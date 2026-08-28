import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSankey, LEAF_NODES, SOURCE_ID, TINY_ZONE_ID, UNMEASURED_ID, type FlowDevice,
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
