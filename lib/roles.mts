/**
 * `lib/roles.mts` — ce qu'un appareil EST pour le bilan : une entrée ou une charge.
 *
 * Deux remarques du forum ont la même racine : des panneaux solaires rangés parmi les usages, et
 * un compteur P1 impossible à désigner comme entrée. Le diagramme ne connaissait qu'une seule
 * entrée — le drapeau `cumulative` que l'app propriétaire pose ou non —, et tout le reste était
 * une charge.
 *
 * Le choix explicite de l'utilisateur l'emporte, comme pour l'usage : lui seul sait que la prise
 * du garage porte un onduleur, ou que tel module est en réalité le compteur général. Il voyage
 * dans le même réglage que l'usage, sous un préfixe qui ne peut pas désigner une catégorie.
 *
 * Module pur.
 */

export type EnergyRole = 'grid' | 'solar' | 'load';

/** Les choix proposés à l'utilisateur, tels qu'ils sont stockés dans `categoryOverrides`. */
export const ROLE_OVERRIDES: Readonly<Record<string, Exclude<EnergyRole, 'load'>>> = {
  'source:grid': 'grid',
  'source:solar': 'solar',
};

export interface RoleInput {
  /** Drapeau `energyObj.cumulative` de Homey. */
  cumulative: boolean;
  deviceClass?: string | null;
  /** Ce qui est branché sur une prise, déclaré dans Homey. */
  virtualClass?: string | null;
  /** Le réglage de l'utilisateur : un usage, un rôle, ou rien. */
  override?: string | null;
}

export function energyRole(input: RoleInput): EnergyRole {
  const forced = ROLE_OVERRIDES[input.override ?? ''];
  if (forced) return forced;
  // Un USAGE choisi à la main ne change pas le rôle : il ne range que les charges. Avant cette
  // version, des panneaux comptés comme charges ont pu recevoir un usage — il ne doit pas les y
  // retenir. Et choisir un usage sur la ligne d'un compteur ne doit pas en faire un appareil.
  if (input.cumulative) return 'grid';
  if (input.deviceClass === 'solarpanel' || input.virtualClass === 'solarpanel') return 'solar';
  return 'load';
}

/**
 * La puissance PRODUITE, positive, à partir de la `measure_power` brute.
 *
 * Homey n'a pas une convention mais deux : un appareil de classe `solarpanel` rapporte sa
 * production en positif, une prise déclarée « panneau solaire » la rapporte en négatif — c'est
 * Homey qui l'inverse ensuite. Une valeur du mauvais signe est une consommation (veille nocturne
 * de l'onduleur) : elle ne produit rien.
 */
export function producedWatts(watts: number, deviceClass?: string | null, virtualClass?: string | null): number {
  if (!Number.isFinite(watts)) return 0;
  const inverted = deviceClass !== 'solarpanel' && virtualClass === 'solarpanel';
  return Math.max(0, inverted ? -watts : watts);
}
