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
  /**
   * Vrai pour un compteur général (Linky, P1, pince). C'est une SOURCE, pas une charge.
   *
   * Sa valeur est NETTE : un P1 devient négatif dès que le logement réinjecte son surplus
   * solaire. Il n'est donc jamais filtré sur le signe — l'écarter à ce moment-là faisait
   * disparaître le compteur en pleine journée, puis réapparaître le soir.
   */
  cumulative: boolean;
  /**
   * Vrai pour une production locale (onduleur, panneaux). `watts` est alors la puissance
   * PRODUITE, positive. Une production n'est pas une charge : la ranger parmi les usages
   * l'ajoutait à la consommation du logement au lieu de l'en retrancher.
   */
  solar?: boolean;
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
  /**
   * Identifiant de l'appareil qui ALIMENTE celui-ci, quand il en mesure la consommation.
   *
   * Un onduleur, une multiprise mesurée ou un module de tableau ne consomment pas ce qu'ils
   * affichent : ils portent la charge de ce qui est branché derrière. Sans cette relation, un
   * onduleur à 100 W et le NAS à 55 W qu'il alimente sont comptés côte à côte, et le logement
   * paraît consommer 55 W de plus qu'en réalité.
   */
  poweredBy?: string | null;
}

/**
 * -1 = les entrées (réseau, solaire) quand il y en a plusieurs, 0 = le logement — ou le compteur
 * seul quand il est l'unique entrée —, puis un niveau par regroupement, et les appareils en
 * dernier.
 */
export type Depth = -1 | 0 | 1 | 2 | 3;

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

/** Le bilan des entrées et sorties du logement, dans l'unité du modèle. */
export interface EnergyBalance {
  /** Tiré du réseau. `null` sans compteur général : on ne le connaît pas. */
  imported: number | null;
  /** Réinjecté au réseau. `null` quand rien ne permet de le connaître. */
  exported: number | null;
  /** Produit par les appareils déclarés comme production. */
  produced: number;
}

export interface SankeyModel {
  /** Ce que le logement CONSOMME : réseau + production − export. */
  total: number;
  measured: number;
  unmeasured: number;
  /** Vrai quand aucun compteur général n'existe : le total n'est qu'une somme partielle. */
  partial: boolean;
  balance: EnergyBalance;
  /**
   * Vrai quand le non-mesuré peut contenir de l'export, faute de le connaître : sur une période,
   * le rapport de Homey ne donne que l'importé.
   */
  unmeasuredMayIncludeExport: boolean;
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
  /**
   * Faux quand le compteur ne rend que l'importé (rapports de période) : l'export est alors
   * inconnu, et non nul. Vrai par défaut — en instantané, le compteur est net.
   */
  exportKnown?: boolean;
}

const DEFAULTS = { maxPerZone: 5, minWatts: 0.05, minZoneShare: 0.01, minDeviceShare: 0.04 };

export const SOURCE_ID = 'source';

/**
 * Part de la production connue sous laquelle un export excédentaire est mis sur le compte du
 * décalage entre deux relevés plutôt que d'un onduleur caché.
 */
const HIDDEN_PRODUCTION_TOLERANCE = 0.05;
/**
 * Branche de ce que le compteur voit et qu'aucun appareil n'explique. Feuille.
 *
 * Le préfixe n'est PAS `cat:` : ce n'est pas un usage, et lui en donner l'apparence a déjà induit
 * en erreur un test qui vérifiait l'absence de catégories.
 */
export const UNMEASURED_ID = 'branch:__unmeasured__';
/** Regroupement des pièces négligeables. Feuille. */
export const TINY_ZONE_ID = 'zone:__tiny__';

/** Entrée réseau, quand le logement en a plusieurs. */
export const GRID_ID = 'input:grid';
/** Entrée production locale. */
export const SOLAR_ID = 'input:solar';
/**
 * L'entrée qu'aucun appareil ne nomme. Avec un compteur : la production qu'il PROUVE en
 * réinjectant plus que la production connue. Sans compteur : ce que la production ne couvre pas
 * des appareils mesurés, réseau ou autre — rien ne permet de trancher.
 */
export const OTHER_SOURCE_ID = 'input:other';
/** Réinjection au réseau. Feuille, au même titre qu'une charge. */
export const EXPORT_ID = 'output:export';

/** Les nœuds qui n'ont volontairement aucun détail en dessous. */
export const LEAF_NODES: ReadonlySet<string> = new Set([UNMEASURED_ID, TINY_ZONE_ID, EXPORT_ID]);

export function buildSankey(devices: readonly FlowDevice[], options: SankeyOptions = {}): SankeyModel {
  const grouping = options.grouping ?? GROUPINGS['category+zone'] as readonly Grouping[];
  const maxPerZone = options.maxPerZone ?? DEFAULTS.maxPerZone;
  const minWatts = options.minWatts ?? DEFAULTS.minWatts;
  const minZoneShare = options.minZoneShare ?? DEFAULTS.minZoneShare;
  const minDeviceShare = options.minDeviceShare ?? DEFAULTS.minDeviceShare;

  const exportKnown = options.exportKnown ?? true;

  // Le compteur n'est PAS filtré sur le signe : négatif, il réinjecte. Les charges et la
  // production le sont, une valeur négative n'y ayant pas de sens dans ce modèle.
  const mains = devices.filter((d) => d.cumulative && Number.isFinite(d.watts));
  const producers = devices.filter((d) => !d.cumulative && d.solar === true && isPositive(d.watts));
  const loads = devices.filter((d) => !d.cumulative && d.solar !== true && isPositive(d.watts));

  // La somme des charges se calcule après avoir résolu les sous-compteurs : un enfant est déjà
  // compté dans le total de son parent, l'ajouter gonflerait le logement.
  const measured = round(measuredTotal(loads));
  const produced = round(producers.reduce((sum, d) => sum + d.watts, 0));
  const partial = mains.length === 0;
  const net = round(mains.reduce((sum, d) => sum + d.watts, 0));

  // --- Le bilan des entrées --------------------------------------------------
  // Consommation = réseau + production − export. Sans compteur, ni le réseau ni l'export ne sont
  // connus : la production couvre ce qu'elle peut des appareils mesurés, le reste vient d'une
  // origine qu'on ne nomme pas, et son surplus part vers une destination qu'on ne nomme pas non
  // plus — export ou consommation non mesurée, rien ne permet de trancher.
  let imported: number | null;
  let exported: number | null;
  let otherSource = 0;
  let total: number;
  if (partial) {
    imported = null;
    exported = null;
    otherSource = round(Math.max(0, measured - produced));
    // Le surplus éventuel ne traverse pas le logement : il part directement de la production.
    total = measured;
  } else {
    imported = round(Math.max(0, net));
    exported = round(Math.max(0, -net));
    // Un export supérieur à la production connue PROUVE une production que personne ne déclare :
    // un onduleur absent de Homey. On la dessine, et on lui attribue aussi ce que les appareils
    // mesurés consomment au-delà du bilan — elle est la seule à pouvoir les alimenter.
    //
    // Sans cette preuve, un excédent des appareils sur le compteur n'est PAS une production : c'est
    // une estimation trop haute ou un double comptage, et le déséquilibre reste visible.
    //
    // Le compteur et l'onduleur ne se mettent pas à jour au même instant : quelques watts d'écart
    // ne prouvent rien, d'où la tolérance avant de conclure.
    const gap = Math.max(0, exported - produced);
    const hidden = gap > Math.max(minWatts, produced * HIDDEN_PRODUCTION_TOLERANCE) ? gap : 0;
    otherSource = hidden > 0
      ? round(hidden + Math.max(0, measured - (imported + produced + hidden - exported)))
      : 0;
    total = round(imported + produced + otherSource - exported);
  }
  const unmeasured = round(Math.max(0, total - measured));
  // Sans compteur, le surplus de production sort par la branche d'export, sous un libellé qui
  // avoue l'ignorance — voir plus haut.
  const surplus = partial ? round(Math.max(0, produced - measured)) : 0;

  /** Plusieurs entrées, ou une sortie vers le réseau : le logement devient un nœud à part. */
  const multiInput = produced > 0 || (exported ?? 0) > 0;
  const mainsLabel = mains.length === 1 ? (mains[0] as FlowDevice).name : mains.length > 1 ? 'Compteurs' : 'Appareils mesurés';

  const nodes: SankeyNode[] = [{
    id: SOURCE_ID,
    label: multiInput ? 'Logement' : mainsLabel,
    watts: total,
    depth: 0,
  }];
  const links: SankeyLink[] = [];

  if (multiInput) {
    const producedLabel = producers.length === 1 ? (producers[0] as FlowDevice).name : 'Production solaire';
    // L'export puise d'abord dans la production connue : c'est elle qui produit le surplus.
    const out = partial ? surplus : (exported ?? 0);
    const fromSolar = round(Math.min(out, produced));
    const fromOther = round(out - fromSolar);

    if (!partial && (imported ?? 0) > 0) {
      nodes.push({ id: GRID_ID, label: mainsLabel, watts: imported as number, depth: -1 });
      links.push({ from: GRID_ID, to: SOURCE_ID, watts: imported as number });
    }
    if (produced > 0) {
      nodes.push({ id: SOLAR_ID, label: producedLabel, watts: produced, depth: -1 });
      if (produced - fromSolar > 0) links.push({ from: SOLAR_ID, to: SOURCE_ID, watts: round(produced - fromSolar) });
      if (fromSolar > 0) links.push({ from: SOLAR_ID, to: EXPORT_ID, watts: fromSolar });
    }
    if (otherSource > 0) {
      nodes.push({
        id: OTHER_SOURCE_ID, depth: -1, watts: otherSource,
        label: partial ? 'Réseau ou autre' : 'Production non mesurée',
      });
      if (otherSource - fromOther > 0) links.push({ from: OTHER_SOURCE_ID, to: SOURCE_ID, watts: round(otherSource - fromOther) });
      if (fromOther > 0) links.push({ from: OTHER_SOURCE_ID, to: EXPORT_ID, watts: fromOther });
    }
    if (out > 0) {
      nodes.push({
        id: EXPORT_ID, depth: 0, watts: round(out),
        label: partial ? 'Surplus non consommé' : 'Export réseau',
      });
    }
  }

  // --- Sous-compteurs : ce qu'ils affichent CONTIENT leurs enfants -------
  const childrenOf = new Map<string, FlowDevice[]>();
  const byId = new Map(loads.map((d) => [d.id, d]));
  for (const device of loads) {
    const parent = device.poweredBy;
    // Une relation vers un appareil absent, ou vers soi-même, est ignorée : elle produirait un
    // cycle ou un nœud orphelin, et le diagramme ne s'en remettrait pas.
    if (typeof parent !== 'string' || parent === '' || parent === device.id) continue;
    if (!byId.has(parent)) continue;
    const bucket = childrenOf.get(parent);
    if (bucket) bucket.push(device);
    else childrenOf.set(parent, [device]);
  }
  const meterIds = new Set(childrenOf.keys());
  const childIds = new Set([...childrenOf.values()].flat().map((d) => d.id));

  // Un sous-compteur ne traverse PAS le regroupement par usage : il est une branche à lui seul.
  const standalone = loads.filter((d) => !meterIds.has(d.id) && !childIds.has(d.id));

  const placed = standalone.map((device) => ({
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

  // --- Les branches de sous-comptage ---------------------------------------
  for (const [meterId, kids] of childrenOf) {
    const meter = byId.get(meterId) as FlowDevice;
    const kidsSum = kids.reduce((s, k) => s + k.watts, 0);
    const meterWatts = round(Math.max(meter.watts, kidsSum));
    const nodeId = `meter:${meterId}`;

    nodes.push({ id: nodeId, label: meter.name, watts: meterWatts, depth: 1 });
    links.push({ from: SOURCE_ID, to: nodeId, watts: meterWatts });

    for (const kid of kids) {
      const id = `device:${kid.id}`;
      nodes.push({
        id, label: kid.name, watts: round(kid.watts), depth: 2,
        categoryId: categorise(kid.deviceClass, kid.deviceType, kid.categoryOverride).id,
      });
      links.push({ from: nodeId, to: id, watts: round(kid.watts) });
    }

    // Ce que le sous-compteur porte sans qu'on sache quoi : ses propres pertes, et tout ce qui
    // est branché derrière sans être déclaré. C'est la même idée que le « non mesuré » global,
    // à l'échelle d'une branche.
    const rest = round(meterWatts - kidsSum);
    if (rest > minWatts) {
      const id = `${nodeId}:rest`;
      nodes.push({ id, label: 'Reste de la branche', watts: rest, depth: 2 });
      links.push({ from: nodeId, to: id, watts: rest });
    }
  }

  // --- La branche non mesurée, juste après le compteur ---------------------
  if (unmeasured > 0) {
    nodes.push({ id: UNMEASURED_ID, label: 'Non mesuré', watts: unmeasured, depth: 1 });
    links.push({ from: SOURCE_ID, to: UNMEASURED_ID, watts: unmeasured });
  }

  return {
    total, measured, unmeasured, partial, nodes, links,
    balance: { imported, exported: exportKnown ? exported : null, produced },
    unmeasuredMayIncludeExport: !exportKnown && produced > 0 && unmeasured > 0,
  };
}

/**
 * Somme des charges, sous-compteurs résolus.
 *
 * Un sous-compteur compte pour le plus grand de sa propre mesure et de la somme de ses enfants :
 * si les enfants dépassent, c'est sa mesure qui est en retard, et rabattre le total sur elle
 * ferait disparaître de l'énergie réellement observée.
 */
function measuredTotal(loads: readonly FlowDevice[]): number {
  const byId = new Map(loads.map((d) => [d.id, d]));
  const children = new Map<string, FlowDevice[]>();
  for (const d of loads) {
    const p = d.poweredBy;
    if (typeof p !== 'string' || p === '' || p === d.id || !byId.has(p)) continue;
    const b = children.get(p);
    if (b) b.push(d); else children.set(p, [d]);
  }
  const nested = new Set([...children.values()].flat().map((d) => d.id));
  let sum = 0;
  for (const d of loads) {
    if (nested.has(d.id)) continue;
    const kids = children.get(d.id);
    sum += kids ? Math.max(d.watts, kids.reduce((s, k) => s + k.watts, 0)) : d.watts;
  }
  return sum;
}

function isPositive(watts: number): boolean {
  return Number.isFinite(watts) && watts > 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
