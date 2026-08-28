import test from 'node:test';
import assert from 'node:assert/strict';

import { crossedUp, crossedDown } from '../lib/threshold.mjs';

test('le franchissement ne vaut qu’au moment où il a lieu', () => {
  assert.equal(crossedUp(90, 110, 100), true, 'le passage doit déclencher');
  // Le piège : rester au-dessus n'est PAS un franchissement. Sans ça, la notification part toutes
  // les minutes tant que la maison consomme.
  assert.equal(crossedUp(110, 120, 100), false);
  assert.equal(crossedUp(90, 95, 100), false);
});

test('le seuil exact appartient au bas : on le franchit en le dépassant', () => {
  assert.equal(crossedUp(100, 101, 100), true);
  assert.equal(crossedUp(99, 100, 100), false, '« dépasse » veut dire strictement au-dessus');
});

test('la descente est symétrique de la montée', () => {
  assert.equal(crossedDown(110, 90, 100), true);
  assert.equal(crossedDown(90, 80, 100), false);
  assert.equal(crossedDown(100, 99, 100), true);
  assert.equal(crossedDown(101, 100, 100), false);
});

test('une montée et une descente ne sont jamais vraies ensemble', () => {
  for (const [a, b, t] of [[90, 110, 100], [110, 90, 100], [100, 100, 100], [0, 500, 250]] as const) {
    assert.ok(!(crossedUp(a, b, t) && crossedDown(a, b, t)), `${a}→${b} seuil ${t}`);
  }
});

test('une valeur illisible ne déclenche rien', () => {
  assert.equal(crossedUp(Number.NaN, 110, 100), false);
  assert.equal(crossedUp(90, Number.NaN, 100), false);
  assert.equal(crossedUp(90, 110, Number.NaN), false);
  assert.equal(crossedDown(Number.NaN, 90, 100), false);
});

test('dix Flows avec dix seuils jugent chacun le leur', () => {
  // C'est tout l'intérêt : l'app publie un seul couple avant/après, chaque Flow décide.
  const seuils = [50, 100, 150, 200];
  const declenches = seuils.filter((s) => crossedUp(80, 180, s));
  assert.deepEqual(declenches, [100, 150]);
});
