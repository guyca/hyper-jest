/**
 * `node --require <ext>/dist/worker/overlayPreload.cjs`: serves unsaved editor buffers to a Jest
 * process spawned by the CLI engine or by js-debug, so on-type runs and Debug see the same content
 * as the editor without touching the files on disk.
 *
 * Mechanism: the host writes a manifest `{version, files: {<absPath>: {text, version}}}` and sets
 * `HYPERJEST_OVERLAY=<manifest path>`. Before Jest loads (graceful-fs clones `fs` on first require,
 * so patching must happen first — guaranteed by `--require`), this preload patches on the real `fs`
 * module:
 *  - reads: `readFileSync`, `readFile`, `promises.readFile` return the overlay text
 *    (jest-runner's test-file read, ScriptTransformer and ts-jest all go through these);
 *  - stats: `statSync`, `lstatSync`, `stat`, `lstat`, `promises.stat/lstat` report a synthetic
 *    mtime (`real mtime + version + 1`) and the overlay size, so Jest's in-memory
 *    `transformedFiles` key (`${filename}_${mtime}`, @jest/transform getScriptCacheKey) changes
 *    per edit and haste-map entries for overlaid files are re-read;
 *  - writes: `writeFileSync`, `writeFile`, `promises.writeFile`, `appendFile*` to an overlaid
 *    path throw (code `EHJOVERLAY`) and emit `overlayWriteBlocked` — inline snapshots must not be
 *    written into a file the editor is about to save over.
 * Events (`overlayApplied`, `overlayWriteBlocked`, `overlayError`) go to fd 3 as NDJSON when the
 * fd exists; all write errors are swallowed. The overlay never crashes the Jest process: a bad
 * manifest only produces `overlayError` and Jest runs against the disk.
 *
 * Authored in CommonJS style (no ESM exports) because it is both a `--require` entry and a module
 * unit tests load; the API is exposed via `module.exports`.
 */
import fs = require('fs');
import path = require('path');
import url = require('url');

const OVERLAY_ENV = 'HYPERJEST_OVERLAY';
const EVENTS_VERSION = 1;
const FD = 3;
const BLOCKED_CODE = 'EHJOVERLAY';

interface OverlayEntry { text: string; version: number }
interface OverlayManifest { version: number; files: Record<string, OverlayEntry> }
interface Emitter { (event: Record<string, unknown>): void }
interface InstallOptions { emit?: Emitter; manifestPath?: string }
interface OverlayHandle {
  /** Resolved keys (absolute path + realpath) -> entry. */
  files: Map<string, OverlayEntry>;
  version: number;
  /** Restores the original fs functions (tests). */
  restore(): void;
}

type AnyFn = (...args: unknown[]) => unknown;

/** Writes one NDJSON line to fd 3; silent when the fd is absent or closed. */
function createFd3Emitter(writeSync: typeof fs.writeSync = fs.writeSync): Emitter {
  let dead = false;
  return event => {
    if (dead) return;
    try {
      writeSync(FD, `${JSON.stringify({ v: EVENTS_VERSION, ...event })}\n`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'EAGAIN' && code !== 'EWOULDBLOCK') dead = true;
    }
  };
}

/** Validates the manifest JSON; throws a descriptive error on any shape problem. */
function parseManifest(json: string): OverlayManifest {
  const raw: unknown = JSON.parse(json);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('manifest is not an object');
  const m = raw as { version?: unknown; files?: unknown };
  const files: Record<string, OverlayEntry> = {};
  if (m.files && typeof m.files === 'object') {
    for (const [p, entry] of Object.entries(m.files as Record<string, unknown>)) {
      if (!path.isAbsolute(p)) throw new Error(`manifest path is not absolute: ${p}`);
      const e = entry as { text?: unknown; version?: unknown } | null;
      if (!e || typeof e.text !== 'string') throw new Error(`manifest entry has no text: ${p}`);
      files[p] = { text: e.text, version: typeof e.version === 'number' && Number.isFinite(e.version) ? e.version : 0 };
    }
  }
  return { version: typeof m.version === 'number' ? m.version : 0, files };
}

function loadManifest(manifestPath: string, readFileSync: (p: string, enc: BufferEncoding) => string = fs.readFileSync): OverlayManifest {
  return parseManifest(readFileSync(manifestPath, 'utf8'));
}

/** Normalises any fs path argument to an absolute string key; undefined for fds/handles. */
function keyOf(p: unknown): string | undefined {
  if (typeof p === 'string') return p ? path.resolve(p) : undefined;
  if (Buffer.isBuffer(p)) return path.resolve(p.toString('utf8'));
  if (p instanceof URL || (p && typeof p === 'object' && (p as { protocol?: unknown }).protocol === 'file:')) {
    try { return path.resolve(url.fileURLToPath(p as URL)); } catch { return undefined; }
  }
  return undefined;
}

function encodingOf(options: unknown): BufferEncoding | null {
  if (typeof options === 'string') return options as BufferEncoding;
  if (options && typeof options === 'object') {
    const enc = (options as { encoding?: unknown }).encoding;
    if (typeof enc === 'string' && enc !== 'buffer') return enc as BufferEncoding;
  }
  return null;
}

function encode(text: string, options: unknown): string | Buffer {
  const enc = encodingOf(options);
  if (!enc) return Buffer.from(text, 'utf8');
  if (enc === 'utf8' || enc === 'utf-8') return text;
  return Buffer.from(text, 'utf8').toString(enc);
}

function blockedError(key: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(
    `HyperJest: ${key} has unsaved changes in the editor; save the file before Jest can write to it (inline snapshots are written to the file on disk).`,
  );
  err.code = BLOCKED_CODE;
  err.path = key;
  return err;
}

function define(obj: object, prop: string, value: unknown): void {
  Object.defineProperty(obj, prop, { value, enumerable: true, configurable: true, writable: true });
}

/** Overrides mtime/ctime/size on a Stats object for an overlaid file (BigInt stats are left alone). */
function patchStats<T>(stats: T, entry: OverlayEntry): T {
  if (!stats || typeof stats !== 'object') return stats;
  const s = stats as unknown as { mtimeMs?: unknown; isFile?: () => boolean };
  if (typeof s.mtimeMs !== 'number') return stats;
  const ms = Math.floor(s.mtimeMs) + entry.version + 1;
  define(s, 'mtimeMs', ms);
  define(s, 'mtime', new Date(ms));
  define(s, 'ctimeMs', ms);
  define(s, 'ctime', new Date(ms));
  define(s, 'size', Buffer.byteLength(entry.text, 'utf8'));
  return stats;
}

/**
 * Installs the overlay on `fsMod` (the real `fs` in production; a fake in tests).
 * Keys are registered for the given absolute path and, when it exists, its realpath.
 */
function installOverlay(fsMod: typeof fs, manifest: OverlayManifest, options: InstallOptions = {}): OverlayHandle {
  const emit = options.emit ?? createFd3Emitter(fsMod.writeSync);
  const files = new Map<string, OverlayEntry>();
  for (const [p, entry] of Object.entries(manifest.files)) {
    const abs = path.resolve(p);
    files.set(abs, entry);
    try {
      const real = fsMod.realpathSync.native ? fsMod.realpathSync.native(abs) : fsMod.realpathSync(abs);
      if (real && real !== abs) files.set(real, entry);
    } catch {
      /* file does not exist on disk: only the given path is served */
    }
  }
  const lookup = (p: unknown): OverlayEntry | undefined => {
    if (!files.size) return undefined;
    const key = keyOf(p);
    return key ? files.get(key) : undefined;
  };

  const originals = new Map<string, { target: object; name: string; fn: unknown }>();
  const patch = (target: object, name: string, make: (orig: AnyFn) => AnyFn): void => {
    const orig = (target as Record<string, unknown>)[name];
    if (typeof orig !== 'function') return;
    originals.set(`${target === fsMod ? 'fs' : 'promises'}.${name}`, { target, name, fn: orig });
    (target as Record<string, unknown>)[name] = make(orig as AnyFn);
  };

  // ---- reads ---------------------------------------------------------------------------------
  patch(fsMod, 'readFileSync', orig => function (this: unknown, p: unknown, options?: unknown) {
    const entry = lookup(p);
    return entry ? encode(entry.text, options) : orig.apply(this, arguments as unknown as unknown[]);
  } as AnyFn);
  patch(fsMod, 'readFile', orig => function (this: unknown, p: unknown, options?: unknown, cb?: unknown) {
    const entry = lookup(p);
    if (!entry) return orig.apply(this, arguments as unknown as unknown[]);
    const callback = (typeof options === 'function' ? options : cb) as ((err: null, data: string | Buffer) => void) | undefined;
    const data = encode(entry.text, typeof options === 'function' ? undefined : options);
    if (typeof callback === 'function') process.nextTick(() => callback(null, data));
    return undefined;
  } as AnyFn);
  if (fsMod.promises) {
    patch(fsMod.promises, 'readFile', orig => function (this: unknown, p: unknown, options?: unknown) {
      const entry = lookup(p);
      return entry ? Promise.resolve(encode(entry.text, options)) : orig.apply(this, arguments as unknown as unknown[]);
    } as AnyFn);
  }

  // ---- stats ---------------------------------------------------------------------------------
  for (const name of ['statSync', 'lstatSync'] as const) {
    patch(fsMod, name, orig => function (this: unknown, p: unknown) {
      const result = orig.apply(this, arguments as unknown as unknown[]);
      const entry = lookup(p);
      return entry ? patchStats(result, entry) : result;
    } as AnyFn);
  }
  for (const name of ['stat', 'lstat'] as const) {
    patch(fsMod, name, orig => function (this: unknown, p: unknown, ...rest: unknown[]) {
      const entry = lookup(p);
      if (!entry) return orig.apply(this, [p, ...rest]);
      const cbIndex = rest.findIndex(a => typeof a === 'function');
      if (cbIndex < 0) return orig.apply(this, [p, ...rest]);
      const cb = rest[cbIndex] as (err: unknown, stats?: unknown) => void;
      rest[cbIndex] = (err: unknown, stats?: unknown) => cb(err, err ? stats : patchStats(stats, entry));
      return orig.apply(this, [p, ...rest]);
    } as AnyFn);
  }
  if (fsMod.promises) {
    for (const name of ['stat', 'lstat'] as const) {
      patch(fsMod.promises, name, orig => function (this: unknown, p: unknown) {
        const entry = lookup(p);
        const result = orig.apply(this, arguments as unknown as unknown[]) as Promise<unknown>;
        return entry ? result.then(stats => patchStats(stats, entry)) : result;
      } as AnyFn);
    }
  }

  // ---- writes --------------------------------------------------------------------------------
  const block = (p: unknown): NodeJS.ErrnoException | undefined => {
    const entry = lookup(p);
    if (!entry) return undefined;
    const key = keyOf(p) as string;
    emit({ type: 'overlayWriteBlocked', path: key });
    return blockedError(key);
  };
  for (const name of ['writeFileSync', 'appendFileSync'] as const) {
    patch(fsMod, name, orig => function (this: unknown, p: unknown) {
      const err = block(p);
      if (err) throw err;
      return orig.apply(this, arguments as unknown as unknown[]);
    } as AnyFn);
  }
  for (const name of ['writeFile', 'appendFile'] as const) {
    patch(fsMod, name, orig => function (this: unknown, p: unknown, ...rest: unknown[]) {
      const err = block(p);
      if (!err) return orig.apply(this, [p, ...rest]);
      const cb = rest.find(a => typeof a === 'function') as ((e: Error) => void) | undefined;
      if (cb) process.nextTick(() => cb(err));
      return undefined;
    } as AnyFn);
  }
  if (fsMod.promises) {
    for (const name of ['writeFile', 'appendFile'] as const) {
      patch(fsMod.promises, name, orig => function (this: unknown, p: unknown) {
        const err = block(p);
        return err ? Promise.reject(err) : orig.apply(this, arguments as unknown as unknown[]);
      } as AnyFn);
    }
  }

  emit({ type: 'overlayApplied', manifest: options.manifestPath ?? '', version: manifest.version, files: Object.keys(manifest.files).length });

  return {
    files,
    version: manifest.version,
    restore() {
      for (const { target, name, fn } of originals.values()) (target as Record<string, unknown>)[name] = fn;
      originals.clear();
    },
  };
}

/** Reads HYPERJEST_OVERLAY and installs; never throws (emits overlayError instead). */
function autoInstall(env: NodeJS.ProcessEnv = process.env, emit: Emitter = createFd3Emitter()): OverlayHandle | undefined {
  const manifestPath = env[OVERLAY_ENV];
  if (!manifestPath) return undefined;
  try {
    const manifest = loadManifest(manifestPath);
    return installOverlay(fs, manifest, { emit, manifestPath });
  } catch (err) {
    emit({ type: 'overlayError', message: `${manifestPath}: ${err instanceof Error ? err.message : String(err)}` });
    return undefined;
  }
}

module.exports = {
  OVERLAY_ENV,
  BLOCKED_CODE,
  parseManifest,
  loadManifest,
  installOverlay,
  createFd3Emitter,
  autoInstall,
  patchStats,
  keyOf,
};

// Side effect when loaded through `node --require` (or any require) with the env var present.
// Tests load this module without HYPERJEST_OVERLAY and call installOverlay() on a fake fs.
if (process.env[OVERLAY_ENV] && !process.env.HYPERJEST_OVERLAY_NO_AUTO) autoInstall();
