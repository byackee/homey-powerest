import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LutTable, circularDistance } from '../lib/lut.mjs';
import { HS_HUE_MAX } from '../lib/units.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures');

function fixture(name: string): string {
  return gunzipSync(readFileSync(path.join(FIXTURES, name))).toString('utf-8');
}

test('parse ignore l’en-tête et les lignes malformées', () => {
  const table = LutTable.parse('bri,mired,watt\n1,153,0.5\nbroken,line\n1,500,0.6\n\n', 'color_temp');
  assert.equal(table.size, 2);
  assert.deepEqual([...table.brightnessLevels], [1]);
});

test('un CSV sans donnée est une erreur, pas une table vide', () => {
  assert.throws(() => LutTable.parse('bri,mired,watt\n', 'color_temp'), /vide ou illisible/);
});

test('la luminosité est interpolée entre deux niveaux mesurés', () => {
  const table = LutTable.parse('bri,watt\n1,1\n101,11\n', 'brightness');
  assert.equal(table.lookup({ on: true, bri: 51 }), 6, 'milieu exact des deux niveaux');
  assert.equal(table.lookup({ on: true, bri: 1 }), 1);
  assert.equal(table.lookup({ on: true, bri: 101 }), 11);
});

test('hors plage, on reste borné au niveau extrême', () => {
  const table = LutTable.parse('bri,watt\n10,2\n200,8\n', 'brightness');
  assert.equal(table.lookup({ on: true, bri: 1 }), 2);
  assert.equal(table.lookup({ on: true, bri: 255 }), 8);
});

test('la teinte est circulaire', () => {
  // 0 et le maximum sont la même couleur : leur distance doit être nulle, pas maximale.
  assert.equal(circularDistance(0, HS_HUE_MAX, HS_HUE_MAX), 0);
  assert.ok(circularDistance(100, HS_HUE_MAX - 100, HS_HUE_MAX) < 0.01);
  assert.ok(Math.abs(circularDistance(0, HS_HUE_MAX / 2, HS_HUE_MAX) - 0.5) < 1e-6);
});

test('table couleur : deux teintes opposées ne donnent pas la même mesure', () => {
  const table = LutTable.parse(fixture('LCT012_hs.csv.gz'), 'hs');
  const red = table.lookup({ on: true, bri: 200, hue: 0, sat: 254 });
  const cyan = table.lookup({ on: true, bri: 200, hue: HS_HUE_MAX / 2, sat: 254 });
  assert.ok(red > 0 && cyan > 0);
  assert.notEqual(red, cyan, 'la recherche du plus proche voisin retombe toujours au même endroit');
});

test('profil réel LTW013 : la puissance croît avec la luminosité', () => {
  const table = LutTable.parse(fixture('LTW013_color_temp.csv.gz'), 'color_temp');
  const mired = 370; // ~2700 K, blanc chaud
  const low = table.lookup({ on: true, bri: 26, mired });
  const mid = table.lookup({ on: true, bri: 128, mired });
  const high = table.lookup({ on: true, bri: 255, mired });
  assert.ok(low < mid && mid < high, `courbe non monotone : ${low} / ${mid} / ${high}`);
  // Homey attribue une valeur plate de 6,5 W à cette ampoule dès qu'elle est allumée.
  assert.ok(high < 6.5, `à pleine puissance la LTW013 consomme moins que l’estimation Homey, obtenu ${high}`);
  assert.ok(low < 1.5, `à 10 % elle est très en dessous, obtenu ${low}`);
});

test('profil réel LCT012 : la table est indexée sans perte', () => {
  const table = LutTable.parse(fixture('LCT012_color_temp.csv.gz'), 'color_temp');
  assert.ok(table.size > 2000, `table tronquée : ${table.size} lignes`);
  assert.ok(table.brightnessLevels.length > 40);
});
