/**
 * `app.mts` — le hub, la bibliothèque, et rien d'autre.
 *
 * L'app ne calcule aucun watt : elle tient les deux ressources que TOUS les appareils virtuels
 * partagent — l'accès unique aux appareils tiers (`HomeyApiHub`) et le client de la bibliothèque
 * de profils (`LibraryClient`) — et les expose aux drivers.
 *
 * Ce partage n'est pas une commodité. Ouvrir un client `homey-api` par appareil multiplierait les
 * sockets et les `getDevices()` par le nombre d'ampoules, et le quota d'Athom coupe l'app bien
 * avant la vingtième.
 *
 * Les appareils s'enregistrent auprès de l'app, jamais l'inverse : l'ordre d'initialisation des
 * drivers n'est pas garanti par le SDK.
 */

import sourceMapSupport from 'source-map-support';
import Homey from 'homey';

import { HomeyApiHub, type DeviceSummary } from './runtime/hub.mjs';
import { LibraryClient } from './runtime/library.mjs';
import { isSelfUsageOnly, matchDevice, type LibraryIndex, type Match } from './lib/matching.mjs';
import { SUPPORTED_STRATEGIES } from './lib/types.mjs';
import { buildSankey, UNMEASURED_ID, type FlowDevice, type Grouping, type SankeyModel } from './lib/sankey.mjs';
import { crossedUp } from './lib/threshold.mjs';
import { CATEGORIES, categorise, type Category } from './lib/categories.mjs';

sourceMapSupport.install();

/**
 * Période d'évaluation des cartes Flow du logement.
 *
 * Ces cartes portent sur un AGRÉGAT, qui n'a pas d'événement propre : rien ne prévient quand le
 * total change. Une minute suit le rythme du hub — qui applique de toute façon son plancher
 * anti-quota — sans multiplier les réveils.
 */
const FLOW_TICK_MS = 60_000;

/** Bornes du tampon de diagnostic : une app installée n'a aucun log lisible autrement. */
const TRACE_MAX_LINES = 300;
const TRACE_MAX_CHARS = 500;

/** Un appareil candidat à l'estimation, avec le profil trouvé pour lui s'il y en a un. */
export interface Candidate {
  device: DeviceSummary;
  /**
   * Puissance forfaitaire que Homey attribue DÉJÀ à cet appareil, le cas échéant.
   *
   * L'estimer sans le savoir créerait un double comptage : les deux valeurs s'additionneraient
   * dans l'onglet Énergie. La liste d'appairage doit le dire avant, pas l'appareil après.
   */
  homeyWatts: number | null;
  match: {
    manufacturer: string;
    model: string;
    label: string;
    strategy: string;
    deviceType: string | null;
    via: string;
    manufacturerConfirmed: boolean;
    /** Faux quand la stratégie du profil n'est pas gérée par cette version. */
    supported: boolean;
    /** Vrai quand le profil a des sous-variantes que la v1 ne sait pas départager. */
    hasSubProfiles: boolean;
    /** Vrai quand le profil ne décrit que l'appareil, pas la charge qu'il pilote. */
    selfUsageOnly: boolean;
  } | null;
}

export default class PowerEstimateApp extends Homey.App {
  private hub: HomeyApiHub | null = null;
  private library: LibraryClient | null = null;
  private index: LibraryIndex | null = null;
  private indexError: string | null = null;
  private readonly trace: string[] = [];
  private flowTimer: NodeJS.Timeout | null = null;
  /** Dernier bilan publié aux cartes Flow, pour juger les franchissements. */
  private lastFlow: { total: number; percent: number } | null = null;

  public override async onInit(): Promise<void> {
    this.hub = new HomeyApiHub(this.homey, {
      log: (...args) => this.record('log', args),
      error: (...args) => this.record('error', args),
    });
    this.library = new LibraryClient({
      log: (...args) => this.record('lib', args),
      error: (...args) => this.record('lib!', args),
    });

    // Le chargement de l'index ne bloque pas le démarrage : 450 ko sur une connexion lente
    // dépasseraient le budget d'`onInit`, et les appareils déjà appairés ont leur profil en cache.
    void this.warmIndex();

    this.registerFlow();
    await this.hub.start();
    this.flowTimer = this.homey.setInterval(() => { void this.evaluateFlow(); }, FLOW_TICK_MS);
    this.record('log', ['app démarrée']);
  }

  public override async onUninit(): Promise<void> {
    if (this.flowTimer) { this.homey.clearInterval(this.flowTimer); this.flowTimer = null; }
    this.hub?.stop();
    this.hub = null;
  }

  /**
   * Câble les cartes Flow du logement.
   *
   * Le seuil vit dans l'argument de CHAQUE Flow, que l'app ne connaît pas. Elle publie donc le
   * couple avant/après dans l'état, et chaque Flow juge son propre franchissement — c'est ce qui
   * permet à dix Flows d'avoir dix seuils différents sans que l'app en sache rien.
   */
  private registerFlow(): void {
    const cards = this.homey.flow;
    cards.getTriggerCard('home_power_crossed').registerRunListener(
      (args: { watts: number }, state: { previous: number; current: number }) =>
        crossedUp(state.previous, state.current, args.watts),
    );
    cards.getTriggerCard('unmeasured_crossed').registerRunListener(
      (args: { percent: number }, state: { previous: number; current: number }) =>
        crossedUp(state.previous, state.current, args.percent),
    );
    cards.getConditionCard('home_power_is').registerRunListener(
      (args: { watts: number }) => this.energyFlow().total > args.watts,
    );
    cards.getConditionCard('unmeasured_is').registerRunListener((args: { percent: number }) => {
      const flow = this.energyFlow();
      return flow.total > 0 && (flow.unmeasured / flow.total) * 100 > args.percent;
    });
    cards.getActionCard('set_manual_power').registerRunListener(
      async (args: { device: { setSettings(s: Record<string, unknown>): Promise<void> }; watts: number }) => {
        // `power_on` et non `mode` : forcer le mode écraserait un profil mesuré choisi par
        // l'utilisateur, alors que la carte n'annonce que de régler une puissance.
        await args.device.setSettings({ power_on: args.watts });
      },
    );
  }

  /** Publie le bilan aux déclencheurs, avec la valeur précédente pour juger le franchissement. */
  private async evaluateFlow(): Promise<void> {
    if (!this.hub?.connected) return;
    let flow: SankeyModel;
    try { flow = this.energyFlow(); } catch { return; }

    const percent = flow.total > 0 ? (flow.unmeasured / flow.total) * 100 : 0;
    const previous = this.lastFlow;
    this.lastFlow = { total: flow.total, percent };
    // Au tout premier passage il n'y a pas d'« avant » : déclencher reviendrait à annoncer un
    // franchissement au démarrage de l'app, à chaque mise à jour.
    if (!previous) return;

    const tokens = {
      total: round2(flow.total),
      measured: round2(flow.measured),
      unmeasured: round2(flow.unmeasured),
    };
    await this.homey.flow.getTriggerCard('home_power_crossed')
      .trigger(tokens, { previous: previous.total, current: flow.total })
      .catch((err: unknown) => this.record('flow!', ['home_power_crossed', err]));

    await this.homey.flow.getTriggerCard('unmeasured_crossed')
      .trigger({ unmeasured: round2(flow.unmeasured), percent: round2(percent) },
        { previous: previous.percent, current: percent })
      .catch((err: unknown) => this.record('flow!', ['unmeasured_crossed', err]));
  }

  public getHub(): HomeyApiHub {
    if (!this.hub) throw new Error('hub indisponible');
    return this.hub;
  }

  public getLibrary(): LibraryClient {
    if (!this.library) throw new Error('bibliothèque indisponible');
    return this.library;
  }

  /** L'index, ou `null` tant qu'il n'est pas chargé. Ne déclenche pas de téléchargement. */
  public getIndex(): LibraryIndex | null {
    return this.index;
  }

  public getIndexError(): string | null {
    return this.indexError;
  }

  /** Charge l'index, en gardant l'échec pour l'afficher plutôt que de le perdre dans les logs. */
  public async warmIndex(force = false): Promise<LibraryIndex | null> {
    try {
      this.index = await this.getLibrary().getIndex(force);
      this.indexError = null;
      this.record('lib', [`index chargé : ${this.index.size} modèles`]);
    } catch (err) {
      this.indexError = err instanceof Error ? err.message : String(err);
      this.record('lib!', ['index indisponible', this.indexError]);
    }
    return this.index;
  }

  /**
   * Les appareils qui gagneraient à être estimés.
   *
   * Un appareil qui mesure déjà sa puissance est écarté : l'estimer serait au mieux redondant, au
   * pire une seconde vérité contradictoire dans l'onglet Énergie.
   */
  public listCandidates(): Candidate[] {
    const hub = this.getHub();
    const index = this.index;
    const out: Candidate[] = [];

    // Les sources DÉJÀ estimées ne doivent plus être proposées : elles sont masquées et exclues
    // de l'Énergie, mais rien ne les empêchait de réapparaître, au risque d'un second compagnon
    // pour le même appareil. `data.id` vaut `estimate:<id de la source>`.
    const estimated = new Set<string>();
    for (const device of hub.listDevices()) {
      const dataId = device.dataId;
      if (typeof dataId === 'string' && dataId.startsWith('estimate:')) {
        estimated.add(dataId.slice('estimate:'.length));
      }
    }

    for (const device of hub.listDevices()) {
      if (estimated.has(device.id)) continue;
      if (device.hasPowerMeter) continue;
      // `onoff` n'est PAS exigé. Une caméra, un pont ou un routeur n'en a pas et consomme
      // pourtant en permanence : les écarter les laissait dans le « non mesuré » sans aucun
      // moyen d'en sortir. Un appareil sans `onoff` est traité comme toujours allumé.
      if (device.capabilities.length === 0) continue;
      // Un appareil sur pile ne tire rien du secteur : le proposer noierait les vraies charges
      // sous les boutons, les détecteurs de fenêtre et les sondes.
      if (device.batteryPowered) continue;

      let match: Candidate['match'] = null;
      if (index) {
        const found: Match | null = matchDevice(index, device);
        if (found) {
          const m = found.model;
          match = {
            manufacturer: m.manufacturer,
            model: m.model,
            label: `${m.manufacturerLabel ?? m.manufacturer} ${m.name}`,
            strategy: m.strategy,
            deviceType: m.deviceType ?? null,
            via: found.via,
            manufacturerConfirmed: found.manufacturerConfirmed,
            supported: SUPPORTED_STRATEGIES.has(m.strategy),
            hasSubProfiles: m.subProfileCount > 0,
            selfUsageOnly: isSelfUsageOnly(m.deviceType),
          };
        }
      }
      out.push({ device, match, homeyWatts: device.approxWatts });
    }

    // Les appareils reconnus d'abord : c'est ce que l'utilisateur vient chercher.
    return out.sort((a, b) => {
      if (!!a.match !== !!b.match) return a.match ? -1 : 1;
      return a.device.name.localeCompare(b.device.name);
    });
  }

  /**
   * Le flux d'énergie du logement : compteur général → usage → pièce → appareil.
   *
   * Les appareils MASQUÉS sont conservés. Sur cette installation ce sont précisément eux qui
   * portent les estimations : les écarter viderait le diagramme de tout ce que l'app apporte.
   */
  public energyFlow(grouping?: readonly Grouping[]): SankeyModel {
    return this.translate(buildSankey(this.flowDevices(), { grouping }));
  }

  /**
   * Traduit les libellés produits par le modèle.
   *
   * `lib/sankey` et `lib/categories` sont purs : ils ne connaissent pas `homey.__`, et les y
   * coupler les rendrait intestables. Ils rendent donc des identifiants et un libellé de repli
   * anglais, et la traduction se fait ici, au dernier moment. Sans cette étape, les libellés
   * d'usage restaient en français pour tout le monde.
   */
  private translate(model: SankeyModel): SankeyModel {
    const label = (key: string, fallback: string): string => {
      const translated = this.homey.__(key);
      // `homey.__` rend la clé elle-même quand elle manque : on préfère l'anglais à `category.x`.
      return typeof translated === 'string' && translated !== key && translated !== '' ? translated : fallback;
    };
    return {
      ...model,
      nodes: model.nodes.map((node) => {
        if (node.id === UNMEASURED_ID) return { ...node, label: label('category.unmeasured', node.label) };
        if (node.categoryId && node.depth === 1) {
          return { ...node, label: label(`category.${node.categoryId}`, node.label) };
        }
        return node;
      }),
    };
  }

  /**
   * Les appareils qui entrent dans le bilan, et la seule définition qui fasse foi.
   *
   * Le diagramme et la page de réglages divergeaient : la page exigeait une `measure_power` là où
   * le diagramme acceptait aussi le forfait natif de Homey. Conséquence : le NAS apparaissait dans
   * le flux mais restait introuvable dans la page, donc impossible à ranger. Deux règles pour la
   * même question finissent toujours par se contredire ; il n'en reste qu'une.
   */
  private flowDevices(): FlowDevice[] {
    const hub = this.getHub();
    const profileTypes = this.companionDeviceTypes();
    const overrides = this.categoryOverrides();
    const powered = this.poweredByMap();

    return hub.listDevices()
      // Un appareil exclu de l'Énergie ne compte plus dans le total du logement : l'inclure ici
      // rendrait le diagramme irréconciliable avec le compteur. Ce sont nos 30 sources masquées.
      .filter((device) => !device.energyExcluded)
      .map((device): FlowDevice | null => {
        // La mesure d'abord ; à défaut, l'approximation forfaitaire de Homey, qui fait entrer un
        // NAS ou une box dans l'Énergie sans qu'ils ne mesurent rien.
        const measured = device.watts;
        const watts = measured ?? device.approxWatts;
        if (watts === null) return null;
        return {
          id: device.id,
          name: device.name,
          zoneName: device.zoneName,
          watts,
          cumulative: device.cumulative,
          deviceClass: device.class,
          deviceType: (device.dataId !== null ? profileTypes.get(device.dataId) : undefined) ?? null,
          categoryOverride: overrides[device.id] ?? null,
          poweredBy: powered[device.id] ?? null,
          approximated: measured === null,
        };
      })
      .filter((device): device is FlowDevice => device !== null);
  }

  /**
   * Le `device_type` du profil mesuré, pour les appareils de cette app.
   *
   * Sans lui, l'imprimante réseau se rangerait parmi les capteurs de sécurité : son app la déclare
   * `sensor`, ce qui est juste pour Homey et absurde pour un appareil qui tire quinze watts. Le
   * profil, lui, sait que c'est une imprimante. Ce détour est nécessaire parce que le `store` d'un
   * appareil n'est pas restitué par l'API : seul le driver peut le lire.
   */
  private companionDeviceTypes(): Map<string, string> {
    const out = new Map<string, string>();
    const index = this.index;
    if (!index) return out;
    try {
      for (const device of this.homey.drivers.getDriver('estimator').getDevices()) {
        const manufacturer = String(device.getStoreValue('manufacturer') ?? '');
        const model = String(device.getStoreValue('model') ?? '');
        if (manufacturer === '' || model === '') continue;
        const entry = index.get(manufacturer, model);
        const data = device.getData() as { id?: unknown } | null;
        const key = typeof data?.id === 'string' ? data.id : null;
        if (key !== null && entry?.deviceType) out.set(key, entry.deviceType);
      }
    } catch (err) {
      this.record('flow!', ['lecture des profils des compagnons', err]);
    }
    return out;
  }

  /**
   * Les usages choisis à la main, par identifiant d'appareil.
   *
   * Stockés au niveau de l'APP et non sur les appareils : les plus mal rangés ne sont justement
   * pas les nôtres — un onduleur, un module encastré — et une app ne peut pas ajouter de réglage
   * à l'appareil d'une autre. Un réglage porté par les compagnons aurait donc laissé le plus gros
   * poste du diagramme inclassable.
   */
  public categoryOverrides(): Record<string, string> {
    const raw = this.homey.settings.get('categoryOverrides') as unknown;
    if (raw === null || typeof raw !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string' && value !== '') out[id] = value;
    }
    return out;
  }

  /**
   * Qui alimente qui, par identifiant d'appareil.
   *
   * Un onduleur ou une multiprise mesurée ne consomme pas ce qu'il affiche : il porte la charge
   * de ce qui est derrière. Sans cette relation, l'onduleur à 100 W et le NAS à 55 W qu'il
   * alimente sont comptés côte à côte, et le logement paraît consommer 55 W de trop.
   */
  public poweredByMap(): Record<string, string> {
    const raw = this.homey.settings.get('poweredBy') as unknown;
    if (raw === null || typeof raw !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string' && value !== '' && value !== id) out[id] = value;
    }
    return out;
  }

  /** Déclare — ou efface — l'appareil qui en alimente un autre. */
  public setPoweredBy(deviceId: string, parentId: string | null): void {
    const current = this.poweredByMap();
    if (parentId === null || parentId === '' || parentId === deviceId) delete current[deviceId];
    else current[deviceId] = parentId;
    this.homey.settings.set('poweredBy', current);
    this.record('flow', [`${deviceId} alimenté par ${parentId ?? 'rien'}`]);
  }

  /** Fixe ou efface l'usage d'un appareil. Une chaîne vide rend la main au rangement automatique. */
  public setCategoryOverride(deviceId: string, categoryId: string | null): void {
    const current = this.categoryOverrides();
    if (categoryId === null || categoryId === '') delete current[deviceId];
    else current[deviceId] = categoryId;
    this.homey.settings.set('categoryOverrides', current);
    this.record('flow', [`usage de ${deviceId} → ${categoryId ?? 'automatique'}`]);
  }

  /** Ce que la page de réglages affiche : chaque appareil du bilan, son usage, et d'où il vient. */
  public listUsages(): Array<{
    id: string; name: string; zone: string | null; watts: number;
    categoryId: string; categoryLabel: string; manual: boolean; poweredBy: string | null;
    approximated: boolean;
  }> {
    const overrides = this.categoryOverrides();
    return this.flowDevices()
      .filter((device) => !device.cumulative)
      .map((device) => {
        const category: Category = categorise(device.deviceClass, device.deviceType, device.categoryOverride);
        const translated = this.homey.__(`category.${category.id}`);
        return {
          id: device.id,
          name: device.name,
          zone: device.zoneName,
          watts: device.watts,
          categoryId: category.id,
          categoryLabel: typeof translated === 'string' && translated !== `category.${category.id}` && translated !== ''
            ? translated : category.label,
          manual: (overrides[device.id] ?? null) !== null,
          poweredBy: device.poweredBy ?? null,
          approximated: device.approximated === true,
        };
      })
      .sort((a, b) => b.watts - a.watts);
  }

  /** La liste des usages proposables, pour que la page n'en invente aucun. */
  public availableCategories(): readonly Category[] {
    return CATEGORIES.map((c) => {
      const translated = this.homey.__(`category.${c.id}`);
      return typeof translated === 'string' && translated !== `category.${c.id}` && translated !== ''
        ? { ...c, label: translated } : c;
    });
  }

  /** Journal circulaire consultable depuis la page de réglages. */
  public getTrace(): string[] {
    return [...this.trace];
  }

  /**
   * Journalise depuis un driver ou un appareil.
   *
   * `Device.log`/`Device.error` n'aboutissent nulle part de lisible sur une app INSTALLÉE :
   * Developer Tools ne liste que les soumissions au store et le CLI n'a pas de commande de logs.
   * Une erreur d'appareil sans ce relais est donc définitivement invisible — c'est précisément ce
   * qui a masqué l'échec de `energy_exclude` au premier appairage.
   */
  public note(tag: string, ...args: unknown[]): void {
    this.record(tag, args);
  }

  private record(tag: string, args: unknown[]): void {
    const text = args
      .map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : safeJson(a)))
      .join(' ')
      .slice(0, TRACE_MAX_CHARS);
    const line = `${new Date().toISOString()} [${tag}] ${text}`;
    this.trace.push(line);
    if (this.trace.length > TRACE_MAX_LINES) this.trace.shift();
    if (tag.endsWith('!')) this.error(line);
    else this.log(line);
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
