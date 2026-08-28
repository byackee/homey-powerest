import test from 'node:test';
import assert from 'node:assert/strict';

import { manualModel, effectiveMode, isPowerMode } from '../lib/manual.mjs';
import { computePower } from '../lib/strategies.mjs';

const base = { mode: 'fixed', powerOff: 0.4, powerOn: 14, powerMin: 0, powerMax: 0 };

test('le mode manuel produit un profil que le moteur habituel sait traiter', () => {
  const model = manualModel(base);
  assert.ok(model);
  assert.equal(computePower(model, {}, { on: true }).watts, 14);
  assert.equal(computePower(model, {}, { on: false }).watts, 0.4);
});

test('le cas Pipistrello : 14 W saisis à la main plutôt que les 0,6 W du profil de la prise', () => {
  // innr/SP 120 porte only_self_usage : son profil décrit la prise, pas la lampe branchée dessus.
  const model = manualModel({ mode: 'fixed', powerOff: 0.41, powerOn: 14, powerMin: 0, powerMax: 0 });
  assert.ok(model);
  assert.equal(computePower(model, {}, { on: true }).watts, 14);
});

test('le mode linéaire suit la gradation', () => {
  const model = manualModel({ mode: 'linear', powerOff: 0.5, powerOn: 0, powerMin: 2, powerMax: 12 });
  assert.ok(model);
  assert.equal(computePower(model, {}, { on: true, bri: 1 }).watts, 2);
  assert.equal(computePower(model, {}, { on: true, bri: 255 }).watts, 12);
  assert.equal(computePower(model, {}, { on: true, bri: 128 }).watts, 7);
});

test('des bornes inversées sont remises dans l’ordre, pas refusées', () => {
  const model = manualModel({ mode: 'linear', powerOff: 0, powerOn: 0, powerMin: 12, powerMax: 2 });
  assert.ok(model);
  assert.equal(computePower(model, {}, { on: true, bri: 1 }).watts, 2);
  assert.equal(computePower(model, {}, { on: true, bri: 255 }).watts, 12);
});

test('en mode profile, aucun modèle de repli n’est fabriqué', () => {
  assert.equal(manualModel({ ...base, mode: 'profile' }), null);
});

test('une saisie vide, textuelle ou négative vaut zéro et non NaN', () => {
  for (const bad of [undefined, null, '', 'douze', -5, Number.NaN]) {
    const model = manualModel({ mode: 'fixed', powerOff: bad, powerOn: bad, powerMin: 0, powerMax: 0 });
    assert.ok(model);
    assert.equal(computePower(model, {}, { on: true }).watts, 0);
    assert.equal(computePower(model, {}, { on: false }).watts, 0);
  }
});

test('un nombre saisi comme texte est accepté', () => {
  const model = manualModel({ mode: 'fixed', powerOff: '0.4', powerOn: '14', powerMin: 0, powerMax: 0 });
  assert.ok(model);
  assert.equal(computePower(model, {}, { on: true }).watts, 14);
});

test('sans profil disponible, le mode profile retombe sur la saisie manuelle', () => {
  assert.equal(effectiveMode('profile', false), 'fixed');
  assert.equal(effectiveMode('profile', true), 'profile');
  assert.equal(effectiveMode('linear', false), 'linear');
  assert.equal(effectiveMode(undefined, true), 'profile');
  assert.equal(effectiveMode('n’importe quoi', true), 'profile');
});

test('isPowerMode refuse ce qui n’est pas un mode', () => {
  assert.ok(isPowerMode('fixed'));
  assert.ok(!isPowerMode('lut'));
  assert.ok(!isPowerMode(3));
});
