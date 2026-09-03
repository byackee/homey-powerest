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
import { ProfileError, type LutKind, type ProfileModel, type Strategy } from '../lib/types.mjs';
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

/**
 * Ce que l'index ne dit plus, et qu'il faut aller chercher dans le profil lui-même.
 *
 * Depuis 2026, `api.powercalc.nl/library` ne publie plus ni `calculation_strategy`, ni
 * `color_modes`, ni `sub_profile_count`. Ces trois informations existent toujours, mais ailleurs :
 * la stratégie et les sous-profils dans `model.json`, les tables disponibles dans la LISTE DE
 * FICHIERS du profil — laquelle est plus fiable que l'ancien `color_modes`, puisqu'elle décrit ce
 * qui est réellement téléchargeable plutôt que ce qui est déclaré.
 *
 * La méta est mise en cache sur disque à côté du profil : sans elle, une Homey redémarrée hors
 * ligne ne saurait plus quelles tables elle est censée avoir, et retéléchargerait sans fin.
 */
export interface ProfileMeta {
  strategy: Strategy;
  tables: LutKind[];
  hasSubProfiles: boolean;
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
  private readonly metaMemory = new Map<string, ProfileMeta>();
  private readonly metaInflight = new Map<string, Promise<ProfileMeta>>();
  /**
   * Listes de fichiers déjà demandées, par profil.
   *
   * La méta et le téléchargement des tables en ont besoin l'une après l'autre. Sans mémoire, tout
   * ajout d'appareil ferait deux fois le même appel.
   */
  private readonly listings = new Map<string, Promise<Map<string, string>>>();

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

  /**
   * La stratégie et les tables d'un profil, résolues une seule fois.
   *
   * Mémoire, puis disque, puis réseau — comme les profils eux-mêmes. L'appel réseau récupère la
   * liste de fichiers et le `model.json`, ce qui amorce au passage le cache du profil que
   * l'utilisateur s'apprête à choisir.
   */
  public async getMeta(ref: ProfileRefLike): Promise<ProfileMeta> {
    const key = cacheKey(ref.manufacturer, ref.model);

    const hot = this.metaMemory.get(key);
    if (hot) return hot;

    const pending = this.metaInflight.get(key);
    if (pending) return pending;

    const task = this.resolveMeta(ref, key).finally(() => this.metaInflight.delete(key));
    this.metaInflight.set(key, task);
    return task;
  }

  private async resolveMeta(ref: ProfileRefLike, key: string): Promise<ProfileMeta> {
    const dir = path.join(this.cacheDir, 'profiles', key);
    const cached = parseMeta(await this.readCachedJson(path.join(dir, 'meta.json')));
    if (cached) {
      this.metaMemory.set(key, cached);
      return cached;
    }

    const byPath = await this.listing(ref);
    const modelUrl = byPath.get('model.json');
    if (!modelUrl) throw new ProfileError(`profil ${ref.manufacturer}/${ref.model} sans model.json`, 'malformed');

    const raw = Buffer.from(await this.getBuffer(modelUrl));
    await this.writeCache(path.join(dir, 'model.json'), raw);

    let modelJson: ProfileModel;
    try {
      modelJson = JSON.parse(raw.toString('utf-8')) as ProfileModel;
    } catch (err) {
      throw new ProfileError(`model.json de ${key} illisible : ${describe(err)}`, 'malformed');
    }

    const strategy = modelJson.calculation_strategy;
    if (typeof strategy !== 'string') {
      throw new ProfileError(`model.json de ${key} sans calculation_strategy`, 'malformed');
    }

    const meta: ProfileMeta = {
      strategy,
      tables: strategy === 'lut' ? tablesFromListing(byPath.keys()) : [],
      hasSubProfiles: modelJson.sub_profile_select !== undefined,
    };
    await this.writeCache(path.join(dir, 'meta.json'), Buffer.from(JSON.stringify(meta), 'utf-8'));
    this.metaMemory.set(key, meta);
    return meta;
  }

  /** La liste des fichiers d'un profil, avec leurs URL brutes. Mémorisée pour la session. */
  private listing(ref: ProfileRefLike): Promise<Map<string, string>> {
    const key = cacheKey(ref.manufacturer, ref.model);
    const known = this.listings.get(key);
    if (known) return known;

    const url = `${this.baseUrl}/download/${encodeURIComponent(ref.manufacturer)}/${encodeURIComponent(ref.model)}`;
    const task = (async (): Promise<Map<string, string>> => {
      const listing = await this.getJson(url) as Array<{ path?: string; url?: string }> | null;
      if (!Array.isArray(listing) || listing.length === 0) {
        throw new ProfileError(`profil ${ref.manufacturer}/${ref.model} absent de la bibliothèque`, 'not_found');
      }
      const byPath = new Map<string, string>();
      for (const entry of listing) {
        if (typeof entry?.path === 'string' && typeof entry?.url === 'string') byPath.set(entry.path, entry.url);
      }
      return byPath;
    })();
    // Un échec ne reste pas en mémoire : la tentative suivante doit repartir du réseau.
    task.catch(() => this.listings.delete(key));
    this.listings.set(key, task);
    return task;
  }

  private async loadProfile(model: LibraryModel, key: string): Promise<LoadedProfile> {
    const dir = path.join(this.cacheDir, 'profiles', key);
    // C'est la méta, pas l'index, qui sait quelles tables ce profil possède.
    const wanted = (await this.getMeta(model)).tables;

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
    const byPath = await this.listing(model);

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

/** Le strict nécessaire pour désigner un profil : `getMeta` n'a pas besoin de tout un modèle. */
export interface ProfileRefLike {
  manufacturer: string;
  model: string;
}

/**
 * Les tables réellement présentes dans un profil, d'après sa liste de fichiers.
 *
 * L'index publiait autrefois `color_modes`, et l'app demandait les trois tables quand il manquait.
 * C'était tolérable tant que `color_modes` existait ; ce n'est plus le cas, et demander trois
 * tables dont une seule existe casserait le contrôle de complétude du cache — le profil serait
 * jugé incomplet à chaque démarrage et retéléchargé sans fin.
 *
 * La liste de fichiers dit ce qui existe vraiment. C'est une meilleure source que la déclaration.
 */
export function tablesFromListing(paths: Iterable<string>): LutKind[] {
  const available = new Set(paths);
  const out: LutKind[] = [];
  for (const [kind, file] of Object.entries(LUT_FILES) as Array<[LutKind, string]>) {
    if (available.has(file)) out.push(kind);
  }
  return out;
}

/** Relit une méta écrite sur disque, en refusant tout ce qui la rendrait trompeuse. */
function parseMeta(raw: unknown): ProfileMeta | null {
  if (raw === null || typeof raw !== 'object') return null;
  const candidate = raw as Partial<ProfileMeta>;
  if (typeof candidate.strategy !== 'string') return null;
  if (!Array.isArray(candidate.tables)) return null;
  return {
    strategy: candidate.strategy,
    tables: candidate.tables.filter((kind): kind is LutKind => typeof kind === 'string' && kind in LUT_FILES),
    hasSubProfiles: candidate.hasSubProfiles === true,
  };
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
