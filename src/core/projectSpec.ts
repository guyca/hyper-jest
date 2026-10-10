/**
 * Project discovery: package.json paths + a file-system view -> ProjectSpec[] (protocol.ts).
 *
 * Implements plan section "Project discovery" (host, static):
 *   1. candidates are package.json files (the host runs findFiles); node_modules, `.claude/worktrees`
 *      (unless a workspace folder lives inside) and `hyperjest.discovery.exclude` are dropped here too;
 *   2. repo root = nearest ancestor package.json with `workspaces`; package dir PK = the package.json dir,
 *      and PK is the cwd for everything;
 *   3. a package is a Jest package when its deps include `jest`, a script invokes `jest` / `shono testjs`,
 *      or a `jest.config.*` / package.json `jest` key exists; `node --test` / mocha / wdio / detox are notJest;
 *   4. flavor precedence: override > shono > script-config > implicit > projects;
 *   5. `jest` resolved by chain (shono: from the shono-testjs dir first), never `.bin`; missing -> unavailable,
 *      < 29 -> unsupported;
 *   6. node picked by nodeResolver; warnings carry every fallback and incompatibility.
 *
 * Pure: no 'vscode', no process-global reads except through the injected `env`; fs/resolve/exec injectable.
 */
import * as path from 'path';
import picomatch from 'picomatch';
import { hashParts } from './hash';
import { JestResolution, MIN_SUPPORTED_JEST_MAJOR, ResolveFn, createNodeResolveFn, declaredMajor, resolveJest } from './jestResolver';
import { AsyncExecFn, ExecFn, PickNodeDeps, PickNodeResult, createDefaultAsyncExec, createDefaultExec, nodeVersionCacheKey, pickNode, validateNodeBinaryAsync } from './nodeResolver';
import {
  FsView, PackageJsonLike, findRepoRoot, hasWorkspaces, isExcludedWorktreePath, isUnderNodeModules, nodeFs, normalizePath,
  readJson, toPosix, workspaceGlobs, workspaceRelativePosix,
} from './paths';
import type { ProjectFlavor, ProjectSpec, ProjectStatus } from './protocol';
import {
  CommandInfo, NON_JEST_TEST_RUNNERS, Runner, allCommands, commandPriority, isE2eScriptName, isShonoConfigPath, nodeOptionsToArgs, sniffScripts,
} from './scriptSniffer';
import type { HyperJestSettings, ProjectOverride } from './settingsModel';
import { ShonoChain, resolveShonoChain } from './shono';
import { jestConfigExtOrderFor } from './testFileMatcher';

// ---------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------

export interface DiscoveryInput {
  packageJsonPaths: string[];
  settings: HyperJestSettings;
  homeDir: string;
  platform: NodeJS.Platform;
  /** Host process environment (read-only: PATH for node lookup, NODE_PATH for the shono merge, FNM_DIR...). */
  env?: Record<string, string | undefined>;
  /** Open workspace folders. A `.claude/worktrees/*` package survives only when a workspace folder is inside that worktree. */
  workspaceFolders?: string[];
  fs?: FsView;
  resolve?: ResolveFn;
  exec?: ExecFn;
  /** Shared `node -p process.version` cache (path -> version | null). */
  nodeVersionCache?: Map<string, string | null>;
  electronExecPath?: string;
  hostNodeVersion?: string;
  /** How deep below a package to look for nested `jest.config.*` (e.g. `e2e/jest.config.js`). Default 3; 0 disables. */
  nestedConfigDepth?: number;
}

export type SkipReason = 'nodeModules' | 'worktree' | 'excluded' | 'invalidJson' | 'noTests' | 'workspaceRoot' | 'duplicate';

export interface SkippedPackage {
  packageJsonPath: string;
  packageDir: string;
  reason: SkipReason;
  detail?: string;
}

export interface DiscoveryResult {
  specs: ProjectSpec[];
  skipped: SkippedPackage[];
}

export interface PackageDiscovery {
  packageDir: string;
  repoRoot?: string;
  specs: ProjectSpec[];
  skipped?: SkippedPackage;
  /** Resolved shono chain when the package is a shono package (for Doctor / logs). */
  shono?: ShonoChain;
}

// ---------------------------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------------------------

interface Ctx {
  settings: HyperJestSettings;
  homeDir: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  workspaceFolders: string[];
  fs: FsView;
  resolve: ResolveFn;
  nodeDeps: PickNodeDeps;
  electronExecPath?: string;
  hostNodeVersion?: string;
  nestedConfigDepth: number;
  isExcluded: (relOrAbsPosix: string) => boolean;
  isE2ePath: (relPosix: string) => boolean;
  caches: {
    repoRoot: Map<string, string>;
    jest: Map<string, JestResolution | undefined>;
    node: Map<string, PickNodeResult>;
    seenDirs: Set<string>;
  };
}

function createCtx(input: DiscoveryInput): Ctx {
  const fs = input.fs ?? nodeFs;
  const excludeGlobs = input.settings.discovery.exclude ?? [];
  const e2eGlobs = input.settings.discovery.e2ePatterns ?? [];
  const excludeMatch = excludeGlobs.length ? picomatch(excludeGlobs, { dot: true }) : () => false;
  const e2eMatch = e2eGlobs.length ? picomatch(e2eGlobs, { dot: true }) : () => false;
  return {
    settings: input.settings,
    homeDir: input.homeDir,
    platform: input.platform,
    env: input.env ?? {},
    workspaceFolders: (input.workspaceFolders ?? []).map(normalizePath),
    fs,
    resolve: input.resolve ?? createNodeResolveFn(fs),
    nodeDeps: { fs, exec: input.exec ?? createDefaultExec(), versionCache: input.nodeVersionCache ?? new Map() },
    electronExecPath: input.electronExecPath,
    hostNodeVersion: input.hostNodeVersion,
    nestedConfigDepth: input.nestedConfigDepth ?? 3,
    isExcluded: p => excludeMatch(p),
    isE2ePath: p => e2eMatch(p),
    caches: { repoRoot: new Map(), jest: new Map(), node: new Map(), seenDirs: new Set() },
  };
}

// ---------------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------------

/** Full discovery with skip reasons (Doctor). Output is deterministic: sorted by repoRoot, packageDir, displayName. */
export function discoverProjects(input: DiscoveryInput): DiscoveryResult {
  const ctx = createCtx(input);
  const specs: ProjectSpec[] = [];
  const skipped: SkippedPackage[] = [];
  const byId = new Map<string, ProjectSpec>();
  for (const p of input.packageJsonPaths) {
    const d = discoverPackage(p, ctx);
    if (d.skipped) skipped.push(d.skipped);
    for (const spec of d.specs) {
      const existing = byId.get(spec.id);
      if (existing) {
        mergeDuplicate(existing, spec);
        continue;
      }
      byId.set(spec.id, spec);
      specs.push(spec);
    }
  }
  specs.sort((a, b) => a.repoRoot.localeCompare(b.repoRoot) || a.packageDir.localeCompare(b.packageDir) || a.displayName.localeCompare(b.displayName));
  skipped.sort((a, b) => a.packageDir.localeCompare(b.packageDir));
  return { specs, skipped };
}

/**
 * discoverProjects without synchronous `node -p process.version` spawns: dry passes (whose exec never
 * spawns, on a copy of the version cache) collect the binaries discovery wants validated, those are
 * validated concurrently with `execAsync` into `nodeVersionCache`, and the first pass that needs no
 * spawn is the result. After `maxRounds` the last pass falls back to the synchronous exec.
 */
export async function discoverProjectsAsync(input: DiscoveryInput & { execAsync?: AsyncExecFn; maxRounds?: number }): Promise<DiscoveryResult> {
  const cache = input.nodeVersionCache ?? new Map<string, string | null>();
  const execAsync = input.execAsync ?? createDefaultAsyncExec();
  for (let round = 0; round < (input.maxRounds ?? 3); round++) {
    const misses = new Map<string, { file: string; env?: Record<string, string> }>();
    const result = discoverProjects({
      ...input,
      nodeVersionCache: new Map(cache),
      exec: (file, _args, env) => { misses.set(nodeVersionCacheKey(file, env), { file, env }); return undefined; },
    });
    if (!misses.size) return result;
    await Promise.all([...misses.values()].map(m => validateNodeBinaryAsync(m.file, cache, execAsync, m.env)));
  }
  return discoverProjects({ ...input, nodeVersionCache: cache });
}

/** The plan's `buildProjectSpecs`: discovery output as the registry consumes it. */
export function buildProjectSpecs(input: DiscoveryInput): ProjectSpec[] {
  return discoverProjects(input).specs;
}

/** Stable id (contract: sha1 over packageDir + configArg). */
export function computeSpecId(packageDir: string, configArg: string | undefined): string {
  return hashParts([normalizePath(packageDir), configArg ? normalizePath(configArg) : undefined]);
}

function mergeDuplicate(into: ProjectSpec, dup: ProjectSpec): void {
  for (const p of dup.cliFilters.testPathIgnorePatterns) if (!into.cliFilters.testPathIgnorePatterns.includes(p)) into.cliFilters.testPathIgnorePatterns.push(p);
  if (dup.cliFilters.testPathPatterns?.length) {
    const merged = into.cliFilters.testPathPatterns ?? [];
    for (const p of dup.cliFilters.testPathPatterns) if (!merged.includes(p)) merged.push(p);
    into.cliFilters.testPathPatterns = merged;
  }
  for (const w of dup.warnings) if (!into.warnings.includes(w)) into.warnings.push(w);
}

// ---------------------------------------------------------------------------------------------
// Per-package discovery
// ---------------------------------------------------------------------------------------------

/** Internal candidate before Jest / Node resolution. */
interface Candidate {
  flavor: ProjectFlavor;
  configArg?: string;
  cliFilters: { testPathIgnorePatterns: string[]; testPathPatterns: string[] };
  env: Record<string, string>;
  nodeArgs: string[];
  /** Directories to resolve `jest` from, in order. */
  jestStartDirs: string[];
  /** Suffix appended to the package name in displayName. */
  displaySuffix?: string;
  warnings: string[];
  /** Pre-decided status (notJest / unavailable / disabled) that skips Jest / Node resolution. */
  status?: ProjectStatus;
  reason?: string;
  nodePathOverride?: string;
}

const NESTED_SCAN_SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', 'ios', 'android', 'Pods', 'lib', 'out', '.yarn', '.claude']);
/** Dependencies that identify a non-Jest test stack when no script runs Jest (mocha, WebdriverIO/Appium incl. Wix wrappers, detox, vitest, ...). */
const NON_JEST_DEP_PATTERN = /^(mocha|@wdio\/.+|webdriverio|@wix-pilot\/webdriverio.*|@wix\/applot|appium|vitest|detox|@playwright\/test|cypress|ava|tap)$/;

/** Discover one package.json. Exported for Doctor-style per-package reports. */
export function discoverPackage(packageJsonPath: string, ctxOrInput: Ctx | DiscoveryInput): PackageDiscovery {
  const ctx: Ctx = 'caches' in ctxOrInput ? ctxOrInput : createCtx(ctxOrInput);
  const { fs, settings } = ctx;
  const pkgJson = fs.realpath(normalizePath(packageJsonPath));
  const packageDir = path.dirname(pkgJson);
  const skip = (reason: SkipReason, detail?: string): PackageDiscovery => ({ packageDir, specs: [], skipped: { packageJsonPath: pkgJson, packageDir, reason, detail } });

  if (ctx.caches.seenDirs.has(packageDir)) return skip('duplicate', 'same real directory seen through another path');
  ctx.caches.seenDirs.add(packageDir);
  if (isUnderNodeModules(pkgJson)) return skip('nodeModules');
  if (isExcludedWorktreePath(pkgJson, ctx.workspaceFolders)) return skip('worktree', 'inside .claude/worktrees and no workspace folder opened there');
  if (ctx.isExcluded(workspaceRelativePosix(pkgJson, ctx.workspaceFolders))) return skip('excluded', 'matches hyperjest.discovery.exclude');

  const pkg = readJson<PackageJsonLike>(pkgJson, fs);
  if (!pkg || typeof pkg !== 'object') return skip('invalidJson');

  const repoRoot = repoRootFor(packageDir, ctx);
  const baseName = typeof pkg.name === 'string' && pkg.name ? pkg.name : path.basename(packageDir);
  const override = findOverride(packageDir, ctx);

  if (override?.disabled) {
    return { packageDir, repoRoot, specs: [finalize({ flavor: 'override', cliFilters: emptyFilters(), env: {}, nodeArgs: [], jestStartDirs: [packageDir], warnings: [], status: 'disabled', reason: 'disabled by hyperjest.projects' }, pkg, baseName, packageDir, repoRoot, override, ctx)] };
  }

  // --- evidence -------------------------------------------------------------------------------
  const scripts = sniffScripts(pkg.scripts);
  const cmds = allCommands(scripts);
  const jestCmds = cmds.filter(c => c.runner === 'jest');
  const shonoCmds = cmds.filter(c => c.runner === 'shono-testjs' || (c.runner === 'jest' && isShonoConfigPath(c.jest?.configArg)));
  const plainJestCmds = jestCmds.filter(c => !isShonoConfigPath(c.jest?.configArg));
  const nonJestCmds = cmds.filter(c => (NON_JEST_TEST_RUNNERS as readonly Runner[]).includes(c.runner));
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const hasJestDep = Object.prototype.hasOwnProperty.call(deps, 'jest');
  const nonJestDeps = Object.keys(deps).filter(d => NON_JEST_DEP_PATTERN.test(d));
  const jestMajorHint = (ctx.caches.jest.get(packageDir) ?? resolveJestCached([packageDir], ctx))?.major;
  const implicitHere = implicitConfigCandidates(packageDir, fs, jestMajorHint, pkg);
  const hasConfig = implicitHere.candidates.length > 0;
  const hasJestEvidence = hasJestDep || plainJestCmds.length > 0 || shonoCmds.length > 0 || hasConfig || !!override?.configArg;

  if (!hasJestEvidence) {
    if (nonJestCmds.length || nonJestDeps.length) {
      const c = nonJestCmds[0];
      const reason = c ? `tests run with ${c.runner} (script "${c.script}": ${c.bin})` : `test dependencies are ${nonJestDeps.join(', ')}, not Jest`;
      return { packageDir, repoRoot, specs: [finalize({ flavor: 'implicit', cliFilters: emptyFilters(), env: {}, nodeArgs: [], jestStartDirs: [packageDir], warnings: [], status: 'notJest', reason }, pkg, baseName, packageDir, repoRoot, override, ctx)] };
    }
    return skip('noTests', 'no jest dependency, script, config or jest key');
  }
  // Scripts are the source of truth: when every test script runs a non-Jest runner, a jest dependency or a
  // (possibly empty) jest key / config is vestigial (engine mobile-apps-generate-module-manifest: `jest: {}` + `node tests/*.test.js`).
  if (nonJestCmds.length && !plainJestCmds.length && !shonoCmds.length && !override?.configArg) {
    const c = nonJestCmds[0];
    const unused = hasConfig ? `; unused Jest config: ${implicitHere.candidates.map(p => path.relative(packageDir, p)).join(', ')}` : '';
    const reason = `tests run with ${c.runner} (script "${c.script}": ${c.bin})${unused}`;
    return { packageDir, repoRoot, specs: [finalize({ flavor: 'implicit', cliFilters: emptyFilters(), env: {}, nodeArgs: [], jestStartDirs: [packageDir], warnings: [], status: 'notJest', reason }, pkg, baseName, packageDir, repoRoot, override, ctx)] };
  }
  const depsOnly = hasJestDep && !plainJestCmds.length && !shonoCmds.length && !hasConfig && !override?.configArg;
  if (depsOnly && hasWorkspaces(pkg)) return skip('workspaceRoot', 'jest is only a dependency of the workspace root; tests run per package');
  if (depsOnly && (nonJestCmds.length || nonJestDeps.length)) {
    const c = nonJestCmds[0];
    const reason = c ? `jest is only a dependency; tests run with ${c.runner} (script "${c.script}")` : `jest is only a dependency; test tooling is ${nonJestDeps.join(', ')}`;
    return { packageDir, repoRoot, specs: [finalize({ flavor: 'implicit', cliFilters: emptyFilters(), env: {}, nodeArgs: [], jestStartDirs: [packageDir], warnings: [], status: 'notJest', reason }, pkg, baseName, packageDir, repoRoot, override, ctx)] };
  }

  // --- candidates ----------------------------------------------------------------------------
  const packageWarnings: string[] = [];
  const candidates: Candidate[] = [];
  let shono: ShonoChain | undefined;

  if (override?.configArg) {
    const configArg = path.resolve(packageDir, override.configArg);
    const c: Candidate = { flavor: 'override', configArg, cliFilters: emptyFilters(), env: {}, nodeArgs: [], jestStartDirs: [packageDir], warnings: [], displaySuffix: path.relative(packageDir, configArg) || undefined };
    if (!fs.isFile(configArg)) c.warnings.push(`hyperjest.projects configArg ${override.configArg} does not exist`);
    candidates.push(c);
  } else {
    const preferScripts = settings.discovery.preferScriptConfigs;
    const shonoWanted = settings.shono.enabled && shonoCmds.length > 0;
    const scriptConfigCmds = plainJestCmds.filter(c => c.jest?.configArg);
    const implicitCmds = plainJestCmds.filter(c => !c.jest?.configArg);

    if (!preferScripts && hasConfig) {
      if (shonoWanted || scriptConfigCmds.length) packageWarnings.push('hyperjest.discovery.preferScriptConfigs is false: script-referenced configs were ignored in favour of the implicit Jest config');
      candidates.push(implicitCandidate(implicitHere, implicitCmds, packageDir, ctx));
    } else if (shonoWanted) {
      const r = resolveShonoChain({ packageDir, pkg, existingNodePath: ctx.env.NODE_PATH, resolve: ctx.resolve, fs });
      const primary = pickPrimary(shonoCmds);
      if (r.ok) {
        shono = r.chain;
        const filters = emptyFilters();
        if (primary?.shono?.fileName) filters.testPathPatterns.push(primary.shono.fileName);
        if (primary?.jest) {
          filters.testPathIgnorePatterns.push(...primary.jest.testPathIgnorePatterns);
          filters.testPathPatterns.push(...primary.jest.testPathPatterns);
        }
        const env = { ...r.chain.env };
        const nodeArgs = [...r.chain.nodeArgs];
        if (primary) mergeCommandEnv(primary, env, nodeArgs, ctx.env);
        candidates.push({ flavor: 'shono', configArg: r.chain.configArg, cliFilters: filters, env, nodeArgs, jestStartDirs: r.chain.jestStartDirs, displaySuffix: 'shono', warnings: [...r.chain.warnings] });
      } else {
        candidates.push({ flavor: 'shono', cliFilters: emptyFilters(), env: {}, nodeArgs: [], jestStartDirs: [packageDir], warnings: [], status: 'unavailable', reason: r.error, displaySuffix: 'shono' });
      }
      if (hasConfig) packageWarnings.push(`Implicit Jest config ignored (${implicitHere.candidates.map(c => path.relative(packageDir, c)).join(', ')}): scripts run \`shono testjs\``);
      if (scriptConfigCmds.length) packageWarnings.push(`Script config(s) ignored in favour of shono: ${[...new Set(scriptConfigCmds.map(c => c.jest!.configArg!))].join(', ')}`);
    } else {
      if (shonoCmds.length && !settings.shono.enabled) packageWarnings.push('Scripts run `shono testjs` but hyperjest.shono.enabled is false');
      const byConfig = new Map<string, CommandInfo[]>();
      for (const c of scriptConfigCmds) {
        const abs = path.resolve(packageDir, c.jest!.configArg!);
        const list = byConfig.get(abs) ?? [];
        list.push(c);
        byConfig.set(abs, list);
      }
      for (const [configArg, list] of byConfig) {
        if (!fs.isFile(configArg)) {
          packageWarnings.push(`Script "${list[0].script}" references missing Jest config ${path.relative(packageDir, configArg)}`);
          continue;
        }
        const primary = pickPrimary(list)!;
        const c = scriptConfigCandidate(configArg, primary, list, packageDir, ctx);
        candidates.push(c);
      }
      if (implicitCmds.length || !scriptConfigCmds.length) {
        candidates.push(implicitCandidate(implicitHere, implicitCmds, packageDir, ctx));
      } else if (hasConfig) {
        packageWarnings.push(`Implicit Jest config ${implicitHere.candidates.map(c => path.relative(packageDir, c)).join(', ')} is not used by any test script; using the script configs`);
      }
    }
  }

  // Nested configs below the package (e.g. wix-one-app-engine/e2e/jest.config.js) that belong to no sub-package.
  if (ctx.nestedConfigDepth > 0) {
    const taken = new Set(candidates.map(c => c.configArg).filter((x): x is string => !!x));
    for (const nested of findNestedConfigs(packageDir, ctx.nestedConfigDepth, fs, jestMajorHint)) {
      if (taken.has(nested)) continue;
      const rel = toPosix(path.relative(packageDir, nested));
      const e2e = isE2eConfig(nested, rel, ctx);
      candidates.push({
        flavor: 'implicit',
        configArg: nested,
        cliFilters: emptyFilters(),
        env: {},
        nodeArgs: [],
        jestStartDirs: [packageDir],
        displaySuffix: path.dirname(rel),
        warnings: [],
        ...(e2e ? { status: 'notJest' as const, reason: `e2e config (${e2e}) — excluded from unit runs` } : {}),
      });
    }
  }

  const specs = candidates.map(c => finalize({ ...c, warnings: [...packageWarnings, ...c.warnings] }, pkg, baseName, packageDir, repoRoot, override, ctx));
  return { packageDir, repoRoot, specs, shono };
}

// ---------------------------------------------------------------------------------------------
// Candidate builders
// ---------------------------------------------------------------------------------------------

function emptyFilters(): Candidate['cliFilters'] {
  return { testPathIgnorePatterns: [], testPathPatterns: [] };
}

/** Lowest-priority-number command (script `test` first), stable on ties. */
function pickPrimary(cmds: CommandInfo[]): CommandInfo | undefined {
  let best: CommandInfo | undefined;
  let bestP = Infinity;
  for (const c of cmds) {
    const p = commandPriority(c);
    if (p < bestP) {
      best = c;
      bestP = p;
    }
  }
  return best;
}

/** Expand `$VAR`, `${VAR}` and `${VAR:-default}` with the host env (shell semantics for script prefixes). */
export function expandShellVars(value: string, env: Record<string, string | undefined>): string {
  return value
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, def: string | undefined) => env[name] ?? def ?? '')
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => env[name] ?? '');
}

/** Merge a command's env prefixes into a candidate: NODE_OPTIONS become node args, the rest is expanded env. */
function mergeCommandEnv(cmd: CommandInfo, env: Record<string, string>, nodeArgs: string[], hostEnv: Record<string, string | undefined>): void {
  for (const [k, raw] of Object.entries(cmd.env)) {
    const v = expandShellVars(raw, { ...hostEnv, ...env });
    if (k === 'NODE_OPTIONS') {
      for (const a of nodeOptionsToArgs(v)) if (!nodeArgs.includes(a) && !nodeArgs.includes(a.replace(/_/g, '-'))) nodeArgs.push(a);
      continue;
    }
    env[k] = v;
  }
}

function scriptConfigCandidate(configArg: string, primary: CommandInfo, all: CommandInfo[], packageDir: string, ctx: Ctx): Candidate {
  const rel = toPosix(path.relative(packageDir, configArg));
  const filters = emptyFilters();
  filters.testPathIgnorePatterns.push(...(primary.jest?.testPathIgnorePatterns ?? []));
  filters.testPathPatterns.push(...(primary.jest?.testPathPatterns ?? []));
  const env: Record<string, string> = {};
  const nodeArgs: string[] = [];
  mergeCommandEnv(primary, env, nodeArgs, ctx.env);
  const c: Candidate = { flavor: 'script-config', configArg, cliFilters: filters, env, nodeArgs, jestStartDirs: [packageDir], displaySuffix: rel, warnings: [] };
  const e2e = isE2eConfig(configArg, rel, ctx) ?? (all.every(x => isE2eScriptName(x.script) || x.via.some(isE2eScriptName)) ? 'e2e script' : undefined);
  if (e2e) {
    c.status = 'notJest';
    c.reason = `e2e config (${e2e}) — excluded from unit runs`;
  }
  return c;
}

function implicitCandidate(implicit: ImplicitResolution, implicitCmds: CommandInfo[], packageDir: string, ctx: Ctx): Candidate {
  const primary = pickPrimary(implicitCmds);
  const filters = emptyFilters();
  filters.testPathIgnorePatterns.push(...(primary?.jest?.testPathIgnorePatterns ?? []));
  filters.testPathPatterns.push(...(primary?.jest?.testPathPatterns ?? []));
  const env: Record<string, string> = {};
  const nodeArgs: string[] = [];
  if (primary) mergeCommandEnv(primary, env, nodeArgs, ctx.env);
  const c: Candidate = { flavor: 'implicit', cliFilters: filters, env, nodeArgs, jestStartDirs: [packageDir], warnings: [] };
  if (implicit.candidates.length > 1) {
    const names = implicit.candidates.map(p => path.relative(packageDir, p));
    c.configArg = implicit.candidates[0];
    c.warnings.push(`multipleConfigs: ${names.join(', ')} — plain \`jest\` fails with "Multiple configurations found"; HyperJest uses ${names[0]} (override with hyperjest.projects[].configArg)`);
  }
  return c;
}

// ---------------------------------------------------------------------------------------------
// Jest's implicit config resolution (jest-config resolveConfigPath.js 29.7 / index.js 30.x)
// ---------------------------------------------------------------------------------------------

export interface ImplicitResolution {
  /** Config candidates at the directory in Jest's order (`jest.config.<ext>` in ext order, then package.json when it has a `jest` key). */
  candidates: string[];
  /** True when a package.json exists here (it terminates Jest's upward walk even without a `jest` key). */
  terminatedByPackageJson: boolean;
}

/** Jest's candidate rule at ONE directory. */
export function implicitConfigCandidates(dir: string, fs: FsView, jestMajor: number | undefined, pkg?: PackageJsonLike): ImplicitResolution {
  const candidates = jestConfigExtOrderFor(jestMajor).map(ext => path.join(dir, `jest.config${ext}`)).filter(p => fs.isFile(p));
  const pkgPath = path.join(dir, 'package.json');
  const hasPkg = fs.isFile(pkgPath);
  const pkgJson = pkg ?? (hasPkg ? readJson<PackageJsonLike>(pkgPath, fs) : undefined);
  if (hasPkg && pkgJson && Object.prototype.hasOwnProperty.call(pkgJson, 'jest')) candidates.push(pkgPath);
  return { candidates, terminatedByPackageJson: hasPkg };
}

/**
 * Jest's upward traversal from `startDir`, bounded by `packageDir` (whose package.json terminates it anyway).
 * Returns the directory where the walk stopped and its candidates (0 = Jest defaults, 1 = the config, >1 = "Multiple configurations").
 */
export function resolveImplicitConfig(startDir: string, packageDir: string, fs: FsView, jestMajor: number | undefined): { dir: string; candidates: string[] } {
  let dir = normalizePath(startDir);
  const stop = normalizePath(packageDir);
  for (;;) {
    const r = implicitConfigCandidates(dir, fs, jestMajor);
    if (r.candidates.length || r.terminatedByPackageJson || dir === stop) return { dir, candidates: r.candidates };
    const parent = path.dirname(dir);
    if (parent === dir) return { dir, candidates: [] };
    dir = parent;
  }
}

/** `jest.config.*` files below `packageDir` in directories that have no package.json of their own. */
export function findNestedConfigs(packageDir: string, depth: number, fs: FsView, jestMajor: number | undefined): string[] {
  const out: string[] = [];
  const walk = (dir: string, level: number) => {
    for (const name of fs.readdir(dir)) {
      if (NESTED_SCAN_SKIP.has(name) || name.startsWith('.')) continue;
      const sub = path.join(dir, name);
      if (!fs.isDirectory(sub)) continue;
      if (fs.isFile(path.join(sub, 'package.json'))) continue; // its own package
      out.push(...implicitConfigCandidates(sub, fs, jestMajor).candidates);
      if (level + 1 < depth) walk(sub, level + 1);
    }
  };
  if (depth > 0) walk(packageDir, 0);
  return out;
}

/** Why a config is e2e (pattern or detox marker), or undefined when it is a unit config. */
function isE2eConfig(configPath: string, relPosix: string, ctx: Ctx): string | undefined {
  if (ctx.isE2ePath(relPosix)) return `matches hyperjest.discovery.e2ePatterns`;
  const text = ctx.fs.readFile(configPath);
  // Only structural markers count (a unit config that merely ignores `/e2e/` or mentions detox in a comment must stay a unit config).
  if (text && /detox-wix-preset|require\('[^']*detox[^']*'\)|require\("[^"]*detox[^"]*"\)|from\s+['"][^'"]*detox|testEnvironment\s*:\s*['"][^'"]*detox|preset\s*:\s*['"][^'"]*detox|['"]detox\/runners/i.test(text)) return 'detox';
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Finalisation: Jest + Node resolution, env merge, id, displayName
// ---------------------------------------------------------------------------------------------

function repoRootFor(packageDir: string, ctx: Ctx): string {
  const cached = ctx.caches.repoRoot.get(packageDir);
  if (cached) return cached;
  let root = findRepoRoot(packageDir, ctx.fs);
  if (root !== packageDir) {
    // A package the root's `workspaces` globs do not include is a standalone project (e.g. a nested npm project with its own lockfile).
    const rootPkg = readJson<PackageJsonLike>(path.join(root, 'package.json'), ctx.fs);
    const globs = workspaceGlobs(rootPkg) ?? [];
    const rel = toPosix(path.relative(root, packageDir));
    const member = globs.length === 0 || picomatch(globs.map(g => g.replace(/\/+$/, '')), { dot: true })(rel);
    if (!member) root = packageDir;
  }
  ctx.caches.repoRoot.set(packageDir, root);
  return root;
}

function findOverride(packageDir: string, ctx: Ctx): ProjectOverride | undefined {
  for (const o of ctx.settings.projects ?? []) {
    if (!o?.packageDir) continue;
    const bases = path.isAbsolute(o.packageDir) ? [o.packageDir] : ctx.workspaceFolders.length ? ctx.workspaceFolders.map(f => path.join(f, o.packageDir)) : [path.resolve(o.packageDir)];
    if (bases.some(b => ctx.fs.realpath(normalizePath(b)) === packageDir)) return o;
  }
  return undefined;
}

function resolveJestCached(startDirs: string[], ctx: Ctx): JestResolution | undefined {
  const key = startDirs.join('\0');
  if (ctx.caches.jest.has(key)) return ctx.caches.jest.get(key);
  const r = resolveJest(startDirs, ctx.resolve, ctx.fs);
  ctx.caches.jest.set(key, r);
  return r;
}

function pickNodeCached(packageDir: string, repoRoot: string, settingNodePath: string | undefined, jestMajor: number | undefined, ctx: Ctx): PickNodeResult {
  const key = [packageDir, repoRoot, settingNodePath ?? '', jestMajor ?? ''].join('\0');
  const cached = ctx.caches.node.get(key);
  if (cached) return cached;
  const r = pickNode(
    { settingNodePath, packageDir, repoRoot, env: ctx.env, homeDir: ctx.homeDir, platform: ctx.platform, jestMajor, electronExecPath: ctx.electronExecPath, hostNodeVersion: ctx.hostNodeVersion },
    ctx.nodeDeps,
  );
  ctx.caches.node.set(key, r);
  return r;
}

function finalize(c: Candidate, pkg: PackageJsonLike, baseName: string, packageDir: string, repoRoot: string, override: ProjectOverride | undefined, ctx: Ctx): ProjectSpec {
  const { settings } = ctx;
  const warnings = [...c.warnings];
  let status: ProjectStatus = c.status ?? 'ok';
  let reason = c.reason;
  let jest: JestResolution | undefined;

  if (status !== 'disabled' && status !== 'notJest') {
    jest = resolveJestCached(c.jestStartDirs, ctx);
    if (!jest && status === 'ok') {
      status = 'unavailable';
      const declared = declaredMajor((pkg.devDependencies ?? {}).jest ?? (pkg.dependencies ?? {}).jest);
      const nmMissing = !ctx.fs.isDirectory(path.join(repoRoot, 'node_modules'));
      if (declared !== undefined && declared < MIN_SUPPORTED_JEST_MAJOR) {
        status = 'unsupported';
        reason = `package declares jest ${(pkg.devDependencies ?? {}).jest ?? (pkg.dependencies ?? {}).jest} (< ${MIN_SUPPORTED_JEST_MAJOR}); HyperJest needs Jest ${MIN_SUPPORTED_JEST_MAJOR}+`;
      } else if (nmMissing) {
        reason = `node_modules is not installed under ${repoRoot} — run \`yarn install\` there`;
      } else {
        reason = `jest is not resolvable from ${c.jestStartDirs.join(' or ')} — add jest to the package or run \`yarn install\``;
      }
    } else if (jest && status === 'ok') {
      if (jest.major < MIN_SUPPORTED_JEST_MAJOR) {
        status = 'unsupported';
        reason = `jest ${jest.version} at ${jest.pkgDir} is older than ${MIN_SUPPORTED_JEST_MAJOR}`;
      } else if (!jest.binExists) {
        warnings.push(`${jest.binPath} is missing; the CLI engine and Debug need it`);
      }
    }
  }

  let node: PickNodeResult | undefined;
  if (status !== 'disabled' && status !== 'notJest') {
    node = pickNodeCached(packageDir, repoRoot, c.nodePathOverride ?? override?.nodePath ?? settings.nodePath, jest?.major, ctx);
    warnings.push(...node.warnings);
  }

  const env: Record<string, string> = { ...c.env, ...(node?.env ?? {}), ...(settings.env ?? {}), ...(override?.env ?? {}) };
  const nodeArgs = dedupe([...c.nodeArgs, ...(settings.nodeArgs ?? [])]);
  const displayName = c.displaySuffix ? `${baseName} · ${c.displaySuffix}` : baseName;
  const spec: ProjectSpec = {
    id: computeSpecId(packageDir, c.configArg),
    displayName,
    repoRoot,
    packageDir,
    flavor: c.flavor,
    status,
    ...(reason ? { reason } : {}),
    ...(c.configArg ? { configArg: c.configArg } : {}),
    ...(jest ? { jestPkgDir: jest.pkgDir, jestVersion: jest.version, jestBinPath: jest.binPath } : {}),
    ...(node ? { nodePath: node.nodePath, ...(node.version ? { nodeVersion: node.version } : {}) } : {}),
    nodeArgs,
    env,
    cliFilters: { testPathIgnorePatterns: [...c.cliFilters.testPathIgnorePatterns], ...(c.cliFilters.testPathPatterns.length ? { testPathPatterns: [...c.cliFilters.testPathPatterns] } : {}) },
    e2ePatterns: [...(settings.discovery.e2ePatterns ?? [])],
    warnings: dedupe(warnings),
  };
  return spec;
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
