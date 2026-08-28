import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LANGS = ['en', 'fr', 'nl'] as const;

function load(lang: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(ROOT, 'locales', `${lang}.json`), 'utf-8')) as Record<string, unknown>;
}

/** Toutes les clés, aplaties : `pair.warn_manual` plutôt qu'un objet imbriqué. */
function keys(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [prefix];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

test('les trois langues portent exactement les mêmes clés', () => {
  // Une clé absente ne casse rien à l'exécution : elle affiche la clé brute, ou pire, laisse une
  // chaîne écrite en dur dans une autre langue. Les deux se voient seulement à l'usage.
  const reference = new Set(keys(load('en')));
  for (const lang of LANGS.filter((l) => l !== 'en')) {
    const current = new Set(keys(load(lang)));
    const missing = [...reference].filter((k) => !current.has(k));
    const extra = [...current].filter((k) => !reference.has(k));
    assert.deepEqual(missing, [], `${lang} : clés manquantes`);
    assert.deepEqual(extra, [], `${lang} : clés en trop`);
  }
});

test('aucune traduction n’est vide', () => {
  for (const lang of LANGS) {
    const flat = load(lang);
    const walk = (v: unknown, p: string): void => {
      if (typeof v === 'string') {
        assert.notEqual(v.trim(), '', `${lang} : ${p} est vide`);
        return;
      }
      if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, p ? `${p}.${k}` : k);
      }
    };
    walk(flat, '');
  }
});

test('l’anglais ne contient pas de français oublié', () => {
  // Le vrai risque de cette app : le français était la langue de développement, et il s'est
  // installé dans les widgets, les catégories, la page de réglages et la vue d'appairage.
  const walk = (v: unknown, p: string): void => {
    if (typeof v === 'string') {
      assert.ok(!/[éèêàùçîôûÉÈÀÇ]/.test(v), `en : ${p} contient un accent français — « ${v.slice(0, 50)} »`);
      return;
    }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, p ? `${p}.${k}` : k);
    }
  };
  walk(load('en'), '');
});

test('les clés utilisées par les vues existent bien', () => {
  // Les vues appellent `Homey.__('pair.x')` : une clé inventée ne lèverait pas, elle afficherait
  // son propre nom à l'écran.
  const used = [
    'pair.note', 'pair.refresh', 'pair.estimable', 'pair.without_meter', 'pair.creating',
    'pair.failed', 'pair.error', 'pair.loading', 'pair.lib_unavailable', 'pair.no_profile_line',
    'pair.via', 'pair.already_counted',
    'pair.warn_manual', 'pair.warn_always_on', 'pair.warn_self_usage',
    'pair.warn_sub_profiles', 'pair.warn_unconfirmed',
    'settings.status', 'settings.connection', 'settings.library', 'settings.estimable',
    'settings.reload', 'settings.usages_title', 'settings.usages_note', 'settings.powered_note',
    'settings.log', 'settings.connected', 'settings.waiting', 'settings.unavailable',
    'settings.loading', 'settings.models', 'settings.of', 'settings.auto', 'settings.powered_by',
    'settings.nothing', 'settings.error', 'settings.flat_rate',
    'widget.identified', 'widget.unmeasured', 'widget.no_estimate', 'widget.double_counted',
    'category.light', 'category.unmeasured', 'device.exclude_manually',
  ];
  const available = new Set(keys(load('en')));
  for (const key of used) assert.ok(available.has(key), `clé absente des locales : ${key}`);
});

test('le marqueur __watts__ survit dans les trois langues', () => {
  for (const lang of LANGS) {
    const pair = (load(lang) as { pair: Record<string, string> }).pair;
    assert.ok(pair['already_counted']?.includes('__watts__'),
      `${lang} : le marqueur a disparu, le message afficherait une phrase sans chiffre`);
  }
});
