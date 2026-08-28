/**
 * `lib/strategies.mts` — l'aiguillage entre les stratégies de calcul de la bibliothèque.
 *
 * Trois stratégies sur cinq sont gérées, et elles couvrent 734 des 744 modèles publiés :
 * `lut` (531), `fixed` (134), `linear` (69). Les deux autres, `composite` (7) et `multi_switch`
 * (3), demandent un moteur de conditions qui n'a pas sa place dans une v1 pour dix profils.
 */

import type { LightState, LutKind, PowerResult, ProfileModel } from './types.mjs';
import { ProfileError, SUPPORTED_STRATEGIES } from './types.mjs';
import type { LutTable } from './lut.mjs';

/** Tables chargées pour un profil, indexées par type. Une seule est utilisée à la fois. */
export type LutTables = Partial<Record<LutKind, LutTable>>;

/**
 * Puissance instantanée d'un appareil.
 *
 * Éteint, la seule information disponible est `standby_power`. Allumé, la stratégie donne la
 * consommation de la charge, à laquelle s'ajoute `standby_power_on` : la consommation propre de
 * l'appareil (un variateur mural continue de tirer son watt en pilotant la lampe).
 */
export function computePower(
  model: ProfileModel,
  tables: LutTables,
  state: LightState,
): PowerResult {
  if (!state.on) {
    return { watts: round3(model.standby_power ?? 0), via: 'standby' };
  }

  const strategy = model.calculation_strategy;
  if (!SUPPORTED_STRATEGIES.has(strategy)) {
    throw new ProfileError(`stratégie ${strategy} non gérée`, 'unsupported');
  }

  const selfUsage = model.standby_power_on ?? 0;

  if (strategy === 'fixed') {
    // Beaucoup de profils `fixed` réels n'ont PAS de `fixed_config` : ils décrivent un appareil
    // dont la seule consommation connue est la sienne, portée par `standby_power_on`. Vérifié sur
    // la bibliothèque publiée — `eq-3/HmIP-DRSI1`, `neo-coolcam/NAS-WR01Z` sont dans ce cas.
    // Exiger `fixed_config` rejetterait ces profils alors qu'ils sont parfaitement exploitables.
    const base = fixedPower(model);
    if (base === null && selfUsage === 0) {
      throw new ProfileError('profil fixed sans puissance exploitable', 'malformed');
    }
    return { watts: round3((base ?? 0) + selfUsage), via: 'fixed' };
  }
  if (strategy === 'linear') {
    return { watts: round3(linearPower(model, state) + selfUsage), via: 'linear' };
  }

  const picked = pickTable(tables, state);
  if (!picked) throw new ProfileError('aucune table LUT utilisable pour cet état', 'not_found');
  return { watts: round3(picked.table.lookup(state) + selfUsage), via: 'lut', table: picked.kind };
}

/**
 * Choisit la table à consulter d'après ce que la lampe expose réellement.
 *
 * L'ordre n'est pas un goût : une lampe en mode couleur DOIT aller sur `hs`, sinon on lui applique
 * la courbe du blanc, qui sous-estime largement (une LED colorée n'allume qu'une partie de ses
 * puces). Le repli vers `brightness` sert les lampes gradables monochromes.
 */
export function pickTable(tables: LutTables, state: LightState): { kind: LutKind; table: LutTable } | null {
  if (state.hue !== undefined && state.sat !== undefined && tables.hs) {
    return { kind: 'hs', table: tables.hs };
  }
  if (state.mired !== undefined && tables.color_temp) {
    return { kind: 'color_temp', table: tables.color_temp };
  }
  if (tables.brightness) return { kind: 'brightness', table: tables.brightness };
  // Dernier recours : une table existe mais pas celle attendue. Mieux vaut la courbe du blanc
  // qu'aucune valeur du tout — l'app le signalera dans la raison affichée.
  if (tables.color_temp) return { kind: 'color_temp', table: tables.color_temp };
  if (tables.hs) return { kind: 'hs', table: tables.hs };
  return null;
}

/** Quelles tables un profil doit télécharger, d'après sa stratégie. */
export const LUT_FILES: Record<LutKind, string> = {
  brightness: 'brightness.csv.gz',
  color_temp: 'color_temp.csv.gz',
  hs: 'hs.csv.gz',
};

/** Puissance déclarée par `fixed_config`, ou `null` quand le profil n'en porte pas. */
function fixedPower(model: ProfileModel): number | null {
  const config = model.fixed_config;
  if (!config) return null;
  if (typeof config.power === 'number') return config.power;
  // `states_power` décrit une consommation par état (`playing`, `idle`…). Sans lecture de l'état
  // média côté Homey, on retient l'état allumé le plus courant plutôt que d'échouer.
  const states = config.states_power;
  if (states) {
    for (const key of ['on', 'playing', 'active', 'idle']) {
      const value = states[key];
      if (typeof value === 'number') return value;
    }
    const first = Object.values(states).find((v) => typeof v === 'number');
    if (typeof first === 'number') return first;
  }
  return null;
}

/**
 * Stratégie linéaire.
 *
 * Deux formes existent dans la bibliothèque : `min_power`/`max_power`, interpolés sur la plage de
 * luminosité, et `calibrate`, une liste de points `"<bri> -> <watt>"` interpolés par morceaux.
 * `calibrate` gagne quand les deux sont présents : c'est la donnée mesurée.
 */
function linearPower(model: ProfileModel, state: LightState): number {
  const config = model.linear_config;
  if (!config) throw new ProfileError('profil linear sans linear_config', 'malformed');

  const bri = state.bri ?? 255;

  const points = parseCalibration(config.calibrate);
  if (points.length >= 2) return interpolate(points, bri);
  if (points.length === 1) return (points[0] as [number, number])[1];

  const min = config.min_power ?? 0;
  const max = config.max_power;
  if (typeof max !== 'number') {
    throw new ProfileError('profil linear sans max_power ni calibrate', 'malformed');
  }
  const t = Math.max(0, Math.min(1, (bri - 1) / (255 - 1)));
  return min + (max - min) * t;
}

/** `["1 -> 0.3", "255 -> 8.5"]` → points triés. Les entrées illisibles sont ignorées. */
export function parseCalibration(entries: string[] | undefined): Array<[number, number]> {
  if (!entries) return [];
  const points: Array<[number, number]> = [];
  for (const entry of entries) {
    const match = /^\s*([0-9.]+)\s*->\s*([0-9.]+)\s*$/.exec(entry);
    if (!match) continue;
    const x = Number(match[1]);
    const y = Number(match[2]);
    if (Number.isFinite(x) && Number.isFinite(y)) points.push([x, y]);
  }
  return points.sort((a, b) => a[0] - b[0]);
}

/** Interpolation linéaire par morceaux, bornée aux extrémités. */
export function interpolate(points: Array<[number, number]>, x: number): number {
  const first = points[0] as [number, number];
  const last = points[points.length - 1] as [number, number];
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1] as [number, number];
    const b = points[i] as [number, number];
    if (x <= b[0]) {
      const span = b[0] - a[0];
      const t = span === 0 ? 0 : (x - a[0]) / span;
      return a[1] + (b[1] - a[1]) * t;
    }
  }
  return last[1];
}

/** Les watts sont affichés au centième : au-delà, on exposerait le bruit de la mesure. */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
