import test from 'node:test';
import assert from 'node:assert/strict';

import { computePower, interpolate, parseCalibration, pickTable } from '../lib/strategies.mjs';
import { LutTable } from '../lib/lut.mjs';
import type { ProfileModel } from '../lib/types.mjs';

const FIXED: ProfileModel = {
  name: 'Prise',
  calculation_strategy: 'fixed',
  standby_power: 0.3,
  fixed_config: { power: 9 },
};

test('éteint, seule la veille compte', () => {
  const result = computePower(FIXED, {}, { on: false });
  assert.equal(result.watts, 0.3);
  assert.equal(result.via, 'standby');
});

test('un profil sans standby déclaré ne fabrique pas de veille', () => {
  const model: ProfileModel = { ...FIXED, standby_power: undefined };
  assert.equal(computePower(model, {}, { on: false }).watts, 0);
});

test('la consommation propre s’ajoute à la charge', () => {
  const model: ProfileModel = { ...FIXED, standby_power_on: 1.5 };
  assert.equal(computePower(model, {}, { on: true }).watts, 10.5);
});

test('linear interpole entre min_power et max_power', () => {
  const model: ProfileModel = {
    name: 'Variateur', calculation_strategy: 'linear',
    linear_config: { min_power: 2, max_power: 10 },
  };
  assert.equal(computePower(model, {}, { on: true, bri: 1 }).watts, 2);
  assert.equal(computePower(model, {}, { on: true, bri: 255 }).watts, 10);
  assert.equal(computePower(model, {}, { on: true, bri: 128 }).watts, 6);
});

test('calibrate prime sur min/max : c’est la donnée mesurée', () => {
  const model: ProfileModel = {
    name: 'Variateur', calculation_strategy: 'linear',
    linear_config: { min_power: 0, max_power: 100, calibrate: ['1 -> 1', '255 -> 5'] },
  };
  assert.equal(computePower(model, {}, { on: true, bri: 255 }).watts, 5);
});

test('parseCalibration ignore les entrées illisibles et trie', () => {
  assert.deepEqual(parseCalibration(['255 -> 5', 'n’importe quoi', '1 -> 1']), [[1, 1], [255, 5]]);
  assert.deepEqual(parseCalibration(undefined), []);
});

test('interpolate est bornée aux extrémités', () => {
  const points: Array<[number, number]> = [[0, 0], [10, 10]];
  assert.equal(interpolate(points, -5), 0);
  assert.equal(interpolate(points, 15), 10);
  assert.equal(interpolate(points, 5), 5);
});

test('une stratégie non gérée échoue franchement', () => {
  const model: ProfileModel = { name: 'X', calculation_strategy: 'composite' };
  assert.throws(() => computePower(model, {}, { on: true }), /non gérée/);
});

test('un profil fixed sans puissance exploitable échoue au lieu d’inventer', () => {
  const model: ProfileModel = { name: 'X', calculation_strategy: 'fixed', fixed_config: {} };
  assert.throws(() => computePower(model, {}, { on: true }), /puissance exploitable/);
});

test('states_power sert de repli quand power est absent', () => {
  const model: ProfileModel = {
    name: 'TV', calculation_strategy: 'fixed',
    fixed_config: { states_power: { playing: 60, idle: 12 } },
  };
  assert.equal(computePower(model, {}, { on: true }).watts, 60);
});

const white = LutTable.parse('bri,mired,watt\n1,153,1\n255,153,9\n', 'color_temp');
const colour = LutTable.parse('bri,hue,sat,watt\n1,0,0,2\n255,0,0,12\n', 'hs');
const plain = LutTable.parse('bri,watt\n1,3\n255,7\n', 'brightness');

test('une lampe en mode couleur va sur la table couleur', () => {
  const picked = pickTable({ hs: colour, color_temp: white }, { on: true, bri: 255, hue: 0, sat: 0 });
  assert.equal(picked?.kind, 'hs');
});

test('une lampe en mode blanc va sur la table blanc', () => {
  const picked = pickTable({ hs: colour, color_temp: white }, { on: true, bri: 255, mired: 153 });
  assert.equal(picked?.kind, 'color_temp');
});

test('sans axe de couleur, la table brightness suffit', () => {
  const picked = pickTable({ brightness: plain }, { on: true, bri: 128 });
  assert.equal(picked?.kind, 'brightness');
});

test('aucune table utilisable est une erreur, pas un zéro silencieux', () => {
  const model: ProfileModel = { name: 'L', calculation_strategy: 'lut' };
  assert.throws(() => computePower(model, {}, { on: true, bri: 100 }), /aucune table/);
});

test('un profil fixed sans fixed_config tire sa puissance de standby_power_on', () => {
  // Cas réel de la bibliothèque : eq-3/HmIP-DRSI1, neo-coolcam/NAS-WR01Z.
  const model: ProfileModel = {
    name: 'Module', calculation_strategy: 'fixed',
    standby_power: 0.2, standby_power_on: 0.58, only_self_usage: true,
  };
  assert.equal(computePower(model, {}, { on: true }).watts, 0.58);
  assert.equal(computePower(model, {}, { on: false }).watts, 0.2);
});
