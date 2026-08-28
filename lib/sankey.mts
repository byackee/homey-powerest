/**
 * `lib/sankey.mts` — le modèle du diagramme de flux d'énergie.
 *
 * Trois niveaux : le ou les compteurs généraux, les pièces, les appareils. La grandeur qui compte
 * n'est pas ce qui est mesuré mais ce qui ne l'est pas : sur un parc réel, le Linky annonce 428 W
 * quand la somme des appareils en fait 173. Les 255 W restants — le chauffe-eau, le four, tout ce
 * qui n'est sur aucune prise pilotée — sont la première chose que l'utilisateur doit voir, et
 * c'est précisément ce qu'une liste d'appareils ne montre jamais.
 *
 * Module pur : il ne connaît ni Homey ni le SVG, seulement des watts. C'est ce qui permet de
 * vérifier la conservation des flux par des tests plutôt qu'à l'œil sur un dessin.
 */

/** Un appareil tel que le diagramme a besoin de le connaître. */
export interface FlowDevice {
  id: string;
  name: string;
  zoneName: string | null;
  watts: number;
  /** Vrai pour un compteur général (Linky, pince ampèremétrique) : c'est une SOURCE, pas une charge. */
  cumulative: boolean;
}

export interface SankeyNode {
  id: string;
  label: string;
  watts: number;
  /** 0 = compteur général, 1 = pièce, 2 = appareil. */
  depth: 0 | 1 | 2;
}

export interface SankeyLink {
  from: string;
  to: string;
  watts: number;
}

export interface SankeyModel {
  /** Total vu par les compteurs généraux, ou la somme des appareils à défaut. */
  total: number;
  /** Somme des appareils rattachés à une pièce. */
  measured: number;
  /** Ce que le compteur voit et qu'aucun appareil n'explique. */
  unmeasured: number;
  /** Vrai quand aucun compteur général n'existe : le total n'est alors qu'une somme partielle. */
  partial: boolean;
  nodes: SankeyNode[];
  links: SankeyLink[];
}

export interface SankeyOptions {
  /** Nombre d'appareils détaillés par pièce ; au-delà ils sont regroupés. */
  maxPerZone?: number;
  /** En dessous, un appareil est trop fin pour être dessiné et rejoint le regroupement. */
  minWatts?: number;
  /**
   * Part du total en dessous de laquelle une pièce est regroupée sous « Autres pièces ».
   *
   * Sans ce seuil, un logement réel produit des bandes sous le pixel : sur le parc de test, cinq
   * pièces pèsent moins de 1 W chacune face aux 255 W non mesurés. Elles seraient dessinées, donc
   * comptées dans la hauteur, mais illisibles — et elles voleraient la place des pièces qui
   * comptent.
   */
  minZoneShare?: number;
  /**
   * Part de SA PIÈCE en dessous de laquelle un appareil rejoint le regroupement.
   *
   * Un seuil absolu ne suffit pas : dans une pièce à 39 W, six appareils à 0,3 W produisent des
   * bandes plus fines que les écarts qui les séparent. Le dessin devient une suite de rayures où
   * le blanc pèse plus que la donnée. Le seuil relatif garde le détail là où il informe — une
   * pièce dont les appareils se valent — et l'abandonne là où il n'est que du bruit.
   */
  minDeviceShare?: number;
}

const DEFAULTS = { maxPerZone: 6, minWatts: 0.05, minZoneShare: 0.01, minDeviceShare: 0.04 };

/** Identifiant de la branche non mesurée. Exporté pour que la vue puisse la styler à part. */
export const UNMEASURED_ID = 'zone:__unmeasured__';

/** Identifiant du regroupement des pièces négligeables. Feuille, comme la branche non mesurée. */
export const TINY_ZONE_ID = 'zone:__tiny__';

/** Les branches de niveau 1 qui n'ont volontairement aucun détail en dessous. */
export const LEAF_BRANCHES: ReadonlySet<string> = new Set([UNMEASURED_ID, TINY_ZONE_ID]);

export function buildSankey(devices: readonly FlowDevice[], options: SankeyOptions = {}): SankeyModel {
  const maxPerZone = options.maxPerZone ?? DEFAULTS.maxPerZone;
  const minWatts = options.minWatts ?? DEFAULTS.minWatts;
  const minZoneShare = options.minZoneShare ?? DEFAULTS.minZoneShare;
  const minDeviceShare = options.minDeviceShare ?? DEFAULTS.minDeviceShare;

  const mains = devices.filter((d) => d.cumulative && isPositive(d.watts));
  const loads = devices.filter((d) => !d.cumulative && isPositive(d.watts));

  const measured = round(loads.reduce((sum, d) => sum + d.watts, 0));
  const mainsTotal = round(mains.reduce((sum, d) => sum + d.watts, 0));

  // Sans compteur général, le diagramme reste juste mais ne prétend pas au total du logement.
  const partial = mains.length === 0;
  const total = partial ? measured : mainsTotal;

  // Un compteur qui verrait MOINS que la somme des appareils signalerait une estimation trop
  // haute ou un appareil compté deux fois : on ne dessine pas de branche négative, mais on ne
  // corrige pas non plus le total — le déséquilibre reste visible.
  const unmeasured = round(Math.max(0, total - measured));

  const nodes: SankeyNode[] = [];
  const links: SankeyLink[] = [];

  const sourceId = 'source';
  nodes.push({
    id: sourceId,
    label: mains.length === 1 ? (mains[0] as FlowDevice).name : mains.length > 1 ? 'Compteurs' : 'Appareils mesurés',
    watts: total,
    depth: 0,
  });

  // Regroupement par pièce, les plus consommatrices d'abord.
  const byZone = new Map<string, FlowDevice[]>();
  for (const device of loads) {
    const zone = device.zoneName ?? 'Sans pièce';
    const bucket = byZone.get(zone);
    if (bucket) bucket.push(device);
    else byZone.set(zone, [device]);
  }

  const allZones = [...byZone.entries()]
    .map(([name, list]) => ({ name, list, watts: round(list.reduce((s, d) => s + d.watts, 0)) }))
    .sort((a, b) => b.watts - a.watts);

  const floor = total * minZoneShare;
  const zones = allZones.filter((z) => z.watts >= floor);
  const tiny = allZones.filter((z) => z.watts < floor);

  for (const zone of zones) {
    const zoneId = `zone:${zone.name}`;
    nodes.push({ id: zoneId, label: zone.name, watts: zone.watts, depth: 1 });
    links.push({ from: sourceId, to: zoneId, watts: zone.watts });

    const sorted = [...zone.list].sort((a, b) => b.watts - a.watts);
    const deviceFloor = Math.max(minWatts, zone.watts * minDeviceShare);
    const shown = sorted.filter((d) => d.watts >= deviceFloor).slice(0, maxPerZone);
    const hidden = sorted.filter((d) => !shown.includes(d));

    for (const device of shown) {
      const deviceId = `device:${device.id}`;
      nodes.push({ id: deviceId, label: device.name, watts: round(device.watts), depth: 2 });
      links.push({ from: zoneId, to: deviceId, watts: round(device.watts) });
    }

    if (hidden.length > 0) {
      const rest = round(hidden.reduce((s, d) => s + d.watts, 0));
      if (rest > 0) {
        const restId = `${zoneId}:rest`;
        const label = `${hidden.length} autre${hidden.length > 1 ? 's' : ''}`;
        nodes.push({ id: restId, label, watts: rest, depth: 2 });
        links.push({ from: zoneId, to: restId, watts: rest });
      }
    }
  }

  // Les pièces négligeables deviennent une seule branche, sans détail : les détailler serait
  // dessiner du bruit, et les omettre ferait mentir la conservation des flux.
  if (tiny.length > 0) {
    const watts = round(tiny.reduce((s, z) => s + z.watts, 0));
    if (watts > 0) {
      const id = TINY_ZONE_ID;
      nodes.push({ id, label: `${tiny.length} pièce${tiny.length > 1 ? 's' : ''} sous le seuil`, watts, depth: 1 });
      links.push({ from: sourceId, to: id, watts });
    }
  }

  if (unmeasured > 0) {
    nodes.push({ id: UNMEASURED_ID, label: 'Non mesuré', watts: unmeasured, depth: 1 });
    links.push({ from: sourceId, to: UNMEASURED_ID, watts: unmeasured });
  }

  return { total, measured, unmeasured, partial, nodes, links };
}

function isPositive(watts: number): boolean {
  return Number.isFinite(watts) && watts > 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
