/**
 * `widgets/power/api.mts` — la donnée servie au widget de tableau de bord.
 *
 * Le widget existe parce qu'une app ne peut PAS poser `measure_power` sur l'appareil d'une autre
 * app : les capabilities appartiennent au driver propriétaire, et aucune opération de l'API n'en
 * ajoute (`updateDevice` ne touche que nom, zone, note, icône, classe virtuelle, indicateur et
 * masquage). L'estimation vit donc dans un appareil compagnon — que l'utilisateur peut masquer —
 * et ce widget la ramène VISUELLEMENT à côté de l'appareil réel, qui est ce qu'on regarde.
 *
 * L'utilisateur désigne l'appareil RÉEL, pas le compagnon : c'est celui dont il connaît le nom.
 * La correspondance se fait ici, par le `sourceId` mémorisé dans le compagnon.
 */

import type Homey from 'homey';

import type PowerEstimateApp from '../../app.mjs';

interface Request {
  homey: Homey.App['homey'];
  query: Record<string, string | undefined>;
}

export interface EstimateView {
  /** Faux quand aucun compagnon ne suit cet appareil : le widget le dit au lieu d'afficher 0 W. */
  found: boolean;
  name: string | null;
  profile: string | null;
  watts: number | null;
  kwh: number | null;
  /** Vrai tant que la source n'est pas exclue de l'Énergie : le total Homey est alors doublé. */
  doubleCounted: boolean;
  /**
   * Libellés de la vue.
   *
   * Une page de widget n'a pas accès à `homey.__` : sans cela son texte reste figé dans une seule
   * langue, ce qui était le cas — tout était en français.
   */
  labels: Record<string, string>;
}

function labels(homey: Homey.App['homey']): Record<string, string> {
  const keys = ['no_estimate', 'add_device', 'error', 'double_counted', 'no_reply'];
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = homey.__(`widget.${key}`);
    out[key] = typeof value === 'string' && value !== `widget.${key}` ? value : key;
  }
  return out;
}

export default {
  async getEstimate({ homey, query }: Request): Promise<EstimateView> {
    const sourceId = query['sourceId'];
    const empty: EstimateView = { found: false, name: null, profile: null, watts: null, kwh: null, doubleCounted: false, labels: labels(homey) };
    if (typeof sourceId !== 'string' || sourceId === '') return empty;

    const driver = homey.drivers.getDriver('estimator');
    const companion = driver.getDevices().find((device) => device.getStoreValue('sourceId') === sourceId);
    if (!companion) return empty;

    const read = (capability: string): number | null => {
      const value = companion.getCapabilityValue(capability);
      return typeof value === 'number' ? value : null;
    };

    return {
      found: true,
      name: companion.getName(),
      profile: (companion.getSetting('profile_label') as string | undefined) ?? null,
      watts: read('measure_power'),
      kwh: read('meter_power'),
      // Reconstruit depuis l'état RÉEL de la source, comme le fait l'appareil compagnon : c'est le
      // seul avertissement qui compte, parce qu'il signale un total d'Énergie faux.
      doubleCounted: isDoubleCounted(homey, sourceId, companion.getSetting('exclude_source') !== false),
      labels: labels(homey),
    };
  },
};

/** La source est-elle encore comptée par l'approximation native de Homey ? */
function isDoubleCounted(homey: Homey.App['homey'], sourceId: string, wanted: boolean): boolean {
  if (!wanted) return false;
  const app = homey.app as PowerEstimateApp;
  const source = app.getHub().getDevice(sourceId);
  return (source?.settings ?? {})['energy_exclude'] !== true;
}
