/**
 * Pure builders for the CLI engine, Debug and the "find related tests" fallback:
 * `buildRunSpec()` -> {command, args, cwd, env}, `buildDebugConfig()` -> a plain object shaped like
 * a vscode `DebugConfiguration` (type 'node'). No 'vscode' import; snapshot-tested for Jest 29/30.
 *
 * Argv rules (see plan "Run types"):
 * - never `--testPathPattern` (fatal on Jest 30) nor `--testPathPatterns` (unknown on Jest 29);
 *   files go after `--` with `--runTestsByPath` because yargs array options are greedy;
 * - `-t` receives `^(?:a|b)$` built from escaped full names;
 * - `--verbose=false` keeps console output buffered into TestResult.console (Jest forces verbose
 *   when a single file runs); `--silent=false` keeps the BufferedConsole;
 * - the reporter is `<workerAssetsDir>/reporter.cjs`; the overlay preload is injected through
 *   `node --require <workerAssetsDir>/overlayPreload.cjs` + `HYPERJEST_OVERLAY=<manifest>`.
 */
import * as path from 'path';
import { AGENT_REPORTER_TRIGGERS, HOST_ONLY_VARS, buildChildEnv as buildBaseChildEnv } from './childEnv';
import type { RunTestSelection, UpdateSnapshotMode } from './protocol';

/** Bundle file names under the extension's dist/worker directory. */
export const REPORTER_BUNDLE = 'reporter.cjs';
export const OVERLAY_PRELOAD_BUNDLE = 'overlayPreload.cjs';

/** Env var carrying the overlay manifest path for the preload. */
export const OVERLAY_ENV_VAR = 'HYPERJEST_OVERLAY';
export const RUN_ID_ENV_VAR = 'HYPERJEST_RUN_ID';

/** Largest `setTimeout` delay Node accepts; used as the per-test timeout while debugging. */
export const DEBUG_TEST_TIMEOUT_MS = 2147483647;

/**
 * Env vars that make Jest >= 30.4 pick its 'agent' reporter by default
 * (verified: @jest/core 30.4.2 build/index.js:1010 `AGENT_ENV_VARS`, identical in 30.5.2).
 * We pass explicit `--reporters`, but dropping them also keeps child tools (e.g. custom
 * reporters in configs) from switching into agent modes. Single source of truth: src/core/childEnv.ts.
 */
export const AGENT_REPORTER_ENV_VARS: readonly string[] = AGENT_REPORTER_TRIGGERS;

/** Extension-host leftovers that would break or alter a child node process (from src/core/childEnv.ts). */
export const HOST_ONLY_ENV_VARS: readonly string[] = HOST_ONLY_VARS;

export const DROPPED_ENV_VARS: readonly string[] = [...HOST_ONLY_ENV_VARS, ...AGENT_REPORTER_ENV_VARS];

/** The subset of ProjectSpec the builders need (so tests and callers can pass plain objects). */
export interface RunSpecProject {
  /** cwd for the spawned process (nearest package.json dir). */
  packageDir: string;
  /** Resolved `jest` package dir (never node_modules/.bin). */
  jestPkgDir: string;
  /** Defaults to `<jestPkgDir>/bin/jest.js`. */
  jestBinPath?: string;
  /** Passed as `-c <configArg>`; undefined = Jest's implicit resolution. */
  configArg?: string;
  cliFilters?: { testPathIgnorePatterns?: string[] };
  /** Project-level env (including explicit NODE_PATH overrides). */
  env?: Record<string, string>;
  nodePath?: string;
  nodeArgs?: string[];
}

export interface ChildEnvInput {
  /** Defaults to process.env. */
  hostEnv?: NodeJS.ProcessEnv;
  /** Executable the child runs with; its directory is prepended to PATH when absolute. */
  nodePath: string;
  runId?: string;
  /** Overlay manifest path; when absent, an inherited HYPERJEST_OVERLAY is removed. */
  overlayManifestPath?: string;
  /** Project env (applied after sanitisation, before extraEnv). */
  projectEnv?: Record<string, string>;
  /** `hyperjest.env` (applied last). */
  extraEnv?: Record<string, string>;
  /** FORCE_COLOR=0 / NO_COLOR=1 (default true; the debug terminal keeps colors). */
  disableColors?: boolean;
}

/** Escapes a string for use inside a RegExp (same table as lodash/escape-string-regexp). */
export function escapeRegExp(text: string): string {
  return text.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&').replace(/-/g, '\\x2d');
}

/** `^(?:a|b)$` for Jest's `-t` so only the named tests run (Jest matches the full name). */
export function testNamePattern(names: readonly string[]): string {
  return `^(?:${names.map(escapeRegExp).join('|')})$`;
}

/**
 * Union of names across selections. Returns undefined when any selection wants the whole file
 * (`-t` is process-global, so narrowing would wrongly exclude that file's other tests).
 */
export function namesForSelection(tests: readonly RunTestSelection[]): string[] | undefined {
  const names = new Set<string>();
  for (const t of tests) {
    if (!t.names) return undefined;
    for (const n of t.names) names.add(n);
  }
  return names.size ? [...names] : undefined;
}

/**
 * Builds the child environment for CLI / Debug / find-related runs. Delegates the sanitisation to
 * src/core/childEnv.ts (`buildChildEnv`: host env minus host-only and agent-reporter vars,
 * NODE_ENV/BABEL_ENV=test when unset, colors off, PATH prefixed with the node dir, project env with
 * NODE_PATH appending, then `hyperjest.env`) and adds the run-scoped parts on top:
 * - `HYPERJEST_RUN_ID` / `HYPERJEST_OVERLAY` (a manifest inherited from the host is always dropped);
 * - a bare `nodePath` ('node') leaves PATH untouched, an absolute one is never duplicated in it;
 * - `disableColors: false` (Debug) restores the host's FORCE_COLOR / NO_COLOR instead of forcing them off.
 */
export function buildChildEnv(input: ChildEnvInput): Record<string, string> {
  const host = input.hostEnv ?? process.env;
  const base: NodeJS.ProcessEnv = { ...host };
  delete base[OVERLAY_ENV_VAR];
  const nodeDir = path.isAbsolute(input.nodePath) ? path.dirname(input.nodePath) : undefined;
  if (nodeDir && base.PATH) base.PATH = base.PATH.split(path.delimiter).filter(p => p && p !== nodeDir).join(path.delimiter);
  const extra: Record<string, string> = {};
  if (input.runId) extra[RUN_ID_ENV_VAR] = input.runId;
  if (input.overlayManifestPath) extra[OVERLAY_ENV_VAR] = input.overlayManifestPath;

  const env = buildBaseChildEnv({ base, nodePath: input.nodePath, projectEnv: input.projectEnv, userEnv: input.extraEnv, extra });

  if (!nodeDir) {
    // childEnv prepends dirname(nodePath) unconditionally, which is '.' for a bare command.
    if (host.PATH !== undefined) env.PATH = host.PATH;
    else delete env.PATH;
  }
  if (input.disableColors === false) {
    for (const k of ['FORCE_COLOR', 'NO_COLOR'] as const) {
      const v = input.extraEnv?.[k] ?? input.projectEnv?.[k] ?? host[k];
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }
  return env;
}

export interface RunSpecInput {
  project: RunSpecProject;
  /** Absolute path of the extension's dist/worker directory. */
  workerAssetsDir: string;
  tests: readonly RunTestSelection[];
  /** Default 'none'. 'new' is Jest's default behaviour (no flag); 'all' adds `-u`. */
  updateSnapshot?: UpdateSnapshotMode;
  runId: string;
  /** When set, coverage flags are added and `coverage-final.json` lands in `directory`. */
  coverage?: { directory: string };
  /** Overlay manifest written by the host; enables `--require overlayPreload.cjs`. */
  overlayManifestPath?: string;
  /** Resolved node executable (defaults to project.nodePath, then 'node'). */
  nodePath?: string;
  hostEnv?: NodeJS.ProcessEnv;
  extraEnv?: Record<string, string>;
  /** Appended before `--` (escape hatch for Doctor's "compare with plain Jest"). */
  extraJestArgs?: readonly string[];
}

export interface RunSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Paths the spec references, for logging/Doctor. */
  reporterPath: string;
  preloadPath?: string;
  jestBinPath: string;
}

function jestBinOf(project: RunSpecProject): string {
  return project.jestBinPath ?? path.join(project.jestPkgDir, 'bin', 'jest.js');
}

function nodeOf(input: { nodePath?: string; project: RunSpecProject }): string {
  return input.nodePath || input.project.nodePath || 'node';
}

function configArgs(project: RunSpecProject): string[] {
  const args: string[] = [];
  if (project.configArg) args.push('-c', project.configArg);
  for (const p of project.cliFilters?.testPathIgnorePatterns ?? []) args.push(`--testPathIgnorePatterns=${p}`);
  return args;
}

function snapshotArgs(mode: UpdateSnapshotMode | undefined): string[] {
  switch (mode) {
    case 'all': return ['-u'];
    case 'none': return ['--ci=true'];
    default: return [];
  }
}

/**
 * `<node> [nodeArgs] [--require preload] <jest.js> [-c cfg] [--testPathIgnorePatterns=p]*
 *  --reporters=<reporter> --runInBand --watchAll=false --ci=false --passWithNoTests
 *  --testLocationInResults --runTestsByPath --verbose=false --silent=false --colors=false
 *  [--coverage --coverageProvider=babel --coverageReporters=json --coverageDirectory=<dir>]
 *  [-u] [-t <pattern>] [extra] -- <files…>`
 *
 * `updateSnapshot:'none'` is expressed as `--ci=true` after `--ci=false` (last wins in yargs):
 * Jest writes no new snapshots in CI mode, which is exactly 'none'.
 */
export function buildRunSpec(input: RunSpecInput): RunSpec {
  const { project } = input;
  const node = nodeOf(input);
  const reporterPath = path.join(input.workerAssetsDir, REPORTER_BUNDLE);
  const preloadPath = input.overlayManifestPath ? path.join(input.workerAssetsDir, OVERLAY_PRELOAD_BUNDLE) : undefined;
  const jestBinPath = jestBinOf(project);
  const names = namesForSelection(input.tests);

  const args: string[] = [
    ...(project.nodeArgs ?? []),
    ...(preloadPath ? ['--require', preloadPath] : []),
    jestBinPath,
    ...configArgs(project),
    `--reporters=${reporterPath}`,
    '--runInBand',
    '--watchAll=false',
    '--ci=false',
    '--passWithNoTests',
    '--testLocationInResults',
    '--runTestsByPath',
    '--verbose=false',
    '--silent=false',
    '--colors=false',
  ];
  if (input.coverage) {
    args.push('--coverage', '--coverageProvider=babel', '--coverageReporters=json', `--coverageDirectory=${input.coverage.directory}`);
  }
  args.push(...snapshotArgs(input.updateSnapshot));
  if (names) args.push('-t', testNamePattern(names));
  if (input.extraJestArgs?.length) args.push(...input.extraJestArgs);
  args.push('--', ...input.tests.map(t => t.path));

  const env = buildChildEnv({
    hostEnv: input.hostEnv,
    nodePath: node,
    runId: input.runId,
    overlayManifestPath: input.overlayManifestPath,
    projectEnv: project.env,
    extraEnv: input.extraEnv,
  });
  const spec: RunSpec = { command: node, args, cwd: project.packageDir, env, reporterPath, jestBinPath };
  if (preloadPath) spec.preloadPath = preloadPath;
  return spec;
}

export interface FindRelatedSpecInput {
  project: RunSpecProject;
  /** Absolute source files whose dependents are wanted. */
  sources: readonly string[];
  runId: string;
  nodePath?: string;
  hostEnv?: NodeJS.ProcessEnv;
  extraEnv?: Record<string, string>;
}

/**
 * Cold fallback for affected-test selection before any runtime data exists:
 * `jest --listTests --findRelatedTests --json -- <sources>` prints a JSON array of test paths.
 */
export function buildFindRelatedSpec(input: FindRelatedSpecInput): RunSpec {
  const { project } = input;
  const node = nodeOf(input);
  const jestBinPath = jestBinOf(project);
  const args = [
    ...(project.nodeArgs ?? []),
    jestBinPath,
    ...configArgs(project),
    '--listTests',
    '--findRelatedTests',
    '--json',
    '--watchAll=false',
    '--ci=false',
    '--passWithNoTests',
    '--',
    ...input.sources,
  ];
  const env = buildChildEnv({ hostEnv: input.hostEnv, nodePath: node, runId: input.runId, projectEnv: project.env, extraEnv: input.extraEnv });
  return { command: node, args, cwd: project.packageDir, env, reporterPath: '', jestBinPath };
}

export interface DebugConfigInput {
  project: RunSpecProject;
  workerAssetsDir: string;
  tests: readonly RunTestSelection[];
  /** Shown as `HyperJest: <title>` in the debug toolbar. */
  title: string;
  updateSnapshot?: UpdateSnapshotMode;
  runId: string;
  overlayManifestPath?: string;
  nodePath?: string;
  hostEnv?: NodeJS.ProcessEnv;
  extraEnv?: Record<string, string>;
  console?: 'integratedTerminal' | 'internalConsole';
}

/** Plain-object shape of the vscode.DebugConfiguration we launch (kept vscode-free for tests). */
export interface HyperJestDebugConfiguration {
  type: 'node';
  request: 'launch';
  name: string;
  runtimeExecutable: string;
  runtimeArgs: string[];
  program: string;
  cwd: string;
  env: Record<string, string>;
  args: string[];
  console: 'integratedTerminal' | 'internalConsole';
  internalConsoleOptions: 'neverOpen';
  skipFiles: string[];
  sourceMaps: true;
  autoAttachChildProcesses: true;
  /** Both the default reporter (terminal output) and ours (results into the Test Explorer run). */
  [key: string]: unknown;
}

/**
 * js-debug launch config: `type:'node'` (pwa-node is deprecated), `--runInBand` because
 * jest-worker strips --inspect from worker execArgv, the overlay preload via runtimeArgs, both
 * `default` and HyperJest reporters, and an effectively infinite test timeout.
 */
export function buildDebugConfig(input: DebugConfigInput): HyperJestDebugConfiguration {
  const { project } = input;
  const node = nodeOf(input);
  const reporterPath = path.join(input.workerAssetsDir, REPORTER_BUNDLE);
  const preloadPath = input.overlayManifestPath ? path.join(input.workerAssetsDir, OVERLAY_PRELOAD_BUNDLE) : undefined;
  const names = namesForSelection(input.tests);
  const args = [
    ...configArgs(project),
    '--runInBand',
    '--watchAll=false',
    '--ci=false',
    '--testLocationInResults',
    `--testTimeout=${DEBUG_TEST_TIMEOUT_MS}`,
    ...snapshotArgs(input.updateSnapshot),
    ...(names ? ['-t', testNamePattern(names)] : []),
    '--reporters=default',
    `--reporters=${reporterPath}`,
    '--runTestsByPath',
    '--',
    ...input.tests.map(t => t.path),
  ];
  const env = buildChildEnv({
    hostEnv: input.hostEnv,
    nodePath: node,
    runId: input.runId,
    overlayManifestPath: input.overlayManifestPath,
    projectEnv: project.env,
    extraEnv: input.extraEnv,
    disableColors: false,
  });
  return {
    type: 'node',
    request: 'launch',
    name: `HyperJest: ${input.title}`,
    runtimeExecutable: node,
    runtimeArgs: [...(project.nodeArgs ?? []), ...(preloadPath ? ['--require', preloadPath] : [])],
    program: jestBinOf(project),
    cwd: project.packageDir,
    env,
    args,
    console: input.console ?? 'integratedTerminal',
    internalConsoleOptions: 'neverOpen',
    skipFiles: ['<node_internals>/**'],
    sourceMaps: true,
    autoAttachChildProcesses: true,
  };
}
