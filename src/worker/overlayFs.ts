/**
 * In-memory file overlay for unsaved editor buffers.
 *
 * Jest (and every transformer) reads sources through `fs` / `graceful-fs`. Patching the `fs` module
 * BEFORE anything requires `graceful-fs` (it clones `fs` on first require) makes every read of an
 * overlaid path return the editor content without touching disk, exactly like Wallaby's
 * `fs.readFileSync` redirection. Overlaid files must exist on disk (Jest stats them and the v30
 * native resolver cannot be intercepted); only their *content* and *mtime* are virtual.
 *
 * - `readFileSync` / `readFile` / `promises.readFile`: serve overlay text (utf8 or Buffer form).
 * - `statSync` / `lstatSync` / `promises.stat|lstat`: report a synthetic mtime per editor version so
 *   Jest's in-memory transform key (`${filename}_${mtime}`) changes on every edit.
 * - `writeFileSync` / `writeFile` / `promises.writeFile` to an overlaid path are blocked (inline
 *   snapshot writes would clobber the editor buffer); listeners get the path so the host can say
 *   "save the file first".
 *
 * No Jest, no 'vscode'.
 */
import type * as fsTypes from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * The REAL `fs` module object. A bundler's `import * as fs` gives an ESM-interop namespace whose
 * properties are getters; patching that would not affect Node's module (or graceful-fs's clone).
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeFs: typeof fsTypes = require('fs');

export interface OverlayEntry {
  text: string;
  version: number;
}

/** Jan 2033 in ms: a synthetic mtime base no real file reaches, so keys never collide with disk mtimes. */
export const SYNTHETIC_MTIME_BASE_MS = 2_000_000_000_000;

export function syntheticMtimeMs(version: number): number {
  return SYNTHETIC_MTIME_BASE_MS + Math.max(0, Math.floor(Number.isFinite(version) ? version : 0));
}

export function normalizeOverlayPath(p: string): string {
  return path.resolve(p);
}

/** The error raised for writes to overlaid paths. */
export function overlayWriteBlockedError(p: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(
    `HyperJest: "${p}" has unsaved changes in the editor. Save the file before Jest can write to it (inline snapshots).`,
  );
  err.code = 'EHYPERJEST_OVERLAY';
  err.path = p;
  return err;
}

/** Map of overlaid paths plus a change log for transform-cache pruning. */
export class OverlayStore {
  private readonly entries = new Map<string, OverlayEntry>();
  /** path -> generation of its last set/delete. */
  private readonly changedAt = new Map<string, number>();
  private generation = 0;
  private readonly blockedListeners: Array<(p: string) => void> = [];

  set(p: string, text: string, version: number): void {
    const key = normalizeOverlayPath(p);
    this.entries.set(key, { text, version });
    this.touch(key);
  }

  delete(p: string): boolean {
    const key = normalizeOverlayPath(p);
    const had = this.entries.delete(key);
    if (had) this.touch(key);
    return had;
  }

  has(p: string): boolean {
    return this.entries.has(normalizeOverlayPath(p));
  }

  get(p: string): OverlayEntry | undefined {
    return this.entries.get(normalizeOverlayPath(p));
  }

  /** Lookup by an already-normalised key (hot path inside the fs patches). */
  getNormalized(key: string): OverlayEntry | undefined {
    return this.entries.get(key);
  }

  paths(): string[] {
    return [...this.entries.keys()];
  }

  get size(): number {
    return this.entries.size;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  /** Paths set or deleted after `sinceGeneration` (exclusive), with the generation to remember. */
  changedSince(sinceGeneration: number): { paths: string[]; generation: number } {
    const paths: string[] = [];
    for (const [p, gen] of this.changedAt) if (gen > sinceGeneration) paths.push(p);
    return { paths, generation: this.generation };
  }

  onWriteBlocked(cb: (p: string) => void): () => void {
    this.blockedListeners.push(cb);
    return () => {
      const i = this.blockedListeners.indexOf(cb);
      if (i >= 0) this.blockedListeners.splice(i, 1);
    };
  }

  notifyBlocked(p: string): void {
    for (const cb of this.blockedListeners) {
      try { cb(p); } catch { /* listeners must not break fs */ }
    }
  }

  private touch(key: string): void {
    this.generation += 1;
    this.changedAt.set(key, this.generation);
  }
}

/** Encoding requested by a read call, or null for the Buffer form. */
export function readEncodingOf(options: unknown): BufferEncoding | null {
  if (typeof options === 'string') return options as BufferEncoding;
  if (options && typeof options === 'object') {
    const enc = (options as { encoding?: unknown }).encoding;
    if (typeof enc === 'string') return enc as BufferEncoding;
  }
  return null;
}

export function overlayContent(entry: OverlayEntry, options: unknown): string | Buffer {
  const enc = readEncodingOf(options);
  if (enc === null) return Buffer.from(entry.text, 'utf8');
  if (enc === 'utf8' || enc === 'utf-8') return entry.text;
  return Buffer.from(entry.text, 'utf8').toString(enc);
}

/** A copy of a real `fs.Stats` whose mtime/ctime report the synthetic overlay time. */
export function makeOverlayStats(real: fsTypes.Stats, mtimeMs: number): fsTypes.Stats {
  const copy = Object.assign(Object.create(Object.getPrototypeOf(real)), real) as fsTypes.Stats;
  copy.mtimeMs = mtimeMs;
  copy.ctimeMs = mtimeMs;
  const d = new Date(mtimeMs);
  Object.defineProperty(copy, 'mtime', { value: d, enumerable: true, configurable: true, writable: true });
  Object.defineProperty(copy, 'ctime', { value: d, enumerable: true, configurable: true, writable: true });
  return copy;
}

function keyOf(p: unknown): string | null {
  if (typeof p === 'string') return normalizeOverlayPath(p);
  if (p instanceof URL && p.protocol === 'file:') {
    try { return normalizeOverlayPath(fileURLToPath(p)); } catch { return null; }
  }
  return null;
}

const installed = new WeakMap<object, OverlayStore>();

/**
 * Patches the given `fs` module (default: Node's) and returns the store. Idempotent per module.
 * Call this before anything requires graceful-fs or Jest.
 */
export function install(target: typeof fsTypes = nodeFs): OverlayStore {
  const existing = installed.get(target);
  if (existing) return existing;
  const store = new OverlayStore();
  installed.set(target, store);

  const t = target as unknown as Record<string, any>;
  const orig = {
    readFileSync: t.readFileSync as (...a: any[]) => any,
    readFile: t.readFile as (...a: any[]) => any,
    statSync: t.statSync as (...a: any[]) => any,
    lstatSync: t.lstatSync as (...a: any[]) => any,
    writeFileSync: t.writeFileSync as (...a: any[]) => any,
    writeFile: t.writeFile as (...a: any[]) => any,
  };
  const lookup = (p: unknown): { key: string; entry: OverlayEntry } | undefined => {
    if (store.size === 0) return undefined;
    const key = keyOf(p);
    if (!key) return undefined;
    const entry = store.getNormalized(key);
    return entry ? { key, entry } : undefined;
  };

  t.readFileSync = function readFileSync(this: unknown, p: unknown, options?: unknown) {
    const hit = lookup(p);
    if (!hit) return orig.readFileSync.apply(this, arguments as unknown as unknown[]);
    return overlayContent(hit.entry, options);
  };

  t.readFile = function readFile(this: unknown, p: unknown, options?: unknown, cb?: unknown) {
    const hit = lookup(p);
    if (!hit) return orig.readFile.apply(this, arguments as unknown as unknown[]);
    const callback = (typeof options === 'function' ? options : cb) as ((e: Error | null, d?: string | Buffer) => void) | undefined;
    const data = overlayContent(hit.entry, typeof options === 'function' ? undefined : options);
    if (typeof callback === 'function') process.nextTick(() => callback(null, data));
    return undefined;
  };

  const patchStat = (name: 'statSync' | 'lstatSync') => {
    t[name] = function stat(this: unknown, p: unknown, options?: unknown) {
      const real = orig[name].apply(this, arguments as unknown as unknown[]);
      const hit = lookup(p);
      if (!hit || !real || (options as { bigint?: boolean } | undefined)?.bigint) return real;
      return makeOverlayStats(real as fsTypes.Stats, syntheticMtimeMs(hit.entry.version));
    };
  };
  patchStat('statSync');
  patchStat('lstatSync');

  t.writeFileSync = function writeFileSync(this: unknown, p: unknown) {
    const hit = lookup(p);
    if (!hit) return orig.writeFileSync.apply(this, arguments as unknown as unknown[]);
    store.notifyBlocked(hit.key);
    throw overlayWriteBlockedError(hit.key);
  };

  t.writeFile = function writeFile(this: unknown, p: unknown, _data?: unknown, options?: unknown, cb?: unknown) {
    const hit = lookup(p);
    if (!hit) return orig.writeFile.apply(this, arguments as unknown as unknown[]);
    store.notifyBlocked(hit.key);
    const callback = (typeof options === 'function' ? options : cb) as ((e: Error | null) => void) | undefined;
    const err = overlayWriteBlockedError(hit.key);
    if (typeof callback === 'function') process.nextTick(() => callback(err));
    return undefined;
  };

  // `fs.promises` is a lazy getter returning the fs/promises singleton; patch its methods in place.
  const promises = (target as { promises?: Record<string, any> }).promises;
  if (promises && typeof promises === 'object') {
    const p = promises;
    const pReadFile = p.readFile as (...a: any[]) => Promise<any>;
    const pStat = p.stat as (...a: any[]) => Promise<any>;
    const pLstat = p.lstat as (...a: any[]) => Promise<any>;
    const pWriteFile = p.writeFile as (...a: any[]) => Promise<any>;
    if (typeof pReadFile === 'function') {
      p.readFile = async function readFile(this: unknown, file: unknown, options?: unknown) {
        const hit = lookup(file);
        if (!hit) return pReadFile.apply(this, arguments as unknown as unknown[]);
        return overlayContent(hit.entry, options);
      };
    }
    const patchPStat = (name: 'stat' | 'lstat', fn: (...a: any[]) => Promise<any>) => {
      if (typeof fn !== 'function') return;
      p[name] = async function stat(this: unknown, file: unknown, options?: unknown) {
        const real = await fn.apply(this, arguments as unknown as unknown[]);
        const hit = lookup(file);
        if (!hit || !real || (options as { bigint?: boolean } | undefined)?.bigint) return real;
        return makeOverlayStats(real as fsTypes.Stats, syntheticMtimeMs(hit.entry.version));
      };
    };
    patchPStat('stat', pStat);
    patchPStat('lstat', pLstat);
    if (typeof pWriteFile === 'function') {
      p.writeFile = async function writeFile(this: unknown, file: unknown) {
        const hit = lookup(file);
        if (!hit) return pWriteFile.apply(this, arguments as unknown as unknown[]);
        store.notifyBlocked(hit.key);
        throw overlayWriteBlockedError(hit.key);
      };
    }
  }

  return store;
}

/** The store installed on Node's `fs`, if `install()` ran. */
export function getOverlayStore(target: typeof fsTypes = nodeFs): OverlayStore | undefined {
  return installed.get(target);
}
