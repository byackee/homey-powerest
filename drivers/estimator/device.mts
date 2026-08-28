/**
 * `drivers/estimator/device.mts` — un appareil virtuel qui estime la puissance d'un autre.
 *
 * Le cycle est court et toujours le même : une capability de la source change → on recalcule les
 * watts → on intègre l'énergie écoulée → on écrit `measure_power` et `meter_power`.
 *
 * Deux invariants gouvernent tout le fichier :
 *
 *  1. `meter_power` ne recule JAMAIS. Homey calcule la consommation par différence entre deux
 *     relevés ; un compteur qui recule produit une consommation négative puis un pic aberrant.
 *  2. La source ne doit être comptée qu'une fois. Homey lui applique sa propre approximation
 *     forfaitaire ; sans `energy_exclude`, l'onglet Énergie additionne les deux.
 */

import Homey from 'homey';

import type PowerEstimateApp from '../../app.mjs';
import type { Subscription, CapValue } from '../../runtime/hub.mjs';
import type { LoadedProfile } from '../../runtime/library.mjs';
import { accumulate, restoreMeter, roundKwh, type MeterState } from '../../lib/energy.mjs';
import { computePower } from '../../lib/strategies.mjs';
import { toLightState, type HomeyLightCapabilities } from '../../lib/units.mjs';
import { ProfileError } from '../../lib/types.mjs';

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

    this.ticker = this.homey.setInterval(() => { void this.tick(); }, TICK_MS);
    await this.loadProfile();
  }

  public override async onUninit(): Promise<void> {
    this.teardown();
  }

  public override async onDeleted(): Promise<void> {
    this.teardown();
    // On rend la source à Homey telle qu'on l'a trouvée : sans cela, l'utilisateur qui désinstalle
    // l'app garderait des appareils définitivement absents de son onglet Énergie, sans savoir
    // pourquoi.
    if (this.getSetting('exclude_source') === true) {
      try {
        await this.app.getHub().setDeviceSettings(this.sourceId, { energy_exclude: false });
      } catch (err) {
        this.error('restauration de energy_exclude', err);
      }
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
    if (changedKeys.includes('min_mired') || changedKeys.includes('max_mired')) {
      await this.recompute(Date.now());
    }
  }

  /** Charge le profil, puis branche les abonnements. Réessaie tant que le réseau manque. */
  private async loadProfile(): Promise<void> {
    const manufacturer = String(this.getStoreValue('manufacturer') ?? '');
    const model = String(this.getStoreValue('model') ?? '');
    if (manufacturer === '' || model === '') {
      await this.setUnavailable(this.homey.__('device.no_profile'));
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

    const watched = WATCHED.filter((cap) => source.capabilities.includes(cap));
    const current = hub.readCapabilities(this.sourceId, watched);
    for (const [key, value] of Object.entries(current)) this.state.set(key, value);

    for (const sub of this.subscriptions.splice(0)) sub.destroy();
    for (const capability of watched) {
      this.subscriptions.push(hub.subscribe(this.sourceId, capability, (value) => {
        this.state.set(capability, value);
        void this.recompute(Date.now());
      }));
    }
  }

  /**
   * Pose ou retire `energy_exclude` sur la SOURCE.
   *
   * L'écriture porte sur l'appareil d'une autre app : elle peut échouer (permission, appareil
   * disparu) et l'échec ne doit pas rendre l'estimation indisponible — un double comptage est
   * gênant, pas bloquant. Il est seulement journalisé.
   */
  private async applyExclusion(): Promise<void> {
    const exclude = this.getSetting('exclude_source') === true;
    try {
      await this.app.getHub().setDeviceSettings(this.sourceId, { energy_exclude: exclude });
      this.log(`energy_exclude=${exclude} posé sur ${this.sourceId}`);
    } catch (err) {
      this.error('energy_exclude', err);
    }
  }

  /** Fait avancer le compteur sans changement d'état, et persiste. */
  private async tick(): Promise<void> {
    if (!this.profile) return;
    await this.recompute(Date.now());
    await this.setStoreValue('meter', this.meter).catch((err: unknown) => this.error('persistance', err));
  }

  /**
   * Recalcule la puissance et intègre l'énergie.
   *
   * L'ordre compte : on intègre AVEC L'ANCIENNE puissance jusqu'à maintenant, puis on retient la
   * nouvelle. Intégrer avec la nouvelle attribuerait rétroactivement la consommation d'une lampe
   * qu'on vient d'allumer à la période où elle était éteinte.
   */
  private async recompute(now: number): Promise<void> {
    const profile = this.profile;
    if (!profile) return;

    let watts = 0;
    try {
      const state = toLightState(this.readState(), {
        minMired: numberSetting(this.getSetting('min_mired')),
        maxMired: numberSetting(this.getSetting('max_mired')),
      });
      watts = computePower(profile.model, profile.tables, state).watts;
    } catch (err) {
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
      onoff: read<boolean>('onoff'),
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
