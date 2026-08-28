import test from 'node:test';
import assert from 'node:assert/strict';

import { plannedCapabilities, writableCapabilities, capabilityDiff, OWN_CAPABILITIES } from '../lib/mirror.mjs';

/** Capabilities réelles d'une Hue LightStrip, telles que l'app Philips Hue les publie. */
const LIGHTSTRIP = ['onoff', 'dim', 'light_hue', 'light_saturation', 'light_temperature', 'light_mode', 'button.migrate_v3'];
const WHITE_BULB = ['onoff', 'dim', 'button.migrate_v3'];
const PLUG = ['onoff'];

test('le compagnon reprend les commandes de la source et ajoute la consommation', () => {
  assert.deepEqual(plannedCapabilities(LIGHTSTRIP), [
    'onoff', 'dim', 'light_hue', 'light_saturation', 'light_temperature', 'light_mode',
    'measure_power', 'meter_power',
  ]);
});

test('les capabilities étrangères de la source ne sont pas reprises', () => {
  assert.ok(!plannedCapabilities(LIGHTSTRIP).includes('button.migrate_v3'));
});

test('une lampe blanche n’hérite pas de commandes de couleur', () => {
  assert.deepEqual(plannedCapabilities(WHITE_BULB), ['onoff', 'dim', 'measure_power', 'meter_power']);
});

test('une prise garde son seul interrupteur', () => {
  assert.deepEqual(plannedCapabilities(PLUG), ['onoff', 'measure_power', 'meter_power']);
});

test('l’ordre est celui de la tuile : allumage, gradation, couleur, puis mesure', () => {
  const caps = plannedCapabilities(LIGHTSTRIP);
  assert.ok(caps.indexOf('onoff') < caps.indexOf('dim'));
  assert.ok(caps.indexOf('dim') < caps.indexOf('light_hue'));
  assert.ok(caps.indexOf('light_temperature') < caps.indexOf('measure_power'));
});

test('light_mode est repris mais jamais réécrit vers la source', () => {
  assert.ok(plannedCapabilities(LIGHTSTRIP).includes('light_mode'));
  assert.ok(!writableCapabilities(LIGHTSTRIP).includes('light_mode'));
});

test('la mesure n’est jamais réécrite vers la source', () => {
  const writable = writableCapabilities(LIGHTSTRIP);
  for (const own of OWN_CAPABILITIES) assert.ok(!writable.includes(own));
});

test('les commandes réellement renvoyées à la lampe', () => {
  assert.deepEqual(writableCapabilities(LIGHTSTRIP), ['onoff', 'dim', 'light_hue', 'light_saturation', 'light_temperature']);
});

test('le diff ajoute ce qui manque et retire ce qui n’est plus mirroir', () => {
  const diff = capabilityDiff(['onoff', 'dim', 'light_hue', 'measure_power', 'meter_power'], plannedCapabilities(WHITE_BULB));
  assert.deepEqual(diff.add, []);
  assert.deepEqual(diff.remove, ['light_hue']);
});

test('measure_power et meter_power ne sont JAMAIS retirés', () => {
  // removeCapability détruit l'historique Insights, et le ré-ajout ne le restaure pas : retirer
  // ces deux-là effacerait tout l'historique de consommation, c'est-à-dire l'app entière.
  const diff = capabilityDiff(['onoff', 'measure_power', 'meter_power'], ['onoff']);
  assert.deepEqual(diff.remove, []);
});

test('le diff est vide quand tout est déjà en place', () => {
  const planned = plannedCapabilities(LIGHTSTRIP);
  const diff = capabilityDiff(planned, planned);
  assert.deepEqual(diff.add, []);
  assert.deepEqual(diff.remove, []);
});
