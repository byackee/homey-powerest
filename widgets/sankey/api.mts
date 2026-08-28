/**
 * `widgets/sankey/api.mts` — le flux d'énergie servi au diagramme.
 *
 * Rien n'est calculé ici : le modèle vient de `lib/sankey`, qui est pur et testé. Ce fichier est
 * une façade, pour que la vue n'ait jamais à décider ce qui est une source et ce qui est une
 * charge — la confusion qui doublerait le total du logement.
 *
 * ⚠️ Homey ne lit que l'export par défaut, et ses clés doivent porter exactement les noms déclarés
 * dans `api` de `widget.compose.json`. Des exports nommés s'installent sans un mot puis répondent
 * `Missing implementation for api endpoint`.
 */

import type Homey from 'homey';

import type PowerEstimateApp from '../../app.mjs';
import type { SankeyModel } from '../../lib/sankey.mjs';

interface Request {
  homey: Homey.App['homey'];
}

export default {
  async getFlow({ homey }: Request): Promise<SankeyModel> {
    return (homey.app as PowerEstimateApp).energyFlow();
  },
};
