/**
 * `lib/types.mts` — le vocabulaire partagé de l'app.
 *
 * Deux mondes se rencontrent ici et n'ont pas les mêmes unités :
 *
 *  - Home Assistant / PowerCalc raisonne en `bri` 1-255, `mired` 153-500, `hue` 0-65535, `sat` 0-255 (échelle API Hue) ;
 *  - Homey raisonne en `dim`, `light_temperature`, `light_hue`, `light_saturation`, tous dans 0..1.
 *
 * La frontière est `lib/units.mts`, et elle est la seule. Tout ce qui est typé `LightState` ici est
 * déjà EN UNITÉS POWERCALC : aucune valeur Homey brute ne doit descendre plus bas.
 */

/** Stratégies de calcul de la bibliothèque. `composite` et `multi_switch` ne sont pas gérées en v1. */
export type Strategy = 'lut' | 'linear' | 'fixed' | 'multi_switch' | 'composite';

export const SUPPORTED_STRATEGIES: ReadonlySet<Strategy> = new Set<Strategy>(['lut', 'linear', 'fixed']);

/** Ce que la bibliothèque appelle un `device_type`. Sert au libellé et au choix des entrées. */
export type DeviceType =
  | 'camera' | 'cover' | 'fan' | 'generic_iot' | 'light' | 'power_meter' | 'printer'
  | 'smart_dimmer' | 'smart_switch' | 'smart_speaker' | 'television' | 'network'
  | 'vacuum_robot' | 'lawn_mower_robot' | 'heating' | 'ups';

/** `model.json` d'un profil, réduit aux champs que l'app sait exploiter. */
export interface ProfileModel {
  name: string;
  device_type?: DeviceType;
  calculation_strategy: Strategy;
  /** Puissance quand l'appareil est ÉTEINT. */
  standby_power?: number;
  /** Consommation propre de l'appareil quand il est allumé, à AJOUTER au calcul. */
  standby_power_on?: number;
  /** Le profil ne décrit que l'appareil lui-même, pas la charge qu'il pilote (variateur, prise). */
  only_self_usage?: boolean;
  aliases?: string[];
  linked_profile?: string;
  linked_lut?: string;
  fixed_config?: { power?: number; states_power?: Record<string, number> };
  linear_config?: { min_power?: number; max_power?: number; calibrate?: string[] };
}

/** Identité d'un profil dans la bibliothèque. */
export interface ProfileRef {
  /** `dir_name` du fabricant, tel qu'attendu par l'API de téléchargement. */
  manufacturer: string;
  /** Identifiant du modèle, tel qu'attendu par l'API de téléchargement. */
  model: string;
  /** Nom lisible du fabricant, pour l'affichage. */
  manufacturerLabel?: string;
  /** Nom lisible du modèle, pour l'affichage. */
  modelLabel?: string;
}

/**
 * État d'une source, EN UNITÉS POWERCALC.
 *
 * `on` est la seule information toujours disponible. Tout le reste est optionnel parce qu'une
 * lampe non gradable n'a pas de `bri`, et qu'une lampe en mode blanc n'a pas de `hue`.
 */
export interface LightState {
  on: boolean;
  /** 1..255. */
  bri?: number;
  /** 153..500 (microreciprocal degrees). Présent en mode blanc. */
  mired?: number;
  /** 0..65535, échelle de la table `hs`. Présent en mode couleur. */
  hue?: number;
  /** 0..255, échelle de la table `hs`. Présent en mode couleur. */
  sat?: number;
}

/** Résultat d'un calcul, avec de quoi expliquer d'où il sort. */
export interface PowerResult {
  watts: number;
  /** Stratégie effectivement employée. */
  via: Strategy | 'standby';
  /** Table consultée pour une LUT (`color_temp`, `hs`, `brightness`). */
  table?: LutKind;
}

export type LutKind = 'brightness' | 'color_temp' | 'hs';

/** Erreur portant un code stable, pour distinguer « profil absent » de « réseau coupé ». */
export class ProfileError extends Error {
  public constructor(
    message: string,
    public readonly code: 'not_found' | 'unsupported' | 'network' | 'malformed',
  ) {
    super(message);
    this.name = 'ProfileError';
  }
}
