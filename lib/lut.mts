/**
 * `lib/lut.mts` — les tables de mesures de la bibliothèque PowerCalc.
 *
 * Une LUT est un CSV mesuré au wattmètre sur une vraie lampe : `bri,mired,watt` pour le blanc,
 * `bri,hue,sat,watt` pour la couleur, `bri,watt` pour une lampe sans couleur. C'est ce qui
 * distingue cette app de l'approximation native de Homey, qui n'a qu'une valeur par appareil.
 *
 * Contrainte de taille, mesurée : `signify/LCA001` fait 24 787 lignes en `hs`. Stocker ça en
 * tableau d'objets JavaScript coûterait plusieurs mégaoctets par profil sur une Homey Pro. D'où
 * l'indexation en `Float32Array` par niveau de luminosité : ~400 ko pour le plus gros profil.
 */

import type { LightState, LutKind } from './types.mjs';
import { HS_HUE_MAX, HS_SAT_MAX } from './units.mjs';
import { ProfileError } from './types.mjs';

/** Nombre de colonnes de clé, hors watt, pour chaque type de table. */
const ARITY: Record<LutKind, number> = { brightness: 0, color_temp: 1, hs: 2 };

const HEADERS: Record<LutKind, string[]> = {
  brightness: ['bri', 'watt'],
  color_temp: ['bri', 'mired', 'watt'],
  hs: ['bri', 'hue', 'sat', 'watt'],
};

/** Un niveau de luminosité : toutes les mesures prises à ce `bri`. */
interface LutLevel {
  /** Clés secondaires aplaties, `arity` valeurs par mesure. Vide pour `brightness`. */
  keys: Float32Array;
  /** Watts, une valeur par mesure. */
  watts: Float32Array;
}

export class LutTable {
  private readonly levels = new Map<number, LutLevel>();
  /** Niveaux de `bri` présents, triés — support de l'interpolation. */
  private readonly briLevels: number[];

  private constructor(
    public readonly kind: LutKind,
    levels: Map<number, LutLevel>,
  ) {
    this.levels = levels;
    this.briLevels = [...levels.keys()].sort((a, b) => a - b);
  }

  public get size(): number {
    let n = 0;
    for (const level of this.levels.values()) n += level.watts.length;
    return n;
  }

  public get brightnessLevels(): readonly number[] {
    return this.briLevels;
  }

  /**
   * Analyse un CSV décompressé.
   *
   * Les lignes malformées sont ignorées plutôt que fatales : un profil de la bibliothèque peut
   * contenir une ligne tronquée sans que cela invalide les 24 000 autres.
   */
  public static parse(csv: string, kind: LutKind): LutTable {
    const arity = ARITY[kind];
    const expected = HEADERS[kind].length;
    const lines = csv.split('\n');

    // Accumulation en tableaux ordinaires, converties en Float32Array une fois la taille connue.
    const acc = new Map<number, { keys: number[]; watts: number[] }>();
    let seen = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line === undefined) continue;
      const trimmed = line.trim();
      if (trimmed === '') continue;
      // L'en-tête est repéré par son contenu, pas par sa position : certains fichiers ont un BOM.
      if (i === 0 || trimmed.startsWith('bri,')) continue;

      const parts = trimmed.split(',');
      if (parts.length !== expected) continue;

      const nums: number[] = [];
      let ok = true;
      for (const part of parts) {
        const value = Number(part);
        if (!Number.isFinite(value)) { ok = false; break; }
        nums.push(value);
      }
      if (!ok) continue;

      const bri = nums[0] as number;
      const watt = nums[expected - 1] as number;
      let bucket = acc.get(bri);
      if (!bucket) { bucket = { keys: [], watts: [] }; acc.set(bri, bucket); }
      for (let k = 1; k <= arity; k += 1) bucket.keys.push(nums[k] as number);
      bucket.watts.push(watt);
      seen += 1;
    }

    if (seen === 0) throw new ProfileError(`table ${kind} vide ou illisible`, 'malformed');

    const levels = new Map<number, LutLevel>();
    for (const [bri, bucket] of acc) {
      levels.set(bri, {
        keys: Float32Array.from(bucket.keys),
        watts: Float32Array.from(bucket.watts),
      });
    }
    return new LutTable(kind, levels);
  }

  /**
   * Puissance pour un état donné.
   *
   * Reproduit la démarche de PowerCalc : on encadre la luminosité demandée par les deux niveaux
   * mesurés les plus proches, on cherche dans chacun la mesure la plus proche sur les axes de
   * couleur, puis on interpole LINÉAIREMENT entre les deux sur la luminosité.
   *
   * L'interpolation ne porte que sur `bri`, jamais sur la couleur : les axes de couleur sont
   * échantillonnés assez finement pour que le plus proche voisin suffise, et interpoler sur une
   * teinte circulaire créerait des valeurs qui n'ont jamais été mesurées.
   */
  public lookup(state: LightState): number {
    // Une lampe non gradable est mesurée à son maximum.
    const bri = state.bri ?? (this.briLevels[this.briLevels.length - 1] as number);

    const { lo, hi } = this.bracket(bri);
    const wattLo = this.wattAt(lo, state);
    if (lo === hi) return wattLo;

    const wattHi = this.wattAt(hi, state);
    const span = hi - lo;
    const t = span === 0 ? 0 : (bri - lo) / span;
    return wattLo + (wattHi - wattLo) * t;
  }

  /** Les deux niveaux de luminosité mesurés qui encadrent `bri`, bornés aux extrémités. */
  private bracket(bri: number): { lo: number; hi: number } {
    const levels = this.briLevels;
    const first = levels[0] as number;
    const last = levels[levels.length - 1] as number;
    if (bri <= first) return { lo: first, hi: first };
    if (bri >= last) return { lo: last, hi: last };

    // Recherche dichotomique : les profils ont jusqu'à 51 niveaux, mais la recherche est appelée
    // à chaque changement de gradation de chaque lampe.
    let low = 0;
    let high = levels.length - 1;
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if ((levels[mid] as number) <= bri) low = mid;
      else high = mid;
    }
    return { lo: levels[low] as number, hi: levels[high] as number };
  }

  /** Mesure la plus proche sur les axes de couleur, à un niveau de luminosité donné. */
  private wattAt(bri: number, state: LightState): number {
    const level = this.levels.get(bri);
    if (!level) return 0;
    const watts = level.watts;
    if (watts.length === 0) return 0;

    const arity = ARITY[this.kind];
    if (arity === 0) return watts[0] as number;

    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    if (this.kind === 'color_temp') {
      const target = state.mired;
      if (target === undefined) return watts[0] as number;
      for (let i = 0; i < watts.length; i += 1) {
        const d = Math.abs((level.keys[i] as number) - target);
        if (d < bestDistance) { bestDistance = d; bestIndex = i; }
      }
    } else {
      const hue = state.hue;
      const sat = state.sat;
      if (hue === undefined || sat === undefined) return watts[0] as number;
      for (let i = 0; i < watts.length; i += 1) {
        const dh = circularDistance(level.keys[i * 2] as number, hue, HS_HUE_MAX);
        const ds = ((level.keys[i * 2 + 1] as number) - sat) / HS_SAT_MAX;
        // Les deux axes sont ramenés à 0..1 avant d'être comparés : sans ça, la teinte (0-65535)
        // écraserait complètement la saturation (0-255) dans la distance.
        const d = dh * dh + ds * ds;
        if (d < bestDistance) { bestDistance = d; bestIndex = i; }
      }
    }
    return watts[bestIndex] as number;
  }
}

/**
 * Distance entre deux teintes, normalisée dans 0..1.
 *
 * La teinte boucle : 0 et 65535 sont la même couleur (rouge). Une distance linéaire ferait croire
 * qu'un rouge à 65500 est à l'opposé d'un rouge à 30 et irait chercher la mesure d'un cyan.
 */
export function circularDistance(a: number, b: number, period: number): number {
  const raw = Math.abs(a - b) % period;
  return Math.min(raw, period - raw) / period;
}
