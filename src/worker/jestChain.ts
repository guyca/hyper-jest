/**
 * Resolves the PROJECT's Jest packages by following dependency edges from its `jest` package, and
 * loads them with absolute-path `require`. Never resolves from the repo root or the extension: in
 * monorepos the hoisted `jest-config`/`jest-circus` can be a different major than the `jest` the
 * project actually uses (mobile-apps-engine: root jest-config 29.7 vs jest 30.4.2).
 *
 * Chain (verified for 29.7.0, 30.4.2 and 30.5.2):
 *   jest -> jest-cli -> @jest/core -> {jest-config, jest-runtime, jest-runner, jest-watcher, jest-resolve-dependencies}
 *   jest-runtime -> {jest-resolve, @jest/transform, jest-snapshot, jest-haste-map, @jest/source-map}
 *   jest-runner  -> {jest-message-util, jest-util, pretty-format}
 *   @jest/transform -> {@babel/core, @jridgewell/trace-mapping, convert-source-map}; @babel/core -> @babel/parser
 *
 * Nothing here imports Jest statically, so esbuild never bundles it.
 */
import { createRequire } from 'module';
import * as path from 'path';

/** Resolves package `name` as seen from `fromDir` and returns the package directory. */
export type ResolveFrom = (name: string, fromDir: string) => string;

export const defaultResolveFrom: ResolveFrom = (name, fromDir) => {
  const req = createRequire(path.join(fromDir, 'package.json'));
  return path.dirname(req.resolve(`${name}/package.json`));
};

export interface JestChainDirs {
  jest: string;
  cli: string;
  core: string;
  config: string;
  runtime: string;
  runner: string;
  watcher: string;
  resolveDeps: string;
  resolve: string;
  transform: string;
  snapshot: string;
  hasteMap: string;
  messageUtil: string;
  util: string;
  prettyFormat: string;
  babelCore?: string;
  babelParser?: string;
  traceMapping?: string;
  convertSourceMap?: string;
}

/** Loaded modules. Typed loosely on purpose: shapes differ slightly between 29 and 30. */
export interface JestChainModules {
  config: { readConfigs: (argv: Record<string, unknown>, projects: string[]) => Promise<{ globalConfig: any; configs: any[]; hasDeprecationWarnings: boolean }> } & Record<string, any>;
  /** jest-runtime default export (class with static createContext/createResolver/shouldInstrument). */
  Runtime: any;
  runner: { default: any; EmittingTestRunner?: any } & Record<string, any>;
  core: { SearchSource: any } & Record<string, any>;
  watcher: { TestWatcher: any } & Record<string, any>;
  resolveDeps: { DependencyResolver: any } & Record<string, any>;
  /** jest-resolve module; `.default` is the Resolver class (static clearDefaultResolverCache). */
  resolve: { default: any } & Record<string, any>;
  transform: { createScriptTransformer: (cfg: any, cacheFS?: Map<string, string>) => Promise<any>; shouldInstrument?: any } & Record<string, any>;
  snapshot: { buildSnapshotResolver: (cfg: any, localRequire?: any) => Promise<any> } & Record<string, any>;
  messageUtil: Record<string, any>;
  util: Record<string, any>;
  prettyFormat: { format: (v: unknown, o?: any) => string } & Record<string, any>;
  babelCore?: Record<string, any>;
  babelParser?: Record<string, any>;
  traceMapping?: Record<string, any>;
  convertSourceMap?: Record<string, any>;
}

export interface JestChain {
  version: string;
  dirs: JestChainDirs;
  modules: JestChainModules;
}

function tryResolve(resolveFrom: ResolveFrom, name: string, ...fromDirs: Array<string | undefined>): string | undefined {
  for (const dir of fromDirs) {
    if (!dir) continue;
    try { return resolveFrom(name, dir); } catch { /* try next base */ }
  }
  return undefined;
}

/**
 * Pure chain resolution. `jestPkgDir` (from host discovery) short-circuits the first hop; everything
 * else is resolved relative to the previous package so nested/hoisted mixes come out right.
 */
export function resolveJestChainDirs(packageDir: string, resolveFrom: ResolveFrom = defaultResolveFrom, jestPkgDir?: string): JestChainDirs {
  const jest = jestPkgDir ?? resolveFrom('jest', packageDir);
  const cli = resolveFrom('jest-cli', jest);
  const core = resolveFrom('@jest/core', cli);
  const config = resolveFrom('jest-config', core);
  const runtime = resolveFrom('jest-runtime', core);
  const runner = resolveFrom('jest-runner', core);
  const watcher = resolveFrom('jest-watcher', core);
  const resolveDeps = resolveFrom('jest-resolve-dependencies', core);
  const resolve = resolveFrom('jest-resolve', runtime);
  const transform = resolveFrom('@jest/transform', runtime);
  const snapshot = resolveFrom('jest-snapshot', runtime);
  const hasteMap = resolveFrom('jest-haste-map', runtime);
  const messageUtil = resolveFrom('jest-message-util', runner);
  const util = resolveFrom('jest-util', runner);
  const prettyFormat = resolveFrom('pretty-format', runner);
  const babelCore = tryResolve(resolveFrom, '@babel/core', transform, runtime, packageDir);
  const babelParser = tryResolve(resolveFrom, '@babel/parser', babelCore, transform, packageDir);
  const sourceMap = tryResolve(resolveFrom, '@jest/source-map', runtime, runner);
  const traceMapping = tryResolve(resolveFrom, '@jridgewell/trace-mapping', transform, sourceMap, babelCore);
  const convertSourceMap = tryResolve(resolveFrom, 'convert-source-map', transform, babelCore);
  return {
    jest, cli, core, config, runtime, runner, watcher, resolveDeps, resolve, transform, snapshot, hasteMap,
    messageUtil, util, prettyFormat, babelCore, babelParser, traceMapping, convertSourceMap,
  };
}

/** `require(<absolute package dir>)`: Node reads the package's `main`; exports maps do not apply to absolute paths. */
export function requirePackageDir(dir: string): any {
  const req = createRequire(path.join(dir, 'package.json'));
  return req(dir);
}

export function readPackageVersion(dir: string): string {
  try {
    const pkg = JSON.parse(require('fs').readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Resolves and loads the whole chain. Throws with a clear message when `jest` is missing. */
export function loadJestChain(packageDir: string, jestPkgDir?: string, resolveFrom: ResolveFrom = defaultResolveFrom): JestChain {
  const dirs = resolveJestChainDirs(packageDir, resolveFrom, jestPkgDir);
  const version = readPackageVersion(dirs.jest);
  const optional = (dir?: string) => (dir ? safeRequire(dir) : undefined);
  const runtimeModule = requirePackageDir(dirs.runtime);
  const modules: JestChainModules = {
    config: requirePackageDir(dirs.config),
    Runtime: runtimeModule.default ?? runtimeModule,
    runner: requirePackageDir(dirs.runner),
    core: requirePackageDir(dirs.core),
    watcher: requirePackageDir(dirs.watcher),
    resolveDeps: requirePackageDir(dirs.resolveDeps),
    resolve: requirePackageDir(dirs.resolve),
    transform: requirePackageDir(dirs.transform),
    snapshot: requirePackageDir(dirs.snapshot),
    messageUtil: requirePackageDir(dirs.messageUtil),
    util: requirePackageDir(dirs.util),
    prettyFormat: requirePackageDir(dirs.prettyFormat),
    babelCore: optional(dirs.babelCore),
    babelParser: optional(dirs.babelParser),
    traceMapping: optional(dirs.traceMapping),
    convertSourceMap: optional(dirs.convertSourceMap),
  };
  return { version, dirs, modules };
}

function safeRequire(dir: string): any | undefined {
  try { return requirePackageDir(dir); } catch { return undefined; }
}

/** Major version as a number (29, 30, ...). */
export function majorOf(version: string): number {
  const m = /^(\d+)/.exec(version);
  return m ? Number(m[1]) : 0;
}
