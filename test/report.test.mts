import test from 'node:test';
import assert from 'node:assert/strict';

import {
  floorFor, isoDate, isoWeek, isPeriod, reportToFlowDevices, reportTotals,
  type DeviceContext, type EnergyReport,
} from '../lib/report.mjs';
import { buildSankey, UNMEASURED_ID } from '../lib/sankey.mjs';

/**
 * Un extrait FIDÈLE d'un `getReportDay` relevé sur une Homey Pro le 3 septembre 2026.
 *
 * Les chiffres ne sont pas inventés : c'est ce qui permet au test de vérifier l'arithmétique
 * réelle — 5,36 + 3,62 = 8,98 importés, 7,591 attribués, donc 1,389 kWh que rien n'explique.
 */
const REPORT: EnergyReport = {
  electricity: {
    importedPeriod: 8.98,
    consumedPeriod: 7.591,
    importedPrice: 1.191646,
    devices: {
      imported: {
        linky: { name: 'Linky', total: 126.74, period: 5.36, price: 0.711272 },
        zlinky: { name: 'ZLinky_TIC', total: 37217.08, period: 3.62, price: 0.480374 },
        // Un compteur de GAZ, listé dans l'électricité avec une période nulle. Il ne doit pas
        // devenir un appareil électrique à zéro : il n'appartient pas à ce diagramme.
        gazpar: { name: 'Gazpar', total: null, period: null, price: null },
      },
      consumed: {
        nas: { name: 'Ugreen NAS', total: 1.261, period: 1.261, price: 0.167348, approximatedEnergy: true },
        lampe: { name: 'Lampe salon', total: 4.33, period: 4.33, price: 0.574 },
        borne: { name: 'U7 Pro', total: 0, period: 0, price: 0, approximatedEnergy: true },
        four: { name: 'Four', total: 2, period: 2, price: 0.265 },
      },
    },
  },
};

const CONTEXT: Record<string, DeviceContext> = {
  nas: { zoneName: 'Bureau', deviceClass: 'other' },
  lampe: { zoneName: 'Salon', deviceClass: 'light' },
  four: { zoneName: 'Cuisine', deviceClass: 'oven', categoryOverride: 'kitchen' },
};

const lookup = (id: string): DeviceContext | null => CONTEXT[id] ?? null;

test('les compteurs deviennent des sources, les appareils des charges', () => {
  const devices = reportToFlowDevices(REPORT, lookup);
  const mains = devices.filter((d) => d.cumulative).map((d) => d.id).sort();
  const loads = devices.filter((d) => !d.cumulative).map((d) => d.id).sort();
  assert.deepEqual(mains, ['linky', 'zlinky']);
  assert.deepEqual(loads, ['four', 'lampe', 'nas']);
});

test('une période nulle ou à zéro écarte l’entrée au lieu de la compter pour rien', () => {
  const ids = reportToFlowDevices(REPORT, lookup).map((d) => d.id);
  // `Gazpar` n'a pas de période, `U7 Pro` en a une à zéro : ni l'un ni l'autre n'a sa place ici.
  assert.ok(!ids.includes('gazpar'));
  assert.ok(!ids.includes('borne'));
});

test('le drapeau d’approximation vient de Homey, pas d’une déduction', () => {
  const devices = reportToFlowDevices(REPORT, lookup);
  const nas = devices.find((d) => d.id === 'nas');
  const lampe = devices.find((d) => d.id === 'lampe');
  assert.equal(nas?.approximated, true);
  assert.equal(lampe?.approximated, false);
});

test('la pièce et l’usage viennent de l’app, que le rapport ignore', () => {
  const devices = reportToFlowDevices(REPORT, lookup);
  const four = devices.find((d) => d.id === 'four');
  assert.equal(four?.zoneName, 'Cuisine');
  assert.equal(four?.deviceClass, 'oven');
  assert.equal(four?.categoryOverride, 'kitchen');
  // Un appareil que l'app ne connaît pas garde son nom et perd seulement ses niveaux.
  const linky = devices.find((d) => d.id === 'linky');
  assert.equal(linky?.name, 'Linky');
  assert.equal(linky?.zoneName, null);
});

test('les totaux du rapport sont relayés tels quels', () => {
  assert.deepEqual(reportTotals(REPORT), { imported: 8.98, consumed: 7.591, cost: 1.191646 });
  assert.deepEqual(reportTotals({}), { imported: null, consumed: null, cost: null });
});

test('le diagramme d’une période retrouve le non-mesuré du rapport', () => {
  const model = buildSankey(reportToFlowDevices(REPORT, lookup), { minWatts: floorFor('day') });
  // Le total est celui des compteurs, pas la somme des appareils.
  assert.equal(model.total, 8.98);
  assert.equal(model.partial, false);
  // 8,98 − (1,261 + 4,33 + 2) = 1,389. C'est le chiffre que le widget doit afficher.
  assert.ok(Math.abs(model.unmeasured - 1.389) < 0.002, `non mesuré = ${model.unmeasured}`);
  assert.ok(model.nodes.some((n) => n.id === UNMEASURED_ID));
});

test('le plancher suit la période : celui des watts effacerait la journée', () => {
  // Un appareil à 30 Wh dans la journée est parfaitement réel ; le plancher instantané de 0,05 W
  // le supprimerait, ce qui est exactement le défaut que `floorFor` existe pour empêcher.
  assert.ok(floorFor('day') < 0.03);
  assert.ok(floorFor('day') < floorFor('week'));
  assert.ok(floorFor('week') < floorFor('month'));
  assert.ok(floorFor('month') < floorFor('year'));
});

test('les périodes reconnues sont exactement celles de la Web API', () => {
  assert.ok(isPeriod('live') && isPeriod('day') && isPeriod('week'));
  assert.ok(isPeriod('month') && isPeriod('year'));
  assert.ok(!isPeriod('hour'));
  assert.ok(!isPeriod(''));
  assert.ok(!isPeriod(undefined));
});

test('la semaine ISO suit le jeudi, pas le 1er janvier', () => {
  // Le 1er janvier 2027 est un vendredi : il appartient à la semaine 53 de 2026. Une conversion
  // naïve demanderait `2027-W01`, une semaine qui ne contient pas ce jour.
  assert.equal(isoWeek(new Date(2027, 0, 1)), '2026-W53');
  assert.equal(isoWeek(new Date(2026, 8, 3)), '2026-W36');
});

test('la date part en heure locale, comme les rapports de Homey', () => {
  // Un `toISOString()` bascule sur la veille pour tout fuseau à l'est de Greenwich en soirée.
  assert.equal(isoDate(new Date(2026, 8, 3, 23, 30)), '2026-09-03');
  assert.equal(isoDate(new Date(2026, 0, 9)), '2026-01-09');
});

test('des panneaux listés comme appareil deviennent une production, pas un usage', () => {
  const report: EnergyReport = {
    electricity: {
      devices: {
        imported: { p1: { name: 'P1', period: 3 } },
        consumed: {
          pv: { name: 'Onduleur', period: 12 },
          four: { name: 'Four', period: 2 },
        },
      },
    },
  };
  const context = (id: string): DeviceContext | null =>
    id === 'pv' ? { zoneName: 'Garage', deviceClass: 'solarpanel' } : null;
  const devices = reportToFlowDevices(report, context);
  const pv = devices.find((d) => d.id === 'pv');
  assert.equal(pv?.solar, true);
  assert.equal(pv?.cumulative, false);

  // Le rapport ne donne pas l'export : le non-mesuré l'avoue.
  const m = buildSankey(devices, { exportKnown: false });
  assert.equal(m.balance.exported, null);
  assert.equal(m.total, 15);
  assert.equal(m.unmeasuredMayIncludeExport, true);
});

test('un compteur désigné à la main entre comme réseau', () => {
  const report: EnergyReport = { electricity: { devices: { consumed: { p1: { name: 'P1', period: 4 } } } } };
  const devices = reportToFlowDevices(report, () => ({ zoneName: null, categoryOverride: 'source:grid' }));
  assert.equal(devices[0]?.cumulative, true);
});
