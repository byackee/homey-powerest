import test from 'node:test';
import assert from 'node:assert/strict';

import { accumulate, initialMeter, restoreMeter, roundKwh, MAX_GAP_MS } from '../lib/energy.mjs';

const HOUR = 3_600_000;

test('une heure à 1000 W vaut 1 kWh', () => {
  // MAX_GAP_MS borne un seul pas : on avance par tranches pour couvrir l'heure entière.
  let meter = initialMeter(0, 1000);
  let now = 0;
  while (now < HOUR) {
    now += MAX_GAP_MS;
    meter = accumulate(meter, 1000, now);
  }
  assert.ok(Math.abs(meter.kwh - 1) < 1e-9, `attendu 1 kWh, obtenu ${meter.kwh}`);
});

test('l’intégration est à main gauche : la nouvelle puissance ne vaut pas rétroactivement', () => {
  const start = initialMeter(0, 0);
  // Éteinte pendant 10 min, puis allumée à 100 W : rien ne doit avoir été compté.
  const after = accumulate(start, 100, 600_000);
  assert.equal(after.kwh, 0);
  assert.equal(after.lastW, 100);
});

test('le compteur ne recule jamais', () => {
  let meter = initialMeter(0, 50);
  const samples = [10_000, 20_000, 30_000, 40_000];
  let previous = 0;
  for (const ts of samples) {
    meter = accumulate(meter, 50, ts);
    assert.ok(meter.kwh >= previous, 'régression : le compteur a reculé');
    previous = meter.kwh;
  }
});

test('une horloge qui recule ne retire pas d’énergie', () => {
  const meter = accumulate({ kwh: 5, lastTs: 100_000, lastW: 200 }, 200, 50_000);
  assert.equal(meter.kwh, 5);
  assert.equal(meter.lastTs, 50_000);
});

test('un trou trop long n’est pas extrapolé', () => {
  const twelveHours = 12 * HOUR;
  const meter = accumulate({ kwh: 0, lastTs: 0, lastW: 1000 }, 1000, twelveHours);
  const capped = (1000 * MAX_GAP_MS) / 3_600_000_000;
  assert.ok(Math.abs(meter.kwh - capped) < 1e-12, `attendu ${capped}, obtenu ${meter.kwh}`);
  assert.ok(meter.kwh < 0.3, 'douze heures de courant fictif se seraient vues ici');
});

test('une puissance absurde est traitée comme nulle', () => {
  const meter = accumulate(initialMeter(0, 0), Number.NaN, 60_000);
  assert.equal(meter.lastW, 0);
  const negative = accumulate(initialMeter(0, 0), -40, 60_000);
  assert.equal(negative.lastW, 0);
});

test('restoreMeter refuse ce qui casserait la monotonie', () => {
  assert.equal(restoreMeter(null, 42).kwh, 0);
  assert.equal(restoreMeter({ kwh: Number.NaN, lastTs: 1, lastW: 1 }, 42).kwh, 0);
  assert.equal(restoreMeter({ kwh: -3, lastTs: 1, lastW: 1 }, 42).kwh, 0);
  const good = restoreMeter({ kwh: 12.5, lastTs: 7, lastW: 30 }, 42);
  assert.equal(good.kwh, 12.5);
  assert.equal(good.lastTs, 7);
});

test('restoreMeter garde le cumul mais répare un horodatage absent', () => {
  const restored = restoreMeter({ kwh: 3 }, 999);
  assert.equal(restored.kwh, 3);
  assert.equal(restored.lastTs, 999);
  assert.equal(restored.lastW, 0);
});

test('roundKwh s’arrête au Wh', () => {
  assert.equal(roundKwh(1.23456), 1.235);
});
