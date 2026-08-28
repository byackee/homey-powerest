/**
 * `lib/units.mts` — la frontière d'unités entre Homey et PowerCalc.
 *
 * C'est le module le plus court et le plus dangereux du projet : une erreur ici ne casse rien,
 * elle produit simplement des watts faux que personne ne remarquera. Chaque conversion porte donc
 * la raison de sa formule.
 */

import type { LightState } from './types.mjs';

/**
 * Plage de température de couleur supposée, en mired.
 *
 * ⚠️ Homey normalise `light_temperature` dans 0..1 et **n'expose nulle part la plage physique de
 * la lampe**. La LUT, elle, est indexée en mired absolus. Il faut donc supposer une plage, et 153
 * (≈6500 K) à 500 (2000 K) est celle des Philips Hue — c'est aussi la plage historique de l'API
 * Hue, donc la bonne valeur pour l'écrasante majorité des profils `signify/*`.
 *
 * Pour une lampe d'une autre marque, c'est la principale source d'imprécision de l'app : d'où le
 * réglage par appareil qui permet de la corriger.
 */
export const DEFAULT_MIN_MIRED = 153;
export const DEFAULT_MAX_MIRED = 500;

/** Bornes d'un nombre, avec les `NaN` renvoyés au minimum plutôt que propagés. */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

/**
 * `dim` Homey (0..1) → `bri` PowerCalc (1..255).
 *
 * Le plancher est 1 et non 0 : dans la bibliothèque, `bri = 0` n'existe pas (une lampe allumée au
 * minimum est à 1). Renvoyer 0 ferait tomber la recherche sur le niveau le plus bas par défaut,
 * ce qui marche par accident — on préfère que ce soit intentionnel.
 */
export function dimToBri(dim: number): number {
  return Math.max(1, Math.min(255, Math.round(clamp(dim, 0, 1) * 255)));
}

/**
 * `light_temperature` Homey (0..1) → mired.
 *
 * Homey code 0 = le plus froid et 1 = le plus chaud. Le mired croît avec la chaleur (153 froid,
 * 500 chaud) : les deux échelles vont donc dans le même sens, la conversion est affine directe.
 * Se tromper de sens donnerait des watts plausibles mais systématiquement pris à l'autre bout de
 * la table — l'erreur invisible que ce commentaire existe pour empêcher.
 */
export function temperatureToMired(
  temperature: number,
  minMired: number = DEFAULT_MIN_MIRED,
  maxMired: number = DEFAULT_MAX_MIRED,
): number {
  const lo = Math.min(minMired, maxMired);
  const hi = Math.max(minMired, maxMired);
  return lo + clamp(temperature, 0, 1) * (hi - lo);
}

/**
 * `light_hue` Homey (0..1) → teinte de la table `hs`.
 *
 * ⚠️ La table `hs.csv.gz` n'est PAS en degrés. Vérifié sur `signify/LCT012` : `hue` y va de 0 à
 * **65535** et `sat` de 0 à **255** — l'échelle brute de l'API Philips Hue, celle avec laquelle
 * les mesures ont été prises. Convertir en degrés (0..360) et pourcent (0..100) donnerait une
 * recherche du plus proche voisin qui retomberait toujours sur la première ligne de la table :
 * des watts plausibles, constants, et faux.
 */
export const HS_HUE_MAX = 65535;
export const HS_SAT_MAX = 255;

export function hueToLutScale(hue: number): number {
  return clamp(hue, 0, 1) * HS_HUE_MAX;
}

/** `light_saturation` Homey (0..1) → saturation de la table `hs` (0..255). */
export function saturationToLutScale(saturation: number): number {
  return clamp(saturation, 0, 1) * HS_SAT_MAX;
}

/** Valeurs de capabilities Homey telles que le hub les restitue. */
export interface HomeyLightCapabilities {
  onoff?: boolean | null;
  dim?: number | null;
  light_mode?: string | null;
  light_temperature?: number | null;
  light_hue?: number | null;
  light_saturation?: number | null;
}

export interface MiredRange {
  minMired?: number;
  maxMired?: number;
}

/**
 * Traduit un jeu de capabilities Homey en `LightState` PowerCalc.
 *
 * Le choix couleur/blanc suit `light_mode` quand la lampe l'expose. Beaucoup de lampes ne
 * l'exposent pas : on retombe alors sur la présence de `light_temperature`, puis sur `light_hue`.
 * Une lampe qui n'a ni l'un ni l'autre reste en `bri` seul, ce que la table `brightness` couvre.
 */
export function toLightState(caps: HomeyLightCapabilities, range: MiredRange = {}): LightState {
  const on = caps.onoff === true;
  const state: LightState = { on };
  if (!on) return state;

  if (typeof caps.dim === 'number') state.bri = dimToBri(caps.dim);

  const hasTemp = typeof caps.light_temperature === 'number';
  const hasColor = typeof caps.light_hue === 'number' && typeof caps.light_saturation === 'number';

  // `light_mode` fait autorité quand il existe ; sinon on déduit de ce qui est présent.
  const mode = caps.light_mode ?? (hasTemp ? 'temperature' : hasColor ? 'color' : null);

  if (mode === 'color' && hasColor) {
    state.hue = hueToLutScale(caps.light_hue as number);
    state.sat = saturationToLutScale(caps.light_saturation as number);
  } else if (hasTemp) {
    state.mired = temperatureToMired(caps.light_temperature as number, range.minMired, range.maxMired);
  } else if (hasColor) {
    state.hue = hueToLutScale(caps.light_hue as number);
    state.sat = saturationToLutScale(caps.light_saturation as number);
  }
  return state;
}
