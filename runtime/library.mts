/**
 * `runtime/library.mts` — l'accès à la bibliothèque de profils PowerCalc.
 *
 * La bibliothèque est publique et sans authentification : `GET https://api.powercalc.nl/library`
 * rend l'index complet (123 fabricants, 744 modèles, ~450 ko), et
 * `GET /download/{fabricant}/{modèle}` rend la liste des fichiers du profil avec leurs URL brutes.
 * Le tout est publié sous licence MIT par le projet homeassistant-powercalc.
 *
 * Rien n'est embarqué dans l'app : l'index seul pèse la moitié d'une app Homey, et les tables de
 * mesure de tous les modèles se comptent en dizaines de mégaoctets. Tout est donc téléchargé à la
 * demande et gardé dans `/userdata`, qui survit aux redémarrages mais pas à une désinstallation.
 *
 * Conséquence assumée : une Homey sans accès Internet ne peut pas ajouter un profil qu'elle n'a
 * jamais téléchargé. Elle continue en revanche à calculer avec ceux qu'elle a déjà.
 */

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

import { LibraryIndex, type LibraryModel } from '../lib/matching.mjs';
import { LutTable } from '../lib/lut.mjs';
import { ProfileError, type LutKind, type ProfileModel } from '../lib/types.mjs';
import { LUT_FILES, type LutTables } from '../lib/strategies.mjs';

const DEFAULT_BASE_URL = 'https://api.powercalc.nl';

/** `/userdata` est le seul répertoire inscriptible et persistant d'une app Homey. */
const DEFAULT_CACHE_DIR = '/userdata';

/**
 * Durée de validité de l'index en cache.
 *
 * La bibliothèque bouge de quelques modèles par semaine. Une semaine évite de retélécharger
 * 450 ko à chaque redémarrage de la Homey tout en récupérant les nouveaux profils sans que
 * l'utilisateur ait à intervenir.
 */
const INDEX_TTL_MS = 7 * 24 * 3_600_000;

/** Au-delà, on considère que la requête n'aboutira pas. Le téléchargement est réessayable. */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Profils gardés décodés en mémoire.
 *
 * Un profil couleur pèse ~400 ko une fois indexé en `Float32Array`. Douze profils tiennent dans
 * quelques mégaoctets, ce qui couvre un parc domestique entier ; au-delà on relit depuis le
 * disque, qui est local et rapide.
 */
const MEMORY_LIMIT = 12;

type Logger = (...args: unknown[]) => void;
type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface LibraryClientOptions {
  baseUrl?: string;
  cacheDir?: string;
  log?: Logger;
  error?: Logger;
  fetchImpl?: FetchLike;
}

/** Un profil prêt à calculer : son `model.json` et ses tables décodées. */
export interface LoadedProfile {
  ref: { manufacturer: string; model: string };
  model: ProfileModel;
  tables: LutTables;
}

export class LibraryClient {
  private readonly baseUrl: string;
  private readonly cacheDir: string;
  private readonly log: Logger;
  private readonly errorLog: Logger;
  private readonly fetchImpl: FetchLike;

  private index: LibraryIndex | null = null;
  private readonly memory = new Map<string, LoadedProfile>();
  /** Téléchargements en cours, pour que deux appareils du même modèle n'en lancent pas deux. */
  private readonly inflight = new Map<string, Promise<LoadedProfile>>();

  public constructor(options: LibraryClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
    this.log = options.log ?? (() => {});
    this.errorLog = options.error ?? (() => {});
    const impl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!impl) throw new ProfileError('aucune implémentation de fetch disponible', 'network');
    this.fetchImpl = impl;
  }

  /**
   * L'index de la bibliothèque.
   *
   * Le cache disque prime tant qu'il est frais. En cas d'échec réseau on ressert le cache PÉRIMÉ
   * plutôt que d'échouer : un index d'une semaine passée vaut infiniment mieux qu'une app qui ne
   * sait plus reconnaître aucun appareil parce que la box a perdu le Wi-Fi.
   */
  public async getIndex(force = false): Promise<LibraryIndex> {
    if (this.index && !force) return this.index;

    const file = path.join(this.cacheDir, 'library-index.json');
    if (!force) {
      const cached = await this.readCachedIndex(file);
      if (cached) { this.index = cached; return cached; }
    }

    try {
      const raw = await this.getJson(`${this.baseUrl}/library`);
      const index = LibraryIndex.fromIndexJson(raw);
      await this.writeCache(file, Buffer.from(JSON.stringify(raw), 'utf-8'));
      this.log(`bibliothèque à jour : ${index.size} modèles`);
      this.index = index;
      return index;
    } catch (err) {
      const stale = await this.readCachedIndex(file, true);
      if (stale) {
        this.errorLog('index indisponible, on repart du cache périmé', err);
        this.index = stale;
        return stale;
      }
      throw new ProfileError(`index inaccessible : ${describe(err)}`, 'network');
    }
  }

  /** Charge un profil, du cache mémoire, puis du disque, puis du réseau. */
  public async getProfile(model: LibraryModel): Promise<LoadedProfile> {
    const key = cacheKey(model.manufacturer, model.model);

    const hot = this.memory.get(key);
    if (hot) return hot;

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const task = this.loadProfile(model, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }

  private async loadProfile(model: LibraryModel, key: string): Promise<LoadedProfile> {
    const dir = path.join(this.cacheDir, 'profiles', key);
    const wanted = tablesToFetch(model);

    let modelJson = await this.readCachedJson(path.join(dir, 'model.json'));
    const buffers = new Map<LutKind, Buffer>();
    for (const kind of wanted) {
      const buf = await this.readCachedBuffer(path.join(dir, LUT_FILES[kind]));
      if (buf) buffers.set(kind, buf);
    }

    const complete = modelJson !== null && wanted.every((kind) => buffers.has(kind));
    if (!complete) {
      await this.download(model, dir, wanted, buffers);
      modelJson = await this.readCachedJson(path.join(dir, 'model.json'));
    }

    if (!modelJson) throw new ProfileError(`profil ${key} introuvable`, 'not_found');

    const tables: LutTables = {};
    for (const [kind, buf] of buffers) {
      try {
        tables[kind] = LutTable.parse(gunzipSync(buf).toString('utf-8'), kind);
      } catch (err) {
        // Une table illisible ne doit pas condamner le profil : les autres restent utilisables,
        // et `pickTable` saura se rabattre.
        this.errorLog(`table ${kind} de ${key} illisible`, err);
      }
    }

    const loaded: LoadedProfile = {
      ref: { manufacturer: model.manufacturer, model: model.model },
      model: modelJson as ProfileModel,
      tables,
    };
    this.remember(key, loaded);
    return loaded;
  }

  /** Récupère la liste des fichiers du profil puis n'aspire que ceux qui servent. */
  private async download(
    model: LibraryModel,
    dir: string,
    wanted: LutKind[],
    buffers: Map<LutKind, Buffer>,
  ): Promise<void> {
    const url = `${this.baseUrl}/download/${encodeURIComponent(model.manufacturer)}/${encodeURIComponent(model.model)}`;
    const listing = await this.getJson(url) as Array<{ path?: string; url?: string }> | null;
    if (!Array.isArray(listing) || listing.length === 0) {
      throw new ProfileError(`profil ${model.manufacturer}/${model.model} absent de la bibliothèque`, 'not_found');
    }

    const byPath = new Map<string, string>();
    for (const entry of listing) {
      if (typeof entry?.path === 'string' && typeof entry?.url === 'string') byPath.set(entry.path, entry.url);
    }

    const modelUrl = byPath.get('model.json');
    if (!modelUrl) throw new ProfileError(`profil ${model.manufacturer}/${model.model} sans model.json`, 'malformed');

    await this.writeCache(path.join(dir, 'model.json'), Buffer.from(await this.getBuffer(modelUrl)));

    for (const kind of wanted) {
      if (buffers.has(kind)) continue;
      const fileUrl = byPath.get(LUT_FILES[kind]);
      if (!fileUrl) continue;
      const buf = Buffer.from(await this.getBuffer(fileUrl));
      await this.writeCache(path.join(dir, LUT_FILES[kind]), buf);
      buffers.set(kind, buf);
    }
  }

  private remember(key: string, profile: LoadedProfile): void {
    if (this.memory.size >= MEMORY_LIMIT) {
      const oldest = this.memory.keys().next().value;
      if (typeof oldest === 'string') this.memory.delete(oldest);
    }
    this.memory.set(key, profile);
  }

  private async readCachedIndex(file: string, allowStale = false): Promise<LibraryIndex | null> {
    try {
      const info = await stat(file);
      if (!allowStale && Date.now() - info.mtimeMs > INDEX_TTL_MS) return null;
      const raw = JSON.parse(await readFile(file, 'utf-8')) as unknown;
      const index = LibraryIndex.fromIndexJson(raw);
      return index.size > 0 ? index : null;
    } catch {
      return null;
    }
  }

  private async readCachedJson(file: string): Promise<unknown | null> {
    try {
      return JSON.parse(await readFile(file, 'utf-8')) as unknown;
    } catch {
      return null;
    }
  }

  private async readCachedBuffer(file: string): Promise<Buffer | null> {
    try {
      return await readFile(file);
    } catch {
      return null;
    }
  }

  private async writeCache(file: string, data: Buffer): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  }

  private async getJson(url: string): Promise<unknown> {
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new ProfileError(`${url} → HTTP ${response.status}`, response.status === 404 ? 'not_found' : 'network');
    return response.json();
  }

  private async getBuffer(url: string): Promise<ArrayBuffer> {
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new ProfileError(`${url} → HTTP ${response.status}`, response.status === 404 ? 'not_found' : 'network');
    return response.arrayBuffer();
  }
}

/**
 * Tables à récupérer pour un modèle.
 *
 * L'index publie `color_modes`, donc on sait AVANT de télécharger quelles tables existent. Sans
 * cette information (profil ancien), on demande les trois : les absentes seront simplement
 * introuvables dans la liste de fichiers, sans erreur.
 */
export function tablesToFetch(model: LibraryModel): LutKind[] {
  if (model.strategy !== 'lut') return [];
  if (model.colorModes.length > 0) return model.colorModes;
  return ['brightness', 'color_temp', 'hs'];
}

/**
 * Nom de dossier sûr pour un couple fabricant/modèle.
 *
 * Les deux valeurs viennent de la bibliothèque distante, donc d'une source que l'app ne contrôle
 * pas, et servent à construire un chemin sous `/userdata`. Tout ce qui n'est pas alphanumérique
 * est réduit, et les points consécutifs sont écrasés : un segment `..` transformerait une écriture
 * de cache en écriture hors du répertoire de l'app.
 */
export function cacheKey(manufacturer: string, model: string): string {
  const clean = (value: string): string => value
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/\.{2,}/g, '_');
  return `${clean(manufacturer)}__${clean(model)}`;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
