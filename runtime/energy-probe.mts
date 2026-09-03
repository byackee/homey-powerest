/**
 * `runtime/energy-probe.mts` — l'instrument qui tranche la question des scopes.
 *
 * Une app déclarant `homey:manager:api` ne reçoit PAS tous les droits de la Web API. Vérifié sur
 * une Homey Pro : `devices.setDeviceSettings` répond `Missing Scopes`, faute de `homey.device`.
 * Or `ManagerEnergy` — les rapports jour/semaine/mois/année, la devise, les prix élec/gaz/eau —
 * exige `homey.energy.readonly`, et `ManagerInsights` exige `homey.insights.readonly`. Aucune
 * documentation ne dit si une app les reçoit. Tant que la réponse est inconnue, on ne peut pas
 * choisir entre « transposer le tableau de bord Énergie » et « refaire son propre historique ».
 *
 * Cette sonde ne fait donc qu'une chose : appeler chaque opération convoitée et classer sa
 * réponse. Elle rapporte aussi la FORME de ce qui revient, parce que la spécification embarquée
 * avec `homey-api` décrit les chemins et les paramètres, jamais le schéma de retour — et sans
 * cette forme on ne peut pas dessiner un widget.
 *
 * Elle ouvre son propre client plutôt que d'emprunter celui du hub : les scopes sont les mêmes,
 * et le hub garde ainsi son encapsulation intacte pour un instrument qui n'a pas vocation à
 * rester. Elle n'appelle jamais `connect()` — aucun socket, aucun abonnement — et détruit son
 * client en partant.
 *
 * ⚠️ Code de recherche. Il ne s'exécute que sous `homey app run`, quand `env.json` porte
 * `ENERGY_PROBE = "1"`, et n'a aucune raison d'atteindre le store.
 */

import type Homey from 'homey';
import { HomeyAPI } from 'homey-api';

type Logger = (...args: unknown[]) => void;

/** Une méthode de manager telle que `homey-api` la génère depuis sa spécification. */
type ProbeMethod = (opts?: Record<string, string>) => Promise<unknown>;
type ProbeManager = Record<string, ProbeMethod | undefined>;

/**
 * Le verdict d'un appel.
 *
 * `scope` est le seul qui compte vraiment : il distingue « l'app n'a pas le droit » de « l'appel
 * n'existe pas » et de « la Homey n'a pas la donnée ». Les confondre ferait conclure à un refus
 * là où il n'y a qu'un logement sans compteur de gaz.
 */
export type Verdict = 'ok' | 'scope' | 'absent' | 'erreur';

export interface ProbeResult {
  /** `manager.méthode`, tel qu'on l'écrirait dans le code. */
  call: string;
  /** Le scope exigé par la spécification pour cet appel. */
  scope: string;
  verdict: Verdict;
  /** La forme du résultat, ou le message d'erreur. */
  detail: string;
}

/** Bornes du résumé de forme : un rapport d'année entier noierait la réponse. */
const MAX_DEPTH = 3;
const MAX_KEYS = 12;
const MAX_STRING = 32;

/**
 * Rend la FORME d'une valeur, jamais son volume.
 *
 * Les nombres sont écrits tels quels — un rapport dont on ne voit pas les watts ne prouve rien —
 * mais les tableaux sont réduits à leur cardinal et à la forme de leur premier élément.
 */
function describe(value: unknown, depth = 0): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (depth >= MAX_DEPTH) return `[${value.length} × …]`;
    return `[${value.length} × ${describe(value[0], depth + 1)}]`;
  }

  const type = typeof value;
  if (type === 'string') {
    const text = value as string;
    return `"${text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}…` : text}"`;
  }
  if (type !== 'object') return String(value);

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return '{}';
  if (depth >= MAX_DEPTH) return `{${entries.length} clés}`;

  const shown = entries.slice(0, MAX_KEYS)
    .map(([key, sub]) => `${key}: ${describe(sub, depth + 1)}`)
    .join(', ');
  const rest = entries.length > MAX_KEYS ? `, …+${entries.length - MAX_KEYS}` : '';
  return `{ ${shown}${rest} }`;
}

/**
 * Classe une erreur.
 *
 * Athom écrit `Missing Scopes` — parfois avec la liste, parfois sans. On cherche donc le mot
 * plutôt que la phrase exacte, en acceptant qu'un faux positif soit moins coûteux ici qu'un
 * refus de scope pris pour une panne.
 */
function classify(err: unknown): { verdict: Verdict; detail: string } {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (lower.includes('scope')) return { verdict: 'scope', detail: message };
  if (lower.includes('not_found') || lower.includes('not found') || lower.includes('404')) {
    return { verdict: 'absent', detail: message };
  }
  return { verdict: 'erreur', detail: message };
}

/** `YYYY-MM-DD` en heure locale : les rapports de Homey sont datés dans le fuseau du logement. */
function isoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * `YYYY-Www` au sens ISO 8601.
 *
 * L'année ISO n'est pas l'année civile : le 1er janvier peut appartenir à la semaine 52 de
 * l'année précédente. C'est le jeudi de la semaine qui porte l'année, d'où le décalage.
 */
function isoWeek(date: Date): string {
  const thursday = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
  const year = thursday.getUTCFullYear();
  const firstDay = Date.UTC(year, 0, 1);
  const week = Math.ceil(((thursday.getTime() - firstDay) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

interface Step {
  manager: string;
  method: string;
  scope: string;
  args?: Record<string, string>;
}

/**
 * Les appels sondés, dans l'ordre du moins au plus engageant.
 *
 * `getState` ouvre la marche parce qu'il n'exige que `homey.system.readonly` : s'il échoue aussi,
 * ce n'est pas une question de scope énergie mais de client mal construit, et tout le reste du
 * rapport serait à jeter.
 */
function steps(now: Date): Step[] {
  return [
    { manager: 'energy', method: 'getState', scope: 'homey.system.readonly' },
    { manager: 'energy', method: 'getCurrency', scope: 'homey.energy.readonly' },
    { manager: 'energy', method: 'getLiveReport', scope: 'homey.energy.readonly' },
    { manager: 'energy', method: 'getReportsAvailable', scope: 'homey.energy.readonly' },
    { manager: 'energy', method: 'getReportDay', scope: 'homey.energy.readonly', args: { date: isoDate(now) } },
    { manager: 'energy', method: 'getReportWeek', scope: 'homey.energy.readonly', args: { isoWeek: isoWeek(now) } },
    {
      manager: 'energy',
      method: 'getReportMonth',
      scope: 'homey.energy.readonly',
      args: { yearMonth: isoDate(now).slice(0, 7) },
    },
    {
      manager: 'energy',
      method: 'getReportYear',
      scope: 'homey.energy.readonly',
      args: { year: String(now.getFullYear()) },
    },
    { manager: 'energy', method: 'getElectricityPriceType', scope: 'homey.energy.readonly' },
    { manager: 'energy', method: 'getOptionElectricityPriceFixed', scope: 'homey.energy.readonly' },
    { manager: 'energy', method: 'getOptionGasPriceFixed', scope: 'homey.energy.readonly' },
    { manager: 'energy', method: 'getOptionWaterPriceFixed', scope: 'homey.energy.readonly' },
    {
      manager: 'energy',
      method: 'fetchDynamicElectricityPrices',
      scope: 'homey.energy.readonly',
      args: { date: isoDate(now) },
    },
    { manager: 'insights', method: 'getLogs', scope: 'homey.insights.readonly' },
  ];
}

function managerOf(api: Record<string, unknown>, name: string): ProbeManager | null {
  const value = api[name];
  return value !== null && typeof value === 'object' ? (value as ProbeManager) : null;
}

/**
 * Appelle une opération et rapporte ce qui s'est passé, sans jamais laisser passer d'exception :
 * un refus sur le troisième appel ne doit pas priver du verdict des onze suivants.
 */
async function runStep(api: Record<string, unknown>, step: Step): Promise<ProbeResult> {
  const call = `${step.manager}.${step.method}`;
  const manager = managerOf(api, step.manager);
  if (manager === null) {
    return { call, scope: step.scope, verdict: 'absent', detail: `manager \`${step.manager}\` absent du client` };
  }

  const method = manager[step.method];
  if (typeof method !== 'function') {
    return { call, scope: step.scope, verdict: 'absent', detail: 'méthode absente du client' };
  }

  try {
    const result = await method.call(manager, step.args);
    return { call, scope: step.scope, verdict: 'ok', detail: describe(result) };
  } catch (err) {
    return { call, scope: step.scope, ...classify(err) };
  }
}

/**
 * Sonde l'accès aux rapports d'énergie et aux Insights, et rend le rapport complet.
 *
 * `getLogEntries` n'est tenté qu'après `getLogs`, puisqu'il lui faut un `uri` et un `id` réels :
 * inventer une clé ferait répondre « introuvable » là où la question est « ai-je le droit ».
 */
export async function probeEnergy(homey: Homey.App['homey'], log: Logger): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  let api: (Record<string, unknown> & { destroy?: () => void }) | null = null;

  try {
    api = await HomeyAPI.createAppAPI({ homey }) as unknown as Record<string, unknown> & { destroy?: () => void };
  } catch (err) {
    log('sonde énergie : client indisponible', err);
    return [{ call: 'createAppAPI', scope: 'homey:manager:api', ...classify(err) }];
  }

  try {
    const now = new Date();
    for (const step of steps(now)) {
      results.push(await runStep(api, step));
    }

    // Les Insights ne se lisent qu'avec une clé existante. On la prend dans le premier log rendu.
    const insights = managerOf(api, 'insights');
    const logs = results.find((result) => result.call === 'insights.getLogs');
    if (insights !== null && logs?.verdict === 'ok') {
      const first = await firstLogKey(insights);
      results.push(first === null
        ? {
          call: 'insights.getLogEntries',
          scope: 'homey.insights.readonly',
          verdict: 'absent',
          detail: 'aucun log à interroger',
        }
        : await runStep(api, {
          manager: 'insights',
          method: 'getLogEntries',
          scope: 'homey.insights.readonly',
          args: { ...first, resolution: 'last24Hours' },
        }));
    }
  } finally {
    try { api.destroy?.(); } catch { /* un client déjà mort n'a rien à nous apprendre */ }
  }

  for (const line of format(results)) log(line);
  return results;
}

/** Le couple `uri`/`id` du premier log rendu, ou `null` si le logement n'en a aucun. */
async function firstLogKey(insights: ProbeManager): Promise<{ uri: string; id: string } | null> {
  try {
    const method = insights['getLogs'];
    if (typeof method !== 'function') return null;
    const logs = await method.call(insights);
    const list = Array.isArray(logs) ? logs : Object.values(logs as Record<string, unknown>);
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object') continue;
      const { uri, id } = entry as { uri?: unknown; id?: unknown };
      if (typeof uri === 'string' && typeof id === 'string') return { uri, id };
    }
  } catch { /* le verdict de getLogs est déjà consigné ; inutile de le doubler */ }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/**
 * Le second temps de la sonde : la structure FINE d'un seul rapport.
 *
 * `describe()` s'arrête à `{14 clés}` — c'est ce qu'on veut pour arbitrer un droit d'accès, c'est
 * insuffisant pour dessiner. Un Sankey a besoin de savoir ce que porte exactement une entrée de
 * `devices.consumed` : des kWh nus, ou un objet avec un coût et un nom.
 *
 * On ne déverse pas le rapport entier pour autant. Vingt-quatre `subReports` de trois sections
 * noieraient la réponse pour n'en dire pas plus qu'un seul, échantillonné.
 */
export async function dumpReportDay(homey: Homey.App['homey'], log: Logger): Promise<void> {
  const api = await HomeyAPI.createAppAPI({ homey }) as unknown as Record<string, unknown> & { destroy?: () => void };
  try {
    const energy = managerOf(api, 'energy');
    const method = energy?.['getReportDay'];
    if (typeof method !== 'function') { log('[jour] getReportDay indisponible'); return; }

    const report = asRecord(await method.call(energy, { date: isoDate(new Date()) }));
    const electricity = asRecord(report['electricity']);
    const buckets = asRecord(electricity['devices']);

    // Les totaux d'abord, `devices` retiré : c'est lui, et lui seul, qui est volumineux.
    const { devices: _drop, ...totals } = electricity;
    log(`[jour] électricité, totaux : ${JSON.stringify(totals)}`);
    log(`[jour] gaz : ${JSON.stringify(report['gas'])}`);
    log(`[jour] eau : ${JSON.stringify(report['water'])}`);

    for (const [bucket, value] of Object.entries(buckets)) {
      const entries = Object.entries(asRecord(value));
      if (entries.length === 0) continue;
      log(`[jour] devices.${bucket} — ${entries.length} entrées, dont :`);
      for (const [id, payload] of entries.slice(0, 3)) log(`[jour]   ${id} = ${JSON.stringify(payload)}`);
    }

    // Un seul sous-rapport, pour savoir si le pas horaire porte la même forme que le jour.
    const subs = Object.entries(asRecord(report['subReports']));
    const first = subs[0];
    if (first !== undefined) {
      const subElectricity = asRecord(asRecord(first[1])['electricity']);
      const subBuckets = asRecord(subElectricity['devices']);
      const { devices: _dropSub, ...subTotals } = subElectricity;
      log(`[jour] subReport ${first[0]}, totaux : ${JSON.stringify(subTotals)}`);
      log(`[jour] subReport devices.consumed : ${JSON.stringify(Object.entries(asRecord(subBuckets['consumed'])).slice(0, 2))}`);
    }
  } finally {
    try { api.destroy?.(); } catch { /* rien à apprendre d'un client déjà mort */ }
  }
}

const MARKS: Record<Verdict, string> = { ok: '✅', scope: '⛔', absent: '➖', erreur: '❌' };

/** Met le rapport en lignes lisibles dans le flux de `homey app run`. */
export function format(results: ProbeResult[]): string[] {
  const width = Math.max(...results.map((result) => result.call.length));
  const granted = results.filter((result) => result.verdict === 'ok').length;
  const refused = results.filter((result) => result.verdict === 'scope').length;

  return [
    '───── sonde énergie ─────',
    ...results.map((result) =>
      `${MARKS[result.verdict]} ${result.call.padEnd(width)}  ${result.scope}  ${result.detail}`),
    `───── ${granted} accordés, ${refused} refusés pour scope, sur ${results.length} ─────`,
  ];
}
