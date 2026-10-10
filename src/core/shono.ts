/**
 * Wix `shono testjs` resolution, replicating the CLI (verified against
 * `@wix/shono/index.js`, `@wix/shono-lib/index.js`, `@wix/shono-testjs/dist/src/index.js` 9.134/9.136
 * and `@wix/yarn-workspace-utils/dist/index.js` in mobile-modules):
 *
 *  - `shono` bin:      `@wix/shono` from the package dir -> `requireResolve('@wix/shono-lib', shonoDir)`
 *                      (paths = [shonoDir, cwd]) -> shono-cli loads commands, `testjs` comes from
 *                      `@wix/shono-testjs` resolved from shono-lib's dir (paths = [shonoLibDir, cwd]).
 *  - Packages that depend on `@wix/shono-lib` directly skip the first hop.
 *  - testjs command:   `RNTL_SKIP_AUTO_DETECT_FAKE_TIMERS=true NODE_OPTIONS="--max_old_space_size=4096"
 *                      <resolveBinFromPackage('jest', testjsDir)> -c <testjsDir>/jestConfig.js`
 *                      with `USE_HEADLESS_PB=true` always prepended, and for one-app modules
 *                      (`package.json: wix.isOneAppModule === true`, read from cwd)
 *                      `NODE_PATH=$NODE_PATH:<dirname(require.resolve('@wix/wix-one-app-engine', testjsDir))>/node_modules:<cwd>/node_modules`.
 *
 * `jest` is therefore resolved from the shono-testjs dir first (engine: nested 29.7 under shono-testjs
 * even though the repo root has 30.4.2), then from the package dir.
 *
 * Pure: no fs side effects, no 'vscode'. This module never loads jestConfig.js (it runs `patchFiles()`).
 */
import * as path from 'path';
import { FsView, PackageJsonLike } from './paths';
import { ResolveFn, ResolvedPackage, resolvePackage } from './jestResolver';

/** Environment the shono CLI always sets for `jest` (verified in shono-testjs index.js l.91 and l.112). */
export const SHONO_ENV: Readonly<Record<string, string>> = Object.freeze({
  RNTL_SKIP_AUTO_DETECT_FAKE_TIMERS: 'true',
  USE_HEADLESS_PB: 'true',
});

/** `NODE_OPTIONS="--max_old_space_size=4096"` expressed as a node argument (dash and underscore forms are equivalent). */
export const SHONO_NODE_ARGS: readonly string[] = Object.freeze(['--max-old-space-size=4096']);

export const SHONO_PACKAGE = '@wix/shono';
export const SHONO_LIB_PACKAGE = '@wix/shono-lib';
export const SHONO_TESTJS_PACKAGE = '@wix/shono-testjs';
export const ONE_APP_ENGINE_PACKAGE = '@wix/wix-one-app-engine';

export interface ShonoChain {
  shono?: ResolvedPackage;
  shonoLib?: ResolvedPackage;
  testjs: ResolvedPackage;
  /** `<testjsDir>/dist/src/jestConfig.js` */
  configArg: string;
  /** Directories to resolve `jest` from, in order: shono-testjs dir, then the package dir. */
  jestStartDirs: string[];
  env: Record<string, string>;
  nodeArgs: string[];
  isOneAppModule: boolean;
  /** `dirname(require.resolve('@wix/wix-one-app-engine'))` when resolvable. */
  engineDir?: string;
  /** Whether shono-testjs 9.136+ semantics apply (`tests/` is a unit-test folder, customNodeEnv). */
  unitTestsFolders: string[];
  warnings: string[];
}

export interface ShonoChainInput {
  packageDir: string;
  pkg: PackageJsonLike;
  /** Host `NODE_PATH` to prepend (the CLI does `NODE_PATH=$NODE_PATH:...`). */
  existingNodePath?: string;
  resolve: ResolveFn;
  fs: FsView;
}

export type ShonoChainResult = { ok: true; chain: ShonoChain } | { ok: false; error: string; tried: string[] };

/** `wix.isOneAppModule` marker, exactly as `@wix/shono-internal-utils` reads it (`readJSON(cwd/package.json).wix?.isOneAppModule`). */
export function isOneAppModule(pkg: PackageJsonLike | undefined): boolean {
  return !!pkg?.wix?.isOneAppModule;
}

/** Compare dotted versions numerically (`9.136.0` >= `9.136.0`). */
export function versionAtLeast(version: string, min: string): boolean {
  const a = version.split('.').map(n => parseInt(n, 10) || 0);
  const b = min.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** Folders whose `**\/*.spec.ts?(x)` files belong to shono's "Unit Tests" project (9.136 added `tests`). */
export function shonoUnitTestsFolders(testjsVersion: string): string[] {
  return versionAtLeast(testjsVersion, '9.136.0') ? ['unitTests', 'tests'] : ['unitTests'];
}

/**
 * Resolve the shono chain for a package exactly like the CLI would from `cwd = packageDir`.
 * Read-only: nothing is required/executed.
 */
export function resolveShonoChain(input: ShonoChainInput): ShonoChainResult {
  const { packageDir, pkg, resolve, fs } = input;
  const warnings: string[] = [];
  const tried: string[] = [];

  const shono = resolvePackage(SHONO_PACKAGE, [packageDir], resolve, fs);
  tried.push(`${SHONO_PACKAGE} from ${packageDir}${shono ? ` -> ${shono.pkgDir}` : ' (not found)'}`);

  // yarn-workspace-utils `requireResolve(name, relativeTo)` uses paths = [relativeTo, process.cwd()].
  const libFrom = shono ? [shono.pkgDir, packageDir] : [packageDir];
  const shonoLib = resolvePackage(SHONO_LIB_PACKAGE, libFrom, resolve, fs);
  tried.push(`${SHONO_LIB_PACKAGE} from ${libFrom.join(', ')}${shonoLib ? ` -> ${shonoLib.pkgDir}` : ' (not found)'}`);

  const testjsFrom = shonoLib ? [shonoLib.pkgDir, packageDir] : [packageDir];
  const testjs = resolvePackage(SHONO_TESTJS_PACKAGE, testjsFrom, resolve, fs);
  tried.push(`${SHONO_TESTJS_PACKAGE} from ${testjsFrom.join(', ')}${testjs ? ` -> ${testjs.pkgDir}` : ' (not found)'}`);
  if (!testjs) {
    return { ok: false, error: `${SHONO_TESTJS_PACKAGE} is not resolvable from ${packageDir}; run \`yarn install\` in the repo root`, tried };
  }

  const configArg = path.join(testjs.pkgDir, 'dist', 'src', 'jestConfig.js');
  if (!fs.isFile(configArg)) {
    return { ok: false, error: `${configArg} does not exist (shono-testjs ${testjs.version} layout changed?)`, tried };
  }
  if (!shono && !shonoLib) warnings.push(`${SHONO_PACKAGE}/${SHONO_LIB_PACKAGE} not found; using ${SHONO_TESTJS_PACKAGE} ${testjs.version} resolved directly from the package`);

  const env: Record<string, string> = { ...SHONO_ENV };
  const oneApp = isOneAppModule(pkg);
  let engineDir: string | undefined;
  if (oneApp) {
    const engineMain = resolve(ONE_APP_ENGINE_PACKAGE, [testjs.pkgDir, packageDir]);
    if (engineMain) {
      engineDir = path.dirname(engineMain);
    } else {
      const enginePkg = resolvePackage(ONE_APP_ENGINE_PACKAGE, [testjs.pkgDir, packageDir], resolve, fs);
      if (enginePkg) engineDir = path.dirname(path.join(enginePkg.pkgDir, typeof enginePkg.pkg.main === 'string' ? enginePkg.pkg.main : 'index.js'));
    }
    const segments = [input.existingNodePath, engineDir ? path.join(engineDir, 'node_modules') : undefined, path.join(packageDir, 'node_modules')].filter((s): s is string => !!s);
    env.NODE_PATH = segments.join(path.delimiter);
    if (!engineDir) warnings.push(`${ONE_APP_ENGINE_PACKAGE} is not resolvable from ${testjs.pkgDir}; NODE_PATH lacks the engine node_modules (the shono CLI would fail here)`);
  }

  return {
    ok: true,
    chain: {
      shono,
      shonoLib,
      testjs,
      configArg,
      jestStartDirs: [testjs.pkgDir, packageDir],
      env,
      nodeArgs: [...SHONO_NODE_ARGS],
      isOneAppModule: oneApp,
      engineDir,
      unitTestsFolders: shonoUnitTestsFolders(testjs.version),
      warnings,
    },
  };
}

/** One-line description of a resolved chain for logs and Doctor. */
export function describeShonoChain(chain: ShonoChain): string {
  const hop = (p: ResolvedPackage | undefined, label: string) => (p ? `${label}@${p.version}` : `${label}(-)`);
  return `${hop(chain.shono, 'shono')} -> ${hop(chain.shonoLib, 'shono-lib')} -> shono-testjs@${chain.testjs.version} (${chain.testjs.pkgDir})`;
}
