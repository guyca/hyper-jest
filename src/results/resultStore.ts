/**
 * Host-side result store. Pure (no 'vscode'); fed by WorkerToHost messages via `apply()` and read
 * by the UI surfaces (decorations, diagnostics, hover, status bar, Test Explorer, code lenses).
 *
 * Data model (see core/resultModel.ts for the public record types):
 *  - tests          testKey (`path\0fullName\0dupIndex`) -> TestRecord
 *  - files          test file path -> FileRecord (status, testExecError, snapshot summary, keys)
 *  - coverage       SOURCE file path -> FileCoverage (meta + per-test hits + file-level union hits)
 *  - loadedBy       source -> test FILES that executed its module scope while loading
 *  - execBy         source -> testKeys that executed at least one of its statements
 *  - inline entries file -> 0-based line -> console/value entries, each tagged with its run generation
 *
 * Run generations: messages for a test file arrive under a `runId`. Per-test data (result, coverage,
 * console/value entries tagged with a testKey) is committed as soon as the test's result arrives so
 * the UI updates live; file-level data (union coverage, loaded files, untagged console entries) is
 * committed when the file's `fileResult` arrives. At that point every contribution of the test file
 * that belongs to an older generation is dropped, so a test that stopped logging or stopped covering
 * a statement disappears from the UI, and a test deleted from the file is removed after an
 * unfiltered run. A narrowed run (`names`) reports the de-selected tests as `pending` (jest-circus
 * `utils.js` 473); their previous results and contributions are kept.
 *
 * Change notification is coalesced (16 ms by default, timer injectable) and reports changed paths
 * (test files and source files alike).
 */
import type {
  ConsoleMsg, FailureInfo, FileCoverageMsg, FileLoadMsg, FileResultMsg, RunCompleteMsg, RunTestSelection,
  TestCoverageMsg, TestResultMsg, TestStartMsg, TestStatus, ValueMsg, WorkerToHost,
} from '../core/protocol';
import { makeTestKey, parseTestKey } from '../core/protocol';
import type { CoverageMeta, FileCoverage, FileRecord, InlineEntry, RunSummary, TestRecord } from '../core/resultModel';
import type { ParsedFile } from '../core/testModel';

export interface ResultStoreOptions {
  /** Coalescing window for `onDidChange` in ms (default 16). */
  coalesceMs?: number;
  /** Injectable timer (defaults to setTimeout/clearTimeout). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
  /** Max inline entries kept per (file, line) and run generation (default 50). */
  maxEntriesPerLine?: number;
}

/** Stale (pre-edit) marker for a file. `lines` are 0-based; `all` marks the whole file. */
export interface StaleInfo {
  all: boolean;
  lines: Set<number>;
  /** When the mark was set; a run that started earlier does not clear it. */
  at: number;
}

export interface StartedTest { fullName: string; ancestorTitles: string[]; title: string; }

/** What the store remembers about the last completed run of a test file. */
export interface LastRunInfo { runId: string; filtered: boolean; names?: string[]; at: number; /** When the run of the file started (stale marks set before it are satisfied). */ startedAt: number; }

export type ChangeListener = (changedPaths: string[]) => void;

interface OwnedEntry {
  entry: InlineEntry;
  /** Test file whose run produced the entry (removal index). */
  owner: string;
}

interface PendingRun {
  runId: string;
  path: string;
  projectId: string;
  startedAt: number;
  filtered: boolean;
  names: Set<string>;
  prevStatus: FileRecord['status'];
  /** testKeys whose result arrived in this run. */
  seenTests: Set<string>;
  /** De-selected tests of a narrowed run whose previous result was kept. */
  keptTests: Set<string>;
  /** Per-test coverage received before the test's result (testKey -> source -> stmt ids). */
  perTest: Map<string, Map<string, number[]>>;
  /** File-level coverage (source -> hits). */
  fileHits: Map<string, { hash: string; stmts: Set<number>; arms: Set<string> }>;
  loaded: Set<string>;
  /** Inline entries waiting for their test's result (testKey -> entries) or for `fileResult` (no key). */
  entriesByTest: Map<string, Array<{ file: string; line: number; entry: InlineEntry }>>;
  untaggedEntries: Array<{ file: string; line: number; entry: InlineEntry }>;
}

const INACTIVE_STATUSES: ReadonlySet<TestStatus> = new Set<TestStatus>(['pending', 'skipped', 'todo', 'disabled']);

export function isFailingStatus(status: TestStatus): boolean {
  return status === 'failed' || status === 'errored';
}
export function isInactiveStatus(status: TestStatus): boolean {
  return INACTIVE_STATUSES.has(status);
}

export class ResultStore {
  private readonly tests = new Map<string, TestRecord>();
  private readonly files = new Map<string, FileRecord>();
  private readonly parsedFiles = new Map<string, ParsedFile>();
  private readonly coverage = new Map<string, FileCoverage>();
  private readonly loadedByMap = new Map<string, Set<string>>();
  private readonly execByMap = new Map<string, Set<string>>();
  /** testKey -> sources holding `stmtHitBy` entries for it. */
  private readonly testSources = new Map<string, Set<string>>();
  /** test file -> sources holding file-level hits for it. */
  private readonly fileSources = new Map<string, Set<string>>();
  /** test file -> sources it loads (inverse of loadedByMap). */
  private readonly fileLoads = new Map<string, Set<string>>();
  private readonly inline = new Map<string, Map<number, OwnedEntry[]>>();
  /** owner test file -> files holding inline entries it produced. */
  private readonly entryFiles = new Map<string, Set<string>>();
  private readonly staleMap = new Map<string, StaleInfo>();
  private readonly runRegistrations = new Map<string, Map<string, RunTestSelection>>();
  private readonly pending = new Map<string, PendingRun>();
  private readonly startedTests = new Map<string, Map<string, StartedTest>>();
  private readonly lastRuns = new Map<string, LastRunInfo>();
  /** path -> start time of the newest committed run whose data (coverage, loads, entries, results) touched it. */
  private readonly dataStarts = new Map<string, number>();
  /** path -> status the file had before markQueued (restored by unmarkQueued). */
  private readonly preQueueStatus = new Map<string, FileRecord['status']>();

  private readonly listeners = new Set<ChangeListener>();
  private readonly changed = new Set<string>();
  private timer: unknown;
  private readonly coalesceMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly now: () => number;
  private readonly maxEntriesPerLine: number;

  /** Monotonic counter bumped on every mutation (cheap cache invalidation for view consumers). */
  generation = 0;

  constructor(opts: ResultStoreOptions = {}) {
    this.coalesceMs = opts.coalesceMs ?? 16;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? (h => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.now = opts.now ?? (() => Date.now());
    this.maxEntriesPerLine = opts.maxEntriesPerLine ?? 50;
  }

  // ------------------------------------------------------------------------------------------
  // Run bookkeeping (called by the RunCoordinator)
  // ------------------------------------------------------------------------------------------

  /**
   * Tells the store which files/names a run covers so narrowed runs keep the results of
   * de-selected tests and unfiltered runs drop deleted tests. Optional: an unregistered run is
   * treated as unfiltered.
   */
  registerRun(runId: string, tests: RunTestSelection[]): void {
    const byPath = new Map<string, RunTestSelection>();
    for (const t of tests) byPath.set(t.path, t);
    this.runRegistrations.set(runId, byPath);
  }

  /** Marks a test file as queued (waiting for a worker). */
  markQueued(path: string, projectId?: string): void {
    const file = this.ensureFile(path, projectId ?? this.files.get(path)?.projectId ?? '');
    if (file.status === 'running') return;
    if (file.status !== 'queued') this.preQueueStatus.set(path, file.status);
    file.status = 'queued';
    file.updatedAt = this.now();
    this.touch(path);
  }

  /**
   * Undoes markQueued for a file that left the queue without running (cancelled, dropped): restores
   * the status it had before. No-op unless the file is still `queued`.
   */
  unmarkQueued(path: string): void {
    const prev = this.preQueueStatus.get(path);
    this.preQueueStatus.delete(path);
    const file = this.files.get(path);
    if (!file || file.status !== 'queued') return;
    file.status = prev ?? 'unknown';
    file.updatedAt = this.now();
    this.touch(path);
  }

  /** Marks a test file as running. `run` is optional; `fileStart` from the worker does the same. */
  markRunning(path: string, run?: { runId: string; names?: string[]; projectId?: string }): void {
    const file = this.ensureFile(path, run?.projectId ?? this.files.get(path)?.projectId ?? '');
    if (run) this.ensurePending(run.runId, path, file.projectId, run.names);
    this.preQueueStatus.delete(path);
    if (file.status !== 'running') {
      file.status = 'running';
      file.updatedAt = this.now();
    }
    this.touch(path);
  }

  /**
   * Marks a file's results as predating an edit. With `changedLines` (0-based) only those lines are
   * drawn hollow; without, the whole file is. Works for source files and test files alike.
   */
  markStale(path: string, changedLines?: Iterable<number>): void {
    const existing = this.staleMap.get(path);
    const info: StaleInfo = existing ?? { all: false, lines: new Set(), at: this.now() };
    info.at = this.now();
    // Only a change of what is drawn notifies: every keystroke re-applying the decorations would
    // throw away the editor's own range tracking of the lines being edited.
    let changed = !existing;
    if (!changedLines) { changed ||= !info.all; info.all = true; }
    else for (const l of changedLines) if (!info.lines.has(l)) { info.lines.add(l); changed = true; }
    this.staleMap.set(path, info);
    const file = this.files.get(path);
    if (file) {
      changed ||= !file.stale;
      file.stale = true;
      for (const key of file.testKeys) {
        const t = this.tests.get(key);
        if (t && !t.stale) { t.stale = true; changed = true; }
      }
    }
    if (changed) this.touch(path);
  }

  /** Drops the stale marker of a path without touching results (e.g. after an undo). */
  clearStale(path: string): void {
    if (!this.staleMap.delete(path)) return;
    const file = this.files.get(path);
    if (file) {
      file.stale = false;
      for (const key of file.testKeys) {
        const t = this.tests.get(key);
        if (t) t.stale = false;
      }
    }
    this.touch(path);
  }

  /** Forgets everything about a test file (results, coverage contributions, inline entries). */
  clearFile(path: string): void {
    const file = this.files.get(path);
    if (file) for (const key of [...file.testKeys]) this.removeTest(key);
    this.removeFileLevelContributions(path);
    this.removeLoadedBy(path);
    this.removeEntries(path, () => true);
    this.files.delete(path);
    this.parsedFiles.delete(path);
    this.staleMap.delete(path);
    this.startedTests.delete(path);
    this.lastRuns.delete(path);
    this.dataStarts.delete(path);
    this.preQueueStatus.delete(path);
    for (const [k, p] of this.pending) if (p.path === path) this.pending.delete(k);
    this.touch(path);
  }

  /** Forgets every file of a project. */
  clearProject(projectId: string): void {
    for (const [path, file] of [...this.files]) if (file.projectId === projectId) this.clearFile(path);
  }

  /** Marks a run as aborted (worker killed); pending data of the run is discarded. */
  abortRun(runId: string): void {
    this.finishRun(runId, true, undefined);
  }

  /** Records the statically parsed shape of a test file (declaration + snapshot lines). */
  setParsed(path: string, parsed: ParsedFile): void {
    this.parsedFiles.set(path, parsed);
    this.touch(path);
  }

  // ------------------------------------------------------------------------------------------
  // Message intake
  // ------------------------------------------------------------------------------------------

  /** Applies one worker message. `projectId` identifies the project whose worker sent it. */
  apply(msg: WorkerToHost, projectId: string): void {
    switch (msg.type) {
      case 'fileStart': {
        const file = this.ensureFile(msg.path, projectId);
        this.ensurePending(msg.runId, msg.path, projectId);
        file.status = 'running';
        file.updatedAt = this.now();
        this.touch(msg.path);
        return;
      }
      case 'testStart': return this.onTestStart(msg, projectId);
      case 'testResult': return this.onTestResult(msg, projectId);
      case 'testCoverage': return this.onTestCoverage(msg, projectId);
      case 'fileLoad': return this.onFileLoad(msg, projectId);
      case 'coverageMeta': return this.setCoverageMeta(msg.path, {
        hash: msg.hash, stmtStartLine: msg.stmtStartLine, stmtEndLine: msg.stmtEndLine,
        fnDeclLine: msg.fnDeclLine, fnEndLine: msg.fnEndLine, branchArms: msg.branchArms, remapped: msg.remapped,
      });
      case 'fileCoverage': return this.onFileCoverage(msg, projectId);
      case 'console': return this.onConsole(msg, projectId);
      case 'value': return this.onValue(msg, projectId);
      case 'fileResult': return this.onFileResult(msg, projectId);
      case 'runComplete': return this.onRunComplete(msg);
      default: return;
    }
  }

  // ------------------------------------------------------------------------------------------
  // Getters
  // ------------------------------------------------------------------------------------------

  fileRecord(path: string): FileRecord | undefined { return this.files.get(path); }
  test(testKey: string): TestRecord | undefined { return this.tests.get(testKey); }
  parsed(path: string): ParsedFile | undefined { return this.parsedFiles.get(path); }
  coverageFor(path: string): FileCoverage | undefined { return this.coverage.get(path); }
  staleInfo(path: string): StaleInfo | undefined { return this.staleMap.get(path); }
  lastRun(path: string): LastRunInfo | undefined { return this.lastRuns.get(path); }
  /**
   * When the newest run whose data touched `path` started (a source file's coverage/entries come from
   * test-file runs, so `lastRun` knows only test files). Undefined when no committed run touched it.
   */
  dataStartedAt(path: string): number | undefined { return this.dataStarts.get(path); }
  /** Tests whose `testStart` arrived in the in-flight run of `path`. */
  started(path: string): StartedTest[] { return [...(this.startedTests.get(path)?.values() ?? [])]; }
  /** Every test file the store knows about. */
  allFiles(): FileRecord[] { return [...this.files.values()]; }
  allTests(): TestRecord[] { return [...this.tests.values()]; }

  /** Tests of a test file, ordered by declaration line then full name. */
  testsInFile(path: string): TestRecord[] {
    const file = this.files.get(path);
    if (!file) return [];
    const out: TestRecord[] = [];
    for (const key of file.testKeys) {
      const t = this.tests.get(key);
      if (t) out.push(t);
    }
    return out.sort((a, b) => (a.location?.line ?? 1e9) - (b.location?.line ?? 1e9) || a.fullName.localeCompare(b.fullName) || a.testKey.localeCompare(b.testKey));
  }

  failingTests(): TestRecord[] {
    const out: TestRecord[] = [];
    for (const t of this.tests.values()) if (isFailingStatus(t.status)) out.push(t);
    return out;
  }

  summary(): RunSummary {
    const s: RunSummary = { passed: 0, failed: 0, pending: 0, running: 0, queued: 0, staleFiles: 0 };
    for (const t of this.tests.values()) {
      if (isFailingStatus(t.status)) s.failed++;
      else if (isInactiveStatus(t.status)) s.pending++;
      else s.passed++;
    }
    for (const f of this.files.values()) {
      if (f.status === 'running') s.running++;
      else if (f.status === 'queued') s.queued++;
      if (f.stale) s.staleFiles++;
      // A file that failed to load counts as one failure even though it reported no tests.
      if (f.testExecError && f.status === 'errored') s.failed++;
    }
    return s;
  }

  /** source file -> testKeys that executed it (per-test coverage mode). */
  execBy(): Map<string, Set<string>> { return this.execByMap; }
  /** source file -> test files whose module load executed it. */
  loadedBy(): Map<string, Set<string>> { return this.loadedByMap; }

  /** Inline console/value entries of a file, keyed by 0-based line. */
  entriesFor(path: string): Map<number, InlineEntry[]> {
    const out = new Map<number, InlineEntry[]>();
    const lines = this.inline.get(path);
    if (!lines) return out;
    for (const [line, owned] of lines) out.set(line, owned.map(o => o.entry));
    return out;
  }

  /** Source files that the given test file (or its tests) contributed coverage/loads to. */
  coveredSourcesOf(testFilePath: string): Set<string> {
    const out = new Set<string>(this.fileSources.get(testFilePath) ?? []);
    for (const s of this.fileLoads.get(testFilePath) ?? []) out.add(s);
    const file = this.files.get(testFilePath);
    if (file) for (const key of file.testKeys) for (const s of this.testSources.get(key) ?? []) out.add(s);
    return out;
  }

  /** Removes inline entries on one line of a file (Esc) or the whole file (Esc Esc). */
  clearInlineEntries(path: string, line?: number): void {
    const lines = this.inline.get(path);
    if (!lines) return;
    if (line === undefined) this.inline.delete(path);
    else lines.delete(line);
    this.touch(path);
  }

  // ------------------------------------------------------------------------------------------
  // Change notification
  // ------------------------------------------------------------------------------------------

  onDidChange(listener: ChangeListener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  /** Delivers pending change notifications now (tests, shutdown). */
  flush(): void {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    if (this.changed.size === 0) return;
    const paths = [...this.changed];
    this.changed.clear();
    for (const l of this.listeners) l(paths);
  }

  dispose(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    this.listeners.clear();
  }

  // ------------------------------------------------------------------------------------------
  // Internals: intake handlers
  // ------------------------------------------------------------------------------------------

  private onTestStart(m: TestStartMsg, projectId: string): void {
    this.ensurePending(m.runId, m.path, projectId);
    let started = this.startedTests.get(m.path);
    if (!started) this.startedTests.set(m.path, (started = new Map()));
    started.set(m.fullName, { fullName: m.fullName, ancestorTitles: m.ancestorTitles, title: m.title });
    const file = this.ensureFile(m.path, projectId);
    if (file.status !== 'running') file.status = 'running';
    this.touch(m.path);
  }

  private onTestResult(m: TestResultMsg, projectId: string): void {
    const p = this.ensurePending(m.runId, m.path, projectId);
    const key = m.testKey || makeTestKey(m.path, m.fullName, 0);
    const existing = this.tests.get(key);
    if (p.filtered && existing && isInactiveStatus(m.status) && !p.names.has(m.fullName)) {
      // Narrowed run: Jest reports de-selected tests as pending. Keep what we knew.
      p.seenTests.add(key);
      p.keptTests.add(key);
      return;
    }
    const file = this.ensureFile(m.path, projectId);
    const record: TestRecord = {
      testKey: key,
      path: m.path,
      projectId: file.projectId || projectId,
      fullName: m.fullName,
      ancestorTitles: m.ancestorTitles,
      title: m.title,
      status: m.status,
      duration: m.duration,
      location: m.location,
      failures: m.failures,
      invocations: m.invocations,
      lastRunId: m.runId,
      updatedAt: this.now(),
      stale: false,
    };
    this.tests.set(key, record);
    file.testKeys.add(key);
    p.seenTests.add(key);
    // Commit per-test data that arrived before the result.
    const cov = p.perTest.get(key);
    p.perTest.delete(key);
    const touched = this.replaceTestCoverage(key, cov);
    for (const s of touched) this.touch(s);
    const entries = p.entriesByTest.get(key);
    p.entriesByTest.delete(key);
    this.replaceTestEntries(m.path, key, entries ?? []);
    this.touch(m.path);
  }

  private onTestCoverage(m: TestCoverageMsg, projectId: string): void {
    const p = this.ensurePending(m.runId, m.path, projectId);
    const bySource = new Map<string, number[]>();
    for (const f of m.files) {
      const prev = bySource.get(f.path);
      bySource.set(f.path, prev ? prev.concat(f.stmts) : f.stmts.slice());
    }
    if (p.seenTests.has(m.testKey) && !p.keptTests.has(m.testKey)) {
      // Result already arrived: merge with what this run already committed for the test.
      const current = this.perTestHits(m.testKey);
      for (const [src, stmts] of bySource) {
        const prev = current.get(src);
        current.set(src, prev ? prev.concat(stmts) : stmts);
      }
      for (const s of this.replaceTestCoverage(m.testKey, current)) this.touch(s);
      return;
    }
    const stash = p.perTest.get(m.testKey) ?? new Map<string, number[]>();
    for (const [src, stmts] of bySource) {
      const prev = stash.get(src);
      stash.set(src, prev ? prev.concat(stmts) : stmts);
    }
    p.perTest.set(m.testKey, stash);
  }

  /**
   * True when `fileResult` of (runId, path) was already committed. File-level messages that arrive
   * after it (CLI reporter, degraded warm engine) are then committed directly instead of opening a
   * new pending run that nothing would ever close (or that `runComplete` would turn into an error).
   */
  private isCommitted(runId: string, path: string): boolean {
    return !this.pending.has(pendingKey(runId, path)) && this.lastRuns.get(path)?.runId === runId;
  }

  private onFileLoad(m: FileLoadMsg, projectId: string): void {
    if (this.isCommitted(m.runId, m.path)) {
      for (const src of m.files) {
        addTo(this.loadedByMap, src, m.path);
        addTo(this.fileLoads, m.path, src);
        this.clearSatisfiedStale(src, this.lastRuns.get(m.path)!.startedAt);
        this.touch(src);
      }
      return;
    }
    const p = this.ensurePending(m.runId, m.path, projectId);
    for (const f of m.files) p.loaded.add(f);
  }

  private onFileCoverage(m: FileCoverageMsg, projectId: string): void {
    if (this.isCommitted(m.runId, m.path)) {
      for (const f of m.files) {
        const cov = this.ensureCoverage(f.path);
        for (const s of f.hitStmts) addTo(cov.stmtHitByFile, s, m.path);
        for (let i = 0; i + 1 < f.hitBranchArms.length; i += 2) addTo(cov.branchArmHitByFile, `${f.hitBranchArms[i]}:${f.hitBranchArms[i + 1]}`, m.path);
        addTo(this.fileSources, m.path, f.path);
        this.clearSatisfiedStale(f.path, this.lastRuns.get(m.path)!.startedAt);
        this.touch(f.path);
      }
      return;
    }
    const p = this.ensurePending(m.runId, m.path, projectId);
    for (const f of m.files) {
      let bucket = p.fileHits.get(f.path);
      if (!bucket) p.fileHits.set(f.path, (bucket = { hash: f.hash, stmts: new Set(), arms: new Set() }));
      bucket.hash = f.hash;
      for (const s of f.hitStmts) bucket.stmts.add(s);
      for (let i = 0; i + 1 < f.hitBranchArms.length; i += 2) bucket.arms.add(`${f.hitBranchArms[i]}:${f.hitBranchArms[i + 1]}`);
    }
  }

  private onConsole(m: ConsoleMsg, projectId: string): void {
    if (m.line === undefined) return; // nothing to anchor the entry to
    const file = m.file ?? m.path;
    this.stashEntry(this.ensurePending(m.runId, m.path, projectId), file, m.line - 1, {
      kind: 'log', text: m.text, runId: m.runId, testKey: m.testKey, level: m.level,
    });
  }

  private onValue(m: ValueMsg, projectId: string): void {
    this.stashEntry(this.ensurePending(m.runId, m.path, projectId), m.file, m.line - 1, {
      kind: 'value', text: m.text, runId: m.runId, testKey: m.testKey,
    });
  }

  private stashEntry(p: PendingRun, file: string, line: number, entry: InlineEntry): void {
    const item = { file, line, entry };
    if (entry.testKey && !p.keptTests.has(entry.testKey)) {
      if (p.seenTests.has(entry.testKey)) {
        this.addEntry(p.path, item);
        this.touch(file);
      } else {
        let list = p.entriesByTest.get(entry.testKey);
        if (!list) p.entriesByTest.set(entry.testKey, (list = []));
        list.push(item);
      }
    } else if (!entry.testKey) {
      p.untaggedEntries.push(item);
    }
  }

  private onFileResult(m: FileResultMsg, projectId: string): void {
    const p = this.ensurePending(m.runId, m.path, projectId);
    const file = this.ensureFile(m.path, projectId);
    const touched = new Set<string>([m.path]);

    file.status = m.testExecError && m.status !== 'notMatched' ? 'errored' : m.status;
    file.testExecError = m.testExecError;
    file.snapshot = m.snapshot;
    file.lastRunId = m.runId;
    file.updatedAt = this.now();

    // File-level coverage: replace this test file's previous contributions. A narrowed run only
    // executed the selected tests, so its union is merged into (not substituted for) the previous one.
    if (!p.filtered) for (const s of this.removeFileLevelContributions(m.path)) touched.add(s);
    for (const [src, hits] of p.fileHits) {
      const cov = this.ensureCoverage(src);
      for (const s of hits.stmts) addTo(cov.stmtHitByFile, s, m.path);
      for (const a of hits.arms) addTo(cov.branchArmHitByFile, a, m.path);
      addTo(this.fileSources, m.path, src);
      touched.add(src);
    }

    // Loaded-by: replace (merge for narrowed runs, same reasoning as above).
    if (!p.filtered) for (const s of this.removeLoadedBy(m.path)) touched.add(s);
    for (const src of p.loaded) {
      addTo(this.loadedByMap, src, m.path);
      addTo(this.fileLoads, m.path, src);
      touched.add(src);
    }

    // Per-test coverage for tests that never reported (defensive).
    for (const [key, cov] of p.perTest) for (const s of this.replaceTestCoverage(key, cov)) touched.add(s);
    p.perTest.clear();

    // Unfiltered run: tests not reported any more were deleted from the file.
    if (!p.filtered) {
      for (const key of [...file.testKeys]) {
        if (!p.seenTests.has(key)) for (const s of this.removeTest(key)) touched.add(s);
      }
    }

    // Inline entries: drop older generations of this file's output (kept tests excepted).
    for (const s of this.removeEntries(m.path, e => e.runId !== m.runId && !(e.testKey !== undefined && p.keptTests.has(e.testKey)))) touched.add(s);
    for (const item of p.untaggedEntries) { this.addEntry(m.path, item); touched.add(item.file); }
    for (const [, list] of p.entriesByTest) for (const item of list) { this.addEntry(m.path, item); touched.add(item.file); }
    for (const c of m.console ?? []) {
      if (c.line === undefined) continue;
      const f = c.file ?? m.path;
      this.addEntry(m.path, { file: f, line: c.line - 1, entry: { kind: 'log', text: c.text, runId: m.runId, level: c.level } });
      touched.add(f);
    }

    // Stale markers set before this run started are now satisfied.
    for (const path of touched) this.clearSatisfiedStale(path, p.startedAt);
    file.stale = this.staleMap.has(m.path);
    for (const key of p.seenTests) {
      const t = this.tests.get(key);
      if (t && !p.keptTests.has(key)) t.stale = file.stale;
    }

    this.lastRuns.set(m.path, { runId: m.runId, filtered: p.filtered, names: p.filtered ? [...p.names] : undefined, at: this.now(), startedAt: p.startedAt });
    this.startedTests.delete(m.path);
    this.pending.delete(pendingKey(m.runId, m.path));
    for (const s of touched) this.touch(s);
  }

  /** Records that a run started at `startedAt` refreshed `path`'s data; drops a stale mark set before it. */
  private clearSatisfiedStale(path: string, startedAt: number): void {
    if (startedAt > (this.dataStarts.get(path) ?? -Infinity)) this.dataStarts.set(path, startedAt);
    const st = this.staleMap.get(path);
    if (st && st.at <= startedAt) {
      this.staleMap.delete(path);
      const f = this.files.get(path);
      if (f) f.stale = false;
    }
  }

  private onRunComplete(m: RunCompleteMsg): void {
    this.finishRun(m.runId, m.wasInterrupted, m.error);
  }

  /** Closes every pending file of a run: interrupted runs are discarded, others are force-committed. */
  private finishRun(runId: string, interrupted: boolean, error: string | undefined): void {
    for (const [k, p] of [...this.pending]) {
      if (p.runId !== runId) continue;
      if (interrupted) {
        const file = this.files.get(p.path);
        if (file && file.status === 'running') file.status = p.prevStatus === 'running' || p.prevStatus === 'queued' ? 'unknown' : p.prevStatus;
        this.startedTests.delete(p.path);
        this.pending.delete(k);
        this.touch(p.path);
      } else {
        // No fileResult arrived: treat as a file-level error so the UI never shows a spinner forever.
        const exec: FailureInfo = { message: error ?? 'The run ended without a result for this file.', frames: [] };
        this.onFileResult({
          v: 1, type: 'fileResult', runId, path: p.path, status: 'errored', testExecError: exec,
          numPassing: 0, numFailing: 0, numPending: 0, numTodo: 0,
        }, p.projectId);
      }
    }
    this.runRegistrations.delete(runId);
  }

  // ------------------------------------------------------------------------------------------
  // Internals: coverage
  // ------------------------------------------------------------------------------------------

  private setCoverageMeta(path: string, meta: CoverageMeta): void {
    const cov = this.ensureCoverage(path);
    if (cov.meta && cov.meta.hash !== meta.hash) {
      // Statement ids changed with the file: previous hits no longer line up.
      for (const key of [...cov.stmtHitBy.values()].flatMap(s => [...s])) this.testSources.get(key)?.delete(path);
      for (const tf of [...cov.stmtHitByFile.values()].flatMap(s => [...s])) this.fileSources.get(tf)?.delete(path);
      cov.stmtHitBy.clear();
      cov.stmtHitByFile.clear();
      cov.branchArmHitByFile.clear();
      this.execByMap.delete(path);
    }
    cov.meta = meta;
    this.touch(path);
  }

  /** Current per-test hits of a test (source -> stmt ids), reconstructed from the hit maps. */
  private perTestHits(testKey: string): Map<string, number[]> {
    const out = new Map<string, number[]>();
    for (const src of this.testSources.get(testKey) ?? []) {
      const cov = this.coverage.get(src);
      if (!cov) continue;
      const ids: number[] = [];
      for (const [s, keys] of cov.stmtHitBy) if (keys.has(testKey)) ids.push(s);
      out.set(src, ids);
    }
    return out;
  }

  /** Replaces a test's statement hits; returns the touched source paths. */
  private replaceTestCoverage(testKey: string, hits: Map<string, number[]> | undefined): Set<string> {
    const touched = new Set<string>();
    for (const src of this.testSources.get(testKey) ?? []) {
      const cov = this.coverage.get(src);
      if (cov) for (const [s, keys] of cov.stmtHitBy) if (keys.delete(testKey) && keys.size === 0) cov.stmtHitBy.delete(s);
      const ex = this.execByMap.get(src);
      if (ex && ex.delete(testKey) && ex.size === 0) this.execByMap.delete(src);
      touched.add(src);
    }
    this.testSources.delete(testKey);
    if (hits) {
      for (const [src, stmts] of hits) {
        if (stmts.length === 0) continue;
        const cov = this.ensureCoverage(src);
        for (const s of stmts) addTo(cov.stmtHitBy, s, testKey);
        addTo(this.execByMap, src, testKey);
        addTo(this.testSources, testKey, src);
        touched.add(src);
      }
    }
    return touched;
  }

  private removeFileLevelContributions(testFile: string): Set<string> {
    const touched = new Set<string>();
    for (const src of this.fileSources.get(testFile) ?? []) {
      const cov = this.coverage.get(src);
      if (cov) {
        for (const [s, files] of cov.stmtHitByFile) if (files.delete(testFile) && files.size === 0) cov.stmtHitByFile.delete(s);
        for (const [a, files] of cov.branchArmHitByFile) if (files.delete(testFile) && files.size === 0) cov.branchArmHitByFile.delete(a);
      }
      touched.add(src);
    }
    this.fileSources.delete(testFile);
    return touched;
  }

  private removeLoadedBy(testFile: string): Set<string> {
    const touched = new Set<string>();
    for (const src of this.fileLoads.get(testFile) ?? []) {
      const set = this.loadedByMap.get(src);
      if (set && set.delete(testFile) && set.size === 0) this.loadedByMap.delete(src);
      touched.add(src);
    }
    this.fileLoads.delete(testFile);
    return touched;
  }

  /** Removes a test record and all its contributions; returns touched paths. */
  private removeTest(testKey: string): Set<string> {
    const touched = this.replaceTestCoverage(testKey, undefined);
    const t = this.tests.get(testKey);
    if (t) {
      this.files.get(t.path)?.testKeys.delete(testKey);
      for (const s of this.removeEntries(t.path, e => e.testKey === testKey)) touched.add(s);
      touched.add(t.path);
    }
    this.tests.delete(testKey);
    return touched;
  }

  // ------------------------------------------------------------------------------------------
  // Internals: inline entries
  // ------------------------------------------------------------------------------------------

  private addEntry(owner: string, item: { file: string; line: number; entry: InlineEntry }): void {
    let lines = this.inline.get(item.file);
    if (!lines) this.inline.set(item.file, (lines = new Map()));
    let list = lines.get(item.line);
    if (!list) lines.set(item.line, (list = []));
    const sameGen = list.filter(o => o.entry.runId === item.entry.runId).length;
    if (sameGen >= this.maxEntriesPerLine) return;
    list.push({ owner, entry: item.entry });
    addTo(this.entryFiles, owner, item.file);
  }

  private replaceTestEntries(owner: string, testKey: string, items: Array<{ file: string; line: number; entry: InlineEntry }>): void {
    for (const s of this.removeEntries(owner, e => e.testKey === testKey)) this.touch(s);
    for (const item of items) { this.addEntry(owner, item); this.touch(item.file); }
  }

  /** Removes entries produced by `owner` matching `pred`; returns touched files. */
  private removeEntries(owner: string, pred: (e: InlineEntry) => boolean): Set<string> {
    const touched = new Set<string>();
    const files = this.entryFiles.get(owner);
    if (!files) return touched;
    for (const file of [...files]) {
      const lines = this.inline.get(file);
      if (!lines) { files.delete(file); continue; }
      let stillOwns = false;
      for (const [line, list] of [...lines]) {
        const kept = list.filter(o => !(o.owner === owner && pred(o.entry)));
        if (kept.length !== list.length) touched.add(file);
        if (kept.length === 0) lines.delete(line);
        else {
          lines.set(line, kept);
          if (kept.some(o => o.owner === owner)) stillOwns = true;
        }
      }
      if (lines.size === 0) this.inline.delete(file);
      if (!stillOwns) files.delete(file);
    }
    if (files.size === 0) this.entryFiles.delete(owner);
    return touched;
  }

  // ------------------------------------------------------------------------------------------
  // Internals: records and pending runs
  // ------------------------------------------------------------------------------------------

  private ensureFile(path: string, projectId: string): FileRecord {
    let f = this.files.get(path);
    if (!f) {
      f = { path, projectId, status: 'unknown', testKeys: new Set(), updatedAt: this.now(), stale: this.staleMap.has(path) };
      this.files.set(path, f);
    } else if (!f.projectId && projectId) {
      f.projectId = projectId;
    }
    return f;
  }

  private ensureCoverage(path: string): FileCoverage {
    let c = this.coverage.get(path);
    if (!c) {
      c = { stmtHitBy: new Map(), stmtHitByFile: new Map(), branchArmHitByFile: new Map() };
      this.coverage.set(path, c);
    }
    return c;
  }

  private ensurePending(runId: string, path: string, projectId: string, names?: string[]): PendingRun {
    const key = pendingKey(runId, path);
    let p = this.pending.get(key);
    if (!p) {
      const reg = this.runRegistrations.get(runId)?.get(path);
      const filterNames = names ?? reg?.names;
      const file = this.files.get(path);
      p = {
        runId, path, projectId, startedAt: this.now(),
        filtered: !!filterNames && filterNames.length > 0,
        names: new Set(filterNames ?? []),
        prevStatus: file?.status ?? 'unknown',
        seenTests: new Set(), keptTests: new Set(), perTest: new Map(), fileHits: new Map(), loaded: new Set(),
        entriesByTest: new Map(), untaggedEntries: [],
      };
      this.pending.set(key, p);
      // A newer generation for the same file supersedes any older in-flight one.
      for (const [k, other] of [...this.pending]) if (other.path === path && other.runId !== runId && other.startedAt < p.startedAt) this.pending.delete(k);
    } else if (names && names.length > 0 && !p.filtered) {
      p.filtered = true;
      for (const n of names) p.names.add(n);
    }
    return p;
  }

  private touch(path: string): void {
    this.generation++;
    this.changed.add(path);
    if (this.timer === undefined) {
      this.timer = this.setTimer(() => { this.timer = undefined; this.flush(); }, this.coalesceMs);
    }
  }
}

function pendingKey(runId: string, path: string): string {
  return `${runId}\0${path}`;
}

function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(value);
}

/** Convenience: the test file path of a testKey. */
export function testKeyPath(testKey: string): string {
  return parseTestKey(testKey).path;
}
