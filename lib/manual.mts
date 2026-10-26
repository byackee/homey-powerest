/**
 * `lib/manual.mts` — la consommation saisie à la main.
 *
 * Deux situations la rendent indispensable, et aucune n'est marginale :
 *
 *  1. **La bibliothèque ne connaît pas l'appareil.** Sur un parc réel de 94 appareils, 12 des 35
 *     candidats n'ont aucun profil : un ventilateur Dyson, une télévision, un module de chaudière,
 *     une imprimante. Sans saisie manuelle, l'app n'a rien à leur dire.
 *  2. **Le profil décrit autre chose que ce qu'on veut mesurer.** Une prise connectée porte un
 *     profil `only_self_usage` : `innr/SP 120` vaut 0,6 W, ce qui est la PRISE et non la lampe
 *     branchée dessus. La valeur est juste et pourtant trompeuse ; seule la main de l'utilisateur
 *     sait ce qui est au bout.
 *
 * Le mode manuel ne réécrit aucun moteur : il fabrique un `ProfileModel` que
 * `computePower` traite exactement comme un profil de la bibliothèque. Une seule implémentation
 * des stratégies, donc un seul endroit où un défaut peut se cacher.
 */

import { ProfileError, SUPPORTED_STRATEGIES, type ProfileModel, type Strategy } from './types.mjs';

/** Comment la puissance d'un appareil est déterminée. */
export type PowerMode = 'profile' | 'fixed' | 'linear';

export const POWER_MODES: readonly PowerMode[] = ['profile', 'fixed', 'linear'];

export function isPowerMode(value: unknown): value is PowerMode {
  return typeof value === 'string' && (POWER_MODES as readonly string[]).includes(value);
}

/** Les réglages manuels, tels que la page de réglages les fournit. */
export interface ManualSettings {
  mode: unknown;
  /** Puissance quand l'appareil est éteint, en W. */
  powerOff: unknown;
  /** Puissance quand il est allumé, en W. Mode `fixed`. */
  powerOn: unknown;
  /** Puissance à la gradation minimale, en W. Mode `linear`. */
  powerMin: unknown;
  /** Puissance à la gradation maximale, en W. Mode `linear`. */
  powerMax: unknown;
}

/**
 * Construit un profil équivalent à partir des réglages.
 *
 * Rend `null` en mode `profile` : c'est alors la bibliothèque qui fait foi, et fabriquer un
 * modèle de repli masquerait un profil manquant derrière des watts inventés.
 */
export function manualModel(settings: ManualSettings): ProfileModel | null {
  const mode = isPowerMode(settings.mode) ? settings.mode : 'profile';
  if (mode === 'profile') return null;

  const off = watts(settings.powerOff, 0);

  if (mode === 'fixed') {
    return {
      name: 'Saisie manuelle',
      calculation_strategy: 'fixed',
      standby_power: off,
      fixed_config: { power: watts(settings.powerOn, 0) },
    };
  }

  const min = watts(settings.powerMin, 0);
  const max = watts(settings.powerMax, 0);
  return {
    name: 'Saisie manuelle',
    calculation_strategy: 'linear',
    standby_power: off,
    // `max_power` en dessous de `min_power` donnerait une courbe décroissante : une lampe qui
    // consommerait MOINS en montant. On remet les bornes dans l'ordre plutôt que de refuser la
    // saisie, parce qu'inverser deux champs est l'erreur la plus banale d'un formulaire.
    linear_config: { min_power: Math.min(min, max), max_power: Math.max(min, max) },
  };
}

/** Le mode effectif : `profile` retombe sur `fixed` quand aucun profil n'est disponible. */
export function effectiveMode(setting: unknown, hasProfile: boolean): PowerMode {
  const mode = isPowerMode(setting) ? setting : 'profile';
  if (mode === 'profile' && !hasProfile) return 'fixed';
  return mode;
}

/**
 * Ce que l'appairage a appris du profil choisi : sa stratégie, ou l'erreur qui l'a empêché de la lire.
 */
export type MetaOutcome = { strategy: Strategy } | { error: unknown };

/**
 * Vrai quand l'appareil doit naître en mode profil.
 *
 * Seul un refus DÉFINITIF de la bibliothèque justifie la saisie manuelle : une stratégie non gérée,
 * un profil absent ou illisible. Une coupure réseau, un délai dépassé ou toute erreur inconnue sont
 * passagers, et l'appareil sait déjà réessayer avec un back-off.
 *
 * ⚠️ Traiter tout échec comme définitif était le défaut de la 1.2.0 : une seule requête manquée à
 * l'appairage effaçait le modèle du `store`, et l'appareil restait à 0 W en « saisie manuelle »
 * pour toujours — repasser le réglage sur « Profil mesuré » n'y pouvait rien, faute de modèle.
 * 79 lampes Hue d'un même utilisateur sont tombées ainsi d'un coup.
 */
export function keepsProfile(outcome: MetaOutcome): boolean {
  if ('strategy' in outcome) return SUPPORTED_STRATEGIES.has(outcome.strategy);
  const err = outcome.error;
  return !(err instanceof ProfileError) || err.code === 'network';
}

/**
 * Vrai pour un appareil en saisie manuelle qui n'a JAMAIS été configuré, et ne mesure donc rien.
 *
 * C'est la signature exacte des appareils laissés par le défaut décrit dans `keepsProfile` : aucun
 * modèle retenu, et toutes les puissances à leur valeur par défaut de zéro. Un tel appareil peut
 * être rapproché à nouveau de la bibliothèque sans risque — il ne produit rien qu'on puisse perdre.
 * Dès qu'une seule puissance est saisie, la main de l'utilisateur fait foi et on n'y touche plus.
 */
export function isUnconfiguredManual(storeModel: unknown, settings: ManualSettings): boolean {
  if (typeof storeModel === 'string' && storeModel !== '') return false;
  if (settings.mode !== 'fixed') return false;
  return [settings.powerOff, settings.powerOn, settings.powerMin, settings.powerMax]
    .every((value) => watts(value, 0) === 0);
}

/** Une puissance saisie, débarrassée du vide, du texte et du négatif. */
function watts(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}
