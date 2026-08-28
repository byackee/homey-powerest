import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clamp, dimToBri, temperatureToMired, hueToLutScale, saturationToLutScale, toLightState,
  HS_HUE_MAX, HS_SAT_MAX, DEFAULT_MIN_MIRED, DEFAULT_MAX_MIRED,
} from '../lib/units.mjs';

test('dimToBri couvre la plage de la bibliothèque', () => {
  assert.equal(dimToBri(0), 1, 'bri = 0 n’existe pas dans les tables mesurées');
  assert.equal(dimToBri(1), 255);
  assert.equal(dimToBri(0.5), 128);
  assert.equal(dimToBri(-5), 1, 'une valeur hors bornes ne doit pas sortir de la plage');
  assert.equal(dimToBri(Number.NaN), 1);
});

test('temperatureToMired va dans le même sens que Homey', () => {
  // 0 = le plus froid côté Homey, et le mired le plus BAS est le plus froid.
  assert.equal(temperatureToMired(0), DEFAULT_MIN_MIRED);
  assert.equal(temperatureToMired(1), DEFAULT_MAX_MIRED);
  assert.ok(temperatureToMired(0.2) < temperatureToMired(0.8));
});

test('temperatureToMired accepte une plage inversée sans se retourner', () => {
  assert.equal(temperatureToMired(0, 500, 153), 153);
  assert.equal(temperatureToMired(1, 500, 153), 500);
});

test('la teinte et la saturation sortent à l’échelle des tables, pas en degrés', () => {
  assert.equal(hueToLutScale(1), HS_HUE_MAX);
  assert.equal(saturationToLutScale(1), HS_SAT_MAX);
  assert.equal(hueToLutScale(0.5), HS_HUE_MAX / 2);
  assert.notEqual(hueToLutScale(1), 360, 'régression : conversion en degrés');
});

test('clamp neutralise NaN', () => {
  assert.equal(clamp(Number.NaN, 3, 9), 3);
  assert.equal(clamp(12, 3, 9), 9);
});

test('toLightState éteint ne rapporte aucune couleur', () => {
  const state = toLightState({ onoff: false, dim: 0.8, light_temperature: 0.5 });
  assert.equal(state.on, false);
  assert.equal(state.bri, undefined);
  assert.equal(state.mired, undefined);
});

test('light_mode arbitre entre couleur et blanc', () => {
  const caps = { onoff: true, dim: 1, light_temperature: 0.5, light_hue: 0.25, light_saturation: 1 };

  const colour = toLightState({ ...caps, light_mode: 'color' });
  assert.equal(colour.hue, HS_HUE_MAX * 0.25);
  assert.equal(colour.mired, undefined, 'en mode couleur, la table blanc ne doit pas être visée');

  const white = toLightState({ ...caps, light_mode: 'temperature' });
  assert.ok(white.mired !== undefined);
  assert.equal(white.hue, undefined);
});

test('sans light_mode, la température prime quand elle existe', () => {
  const state = toLightState({ onoff: true, dim: 1, light_temperature: 0.3, light_hue: 0.5, light_saturation: 0.5 });
  assert.ok(state.mired !== undefined);
  assert.equal(state.hue, undefined);
});

test('une lampe couleur seule reste exploitable sans light_mode', () => {
  const state = toLightState({ onoff: true, dim: 1, light_hue: 0.5, light_saturation: 0.5 });
  assert.equal(state.hue, HS_HUE_MAX * 0.5);
  assert.equal(state.sat, HS_SAT_MAX * 0.5);
});
