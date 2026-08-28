import test from 'node:test';
import assert from 'node:assert/strict';

import { CATEGORIES, categorise, categoryById, UNKNOWN_CATEGORY } from '../lib/categories.mjs';

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

test('le choix explicite de l’utilisateur l’emporte sur tout', () => {
  // Le cas qui motive ce réglage : un onduleur que Homey ne sait pas nommer, et qui pèse 100 W.
  assert.equal(categorise('other', null, 'office').id, 'office');
  assert.equal(categorise('light', 'light', 'appliance').id, 'appliance');
  assert.equal(categorise('sensor', 'printer', 'media').id, 'media');
});

test('une surcharge vide ou fantaisiste ne casse pas le rangement automatique', () => {
  assert.equal(categorise('light', null, '').id, 'light');
  assert.equal(categorise('light', null, null).id, 'light');
  assert.equal(categorise('light', null, 'pas_une_categorie').id, 'light');
  assert.equal(categorise('sensor', 'printer', undefined).id, 'office');
});

test('le menu ne propose que des usages que le modèle connaît', () => {
  for (const c of CATEGORIES) {
    assert.equal(categoryById(c.id)?.id, c.id);
    assert.equal(categorise('light', null, c.id).id, c.id, `${c.id} n'est pas applicable`);
  }
  assert.equal(categoryById('inexistant'), null);
});

test('les libellés de repli sont en anglais, pas en français', () => {
  // Ils ne sont affichés que si une clé de traduction manque : une clé brute à l'écran est pire,
  // mais du français pour un utilisateur néerlandais l'est tout autant. C'est ce qui existait.
  for (const c of CATEGORIES) {
    assert.ok(!/[éèêàçÉÈÀÇ]/.test(c.label), `${c.id} : « ${c.label} » n'est pas de l'anglais`);
  }
});

test('chaque catégorie a un identifiant utilisable comme clé de traduction', () => {
  for (const c of CATEGORIES) {
    assert.match(c.id, /^[a-z_]+$/, `${c.id} ne convient pas à une clé de locale`);
  }
});
