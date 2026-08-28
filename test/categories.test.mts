import test from 'node:test';
import assert from 'node:assert/strict';

import { categorise, UNKNOWN_CATEGORY } from '../lib/categories.mjs';

test('les classes Homey courantes tombent dans une catégorie utile', () => {
  assert.equal(categorise('light').id, 'light');
  assert.equal(categorise('tv').id, 'media');
  assert.equal(categorise('settopbox').id, 'media');
  assert.equal(categorise('thermostat').id, 'climate');
  assert.equal(categorise('fan').id, 'climate');
  assert.equal(categorise('vacuumcleaner').id, 'appliance');
  assert.equal(categorise('camera').id, 'security');
});

test('le type du profil mesuré l’emporte sur la classe Homey', () => {
  // L'imprimante Epson est déclarée `sensor` par son app : sans cette priorité elle se
  // retrouverait parmi les capteurs de sécurité, pour quinze watts.
  assert.equal(categorise('sensor').id, 'security');
  assert.equal(categorise('sensor', 'printer').id, 'office');
  assert.equal(categorise('socket', 'ups').id, 'office');
});

test('une classe inconnue ne se range pas au jugé', () => {
  assert.equal(categorise('quelquechose').id, UNKNOWN_CATEGORY.id);
  assert.equal(categorise(null).id, UNKNOWN_CATEGORY.id);
  assert.equal(categorise(undefined, undefined).id, UNKNOWN_CATEGORY.id);
  assert.equal(categorise('socket').id, UNKNOWN_CATEGORY.id);
});

test('un device_type inconnu retombe sur la classe plutôt que d’échouer', () => {
  assert.equal(categorise('light', 'type_qui_nexiste_pas').id, 'light');
});

test('les catégories restent peu nombreuses', () => {
  const ids = new Set<string>();
  for (const cls of ['light', 'tv', 'thermostat', 'washingmachine', 'camera', 'socket', 'sensor', 'lock', 'fan']) {
    ids.add(categorise(cls).id);
  }
  // Au-delà de six ou sept branches, chacune devient trop fine pour porter son nom.
  assert.ok(ids.size <= 6, `trop de catégories : ${[...ids].join(', ')}`);
});
