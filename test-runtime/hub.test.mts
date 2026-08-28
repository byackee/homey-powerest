/**
 * `runtime/hub.mts` — le module le plus risqué du projet, et le seul qui n'était pas couvert.
 *
 * PANNES EMPÊCHÉES :
 *  - l'abonnement mort. Une app tierce qui redémarre DÉTRUIT ses capabilities ; l'instance devient
 *    muette sans lever. Sans ré-abonnement, l'estimation d'une lampe se fige sur sa dernière
 *    valeur et plus rien ne bouge jusqu'au redémarrage de Homey — invisible, puisque l'appareil
 *    reste disponible et affiche un chiffre plausible ;
 *  - la rafale de `getDevices()`. Le quota d'Athom coupe TOUS les points d'entrée pendant vingt
 *    minutes après une cinquantaine d'appels rapprochés. Le plancher est la seule protection, et
 *    il est franchi par du code qui a l'air anodin ;
 *  - l'écriture avalée. `setDeviceSettings` est refusé aux apps (scope `homey.device`) : le refus
 *    doit remonter à l'appelant, pas être absorbé, sinon le double comptage passe inaperçu.
 *
 * Le paquet `homey-api` parle à un websocket : il est substitué AVANT l'import du hub.
 */

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { FakeApi, FakeDevice } from './fakes/api.mjs';
import { FakeHomey } from './fakes/homey.mjs';

/** L'API rendue par le prochain `createAppAPI`, et les échecs à lui faire subir avant. */
let current: FakeApi;
let startFailures = 0;

mock.module('homey-api', {
  namedExports: {
    HomeyAPI: {
      createAppAPI: async (): Promise<FakeApi> => {
        if (startFailures > 0) { startFailures -= 1; throw new Error('cloud indisponible'); }
        return current;
      },
    },
  },
});

const { HomeyApiHub } = await import('../runtime/hub.mjs');

function lamp(): FakeDevice {
  return new FakeDevice({
    id: 'lamp-1', name: 'Lampe salon',
    capabilities: ['onoff', 'dim'],
    values: { onoff: false, dim: 0.5 },
    settings: { Model_ID: 'LCT012', energy_exclude: false },
    energyObj: { cumulative: null, W: 6 },
    data: { id: 'estimate:src-1' },
  });
}

async function startedHub(devices: FakeDevice[]): Promise<InstanceType<typeof HomeyApiHub>> {
  current = new FakeApi(devices);
  const hub = new HomeyApiHub(new FakeHomey().asHomey(), {});
  await hub.start();
  return hub;
}

test('le hub se connecte avant de lire : sans connect(), les abonnements ne reçoivent rien', async () => {
  const hub = await startedHub([lamp()]);
  // `getDevices()` seul rend des appareils ORPHELINS : leurs `makeCapabilityInstance` ne
  // reçoivent jamais rien. C'est la panne la plus sournoise du module — l'app a l'air de marcher.
  assert.equal(current.devicesConnected, true, 'manager devices non connecté');
  assert.equal(current.zonesConnected, true, 'manager zones non connecté');
  assert.equal(hub.connected, true);
  hub.stop();
});

test('un démarrage impossible ne fait pas échouer l’app, il est réessayé', async () => {
  startFailures = 1;
  current = new FakeApi([lamp()]);
  const hub = new HomeyApiHub(new FakeHomey().asHomey(), {});
  await hub.start();
  // La Homey peut démarrer avant sa connexion : c'est un cas ORDINAIRE, pas une avarie.
  assert.equal(hub.connected, false, 'le hub ne doit pas se prétendre connecté');
  hub.stop();
  startFailures = 0;
});

test('le plancher anti-quota empêche la rafale de getDevices', async () => {
  const hub = await startedHub([lamp()]);
  const after = current.getDevicesCalls;
  for (let i = 0; i < 20; i += 1) await hub.refresh();
  assert.equal(current.getDevicesCalls, after, '20 rafraîchissements ont franchi le plancher');
  await hub.refresh(true);
  assert.equal(current.getDevicesCalls, after + 1, 'un rafraîchissement forcé doit passer');
  hub.stop();
});

test('l’état d’un appareil est restitué sans fuite de homey-api', async () => {
  const hub = await startedHub([lamp()]);
  const summary = hub.getDevice('lamp-1');
  assert.ok(summary);
  assert.equal(summary.name, 'Lampe salon');
  assert.equal(summary.zoneName, 'Salon');
  assert.equal(summary.hasPowerMeter, false);
  assert.equal(summary.approxWatts, 6, 'le forfait natif de Homey doit remonter');
  assert.equal(summary.energyExcluded, false);
  assert.equal(summary.dataId, 'estimate:src-1');
  assert.equal(summary.batteryPowered, false);
  hub.stop();
});

test('un abonnement détruit par l’app propriétaire est repris', async () => {
  const device = lamp();
  const hub = await startedHub([device]);
  const seen: unknown[] = [];
  hub.subscribe('lamp-1', 'onoff', (v) => seen.push(v));

  const first = device.latest('onoff');
  assert.ok(first, 'aucun abonnement créé');
  first.emit(true);
  assert.deepEqual(seen, [true]);

  // L'app Hue redémarre : elle détruit ses capabilities. L'instance devient muette sans lever.
  first.killFromOwner();
  await new Promise((r) => setTimeout(r, 6_200));

  const second = device.latest('onoff');
  assert.ok(second && second !== first, 'aucun ré-abonnement après destruction');
  second.emit(false);
  assert.deepEqual(seen, [true, false], 'le nouvel abonnement ne remonte rien');
  hub.stop();
});

test('un abonnement impossible est retenté au lieu d’être perdu', async () => {
  const device = lamp();
  device.failNextSubscribe = true;
  const hub = await startedHub([device]);
  hub.subscribe('lamp-1', 'onoff', () => {});
  assert.equal(device.instances.length, 0, 'le premier essai devait échouer');
  await new Promise((r) => setTimeout(r, 6_200));
  assert.equal(device.instances.length, 1, 'aucune reprise après un abonnement raté');
  hub.stop();
});

test('arrêter le hub coupe les abonnements : rien ne doit survivre à onUninit', async () => {
  const device = lamp();
  const hub = await startedHub([device]);
  hub.subscribe('lamp-1', 'onoff', () => {});
  const instance = device.latest('onoff');
  assert.ok(instance);
  hub.stop();
  assert.equal(instance.destroyed, true, 'abonnement laissé vivant après stop()');
  assert.equal(current.destroyed, true, 'client homey-api laissé vivant');
  assert.equal(hub.connected, false);
});

test('écrire une capability atteint bien l’appareil tiers', async () => {
  const device = lamp();
  const hub = await startedHub([device]);
  await hub.setCapability('lamp-1', 'onoff', true);
  assert.deepEqual(device.writes, [{ capabilityId: 'onoff', value: true }]);
  hub.stop();
});

test('écrire sur un appareil inconnu lève au lieu de se taire', async () => {
  const hub = await startedHub([lamp()]);
  await assert.rejects(() => hub.setCapability('fantome', 'onoff', true), /inconnu/);
  hub.stop();
});

test('le refus de setDeviceSettings remonte à l’appelant', async () => {
  // C'est le refus réel : scope `homey.device`, que les apps n'ont pas. L'absorber ferait passer
  // un double comptage pour un succès.
  const hub = await startedHub([lamp()]);
  current.settingsError = new Error('Missing Scopes');
  await assert.rejects(() => hub.setDeviceSettings('lamp-1', { energy_exclude: true }), /Missing Scopes/);
  current.settingsError = null;
  await hub.setDeviceSettings('lamp-1', { energy_exclude: true });
  assert.deepEqual(current.settingsWrites, [{ id: 'lamp-1', settings: { energy_exclude: true } }]);
  hub.stop();
});

test('un appareil sur pile est signalé comme tel', async () => {
  const battery = new FakeDevice({
    id: 'sensor-1', name: 'Détecteur', class: 'sensor',
    capabilities: ['alarm_motion', 'measure_battery'],
  });
  const hub = await startedHub([battery]);
  assert.equal(hub.getDevice('sensor-1')?.batteryPowered, true);
  hub.stop();
});

test('une reconnexion du socket relance un rafraîchissement', async () => {
  const hub = await startedHub([lamp()]);
  const before = current.getDevicesCalls;
  current.fire('reconnect');
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(current.getDevicesCalls > before, 'aucune relecture après reconnexion');
  hub.stop();
});
