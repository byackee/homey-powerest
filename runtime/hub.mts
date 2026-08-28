/**
 * `runtime/hub.mts` — la couche d'accès aux appareils tiers.
 *
 * SEUL module du projet qui importe `homey-api`. Il isole le reste de l'app d'un client typé
 * `Promise<any>` par Athom, et concentre les trois choses qui peuvent mal tourner en production :
 * la connexion au socket, le quota de l'API, et les abonnements qui meurent quand l'app
 * propriétaire d'un appareil redémarre.
 *
 * Les interfaces `Api*` décrivent la surface réellement utilisée de `homey-api@3.19`, écrites
 * d'après le code du paquet installé.
 *
 * ⚠️ `setDeviceSettings` écrit dans les réglages d'un appareil appartenant à une AUTRE app.
 * C'est ce qui permet d'exclure la source du calcul d'énergie et donc d'éviter le double
 * comptage. Le `Manager` de `homey-api@3` gère bien le paramètre `root: true` de sa spécification
 * (`lib/HomeyAPI/HomeyAPIV3/Manager.js`, `body = value`), donc le corps part à la racine comme
 * l'API l'attend — vérifié dans le code du paquet, pas supposé.
 */

import { EventEmitter } from 'node:events';
import type Homey from 'homey';
import { HomeyAPI } from 'homey-api';

import type { DeviceIdentity } from '../lib/matching.mjs';

type HomeyInstance = Homey.App['homey'];
type Logger = (...args: unknown[]) => void;

/** Back-off du ré-abonnement après la destruction d'une capability par l'app propriétaire. */
const RESUBSCRIBE_MIN_MS = 5_000;
const RESUBSCRIBE_MAX_MS = 5 * 60_000;

/** Back-off de reprise du démarrage : la Homey peut redémarrer avant que le cloud réponde. */
const START_RETRY_MIN_MS = 5_000;
const START_RETRY_MAX_MS = 5 * 60_000;

/**
 * Intervalle plancher entre deux `getDevices()` réseau.
 *
 * Le quota d'Athom est global à tous les points d'entrée et se déclenche aussi en production :
 * une rafale de rafraîchissements coupe l'app pour vingt minutes. Le pairing et les ajouts
 * d'appareils passent tous par ici, donc le plancher est la seule protection.
 */
const REFRESH_MIN_INTERVAL_MS = 60_000;

export type CapValue = boolean | number | string | null;

interface ApiCapabilityInstance {
  value: CapValue | null;
  on(event: 'destroy', fn: () => void): unknown;
  destroy(): void;
}

interface ApiDevice {
  id: string;
  name: string;
  zone: string;
  class: string;
  capabilities: string[];
  capabilitiesObj: Record<string, { value?: unknown } | undefined> | null;
  settings?: Record<string, unknown> | null;
  driverId?: string;
  driverUri?: string;
  available: boolean;
  makeCapabilityInstance(capabilityId: string, listener: (value: CapValue | null) => void): ApiCapabilityInstance;
}

interface ApiManagerDevices {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getDevices(opts?: { $cache?: boolean; $updateCache?: boolean }): Promise<Record<string, ApiDevice | undefined>>;
  getDevice(opts: { id: string }): Promise<ApiDevice>;
  setDeviceSettings(opts: { id: string; settings: Record<string, unknown> }): Promise<unknown>;
}

interface ApiZone { id: string; name: string }

interface ApiManagerZones {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getZones(opts?: { $cache?: boolean }): Promise<Record<string, ApiZone | undefined>>;
}

interface HomeyApiClient {
  devices: ApiManagerDevices;
  zones: ApiManagerZones;
  on(event: string, fn: (...args: unknown[]) => void): unknown;
  destroy(): void;
}

/** Un appareil vu par l'app, enrichi de sa zone. */
export interface DeviceSummary extends DeviceIdentity {
  zoneName: string | null;
  available: boolean;
  /** Vrai si l'appareil mesure déjà sa consommation : il n'a pas besoin d'estimation. */
  hasPowerMeter: boolean;
}

/** Un abonnement vivant à une capability d'une source. */
export interface Subscription {
  /** Coupe l'abonnement et annule tout ré-abonnement en attente. */
  destroy(): void;
}

export interface HubOptions {
  log?: Logger;
  error?: Logger;
}

/**
 * Le hub émet `'ready'` une fois connecté et `'device-changed'` à chaque valeur reçue.
 */
export class HomeyApiHub extends EventEmitter {
  private api: HomeyApiClient | null = null;
  private starting = false;
  private stopped = false;
  private startBackoff = START_RETRY_MIN_MS;
  private startTimer: NodeJS.Timeout | null = null;

  private lastRefresh = 0;
  private devices: Record<string, ApiDevice | undefined> = {};
  private zones: Record<string, ApiZone | undefined> = {};

  private readonly subscriptions = new Set<ManagedSubscription>();
  private readonly log: Logger;
  private readonly errorLog: Logger;

  public constructor(
    private readonly homey: HomeyInstance,
    options: HubOptions = {},
  ) {
    super();
    this.log = options.log ?? (() => {});
    this.errorLog = options.error ?? (() => {});
  }

  public get connected(): boolean {
    return this.api !== null;
  }

  /**
   * Démarre le hub, en réessayant indéfiniment.
   *
   * `createAppAPI()` attend `homey.cloud.getHomeyId()` : une Homey qui démarre avant sa connexion
   * échoue ici, et c'est un cas ORDINAIRE, pas une avarie. D'où le back-off plutôt qu'une erreur
   * remontée à l'utilisateur.
   */
  public async start(): Promise<void> {
    if (this.starting || this.stopped) return;
    this.starting = true;
    try {
      const api = await HomeyAPI.createAppAPI({ homey: this.homey }) as unknown as HomeyApiClient;
      // `connect()` est indispensable : sans lui, `getDevices()` rend des objets orphelins dont
      // les `makeCapabilityInstance` ne reçoivent jamais rien. L'app aurait l'air de fonctionner.
      await api.devices.connect();
      await api.zones.connect();
      this.api = api;
      this.startBackoff = START_RETRY_MIN_MS;

      api.on('disconnect', () => this.log('socket Homey déconnecté'));
      api.on('reconnect', () => {
        this.log('socket Homey reconnecté');
        void this.refresh(true).catch((err) => this.errorLog('rafraîchissement après reconnexion', err));
      });

      await this.refresh(true);
      this.emit('ready');
      this.log('hub prêt');
    } catch (err) {
      this.errorLog('démarrage du hub', err);
      this.scheduleRestart();
    } finally {
      this.starting = false;
    }
  }

  public stop(): void {
    this.stopped = true;
    if (this.startTimer) { clearTimeout(this.startTimer); this.startTimer = null; }
    for (const sub of [...this.subscriptions]) sub.destroy();
    try { this.api?.destroy(); } catch { /* le client peut déjà être détruit */ }
    this.api = null;
  }

  private scheduleRestart(): void {
    if (this.stopped || this.startTimer) return;
    const delay = this.startBackoff;
    this.startBackoff = Math.min(this.startBackoff * 2, START_RETRY_MAX_MS);
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      void this.start();
    }, delay);
  }

  /** Recharge la liste des appareils, en respectant le plancher anti-quota. */
  public async refresh(force = false): Promise<void> {
    const api = this.api;
    if (!api) return;
    const now = Date.now();
    if (!force && now - this.lastRefresh < REFRESH_MIN_INTERVAL_MS) return;
    this.lastRefresh = now;
    const [devices, zones] = await Promise.all([
      api.devices.getDevices({ $cache: !force, $updateCache: force }),
      api.zones.getZones({ $cache: !force }),
    ]);
    this.devices = devices;
    this.zones = zones;
  }

  /** Tous les appareils connus, sous une forme dépourvue de `homey-api`. */
  public listDevices(): DeviceSummary[] {
    const out: DeviceSummary[] = [];
    for (const device of Object.values(this.devices)) {
      if (!device) continue;
      out.push(this.summarise(device));
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  public getDevice(id: string): DeviceSummary | null {
    const device = this.devices[id];
    return device ? this.summarise(device) : null;
  }

  /** Valeurs courantes des capabilities d'un appareil. */
  public readCapabilities(id: string, capabilityIds: string[]): Record<string, CapValue | null> {
    const device = this.devices[id];
    const out: Record<string, CapValue | null> = {};
    if (!device) return out;
    const obj = device.capabilitiesObj ?? {};
    for (const capabilityId of capabilityIds) {
      const entry = obj[capabilityId];
      out[capabilityId] = (entry?.value ?? null) as CapValue | null;
    }
    return out;
  }

  /**
   * S'abonne aux changements d'une capability.
   *
   * Ce sont des notifications temps réel par websocket, pas du sondage : le quota de l'API n'est
   * pas consommé par les abonnements, seulement par les rafraîchissements. C'est ce qui rend
   * viable un abonnement par capability sur plusieurs dizaines d'appareils.
   */
  public subscribe(
    deviceId: string,
    capabilityId: string,
    listener: (value: CapValue | null) => void,
  ): Subscription {
    const sub = new ManagedSubscription(
      deviceId,
      capabilityId,
      listener,
      () => this.api,
      (id) => this.devices[id] ?? null,
      this.errorLog,
    );
    this.subscriptions.add(sub);
    sub.onDisposed = () => this.subscriptions.delete(sub);
    sub.attach();
    return sub;
  }

  /**
   * Écrit des réglages sur un appareil, y compris celui d'une autre app.
   *
   * Sert à poser `energy_exclude: true` sur la source d'une estimation. Sans cela, Homey compte
   * DEUX fois le même appareil dans l'onglet Énergie : une fois via sa propre approximation, une
   * fois via l'appareil virtuel de cette app.
   */
  public async setDeviceSettings(id: string, settings: Record<string, unknown>): Promise<void> {
    const api = this.api;
    if (!api) throw new Error('hub non connecté');
    await api.devices.setDeviceSettings({ id, settings });
  }

  private summarise(device: ApiDevice): DeviceSummary {
    const capabilities = device.capabilities ?? [];
    return {
      id: device.id,
      name: device.name,
      class: device.class,
      capabilities,
      driverId: device.driverUri ?? device.driverId ?? null,
      settings: device.settings ?? null,
      zoneName: this.zones[device.zone]?.name ?? null,
      available: device.available !== false,
      hasPowerMeter: capabilities.includes('measure_power') || capabilities.includes('meter_power'),
    };
  }
}

/**
 * Un abonnement qui se répare tout seul.
 *
 * Une app tierce qui redémarre détruit ses capabilities ; l'instance devient muette sans erreur.
 * Le ré-abonnement est donc obligatoire — et il doit être temporisé, sinon une app qui redémarre
 * en boucle nous fait marteler l'API jusqu'au quota.
 */
class ManagedSubscription implements Subscription {
  private instance: ApiCapabilityInstance | null = null;
  private timer: NodeJS.Timeout | null = null;
  private backoff = RESUBSCRIBE_MIN_MS;
  private disposed = false;

  public onDisposed: (() => void) | null = null;

  public constructor(
    private readonly deviceId: string,
    private readonly capabilityId: string,
    private readonly listener: (value: CapValue | null) => void,
    private readonly getApi: () => HomeyApiClient | null,
    private readonly getDevice: (id: string) => ApiDevice | null,
    private readonly errorLog: Logger,
  ) {}

  public attach(): void {
    if (this.disposed) return;
    const device = this.getDevice(this.deviceId);
    if (!device) { this.retry(); return; }

    try {
      const instance = device.makeCapabilityInstance(this.capabilityId, (value) => {
        this.backoff = RESUBSCRIBE_MIN_MS;
        this.listener(value);
      });
      instance.on('destroy', () => {
        this.instance = null;
        this.retry();
      });
      this.instance = instance;
      this.backoff = RESUBSCRIBE_MIN_MS;
    } catch (err) {
      this.errorLog(`abonnement ${this.deviceId}/${this.capabilityId}`, err);
      this.retry();
    }
  }

  private retry(): void {
    if (this.disposed || this.timer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, RESUBSCRIBE_MAX_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      // Tant que le socket est coupé, rien ne sert de tenter : on repasse par le back-off, qui
      // continue de s'allonger jusqu'à ce que le hub soit revenu.
      if (!this.getApi()) { this.retry(); return; }
      this.attach();
    }, delay);
  }

  public destroy(): void {
    this.disposed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try { this.instance?.destroy(); } catch { /* déjà détruite */ }
    this.instance = null;
    this.onDisposed?.();
  }
}
