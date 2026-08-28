/**
 * `lib/sankey.mts` — le modèle du diagramme de flux d'énergie.
 *
 * Quatre niveaux : compteur général → usage → pièce → appareil.
 *
 * Le niveau « usage » n'est pas décoratif. Il rend le graphe NON arborescent : une pièce reçoit
 * de plusieurs usages, un usage arrose plusieurs pièces. C'est de là que naissent les croisements
 * — et c'est aussi ce qui justifie un moteur de placement (`d3-sankey`) côté vue, là où un arbre
 * strict n'en avait aucun besoin.
 *
 * La grandeur qui compte reste ce qui n'est PAS mesuré : sur un logement réel, le Linky annonce
 * 428 W quand la somme des appareils en fait 173. Les 255 W restants sont la première chose que
 * l'utilisateur doit voir, et aucune liste d'appareils ne la montre.
 *
 * Module pur : il ne connaît ni Homey ni le SVG, seulement des watts. C'est ce qui permet de
 * vérifier la conservation des flux par des tests plutôt qu'à l'œil sur un dessin.
 */

import { categorise } from './categories.mjs';

/** Un appareil tel que le diagramme a besoin de le connaître. */
export interface FlowDevice {
  id: string;
  name: string;
  zoneName: string | null;
  watts: number;
  /** Vrai pour un compteur général (Linky, pince). C'est une SOURCE, pas une charge. */
  cumulative: boolean;
  /** Classe Homey, qui sert au rangement par usage. */
  deviceClass?: string | null;
  /** `device_type` du profil mesuré, quand il existe : il l'emporte sur la classe. */
  deviceType?: string | null;
}

/** 0 = compteur, 1 = usage, 2 = pièce, 3 = appareil. */
export type Depth = 0 | 1 | 2 | 3;

export interface SankeyNode {
  id: string;
  label: string;
  watts: number;
  depth: Depth;
  /** Usage auquel le nœud se rattache, pour la couleur. Absent sur le compteur. */
  categoryId?: string;
}

export interface SankeyLink {
  from: string;
  to: string;
  watts: number;
  /** Usage porteur du flux, pour colorer le ruban. */
  categoryId?: string;
}

export interface SankeyModel {
  total: number;
  measured: number;
  unmeasured: number;
  /** Vrai quand aucun compteur général n'existe : le total n'est qu'une somme partielle. */
  partial: boolean;
  nodes: SankeyNode[];
  links: SankeyLink[];
}

export interface SankeyOptions {
  maxPerZone?: number;
  minWatts?: number;
  /** Part du total sous laquelle une pièce est regroupée. */
  minZoneShare?: number;
  /** Part de SA PIÈCE sous laquelle un appareil est regroupé. */
  minDeviceShare?: number;
}

const DEFAULTS = { maxPerZone: 5, minWatts: 0.05, minZoneShare: 0.01, minDeviceShare: 0.04 };

export const SOURCE_ID = 'source';
/** Branche de ce que le compteur voit et qu'aucun appareil n'explique. Feuille. */
export const UNMEASURED_ID = 'cat:__unmeasured__';
/** Regroupement des pièces négligeables. Feuille. */
export const TINY_ZONE_ID = 'zone:__tiny__';

/** Les nœuds qui n'ont volontairement aucun détail en dessous. */
export const LEAF_NODES: ReadonlySet<string> = new Set([UNMEASURED_ID, TINY_ZONE_ID]);

export function buildSankey(devices: readonly FlowDevice[], options: SankeyOptions = {}): SankeyModel {
  const maxPerZone = options.maxPerZone ?? DEFAULTS.maxPerZone;
  const minWatts = options.minWatts ?? DEFAULTS.minWatts;
  const minZoneShare = options.minZoneShare ?? DEFAULTS.minZoneShare;
  const minDeviceShare = options.minDeviceShare ?? DEFAULTS.minDeviceShare;

  const mains = devices.filter((d) => d.cumulative && isPositive(d.watts));
  const loads = devices.filter((d) => !d.cumulative && isPositive(d.watts));

  const measured = round(loads.reduce((sum, d) => sum + d.watts, 0));
  const mainsTotal = round(mains.reduce((sum, d) => sum + d.watts, 0));
  const partial = mains.length === 0;
  const total = partial ? measured : mainsTotal;

  // Un compteur qui verrait MOINS que la somme des appareils signalerait une estimation trop
  // haute ou un double comptage : on ne dessine pas de branche négative, et on ne corrige pas le
  // total en douce — le déséquilibre reste visible.
  const unmeasured = round(Math.max(0, total - measured));

  const nodes: SankeyNode[] = [{
    id: SOURCE_ID,
    label: mains.length === 1 ? (mains[0] as FlowDevice).name : mains.length > 1 ? 'Compteurs' : 'Appareils mesurés',
    watts: total,
    depth: 0,
  }];
  const links: SankeyLink[] = [];

  /** Chaque appareil enrichi de son usage et de sa pièce, une seule fois. */
  const placed = loads.map((device) => ({
    device,
    category: categorise(device.deviceClass, device.deviceType),
    zoneName: device.zoneName ?? 'Sans pièce',
  }));

  // Une pièce trop petite pour être dessinée est regroupée AVANT tout le reste : sa part continue
  // de compter dans son usage, seul son détail disparaît.
  const zoneTotals = new Map<string, number>();
  for (const p of placed) zoneTotals.set(p.zoneName, (zoneTotals.get(p.zoneName) ?? 0) + p.device.watts);
  const zoneFloor = total * minZoneShare;
  const tinyZones = new Set([...zoneTotals].filter(([, w]) => w < zoneFloor).map(([name]) => name));

  const zoneKey = (name: string): string => (tinyZones.has(name) ? TINY_ZONE_ID : `zone:${name}`);

  // --- Niveau 1 : les usages, du plus lourd au plus léger ------------------
  const catTotals = new Map<string, { label: string; watts: number }>();
  for (const p of placed) {
    const entry = catTotals.get(p.category.id);
    if (entry) entry.watts += p.device.watts;
    else catTotals.set(p.category.id, { label: p.category.label, watts: p.device.watts });
  }
  const categories = [...catTotals].sort((a, b) => b[1].watts - a[1].watts);

  for (const [id, cat] of categories) {
    nodes.push({ id: `cat:${id}`, label: cat.label, watts: round(cat.watts), depth: 1, categoryId: id });
    links.push({ from: SOURCE_ID, to: `cat:${id}`, watts: round(cat.watts), categoryId: id });
  }

  // --- Niveau 2 : les pièces. Une pièce reçoit de PLUSIEURS usages ---------
  const catZone = new Map<string, { cat: string; zone: string; watts: number }>();
  const zoneSum = new Map<string, { label: string; watts: number }>();
  for (const p of placed) {
    const zid = zoneKey(p.zoneName);
    const key = `${p.category.id}|${zid}`;
    const cz = catZone.get(key);
    if (cz) cz.watts += p.device.watts;
    else catZone.set(key, { cat: p.category.id, zone: zid, watts: p.device.watts });

    const zs = zoneSum.get(zid);
    const label = zid === TINY_ZONE_ID ? `${tinyZones.size} pièce${tinyZones.size > 1 ? 's' : ''} sous le seuil` : p.zoneName;
    if (zs) zs.watts += p.device.watts;
    else zoneSum.set(zid, { label, watts: p.device.watts });
  }

  for (const [zid, z] of [...zoneSum].sort((a, b) => b[1].watts - a[1].watts)) {
    nodes.push({ id: zid, label: z.label, watts: round(z.watts), depth: 2 });
  }
  for (const cz of catZone.values()) {
    links.push({ from: `cat:${cz.cat}`, to: cz.zone, watts: round(cz.watts), categoryId: cz.cat });
  }

  // --- Niveau 3 : les appareils, par pièce --------------------------------
  const byZone = new Map<string, typeof placed>();
  for (const p of placed) {
    const zid = zoneKey(p.zoneName);
    if (zid === TINY_ZONE_ID) continue;   // regroupement : pas de détail, par construction
    const bucket = byZone.get(zid);
    if (bucket) bucket.push(p);
    else byZone.set(zid, [p]);
  }

  for (const [zid, list] of byZone) {
    const zoneWatts = list.reduce((s, p) => s + p.device.watts, 0);
    const sorted = [...list].sort((a, b) => b.device.watts - a.device.watts);
    const floor = Math.max(minWatts, zoneWatts * minDeviceShare);
    const shown = sorted.filter((p) => p.device.watts >= floor).slice(0, maxPerZone);
    const hidden = sorted.filter((p) => !shown.includes(p));

    for (const p of shown) {
      const id = `device:${p.device.id}`;
      nodes.push({ id, label: p.device.name, watts: round(p.device.watts), depth: 3, categoryId: p.category.id });
      links.push({ from: zid, to: id, watts: round(p.device.watts), categoryId: p.category.id });
    }
    if (hidden.length > 0) {
      const rest = round(hidden.reduce((s, p) => s + p.device.watts, 0));
      if (rest > 0) {
        const id = `${zid}:rest`;
        nodes.push({
          id, depth: 3, watts: rest,
          label: `${hidden.length} autre${hidden.length > 1 ? 's' : ''}`,
          categoryId: (hidden[0] as (typeof placed)[number]).category.id,
        });
        links.push({ from: zid, to: id, watts: rest });
      }
    }
  }

  // --- La branche non mesurée, au niveau des usages ------------------------
  if (unmeasured > 0) {
    nodes.push({ id: UNMEASURED_ID, label: 'Non mesuré', watts: unmeasured, depth: 1 });
    links.push({ from: SOURCE_ID, to: UNMEASURED_ID, watts: unmeasured });
  }

  return { total, measured, unmeasured, partial, nodes, links };
}

function isPositive(watts: number): boolean {
  return Number.isFinite(watts) && watts > 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
