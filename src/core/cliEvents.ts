/**
 * NDJSON event stream written by `dist/worker/reporter.cjs` (a dependency-free Jest reporter
 * loaded via `--reporters=<path>`) and `dist/worker/overlayPreload.cjs` (`node --require`) to fd 3
 * of the Jest process spawned by the CLI engine.
 *
 * This module is the contract between those bundles and the host/worker code that consumes the
 * stream (`cliEngine`): event types, a tolerant line parser and `toWorkerToHost()` which converts
 * events into protocol.ts messages so the CLI engine feeds the same result store as the warm engine.
 *
 * It also holds the pure "Jest result -> event" shaping helpers (stack frame parsing, failure
 * extraction, duplicate-name indexing, istanbul coverage flattening) so they are unit-testable and
 * reusable by the warm engine (stacks.ts may call the same functions).
 *
 * Pure; no 'vscode'; no Jest imports (Jest shapes are described structurally).
 */
import { createHash } from 'crypto';
import { stripAnsi } from './ansi';
import {
  PROTOCOL_VERSION,
  makeTestKey,
  type ConsoleMsg,
  type CoverageMetaMsg,
  type FailureInfo,
  type FileCoverageMsg,
  type FileResultMsg,
  type FileStartMsg,
  type Frame,
  type LogMsg,
  type OverlayWriteBlockedMsg,
  type RunCompleteMsg,
  type SnapshotSummary,
  type TestResultMsg,
  type TestStartMsg,
  type TestStatus,
  type WorkerToHost,
} from './protocol';

/** Bumped when an event shape changes incompatibly; the consumer logs and ignores unknown versions. */
export const CLI_EVENTS_VERSION = 1;

// ---------------------------------------------------------------------------------------------
// Event types (one JSON object per line)
// ---------------------------------------------------------------------------------------------

export type CliConsoleLevel = ConsoleMsg['level'];

export interface CliConsoleEntry {
  level: CliConsoleLevel;
  /** ANSI-stripped message. */
  text: string;
  /** Top user-code frame of the console call (source-mapped by Jest), when parseable. */
  file?: string;
  line?: number;
  column?: number;
}

export interface CliRunStartEvent {
  v: number;
  type: 'runStart';
  numTotalTestSuites: number;
  startTime: number;
  pid: number;
  jestVersion?: string;
}

export interface CliFileStartEvent {
  v: number;
  type: 'fileStart';
  path: string;
}

/** Emitted from `onTestCaseStart` (observed on jest-circus 29.7 and 30.5.2; never for tests skipped by `-t`). */
export interface CliTestStartEvent {
  v: number;
  type: 'testStart';
  path: string;
  fullName: string;
  ancestorTitles: string[];
  title: string;
  startedAt: number | null;
}

export interface CliTestResultEvent {
  v: number;
  type: 'testResult';
  path: string;
  fullName: string;
  ancestorTitles: string[];
  title: string;
  /** `path\0fullName\0dupIndex` (see protocol.ts). */
  testKey: string;
  /** 0-based index among tests in the file sharing the same fullName (retries do not increment it). */
  dupIndex: number;
  status: TestStatus;
  duration: number | null;
  /** 1-based test() call-site location (only with --testLocationInResults). */
  location: { line: number; column: number } | null;
  failures: FailureInfo[];
  invocations: number;
  retryReasons?: string[];
}

export interface CliFileResultEvent {
  v: number;
  type: 'fileResult';
  path: string;
  status: 'passed' | 'failed' | 'errored' | 'skipped';
  testExecError?: FailureInfo;
  snapshot: SnapshotSummary;
  numPassing: number;
  numFailing: number;
  numPending: number;
  numTodo: number;
  perfStats: { start: number; end: number; runtime: number; slow: boolean };
  /** Jest's BufferedConsole entries (only available inside onTestFileResult). */
  console?: CliConsoleEntry[];
  /** Jest's formatted per-file failure text (code frames included), ANSI-stripped and capped. */
  failureMessage?: string;
  displayName?: string;
}

/** Flattened raw istanbul data for one instrumented source file (coordinates of the instrumented code). */
export interface CliCoverageFile {
  path: string;
  /** istanbul's content hash (`coverageData.hash`), or sha1(path + statementMap) when absent. */
  hash: string;
  /** 1-based start/end line per statement id (dense arrays indexed by statement id). */
  stmtStartLine: number[];
  stmtEndLine: number[];
  /** 1-based declaration line per function id. */
  fnDeclLine: number[];
  /** [branchId, armIndex, 1-based line] triples, flattened. */
  branchArms: number[];
  /** Statement ids with a counter > 0. */
  hitStmts: number[];
  /** [branchId, armIndex] pairs, flattened, for arms with a counter > 0. */
  hitBranchArms: number[];
  /**
   * True when the transformer (e.g. ts-jest) provided a source map, meaning the coordinates above
   * are in generated-code space and must be remapped (`inputSourceMap` carries the raw map).
   */
  hasInputSourceMap: boolean;
  inputSourceMap?: unknown;
  /**
   * True when the reporter already remapped the line arrays above to the original source through
   * `inputSourceMap` (with the project's @jridgewell/trace-mapping, inside the Jest process).
   */
  remapped?: boolean;
}

export interface CliFileCoverageEvent {
  v: number;
  type: 'fileCoverage';
  /** The test file whose run produced this coverage. */
  path: string;
  files: CliCoverageFile[];
}

export interface CliRunCompleteEvent {
  v: number;
  type: 'runComplete';
  wasInterrupted: boolean;
  success: boolean;
  numTotalTestSuites: number;
  numFailedTestSuites: number;
  numRuntimeErrorTestSuites: number;
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  numTodoTests: number;
  snapshot: {
    added: number; matched: number; unmatched: number; updated: number; unchecked: number;
    filesAdded: number; filesRemoved: number; filesUnmatched: number; filesUpdated: number;
    failure: boolean; didUpdate: boolean;
  };
  startTime: number;
  durationMs: number;
  memory: { rss: number; heapUsed: number };
  runExecError?: FailureInfo;
}

/** The preload applied an overlay manifest (unsaved editor buffers served to Jest). */
export interface CliOverlayAppliedEvent {
  v: number;
  type: 'overlayApplied';
  manifest: string;
  version: number;
  files: number;
}

export interface CliOverlayWriteBlockedEvent {
  v: number;
  type: 'overlayWriteBlocked';
  path: string;
}

/** The preload could not read/parse the manifest; Jest ran against the files on disk. */
export interface CliOverlayErrorEvent {
  v: number;
  type: 'overlayError';
  message: string;
}

/** A reporter hook threw; the run continues (the reporter never throws into Jest). */
export interface CliReporterErrorEvent {
  v: number;
  type: 'reporterError';
  hook: string;
  message: string;
}

export type CliEvent =
  | CliRunStartEvent
  | CliFileStartEvent
  | CliTestStartEvent
  | CliTestResultEvent
  | CliFileResultEvent
  | CliFileCoverageEvent
  | CliRunCompleteEvent
  | CliOverlayAppliedEvent
  | CliOverlayWriteBlockedEvent
  | CliOverlayErrorEvent
  | CliReporterErrorEvent;

export const CLI_EVENT_TYPES: ReadonlySet<string> = new Set<CliEvent['type']>([
  'runStart', 'fileStart', 'testStart', 'testResult', 'fileResult', 'fileCoverage', 'runComplete',
  'overlayApplied', 'overlayWriteBlocked', 'overlayError', 'reporterError',
]);

// ---------------------------------------------------------------------------------------------
// NDJSON parsing
// ---------------------------------------------------------------------------------------------

/**
 * Parses one NDJSON line. Returns undefined for blank lines, invalid JSON, non-objects and
 * unknown event types (the stream may contain stray output if something else writes to fd 3).
 */
export function parseCliEventLine(line: string): CliEvent | undefined {
  let text = line;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.trim();
  if (!text || text[0] !== '{') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== 'string' || !CLI_EVENT_TYPES.has(type)) return undefined;
  return value as CliEvent;
}

export interface NdjsonSplitter {
  /** Feed a chunk (string or Buffer). Complete lines are delivered to the callback immediately. */
  push(chunk: string | Uint8Array): void;
  /** Flush a trailing line without a newline (call when the stream ends). */
  end(): void;
  /** Lines that were not valid events (for diagnostics). */
  readonly rejected: number;
}

/**
 * Incremental line splitter for an fd-3 pipe: handles chunks that split a line and multi-byte
 * characters split across chunks (decoding is done per complete line on the byte buffer).
 */
export function createNdjsonSplitter(onEvent: (event: CliEvent, line: string) => void, onReject?: (line: string) => void): NdjsonSplitter {
  // Bytes of the incomplete trailing line, kept as separate chunks: each push scans only the new
  // chunk and a long line (multi-MB coverage) is concatenated once, when its newline arrives.
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let rejected = 0;
  const deliver = (line: string) => {
    if (!line.trim()) return;
    const event = parseCliEventLine(line);
    if (event) onEvent(event, line);
    else {
      rejected++;
      onReject?.(line);
    }
  };
  const takeLine = (tail: Buffer): string => {
    const bytes = pending.length ? Buffer.concat([...pending, tail], pendingBytes + tail.length) : tail;
    pending = [];
    pendingBytes = 0;
    return bytes.toString('utf8');
  };
  return {
    get rejected() { return rejected; },
    push(chunk) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      let start = 0;
      for (;;) {
        const nl = buf.indexOf(0x0a, start);
        if (nl < 0) break;
        deliver(takeLine(buf.subarray(start, nl)));
        start = nl + 1;
      }
      if (start < buf.length) {
        // Copy the remainder: it must never alias the caller's chunk (stream buffers may be pooled).
        const rest = Buffer.from(buf.subarray(start));
        pending.push(rest);
        pendingBytes += rest.length;
      }
    },
    end() {
      if (pendingBytes) deliver(takeLine(Buffer.alloc(0)));
    },
  };
}

/** Convenience for tests and files: parse a whole NDJSON text into events (invalid lines skipped). */
export function parseCliEvents(text: string): CliEvent[] {
  const events: CliEvent[] = [];
  const splitter = createNdjsonSplitter(e => events.push(e));
  splitter.push(text);
  splitter.end();
  return events;
}

// ---------------------------------------------------------------------------------------------
// Result shaping helpers (Jest objects described structurally so core never imports Jest)
// ---------------------------------------------------------------------------------------------

const FRAME_RE = /^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;
/** Frames from Jest/expect/babel internals that jest-message-util also hides. */
const INTERNAL_FRAME_RE = /[\\/]node_modules[\\/](?:jest-|@jest[\\/]|expect[\\/]|expect-utils[\\/]|pretty-format[\\/]|@babel[\\/]|source-map-support[\\/]|regenerator-runtime[\\/]|graceful-fs[\\/]|jest(?:-[a-z-]+)?$)/;

function fileFromFrameLocation(raw: string): string | undefined {
  let file = raw.trim();
  if (file.startsWith('file://')) {
    file = file.slice('file://'.length);
    try { file = decodeURIComponent(file); } catch { /* keep as is */ }
  }
  if (!file || file.startsWith('node:') || file.startsWith('internal/') || file === '<anonymous>' || file.startsWith('eval at') || file === 'native') {
    return undefined;
  }
  if (file.startsWith('(')) return undefined;
  return file;
}

/**
 * Parses V8-style `    at fn (file:line:col)` / `    at file:line:col` lines into frames.
 * Node internals, `<anonymous>`, eval frames and Jest/Babel internals are dropped; the stack text
 * itself is kept verbatim on FailureInfo so nothing is lost.
 */
export function parseStackFrames(stack: string | undefined | null, opts: { keepInternals?: boolean } = {}): Frame[] {
  if (!stack) return [];
  const frames: Frame[] = [];
  for (const line of stack.split('\n')) {
    const m = FRAME_RE.exec(line);
    if (!m) continue;
    const file = fileFromFrameLocation(m[2]);
    if (!file) continue;
    if (!opts.keepInternals && INTERNAL_FRAME_RE.test(file)) continue;
    const frame: Frame = { file, line: Number(m[3]), column: Number(m[4]) };
    const fn = m[1]?.trim();
    if (fn) frame.functionName = fn;
    frames.push(frame);
  }
  return frames;
}

/**
 * Splits an `error.stack`-like text into the message part and the frame part. Mirrors
 * jest-message-util's `separateMessageFromStack`: the message is everything before the first
 * `    at ...:line:col` line, with a leading `Error: ` removed (other error names are kept).
 */
export function splitMessageAndStack(text: string): { message: string; stack: string } {
  const lines = text.split('\n');
  let idx = lines.findIndex(l => /^\s+at\s.*:\d+:\d+\)?\s*$/.test(l));
  if (idx < 0) idx = lines.length;
  let message = lines.slice(0, idx).join('\n').replace(/\s+$/, '');
  message = message.replace(/^Error: /, '');
  const stack = lines.slice(idx).join('\n').replace(/\s+$/, '');
  return { message, stack };
}

/** Caps a text for transport; the full value never matters beyond this size in the UI. */
export function capText(text: string, max = 64 * 1024): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

/** Best-effort formatting of expected/actual values coming from `matcherResult` (may be any JS value). */
export function formatMatcherValue(value: unknown, max = 16 * 1024): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return capText(value, max);
  try {
    const json = JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : typeof v === 'function' ? `[Function ${v.name || 'anonymous'}]` : v === undefined ? '[undefined]' : v), 2);
    return capText(json ?? String(value), max);
  } catch {
    return capText(String(value), max);
  }
}

/** Shape of `failureDetails[i]` for expect errors (enumerable props survive worker serialization). */
interface MatcherResultLike {
  matcherResult?: { name?: unknown; expected?: unknown; actual?: unknown; pass?: unknown };
}

/**
 * Builds a FailureInfo from one `failureMessages[i]` entry (raw `error.stack`, possibly with ANSI)
 * and the matching `failureDetails[i]` (for matcherName/expected/actual).
 */
export function failureInfoFromMessage(rawMessage: string, detail?: unknown): FailureInfo {
  const text = stripAnsi(String(rawMessage ?? ''));
  const { message, stack } = splitMessageAndStack(text);
  const info: FailureInfo = { message: capText(message), frames: parseStackFrames(stack) };
  if (stack) info.stack = capText(stack);
  const mr = (detail as MatcherResultLike | undefined)?.matcherResult;
  if (mr && typeof mr === 'object') {
    if (typeof mr.name === 'string') info.matcherName = mr.name;
    const expected = formatMatcherValue(mr.expected);
    const actual = formatMatcherValue(mr.actual);
    if (expected !== undefined) info.expected = expected;
    if (actual !== undefined) info.actual = actual;
  }
  return info;
}

/** FailureInfo from a SerializableError (`testExecError`, `runExecError`). */
export function failureInfoFromError(err: { message?: unknown; stack?: unknown } | undefined | null, fallbackMessage?: string): FailureInfo {
  const rawStack = typeof err?.stack === 'string' ? stripAnsi(err.stack) : '';
  const rawMessage = typeof err?.message === 'string' ? stripAnsi(err.message) : '';
  const split = splitMessageAndStack(rawStack || rawMessage);
  const message = (rawMessage || split.message || fallbackMessage || 'Unknown error').replace(/^Error: /, '');
  const info: FailureInfo = { message: capText(message), frames: parseStackFrames(split.stack) };
  if (split.stack) info.stack = capText(split.stack);
  return info;
}

/** Jest's `AssertionResult` / `TestCaseResult`, structurally. */
export interface AssertionResultLike {
  ancestorTitles: string[];
  title: string;
  fullName: string;
  status: string;
  duration?: number | null;
  failureMessages: string[];
  failureDetails?: unknown[];
  invocations?: number;
  location?: { line: number; column: number } | null;
  retryReasons?: string[];
}

/** Maps Jest's assertion status strings onto the protocol's TestStatus (unknown values pass through). */
export function toTestStatus(status: string): TestStatus {
  switch (status) {
    case 'passed': case 'failed': case 'skipped': case 'pending': case 'todo': case 'disabled': case 'focused':
      return status;
    default:
      return 'errored';
  }
}

/**
 * Assigns `dupIndex` per (file, fullName): the k-th test with the same full name gets k. Retries
 * (`jest.retryTimes`) re-dispatch `test-case-result` for the same test with `invocations > 1`, so
 * they keep the index of the previous attempt instead of being counted as a duplicate.
 */
export interface DupIndexer {
  next(fullName: string, invocations: number | undefined): number;
  reset(): void;
}

export function createDupIndexer(): DupIndexer {
  let counts = new Map<string, number>();
  return {
    next(fullName, invocations) {
      const seen = counts.get(fullName) ?? 0;
      if ((invocations ?? 1) > 1 && seen > 0) return seen - 1;
      counts.set(fullName, seen + 1);
      return seen;
    },
    reset() { counts = new Map(); },
  };
}

/** Converts one assertion result into a testResult event (dupIndex supplied by the caller). */
export function assertionToTestResultEvent(path: string, r: AssertionResultLike, dupIndex: number): CliTestResultEvent {
  const failures = (r.failureMessages ?? []).map((m, i) => failureInfoFromMessage(m, r.failureDetails?.[i]));
  const ev: CliTestResultEvent = {
    v: CLI_EVENTS_VERSION,
    type: 'testResult',
    path,
    fullName: r.fullName,
    ancestorTitles: r.ancestorTitles ?? [],
    title: r.title,
    testKey: makeTestKey(path, r.fullName, dupIndex),
    dupIndex,
    status: toTestStatus(r.status),
    duration: typeof r.duration === 'number' ? r.duration : null,
    location: r.location && typeof r.location.line === 'number' ? { line: r.location.line, column: r.location.column } : null,
    failures,
    invocations: typeof r.invocations === 'number' ? r.invocations : 1,
  };
  if (r.retryReasons && r.retryReasons.length) ev.retryReasons = r.retryReasons.map(x => stripAnsi(String(x)));
  return ev;
}

/** Jest's `LogEntry` (`TestResult.console[i]`). */
export interface LogEntryLike { message: string; origin: string; type: string }

const CONSOLE_LEVELS: Record<string, CliConsoleLevel> = {
  log: 'log', info: 'info', warn: 'warn', error: 'error', debug: 'debug', dir: 'dir', dirxml: 'dir',
  assert: 'error', trace: 'error', table: 'log', count: 'log', countReset: 'log', time: 'log', timeEnd: 'log', timeLog: 'log',
  group: 'log', groupCollapsed: 'log', groupEnd: 'log',
};

/** Converts BufferedConsole entries; the origin stack's top user frame gives file/line/column. */
export function consoleEntriesFromBuffer(buffer: LogEntryLike[] | undefined | null): CliConsoleEntry[] {
  if (!buffer || !Array.isArray(buffer)) return [];
  return buffer.map(entry => {
    const out: CliConsoleEntry = { level: CONSOLE_LEVELS[entry.type] ?? 'log', text: capText(stripAnsi(String(entry.message ?? ''))) };
    const top = parseStackFrames(entry.origin)[0];
    if (top) {
      out.file = top.file;
      out.line = top.line;
      out.column = top.column;
    }
    return out;
  });
}

/** Raw istanbul `FileCoverageData`, structurally. */
export interface IstanbulFileCoverageLike {
  path: string;
  hash?: string;
  statementMap: Record<string, { start: { line: number; column: number }; end: { line: number; column: number } }>;
  fnMap: Record<string, { decl: { start: { line: number; column: number } }; loc?: unknown; name?: string }>;
  branchMap: Record<string, { locations: Array<{ start: { line: number; column: number } }>; loc?: unknown; type?: string }>;
  s: Record<string, number>;
  f: Record<string, number>;
  b: Record<string, number[]>;
  inputSourceMap?: unknown;
}

export function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/** Flattens one istanbul file record into the transport shape used by fileCoverage events. */
export function flattenIstanbulFile(fc: IstanbulFileCoverageLike, opts: { includeInputSourceMap?: boolean } = {}): CliCoverageFile {
  const stmtIds = Object.keys(fc.statementMap ?? {}).map(Number).filter(n => Number.isInteger(n) && n >= 0);
  const size = stmtIds.length ? Math.max(...stmtIds) + 1 : 0;
  const stmtStartLine = new Array<number>(size).fill(0);
  const stmtEndLine = new Array<number>(size).fill(0);
  for (const id of stmtIds) {
    const loc = fc.statementMap[String(id)];
    stmtStartLine[id] = loc?.start?.line ?? 0;
    stmtEndLine[id] = loc?.end?.line ?? loc?.start?.line ?? 0;
  }
  const hitStmts: number[] = [];
  for (const [id, count] of Object.entries(fc.s ?? {})) {
    if (typeof count === 'number' && count > 0) hitStmts.push(Number(id));
  }
  hitStmts.sort((a, b) => a - b);

  const fnIds = Object.keys(fc.fnMap ?? {}).map(Number).filter(n => Number.isInteger(n) && n >= 0);
  const fnDeclLine = new Array<number>(fnIds.length ? Math.max(...fnIds) + 1 : 0).fill(0);
  for (const id of fnIds) fnDeclLine[id] = fc.fnMap[String(id)]?.decl?.start?.line ?? 0;

  const branchArms: number[] = [];
  const hitBranchArms: number[] = [];
  for (const [idStr, branch] of Object.entries(fc.branchMap ?? {})) {
    const id = Number(idStr);
    const counts = fc.b?.[idStr] ?? [];
    (branch?.locations ?? []).forEach((loc, arm) => {
      branchArms.push(id, arm, loc?.start?.line ?? 0);
      if ((counts[arm] ?? 0) > 0) hitBranchArms.push(id, arm);
    });
  }

  const out: CliCoverageFile = {
    path: fc.path,
    hash: typeof fc.hash === 'string' && fc.hash ? fc.hash : sha1(`${fc.path}\0${JSON.stringify(fc.statementMap ?? {})}`),
    stmtStartLine,
    stmtEndLine,
    fnDeclLine,
    branchArms,
    hitStmts,
    hitBranchArms,
    hasInputSourceMap: fc.inputSourceMap != null,
  };
  if (opts.includeInputSourceMap !== false && fc.inputSourceMap != null) out.inputSourceMap = fc.inputSourceMap;
  return out;
}

/** Converts `TestResult.coverage` (a `{[absPath]: FileCoverageData}` map) into a fileCoverage event. */
export function coverageMapToEvent(testPath: string, coverage: Record<string, IstanbulFileCoverageLike> | undefined | null, opts: { includeInputSourceMap?: boolean } = {}): CliFileCoverageEvent | undefined {
  if (!coverage || typeof coverage !== 'object') return undefined;
  const files: CliCoverageFile[] = [];
  for (const [path, fc] of Object.entries(coverage)) {
    if (!fc || typeof fc !== 'object' || !fc.statementMap) continue;
    files.push(flattenIstanbulFile({ ...fc, path: fc.path || path }, opts));
  }
  if (!files.length) return undefined;
  return { v: CLI_EVENTS_VERSION, type: 'fileCoverage', path: testPath, files };
}

/** Jest's `TestResult`, structurally (fields the reporter reads). */
export interface TestResultLike {
  testFilePath: string;
  testResults: AssertionResultLike[];
  testExecError?: { message?: unknown; stack?: unknown } | null;
  failureMessage?: string | null;
  numFailingTests: number;
  numPassingTests: number;
  numPendingTests: number;
  numTodoTests: number;
  skipped?: boolean;
  snapshot?: Partial<SnapshotSummary> | null;
  perfStats?: { start: number; end: number; runtime: number; slow: boolean } | null;
  console?: LogEntryLike[] | null;
  coverage?: Record<string, IstanbulFileCoverageLike> | null;
  displayName?: { name: string } | string | null;
}

export function fileStatusOf(r: Pick<TestResultLike, 'testExecError' | 'numFailingTests' | 'numPassingTests' | 'numPendingTests' | 'numTodoTests' | 'skipped'>): CliFileResultEvent['status'] {
  if (r.testExecError) return 'errored';
  if (r.numFailingTests > 0) return 'failed';
  if (r.skipped || (r.numPassingTests === 0 && r.numPendingTests + r.numTodoTests > 0)) return 'skipped';
  return 'passed';
}

export function snapshotSummaryOf(s: Partial<SnapshotSummary> | null | undefined): SnapshotSummary {
  return {
    added: s?.added ?? 0,
    matched: s?.matched ?? 0,
    unmatched: s?.unmatched ?? 0,
    updated: s?.updated ?? 0,
    unchecked: s?.unchecked ?? 0,
    uncheckedKeys: Array.isArray(s?.uncheckedKeys) ? s.uncheckedKeys.map(String) : [],
    fileDeleted: Boolean(s?.fileDeleted),
  };
}

/** Converts a Jest TestResult into a fileResult event. */
export function testResultToFileResultEvent(r: TestResultLike): CliFileResultEvent {
  const ev: CliFileResultEvent = {
    v: CLI_EVENTS_VERSION,
    type: 'fileResult',
    path: r.testFilePath,
    status: fileStatusOf(r),
    snapshot: snapshotSummaryOf(r.snapshot),
    numPassing: r.numPassingTests ?? 0,
    numFailing: r.numFailingTests ?? 0,
    numPending: r.numPendingTests ?? 0,
    numTodo: r.numTodoTests ?? 0,
    perfStats: {
      start: r.perfStats?.start ?? 0,
      end: r.perfStats?.end ?? 0,
      runtime: r.perfStats?.runtime ?? 0,
      slow: Boolean(r.perfStats?.slow),
    },
  };
  if (r.testExecError) {
    ev.testExecError = failureInfoFromError(r.testExecError, typeof r.failureMessage === 'string' ? stripAnsi(r.failureMessage) : undefined);
    // The formatted message carries the code frame; it is the better human-readable text.
    if (typeof r.failureMessage === 'string' && r.failureMessage && !ev.testExecError.frames.length) {
      ev.testExecError.frames = parseStackFrames(stripAnsi(r.failureMessage));
    }
  }
  const consoleEntries = consoleEntriesFromBuffer(r.console);
  if (consoleEntries.length) ev.console = consoleEntries;
  if (typeof r.failureMessage === 'string' && r.failureMessage) ev.failureMessage = capText(stripAnsi(r.failureMessage));
  const dn = r.displayName;
  if (dn) ev.displayName = typeof dn === 'string' ? dn : dn.name;
  return ev;
}

// ---------------------------------------------------------------------------------------------
// Conversion to protocol.ts messages (so the CLI engine feeds the same result store)
// ---------------------------------------------------------------------------------------------

/**
 * Converts a CLI event into zero or more WorkerToHost messages for `runId`.
 * - fileCoverage → one `coverageMeta` per source file + one `fileCoverage`. `remapped` mirrors the
 *   event: the reporter remaps ts-jest (inputSourceMap) coordinates inside the Jest process.
 * - runStart → nothing (the engine already knows the run started).
 * - overlayApplied / overlayError / reporterError → `log` messages.
 */
export function toWorkerToHost(event: CliEvent, runId: string): WorkerToHost[] {
  const v = PROTOCOL_VERSION;
  switch (event.type) {
    case 'runStart':
      return [];
    case 'fileStart': {
      const msg: FileStartMsg = { v, type: 'fileStart', runId, path: event.path };
      return [msg];
    }
    case 'testStart': {
      const msg: TestStartMsg = { v, type: 'testStart', runId, path: event.path, fullName: event.fullName, ancestorTitles: event.ancestorTitles, title: event.title };
      return [msg];
    }
    case 'testResult': {
      const msg: TestResultMsg = {
        v, type: 'testResult', runId, path: event.path,
        fullName: event.fullName, ancestorTitles: event.ancestorTitles, title: event.title,
        testKey: event.testKey, status: event.status, duration: event.duration, location: event.location,
        failures: event.failures, invocations: event.invocations,
      };
      if (event.retryReasons) msg.retryReasons = event.retryReasons;
      return [msg];
    }
    case 'fileResult': {
      const msg: FileResultMsg = {
        v, type: 'fileResult', runId, path: event.path, status: event.status,
        numPassing: event.numPassing, numFailing: event.numFailing, numPending: event.numPending, numTodo: event.numTodo,
        snapshot: event.snapshot, perfStats: event.perfStats,
      };
      if (event.testExecError) msg.testExecError = event.testExecError;
      if (event.console) msg.console = event.console.map(c => {
        const entry: NonNullable<FileResultMsg['console']>[number] = { level: c.level, text: c.text };
        if (c.file) { entry.file = c.file; entry.line = c.line; entry.column = c.column; }
        return entry;
      });
      return [msg];
    }
    case 'fileCoverage': {
      const metas: CoverageMetaMsg[] = event.files.map(f => ({
        v, type: 'coverageMeta', path: f.path, hash: f.hash,
        stmtStartLine: f.stmtStartLine, stmtEndLine: f.stmtEndLine, fnDeclLine: f.fnDeclLine, branchArms: f.branchArms,
        remapped: f.remapped === true,
      }));
      const cov: FileCoverageMsg = {
        v, type: 'fileCoverage', runId, path: event.path,
        files: event.files.map(f => ({ path: f.path, hash: f.hash, hitStmts: f.hitStmts, hitBranchArms: f.hitBranchArms })),
      };
      return [...metas, cov];
    }
    case 'runComplete': {
      const msg: RunCompleteMsg = {
        v, type: 'runComplete', runId, wasInterrupted: event.wasInterrupted, durationMs: event.durationMs,
        memory: event.memory ?? { rss: 0, heapUsed: 0 },
      };
      if (event.runExecError) msg.error = event.runExecError.message;
      return [msg];
    }
    case 'overlayWriteBlocked': {
      const msg: OverlayWriteBlockedMsg = { v, type: 'overlayWriteBlocked', path: event.path };
      return [msg];
    }
    case 'overlayApplied': {
      const msg: LogMsg = { v, type: 'log', level: 'debug', text: `overlay applied: ${event.files} file(s), version ${event.version}` };
      return [msg];
    }
    case 'overlayError': {
      const msg: LogMsg = { v, type: 'log', level: 'warn', text: `overlay not applied: ${event.message}` };
      return [msg];
    }
    case 'reporterError': {
      const msg: LogMsg = { v, type: 'log', level: 'warn', text: `reporter ${event.hook} failed: ${event.message}` };
      return [msg];
    }
    default:
      return [];
  }
}
