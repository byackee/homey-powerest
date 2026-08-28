import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LibraryIndex, isSelfUsageOnly, matchDevice, modelCandidates, manufacturerHints, normalise, type DeviceIdentity } from '../lib/matching.mjs';
import { tablesToFetch, cacheKey } from '../runtime/library.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures');
const index = LibraryIndex.fromIndexJson(
  JSON.parse(readFileSync(path.join(FIXTURES, 'library-index.json'), 'utf-8')) as unknown,
);

/** Une ampoule Hue telle que l'app Philips Hue la publie réellement sur Homey. */
const hueBulb: DeviceIdentity = {
  id: 'aaa', name: 'Lampe commode', class: 'light',
  capabilities: ['onoff', 'dim', 'light_hue', 'light_saturation', 'light_temperature'],
  driverId: 'homey:app:nl.philips.hue:bulb',
  settings: { Model_ID: 'LCT012', energy_value_off: 0.4, energy_value_on: 6 },
};

test('l’index se construit depuis la forme réelle de l’API', () => {
  assert.ok(index.size >= 5, `index vide ou tronqué : ${index.size}`);
});

test('une Hue est reconnue par son Model_ID, fabricant confirmé', () => {
  const match = matchDevice(index, hueBulb);
  assert.ok(match, 'aucune correspondance');
  assert.equal(match.model.manufacturer, 'signify');
  assert.equal(match.model.model, 'LCT012');
  assert.equal(match.via, 'Model_ID');
  // « philips » vient du driverId et figure dans les alias de signify.
  assert.equal(match.manufacturerConfirmed, true);
});

test('l’index publie les tables disponibles, ce qui évite de deviner', () => {
  const match = matchDevice(index, hueBulb);
  assert.ok(match);
  const tables = tablesToFetch(match.model);
  assert.ok(tables.length > 0);
  assert.ok(tables.every((t) => ['brightness', 'color_temp', 'hs'].includes(t)));
});

test('un modèle inconnu ne fabrique pas de correspondance', () => {
  const unknown: DeviceIdentity = { ...hueBulb, settings: { Model_ID: 'PAS-UN-MODELE' } };
  assert.equal(matchDevice(index, unknown), null);
});

test('un appareil sans réglage identifiant reste sans profil', () => {
  const nameless: DeviceIdentity = { ...hueBulb, settings: null };
  assert.equal(matchDevice(index, nameless), null);
});

test('une référence double de Zigbee2MQTT est coupée en deux candidats', () => {
  const device: DeviceIdentity = {
    id: 'b', name: 'Module', class: 'light', capabilities: ['onoff', 'dim'],
    driverId: 'homey:app:com.gruijter.zigbee2mqtt:device',
    settings: { model: 'ICPSHC24-10EU-IL-1/ICPSHC24-10EU-IL-2' },
  };
  const values = modelCandidates(device).map((c) => c.value);
  assert.ok(values.includes('ICPSHC24-10EU-IL-1/ICPSHC24-10EU-IL-2'));
  assert.ok(values.includes('ICPSHC24-10EU-IL-1'));
  assert.ok(values.includes('ICPSHC24-10EU-IL-2'));
});

test('un modèle avec espace est retrouvé (innr SP 120)', () => {
  const plug: DeviceIdentity = {
    id: 'c', name: 'Pipistrello', class: 'light', capabilities: ['onoff'],
    driverId: 'homey:app:nl.innr:plug', settings: { Model_ID: 'SP 120' },
  };
  const match = matchDevice(index, plug);
  assert.ok(match, 'SP 120 non retrouvé');
  assert.equal(match.model.manufacturer, 'innr');
});

test('les indices de fabricant écartent les segments inutiles du driverId', () => {
  const hints = manufacturerHints(hueBulb);
  assert.ok(hints.includes('philips'));
  assert.ok(!hints.includes('app'));
  assert.ok(!hints.includes('homey'));
});

test('normalise rend la comparaison insensible à la casse et aux séparateurs', () => {
  assert.equal(normalise('Signify Netherlands B.V.'), 'signify netherlands b.v.'.replace(/[\s_-]+/g, ''));
  assert.equal(normalise('LCT-012'), normalise('lct012'));
});

test('cacheKey ne produit jamais de chemin surprenant', () => {
  assert.equal(cacheKey('signify', 'SP 120'), 'signify__SP_120');
  assert.ok(!cacheKey('a/b', '../evil').includes('/'));
  assert.ok(!cacheKey('a/b', '../evil').includes('..'));
});

test('un profil non-LUT ne télécharge aucune table', () => {
  const fixedModel = index.lookup('SP 120')[0];
  assert.ok(fixedModel);
  assert.equal(fixedModel.strategy, 'fixed');
  assert.deepEqual(tablesToFetch(fixedModel), []);
});

test('les profils de prises et de variateurs sont signalés comme conso propre seule', () => {
  // Cas réel : innr/SP 120 porte only_self_usage et vaut 0,6 W — la prise, pas la lampe.
  assert.equal(isSelfUsageOnly('smart_switch'), true);
  assert.equal(isSelfUsageOnly('smart_dimmer'), true);
  assert.equal(isSelfUsageOnly('ups'), true);
  assert.equal(isSelfUsageOnly('light'), false);
  assert.equal(isSelfUsageOnly(null), false);
  assert.equal(isSelfUsageOnly(undefined), false);
});

test('le profil innr SP 120 de la fixture est bien de ce type', () => {
  const plug = index.lookup('SP 120')[0];
  assert.ok(plug);
  assert.equal(isSelfUsageOnly(plug.deviceType), true);
});
