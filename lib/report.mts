/**
 * `lib/report.mts` — le rapport d'énergie de Homey, traduit en entrées de diagramme.
 *
 * Homey tient déjà, dans `ManagerEnergy`, ce que le Sankey ne savait montrer qu'en instantané :
 * la consommation par appareil sur une journée, une semaine, un mois, une année, en kWh et en
 * euros. Ce module fait la seule chose qui manquait — rendre ces chiffres consommables par
 * `buildSankey`, qui ne connaît que des nombres et se moque de leur unité.
 *
 * Deux vérifications faites sur une Homey Pro réelle plutôt que supposées, et qui fixent tout le
 * reste :
 *
 *  1. `importedPeriod` est la somme des COMPTEURS généraux, `consumedPeriod` la somme des
 *     appareils attribués. Relevé le 3 septembre 2026 : Linky 5,36 + ZLinky_TIC 3,62 = 8,98, et
 *     `importedPeriod` valait 8,98 pour 7,591 de `consumedPeriod`. L'écart de 1,389 kWh est le
 *     non-mesuré de la journée — la grandeur que le diagramme existe pour montrer.
 *  2. `subReports` ne porte QUE des totaux : `devices.consumed` y est vide. Le détail par
 *     appareil n'existe donc jamais à l'heure, seulement sur la période entière. C'est la raison
 *     pour laquelle le widget offre un choix de période et non un curseur temporel.
 *
 * Module pur : il ne connaît ni Homey ni le réseau. Le rapport entre et des `FlowDevice` sortent.
 *
 * ⚠️ **Électricité seulement.** Le gaz est en m³ et l'eau en litres ; les verser dans le même
 * diagramme additionnerait des unités incomparables et rendrait un total qui ne veut rien dire.
 */

import type { FlowDevice } from './sankey.mjs';

/** Les périodes offertes, et le paramètre que chacune exige de la Web API. */
export type Period = 'live' | 'day' | 'week' | 'month' | 'year';

export const PERIODS: readonly Period[] = ['live', 'day', 'week', 'month', 'year'];

export function isPeriod(value: unknown): value is Period {
  return typeof value === 'string' && (PERIODS as readonly string[]).includes(value);
}

/**
 * Une entrée de `devices.imported` ou `devices.consumed`.
 *
 * Tout y est nullable : un Gazpar apparaît dans `devices.imported` de l'électricité avec
 * `period: null`, et un appareil ajouté en cours de période n'a pas encore de coût.
 */
export interface ReportEntry {
  name?: string | null;
  total?: number | null;
  period?: number | null;
  price?: number | null;
  /** Posé par Homey quand le chiffre vient de SON approximation et non d'une mesure. */
  approximatedEnergy?: boolean | null;
}

export interface ReportSection {
  importedPeriod?: number | null;
  consumedPeriod?: number | null;
  importedPrice?: number | null;
  devices?: {
    imported?: Record<string, ReportEntry | undefined> | null;
    consumed?: Record<string, ReportEntry | undefined> | null;
  } | null;
}

export interface EnergyReport {
  electricity?: ReportSection | null;
}

/**
 * Ce que l'app sait d'un appareil et que le rapport ignore.
 *
 * Le rapport ne rend qu'un identifiant et un nom. La pièce, la classe et l'usage choisi à la main
 * vivent dans le hub et dans les réglages de l'app : c'est leur jonction qui donne au diagramme
 * ses deux niveaux intermédiaires.
 */
export interface DeviceContext {
  zoneName: string | null;
  deviceClass?: string | null;
  deviceType?: string | null;
  categoryOverride?: string | null;
  poweredBy?: string | null;
}

/** Les totaux que le diagramme ne porte pas, mais que l'en-tête du widget affiche. */
export interface ReportTotals {
  /** Somme des compteurs généraux sur la période, en kWh. */
  imported: number | null;
  /** Somme des appareils attribués sur la période, en kWh. */
  consumed: number | null;
  /** Coût de l'importé sur la période, dans la devise du logement. */
  cost: number | null;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function maybeNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function entries(bucket: Record<string, ReportEntry | undefined> | null | undefined):
[string, ReportEntry][] {
  if (bucket === null || bucket === undefined) return [];
  const out: [string, ReportEntry][] = [];
  for (const [id, entry] of Object.entries(bucket)) {
    if (entry !== undefined && entry !== null) out.push([id, entry]);
  }
  return out;
}

export function reportTotals(report: EnergyReport): ReportTotals {
  const electricity = report.electricity ?? {};
  return {
    imported: maybeNum(electricity.importedPeriod),
    consumed: maybeNum(electricity.consumedPeriod),
    cost: maybeNum(electricity.importedPrice),
  };
}

/**
 * Transforme un rapport en appareils de diagramme, en kWh.
 *
 * Les compteurs généraux deviennent des sources (`cumulative`), les appareils attribués des
 * charges. C'est exactement l'arithmétique du mode instantané, à l'unité près — et c'est pour
 * cela que `buildSankey` n'a pas une ligne à changer.
 *
 * Un appareil dont la période est nulle ou négative est écarté ici plutôt que laissé à
 * `buildSankey` : un Gazpar listé dans l'électricité avec `period: null` n'est pas un appareil
 * électrique à zéro watt, c'est un appareil qui n'appartient pas à ce diagramme.
 */
export function reportToFlowDevices(
  report: EnergyReport,
  context: (deviceId: string) => DeviceContext | null,
): FlowDevice[] {
  const electricity = report.electricity ?? {};
  const devices = electricity.devices ?? {};
  const out: FlowDevice[] = [];

  const push = (id: string, entry: ReportEntry, cumulative: boolean): void => {
    const kwh = num(entry.period);
    if (kwh <= 0) return;
    const known = context(id);
    out.push({
      id,
      name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : id,
      zoneName: known?.zoneName ?? null,
      watts: kwh,
      cumulative,
      deviceClass: known?.deviceClass ?? null,
      deviceType: known?.deviceType ?? null,
      categoryOverride: known?.categoryOverride ?? null,
      // Homey pose lui-même le drapeau. L'app le déduisait jusqu'ici de l'absence de
      // `measure_power` ; sur une période, c'est la source qui fait autorité.
      approximated: entry.approximatedEnergy === true,
      poweredBy: known?.poweredBy ?? null,
    });
  };

  for (const [id, entry] of entries(devices.imported)) push(id, entry, true);
  for (const [id, entry] of entries(devices.consumed)) push(id, entry, false);

  return out;
}

/**
 * Le plancher sous lequel un appareil disparaît du diagramme, pour la période demandée.
 *
 * `buildSankey` a un plancher pensé pour des watts (0,05 W). Appliqué à des kWh, il effacerait
 * tout ce qui consomme moins de 50 Wh dans la journée — c'est-à-dire la moitié d'un logement.
 * Le plancher doit suivre l'ordre de grandeur de la période, pas celui de l'unité instantanée.
 */
export function floorFor(period: Period): number {
  switch (period) {
    case 'day': return 0.001;
    case 'week': return 0.005;
    case 'month': return 0.02;
    case 'year': return 0.2;
    default: return 0.05;
  }
}

/** `YYYY-MM-DD` en heure locale : les rapports de Homey sont datés dans le fuseau du logement. */
export function isoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * `YYYY-Www` au sens ISO 8601.
 *
 * L'année ISO n'est pas l'année civile : le 1er janvier appartient parfois à la semaine 52 de
 * l'année précédente. C'est le jeudi de la semaine qui porte l'année, d'où le décalage — s'en
 * passer ferait demander une semaine inexistante deux ou trois jours par an.
 */
export function isoWeek(date: Date): string {
  const thursday = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
  const year = thursday.getUTCFullYear();
  const firstDay = Date.UTC(year, 0, 1);
  const week = Math.ceil(((thursday.getTime() - firstDay) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}
