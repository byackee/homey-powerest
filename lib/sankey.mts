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
  /** Usage choisi explicitement par l'utilisateur. L'emporte sur tout le reste. */
  categoryOverride?: string | null;
  /**
   * Vrai quand la puissance vient de l'approximation forfaitaire de Homey et non d'une
   * `measure_power`. Ces appareils comptent bel et bien dans l'onglet Énergie : les omettre les
   * ferait tomber dans « Non mesuré », ce qui serait faux — ils sont comptés, mal.
   */
  approximated?: boolean;
}

/** 0 = compteur, puis un niveau par regroupement, et les appareils en dernier. */
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

/** Les niveaux intermédiaires du diagramme, dans l'ordre, entre le compteur et les appareils. */
export type Grouping = 'category' | 'zone';

/**
 * Les combinaisons proposées.
 *
 * `['category','zone']` est la seule qui rende le graphe non arborescent, donc la seule où les
 * rubans se croisent. Les deux autres répondent à une question plus simple — « à quoi » ou
 * « où » — et se lisent d'un coup d'œil quand le logement compte beaucoup d'appareils.
 */
export const GROUPINGS: Readonly<Record<string, readonly Grouping[]>> = {
  'category+zone': ['category', 'zone'],
  category: ['category'],
  zone: ['zone'],
};

export interface SankeyOptions {
  /** Niveaux intermédiaires. Par défaut usage puis pièce. */
  grouping?: readonly Grouping[];
  maxPerZone?: number;
  minWatts?: number;
  /** Part du total sous laquelle une pièce est regroupée. */
  minZoneShare?: number;
  /** Part de SA PIÈCE sous laquelle un appareil est regroupé. */
  minDeviceShare?: number;
}

const DEFAULTS = { maxPerZone: 5, minWatts: 0.05, minZoneShare: 0.01, minDeviceShare: 0.04 };

export const SOURCE_ID = 'source';
/**
 * Branche de ce que le compteur voit et qu'aucun appareil n'explique. Feuille.
 *
 * Le préfixe n'est PAS `cat:` : ce n'est pas un usage, et lui en donner l'apparence a déjà induit
 * en erreur un test qui vérifiait l'absence de catégories.
 */
export const UNMEASURED_ID = 'branch:__unmeasured__';
/** Regroupement des pièces négligeables. Feuille. */
export const TINY_ZONE_ID = 'zone:__tiny__';

/** Les nœuds qui n'ont volontairement aucun détail en dessous. */
export const LEAF_NODES: ReadonlySet<string> = new Set([UNMEASURED_ID, TINY_ZONE_ID]);

export function buildSankey(devices: readonly FlowDevice[], options: SankeyOptions = {}): SankeyModel {
  const grouping = options.grouping ?? GROUPINGS['category+zone'] as readonly Grouping[];
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

  const placed = loads.map((device) => ({
    device,
    category: categorise(device.deviceClass, device.deviceType, device.categoryOverride),
    zoneName: device.zoneName ?? 'Sans pièce',
  }));
  type Placed = (typeof placed)[number];

  // Une pièce trop petite pour être dessinée est regroupée AVANT tout le reste : sa part continue
  // de compter dans son usage, seul son détail disparaît. Sans niveau « pièce », rien à faire.
  const usesZone = grouping.includes('zone');
  const zoneTotals = new Map<string, number>();
  for (const p of placed) zoneTotals.set(p.zoneName, (zoneTotals.get(p.zoneName) ?? 0) + p.device.watts);
  const zoneFloor = total * minZoneShare;
  const tinyZones = new Set(
    usesZone ? [...zoneTotals].filter(([, w]) => w < zoneFloor).map(([name]) => name) : [],
  );

  /** L'identifiant du nœud d'un appareil au niveau `level`. */
  const keyOf = (p: Placed, level: Grouping): string => {
    if (level === 'category') return `cat:${p.category.id}`;
    return tinyZones.has(p.zoneName) ? TINY_ZONE_ID : `zone:${p.zoneName}`;
  };
  const labelOf = (p: Placed, level: Grouping): string => {
    if (level === 'category') return p.category.label;
    if (tinyZones.has(p.zoneName)) return `${tinyZones.size} pièce${tinyZones.size > 1 ? 's' : ''} sous le seuil`;
    return p.zoneName;
  };

  // --- Niveaux intermédiaires ---------------------------------------------
  const seen = new Set<string>();
  grouping.forEach((level, i) => {
    const depth = (i + 1) as Depth;
    const totals = new Map<string, { label: string; watts: number; category: string }>();
    for (const p of placed) {
      const id = keyOf(p, level);
      const entry = totals.get(id);
      if (entry) entry.watts += p.device.watts;
      else totals.set(id, { label: labelOf(p, level), watts: p.device.watts, category: p.category.id });
    }
    for (const [id, t] of [...totals].sort((a, b) => b[1].watts - a[1].watts)) {
      if (seen.has(id)) continue;
      seen.add(id);
      nodes.push({
        id, label: t.label, watts: round(t.watts), depth,
        // Une pièce reçoit plusieurs usages : lui en attribuer un serait mentir. Seuls les nœuds
        // d'usage portent une couleur d'usage.
        categoryId: level === 'category' ? t.category : undefined,
      });
    }

    // Liens depuis le niveau précédent : la source, ou le niveau d'avant.
    const previous = i === 0 ? null : (grouping[i - 1] as Grouping);
    const pairs = new Map<string, { from: string; to: string; watts: number; category: string }>();
    for (const p of placed) {
      const from = previous === null ? SOURCE_ID : keyOf(p, previous);
      const to = keyOf(p, level);
      const key = `${from}|${to}`;
      const pair = pairs.get(key);
      if (pair) pair.watts += p.device.watts;
      else pairs.set(key, { from, to, watts: p.device.watts, category: p.category.id });
    }
    for (const pair of pairs.values()) {
      links.push({ from: pair.from, to: pair.to, watts: round(pair.watts), categoryId: pair.category });
    }
  });

  // --- Les appareils, sous le dernier niveau intermédiaire -----------------
  const lastLevel = grouping[grouping.length - 1] as Grouping;
  const deviceDepth = (grouping.length + 1) as Depth;
  const byParent = new Map<string, Placed[]>();
  for (const p of placed) {
    const id = keyOf(p, lastLevel);
    if (id === TINY_ZONE_ID) continue;   // regroupement : pas de détail, par construction
    const bucket = byParent.get(id);
    if (bucket) bucket.push(p);
    else byParent.set(id, [p]);
  }

  for (const [parent, list] of byParent) {
    const parentWatts = list.reduce((s, p) => s + p.device.watts, 0);
    const sorted = [...list].sort((a, b) => b.device.watts - a.device.watts);
    const floor = Math.max(minWatts, parentWatts * minDeviceShare);
    const shown = sorted.filter((p) => p.device.watts >= floor).slice(0, maxPerZone);
    const hidden = sorted.filter((p) => !shown.includes(p));

    for (const p of shown) {
      const id = `device:${p.device.id}`;
      nodes.push({ id, label: p.device.name, watts: round(p.device.watts), depth: deviceDepth, categoryId: p.category.id });
      links.push({ from: parent, to: id, watts: round(p.device.watts), categoryId: p.category.id });
    }
    if (hidden.length > 0) {
      const rest = round(hidden.reduce((s, p) => s + p.device.watts, 0));
      if (rest > 0) {
        const id = `${parent}:rest`;
        nodes.push({
          id, depth: deviceDepth, watts: rest,
          label: `${hidden.length} autre${hidden.length > 1 ? 's' : ''}`,
          categoryId: (hidden[0] as Placed).category.id,
        });
        links.push({ from: parent, to: id, watts: rest });
      }
    }
  }

  // --- La branche non mesurée, juste après le compteur ---------------------
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
