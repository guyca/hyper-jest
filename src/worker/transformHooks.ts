/**
 * Prototype seams on the project's `@jest/transform` ScriptTransformer (installed once per worker).
 *
 * 1. `requireAndTranspileModule`: when the loaded module is an environment class, return the
 *    HyperJest subclass (envWrapper). Covers the configured `testEnvironment` AND per-file
 *    `@jest-environment` docblocks, with the ProjectConfig untouched.
 *    Verified: 29.7 ScriptTransformer.js:757, 30.4.x index.js:576, 30.5.2 index.js:588.
 * 2. `_getTransformer(filename)`: pass the project's transformer through the `//?` probe
 *    transformer (written by another module with the contract `wrapTransformer(inner, deps)`).
 * 3. `_cache.transformedFiles`: prune `${path}_*` keys for overlay paths (keys are filename_mtime).
 *
 * Each seam is presence-checked; a missing one only degrades its feature and is reported in `ready`.
 * No static Jest imports.
 */
import type { Logger } from '../core/logger';
import { isEnvironmentClass, wrapEnvironment, type EnvDeps } from './envWrapper';

export interface Seams {
  envWrapper: boolean;
  probeTransformer: boolean;
  cachePrune: boolean;
}

export interface ProbeDeps {
  babelCore: any;
  babelParser: any;
  convertSourceMap?: any;
  /** Optional @jridgewell/trace-mapping: lets the probe pass fall back to source-map pairing when a transformer drops comments. */
  traceMapping?: any;
  probeVersion: string;
}

/** Contract of ./probeTransformer (owned by another module; imported lazily so its absence degrades). */
export interface ProbeModule {
  wrapTransformer: (inner: any, deps: ProbeDeps) => any;
  hasLiveMarkers?: (source: string) => boolean;
}

/** Bumped whenever probe output changes shape; part of the probe transformer's cache key. */
export const PROBE_VERSION = '1';

export function loadProbeModule(): ProbeModule | undefined {
  try {
    // Inside try: esbuild keeps the build green when the file does not exist yet (runtime require
    // then throws and live comments degrade); once present it is bundled like any other module.
    const mod = require('./probeTransformer') as Partial<ProbeModule> | undefined;
    if (mod && typeof mod.wrapTransformer === 'function') return mod as ProbeModule;
  } catch {
    // not available
  }
  return undefined;
}

export interface HookOptions {
  liveComments: boolean;
  probe?: ProbeModule;
  probeDeps?: ProbeDeps;
  envDeps: EnvDeps;
  log?: Logger;
}

const hookedProtos = new WeakMap<object, Seams>();

/** True when the instance exposes the in-memory transform cache we prune. */
export function hasCachePruneSeam(transformer: any): boolean {
  const files = transformer?._cache?.transformedFiles;
  return !!files && typeof files.delete === 'function' && typeof files.keys === 'function';
}

/**
 * Installs the two prototype seams. Idempotent per prototype (every ScriptTransformer instance of a
 * process shares it). Returns which seams exist; `cachePrune` is reported by the caller from an instance.
 */
export function installHooksOnPrototype(proto: any, opts: HookOptions): Omit<Seams, 'cachePrune'> {
  const prior = hookedProtos.get(proto);
  if (prior) return { envWrapper: prior.envWrapper, probeTransformer: prior.probeTransformer };
  const seams: Seams = { envWrapper: false, probeTransformer: false, cachePrune: false };

  if (proto && typeof proto.requireAndTranspileModule === 'function') {
    const orig = proto.requireAndTranspileModule;
    proto.requireAndTranspileModule = async function hjRequireAndTranspileModule(this: unknown, moduleName: string, callback?: unknown, options?: unknown) {
      // With a callback (globalSetup/teardown, snapshot resolver) the module is consumed inside;
      // pass through untouched.
      if (callback) return orig.call(this, moduleName, callback, options);
      const mod = await orig.call(this, moduleName, undefined, options);
      if (isEnvironmentClass(mod)) {
        try {
          return wrapEnvironment(mod, opts.envDeps);
        } catch (e) {
          opts.log?.warn(`envWrapper: failed to wrap ${String((mod as { name?: string })?.name ?? moduleName)}: ${(e as Error).message}`);
        }
      }
      return mod;
    };
    seams.envWrapper = true;
  }

  if (proto && typeof proto._getTransformer === 'function' && opts.liveComments && opts.probe && opts.probeDeps) {
    const origGet = proto._getTransformer;
    const probe = opts.probe;
    const deps = opts.probeDeps;
    const wrappedEntries = new WeakMap<object, any>();
    proto._getTransformer = function hjGetTransformer(this: unknown, filename: string) {
      const entry = origGet.call(this, filename);
      if (!entry || typeof entry !== 'object' || !entry.transformer) return entry;
      let wrapped = wrappedEntries.get(entry);
      if (!wrapped) {
        try {
          const t = probe.wrapTransformer(entry.transformer, deps);
          wrapped = t && t !== entry.transformer ? { ...entry, transformer: t } : entry;
        } catch (e) {
          opts.log?.warn(`probeTransformer: wrapTransformer failed, live comments disabled for this transformer: ${(e as Error).message}`);
          wrapped = entry;
        }
        wrappedEntries.set(entry, wrapped);
      }
      return wrapped;
    };
    seams.probeTransformer = true;
  }

  hookedProtos.set(proto, seams);
  return { envWrapper: seams.envWrapper, probeTransformer: seams.probeTransformer };
}

/**
 * Creates the first ScriptTransformer for `cfg`, hooks its prototype and reports the seams.
 * The returned transformer is reused by the engine for cache pruning and globalSetup.
 */
export async function installTransformHooks(
  transform: { createScriptTransformer: (cfg: any, cacheFS?: Map<string, string>) => Promise<any> },
  cfg: any,
  opts: HookOptions,
): Promise<{ seams: Seams; transformer: any }> {
  const transformer = await transform.createScriptTransformer(cfg);
  const proto = Object.getPrototypeOf(transformer);
  const partial = installHooksOnPrototype(proto, opts);
  return { seams: { ...partial, cachePrune: hasCachePruneSeam(transformer) }, transformer };
}

/**
 * Deletes in-memory transform results for `paths` (keys `${filename}_${mtime}[_instrumented]`).
 * Returns the number of removed entries, or -1 when the seam is missing.
 */
export function pruneTransformCache(transformer: any, paths: string[]): number {
  if (!hasCachePruneSeam(transformer) || !paths.length) return hasCachePruneSeam(transformer) ? 0 : -1;
  const files: Map<string, unknown> = transformer._cache.transformedFiles;
  const prefixes = paths.map(p => `${p}_`);
  let removed = 0;
  for (const key of [...files.keys()]) {
    if (prefixes.some(prefix => key.startsWith(prefix))) {
      files.delete(key);
      removed += 1;
    }
  }
  return removed;
}
