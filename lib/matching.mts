/**
 * `lib/matching.mts` — la jointure entre un appareil Homey et un profil de la bibliothèque.
 *
 * C'est le point qui rend l'app utilisable sans configuration : Homey expose le modèle exact des
 * ampoules dans leurs réglages (`Model_ID` vaut `LCT012`, `LTW013`…), et ce sont EXACTEMENT les
 * identifiants Signify que la bibliothèque PowerCalc utilise comme clés. La correspondance est
 * donc directe, pas heuristique.
 *
 * Mesuré sur un parc réel de 94 appareils : 23 des 26 appareils pilotables sans mesure de
 * puissance ont été retrouvés dans la bibliothèque par cette seule jointure.
 */

import type { DeviceType, LutKind, ProfileRef, Strategy } from './types.mjs';

/** Un modèle de la bibliothèque, aplati depuis l'index distant. */
export interface LibraryModel extends ProfileRef {
  id: string;
  name: string;
  aliases: string[];
  /** Noms alternatifs du fabricant (« Philips », « Signify Netherlands B.V. » pour `signify`). */
  manufacturerAliases: string[];
  strategy: Strategy;
  deviceType?: DeviceType;
  /** Tables de mesure disponibles. Évite de deviner quels fichiers télécharger. */
  colorModes: LutKind[];
  standbyPower?: number;
  maxPower?: number;
  /** > 0 signale un profil à sous-variantes, que la v1 ne sait pas choisir. */
  subProfileCount: number;
  hash?: string;
}

/** Ce que le hub sait d'un appareil tiers, réduit à ce qui sert à l'identifier. */
export interface DeviceIdentity {
  id: string;
  name: string;
  class: string;
  capabilities: string[];
  driverId?: string | null;
  settings?: Record<string, unknown> | null;
}

/**
 * Réglages où le modèle d'un appareil est susceptible d'apparaître.
 *
 * `Model_ID` est celui de l'app Hue, `model` celui de l'app Zigbee2MQTT. Les autres sont les
 * conventions des couches Zigbee et Z-Wave de Homey. L'ordre est celui de la confiance.
 */
const MODEL_KEYS = [
  'Model_ID', 'model', 'modelId', 'model_id', 'modelid',
  'zb_product_id', 'zb_model_id', 'productid', 'product_id', 'device_model',
] as const;

/** Réglages où le fabricant peut apparaître, quand il n'est pas déductible du driver. */
const MANUFACTURER_KEYS = [
  'manufacturername', 'manufacturerName', 'manufacturer',
  'zb_manufacturer_name', 'vendor',
] as const;

/**
 * Types d'appareils dont le profil ne décrit QUE la consommation de l'appareil lui-même.
 *
 * Une prise connectée mesurée à 0,6 W décrit la prise, pas la lampe branchée dessus. Homey, lui,
 * attribue à cette prise la consommation supposée de la charge (14 W pour une innr SP 120 sur un
 * parc réel). Estimer sans le dire ferait donc CHUTER le total affiché tout en ayant l'air plus
 * précis — c'est le pire résultat possible, et c'est pourquoi la v1 le signale à l'appairage
 * plutôt que de le découvrir après coup.
 *
 * Les profils concernés portent `only_self_usage: true` dans leur `model.json`, mais l'index
 * distant ne publie pas ce champ : le type d'appareil en est le prédicteur fiable.
 */
const SELF_USAGE_TYPES: ReadonlySet<string> = new Set([
  'smart_switch', 'smart_dimmer', 'network', 'power_meter', 'ups',
]);

/** Vrai quand le profil ne couvre que l'appareil, pas la charge qu'il pilote. */
export function isSelfUsageOnly(deviceType: string | null | undefined): boolean {
  return deviceType !== null && deviceType !== undefined && SELF_USAGE_TYPES.has(deviceType);
}

export class LibraryIndex {
  private readonly byKey = new Map<string, LibraryModel[]>();

  private constructor(public readonly models: LibraryModel[]) {
    for (const model of models) {
      for (const key of [model.id, model.name, ...model.aliases]) {
        const norm = normalise(key);
        if (norm === '') continue;
        const bucket = this.byKey.get(norm);
        if (bucket) bucket.push(model);
        else this.byKey.set(norm, [model]);
      }
    }
  }

  public get size(): number {
    return this.models.length;
  }

  /** Aplatit la réponse de `GET /library`. Les entrées incomplètes sont ignorées. */
  public static fromIndexJson(raw: unknown): LibraryIndex {
    const root = raw as { manufacturers?: unknown[] } | null;
    const manufacturers = Array.isArray(root?.manufacturers) ? root.manufacturers : [];
    const models: LibraryModel[] = [];

    for (const entry of manufacturers) {
      const m = entry as Record<string, unknown>;
      const dirName = typeof m.dir_name === 'string' ? m.dir_name : typeof m.name === 'string' ? m.name : null;
      if (!dirName) continue;
      const label = typeof m.full_name === 'string' ? m.full_name : dirName;
      const manufacturerAliases = stringArray(m.aliases).concat(dirName, label);
      const list = Array.isArray(m.models) ? m.models : [];

      for (const modelEntry of list) {
        const mo = modelEntry as Record<string, unknown>;
        const id = typeof mo.id === 'string' ? mo.id : null;
        const strategy = typeof mo.calculation_strategy === 'string' ? (mo.calculation_strategy as Strategy) : null;
        if (!id || !strategy) continue;

        models.push({
          manufacturer: dirName,
          manufacturerLabel: label,
          modelLabel: typeof mo.name === 'string' ? mo.name : id,
          model: id,
          id,
          name: typeof mo.name === 'string' ? mo.name : id,
          aliases: stringArray(mo.aliases),
          manufacturerAliases,
          strategy,
          deviceType: typeof mo.device_type === 'string' ? (mo.device_type as DeviceType) : undefined,
          colorModes: stringArray(mo.color_modes).filter(isLutKind),
          standbyPower: typeof mo.standby_power === 'number' ? mo.standby_power : undefined,
          maxPower: typeof mo.max_power === 'number' ? mo.max_power : undefined,
          subProfileCount: typeof mo.sub_profile_count === 'number' ? mo.sub_profile_count : 0,
          hash: typeof mo.hash === 'string' ? mo.hash : undefined,
        });
      }
    }
    return new LibraryIndex(models);
  }

  /** Tous les modèles portant cet identifiant, tous fabricants confondus. */
  public lookup(modelId: string): LibraryModel[] {
    return this.byKey.get(normalise(modelId)) ?? [];
  }

  public get(manufacturer: string, model: string): LibraryModel | null {
    const norm = normalise(manufacturer);
    return this.lookup(model).find((m) => normalise(m.manufacturer) === norm) ?? null;
  }
}

export interface Match {
  model: LibraryModel;
  /** Réglage qui a fourni l'identifiant, pour l'afficher à l'utilisateur. */
  via: string;
  /** Vrai quand le fabricant a lui aussi été confirmé, et pas seulement le modèle. */
  manufacturerConfirmed: boolean;
}

/**
 * Cherche le profil d'un appareil.
 *
 * Quand plusieurs fabricants publient un modèle du même nom, celui dont le nom est confirmé par
 * ailleurs l'emporte. Sans confirmation on retient quand même le premier, mais `Match` le signale
 * pour que l'interface de pairing affiche le doute plutôt que de le cacher.
 */
export function matchDevice(index: LibraryIndex, device: DeviceIdentity): Match | null {
  const hints = manufacturerHints(device);
  let fallback: Match | null = null;

  for (const { key, value } of modelCandidates(device)) {
    const found = index.lookup(value);
    if (found.length === 0) continue;

    const confirmed = found.find((model) => matchesManufacturer(model, hints));
    if (confirmed) return { model: confirmed, via: key, manufacturerConfirmed: true };
    if (!fallback) {
      fallback = { model: found[0] as LibraryModel, via: key, manufacturerConfirmed: false };
    }
  }
  return fallback;
}

/** Valeurs de réglages susceptibles d'être un identifiant de modèle, par ordre de confiance. */
export function modelCandidates(device: DeviceIdentity): Array<{ key: string; value: string }> {
  const settings = device.settings ?? {};
  const out: Array<{ key: string; value: string }> = [];
  for (const key of MODEL_KEYS) {
    const value = settings[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed === '') continue;
    out.push({ key, value: trimmed });
    // Zigbee2MQTT publie parfois deux références séparées par une barre oblique
    // (`ICPSHC24-10EU-IL-1/ICPSHC24-10EU-IL-2`) : chaque moitié est un modèle valide.
    if (trimmed.includes('/')) {
      for (const part of trimmed.split('/')) {
        const p = part.trim();
        if (p !== '') out.push({ key, value: p });
      }
    }
  }
  return out;
}

/** Indices de fabricant : réglages explicites, puis segments de l'identifiant du driver. */
export function manufacturerHints(device: DeviceIdentity): string[] {
  const hints: string[] = [];
  const settings = device.settings ?? {};
  for (const key of MANUFACTURER_KEYS) {
    const value = settings[key];
    if (typeof value === 'string' && value.trim() !== '') hints.push(normalise(value));
  }
  // `homey:app:nl.philips.hue:bulb` → nl, philips, hue, bulb.
  const driverId = device.driverId;
  if (typeof driverId === 'string') {
    for (const token of driverId.split(/[:.\-_]/)) {
      const norm = normalise(token);
      if (norm.length >= 3 && norm !== 'app' && norm !== 'homey') hints.push(norm);
    }
  }
  return hints;
}

function matchesManufacturer(model: LibraryModel, hints: string[]): boolean {
  if (hints.length === 0) return false;
  const names = [model.manufacturer, model.manufacturerLabel ?? '', ...model.manufacturerAliases]
    .map(normalise)
    .filter((n) => n !== '');
  return hints.some((hint) => names.some((name) => name === hint || name.includes(hint) || hint.includes(name)));
}

function isLutKind(value: string): value is LutKind {
  return value === 'brightness' || value === 'color_temp' || value === 'hs';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Clé de comparaison : minuscules, sans espaces ni séparateurs. */
export function normalise(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, '');
}
