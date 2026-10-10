/**
 * Host <-> worker protocol. JSON over Node IPC (child_process.fork with serialization 'json').
 * Every message carries `v` (PROTOCOL_VERSION). Run-scoped messages carry `runId`; the host drops
 * messages whose runId is not the current generation for that file.
 *
 * This file is the single source of truth shared by src/ (host), src/worker/ and tests/.
 * It must stay free of 'vscode' imports.
 */
export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------------------------
// Project specification (host-side discovery output; sent to the worker in `init`)
// ---------------------------------------------------------------------------------------------

export type ProjectFlavor =
  /** Wix `shono testjs`: run <jest> -c <shono-testjs>/dist/src/jestConfig.js with shono's env. */
  | 'shono'
  /** A config referenced by a package.json test script (`jest -c X`, flags). */
  | 'script-config'
  /** Jest's own implicit resolution (nearest jest.config.* or package.json `jest`). */
  | 'implicit'
  /** A root config with `projects`. */
  | 'projects'
  /** User override from the `hyperjest.projects` setting. */
  | 'override';

export type ProjectStatus =
  | 'ok'
  /** Jest package missing (e.g. node_modules not installed). */
  | 'unavailable'
  /** Jest < 29 or unsupported runner. */
  | 'unsupported'
  /** Package has tests but they are not Jest (mocha, node --test, detox e2e). */
  | 'notJest'
  | 'disabled';

export interface ProjectSpec {
  /** Stable id: sha1(packageDir + configArg). */
  id: string;
  displayName: string;
  repoRoot: string;
  /** Nearest package.json dir; cwd for every spawned process. */
  packageDir: string;
  flavor: ProjectFlavor;
  status: ProjectStatus;
  /** Human-readable reason for a non-ok status, with a suggested fix. */
  reason?: string;
  /** Absolute path passed to jest as `-c` / `readConfigs({config})`. Undefined = implicit. */
  configArg?: string;
  /** Resolved `jest` package dir (never node_modules/.bin). */
  jestPkgDir?: string;
  jestVersion?: string;
  /** `<jestPkgDir>/bin/jest.js` */
  jestBinPath?: string;
  nodePath?: string;
  nodeVersion?: string;
  nodeArgs: string[];
  env: Record<string, string>;
  cliFilters: {
    testPathIgnorePatterns: string[];
    /** Positional / `--testPathPattern(s)` regexes from the package's test script (static file filtering only; never passed to Jest). */
    testPathPatterns?: string[];
  };
  /** Glob patterns (relative to packageDir) that mark e2e/detox files to exclude from discovery. */
  e2ePatterns: string[];
  warnings: string[];
}

export interface WorkerFlags {
  coverage: boolean;
  perTestCoverage: boolean;
  liveComments: boolean;
  instrumentTestFiles: boolean;
  globalSetup: 'once' | 'skip';
  tsJestDiagnostics: 'keep' | 'off';
  trace: boolean;
}

// ---------------------------------------------------------------------------------------------
// Host -> worker
// ---------------------------------------------------------------------------------------------

export interface InitMsg {
  v: number;
  type: 'init';
  spec: ProjectSpec;
  flags: WorkerFlags;
  /** 0-based worker slot within the project; JEST_WORKER_ID = slot + 1. */
  slot: number;
  /** Absolute path of the extension's dist/worker directory (for reporter/preload paths). */
  workerAssetsDir: string;
}

export interface RunTestSelection {
  /** Absolute test file path. */
  path: string;
  /** Full names (`ancestorTitles.join(' ') + ' ' + title`) to narrow to; undefined = whole file. */
  names?: string[];
}

export type UpdateSnapshotMode = 'none' | 'new' | 'all';

export interface RunMsg {
  v: number;
  type: 'run';
  runId: string;
  tests: RunTestSelection[];
  updateSnapshot: UpdateSnapshotMode;
  priority: number;
  reason: 'explicit' | 'onType' | 'onSave' | 'open' | 'smartStart' | 'affected' | 'continuous' | 'failing';
}

export interface CancelMsg { v: number; type: 'cancel'; runId: string; }

export interface OverlayChange {
  /** Absolute path (must exist on disk). */
  path: string;
  /** Full unsaved content, or null to remove the overlay entry (file was saved/closed). */
  text: string | null;
  /** Monotonic version from the editor, used as the synthetic mtime. */
  version: number;
}
export interface OverlayMsg { v: number; type: 'overlay'; changes: OverlayChange[]; }

export interface InvalidateMsg {
  v: number;
  type: 'invalidate';
  reason: 'files' | 'config';
  paths: string[];
}

export interface GraphMsg { v: number; type: 'graph'; }
export interface ShowConfigMsg { v: number; type: 'showConfig'; }
export interface ListTestsMsg { v: number; type: 'listTests'; }
export interface PingMsg { v: number; type: 'ping'; }
export interface ShutdownMsg { v: number; type: 'shutdown'; }

export type HostToWorker =
  | InitMsg | RunMsg | CancelMsg | OverlayMsg | InvalidateMsg | GraphMsg | ShowConfigMsg | ListTestsMsg | PingMsg | ShutdownMsg;

// ---------------------------------------------------------------------------------------------
// Worker -> host
// ---------------------------------------------------------------------------------------------

export interface ResolvedConfigSummary {
  index: number;
  displayName?: string;
  rootDir: string;
  roots: string[];
  testMatch: string[];
  /** Regex sources (strings). */
  testRegex: string[];
  testPathIgnorePatterns: string[];
  modulePathIgnorePatterns: string[];
  moduleFileExtensions: string[];
  testEnvironment: string;
  globalSetup?: string;
  runner: string;
  cacheDirectory: string;
}

export interface ReadyMsg {
  v: number;
  type: 'ready';
  jestVersion: string;
  nodeVersion: string;
  configs: ResolvedConfigSummary[];
  /** Which warm-engine seams were installed; false entries mean degraded mode for that feature. */
  seams: { envWrapper: boolean; probeTransformer: boolean; cachePrune: boolean };
  warnings: string[];
  bootstrapMs: number;
}

export type InitErrorKind =
  | 'jestNotFound' | 'configLoad' | 'multipleConfigs' | 'tsLoader' | 'nodeIncompatible' | 'runnerUnsupported' | 'unknown';

export interface InitErrorMsg {
  v: number;
  type: 'initError';
  kind: InitErrorKind;
  message: string;
  stack?: string;
  candidates?: string[];
}

export type TestStatus = 'passed' | 'failed' | 'skipped' | 'pending' | 'todo' | 'disabled' | 'focused' | 'errored';

export interface Frame {
  file: string;
  /** 1-based */
  line: number;
  /** 1-based */
  column: number;
  functionName?: string;
}

export interface FailureInfo {
  /** Jest's formatted failure message (ANSI stripped). */
  message: string;
  stack?: string;
  /** Source-mapped frames in order; the first frame inside the test file is the "error source". */
  frames: Frame[];
  matcherName?: string;
  expected?: string;
  actual?: string;
}

export interface FileStartMsg { v: number; type: 'fileStart'; runId: string; path: string; }

export interface TestStartMsg {
  v: number; type: 'testStart'; runId: string; path: string;
  fullName: string; ancestorTitles: string[]; title: string;
}

export interface TestResultMsg {
  v: number; type: 'testResult'; runId: string; path: string;
  fullName: string; ancestorTitles: string[]; title: string;
  /** `path\0fullName\0dupIndex` */
  testKey: string;
  status: TestStatus;
  duration: number | null;
  /** 1-based test() call-site location in the test file (null when unknown). */
  location: { line: number; column: number } | null;
  failures: FailureInfo[];
  invocations: number;
  retryReasons?: string[];
}

/** Statement ranges a single test executed, per source file. */
export interface TestCoverageMsg {
  v: number; type: 'testCoverage'; runId: string; path: string; testKey: string;
  files: CoverageHit[];
}

/** IDs belong exclusively to `revision`; missing revision/function data cannot prove non-execution. */
export interface CoverageHit { path: string; revision?: string; hash?: string; stmts: number[]; fns?: number[] }

/** Files loaded (module scope executed) while loading the test file, before any test ran. */
export interface FileLoadMsg {
  v: number; type: 'fileLoad'; runId: string; path: string; files: string[];
  /** Executions outside individual tests, including shared hooks. Sent cumulatively at run_finish. */
  shared?: CoverageHit[];
  complete?: boolean;
}

/** Static shape of one instrumented source file; sent once per (path, hash). */
export interface CoverageMetaMsg {
  v: number; type: 'coverageMeta'; path: string; hash: string;
  revision?: string;
  sourceText?: string;
  /** All coordinates refer reliably to sourceText, rather than generated or partially mapped code. */
  originalCoordinates?: boolean;
  /** 1-based start/end line per statement id (parallel arrays), already remapped to the original file. */
  stmtStartLine: number[];
  stmtEndLine: number[];
  stmtStartColumn?: number[];
  stmtEndColumn?: number[];
  /** 1-based line per function declaration id. */
  fnDeclLine: number[];
  /** 1-based last line per function id (istanbul `fnMap[id].loc.end`), parallel to `fnDeclLine`. Optional; enables function-level affected narrowing. */
  fnEndLine?: number[];
  fnDeclColumn?: number[];
  fnEndColumn?: number[];
  /** Branch arms: [branchId, armIndex, line] triples flattened. */
  branchArms: number[];
  remapped: boolean;
}

/** File-level coverage after a run (hit statement ids); used in degraded mode or as the union. */
export interface FileCoverageMsg {
  v: number; type: 'fileCoverage'; runId: string; path: string;
  files: Array<{ path: string; hash: string; revision?: string; hitStmts: number[]; hitBranchArms: number[] }>;
}

export interface ConsoleMsg {
  v: number; type: 'console'; runId: string; path: string; testKey?: string;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'dir';
  text: string;
  file?: string; line?: number; column?: number;
}

export interface ValueMsg {
  v: number; type: 'value'; runId: string; path: string; testKey?: string;
  file: string; line: number; column: number; text: string;
}

export interface SnapshotSummary {
  added: number; matched: number; unmatched: number; updated: number; unchecked: number;
  uncheckedKeys: string[]; fileDeleted: boolean;
}

export interface FileResultMsg {
  v: number; type: 'fileResult'; runId: string; path: string;
  status: 'passed' | 'failed' | 'errored' | 'skipped' | 'notMatched';
  /** Set when the whole file failed to run (syntax error, import failure, ...). */
  testExecError?: FailureInfo;
  snapshot?: SnapshotSummary;
  numPassing: number; numFailing: number; numPending: number; numTodo: number;
  perfStats?: { start: number; end: number; runtime: number; slow: boolean };
  /** Console entries buffered by Jest for the file (when per-test tagging was unavailable). */
  console?: Array<{ level: ConsoleMsg['level']; text: string; file?: string; line?: number; column?: number }>;
}

export interface RunCompleteMsg {
  v: number; type: 'runComplete'; runId: string;
  wasInterrupted: boolean; durationMs: number; memory: { rss: number; heapUsed: number };
  error?: string;
}

export interface GraphResultMsg {
  v: number; type: 'graphResult';
  /** forward[file] = files it imports (absolute, realpath). */
  forward: Record<string, string[]>;
  testFiles: string[];
  unresolved: number;
}

export interface ShowConfigResultMsg { v: number; type: 'showConfigResult'; json: string; }
export interface ListTestsResultMsg { v: number; type: 'listTestsResult'; files: string[]; }
export interface LogMsg { v: number; type: 'log'; level: 'trace' | 'debug' | 'info' | 'warn' | 'error'; text: string; }
export interface PongMsg { v: number; type: 'pong'; rss: number; heapUsed: number; }
export interface OverlayWriteBlockedMsg { v: number; type: 'overlayWriteBlocked'; path: string; }

export type WorkerToHost =
  | ReadyMsg | InitErrorMsg | FileStartMsg | TestStartMsg | TestResultMsg | TestCoverageMsg | FileLoadMsg
  | CoverageMetaMsg | FileCoverageMsg | ConsoleMsg | ValueMsg | FileResultMsg | RunCompleteMsg | GraphResultMsg
  | ShowConfigResultMsg | ListTestsResultMsg | LogMsg | PongMsg | OverlayWriteBlockedMsg;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

export const TEST_KEY_SEP = '\0';

export function makeTestKey(path: string, fullName: string, dupIndex: number): string {
  return `${path}${TEST_KEY_SEP}${fullName}${TEST_KEY_SEP}${dupIndex}`;
}

export function parseTestKey(key: string): { path: string; fullName: string; dupIndex: number } {
  const [path, fullName, dup] = key.split(TEST_KEY_SEP);
  return { path, fullName, dupIndex: Number(dup) || 0 };
}

export function fullNameOf(ancestorTitles: string[], title: string): string {
  return [...ancestorTitles, title].join(' ');
}
