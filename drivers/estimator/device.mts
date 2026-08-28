/**
 * `drivers/estimator/device.mts` — l'appareil qui REMPLACE l'appareil réel.
 *
 * Le cycle est court et toujours le même : une capability de la source change → on recalcule les
 * watts → on intègre l'énergie écoulée → on écrit `measure_power` et `meter_power`.
 *
 * Deux invariants gouvernent tout le fichier :
 *
 *  1. `meter_power` ne recule JAMAIS. Homey calcule la consommation par différence entre deux
 *     relevés ; un compteur qui recule produit une consommation négative puis un pic aberrant.
 *  2. La source ne doit être comptée qu'une fois. Homey lui applique sa propre approximation
 *     forfaitaire ; sans exclusion, l'onglet Énergie additionne les deux.
 *
 * Le compagnon ne se contente pas d'afficher des watts : il reprend les commandes de la source
 * (allumage, gradation, couleur) et les lui renvoie, pour que l'utilisateur n'ait qu'UNE tuile —
 * celle qui porte aussi la consommation — et puisse masquer l'appareil d'origine. La seule
 * écriture qu'une app puisse faire sur l'appareil d'une autre est `setCapabilityValue` ; c'est
 * exactement celle dont ce miroir a besoin.
 */

import Homey from 'homey';

import type PowerEstimateApp from '../../app.mjs';
import type { Subscription, CapValue } from '../../runtime/hub.mjs';
import type { LoadedProfile } from '../../runtime/library.mjs';
import { accumulate, restoreMeter, roundKwh, shouldPersist, type MeterState } from '../../lib/energy.mjs';
import { computePower } from '../../lib/strategies.mjs';
import { toLightState, type HomeyLightCapabilities } from '../../lib/units.mjs';
import { ProfileError } from '../../lib/types.mjs';
import { capabilityDiff, plannedCapabilities, writableCapabilities } from '../../lib/mirror.mjs';
import { effectiveMode, manualModel } from '../../lib/manual.mjs';

/**
 * Capabilities de la source qui influencent la consommation.
 *
 * `light_mode` n'entre dans aucun calcul mais arbitre entre la table couleur et la table blanc :
 * l'oublier ferait appliquer la courbe du blanc à une lampe passée en rouge.
 */
const WATCHED = ['onoff', 'dim', 'light_mode', 'light_temperature', 'light_hue', 'light_saturation'] as const;

/**
 * Période de relance du calcul.
 *
 * Les changements d'état arrivent par notification, donc ce timer ne sert pas à les détecter : il
 * sert à faire avancer le compteur d'énergie pendant qu'une lampe reste allumée sans bouger, et à
 * persister l'état. Une minute borne à la fois la dérive du compteur et les écritures disque.
 */
const TICK_MS = 60_000;

/** Back-off de re-tentative du chargement de profil quand le réseau manque au démarrage. */
const PROFILE_RETRY_MIN_MS = 30_000;
const PROFILE_RETRY_MAX_MS = 30 * 60_000;

export default class EstimatorDevice extends Homey.Device {
  private sourceId = '';
  private profile: LoadedProfile | null = null;
  private meter: MeterState = { kwh: 0, lastTs: Date.now(), lastW: 0 };
  private readonly state = new Map<string, CapValue | null>();
  private readonly subscriptions: Subscription[] = [];
  private ticker: NodeJS.Timeout | null = null;
  private profileTimer: NodeJS.Timeout | null = null;
  private profileBackoff = PROFILE_RETRY_MIN_MS;
  private controlsRegistered = false;
  /**
   * Vrai quand la SOURCE n'expose pas `onoff`.
   *
   * Une caméra, un pont, un routeur ne s'éteignent pas : sans cette bascule, `toLightState`
   * conclurait « éteint » faute de capability et l'appareil afficherait éternellement sa veille —
   * c'est-à-dire zéro, puisqu'on ne renseigne pas de veille pour ce qui n'en a pas.
   */
  private alwaysOn = false;
  /**
   * Capabilities de la source que ce compagnon NE reprend PAS.
   *
   * Sert à avertir quand la source a été masquée alors qu'elle n'est pas remplaçable : on perd
   * alors ses fonctions propres sans que rien ne le signale. C'est exactement l'erreur commise sur
   * une Freebox et un pont Zigbee — masquer et exclure sont deux gestes indépendants, l'exclusion
   * ne règle que l'arithmétique.
   */
  private lostCapabilities: string[] = [];
  /** Dernier cumul réellement écrit dans le `store`, pour ne réécrire que ce qui a bougé. */
  private persistedKwh = 0;

  private get app(): PowerEstimateApp {
    return this.homey.app as PowerEstimateApp;
  }

  public override async onInit(): Promise<void> {
    this.sourceId = String(this.getStoreValue('sourceId') ?? '');
    if (this.sourceId === '') {
      await this.setUnavailable(this.homey.__('device.no_source'));
      return;
    }

    // La classe est celle de la source, pour que l'onglet Énergie range l'estimation avec les
    // lampes et non parmi les capteurs. Le pairing ne peut pas la fixer — le SDK ignore
    // silencieusement toute clé autre que name/data/store/settings — d'où l'appel ici.
    const sourceClass = this.getStoreValue('sourceClass');
    if (typeof sourceClass === 'string' && sourceClass !== '' && this.getClass() !== sourceClass) {
      try { await this.setClass(sourceClass); } catch (err) { this.error('setClass', err); }
    }

    this.meter = restoreMeter(this.getStoreValue('meter'), Date.now());
    this.persistedKwh = this.meter.kwh;

    this.ticker = this.homey.setInterval(() => { void this.tick(); }, TICK_MS);
    await this.loadProfile();
  }

  public override async onUninit(): Promise<void> {
    this.teardown();
    // L'arrêt est le seul moment où l'on écrit sans condition : c'est là qu'on sauve le dernier
    // watt-heure que le filtre de persistance retenait encore.
    await this.persistMeter();
  }

  public override async onDeleted(): Promise<void> {
    this.teardown();
    // La tentative de remise en état est vouée au même refus de scope que la pose (voir
    // `applyExclusion`). Elle est conservée parce qu'elle ne coûte rien et deviendrait correcte
    // si Athom ouvrait le scope, mais l'utilisateur doit être averti que la ré-inclusion de sa
    // source lui revient — d'où la note, qui est lisible, plutôt qu'un `this.error` qui ne l'est
    // pas sur une app installée.
    try {
      await this.app.getHub().setDeviceSettings(this.sourceId, { energy_exclude: false });
      this.app.note('excl', `energy_exclude remis à false sur ${this.sourceId}`);
    } catch {
      this.app.note('excl?', `source ${this.sourceId} à ré-inclure à la main dans l'onglet Énergie`);
    }
  }

  public override async onSettings({ changedKeys }: {
    oldSettings: Record<string, unknown>;
    newSettings: Record<string, unknown>;
    changedKeys: string[];
  }): Promise<void> {
    if (changedKeys.includes('exclude_source')) {
      // `newSettings` n'est pas encore visible via `getSetting` au moment de ce rappel : on lit la
      // valeur qui vient d'être validée plutôt que l'ancienne.
      await this.applyExclusion();
    }
    if (changedKeys.includes('mode')) {
      // Repasser en mode profil doit pouvoir déclencher le téléchargement qu'on avait évité.
      await this.loadProfile();
      return;
    }
    const recomputeKeys = ['min_mired', 'max_mired', 'power_off', 'power_on', 'power_min', 'power_max'];
    if (changedKeys.some((key) => recomputeKeys.includes(key))) {
      await this.recompute(Date.now());
    }
  }

  /**
   * Aligne les capabilities du compagnon sur celles de la source.
   *
   * Fait à CHAQUE démarrage et non seulement à l'appairage : une lampe peut gagner ou perdre des
   * capabilities quand son app est mise à jour, et un compagnon figé deviendrait un pilote
   * incomplet — une tuile sans gradation pour une lampe gradable, sans que rien ne le signale.
   */
  private async syncCapabilities(sourceCapabilities: string[]): Promise<void> {
    const { add, remove } = capabilityDiff(this.getCapabilities(), plannedCapabilities(sourceCapabilities));

    for (const capability of add) {
      try { await this.addCapability(capability); }
      catch (err) { this.app.note('caps!', `ajout de ${capability} : ${describe(err)}`); }
    }
    for (const capability of remove) {
      try { await this.removeCapability(capability); }
      catch (err) { this.app.note('caps!', `retrait de ${capability} : ${describe(err)}`); }
    }
    if (add.length > 0 || remove.length > 0) {
      this.app.note('caps', `${this.getName()} : +[${add.join(', ')}] -[${remove.join(', ')}]`);
    }
  }

  /**
   * Renvoie vers la source ce que l'utilisateur fait sur la tuile du compagnon.
   *
   * Aucune boucle à craindre : `setCapabilityValue` appelé par l'appareil sur lui-même ne
   * déclenche pas ses propres écouteurs. Le retour d'état arrive par l'abonnement au hub, ce qui
   * fait converger la tuile sur ce que la lampe a RÉELLEMENT fait — et non sur ce qu'on lui a
   * demandé, distinction qui compte quand une lampe est hors tension.
   */
  private registerControls(sourceCapabilities: string[]): void {
    // `attach()` peut être rejoué après une reprise de profil : réenregistrer un écouteur sur la
    // même capability le remplacerait silencieusement, mais autant ne pas s'y fier.
    if (this.controlsRegistered) return;
    this.controlsRegistered = true;

    for (const capability of writableCapabilities(sourceCapabilities)) {
      if (!this.hasCapability(capability)) continue;
      this.registerCapabilityListener(capability, async (value: unknown) => {
        await this.app.getHub().setCapability(this.sourceId, capability, value as never);
      });
    }
  }

  /** Charge le profil, puis branche les abonnements. Réessaie tant que le réseau manque. */
  private async loadProfile(): Promise<void> {
    const manufacturer = String(this.getStoreValue('manufacturer') ?? '');
    const model = String(this.getStoreValue('model') ?? '');
    const wantsProfile = this.getSetting('mode') !== 'fixed'
      && this.getSetting('mode') !== 'linear'
      && manufacturer !== '' && model !== '';

    // En saisie manuelle, la bibliothèque n'a rien à dire : ni téléchargement, ni indisponibilité
    // sur un profil absent. C'est ce qui rend appairables les appareils qu'elle ne connaît pas.
    if (!wantsProfile) {
      this.profile = null;
      await this.attach();
      await this.applyExclusion();
      await this.setAvailable();
      await this.recompute(Date.now());
      return;
    }

    try {
      const index = this.app.getIndex() ?? await this.app.warmIndex();
      if (!index) throw new ProfileError('index indisponible', 'network');

      const entry = index.get(manufacturer, model);
      if (!entry) throw new ProfileError(`profil ${manufacturer}/${model} absent de l'index`, 'not_found');

      this.profile = await this.app.getLibrary().getProfile(entry);
      this.profileBackoff = PROFILE_RETRY_MIN_MS;

      await this.attach();
      await this.applyExclusion();
      await this.setAvailable();
      await this.recompute(Date.now());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.app.note('prof!', `${this.getName()} : ${message}`);
      this.error('chargement du profil', message);
      await this.setUnavailable(this.homey.__('device.profile_error'));
      // Un profil absent ne se répare pas tout seul, mais une coupure réseau si : on retente dans
      // les deux cas, le back-off rendant la seconde situation peu coûteuse.
      this.scheduleProfileRetry();
    }
  }

  private scheduleProfileRetry(): void {
    if (this.profileTimer) return;
    const delay = this.profileBackoff;
    this.profileBackoff = Math.min(this.profileBackoff * 2, PROFILE_RETRY_MAX_MS);
    this.profileTimer = this.homey.setTimeout(() => {
      this.profileTimer = null;
      void this.loadProfile();
    }, delay);
  }

  /** Amorce l'état depuis les valeurs courantes, puis s'abonne aux changements. */
  private async attach(): Promise<void> {
    const hub = this.app.getHub();
    const source = hub.getDevice(this.sourceId);
    if (!source) {
      await this.setUnavailable(this.homey.__('device.source_gone'));
      return;
    }

    // Ici, et pas dans `onInit` : l'ordre d'initialisation des drivers n'est pas garanti par le
    // SDK, et le hub peut ne pas être connecté quand l'appareil démarre. Aligner les capabilities
    // sur une source inconnue les laisserait figées jusqu'au redémarrage suivant.
    this.alwaysOn = !source.capabilities.includes('onoff');
    const mine = new Set(plannedCapabilities(source.capabilities));
    this.lostCapabilities = source.capabilities.filter(
      (capability) => !mine.has(capability) && !capability.startsWith('button.'),
    );
    await this.syncCapabilities(source.capabilities);
    this.registerControls(source.capabilities);

    const watched = WATCHED.filter((cap) => source.capabilities.includes(cap));
    const current = hub.readCapabilities(this.sourceId, watched);
    for (const [key, value] of Object.entries(current)) {
      this.state.set(key, value);
      await this.reflect(key, value);
    }

    for (const sub of this.subscriptions.splice(0)) sub.destroy();
    for (const capability of watched) {
      this.subscriptions.push(hub.subscribe(this.sourceId, capability, (value) => {
        this.state.set(capability, value);
        void this.reflect(capability, value);
        void this.recompute(Date.now());
      }));
    }
  }

  /** Écrit le compteur et retient ce qui a été écrit. */
  private async persistMeter(): Promise<void> {
    try {
      await this.setStoreValue('meter', this.meter);
      this.persistedKwh = this.meter.kwh;
    } catch (err) {
      this.app.note('meter!', `persistance : ${describe(err)}`);
    }
  }

  /** Recopie une valeur de la source sur la capability correspondante du compagnon. */
  private async reflect(capability: string, value: CapValue | null): Promise<void> {
    if (!this.hasCapability(capability) || value === null) return;
    await this.setCapabilityValue(capability, value)
      .catch((err: unknown) => this.app.note('mir!', `${capability} : ${describe(err)}`));
  }

  /**
   * Vérifie que la source est bien exclue de l'onglet Énergie, et le signale sinon.
   *
   * 🔴 **Une app ne PEUT PAS poser `energy_exclude` elle-même.** L'opération est
   * `setDeviceSettings`, de scope `homey.device` ; une app, même avec la permission
   * `homey:manager:api`, ne reçoit que `homey.device.readonly` et `homey.device.control`
   * (constaté sur la Homey : `Error: Missing Scopes`, et confirmé dans les scopes de
   * `HomeyAPIV3Local.json`). La même limite condamne l'autre approche envisagée, qui consistait à
   * corriger `energy_value_on` de la source à la volée.
   *
   * L'app tente quand même l'écriture — si Athom ouvrait un jour le scope, tout marcherait sans
   * changement — puis LIT l'état réel de la source, qui est en lecture seule mais bien visible.
   * L'avertissement disparaît donc tout seul dès que l'utilisateur a coché la case, sans qu'il
   * ait à revenir ici.
   */
  private async applyExclusion(): Promise<void> {
    const wanted = this.getSetting('exclude_source') !== false;

    try {
      await this.app.getHub().setDeviceSettings(this.sourceId, { energy_exclude: wanted });
      this.app.note('excl', `energy_exclude=${wanted} posé sur ${this.sourceId}`);
    } catch (err) {
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      this.app.note('excl?', `écriture refusée sur ${this.sourceId} — ${detail}`);
    }

    await this.checkExclusion();
  }

  /**
   * Confronte l'intention au réel et met à jour l'avertissement de l'appareil.
   *
   * Sans exclusion de la source, Homey compte DEUX fois le même appareil : sa propre valeur
   * forfaitaire, plus l'estimation de cette app. Le total est alors PLUS faux qu'avant
   * l'installation — c'est le seul état où l'app nuit, donc le seul qui mérite un avertissement
   * permanent sur la tuile.
   */
  private async checkExclusion(): Promise<void> {
    const wanted = this.getSetting('exclude_source') !== false;
    const source = this.app.getHub().getDevice(this.sourceId);
    const actual = (source?.settings ?? {})['energy_exclude'] === true;

    // L'ordre est celui de la gravité. Un double comptage rend le TOTAL du logement faux ; une
    // source masquée sans remplaçant ne fait perdre que des fonctions, ce qui se rattrape.
    if (wanted && !actual) {
      await this.setWarning(this.homey.__('device.exclude_manually')).catch(() => undefined);
      return;
    }
    if (source?.hidden === true && this.lostCapabilities.length > 0) {
      await this.setWarning(this.homey.__('device.hidden_but_partial', {
        count: String(this.lostCapabilities.length),
      })).catch(() => undefined);
      return;
    }
    await this.unsetWarning().catch(() => undefined);
  }

  /**
   * Fait avancer le compteur sans changement d'état, et persiste.
   *
   * ⚠️ Ne PAS conditionner ce tick à la présence d'un profil. Un appareil en saisie manuelle n'en
   * a aucun : le garder ici le privait de tout recalcul périodique et de toute accumulation
   * d'énergie. Il gardait la valeur calculée à son démarrage — donc zéro watt, puisque les
   * puissances n'étaient pas encore saisies — et plus rien ne le réveillait jusqu'au prochain
   * changement d'état de sa source. Une télé réglée à 60 W restait à 0 W, sans erreur nulle part.
   */
  private async tick(): Promise<void> {
    await this.recompute(Date.now());
    // Le hub applique son propre plancher anti-quota : cet appel ne part sur le réseau qu'une
    // fois par minute au plus, quel que soit le nombre d'appareils virtuels.
    await this.app.getHub().refresh().catch(() => undefined);
    await this.checkExclusion();
    // On n'écrit que si le cumul a bougé d'au moins un watt-heure. Voir `PERSIST_STEP_KWH` : sans
    // ce filtre, une veille de 0,3 W écrivait soixante fois par heure pour ne rien changer.
    if (shouldPersist(this.meter.kwh, this.persistedKwh)) await this.persistMeter();
  }

  /**
   * Recalcule la puissance et intègre l'énergie.
   *
   * L'ordre compte : on intègre AVEC L'ANCIENNE puissance jusqu'à maintenant, puis on retient la
   * nouvelle. Intégrer avec la nouvelle attribuerait rétroactivement la consommation d'une lampe
   * qu'on vient d'allumer à la période où elle était éteinte.
   */
  private async recompute(now: number): Promise<void> {
    // Le mode manuel fabrique un `ProfileModel` que le moteur traite comme n'importe quel profil :
    // une seule implémentation des stratégies, donc un seul endroit où un défaut peut se cacher.
    const mode = effectiveMode(this.getSetting('mode'), this.profile !== null);
    const manual = manualModel({
      mode,
      powerOff: this.getSetting('power_off'),
      powerOn: this.getSetting('power_on'),
      powerMin: this.getSetting('power_min'),
      powerMax: this.getSetting('power_max'),
    });

    const model = manual ?? this.profile?.model ?? null;
    const tables = manual ? {} : (this.profile?.tables ?? {});
    if (!model) return;

    let watts = 0;
    try {
      const state = toLightState(this.readState(), {
        minMired: numberSetting(this.getSetting('min_mired')),
        maxMired: numberSetting(this.getSetting('max_mired')),
      });
      watts = computePower(model, tables, state).watts;
    } catch (err) {
      this.app.note('calc!', `${this.getName()} : ${err instanceof Error ? err.message : String(err)}`);
      this.error('calcul', err);
      return;
    }

    this.meter = accumulate(this.meter, watts, now);

    await this.setCapabilityValue('measure_power', watts).catch((err: unknown) => this.error('measure_power', err));
    await this.setCapabilityValue('meter_power', roundKwh(this.meter.kwh)).catch((err: unknown) => this.error('meter_power', err));
  }

  private readState(): HomeyLightCapabilities {
    const read = <T,>(key: string): T | null => (this.state.get(key) ?? null) as T | null;
    return {
      onoff: this.alwaysOn ? true : read<boolean>('onoff'),
      dim: read<number>('dim'),
      light_mode: read<string>('light_mode'),
      light_temperature: read<number>('light_temperature'),
      light_hue: read<number>('light_hue'),
      light_saturation: read<number>('light_saturation'),
    };
  }

  private teardown(): void {
    if (this.ticker) { this.homey.clearInterval(this.ticker); this.ticker = null; }
    if (this.profileTimer) { this.homey.clearTimeout(this.profileTimer); this.profileTimer = null; }
    for (const sub of this.subscriptions.splice(0)) sub.destroy();
  }
}

/** Un réglage numérique dont on refuse les valeurs impossibles plutôt que de les propager. */
function numberSetting(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
