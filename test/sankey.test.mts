import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSankey, LEAF_BRANCHES, TINY_ZONE_ID, UNMEASURED_ID, type FlowDevice } from '../lib/sankey.mjs';

const dev = (id: string, name: string, zoneName: string | null, watts: number, cumulative = false): FlowDevice =>
  ({ id, name, zoneName, watts, cumulative });

/** Le relevé réel : Linky à 428 W, appareils à 173 W. */
const REAL = [
  dev('linky', '07190593332258 - 4 kVA', 'Maison', 428, true),
  dev('a', 'Micro-ondes', 'Cuisine', 2.5),
  dev('b', 'Lave-linge', 'Cuisine', 0.45),
  dev('c', 'Radiateur SDB', 'Salle de bain', 38),
  dev('d', 'Machine à café', 'Entrée', 110),
];

test('le compteur général est la source, jamais une charge', () => {
  const m = buildSankey(REAL);
  const source = m.nodes.find((n) => n.depth === 0);
  assert.ok(source);
  assert.equal(source.label, '07190593332258 - 4 kVA');
  assert.ok(!m.nodes.some((n) => n.depth === 2 && n.label.includes('4 kVA')), 'le Linky s’est retrouvé en appareil');
});

test('la branche non mesurée porte ce que le compteur voit en trop', () => {
  const m = buildSankey(REAL);
  assert.equal(m.total, 428);
  assert.equal(m.measured, 150.95);
  assert.equal(m.unmeasured, 277.05);
  const branch = m.nodes.find((n) => n.id === UNMEASURED_ID);
  assert.ok(branch, 'aucune branche non mesurée');
  assert.equal(branch.watts, 277.05);
});

test('les flux se conservent : ce qui sort de la source vaut le total', () => {
  const m = buildSankey(REAL);
  const fromSource = m.links.filter((l) => l.from === 'source').reduce((s, l) => s + l.watts, 0);
  assert.ok(Math.abs(fromSource - m.total) < 0.01, `${fromSource} ≠ ${m.total}`);
});

test('chaque pièce redistribue exactement ce qu’elle reçoit', () => {
  const m = buildSankey(REAL);
  for (const zone of m.nodes.filter((n) => n.depth === 1 && !LEAF_BRANCHES.has(n.id))) {
    const out = m.links.filter((l) => l.from === zone.id).reduce((s, l) => s + l.watts, 0);
    assert.ok(Math.abs(out - zone.watts) < 0.01, `${zone.label} : ${out} ≠ ${zone.watts}`);
  }
});

test('les pièces sont classées par consommation décroissante', () => {
  const zones = buildSankey(REAL).nodes.filter((n) => n.depth === 1 && !LEAF_BRANCHES.has(n.id));
  const watts = zones.map((z) => z.watts);
  assert.deepEqual(watts, [...watts].sort((a, b) => b - a));
});

test('sans compteur général, le diagramme se déclare partiel et n’invente pas de reste', () => {
  const m = buildSankey(REAL.slice(1));
  assert.equal(m.partial, true);
  assert.equal(m.unmeasured, 0);
  assert.equal(m.total, m.measured);
  assert.ok(!m.nodes.some((n) => n.id === UNMEASURED_ID));
});

test('un compteur qui voit moins que la somme ne produit pas de branche négative', () => {
  const m = buildSankey([dev('m', 'Compteur', 'Maison', 10, true), dev('x', 'Gros', 'Cuisine', 40)]);
  assert.equal(m.unmeasured, 0);
  assert.ok(!m.nodes.some((n) => n.id === UNMEASURED_ID));
  assert.equal(m.total, 10, 'le total du compteur ne doit pas être corrigé en douce');
});

test('au-delà du plafond, les appareils d’une pièce sont regroupés', () => {
  const many = [dev('m', 'Compteur', 'Maison', 100, true)];
  for (let i = 0; i < 10; i += 1) many.push(dev(`d${i}`, `Lampe ${i}`, 'Salon', 10 - i));
  const m = buildSankey(many, { maxPerZone: 3 });
  const salon = m.links.filter((l) => l.from === 'zone:Salon');
  assert.equal(salon.length, 4, '3 appareils + 1 regroupement attendus');
  const rest = m.nodes.find((n) => n.id === 'zone:Salon:rest');
  assert.ok(rest);
  assert.equal(rest.label, '7 autres');
});

test('les appareils trop fins pour être dessinés rejoignent le regroupement', () => {
  const m = buildSankey([
    dev('m', 'Compteur', 'Maison', 100, true),
    dev('a', 'Gros', 'Salon', 50),
    dev('b', 'Poussière', 'Salon', 0.001),
  ], { minWatts: 0.05 });
  assert.ok(!m.nodes.some((n) => n.label === 'Poussière'));
  const out = m.links.filter((l) => l.from === 'zone:Salon').reduce((s, l) => s + l.watts, 0);
  assert.ok(Math.abs(out - 50.001) < 0.01, 'le regroupement doit conserver les watts');
});

test('un appareil sans pièce est rattaché plutôt qu’ignoré', () => {
  const m = buildSankey([dev('m', 'Compteur', null, 50, true), dev('x', 'Orphelin', null, 20)]);
  assert.ok(m.nodes.some((n) => n.depth === 1 && n.label === 'Sans pièce'));
});

test('les valeurs absurdes ne franchissent pas le modèle', () => {
  const m = buildSankey([
    dev('m', 'Compteur', 'Maison', 100, true),
    dev('a', 'NaN', 'Salon', Number.NaN),
    dev('b', 'Négatif', 'Salon', -5),
    dev('c', 'Zéro', 'Salon', 0),
  ]);
  assert.equal(m.measured, 0);
  assert.ok(!m.nodes.some((n) => n.depth === 2));
});

test('un parc entièrement vide ne casse pas', () => {
  const m = buildSankey([]);
  assert.equal(m.total, 0);
  assert.equal(m.nodes.length, 1);
  assert.equal(m.links.length, 0);
});

test('les pièces négligeables sont regroupées sans casser la conservation', () => {
  const devices = [dev('m', 'Compteur', 'Maison', 200, true), dev('big', 'Radiateur', 'Salon', 150)];
  for (let i = 0; i < 5; i += 1) devices.push(dev(`t${i}`, `Veille ${i}`, `Pièce ${i}`, 0.4));
  const m = buildSankey(devices, { minZoneShare: 0.01 });

  const tiny = m.nodes.find((n) => n.id === TINY_ZONE_ID);
  assert.ok(tiny, 'aucun regroupement de petites pièces');
  assert.equal(tiny.label, '5 pièces sous le seuil');
  assert.ok(Math.abs(tiny.watts - 2) < 0.01);

  // La somme des branches sortant de la source doit toujours valoir le total du compteur.
  const out = m.links.filter((l) => l.from === 'source').reduce((s, l) => s + l.watts, 0);
  assert.ok(Math.abs(out - m.total) < 0.01, `${out} ≠ ${m.total}`);
  assert.ok(!m.nodes.some((n) => n.label.startsWith('Veille')), 'le détail des petites pièces est dessiné');
});

test('un seuil à zéro laisse toutes les pièces détaillées', () => {
  const m = buildSankey([dev('m', 'C', 'Maison', 100, true), dev('a', 'X', 'Petite', 0.2)], { minZoneShare: 0 });
  assert.ok(m.nodes.some((n) => n.id === 'zone:Petite'));
  assert.ok(!m.nodes.some((n) => n.id === TINY_ZONE_ID));
});

test('les branches feuilles sont exactement celles qui n’ont pas de détail', () => {
  const devices = [dev('m', 'C', 'Maison', 300, true), dev('a', 'Gros', 'Salon', 100)];
  for (let i = 0; i < 3; i += 1) devices.push(dev(`t${i}`, `V${i}`, `P${i}`, 0.3));
  const m = buildSankey(devices);
  for (const node of m.nodes.filter((n) => n.depth === 1)) {
    const hasChildren = m.links.some((l) => l.from === node.id);
    assert.equal(hasChildren, !LEAF_BRANCHES.has(node.id),
      `${node.label} : feuille et détail incohérents`);
  }
});

test('les appareils négligeables face à leur pièce rejoignent le regroupement', () => {
  const devices = [dev('m', 'C', 'Maison', 100, true), dev('big', 'Radiateur', 'SDB', 38)];
  for (let i = 0; i < 6; i += 1) devices.push(dev(`v${i}`, `Veille ${i}`, 'SDB', 0.3));
  const m = buildSankey(devices, { minDeviceShare: 0.04 });

  const kids = m.links.filter((l) => l.from === 'zone:SDB');
  assert.equal(kids.length, 2, 'le radiateur et un seul regroupement attendus');
  const rest = m.nodes.find((n) => n.id === 'zone:SDB:rest');
  assert.ok(rest);
  assert.equal(rest.label, '6 autres');
  // La conservation doit tenir malgré le regroupement.
  const out = kids.reduce((s, l) => s + l.watts, 0);
  const zone = m.nodes.find((n) => n.id === 'zone:SDB');
  assert.ok(zone && Math.abs(out - zone.watts) < 0.01);
});

test('une pièce dont les appareils se valent garde son détail', () => {
  const devices = [dev('m', 'C', 'Maison', 100, true)];
  for (let i = 0; i < 4; i += 1) devices.push(dev(`e${i}`, `Appareil ${i}`, 'Cuisine', 10));
  const m = buildSankey(devices, { minDeviceShare: 0.04 });
  assert.equal(m.links.filter((l) => l.from === 'zone:Cuisine').length, 4);
  assert.ok(!m.nodes.some((n) => n.id === 'zone:Cuisine:rest'));
});
