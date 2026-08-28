/**
 * `test-runtime/fakes/api.mts` — un faux client `homey-api`.
 *
 * Le vrai paquet parle à un websocket. On lui substitue un client qui tient quelques appareils et
 * COMPTE ce qu'on lui demande : nombre d'appels réseau, abonnements créés et détruits, écritures
 * reçues. Ce sont ces compteurs qui prouvent le comportement du hub — pas ses valeurs de retour.
 */

export type CapValue = boolean | number | string | null;

export class FakeCapabilityInstance {
  public destroyed = false;
  private readonly destroyHandlers: Array<() => void> = [];

  public constructor(
    public readonly capabilityId: string,
    public readonly listener: (value: CapValue) => void,
    public value: CapValue = null,
  ) {}

  public on(event: 'destroy', fn: () => void): this {
    if (event === 'destroy') this.destroyHandlers.push(fn);
    return this;
  }

  public destroy(): void {
    this.destroyed = true;
  }

  /** Simule la destruction par l'app PROPRIÉTAIRE de l'appareil, qui redémarre. */
  public killFromOwner(): void {
    this.destroyed = true;
    for (const fn of this.destroyHandlers) fn();
  }

  public emit(value: CapValue): void {
    this.value = value;
    this.listener(value);
  }
}

export interface FakeDeviceInit {
  id: string;
  name: string;
  zone?: string;
  class?: string;
  capabilities?: string[];
  values?: Record<string, CapValue>;
  settings?: Record<string, unknown> | null;
  energyObj?: { cumulative?: boolean | null; W?: number | null } | null;
  hidden?: boolean;
  data?: { id?: string } | null;
}

export class FakeDevice {
  public readonly id: string;
  public readonly name: string;
  public readonly zone: string;
  public readonly class: string;
  public readonly capabilities: string[];
  public readonly capabilitiesObj: Record<string, { value?: unknown }>;
  public settings: Record<string, unknown> | null;
  public readonly energyObj: { cumulative?: boolean | null; W?: number | null } | null;
  public readonly hidden: boolean;
  public readonly data: { id?: string } | null;
  public available = true;
  public readonly driverUri = 'homey:app:tests:driver';

  /** Toutes les instances créées, vivantes ou non : c'est la trace des abonnements. */
  public readonly instances: FakeCapabilityInstance[] = [];
  /** Chaque écriture de capability réellement reçue. */
  public readonly writes: Array<{ capabilityId: string; value: CapValue }> = [];
  /** Fait échouer le prochain `makeCapabilityInstance`, comme une app tierce en cours d'arrêt. */
  public failNextSubscribe = false;

  public constructor(init: FakeDeviceInit) {
    this.id = init.id;
    this.name = init.name;
    this.zone = init.zone ?? 'zone-1';
    this.class = init.class ?? 'light';
    this.capabilities = init.capabilities ?? ['onoff'];
    this.settings = init.settings ?? null;
    this.energyObj = init.energyObj ?? null;
    this.hidden = init.hidden ?? false;
    this.data = init.data ?? null;
    this.capabilitiesObj = {};
    for (const [k, v] of Object.entries(init.values ?? {})) this.capabilitiesObj[k] = { value: v };
  }

  public makeCapabilityInstance(capabilityId: string, listener: (value: CapValue) => void): FakeCapabilityInstance {
    if (this.failNextSubscribe) {
      this.failNextSubscribe = false;
      throw new Error('appareil en cours de redémarrage');
    }
    const instance = new FakeCapabilityInstance(
      capabilityId, listener, (this.capabilitiesObj[capabilityId]?.value ?? null) as CapValue,
    );
    this.instances.push(instance);
    return instance;
  }

  public async setCapabilityValue(opts: { capabilityId: string; value: CapValue }): Promise<void> {
    this.writes.push({ capabilityId: opts.capabilityId, value: opts.value });
    this.capabilitiesObj[opts.capabilityId] = { value: opts.value };
  }

  /** Le dernier abonnement créé pour cette capability, celui qui est censé être vivant. */
  public latest(capabilityId: string): FakeCapabilityInstance | undefined {
    return [...this.instances].reverse().find((i) => i.capabilityId === capabilityId);
  }
}

export class FakeApi {
  public getDevicesCalls = 0;
  /** Les deux managers doivent être connectés : sans `connect()`, les abonnements sont muets. */
  public devicesConnected = false;
  public zonesConnected = false;
  public destroyed = false;
  public settingsWrites: Array<{ id: string; settings: Record<string, unknown> }> = [];
  /** Fait échouer le prochain `setDeviceSettings`, comme le refus de scope réel. */
  public settingsError: Error | null = null;

  private readonly handlers: Record<string, Array<(...a: unknown[]) => void>> = {};

  public constructor(private readonly deviceList: FakeDevice[]) {}

  public readonly devices = {
    connect: async (): Promise<void> => { this.devicesConnected = true; },
    disconnect: async (): Promise<void> => {},
    getDevices: async (): Promise<Record<string, FakeDevice>> => {
      this.getDevicesCalls += 1;
      return Object.fromEntries(this.deviceList.map((d) => [d.id, d]));
    },
    getDevice: async ({ id }: { id: string }): Promise<FakeDevice | undefined> =>
      this.deviceList.find((d) => d.id === id),
    setDeviceSettings: async ({ id, settings }: { id: string; settings: Record<string, unknown> }): Promise<void> => {
      if (this.settingsError) throw this.settingsError;
      this.settingsWrites.push({ id, settings });
      const device = this.deviceList.find((d) => d.id === id);
      if (device) device.settings = { ...(device.settings ?? {}), ...settings };
    },
  };

  public readonly zones = {
    connect: async (): Promise<void> => { this.zonesConnected = true; },
    disconnect: async (): Promise<void> => {},
    getZones: async (): Promise<Record<string, { id: string; name: string }>> => ({
      'zone-1': { id: 'zone-1', name: 'Salon' },
    }),
  };

  public on(event: string, fn: (...a: unknown[]) => void): this {
    (this.handlers[event] ??= []).push(fn);
    return this;
  }

  public fire(event: string): void {
    for (const fn of this.handlers[event] ?? []) fn();
  }

  public destroy(): void { this.destroyed = true; }
}
