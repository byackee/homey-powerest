/**
 * `api.mts` — les points d'entrée consommés par la page de réglages.
 *
 * ⚠️ Homey ne lit QUE l'export par défaut de ce module, et il doit être un objet dont les clés
 * portent exactement les noms déclarés dans `api` de `app.json`. Des exports nommés compilent,
 * se valident et s'installent sans une erreur — puis chaque appel répond
 * `Missing implementation for api endpoint "<nom>"` à l'exécution. Constaté sur cette app.
 *
 * ⚠️ Un appel à l'API d'une app est coupé à 10 s par Homey. Aucun gestionnaire ne déclenche donc
 * de téléchargement synchrone : `refreshLibrary` lance le rechargement et rend la main, la page
 * interroge ensuite `getStatus`.
 */

import type PowerEstimateApp from './app.mjs';

interface Request {
  homey: { app: unknown };
}

function appOf(request: Request): PowerEstimateApp {
  return request.homey.app as PowerEstimateApp;
}

export interface StatusResponse {
  connected: boolean;
  libraryLoaded: boolean;
  libraryModels: number;
  libraryError: string | null;
  candidates: number;
  estimable: number;
}

export interface CandidateResponse {
  id: string;
  name: string;
  zone: string | null;
  profile: string | null;
  strategy: string | null;
  supported: boolean;
  selfUsageOnly: boolean;
}

export default {
  async getStatus({ homey }: Request): Promise<StatusResponse> {
    const app = appOf({ homey });
    const index = app.getIndex();
    // Le décompte se fait ici plutôt que dans la page : `listCandidates` est la seule définition
    // de « estimable », et la dupliquer en JavaScript de settings la ferait diverger.
    const candidates = index ? app.listCandidates() : [];
    return {
      connected: app.getHub().connected,
      libraryLoaded: index !== null,
      libraryModels: index?.size ?? 0,
      libraryError: app.getIndexError(),
      candidates: candidates.length,
      estimable: candidates.filter((c) => c.match?.supported === true).length,
    };
  },

  async getCandidates({ homey }: Request): Promise<CandidateResponse[]> {
    return appOf({ homey }).listCandidates().map((candidate) => ({
      id: candidate.device.id,
      name: candidate.device.name,
      zone: candidate.device.zoneName,
      profile: candidate.match?.label ?? null,
      strategy: candidate.match?.strategy ?? null,
      supported: candidate.match?.supported ?? false,
      selfUsageOnly: candidate.match?.selfUsageOnly ?? false,
    }));
  },

  async refreshLibrary({ homey }: Request): Promise<{ started: true }> {
    // Rendu sans attendre : 450 ko sur une liaison lente dépasseraient la coupure de 10 s.
    void appOf({ homey }).warmIndex(true);
    return { started: true };
  },

  async getTrace({ homey }: Request): Promise<string[]> {
    return appOf({ homey }).getTrace();
  },
};
