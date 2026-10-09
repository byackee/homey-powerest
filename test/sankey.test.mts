import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSankey, EXPORT_ID, GRID_ID, GROUPINGS, LEAF_NODES, OTHER_SOURCE_ID, SOLAR_ID, SOURCE_ID,
  TINY_ZONE_ID, UNMEASURED_ID, type FlowDevice,
} from '../lib/sankey.mjs';

const dev = (
  id: string, name: string, zoneName: string | null, watts: number,
  deviceClass: string | null = 'light', cumulative = false,
): FlowDevice => ({ id, name, zoneName, watts, cumulative, deviceClass });

/** Un relevé qui met plusieurs usages dans la même pièce, et un usage dans plusieurs pièces. */
const REAL: FlowDevice[] = [
  dev('linky', 'Linky', 'Maison', 400, null, true),
  dev('l1', 'Lampe salon', 'Salon', 20, 'light'),
  dev('l2', 'Lampe cuisine', 'Cuisine', 10, 'light'),
  dev('tv', 'Télé', 'Salon', 60, 'tv'),
  dev('ap', 'Apple TV', 'Salon', 3, 'settopbox'),
  dev('lv', 'Lave-linge', 'Cuisine', 40, 'washingmachine'),
];

/** Somme des flux sortant d'un nœud. */
function out(m: ReturnType<typeof buildSankey>, id: string): number {
  return m.links.filter((l) => l.from === id).reduce((s, l) => s + l.watts, 0);
}
function into(m: ReturnType<typeof buildSankey>, id: string): number {
  return m.links.filter((l) => l.to === id).reduce((s, l) => s + l.watts, 0);
}

test('le compteur général est la source, jamais une charge', () => {
  const m = buildSankey(REAL);
  const src = m.nodes.find((n) => n.depth === 0);
  assert.ok(src);
  assert.equal(src.label, 'Linky');
  assert.equal(src.watts, 400);
  assert.ok(!m.nodes.some((n) => n.depth === 3 && n.label === 'Linky'));
});

test('les quatre niveaux existent', () => {
  const depths = new Set(buildSankey(REAL).nodes.map((n) => n.depth));
  assert.deepEqual([...depths].sort(), [0, 1, 2, 3]);
});

test('le graphe n’est plus un arbre : une pièce reçoit de plusieurs usages', () => {
  const m = buildSankey(REAL);
  // Le Salon reçoit de l'éclairage ET du multimédia.
  const incoming = m.links.filter((l) => l.to === 'zone:Salon');
  assert.ok(incoming.length >= 2, `le Salon ne reçoit que ${incoming.length} flux`);
  const cats = new Set(incoming.map((l) => l.from));
  assert.ok(cats.has('cat:light') && cats.has('cat:media'));
});

test('un usage arrose plusieurs pièces', () => {
  const m = buildSankey(REAL);
  const zones = m.links.filter((l) => l.from === 'cat:light').map((l) => l.to);
  assert.deepEqual([...zones].sort(), ['zone:Cuisine', 'zone:Salon']);
});

test('les flux se conservent à chaque niveau', () => {
  const m = buildSankey(REAL);
  assert.ok(Math.abs(out(m, SOURCE_ID) - m.total) < 0.01, 'la source ne distribue pas son total');
  for (const n of m.nodes.filter((x) => x.depth === 1 && !LEAF_NODES.has(x.id))) {
    assert.ok(Math.abs(into(m, n.id) - n.watts) < 0.01, `${n.label} : entrée ≠ valeur`);
    assert.ok(Math.abs(out(m, n.id) - n.watts) < 0.01, `${n.label} : sortie ≠ valeur`);
  }
  for (const n of m.nodes.filter((x) => x.depth === 2 && !LEAF_NODES.has(x.id))) {
    assert.ok(Math.abs(into(m, n.id) - n.watts) < 0.01, `${n.label} : entrée ≠ valeur`);
    assert.ok(Math.abs(out(m, n.id) - n.watts) < 0.01, `${n.label} : sortie ≠ valeur`);
  }
});

test('la branche non mesurée porte l’écart au compteur', () => {
  const m = buildSankey(REAL);
  assert.equal(m.measured, 133);
  assert.equal(m.unmeasured, 267);
  const branch = m.nodes.find((n) => n.id === UNMEASURED_ID);
  assert.ok(branch);
  assert.equal(branch.depth, 1, 'le non mesuré doit vivre au niveau des usages');
});

test('les usages sont classés du plus lourd au plus léger', () => {
  const cats = buildSankey(REAL).nodes.filter((n) => n.depth === 1 && n.id !== UNMEASURED_ID);
  const watts = cats.map((c) => c.watts);
  assert.deepEqual(watts, [...watts].sort((a, b) => b - a));
});

test('sans compteur, le diagramme se déclare partiel et n’invente pas de reste', () => {
  const m = buildSankey(REAL.slice(1));
  assert.equal(m.partial, true);
  assert.equal(m.unmeasured, 0);
  assert.equal(m.total, m.measured);
  assert.ok(!m.nodes.some((n) => n.id === UNMEASURED_ID));
});

test('un compteur qui voit moins que la somme ne produit pas de branche négative', () => {
  const m = buildSankey([dev('m', 'C', 'Maison', 10, null, true), dev('x', 'Gros', 'Cuisine', 40)]);
  assert.equal(m.unmeasured, 0);
  assert.equal(m.total, 10, 'le total du compteur ne doit pas être corrigé en douce');
});

test('les pièces négligeables sont regroupées sans casser la conservation', () => {
  const devices = [dev('m', 'C', 'Maison', 200, null, true), dev('big', 'Radiateur', 'Salon', 150, 'heater')];
  for (let i = 0; i < 5; i += 1) devices.push(dev(`t${i}`, `Veille ${i}`, `Pièce ${i}`, 0.4, 'socket'));
  const m = buildSankey(devices, { minZoneShare: 0.01 });

  const tiny = m.nodes.find((n) => n.id === TINY_ZONE_ID);
  assert.ok(tiny, 'aucun regroupement de petites pièces');
  assert.equal(tiny.label, '5 pièces sous le seuil');
  assert.ok(Math.abs(tiny.watts - 2) < 0.01);
  assert.ok(!m.links.some((l) => l.from === TINY_ZONE_ID), 'le regroupement ne doit pas être détaillé');
  assert.ok(Math.abs(out(m, SOURCE_ID) - m.total) < 0.01);
});

test('les appareils négligeables face à leur pièce rejoignent un regroupement', () => {
  const devices = [dev('m', 'C', 'Maison', 100, null, true), dev('big', 'Radiateur', 'SDB', 38, 'heater')];
  for (let i = 0; i < 6; i += 1) devices.push(dev(`v${i}`, `Veille ${i}`, 'SDB', 0.3, 'heater'));
  const m = buildSankey(devices, { minDeviceShare: 0.04 });
  const kids = m.links.filter((l) => l.from === 'zone:SDB');
  assert.equal(kids.length, 2, 'le radiateur et un seul regroupement attendus');
  assert.ok(m.nodes.some((n) => n.id === 'zone:SDB:rest' && n.label === '6 autres'));
  const zone = m.nodes.find((n) => n.id === 'zone:SDB');
  assert.ok(zone && Math.abs(out(m, 'zone:SDB') - zone.watts) < 0.01);
});

test('une pièce dont les appareils se valent garde son détail', () => {
  const devices = [dev('m', 'C', 'Maison', 100, null, true)];
  for (let i = 0; i < 4; i += 1) devices.push(dev(`e${i}`, `Appareil ${i}`, 'Cuisine', 10, 'light'));
  const m = buildSankey(devices, { minDeviceShare: 0.04, maxPerZone: 5 });
  assert.equal(m.links.filter((l) => l.from === 'zone:Cuisine').length, 4);
});

test('un appareil sans pièce est rattaché plutôt qu’ignoré', () => {
  const m = buildSankey([dev('m', 'C', null, 50, null, true), dev('x', 'Orphelin', null, 20, 'light')]);
  assert.ok(m.nodes.some((n) => n.depth === 2 && n.label === 'Sans pièce'));
});

test('les valeurs absurdes ne franchissent pas le modèle', () => {
  const m = buildSankey([
    dev('m', 'C', 'Maison', 100, null, true),
    dev('a', 'NaN', 'Salon', Number.NaN, 'light'),
    dev('b', 'Négatif', 'Salon', -5, 'light'),
    dev('c', 'Zéro', 'Salon', 0, 'light'),
  ]);
  assert.equal(m.measured, 0);
  assert.ok(!m.nodes.some((n) => n.depth === 3));
});

test('un parc entièrement vide ne casse pas', () => {
  const m = buildSankey([]);
  assert.equal(m.total, 0);
  assert.equal(m.nodes.length, 1);
  assert.equal(m.links.length, 0);
});

test('chaque lien porte son usage, pour que la vue puisse le colorer', () => {
  const m = buildSankey(REAL);
  const colored = m.links.filter((l) => l.to !== UNMEASURED_ID && !l.to.endsWith(':rest'));
  assert.ok(colored.every((l) => typeof l.categoryId === 'string'), 'un lien sans usage');
});

test('aucun lien ne pointe vers un nœud absent', () => {
  const m = buildSankey(REAL);
  const ids = new Set(m.nodes.map((n) => n.id));
  for (const l of m.links) {
    assert.ok(ids.has(l.from), `lien depuis un nœud absent : ${l.from}`);
    assert.ok(ids.has(l.to), `lien vers un nœud absent : ${l.to}`);
  }
});

test('groupement par usage seul : trois niveaux, aucune pièce', () => {
  const m = buildSankey(REAL, { grouping: GROUPINGS['category'] });
  const depths = new Set(m.nodes.map((n) => n.depth));
  assert.deepEqual([...depths].sort(), [0, 1, 2]);
  assert.ok(!m.nodes.some((n) => n.label === 'Salon' || n.label === 'Cuisine'));
  assert.ok(m.nodes.some((n) => n.id === 'cat:light'));
  // Les appareils sont accrochés directement à leur usage.
  assert.ok(m.links.some((l) => l.from === 'cat:media' && l.to === 'device:tv'));
});

test('groupement par pièce seul : aucune catégorie', () => {
  const m = buildSankey(REAL, { grouping: GROUPINGS['zone'] });
  assert.ok(!m.nodes.some((n) => n.id.startsWith('cat:')), 'une catégorie subsiste');
  assert.ok(m.nodes.some((n) => n.id === 'zone:Salon'));
  assert.ok(m.links.some((l) => l.from === SOURCE_ID && l.to === 'zone:Salon'));
  assert.ok(m.links.some((l) => l.from === 'zone:Salon' && l.to === 'device:tv'));
});

test('les flux se conservent quel que soit le groupement', () => {
  for (const key of ['category+zone', 'category', 'zone']) {
    const m = buildSankey(REAL, { grouping: GROUPINGS[key] });
    assert.ok(Math.abs(out(m, SOURCE_ID) - m.total) < 0.01, `${key} : la source ne distribue pas son total`);
    for (const n of m.nodes.filter((x) => x.depth > 0 && !LEAF_NODES.has(x.id))) {
      const hasOut = m.links.some((l) => l.from === n.id);
      assert.ok(Math.abs(into(m, n.id) - n.watts) < 0.01, `${key} / ${n.label} : entrée ≠ valeur`);
      if (hasOut) assert.ok(Math.abs(out(m, n.id) - n.watts) < 0.01, `${key} / ${n.label} : sortie ≠ valeur`);
    }
  }
});

test('le total est le même quel que soit le groupement : c’est le même logement', () => {
  const a = buildSankey(REAL, { grouping: GROUPINGS['category+zone'] });
  const b = buildSankey(REAL, { grouping: GROUPINGS['category'] });
  const c = buildSankey(REAL, { grouping: GROUPINGS['zone'] });
  assert.equal(a.total, b.total);
  assert.equal(b.total, c.total);
  assert.equal(a.measured, c.measured);
});

test('seul le groupement croisé produit un graphe non arborescent', () => {
  // Un nœud recevant plus d'un flux est la définition d'un croisement possible.
  const multi = (key: string): number => {
    const m = buildSankey(REAL, { grouping: GROUPINGS[key] });
    return m.nodes.filter((n) => m.links.filter((l) => l.to === n.id).length > 1).length;
  };
  assert.ok(multi('category+zone') > 0, 'le croisé devrait produire des convergences');
  assert.equal(multi('category'), 0);
  assert.equal(multi('zone'), 0);
});

test('la branche non mesurée reste juste après le compteur dans tous les cas', () => {
  for (const key of ['category+zone', 'category', 'zone']) {
    const m = buildSankey(REAL, { grouping: GROUPINGS[key] });
    const branch = m.nodes.find((n) => n.id === UNMEASURED_ID);
    assert.ok(branch, `${key} : branche absente`);
    assert.equal(branch.depth, 1);
    assert.ok(m.links.some((l) => l.from === SOURCE_ID && l.to === UNMEASURED_ID));
  }
});

/** Le cas réel : un onduleur qui n'est pas une charge mais un sous-compteur. */
const UPS: FlowDevice[] = [
  { id: 'linky', name: 'Linky', zoneName: 'Maison', watts: 400, cumulative: true, deviceClass: null },
  { id: 'ups', name: 'Ellipse ECO 650', zoneName: 'Entrée', watts: 100, cumulative: false, deviceClass: 'other' },
  { id: 'nas', name: 'NAS', zoneName: 'Entrée', watts: 55, cumulative: false, deviceClass: 'other', poweredBy: 'ups' },
  { id: 'box', name: 'Box', zoneName: 'Entrée', watts: 15, cumulative: false, deviceClass: 'other', poweredBy: 'ups' },
  { id: 'lamp', name: 'Lampe', zoneName: 'Salon', watts: 8, cumulative: false, deviceClass: 'light' },
];

test('un appareil derrière un sous-compteur n’est pas compté deux fois', () => {
  const m = buildSankey(UPS);
  // 100 (onduleur, qui CONTIENT le NAS et la box) + 8 (lampe) = 108, et non 178.
  assert.equal(m.measured, 108);
  assert.equal(m.unmeasured, 292);
});

test('le sous-compteur devient une branche, pas une charge', () => {
  const m = buildSankey(UPS);
  const meter = m.nodes.find((n) => n.id === 'meter:ups');
  assert.ok(meter, 'aucun nœud de sous-comptage');
  assert.equal(meter.watts, 100);
  assert.ok(m.links.some((l) => l.from === SOURCE_ID && l.to === 'meter:ups'));
  // Il ne doit surtout pas apparaître aussi comme un appareil rangé par usage.
  assert.ok(!m.nodes.some((n) => n.id === 'device:ups'));
  assert.ok(!m.links.some((l) => l.from.startsWith('cat:') && l.to === 'device:ups'));
});

test('ce que le sous-compteur porte sans qu’on sache quoi devient un reste', () => {
  const m = buildSankey(UPS);
  const rest = m.nodes.find((n) => n.id === 'meter:ups:rest');
  assert.ok(rest, 'aucun reste de branche');
  assert.equal(rest.watts, 30);           // 100 − 55 − 15
  assert.equal(rest.label, 'Reste de la branche');
  const out = m.links.filter((l) => l.from === 'meter:ups').reduce((s, l) => s + l.watts, 0);
  assert.ok(Math.abs(out - 100) < 0.01, 'la branche ne redistribue pas son total');
});

test('des enfants qui dépassent la mesure du parent ne font pas disparaître d’énergie', () => {
  // La mesure du sous-compteur peut être en retard sur celles de ses enfants.
  const m = buildSankey([
    { id: 'm', name: 'C', zoneName: null, watts: 100, cumulative: true, deviceClass: null },
    { id: 'ups', name: 'Onduleur', zoneName: null, watts: 10, cumulative: false, deviceClass: 'other' },
    { id: 'a', name: 'A', zoneName: null, watts: 40, cumulative: false, deviceClass: 'other', poweredBy: 'ups' },
  ]);
  const meter = m.nodes.find((n) => n.id === 'meter:ups');
  assert.ok(meter);
  assert.equal(meter.watts, 40, 'le total de la branche doit suivre les enfants observés');
  assert.equal(m.measured, 40);
  assert.ok(!m.nodes.some((n) => n.id === 'meter:ups:rest'), 'pas de reste négatif');
});

test('une relation vers un appareil absent ou vers soi-même est ignorée', () => {
  const m = buildSankey([
    { id: 'm', name: 'C', zoneName: null, watts: 100, cumulative: true, deviceClass: null },
    { id: 'a', name: 'A', zoneName: 'Salon', watts: 10, cumulative: false, deviceClass: 'light', poweredBy: 'fantome' },
    { id: 'b', name: 'B', zoneName: 'Salon', watts: 5, cumulative: false, deviceClass: 'light', poweredBy: 'b' },
  ]);
  assert.equal(m.measured, 15, 'les deux appareils doivent rester comptés');
  assert.ok(!m.nodes.some((n) => n.id.startsWith('meter:')));
});

test('les sous-compteurs survivent au changement de groupement', () => {
  for (const key of ['category+zone', 'category', 'zone']) {
    const m = buildSankey(UPS, { grouping: GROUPINGS[key] });
    assert.equal(m.measured, 108, `${key} : total faux`);
    assert.ok(m.nodes.some((n) => n.id === 'meter:ups'), `${key} : branche perdue`);
    assert.ok(Math.abs(out(m, SOURCE_ID) - m.total) < 0.01, `${key} : conservation rompue`);
  }
});

// --- Production solaire et réinjection --------------------------------------
// Signalé sur le forum : le P1 disparaissait dès qu'il devenait négatif (export), les panneaux
// étaient rangés parmi les usages, et l'export n'était dessiné nulle part.

const solar = (watts: number): FlowDevice => ({ ...dev('pv', 'Onduleur', 'Garage', watts, 'solarpanel'), solar: true });
const p1 = (watts: number): FlowDevice => dev('p1', 'P1', 'Maison', watts, null, true);
const LOADS: FlowDevice[] = [
  dev('l1', 'Lampe', 'Salon', 100, 'light'),
  dev('lv', 'Lave-linge', 'Cuisine', 500, 'washingmachine'),
];

test('un compteur négatif reste le compteur : il réinjecte', () => {
  const m = buildSankey([p1(-1400), solar(2000), ...LOADS]);
  assert.equal(m.partial, false, 'le P1 ne doit pas disparaître quand il exporte');
  assert.deepEqual(m.balance, { imported: 0, exported: 1400, produced: 2000 });
  // Consommation = 0 importé + 2000 produits − 1400 exportés.
  assert.equal(m.total, 600);
  assert.equal(m.unmeasured, 0);
});

test('la production est une entrée, jamais un usage', () => {
  const m = buildSankey([p1(-1400), solar(2000), ...LOADS]);
  assert.ok(!m.nodes.some((n) => n.depth > 0 && n.label === 'Onduleur'), 'l’onduleur est rangé parmi les usages');
  const pv = m.nodes.find((n) => n.id === SOLAR_ID);
  assert.ok(pv);
  assert.equal(pv.depth, -1);
  assert.equal(pv.watts, 2000);
});

test('le surplus part de la production vers l’export, le reste alimente le logement', () => {
  const m = buildSankey([p1(-1400), solar(2000), ...LOADS]);
  assert.equal(into(m, EXPORT_ID), 1400);
  assert.equal(m.links.find((l) => l.from === SOLAR_ID && l.to === EXPORT_ID)?.watts, 1400);
  assert.equal(into(m, SOURCE_ID), m.total);
  assert.ok(Math.abs(out(m, SOURCE_ID) - m.total) < 0.01, 'le logement ne redistribue pas ce qu’il reçoit');
  assert.ok(!m.nodes.some((n) => n.id === GRID_ID), 'rien n’est importé : pas d’entrée réseau');
});

test('réseau et solaire alimentent ensemble le logement', () => {
  const m = buildSankey([p1(300), solar(500), ...LOADS, dev('x', 'Four', 'Cuisine', 150, 'oven')]);
  assert.deepEqual(m.balance, { imported: 300, exported: 0, produced: 500 });
  assert.equal(m.total, 800);
  assert.equal(m.unmeasured, 50);
  assert.equal(m.links.find((l) => l.from === GRID_ID)?.watts, 300);
  assert.equal(m.links.find((l) => l.from === SOLAR_ID && l.to === SOURCE_ID)?.watts, 500);
  assert.ok(!m.nodes.some((n) => n.id === EXPORT_ID));
});

test('un export sans production déclarée prouve un onduleur absent de Homey', () => {
  const m = buildSankey([p1(-800), ...LOADS]);
  const other = m.nodes.find((n) => n.id === OTHER_SOURCE_ID);
  assert.ok(other, 'la production cachée doit être dessinée');
  // Elle exporte 800 W et alimente les 600 W mesurés.
  assert.equal(other.watts, 1400);
  assert.equal(into(m, EXPORT_ID), 800);
  assert.equal(m.total, 600);
});

test('sans solaire ni export, le diagramme ne change pas de forme', () => {
  const m = buildSankey([p1(700), ...LOADS]);
  assert.equal(m.nodes.find((n) => n.id === SOURCE_ID)?.label, 'P1');
  assert.ok(!m.nodes.some((n) => n.depth === -1 || n.id === EXPORT_ID));
});

test('un excédent des appareils sans export ne fabrique pas de production', () => {
  // Estimation trop haute : le déséquilibre doit rester visible, pas être comblé en douce.
  const m = buildSankey([p1(400), ...LOADS]);
  assert.ok(!m.nodes.some((n) => n.id === OTHER_SOURCE_ID));
  assert.equal(m.total, 400);
});

test('sans compteur, le surplus solaire est avoué comme tel', () => {
  const m = buildSankey([solar(1000), ...LOADS]);
  assert.equal(m.partial, true);
  assert.equal(m.total, 600);
  assert.deepEqual(m.balance, { imported: null, exported: null, produced: 1000 });
  assert.equal(m.nodes.find((n) => n.id === EXPORT_ID)?.watts, 400);
  assert.equal(into(m, SOURCE_ID), 600);
});

test('sans compteur, ce que le solaire ne couvre pas vient d’une origine inconnue', () => {
  const m = buildSankey([solar(200), ...LOADS]);
  assert.equal(m.nodes.find((n) => n.id === OTHER_SOURCE_ID)?.watts, 400);
  assert.ok(!m.nodes.some((n) => n.id === EXPORT_ID));
  assert.equal(into(m, SOURCE_ID), 600);
});

test('une production à l’arrêt la nuit ne laisse aucune trace', () => {
  const m = buildSankey([p1(700), solar(0), ...LOADS]);
  assert.ok(!m.nodes.some((n) => n.depth === -1));
  assert.equal(m.total, 700);
});

test('export inconnu (période) : le non-mesuré peut contenir l’export', () => {
  const m = buildSankey([p1(3), solar(10), ...LOADS.map((d) => ({ ...d, watts: d.watts / 1000 }))], { exportKnown: false });
  assert.equal(m.balance.exported, null);
  assert.equal(m.unmeasuredMayIncludeExport, true);
});

test('quelques watts d’écart entre P1 et onduleur ne fabriquent pas un onduleur caché', () => {
  // Les deux relevés ne tombent pas au même instant : 500 W exportés pour 499,99 W produits.
  const m = buildSankey([p1(-500), solar(499.99), ...LOADS]);
  assert.ok(!m.nodes.some((n) => n.id === OTHER_SOURCE_ID));
});
