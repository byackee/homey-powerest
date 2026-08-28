/**
 * `lib/mirror.mts` — quelles capabilities l'appareil compagnon doit porter.
 *
 * Le compagnon ne se contente pas d'afficher une consommation : il **remplace** l'appareil réel
 * dans l'interface. Il en reprend donc les commandes — allumage, gradation, couleur — et y ajoute
 * la puissance estimée, que l'appareil réel ne pourra jamais porter.
 *
 * Ce que le SDK autorise, et qui rend la chose possible :
 *  - une app déclare ce qu'elle veut sur SES propres appareils, et peut les faire évoluer à chaud
 *    avec `addCapability()` / `removeCapability()` ;
 *  - `setCapabilityValue` sur l'appareil d'une AUTRE app est permis (scope `homey.device.control`,
 *    accordé aux apps), contrairement à `setDeviceSettings` qui exige `homey.device`.
 *
 * Ce module ne fait que décider de la LISTE. Il est pur pour que cette décision soit testable
 * sans Homey : une capability oubliée ici, et la lampe devient impilotable depuis sa propre tuile.
 */

/**
 * Capabilities reprises de la source, dans l'ordre d'affichage de la tuile.
 *
 * L'ordre n'est pas cosmétique : Homey construit la tuile dans l'ordre déclaré, et une lampe dont
 * la gradation passerait après la couleur serait pénible à utiliser au quotidien.
 */
export const MIRRORED_CAPABILITIES = [
  'onoff',
  'dim',
  'light_hue',
  'light_saturation',
  'light_temperature',
  'light_mode',
] as const;

/** Capabilities propres au compagnon, que la source n'a pas et n'aura jamais. */
export const OWN_CAPABILITIES = ['measure_power', 'meter_power'] as const;

/**
 * Capabilities reprises SANS écriture vers la source.
 *
 * `light_mode` est renseigné par la lampe pour dire dans quel mode elle se trouve ; le pousser
 * dans l'autre sens ferait basculer une lampe en couleur sans qu'on ait choisi de couleur.
 */
const READ_ONLY_MIRROR = new Set<string>(['light_mode']);

export type MirroredCapability = (typeof MIRRORED_CAPABILITIES)[number];

/** Les capabilities que le compagnon doit porter, d'après celles de la source. */
export function plannedCapabilities(sourceCapabilities: readonly string[]): string[] {
  const source = new Set(sourceCapabilities);
  const mirrored = MIRRORED_CAPABILITIES.filter((capability) => source.has(capability));
  return [...mirrored, ...OWN_CAPABILITIES];
}

/** Celles qui doivent être réécrites vers la source quand l'utilisateur agit sur le compagnon. */
export function writableCapabilities(sourceCapabilities: readonly string[]): string[] {
  return plannedCapabilities(sourceCapabilities)
    .filter((capability) => (MIRRORED_CAPABILITIES as readonly string[]).includes(capability))
    .filter((capability) => !READ_ONLY_MIRROR.has(capability));
}

/**
 * Différence entre ce que porte le compagnon et ce qu'il devrait porter.
 *
 * ⚠️ `removeCapability` **détruit l'historique Insights** de la capability, et le ré-ajout ne le
 * restaure pas. On ne retire donc QUE ce qui n'est plus mirroir : jamais sur une lecture douteuse,
 * et jamais `measure_power`/`meter_power`, dont le retrait effacerait l'historique de
 * consommation — c'est-à-dire tout l'intérêt de l'app.
 */
export function capabilityDiff(
  current: readonly string[],
  planned: readonly string[],
): { add: string[]; remove: string[] } {
  const has = new Set(current);
  const want = new Set(planned);
  const protectedCaps = new Set<string>(OWN_CAPABILITIES);

  return {
    add: planned.filter((capability) => !has.has(capability)),
    remove: current.filter((capability) => !want.has(capability) && !protectedCaps.has(capability)),
  };
}
