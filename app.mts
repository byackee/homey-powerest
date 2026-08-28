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
import { buildSankey, type FlowDevice, type SankeyModel } from './lib/sankey.mjs';

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
   * Le flux d'énergie du logement : compteur général → pièces → appareils.
   *
   * Les appareils MASQUÉS sont conservés. Sur cette installation ils portent justement les
   * estimations : les écarter viderait le diagramme de tout ce que l'app apporte.
   */
  public energyFlow(): SankeyModel {
    const devices: FlowDevice[] = this.getHub().listDevices()
      .filter((device) => device.watts !== null)
      .map((device) => ({
        id: device.id,
        name: device.name,
        zoneName: device.zoneName,
        watts: device.watts as number,
        cumulative: device.cumulative,
      }));
    return buildSankey(devices);
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
