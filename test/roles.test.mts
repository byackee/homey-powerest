import test from 'node:test';
import assert from 'node:assert/strict';

import { energyRole, producedWatts } from '../lib/roles.mjs';

test('un compteur général est une entrée réseau', () => {
  assert.equal(energyRole({ cumulative: true, deviceClass: 'sensor' }), 'grid');
});

test('des panneaux sont une production, pas un usage', () => {
  assert.equal(energyRole({ cumulative: false, deviceClass: 'solarpanel' }), 'solar');
  assert.equal(energyRole({ cumulative: false, deviceClass: 'socket', virtualClass: 'solarpanel' }), 'solar');
});

test('le choix de l’utilisateur l’emporte', () => {
  // Un P1 que son app ne déclare pas comme compteur général.
  assert.equal(energyRole({ cumulative: false, deviceClass: 'sensor', override: 'source:grid' }), 'grid');
  assert.equal(energyRole({ cumulative: false, deviceClass: 'other', override: 'source:solar' }), 'solar');
  // Un usage choisi à la main ne fait pas d'une production ou d'un compteur une charge : il a pu
  // être posé avant cette version, quand les panneaux étaient rangés parmi les usages.
  assert.equal(energyRole({ cumulative: false, deviceClass: 'solarpanel', override: 'appliance' }), 'solar');
  assert.equal(energyRole({ cumulative: true, deviceClass: 'sensor', override: 'other' }), 'grid');
});

test('les deux conventions de signe de Homey donnent une production positive', () => {
  assert.equal(producedWatts(1800, 'solarpanel'), 1800);
  assert.equal(producedWatts(-1800, 'socket', 'solarpanel'), 1800);
  // La veille nocturne d'un onduleur ne produit rien.
  assert.equal(producedWatts(-4, 'solarpanel'), 0);
  assert.equal(producedWatts(4, 'socket', 'solarpanel'), 0);
  assert.equal(producedWatts(Number.NaN, 'solarpanel'), 0);
});
