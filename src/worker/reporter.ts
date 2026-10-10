/**
 * HyperJest's Jest reporter: streams NDJSON events (see src/core/cliEvents.ts) to fd 3 of the Jest
 * process. Loaded by Jest via `--reporters=<ext>/dist/worker/reporter.cjs` (CLI engine, Debug and
 * Doctor's "compare with plain Jest"). esbuild bundles this file together with the core helpers
 * into ONE standalone CommonJS file: it has no runtime dependency on the project's node_modules
 * and works identically under Jest 29.7, 30.4 and 30.5.
 *
 * Contract with Jest (verified in @jest/core 29.7 TestScheduler.js:385-391 and 30.5.2
 * build/index.js:1230): `new Reporter(globalConfig, reporterOptions, reporterContext)`, hooks
 * `onRunStart`, `onTestFileStart`, `onTestCaseStart` (30+), `onTestCaseResult`, `onTestFileResult`,
 * `onRunComplete`, `getLastError`. `TestResult.console` and `TestResult.coverage` are only
 * populated inside `onTestFileResult` (ReporterDispatcher clears them afterwards; 29.7
 * jest-runner runTest.js:399-406, 30.5.2 jest-runner index.js:278-285).
 *
 * fd 3 handling: when fd 3 is absent/closed (js-debug launches, plain `jest` runs) every write
 * error is swallowed and events are buffered; `onRunComplete` makes one final delivery attempt
 * and otherwise stays silent. The reporter never throws into Jest: hook errors become
 * `reporterError` events.
 *
 * This file is authored in CommonJS style (`import x = require()` + `module.exports = Class`) on
 * purpose: Jest applies `interopRequireDefault`, which expects the class as `module.exports`.
 */
import fs = require('fs');
import nodeModule = require('module');
import cli = require('../core/cliEvents');
import coverageDiff = require('./coverageDiff');

const FD = 3;
/** Events are dropped (oldest first) once the undeliverable backlog exceeds this many bytes. */
const MAX_PENDING_BYTES = 16 * 1024 * 1024;

type WriteOutcome = 'ok' | 'again' | 'dead';

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* no SharedArrayBuffer: skip the pause */
  }
}

/**
 * Synchronous fd-3 writer with partial-write handling, EAGAIN backoff and a bounded backlog.
 * Exposed as `HyperJestReporter.Fd3Writer` for tests.
 */
class Fd3Writer {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  /** Set after a non-retryable error (EBADF, EPIPE, ENXIO, ...); cleared once by finalFlush(). */
  disabled = false;
  dropped = 0;

  constructor(private readonly fd: number = FD, private readonly writeSync: typeof fs.writeSync = fs.writeSync) {}

  get backlog(): number { return this.pending.length; }

  write(line: string): void {
    const buf = Buffer.from(line, 'utf8');
    if (this.disabled || this.pending.length) {
      this.enqueue(buf);
      if (!this.disabled) this.drain(1, 0);
      return;
    }
    this.tryWrite(buf);
  }

  /** Last chance delivery (called from onRunComplete); returns true when nothing is left behind. */
  finalFlush(): boolean {
    if (!this.pending.length) return true;
    this.disabled = false;
    return this.drain(50, 20);
  }

  private enqueue(buf: Buffer, front = false): void {
    if (front) this.pending.unshift(buf);
    else this.pending.push(buf);
    this.pendingBytes += buf.length;
    while (this.pendingBytes > MAX_PENDING_BYTES && this.pending.length > 1) {
      const dropped = this.pending.shift()!;
      this.pendingBytes -= dropped.length;
      this.dropped++;
    }
  }

  private tryWrite(buf: Buffer): WriteOutcome {
    let offset = 0;
    while (offset < buf.length) {
      try {
        offset += this.writeSync(this.fd, buf, offset, buf.length - offset);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        const rest = buf.subarray(offset);
        if (code === 'EAGAIN' || code === 'EWOULDBLOCK') {
          this.enqueue(rest, true);
          return 'again';
        }
        this.disabled = true;
        this.enqueue(rest, true);
        return 'dead';
      }
    }
    return 'ok';
  }

  private drain(maxRetries: number, sleepMs: number): boolean {
    let retries = 0;
    while (this.pending.length) {
      const head = this.pending.shift()!;
      this.pendingBytes -= head.length;
      const outcome = this.tryWrite(head);
      if (outcome === 'ok') continue;
      if (outcome === 'dead') return false;
      if (++retries > maxRetries) return false;
      if (sleepMs > 0) sleepSync(sleepMs);
    }
    return true;
  }
}

/** Jest packages from `jest` (or `jest-cli`) to @jest/transform, whose dependency is @jridgewell/trace-mapping. */
const TRACE_MAPPING_CHAIN = ['jest-cli', '@jest/core', 'jest-runtime', '@jest/transform'];

/**
 * Loads the @jridgewell/trace-mapping that the running Jest uses, following the dependency chain
 * from Jest's entry file (never from the extension or the repo root). Undefined when unavailable.
 */
function resolveTraceMapping(entryFile: string | undefined): coverageDiff.TraceMappingLike | undefined {
  if (!entryFile) return undefined;
  try {
    const reqs = [nodeModule.createRequire(entryFile)];
    for (const name of TRACE_MAPPING_CHAIN) {
      try { reqs.unshift(nodeModule.createRequire(reqs[0].resolve(`${name}/package.json`))); } catch { /* hop absent: keep the previous base */ }
    }
    for (const req of reqs) {
      try {
        const tm = req('@jridgewell/trace-mapping') as coverageDiff.TraceMappingLike;
        if (tm && typeof tm.TraceMap === 'function' && typeof tm.originalPositionFor === 'function') return tm;
      } catch { /* try the next base */ }
    }
  } catch { /* unusable entry file */ }
  return undefined;
}

interface FileState {
  dup: cli.DupIndexer;
  emitted: Set<string>;
}

interface JestTestLike { path: string }
interface AggregatedResultLike {
  numTotalTestSuites: number; numFailedTestSuites: number; numRuntimeErrorTestSuites: number;
  numTotalTests: number; numPassedTests: number; numFailedTests: number; numPendingTests: number; numTodoTests: number;
  startTime: number; success: boolean; wasInterrupted: boolean;
  snapshot: Partial<cli.CliRunCompleteEvent['snapshot']>;
  runExecError?: { message?: unknown; stack?: unknown };
}
interface TestCaseStartInfoLike { ancestorTitles: string[]; fullName: string; title: string; startedAt?: number | null }

/** Distributive "event without v" (a plain Omit over the union would collapse to common keys). */
type EventBody<T = cli.CliEvent> = T extends { v: number } ? Omit<T, 'v'> : never;

class HyperJestReporter {
  static Fd3Writer = Fd3Writer;
  static version = cli.CLI_EVENTS_VERSION;
  static resolveTraceMapping = resolveTraceMapping;

  private readonly writer: Fd3Writer;
  private readonly files = new Map<string, FileState>();
  private startTime = Date.now();
  /** Lazily loaded trace-mapping (null once known to be unavailable); tests may preset it. */
  traceMapping: coverageDiff.TraceMappingLike | null | undefined;
  /** Remapped line arrays per (source path, hash): a source loaded by many test files is mapped once. */
  private readonly remapCache = new Map<string, coverageDiff.CoverageMetaBody | null>();

  // Jest passes (globalConfig, reporterOptions, reporterContext); none of them is needed.
  constructor(_globalConfig?: unknown, _options?: unknown, _context?: unknown) {
    this.writer = new Fd3Writer();
  }

  /** Serialises and writes one event (test seam: spy on `prototype.write`). */
  write(event: cli.CliEvent): void {
    this.writer.write(`${JSON.stringify(event)}\n`);
  }

  private emit(event: EventBody): void {
    this.write({ ...event, v: cli.CLI_EVENTS_VERSION } as cli.CliEvent);
  }

  private guard(hook: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      try {
        this.emit({ type: 'reporterError', hook, message: err instanceof Error ? (err.stack ?? err.message) : String(err) });
      } catch {
        /* never throw into Jest */
      }
    }
  }

  private stateFor(path: string): FileState {
    let st = this.files.get(path);
    if (!st) {
      st = { dup: cli.createDupIndexer(), emitted: new Set() };
      this.files.set(path, st);
    }
    return st;
  }

  onRunStart(aggregated?: Partial<AggregatedResultLike>): void {
    this.guard('onRunStart', () => {
      this.startTime = aggregated?.startTime ?? Date.now();
      this.emit({ type: 'runStart', numTotalTestSuites: aggregated?.numTotalTestSuites ?? 0, startTime: this.startTime, pid: process.pid });
    });
  }

  onTestFileStart(test: JestTestLike): void {
    this.guard('onTestFileStart', () => {
      this.files.set(test.path, { dup: cli.createDupIndexer(), emitted: new Set() });
      this.emit({ type: 'fileStart', path: test.path });
    });
  }

  onTestCaseStart(test: JestTestLike, info: TestCaseStartInfoLike): void {
    this.guard('onTestCaseStart', () => {
      this.emit({
        type: 'testStart', path: test.path, fullName: info.fullName, ancestorTitles: info.ancestorTitles ?? [], title: info.title,
        startedAt: typeof info.startedAt === 'number' ? info.startedAt : null,
      });
    });
  }

  onTestCaseResult(test: JestTestLike, result: cli.AssertionResultLike): void {
    this.guard('onTestCaseResult', () => {
      const st = this.stateFor(test.path);
      const dupIndex = st.dup.next(result.fullName, result.invocations);
      const event = cli.assertionToTestResultEvent(test.path, result, dupIndex);
      st.emitted.add(event.testKey);
      this.write(event);
    });
  }

  onTestFileResult(test: JestTestLike, result: cli.TestResultLike): void {
    this.guard('onTestFileResult', () => {
      const path = result.testFilePath || test.path;
      const st = this.stateFor(path);
      // Runners without per-case events (jest-jasmine2) or missed events: emit from the final list.
      const dup = cli.createDupIndexer();
      for (const r of result.testResults ?? []) {
        const dupIndex = dup.next(r.fullName, 1);
        const event = cli.assertionToTestResultEvent(path, r, dupIndex);
        if (st.emitted.has(event.testKey)) continue;
        st.emitted.add(event.testKey);
        this.write(event);
      }
      // Coverage before the file result (protocol order `fileCoverage -> fileResult`). The raw
      // source maps are consumed here and never sent: they would multiply the event size.
      const coverage = cli.coverageMapToEvent(path, result.coverage ?? undefined, { includeInputSourceMap: false });
      if (coverage) {
        this.remapCoverage(coverage, result.coverage!);
        this.write(coverage);
      }
      this.write(cli.testResultToFileResultEvent(result));
      this.files.delete(path);
    });
  }

  /** Remaps generated-code lines (ts-jest instruments compiled JS) to the original source in place. */
  private remapCoverage(event: cli.CliFileCoverageEvent, raw: Record<string, cli.IstanbulFileCoverageLike>): void {
    if (!event.files.some(f => f.hasInputSourceMap)) return;
    if (this.traceMapping === undefined) this.traceMapping = resolveTraceMapping(require.main?.filename ?? process.argv[1]) ?? null;
    const tm = this.traceMapping;
    if (!tm) return;
    const byPath = new Map<string, cli.IstanbulFileCoverageLike>();
    for (const [key, fc] of Object.entries(raw)) if (fc && typeof fc === 'object') byPath.set(fc.path || key, fc);
    for (const f of event.files) {
      if (!f.hasInputSourceMap) continue;
      const cacheKey = `${f.path}\0${f.hash}`;
      let meta = this.remapCache.get(cacheKey);
      if (meta === undefined) {
        const fc = byPath.get(f.path);
        const built = fc ? coverageDiff.buildCoverageMeta({ ...fc, path: f.path } as unknown as coverageDiff.IstanbulFileCoverage, tm) : undefined;
        meta = built && built.remapped ? built : null;
        this.remapCache.set(cacheKey, meta);
      }
      if (!meta) continue;
      f.stmtStartLine = meta.stmtStartLine;
      f.stmtEndLine = meta.stmtEndLine;
      f.fnDeclLine = meta.fnDeclLine;
      f.branchArms = meta.branchArms;
      f.remapped = true;
    }
  }

  onRunComplete(_contexts: unknown, results?: Partial<AggregatedResultLike>): void {
    this.guard('onRunComplete', () => {
      const mem = process.memoryUsage();
      const snap = results?.snapshot ?? {};
      // Jest computes `results.success` after custom reporters ran, so it is still false here
      // (verified on an all-green run); derive it from the counters instead.
      const derivedSuccess =
        (results?.numFailedTests ?? 0) === 0 &&
        (results?.numFailedTestSuites ?? 0) === 0 &&
        (results?.numRuntimeErrorTestSuites ?? 0) === 0 &&
        !results?.runExecError &&
        !results?.wasInterrupted &&
        !snap.failure;
      const event: cli.CliRunCompleteEvent = {
        v: cli.CLI_EVENTS_VERSION,
        type: 'runComplete',
        wasInterrupted: Boolean(results?.wasInterrupted),
        success: Boolean(results?.success) || derivedSuccess,
        numTotalTestSuites: results?.numTotalTestSuites ?? 0,
        numFailedTestSuites: results?.numFailedTestSuites ?? 0,
        numRuntimeErrorTestSuites: results?.numRuntimeErrorTestSuites ?? 0,
        numTotalTests: results?.numTotalTests ?? 0,
        numPassedTests: results?.numPassedTests ?? 0,
        numFailedTests: results?.numFailedTests ?? 0,
        numPendingTests: results?.numPendingTests ?? 0,
        numTodoTests: results?.numTodoTests ?? 0,
        snapshot: {
          added: snap.added ?? 0, matched: snap.matched ?? 0, unmatched: snap.unmatched ?? 0, updated: snap.updated ?? 0, unchecked: snap.unchecked ?? 0,
          filesAdded: snap.filesAdded ?? 0, filesRemoved: snap.filesRemoved ?? 0, filesUnmatched: snap.filesUnmatched ?? 0, filesUpdated: snap.filesUpdated ?? 0,
          failure: Boolean(snap.failure), didUpdate: Boolean(snap.didUpdate),
        },
        startTime: results?.startTime ?? this.startTime,
        durationMs: Math.max(0, Date.now() - (results?.startTime ?? this.startTime)),
        memory: { rss: mem.rss, heapUsed: mem.heapUsed },
      };
      if (results?.runExecError) event.runExecError = cli.failureInfoFromError(results.runExecError);
      this.write(event);
    });
    this.writer.finalFlush();
  }

  /** A non-empty error would make Jest exit with code 1; we never fail the run ourselves. */
  getLastError(): Error | undefined {
    return undefined;
  }
}

module.exports = HyperJestReporter;
