/**
 * `lib/threshold.mts` — le franchissement d'un seuil.
 *
 * Une carte « la puissance dépasse X » doit se déclencher au MOMENT du franchissement, pas à
 * chaque évaluation où la valeur se trouve au-dessus. La différence n'est pas cosmétique : un
 * déclenchement répété toutes les minutes tant que la maison consomme fait partir la notification
 * en boucle, ou pire, rallume en boucle ce que le Flow pilote.
 *
 * Le seuil vit dans l'argument de CHAQUE Flow, que l'app ne connaît pas à l'avance. Elle publie
 * donc la valeur précédente et la nouvelle, et chaque Flow juge son propre franchissement — c'est
 * ce qui permet à dix Flows d'avoir dix seuils différents sans que l'app en sache rien.
 */

/** Vrai au seul passage de `previous` à `current` par-dessus `threshold`. */
export function crossedUp(previous: number, current: number, threshold: number): boolean {
  if (!Number.isFinite(previous) || !Number.isFinite(current) || !Number.isFinite(threshold)) return false;
  return previous <= threshold && current > threshold;
}

/** Vrai au seul passage sous le seuil. Symétrique, pour que les deux sens se valent. */
export function crossedDown(previous: number, current: number, threshold: number): boolean {
  if (!Number.isFinite(previous) || !Number.isFinite(current) || !Number.isFinite(threshold)) return false;
  return previous >= threshold && current < threshold;
}
