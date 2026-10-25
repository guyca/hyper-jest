/**
 * Affected-test selection (plan section "On-type strategy and affected selection"). Pure; no
 * 'vscode'; inputs are plain Maps/Sets owned by the host's result store.
 *
 *  - Test file edit: the single test (from {@link ChangeAnalysis}) or the whole file, plus test
 *    files that load/import it (helper specs), plus previously failing tests.
 *  - Source file edit: A = `execBy[file]` (per-test runtime hits, narrowed to tests that executed
 *    the edited function(s) when per-test coverage with function spans is available) ∪
 *    B = `loadedBy[file]` (whole test files) ∪ C = inverse static-graph closure for test files
 *    without runtime data ∪ D = previously failing tests of those files.
 *  - `.snap` edit → the owning test file. Toolchain files → `invalidateConfig`.
 *  - Nothing selected: `none` when a static graph exists (no tests cover the file), otherwise
 *    `discover` so the host can fall back to `jest --listTests --findRelatedTests`.
 *  - Cap: the first `maxTestFilesPerEdit` files run now, the rest are `deferred` to later idle batches.
 */
import { parseTestKey, type RunTestSelection } from './protocol';
import type { ChangeAnalysis } from './changeAnalyzer';
import { touchedOldLines, type LineChange } from './textDiff';
import type { SourceSelection } from '../results/coverageHistory';

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

/** Per-test coverage of the changed file, as recorded for the text the hunks' `old*` lines refer to. */
export interface AffectedCoverage {
  meta: {
    /** 1-based start/end line per statement id (parallel arrays). */
    stmtStartLine: readonly number[];
    stmtEndLine: readonly number[];
    /** 1-based declaration line per function id. */
    fnDeclLine: readonly number[];
    /** 1-based last line per function id (optional; without it no function-level narrowing happens). */
    fnEndLine?: readonly number[];
  };
  /** statementId -> testKeys whose latest run executed it. */
  stmtHitBy: ReadonlyMap<number, ReadonlySet<string>>;
  /** Line count of the file when the coverage was recorded (for clamping insertion anchors). */
  oldLineCount?: number;
}

export interface AffectedSettings {
  maxTestFilesPerEdit: number;
  alwaysRunFailing: boolean;
  useStaticGraph: boolean;
  trackFileLoading: boolean;
}

export interface AffectedInput {
  /** Source edits evaluated against each test's own immutable coverage revision. */
  sourceSelection?: SourceSelection;
  /** Absolute (real) path of the edited file. */
  changedFile: string;
  /** Hunks in the current text relative to the text the runtime data was recorded for; null = unknown extent. */
  changedLines: readonly LineChange[] | null;
  /** Override when the host knows the file's test-ness (default: `testFiles.has(changedFile)`). */
  isTestFile?: boolean;
  /** The file was deleted: it is not selected itself, and its dependents re-run as whole files (their imports fail). */
  deleted?: boolean;
  /** `analyzeChange()` result for a test-file edit; undefined = whole file. */
  analysis?: ChangeAnalysis;
  /** sourceFile -> testKeys that executed it (per-test coverage). */
  execBy: ReadonlyMap<string, ReadonlySet<string>>;
  /** sourceFile -> test files that loaded it while loading (module scope, setup files, hooks). */
  loadedBy: ReadonlyMap<string, ReadonlySet<string>>;
  /** file -> files importing it (static graph); null when no graph is available yet. */
  inverseStaticGraph: ReadonlyMap<string, ReadonlySet<string>> | null;
  /** Known test files of the project. */
  testFiles: ReadonlySet<string>;
  /** Test files whose latest run produced load/exec data; the static closure skips them (runtime data is authoritative). */
  runtimeTrackedTestFiles?: ReadonlySet<string>;
  /** testFile -> failing testKeys from the latest results. */
  failingTestsByFile: ReadonlyMap<string, ReadonlySet<string>>;
  /** Per-test coverage of `changedFile` for function-level narrowing. */
  coverage?: AffectedCoverage | null;
  /** Toolchain paths from the resolved config: setupFiles, setupFilesAfterEnv, globalSetup/Teardown, configArg, transformers, resolver ... */
  toolchainFiles?: ReadonlySet<string>;
  settings: AffectedSettings;
}

/** How many test files each source contributed (a file may be counted by several sources). */
export interface SourceCounts {
  /** The edited test file itself. */
  self: number;
  execBy: number;
  loadedBy: number;
  staticGraph: number;
  /** Test files that only contributed previously failing tests to an already selected file. */
  failingAdded: number;
  /** True when `execBy` was narrowed to tests that executed the edited function(s). */
  narrowed: boolean;
}

export type AffectedResult =
  | { kind: 'runs'; runs: RunTestSelection[]; deferred: RunTestSelection[]; truncated: boolean; reason: string; sources: SourceCounts }
  | { kind: 'invalidateConfig'; reason: string }
  | { kind: 'none'; reason: string }
  | { kind: 'discover'; reason: string };

/** Max files visited by the inverse-graph closure (cycle/explosion guard). */
const CLOSURE_LIMIT = 50_000;

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

export function selectAffected(input: AffectedInput): AffectedResult {
  const file = input.changedFile;
  if (isToolchainFile(file, input.toolchainFiles)) {
    return { kind: 'invalidateConfig', reason: `${baseName(file)} is a toolchain file` };
  }
  if (file.endsWith('.snap')) return selectForSnapshot(input);
  const isTest = input.isTestFile ?? input.testFiles.has(file);
  return isTest ? selectForTestFile(input) : selectForSourceFile(input);
}

// ---------------------------------------------------------------------------------------------
// Test-file edits
// ---------------------------------------------------------------------------------------------

function selectForTestFile(input: AffectedInput): AffectedResult {
  const file = input.changedFile;
  const acc = new SelectionAccumulator();
  const counts = emptyCounts();

  if (!input.deleted) {
    if (input.analysis?.kind === 'singleTest') acc.addNames(file, input.analysis.fullNames, 0);
    else acc.addWhole(file, 0);
    counts.self = 1;
  }

  // Specs that import this file (shared behaviours, helper specs) re-run as whole files.
  if (input.settings.trackFileLoading) {
    for (const loader of input.loadedBy.get(file) ?? []) {
      if (loader !== file && input.testFiles.has(loader)) { acc.addWhole(loader, 2); counts.loadedBy++; }
    }
  }
  if (input.settings.useStaticGraph && input.inverseStaticGraph) {
    for (const dependent of inverseClosure(input.inverseStaticGraph, file, input.testFiles)) {
      if (dependent === file || isRuntimeTracked(input, dependent)) continue;
      acc.addWhole(dependent, 3);
      counts.staticGraph++;
    }
  }
  if (input.deleted && acc.size === 0) return { kind: 'none', reason: `nothing depends on ${baseName(file)}` };
  counts.failingAdded = addFailing(acc, input);
  return finish(acc, counts, input.settings.maxTestFilesPerEdit, input.deleted ? 'test file deleted' : describeTestEdit(input));
}

function describeTestEdit(input: AffectedInput): string {
  const a = input.analysis;
  if (a?.kind === 'singleTest') return `edit inside "${a.fullNames[0]}"`;
  if (a?.kind === 'structural') return 'test structure changed';
  if (a?.kind === 'wholeFile') return `whole file (${a.reason})`;
  return 'whole file';
}

// ---------------------------------------------------------------------------------------------
// Source-file edits
// ---------------------------------------------------------------------------------------------

function selectForSourceFile(input: AffectedInput): AffectedResult {
  const file = input.changedFile;
  const acc = new SelectionAccumulator();
  const counts = emptyCounts();

  // A: tests that executed the file (optionally narrowed to the edited functions).
  const executed = input.execBy.get(file);
  if (executed && executed.size > 0 && input.deleted) {
    for (const testFile of groupKeysByFile(executed).keys()) { acc.addWhole(testFile, 1); counts.execBy++; }
  } else if (executed && executed.size > 0) {
    const narrowed = input.sourceSelection
      ? { keys: new Set([...executed].filter(key => input.sourceSelection!.tests.has(key))), narrowed: [...executed].some(key => !input.sourceSelection!.tests.has(key)) }
      : narrowByFunctions(executed, input.changedLines, input.coverage);
    counts.narrowed = narrowed.narrowed;
    const byFile = groupKeysByFile(narrowed.keys);
    for (const [testFile, keys] of byFile) {
      acc.addNames(testFile, keys.map(k => parseTestKey(k).fullName), 1);
      counts.execBy++;
    }
  }

  // B: test files that loaded the file at module scope (whole files; Wallaby's testFilesLoadedFrom).
  if (input.settings.trackFileLoading) {
    for (const loader of input.loadedBy.get(file) ?? []) {
      if (input.testFiles.size > 0 && !input.testFiles.has(loader)) continue;
      if (input.sourceSelection?.trackedFiles.has(loader) && !input.sourceSelection.wholeFiles.has(loader)) continue;
      acc.addWhole(loader, 2);
      counts.loadedBy++;
    }
  }

  // A function executed only in a shared hook may have no per-test execution or initial load edge.
  if (input.settings.trackFileLoading) for (const loader of input.sourceSelection?.wholeFiles ?? []) {
    if (input.testFiles.size > 0 && !input.testFiles.has(loader)) continue;
    acc.addWhole(loader, 2);
  }

  // C: static importers (closure) that have no authoritative runtime data.
  let graphConsulted = false;
  if (input.settings.useStaticGraph && input.inverseStaticGraph) {
    graphConsulted = true;
    for (const dependent of inverseClosure(input.inverseStaticGraph, file, input.testFiles)) {
      if (isRuntimeTracked(input, dependent)) continue;
      acc.addWhole(dependent, 3);
      counts.staticGraph++;
    }
  }

  if (acc.size === 0) {
    const name = baseName(file);
    // Jest cannot relate a deleted file to its tests.
    if (!input.deleted && !graphConsulted && !input.loadedBy.get(file)?.size && !input.execBy.get(file)?.size) {
      return { kind: 'discover', reason: `no runtime or static dependency data yet for ${name}` };
    }
    return { kind: 'none', reason: `no tests cover ${name}` };
  }

  // D: previously failing tests of the selected files.
  counts.failingAdded = addFailing(acc, input);
  return finish(acc, counts, input.settings.maxTestFilesPerEdit, describeSourceEdit(counts));
}

function describeSourceEdit(c: SourceCounts): string {
  const parts: string[] = [];
  if (c.execBy) parts.push(`${c.execBy} executed it${c.narrowed ? ' (narrowed to edited functions)' : ''}`);
  if (c.loadedBy) parts.push(`${c.loadedBy} loaded it`);
  if (c.staticGraph) parts.push(`${c.staticGraph} import it`);
  return parts.join(', ');
}

/**
 * Keep only the tests that executed a statement inside the function(s) containing the edited lines.
 * Falls back to the full set when the extent is unknown, function spans are missing, or any edited
 * line is at module scope (outside every function).
 */
export function narrowByFunctions(
  keys: ReadonlySet<string>,
  changedLines: readonly LineChange[] | null,
  coverage: AffectedCoverage | null | undefined,
): { keys: Set<string>; narrowed: boolean } {
  const all = { keys: new Set(keys), narrowed: false };
  if (!coverage || !changedLines || changedLines.length === 0) return all;
  const { fnDeclLine, fnEndLine, stmtStartLine } = coverage.meta;
  if (!fnEndLine || fnEndLine.length !== fnDeclLine.length || fnDeclLine.length === 0) return all;

  // Old-text lines (1-based) the hunks touched.
  const oldLineCount = coverage.oldLineCount ?? Number.MAX_SAFE_INTEGER;
  const touched: number[] = [];
  for (const h of changedLines) {
    const { first, last } = touchedOldLines(h, oldLineCount);
    for (let l = first; l <= last; l++) touched.push(l + 1);
  }

  // Innermost enclosing function per touched line; module scope anywhere → no narrowing.
  const spans: Array<[number, number]> = [];
  for (const line of touched) {
    let best = -1;
    for (let i = 0; i < fnDeclLine.length; i++) {
      if (fnDeclLine[i] <= line && line <= fnEndLine[i]) {
        if (best < 0 || fnEndLine[i] - fnDeclLine[i] < fnEndLine[best] - fnDeclLine[best]) best = i;
      }
    }
    if (best < 0) return all;
    spans.push([fnDeclLine[best], fnEndLine[best]]);
  }

  const selected = new Set<string>();
  for (let s = 0; s < stmtStartLine.length; s++) {
    const line = stmtStartLine[s];
    if (!spans.some(([a, b]) => a <= line && line <= b)) continue;
    const hits = coverage.stmtHitBy.get(s);
    if (!hits) continue;
    for (const k of hits) if (keys.has(k)) selected.add(k);
  }
  return { keys: selected, narrowed: true };
}

// ---------------------------------------------------------------------------------------------
// Snapshot edits
// ---------------------------------------------------------------------------------------------

function selectForSnapshot(input: AffectedInput): AffectedResult {
  const snap = input.changedFile;
  const owner = snapshotOwner(snap);
  const acc = new SelectionAccumulator();
  const counts = emptyCounts();
  if (owner && (input.testFiles.size === 0 || input.testFiles.has(owner))) {
    acc.addWhole(owner, 0);
    counts.self = 1;
  } else if (input.inverseStaticGraph) {
    // Custom snapshotResolver: Jest's own inverse map links .snap files to their tests.
    for (const t of input.inverseStaticGraph.get(snap) ?? []) {
      if (input.testFiles.has(t)) { acc.addWhole(t, 0); counts.staticGraph++; }
    }
  }
  if (acc.size === 0) return { kind: 'none', reason: `no test file owns ${baseName(snap)}` };
  counts.failingAdded = addFailing(acc, input);
  return finish(acc, counts, input.settings.maxTestFilesPerEdit, 'snapshot file changed');
}

/** Default jest-snapshot resolver inverse: `dir/__snapshots__/x.test.ts.snap` -> `dir/x.test.ts`. */
export function snapshotOwner(snapPath: string): string | null {
  const sep = snapPath.includes('\\') && !snapPath.includes('/') ? '\\' : '/';
  const parts = snapPath.split(sep);
  const base = parts.pop() ?? '';
  const dir = parts.pop();
  if (dir !== '__snapshots__' || !base.endsWith('.snap')) return null;
  return [...parts, base.slice(0, -'.snap'.length)].join(sep);
}

// ---------------------------------------------------------------------------------------------
// Toolchain files
// ---------------------------------------------------------------------------------------------

const TOOLCHAIN_BASENAMES: ReadonlyArray<RegExp> = [
  /^jest(\.[\w-]+)*\.config\.(c|m)?[jt]s(on)?$/,   // jest.config.js, jest.unit.config.js, jest.config.ts, jest.config.json
  /^package\.json$/,
  /^babel\.config\.(c|m)?[jt]s(on)?$/,
  /^\.babelrc(\.(c|m)?js|\.json)?$/,
  /^tsconfig(\.[\w-]+)*\.json$/,
  /^\.swcrc$/,
  /^(yarn\.lock|package-lock\.json|pnpm-lock\.yaml|npm-shrinkwrap\.json)$/,
];

/** True for Jest/Babel/TS configs, manifests, lockfiles, anything under node_modules, and host-supplied toolchain paths. */
export function isToolchainFile(path: string, toolchainFiles?: ReadonlySet<string>): boolean {
  if (toolchainFiles?.has(path)) return true;
  if (/[\\/]node_modules[\\/]/.test(path)) return true;
  const base = baseName(path);
  return TOOLCHAIN_BASENAMES.some(re => re.test(base));
}

// ---------------------------------------------------------------------------------------------
// Graph closure
// ---------------------------------------------------------------------------------------------

/**
 * Test files reachable by following `inverse` (file -> importers) from `start`, breadth-first,
 * with a visited set (cycles) and a size guard. Traversal continues through test files so helper
 * specs that re-export fixtures still lead to their consumers.
 */
export function inverseClosure(inverse: ReadonlyMap<string, ReadonlySet<string>>, start: string, testFiles: ReadonlySet<string>): string[] {
  const visited = new Set<string>([start]);
  const queue: string[] = [start];
  const found: string[] = [];
  while (queue.length > 0 && visited.size < CLOSURE_LIMIT) {
    const cur = queue.shift()!;
    for (const importer of inverse.get(cur) ?? []) {
      if (visited.has(importer)) continue;
      visited.add(importer);
      if (testFiles.has(importer)) found.push(importer);
      queue.push(importer);
    }
  }
  return found.sort();
}

// ---------------------------------------------------------------------------------------------
// Accumulation, failing tests, cap
// ---------------------------------------------------------------------------------------------

interface Selection {
  path: string;
  /** null = whole file. */
  names: Set<string> | null;
  /** Lower runs first when the cap applies (0 self, 1 execBy, 2 loadedBy, 3 static graph). */
  priority: number;
}

class SelectionAccumulator {
  private readonly byPath = new Map<string, Selection>();

  get size(): number { return this.byPath.size; }
  get paths(): string[] { return [...this.byPath.keys()]; }

  /** Returns true when the file was newly added. */
  addWhole(path: string, priority: number): boolean {
    const cur = this.byPath.get(path);
    if (cur) { cur.names = null; cur.priority = Math.min(cur.priority, priority); return false; }
    this.byPath.set(path, { path, names: null, priority });
    return true;
  }

  /** Returns true when the file was newly added. Whole-file selections absorb names. */
  addNames(path: string, names: readonly string[], priority: number): boolean {
    const cur = this.byPath.get(path);
    if (cur) {
      cur.priority = Math.min(cur.priority, priority);
      if (cur.names) for (const n of names) cur.names.add(n);
      return false;
    }
    this.byPath.set(path, { path, names: new Set(names), priority });
    return true;
  }

  /** Add names to an existing narrowed selection only (never widens a whole-file run, never adds files). */
  addNamesIfPresent(path: string, names: readonly string[]): boolean {
    const cur = this.byPath.get(path);
    if (!cur || !cur.names) return false;
    let added = false;
    for (const n of names) { if (!cur.names.has(n)) { cur.names.add(n); added = true; } }
    return added;
  }

  ordered(): Selection[] {
    return [...this.byPath.values()].sort((a, b) => a.priority - b.priority || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
}

/** D: previously failing tests of every selected file (Wallaby always re-runs them). Returns how many files gained names. */
function addFailing(acc: SelectionAccumulator, input: AffectedInput): number {
  if (!input.settings.alwaysRunFailing) return 0;
  let touched = 0;
  for (const path of acc.paths) {
    const failing = input.failingTestsByFile.get(path);
    if (!failing || failing.size === 0) continue;
    if (acc.addNamesIfPresent(path, [...failing].map(k => parseTestKey(k).fullName))) touched++;
  }
  return touched;
}

function finish(acc: SelectionAccumulator, counts: SourceCounts, cap: number, why: string): AffectedResult {
  const ordered = acc.ordered().map(toRunSelection);
  const limit = cap > 0 ? cap : ordered.length;
  const runs = ordered.slice(0, limit);
  const deferred = ordered.slice(limit);
  const total = ordered.length;
  const reason = `${total} test file${total === 1 ? '' : 's'}${why ? `: ${why}` : ''}${deferred.length ? ` (${deferred.length} deferred by cap ${cap})` : ''}`;
  return { kind: 'runs', runs, deferred, truncated: deferred.length > 0, reason, sources: counts };
}

function toRunSelection(s: Selection): RunTestSelection {
  return s.names ? { path: s.path, names: [...s.names].sort() } : { path: s.path };
}

function groupKeysByFile(keys: ReadonlySet<string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const key of keys) {
    const { path } = parseTestKey(key);
    const list = out.get(path);
    if (list) list.push(key); else out.set(path, [key]);
  }
  return out;
}

function isRuntimeTracked(input: AffectedInput, testFile: string): boolean {
  return input.runtimeTrackedTestFiles?.has(testFile) ?? false;
}

function emptyCounts(): SourceCounts {
  return { self: 0, execBy: 0, loadedBy: 0, staticGraph: 0, failingAdded: 0, narrowed: false };
}

function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
}
