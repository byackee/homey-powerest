/**
 * `api.mts` — les points d'entrée consommés par la page de réglages.
 *
 * ⚠️ Un appel à l'API d'une app est coupé à 10 s par Homey. Aucun de ces gestionnaires ne
 * déclenche donc de téléchargement synchrone : `refreshLibrary` lance le rechargement et rend la
 * main immédiatement, la page interroge ensuite `getStatus`.
 */

import type PowerEstimateApp from './app.mjs';

interface ApiArgs {
  homey: { app: unknown };
}

function app(args: ApiArgs): PowerEstimateApp {
  return args.homey.app as PowerEstimateApp;
}

export async function getStatus(args: ApiArgs): Promise<{
  connected: boolean;
  libraryLoaded: boolean;
  libraryModels: number;
  libraryError: string | null;
}> {
  const instance = app(args);
  const index = instance.getIndex();
  return {
    connected: instance.getHub().connected,
    libraryLoaded: index !== null,
    libraryModels: index?.size ?? 0,
    libraryError: instance.getIndexError(),
  };
}

export async function getCandidates(args: ApiArgs): Promise<Array<{
  id: string;
  name: string;
  zone: string | null;
  profile: string | null;
  strategy: string | null;
  supported: boolean;
}>> {
  return app(args).listCandidates().map((candidate) => ({
    id: candidate.device.id,
    name: candidate.device.name,
    zone: candidate.device.zoneName,
    profile: candidate.match?.label ?? null,
    strategy: candidate.match?.strategy ?? null,
    supported: candidate.match?.supported ?? false,
  }));
}

export async function refreshLibrary(args: ApiArgs): Promise<{ started: true }> {
  const instance = app(args);
  // Rendu sans attendre : 450 ko sur une liaison lente dépasseraient la coupure de 10 s.
  void instance.warmIndex(true);
  return { started: true };
}

export async function getTrace(args: ApiArgs): Promise<string[]> {
  return app(args).getTrace();
}
