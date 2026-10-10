/**
 * Node binary selection for worker processes (plan "Project discovery" step 6).
 *
 * Order: `hyperjest.nodePath` setting -> `.nvmrc` / `.node-version` / `engines.node` (searched from the
 * package dir up to the repo root) matched against installed binaries (fnm, nvm, volta, asdf, n, Homebrew,
 * /usr/local) with exact -> major.minor -> major -> semver-range matching -> `node` on PATH -> Homebrew
 * -> the extension host's own executable with `ELECTRON_RUN_AS_NODE=1`.
 *
 * Each candidate is validated once by running `node -p process.version` (cached by path) and checked
 * against the Jest engines range (29: `^14.15.0 || ^16.10.0 || >=18.0.0`, 30: `^18.14.0 || ^20.0.0 ||
 * ^22.0.0 || >=24.0.0`, read from the installed jest/package.json files). Incompatibility is a warning,
 * not a failure: the user may still run.
 *
 * fs and exec are injectable so unit tests never touch the machine. No 'vscode'.
 */
import { execFile, spawnSync } from 'child_process';
import * as path from 'path';
import { FsView, PackageJsonLike, ancestorsUpTo, nodeFs, readJson } from './paths';

export type NodeSource = 'setting' | 'nvmrc' | 'node-version' | 'engines' | 'path' | 'homebrew' | 'electron';
export type NodeManager = 'fnm' | 'nvm' | 'volta' | 'asdf' | 'n' | 'homebrew' | 'path';

export interface NodeRequest {
  /** Raw spec (`24.19.0`, `v22`, `lts/*`, `>=20`). */
  spec: string;
  source: 'nvmrc' | 'node-version' | 'engines';
  /** File the spec came from. */
  file: string;
}

export interface InstalledNode {
  path: string;
  /** Known from the install path (fnm/nvm/volta/asdf/n); undefined until executed (homebrew/PATH). */
  version?: string;
  manager: NodeManager;
}

export type ExecResult = { status: number | null; stdout: string } | undefined;
/** Synchronous process runner; returns undefined when the binary cannot be spawned. */
export type ExecFn = (file: string, args: string[], env?: Record<string, string>) => ExecResult;
/** Asynchronous variant (keeps the extension-host thread free while a binary is validated). */
export type AsyncExecFn = (file: string, args: string[], env?: Record<string, string>) => Promise<ExecResult>;

export interface PickNodeInput {
  settingNodePath?: string;
  packageDir: string;
  repoRoot: string;
  env: Record<string, string | undefined>;
  homeDir: string;
  platform: NodeJS.Platform;
  /** Jest major the node must support (for the engines warning). */
  jestMajor?: number;
  /** `process.execPath` of the host (Electron) and its embedded Node version, for the last-resort fallback. */
  electronExecPath?: string;
  hostNodeVersion?: string;
}

export interface PickNodeDeps {
  fs: FsView;
  exec: ExecFn;
  /** path -> validated version (null = broken binary). Shared across calls to spawn each binary once. */
  versionCache: Map<string, string | null>;
}

export interface PickNodeResult {
  nodePath: string;
  version?: string;
  source: NodeSource;
  requested?: NodeRequest;
  /** Extra env the worker needs (`ELECTRON_RUN_AS_NODE=1` for the electron fallback). */
  env: Record<string, string>;
  warnings: string[];
}

// ---------------------------------------------------------------------------------------------
// Versions and ranges
// ---------------------------------------------------------------------------------------------

export interface Version {
  major: number;
  minor: number;
  patch: number;
}

/** Parse `v24.19.0` / `24.19.0` / `24.19` / `24` (missing parts -> 0). Undefined for anything else. */
export function parseVersion(v: string | undefined): Version | undefined {
  if (!v) return undefined;
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/.exec(v.trim());
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0) };
}

export function compareVersions(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function formatVersion(v: Version): string {
  return `v${v.major}.${v.minor}.${v.patch}`;
}

/** Node LTS code names -> major (for `lts/<name>` specs). */
export const LTS_CODENAMES: Readonly<Record<string, number>> = Object.freeze({
  argon: 4, boron: 6, carbon: 8, dubnium: 10, erbium: 12, fermium: 14, gallium: 16, hydrogen: 18, iron: 20, jod: 22, krypton: 24,
});

type Comparator = (v: Version) => boolean;

function partialToRange(spec: string): Comparator | undefined {
  // `24` -> >=24.0.0 <25.0.0 ; `24.19` -> >=24.19.0 <24.20.0 ; `24.19.0` -> exact
  const m = /^v?(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/i.exec(spec.trim());
  if (!m) return undefined;
  const isWild = (s: string | undefined) => s === undefined || s === 'x' || s === 'X' || s === '*';
  if (isWild(m[1])) return () => true;
  const major = Number(m[1]);
  if (isWild(m[2])) return v => v.major === major;
  const minor = Number(m[2]);
  if (isWild(m[3])) return v => v.major === major && v.minor === minor;
  const patch = Number(m[3]);
  return v => v.major === major && v.minor === minor && v.patch === patch;
}

function comparatorFor(token: string): Comparator | undefined {
  const t = token.trim();
  if (!t || t === '*' || t === 'x' || t === 'X') return () => true;
  const op = /^(>=|<=|>|<|=|\^|~)\s*v?(.*)$/.exec(t);
  if (!op) return partialToRange(t);
  const [, o, rest] = op;
  const pv = parseVersion(rest);
  if (!pv) return undefined;
  const parts = rest.replace(/^v/, '').split('.').length;
  switch (o) {
    case '>=': return v => compareVersions(v, pv) >= 0;
    case '>': return v => compareVersions(v, pv) > 0;
    case '<=': return v => compareVersions(v, pv) <= 0;
    case '<': return v => compareVersions(v, pv) < 0;
    case '=': return v => compareVersions(v, pv) === 0;
    case '^': {
      // ^1.2.3 -> >=1.2.3 <2.0.0 ; ^0.2.3 -> >=0.2.3 <0.3.0 ; ^0.0.3 -> >=0.0.3 <0.0.4 ; ^1 / ^1.2 widen like semver.
      let upper: Version;
      if (pv.major > 0) upper = { major: pv.major + 1, minor: 0, patch: 0 };
      else if (pv.minor > 0 || parts < 3) upper = { major: 0, minor: pv.minor + 1, patch: 0 };
      else upper = { major: 0, minor: pv.minor, patch: pv.patch + 1 };
      return v => compareVersions(v, pv) >= 0 && compareVersions(v, upper) < 0;
    }
    case '~': {
      const upper: Version = parts === 1 ? { major: pv.major + 1, minor: 0, patch: 0 } : { major: pv.major, minor: pv.minor + 1, patch: 0 };
      return v => compareVersions(v, pv) >= 0 && compareVersions(v, upper) < 0;
    }
  }
  return undefined;
}

/**
 * Minimal semver range evaluator: `||` alternatives of whitespace-separated comparators, `^`, `~`,
 * hyphen ranges, `x`/`*` wildcards, partial versions. Returns undefined when the range cannot be parsed.
 */
export function satisfiesRange(version: Version, range: string): boolean | undefined {
  const alternatives = range.split('||').map(s => s.trim()).filter(Boolean);
  if (!alternatives.length) return undefined;
  let parsedAny = false;
  for (const alt of alternatives) {
    const hyphen = /^v?(\S+)\s+-\s+v?(\S+)$/.exec(alt);
    const tokens = hyphen ? [`>=${hyphen[1]}`, `<=${hyphen[2]}`] : alt.split(/\s+/).filter(Boolean);
    // Normalise `>= 1.2.3` (operator separated from the version by whitespace).
    const merged: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      if (/^(>=|<=|>|<|=|\^|~)$/.test(tokens[i]) && i + 1 < tokens.length) merged.push(tokens[i] + tokens[++i]);
      else merged.push(tokens[i]);
    }
    const comparators = merged.map(comparatorFor);
    if (comparators.some(c => !c)) continue;
    parsedAny = true;
    if (comparators.every(c => c!(version))) return true;
  }
  return parsedAny ? false : undefined;
}

export type SpecKind = 'exact' | 'majorMinor' | 'major' | 'any' | 'lts' | 'range' | 'invalid';

/** Classify a version request. */
export function classifySpec(spec: string): { kind: SpecKind; major?: number; version?: Version } {
  const s = spec.trim();
  if (!s) return { kind: 'invalid' };
  const lower = s.toLowerCase();
  if (lower === 'node' || lower === 'latest' || lower === 'stable' || lower === 'current' || lower === 'lts/*' || lower === 'lts' || lower === '*') return { kind: 'any' };
  const lts = /^lts\/([a-z]+)$/.exec(lower);
  if (lts) {
    const major = LTS_CODENAMES[lts[1]];
    return major ? { kind: 'lts', major } : { kind: 'invalid' };
  }
  const plain = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(s);
  if (plain) {
    const version = parseVersion(s)!;
    if (plain[3] !== undefined) return { kind: 'exact', version, major: version.major };
    if (plain[2] !== undefined) return { kind: 'majorMinor', version, major: version.major };
    return { kind: 'major', major: version.major, version };
  }
  return { kind: 'range' };
}

/**
 * Pick the best installed version for a spec: exact -> same major.minor (highest patch) -> same major (highest)
 * -> highest satisfying a semver range. Returns undefined when nothing matches (or the spec is invalid).
 */
export function selectVersion<T extends { version: Version }>(spec: string, installed: readonly T[], preferred?: T): T | undefined {
  const cls = classifySpec(spec);
  const sorted = [...installed].sort((a, b) => compareVersions(b.version, a.version));
  const highest = (pred: (v: Version) => boolean): T | undefined => sorted.find(c => pred(c.version));
  switch (cls.kind) {
    case 'exact': {
      const v = cls.version!;
      return (
        highest(x => compareVersions(x, v) === 0) ??
        highest(x => x.major === v.major && x.minor === v.minor) ??
        highest(x => x.major === v.major)
      );
    }
    case 'majorMinor': {
      const v = cls.version!;
      return highest(x => x.major === v.major && x.minor === v.minor) ?? highest(x => x.major === v.major);
    }
    case 'major':
    case 'lts':
      return highest(x => x.major === cls.major);
    case 'any':
      return preferred ?? sorted[0];
    case 'range': {
      if (preferred && satisfiesRange(preferred.version, spec)) return preferred;
      return sorted.find(c => satisfiesRange(c.version, spec) === true);
    }
    default:
      return undefined;
  }
}

/** Jest's `engines.node` per major (verified in the installed jest/package.json of 29.7.0, 30.4.2 and 30.5.2). */
export const JEST_NODE_ENGINES: Readonly<Record<29 | 30, string>> = Object.freeze({
  29: '^14.15.0 || ^16.10.0 || >=18.0.0',
  30: '^18.14.0 || ^20.0.0 || ^22.0.0 || >=24.0.0',
});

export function jestNodeEnginesFor(jestMajor: number | undefined): string | undefined {
  if (jestMajor === undefined) return undefined;
  return jestMajor >= 30 ? JEST_NODE_ENGINES[30] : JEST_NODE_ENGINES[29];
}

/** True/false when known; undefined when either side is unknown. */
export function nodeVersionCompatibleWithJest(nodeVersion: string | undefined, jestMajor: number | undefined): boolean | undefined {
  const v = parseVersion(nodeVersion);
  const range = jestNodeEnginesFor(jestMajor);
  if (!v || !range) return undefined;
  return satisfiesRange(v, range);
}

// ---------------------------------------------------------------------------------------------
// Requests and installations
// ---------------------------------------------------------------------------------------------

function firstMeaningfulLine(text: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line) return line;
  }
  return undefined;
}

/** Nearest `.nvmrc` / `.node-version` / `package.json engines.node` from `packageDir` up to `repoRoot` (inclusive). */
export function readNodeRequest(packageDir: string, repoRoot: string, fsv: FsView): NodeRequest | undefined {
  for (const dir of ancestorsUpTo(packageDir, repoRoot)) {
    const nvmrc = path.join(dir, '.nvmrc');
    const nv = path.join(dir, '.node-version');
    const nvmrcText = fsv.readFile(nvmrc);
    const spec1 = nvmrcText !== undefined ? firstMeaningfulLine(nvmrcText) : undefined;
    if (spec1) return { spec: spec1, source: 'nvmrc', file: nvmrc };
    const nvText = fsv.readFile(nv);
    const spec2 = nvText !== undefined ? firstMeaningfulLine(nvText) : undefined;
    if (spec2) return { spec: spec2, source: 'node-version', file: nv };
    const pkgPath = path.join(dir, 'package.json');
    const pkg = readJson<PackageJsonLike>(pkgPath, fsv);
    const engines = pkg?.engines?.node;
    if (typeof engines === 'string' && engines.trim()) return { spec: engines.trim(), source: 'engines', file: pkgPath };
  }
  return undefined;
}

function nodeBinName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'node.exe' : 'node';
}

/** Enumerate Node binaries installed by the common version managers plus Homebrew / /usr/local. */
export function listInstalledNodes(input: Pick<PickNodeInput, 'env' | 'homeDir' | 'platform'>, fsv: FsView): InstalledNode[] {
  const { env, homeDir, platform } = input;
  const bin = nodeBinName(platform);
  const out: InstalledNode[] = [];
  const seen = new Set<string>();
  const add = (p: string, manager: NodeManager, version?: string) => {
    if (!fsv.isExecutable(p)) return;
    const real = fsv.realpath(p);
    if (seen.has(real)) return;
    seen.add(real);
    out.push({ path: real, manager, version });
  };
  const versioned = (root: string, manager: NodeManager, layout: (name: string) => string) => {
    for (const name of fsv.readdir(root)) {
      const v = parseVersion(name);
      if (!v) continue;
      add(path.join(root, layout(name)), manager, formatVersion(v));
    }
  };
  const fnmRoots = [env.FNM_DIR, path.join(homeDir, '.local', 'share', 'fnm'), path.join(homeDir, '.fnm'), path.join(homeDir, 'Library', 'Application Support', 'fnm')].filter((x): x is string => !!x);
  for (const root of fnmRoots) versioned(path.join(root, 'node-versions'), 'fnm', name => path.join(name, 'installation', 'bin', bin));
  const nvmRoots = [env.NVM_DIR, path.join(homeDir, '.nvm')].filter((x): x is string => !!x);
  for (const root of nvmRoots) versioned(path.join(root, 'versions', 'node'), 'nvm', name => path.join(name, 'bin', bin));
  const voltaRoots = [env.VOLTA_HOME, path.join(homeDir, '.volta')].filter((x): x is string => !!x);
  for (const root of voltaRoots) versioned(path.join(root, 'tools', 'image', 'node'), 'volta', name => path.join(name, 'bin', bin));
  const asdfRoots = [env.ASDF_DATA_DIR, path.join(homeDir, '.asdf')].filter((x): x is string => !!x);
  for (const root of asdfRoots) versioned(path.join(root, 'installs', 'nodejs'), 'asdf', name => path.join(name, 'bin', bin));
  const nRoots = [env.N_PREFIX ? path.join(env.N_PREFIX, 'n') : undefined, path.join(homeDir, 'n'), '/usr/local/n'].filter((x): x is string => !!x);
  for (const root of nRoots) versioned(path.join(root, 'versions', 'node'), 'n', name => path.join(name, 'bin', bin));
  if (platform !== 'win32') {
    add('/opt/homebrew/bin/node', 'homebrew');
    add('/usr/local/bin/node', 'homebrew');
  }
  return out;
}

/** First executable `node` on PATH (real path). */
export function findNodeOnPath(env: Record<string, string | undefined>, platform: NodeJS.Platform, fsv: FsView): string | undefined {
  const bin = nodeBinName(platform);
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    if (fsv.isExecutable(candidate)) return fsv.realpath(candidate);
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------------------------

/** Default exec: `spawnSync` with a 5 s timeout. The electron fallback needs ELECTRON_RUN_AS_NODE in `env`. */
export function createDefaultExec(): ExecFn {
  return (file, args, env) => {
    try {
      const r = spawnSync(file, args, { encoding: 'utf8', timeout: 5000, env: { ...process.env, ...(env ?? {}) }, stdio: ['ignore', 'pipe', 'ignore'] });
      if (r.error) return undefined;
      return { status: r.status, stdout: r.stdout ?? '' };
    } catch {
      return undefined;
    }
  };
}

/** Default async exec: `execFile` with the same 5 s timeout and semantics as createDefaultExec. */
export function createDefaultAsyncExec(): AsyncExecFn {
  return (file, args, env) => new Promise<ExecResult>(resolve => {
    try {
      execFile(file, args, { encoding: 'utf8', timeout: 5000, env: { ...process.env, ...(env ?? {}) }, windowsHide: true }, (err, stdout) => {
        if (!err) return resolve({ status: 0, stdout: stdout ?? '' });
        const code = (err as { code?: unknown }).code;
        // Numeric code = the binary ran and exited non-zero; anything else (ENOENT, timeout kill) = cannot run.
        resolve(typeof code === 'number' ? { status: code, stdout: stdout ?? '' } : undefined);
      }).stdin?.end();
    } catch {
      resolve(undefined);
    }
  });
}

const sharedVersionCache = new Map<string, string | null>();

export function createDefaultPickNodeDeps(): PickNodeDeps {
  return { fs: nodeFs, exec: createDefaultExec(), versionCache: sharedVersionCache };
}

/** Version-cache key of a binary (the electron fallback runs with ELECTRON_RUN_AS_NODE and is cached apart). */
export function nodeVersionCacheKey(nodePath: string, env?: Record<string, string>): string {
  return env?.ELECTRON_RUN_AS_NODE ? `${nodePath}#electron` : nodePath;
}

function versionFromExec(r: ExecResult): string | null {
  const text = r && r.status === 0 ? r.stdout.trim().split(/\r?\n/).pop()?.trim() : undefined;
  const v = parseVersion(text);
  return v ? formatVersion(v) : null;
}

/** Run `node -p process.version` once per binary; null when the binary does not run. */
export function validateNodeBinary(nodePath: string, deps: PickNodeDeps, env?: Record<string, string>): string | null {
  const key = nodeVersionCacheKey(nodePath, env);
  const cached = deps.versionCache.get(key);
  if (cached !== undefined) return cached;
  const result = versionFromExec(deps.exec(nodePath, ['-p', 'process.version'], env));
  deps.versionCache.set(key, result);
  return result;
}

/** Async twin of validateNodeBinary: fills the same cache without blocking the calling thread. */
export async function validateNodeBinaryAsync(
  nodePath: string, versionCache: Map<string, string | null>, exec: AsyncExecFn = createDefaultAsyncExec(), env?: Record<string, string>,
): Promise<string | null> {
  const key = nodeVersionCacheKey(nodePath, env);
  const cached = versionCache.get(key);
  if (cached !== undefined) return cached;
  const result = versionFromExec(await exec(nodePath, ['-p', 'process.version'], env));
  versionCache.set(key, result);
  return result;
}

/**
 * Select the Node binary for a project. Never throws; the worst case is the host's own executable with
 * `ELECTRON_RUN_AS_NODE=1` plus warnings explaining every fallback taken.
 */
export function pickNode(input: PickNodeInput, deps: PickNodeDeps = createDefaultPickNodeDeps()): PickNodeResult {
  const warnings: string[] = [];
  const { fs: fsv } = deps;
  const finish = (nodePath: string, version: string | undefined, source: NodeSource, requested: NodeRequest | undefined, env: Record<string, string> = {}): PickNodeResult => {
    const compatible = nodeVersionCompatibleWithJest(version, input.jestMajor);
    if (compatible === false) {
      warnings.push(`Node ${version} (${source}) is outside Jest ${input.jestMajor}'s supported range ${jestNodeEnginesFor(input.jestMajor)}`);
    }
    return { nodePath, version, source, requested, env, warnings };
  };

  // 1. Explicit setting.
  const setting = input.settingNodePath?.trim();
  if (setting) {
    let candidate: string | undefined;
    if (setting.includes('/') || setting.includes('\\')) {
      const abs = path.isAbsolute(setting) ? setting : path.resolve(input.packageDir, setting);
      candidate = fsv.isExecutable(abs) ? fsv.realpath(abs) : undefined;
    } else {
      candidate = findNodeOnPath(input.env, input.platform, fsv);
      if (candidate && path.basename(candidate).replace(/\.exe$/, '') !== setting.replace(/\.exe$/, '')) candidate = undefined;
    }
    if (candidate) {
      const v = validateNodeBinary(candidate, deps);
      if (v) return finish(candidate, v, 'setting', undefined);
      warnings.push(`hyperjest.nodePath "${setting}" could not be executed; falling back to automatic selection`);
    } else {
      warnings.push(`hyperjest.nodePath "${setting}" was not found; falling back to automatic selection`);
    }
  }

  // 2. Version request from the project.
  const requested = readNodeRequest(input.packageDir, input.repoRoot, fsv);
  const pathNode = findNodeOnPath(input.env, input.platform, fsv);
  if (requested) {
    const installed = listInstalledNodes(input, fsv);
    const cls = classifySpec(requested.spec);
    if (cls.kind === 'invalid') {
      warnings.push(`Unrecognised Node version "${requested.spec}" in ${requested.file}`);
    } else {
      // Learn versions of binaries whose path does not reveal one (Homebrew, /usr/local) only when needed.
      const withVersions: Array<InstalledNode & { version: string; parsed: Version }> = [];
      for (const n of installed) {
        const version = n.version ?? validateNodeBinary(n.path, deps) ?? undefined;
        const parsed = parseVersion(version);
        if (version && parsed) withVersions.push({ ...n, version, parsed });
      }
      const pathEntry = pathNode ? withVersions.find(n => n.path === pathNode) : undefined;
      const candidates = withVersions.map(n => ({ ref: n, version: n.parsed }));
      const preferred = pathEntry ? candidates.find(c => c.ref === pathEntry) : undefined;
      let pick = selectVersion(requested.spec, candidates, preferred);
      // The PATH node may come from a manager we do not enumerate; consider it too.
      if (!pick && pathNode && !pathEntry) {
        const pv = validateNodeBinary(pathNode, deps);
        const parsed = parseVersion(pv ?? undefined);
        if (pv && parsed) pick = selectVersion(requested.spec, [{ ref: { path: pathNode, version: pv, manager: 'path' as NodeManager, parsed }, version: parsed }]);
      }
      const broken = new Set<string>();
      while (pick) {
        const v = validateNodeBinary(pick.ref.path, deps);
        if (v) return finish(pick.ref.path, v, requested.source, requested);
        warnings.push(`${pick.ref.path} (${pick.ref.manager}) could not be executed; skipping`);
        broken.add(pick.ref.path);
        pick = selectVersion(requested.spec, candidates.filter(c => !broken.has(c.ref.path)), undefined);
      }
      const known = withVersions.map(n => n.version).sort().join(', ') || 'none';
      warnings.push(`Node ${requested.spec} requested by ${requested.file} is not installed (fnm/nvm/volta/asdf/n/Homebrew versions: ${known}); falling back`);
    }
  }

  // 3. PATH.
  if (pathNode) {
    const v = validateNodeBinary(pathNode, deps);
    if (v) return finish(pathNode, v, 'path', requested);
    warnings.push(`node on PATH (${pathNode}) could not be executed`);
  }

  // 4. Homebrew / /usr/local.
  for (const p of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    if (input.platform === 'win32' || !fsv.isExecutable(p)) continue;
    const v = validateNodeBinary(fsv.realpath(p), deps);
    if (v) return finish(fsv.realpath(p), v, 'homebrew', requested);
  }

  // 5. The host's own executable (Electron) running as Node.
  const execPath = input.electronExecPath ?? process.execPath;
  const electronEnv = { ELECTRON_RUN_AS_NODE: '1' };
  const v = validateNodeBinary(execPath, deps, electronEnv) ?? input.hostNodeVersion ?? `v${process.versions.node}`;
  warnings.push(`No standalone Node found; using the extension host executable ${execPath} with ELECTRON_RUN_AS_NODE=1`);
  return finish(execPath, v, 'electron', requested, electronEnv);
}
