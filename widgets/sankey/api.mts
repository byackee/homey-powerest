/**
 * `widgets/sankey/api.mts` — le flux d'énergie servi au diagramme.
 *
 * Rien n'est calculé ici : le modèle vient de `lib/sankey`, qui est pur et testé. Ce fichier est
 * une façade, pour que la vue n'ait jamais à décider ce qui est une source et ce qui est une
 * charge — la confusion qui doublerait le total du logement.
 *
 * Deux régimes, une seule forme de réponse. En instantané, le modèle est bâti sur les
 * `measure_power` que le hub écoute ; sur une période, il l'est sur les rapports d'énergie de
 * Homey, en kWh. La vue ne doit pas avoir à distinguer les deux : elle reçoit dans les deux cas
 * un `SankeyModel`, une unité, et la facture de la période quand elle existe.
 *
 * ⚠️ Homey ne lit que l'export par défaut, et ses clés doivent porter exactement les noms déclarés
 * dans `api` de `widget.compose.json`. Des exports nommés s'installent sans un mot puis répondent
 * `Missing implementation for api endpoint`.
 */

import type Homey from 'homey';

import type PowerEstimateApp from '../../app.mjs';
import { GROUPINGS, type SankeyModel } from '../../lib/sankey.mjs';
import { isPeriod, type Period } from '../../lib/report.mjs';

interface Request {
  homey: Homey.App['homey'];
  query?: Record<string, string | undefined>;
}

/** Ce que la vue reçoit, quel que soit le régime. */
type FlowResponse = SankeyModel & {
  labels: Record<string, string>;
  /** `W` en instantané, `kWh` sur une période. La vue n'écrit plus l'unité en dur. */
  unit: string;
  period: Period;
  /** Coût de la période, ou `null` en instantané : Homey ne le donne pas en direct. */
  cost: number | null;
  currency: string | null;
};

/**
 * Libellés de la vue, traduits ici.
 *
 * Une page de widget n'a pas accès à `homey.__` : tout texte écrit dans son HTML est figé dans
 * une seule langue. Les widgets étaient donc entièrement en français dans une app qui se déclare
 * trilingue. Les libellés voyagent avec la donnée.
 */
function labels(homey: Homey.App['homey']): Record<string, string> {
  const keys = ['identified', 'unmeasured', 'sum_only', 'no_meter', 'nothing', 'of_home',
    'no_reply', 'no_data', 'draw_failed', 'no_library'];
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = homey.__(`widget.${key}`);
    out[key] = typeof value === 'string' && value !== `widget.${key}` ? value : key;
  }
  return out;
}

export default {
  async getFlow({ homey, query }: Request): Promise<FlowResponse> {
    // Le regroupement vient du réglage du widget. Une valeur inconnue retombe sur la vue croisée
    // plutôt que d'échouer : un widget mal configuré doit afficher quelque chose.
    const grouping = GROUPINGS[query?.['grouping'] ?? ''] ?? GROUPINGS['category+zone'];
    const app = homey.app as PowerEstimateApp;

    // Même règle pour la période : une valeur inconnue retombe sur l'instantané, qui est le seul
    // régime à ne dépendre d'aucun rapport et donc à répondre toujours.
    const asked = query?.['period'];
    const period: Period = isPeriod(asked) ? asked : 'live';

    if (period === 'live') {
      return {
        ...app.energyFlow(grouping),
        labels: labels(homey),
        unit: 'W',
        period,
        cost: null,
        currency: null,
      };
    }

    return { ...await app.energyFlowOverPeriod(period, grouping), labels: labels(homey), period };
  },
};
