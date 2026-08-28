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
import { buildSankey, type FlowDevice, type Grouping, type SankeyModel } from './lib/sankey.mjs';
import { CATEGORIES, categorise, type Category } from './lib/categories.mjs';

sourceMapSupport.install();

/** Bornes du tampon de diagnostic : une app installée n'a aucun log lisible autrement. */
const TRACE_MAX_LINES = 300;
const TRACE_MAX_CHARS = 500;

/** Un appareil candidat à l'estimation, avec le profil trouvé pour lui s'il y en a un. */
export interface Candidate {
  device: DeviceSummary;
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

    await this.hub.start();
    this.record('log', ['app démarrée']);
  }

  public override async onUninit(): Promise<void> {
    this.hub?.stop();
    this.hub = null;
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
   * pire une seconde vérité contradictoire dans l'onglet Énergie. Un appareil sans `onoff` l'est
   * aussi — sans état allumé/éteint, aucune stratégie ne peut se prononcer.
   */
  public listCandidates(): Candidate[] {
    const hub = this.getHub();
    const index = this.index;
    const out: Candidate[] = [];

    for (const device of hub.listDevices()) {
      if (device.hasPowerMeter) continue;
      if (!device.capabilities.includes('onoff')) continue;

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
      out.push({ device, match });
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
    const hub = this.getHub();
    const profileTypes = this.companionDeviceTypes();
    const overrides = this.categoryOverrides();

    const devices = hub.listDevices()
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
          approximated: measured === null,
        };
      })
      .filter((device): device is FlowDevice => device !== null);
    return buildSankey(devices, { grouping });
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

  /** Fixe ou efface l'usage d'un appareil. Une chaîne vide rend la main au rangement automatique. */
  public setCategoryOverride(deviceId: string, categoryId: string | null): void {
    const current = this.categoryOverrides();
    if (categoryId === null || categoryId === '') delete current[deviceId];
    else current[deviceId] = categoryId;
    this.homey.settings.set('categoryOverrides', current);
    this.record('flow', [`usage de ${deviceId} → ${categoryId ?? 'automatique'}`]);
  }

  /** Ce que la page de réglages affiche : chaque appareil mesuré, son usage, et d'où il vient. */
  public listUsages(): Array<{
    id: string; name: string; zone: string | null; watts: number;
    categoryId: string; categoryLabel: string; manual: boolean;
  }> {
    const overrides = this.categoryOverrides();
    const profileTypes = this.companionDeviceTypes();
    return this.getHub().listDevices()
      .filter((device) => device.watts !== null && !device.cumulative)
      .map((device) => {
        const override = overrides[device.id] ?? null;
        const type = (device.dataId !== null ? profileTypes.get(device.dataId) : undefined) ?? null;
        const category: Category = categorise(device.class, type, override);
        return {
          id: device.id,
          name: device.name,
          zone: device.zoneName,
          watts: device.watts as number,
          categoryId: category.id,
          categoryLabel: category.label,
          manual: override !== null,
        };
      })
      .sort((a, b) => b.watts - a.watts);
  }

  /** La liste des usages proposables, pour que la page n'en invente aucun. */
  public availableCategories(): readonly Category[] {
    return CATEGORIES;
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
