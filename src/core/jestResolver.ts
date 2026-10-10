/**
 * Dependency-free package resolution for the Jest toolchain.
 *
 * Rules (plan "Project discovery" step 5): resolve `jest` via `require.resolve('jest/package.json',
 * {paths:[startDir]})`, NEVER through `node_modules/.bin/jest` or hoisted siblings, and resolve every
 * other Jest package by chaining from the package that depends on it (`jest -> jest-cli -> @jest/core
 * -> jest-config ...`). The same helpers are usable from the worker: no 'vscode', no bundled Jest.
 *
 * Resolution is injectable (`ResolveFn`) so unit tests run on an in-memory file system.
 */
import { createRequire } from 'module';
import * as path from 'path';
import { FsView, PackageJsonLike, ancestors, nodeFs, normalizePath, readJson } from './paths';

/**
 * Resolve `request` (a module id such as `jest/package.json` or `@example/test-tools`) starting from each of
 * `fromDirs` in order. Returns the absolute (real) path of the resolved file, or undefined.
 */
export type ResolveFn = (request: string, fromDirs: string[]) => string | undefined;

/** Split `@scope/name/sub/path` into the package name and the sub path. */
export function splitRequest(request: string): { name: string; sub: string } {
  const parts = request.split('/');
  const name = request.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const sub = request.slice(name.length).replace(/^\//, '');
  return { name, sub };
}

/**
 * Pure `node_modules` walk (Node's lookup order without exports maps, NODE_PATH or global folders).
 * Used for in-memory tests and as the fallback when `require.resolve` is blocked by an `exports` map.
 */
export function createFsResolveFn(fsv: FsView): ResolveFn {
  return (request, fromDirs) => {
    const { name, sub } = splitRequest(request);
    for (const from of fromDirs) {
      for (const dir of ancestors(from)) {
        const pkgRoot = path.join(dir, 'node_modules', name);
        if (!fsv.isDirectory(pkgRoot)) continue;
        if (sub) {
          const candidates = [path.join(pkgRoot, sub), path.join(pkgRoot, `${sub}.js`), path.join(pkgRoot, sub, 'index.js')];
          const hit = candidates.find(c => fsv.isFile(c));
          if (hit) return fsv.realpath(hit);
          continue;
        }
        const pkg = readJson<PackageJsonLike>(path.join(pkgRoot, 'package.json'), fsv);
        const main = typeof pkg?.main === 'string' && pkg.main ? pkg.main : 'index.js';
        const mainCandidates = [path.join(pkgRoot, main), path.join(pkgRoot, `${main}.js`), path.join(pkgRoot, main, 'index.js')];
        const hit = mainCandidates.find(c => fsv.isFile(c));
        if (hit) return fsv.realpath(hit);
      }
    }
    return undefined;
  };
}

/**
 * Node's own resolver (`createRequire(<dir>/noop.js).resolve(request)`) tried from each dir, falling back
 * to the fs walk when the package blocks the request through an `exports` map.
 */
export function createNodeResolveFn(fsv: FsView = nodeFs): ResolveFn {
  const fallback = createFsResolveFn(fsv);
  return (request, fromDirs) => {
    for (const dir of fromDirs) {
      try {
        const req = createRequire(path.join(normalizePath(dir), '__hyperjest_resolve__.js'));
        return fsv.realpath(req.resolve(request));
      } catch (e) {
        const code = (e as NodeJS.ErrnoException | undefined)?.code;
        if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
          const viaFs = fallback(request, [dir]);
          if (viaFs) return viaFs;
        }
      }
    }
    return fallback(request, fromDirs);
  };
}

export interface ResolvedPackage {
  name: string;
  /** Real directory of the package (dirname of its package.json). */
  pkgDir: string;
  packageJsonPath: string;
  version: string;
  pkg: PackageJsonLike;
}

/** Resolve a package's directory and version from any of `fromDirs`. */
export function resolvePackage(name: string, fromDirs: string[], resolve: ResolveFn, fsv: FsView): ResolvedPackage | undefined {
  const packageJsonPath = resolve(`${name}/package.json`, fromDirs);
  if (!packageJsonPath) return undefined;
  const pkg = readJson<PackageJsonLike>(packageJsonPath, fsv);
  if (!pkg) return undefined;
  return { name, pkgDir: path.dirname(packageJsonPath), packageJsonPath, version: typeof pkg.version === 'string' ? pkg.version : '0.0.0', pkg };
}

/** Chain step: resolve `name` the way `basePkgDir`'s own code would (`require.resolve` from inside it). */
export function resolveFromPackage(name: string, basePkgDir: string, resolve: ResolveFn, fsv: FsView): ResolvedPackage | undefined {
  return resolvePackage(name, [basePkgDir], resolve, fsv);
}

export interface JestResolution {
  pkgDir: string;
  version: string;
  major: number;
  /** `<pkgDir>/bin/jest.js` */
  binPath: string;
  binExists: boolean;
  packageJsonPath: string;
  /** Which of the start dirs produced the hit. */
  resolvedFrom: string;
}

/** Lowest Jest major HyperJest drives (the warm engine relies on 29+ `TestRunner` / circus APIs). */
export const MIN_SUPPORTED_JEST_MAJOR = 29;

export function jestMajor(version: string): number {
  const m = /^(\d+)/.exec(version.trim().replace(/^[v^~>=<\s]+/, ''));
  return m ? Number(m[1]) : 0;
}

export function isSupportedJestVersion(version: string): boolean {
  return jestMajor(version) >= MIN_SUPPORTED_JEST_MAJOR;
}

/**
 * Resolve the `jest` package from the first of `startDirs` that can see one (e.g. `[packageDir]`).
 * Never consults `node_modules/.bin`.
 */
export function resolveJest(startDirs: string[], resolve: ResolveFn, fsv: FsView): JestResolution | undefined {
  for (const dir of startDirs) {
    const r = resolvePackage('jest', [dir], resolve, fsv);
    if (!r) continue;
    const binPath = path.join(r.pkgDir, 'bin', 'jest.js');
    return { pkgDir: r.pkgDir, version: r.version, major: jestMajor(r.version), binPath, binExists: fsv.isFile(binPath), packageJsonPath: r.packageJsonPath, resolvedFrom: dir };
  }
  return undefined;
}

/** Package -> the package it must be resolved from (plan "Warm engine" step 3). */
export const JEST_CHAIN: ReadonlyArray<readonly [name: string, from: string]> = [
  ['jest-cli', 'jest'],
  ['@jest/core', 'jest-cli'],
  ['jest-config', '@jest/core'],
  ['jest-runtime', '@jest/core'],
  ['jest-runner', '@jest/core'],
  ['jest-watcher', '@jest/core'],
  ['jest-resolve-dependencies', '@jest/core'],
  ['jest-resolve', 'jest-runtime'],
  ['@jest/transform', 'jest-runtime'],
  ['jest-message-util', 'jest-runner'],
  ['jest-util', 'jest-runner'],
  ['pretty-format', 'jest-runner'],
  ['@babel/core', '@jest/transform'],
];

/**
 * Resolve the whole Jest package chain from a resolved `jest` directory. Missing links are reported in
 * `missing` rather than thrown so Doctor can show partial chains.
 */
export function resolveJestChain(jestPkgDir: string, resolve: ResolveFn, fsv: FsView): { packages: Record<string, ResolvedPackage>; missing: string[] } {
  const packages: Record<string, ResolvedPackage> = {};
  const missing: string[] = [];
  const jestPkg = readJson<PackageJsonLike>(path.join(jestPkgDir, 'package.json'), fsv);
  packages.jest = { name: 'jest', pkgDir: jestPkgDir, packageJsonPath: path.join(jestPkgDir, 'package.json'), version: jestPkg?.version ?? '0.0.0', pkg: jestPkg ?? {} };
  for (const [name, from] of JEST_CHAIN) {
    const base = packages[from];
    if (!base) {
      missing.push(name);
      continue;
    }
    const r = resolveFromPackage(name, base.pkgDir, resolve, fsv);
    if (r) packages[name] = r;
    else missing.push(name);
  }
  return { packages, missing };
}

/** First version-like number in a dependency range (`^27.4.7` -> 27, `>=29 <31` -> 29). */
export function declaredMajor(range: string | undefined): number | undefined {
  if (!range) return undefined;
  const m = /(\d+)(?:\.\d+)?(?:\.\d+)?/.exec(range);
  return m ? Number(m[1]) : undefined;
}
