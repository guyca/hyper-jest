/**
 * Pure projections of the ResultStore for the editor surfaces. No 'vscode'.
 *
 *  - computeLineView(store, path): per-line gutter state, stale flag, snapshot flag, inline entries,
 *    covering tests and declaration statuses (the `LineViewFile` contract in core/resultModel.ts).
 *  - inlineTextFor(view): the single text drawn after a line (error > value > log, joined/truncated).
 *  - matchRecordsToNodes(parsed, records): runtime results <-> parsed tree, a node-keyed view over
 *    core/testIds `reconcile()` (structural + k-th duplicate, `.each`/template rows, location hint,
 *    runtime-only) shared by declarations, code lenses and the Test Explorer.
 *  - wordDiff / compactDiff: expected/actual word diff with context truncation for hovers.
 *  - LineViewCache: memoises views per path until the store reports a change.
 */
import type { FailureInfo, Frame, TestStatus } from '../core/protocol';
import { parseTestKey } from '../core/protocol';
import type { InlineEntry, LineState, LineView, LineViewFile, TestRecord } from '../core/resultModel';
import type { ParsedFile, ParsedNode } from '../core/testModel';
import { findNodeAtLine, findTestAtLine, fullNameOfNode, hasStaticFullName, reconcile, walkTests, type ReconcileIds, type ReconciledTest } from '../core/testIds';
import { isFailingStatus, isInactiveStatus, type ResultStore } from './resultStore';

export interface LineViewOptions {
  /** Max characters of inline text (default 120). */
  maxLength: number;
  /** Max log/value entries joined on one line (default 3). */
  maxLogsPerLine: number;
  showErrors: boolean;
  showLogs: boolean;
  showValues: boolean;
  /**
   * Maps a 0-based line of run data (coverage, error frames, inline entries) onto the current buffer
   * after unsaved edits; `undefined` drops the line. Declarations come from the current parse and
   * are never mapped.
   */
  mapLine?: (line: number) => number | undefined;
}

export const DEFAULT_LINE_VIEW_OPTIONS: LineViewOptions = {
  maxLength: 120, maxLogsPerLine: 3, showErrors: true, showLogs: true, showValues: true,
};

const STATE_RANK: Record<LineState, number> = { errorSource: 0, errorPath: 1, partiallyCovered: 2, covered: 3, notCovered: 4 };

/** Returns the higher-priority state of the two (errorSource > errorPath > partial > covered > notCovered). */
export function strongerState(a: LineState | undefined, b: LineState | undefined): LineState | undefined {
  if (!a) return b;
  if (!b) return a;
  return STATE_RANK[a] <= STATE_RANK[b] ? a : b;
}

// ---------------------------------------------------------------------------------------------
// Line view
// ---------------------------------------------------------------------------------------------

export function computeLineView(store: ResultStore, path: string, options: Partial<LineViewOptions> = {}): LineViewFile {
  const opts: LineViewOptions = { ...DEFAULT_LINE_VIEW_OPTIONS, ...options };
  const lines = new Map<number, LineView>();
  const view: LineViewFile = { path, lines, declarations: new Map() };
  const lineAt = (line: number): LineView => {
    let v = lines.get(line);
    if (!v) lines.set(line, (v = { line, stale: false, snapshot: false, entries: [], tests: [], failingTests: [] }));
    return v;
  };
  const addState = (line: number, state: LineState): void => {
    if (line < 0) return;
    const v = lineAt(line);
    v.state = strongerState(v.state, state);
  };
  /** A line recorded by a run, in current-buffer coordinates (-1 = gone). */
  const runLine = (line: number): number => (opts.mapLine && line >= 0 ? opts.mapLine(line) ?? -1 : line);

  const failing = store.failingTests();
  const failingKeys = new Set(failing.map(t => t.testKey));
  const fileRecord = store.fileRecord(path);
  const parsed = store.parsed(path);
  const testsHere = store.testsInFile(path);
  const matches = parsed ? matchRecordsToNodes(parsed, testsHere) : undefined;

  // 1. Coverage states from instrumentation data.
  const cov = store.coverageFor(path);
  if (cov?.meta) {
    const meta = cov.meta;
    const acc = new Map<number, { hit: number; unhit: number; armHit: number; armUnhit: number; failing: boolean; tests: Set<string> }>();
    const accAt = (line: number) => {
      let a = acc.get(line);
      if (!a) acc.set(line, (a = { hit: 0, unhit: 0, armHit: 0, armUnhit: 0, failing: false, tests: new Set() }));
      return a;
    };
    for (let s = 0; s < meta.stmtStartLine.length; s++) {
      const line = runLine(meta.stmtStartLine[s] - 1);
      if (line < 0) continue;
      const a = accAt(line);
      const byTest = cov.stmtHitBy.get(s);
      const byFile = cov.stmtHitByFile.get(s);
      const hit = (byTest?.size ?? 0) > 0 || (byFile?.size ?? 0) > 0;
      if (hit) a.hit++; else a.unhit++;
      if (byTest) for (const k of byTest) { a.tests.add(k); if (failingKeys.has(k)) a.failing = true; }
    }
    for (let i = 0; i + 2 < meta.branchArms.length; i += 3) {
      const line = runLine(meta.branchArms[i + 2] - 1);
      if (line < 0) continue;
      const a = accAt(line);
      if (cov.branchArmHitByFile.has(`${meta.branchArms[i]}:${meta.branchArms[i + 1]}`)) a.armHit++; else a.armUnhit++;
    }
    for (const [line, a] of acc) {
      const anyHit = a.hit > 0 || a.armHit > 0;
      const state: LineState = a.failing ? 'errorPath'
        : anyHit && (a.unhit > 0 || a.armUnhit > 0) ? 'partiallyCovered'
        : anyHit ? 'covered'
        : 'notCovered';
      addState(line, state);
      const v = lineAt(line);
      v.tests = [...a.tests].sort();
      v.failingTests = v.tests.filter(k => failingKeys.has(k));
    }
  }

  // 2. Error sources (frames of failing tests, anywhere in the store, that point into this file).
  const errorEntries: Array<{ line: number; entry: InlineEntry; key?: string }> = [];
  const noteError = (line: number, failure: FailureInfo, testKey: string | undefined, runId: string): void => {
    if (line < 0) return;
    addState(line, 'errorSource');
    const v = lineAt(line);
    if (testKey && !v.failingTests.includes(testKey)) v.failingTests.push(testKey);
    if (opts.showErrors && !errorEntries.some(e => e.line === line && e.key === testKey && e.entry.longText === failure.message)) {
      errorEntries.push({ line, key: testKey, entry: { kind: 'error', text: firstLine(failure.message), longText: failure.message, testKey, runId } });
    }
  };
  for (const t of failing) {
    for (const f of t.failures) {
      const inFile = f.frames.filter(fr => fr.file === path);
      for (const fr of inFile) addState(runLine(fr.line - 1), 'errorSource');
      if (inFile.length > 0) {
        noteError(runLine(inFile[0].line - 1), f, t.testKey, t.lastRunId);
      } else if (t.path === path && t.location) {
        // No source-mapped frame inside the spec: mark the declaration red.
        noteError(runLine(t.location.line - 1), f, t.testKey, t.lastRunId);
      } else if (t.path === path && !t.location && matches) {
        const m = matches.byKey.get(t.testKey);
        if (m) noteError(m.node.range.startLine, f, t.testKey, t.lastRunId);
      }
      // The throw site (top of the stack) in a source file is an error source too.
      if (f.frames.length > 0 && f.frames[0].file === path && inFile[0] !== f.frames[0]) noteError(runLine(f.frames[0].line - 1), f, t.testKey, t.lastRunId);
    }
    if (t.failures.length === 0 && t.path === path && t.location) addState(runLine(t.location.line - 1), 'errorSource');
  }
  if (fileRecord?.testExecError) {
    const exec = fileRecord.testExecError;
    const inFile = exec.frames.filter(fr => fr.file === path);
    for (const fr of inFile) addState(runLine(fr.line - 1), 'errorSource');
    if (inFile.length > 0) noteError(runLine(inFile[0].line - 1), exec, undefined, fileRecord.lastRunId ?? '');
    else if (fileRecord.path === path) noteError(0, exec, undefined, fileRecord.lastRunId ?? '');
  }

  // 3. Spec-file fallbacks when the test file itself is not instrumented: a failing test's body is
  //    on the error path; snapshot lines inherit the test status.
  if (parsed && matches) {
    const instrumented = !!cov?.meta;
    for (const [node, records] of matches.byNode) {
      if (node.kind !== 'test') continue;
      const failed = records.some(r => isFailingStatus(r.status));
      if (!instrumented && failed) {
        for (let l = node.range.startLine; l <= node.range.endLine; l++) {
          const v = lines.get(l);
          if (!v?.state) addState(l, 'errorPath');
          const lv = lineAt(l);
          for (const r of records) if (isFailingStatus(r.status) && !lv.failingTests.includes(r.testKey)) lv.failingTests.push(r.testKey);
        }
      }
    }
    for (const l of parsed.snapshotLines) {
      const v = lineAt(l);
      v.snapshot = true;
      if (!v.state && !instrumented) {
        const owner = deepestTestAt(parsed, l);
        const records = owner ? matches.byNode.get(owner.node) ?? [] : [];
        if (records.some(r => isFailingStatus(r.status))) v.state = 'errorPath';
        else if (records.some(r => !isInactiveStatus(r.status))) v.state = 'covered';
      }
    }
  }

  // 4. Declarations.
  if (parsed && matches) {
    walkNodes(parsed.nodes, (node) => {
      const records = node.kind === 'test' ? matches.byNode.get(node) ?? [] : collectDescendantRecords(node, matches);
      const line = node.range.startLine;
      const prev = view.declarations.get(line);
      const keys = records.map(r => r.testKey);
      // The innermost declaration on a line wins (a `describe` and its first `it` rarely share one).
      if (!prev || node.kind === 'test') view.declarations.set(line, { status: aggregateStatus(records), testKeys: prev ? dedupe([...prev.testKeys, ...keys]) : keys });
    });
  }

  // 5. Inline entries (logs, values) + derived error entries.
  for (const [recorded, entries] of store.entriesFor(path)) {
    const line = runLine(recorded);
    if (line < 0) continue;
    const v = lineAt(line);
    for (const e of entries) {
      if (e.kind === 'log' && !opts.showLogs) continue;
      if (e.kind === 'value' && !opts.showValues) continue;
      v.entries.push(e);
    }
  }
  for (const e of errorEntries) lineAt(e.line).entries.push(e.entry);
  for (const v of lines.values()) {
    v.entries = v.entries
      .map(e => normaliseEntry(e, opts.maxLength))
      .sort((a, b) => kindRank(a.kind) - kindRank(b.kind));
  }

  // 6. Stale flags.
  const stale = store.staleInfo(path);
  const fileStale = !!fileRecord?.stale;
  if (stale || fileStale || cov?.stale) {
    for (const v of lines.values()) {
      if (fileStale || cov?.stale || stale?.all || stale?.lines.has(v.line)) v.stale = true;
    }
  }

  // Drop empty views (no state, no entries, not a snapshot line) to keep the map small.
  for (const [line, v] of [...lines]) {
    if (!v.state && v.entries.length === 0 && !v.snapshot && v.tests.length === 0) lines.delete(line);
  }
  return view;
}

function kindRank(kind: InlineEntry['kind']): number {
  return kind === 'error' ? 0 : kind === 'value' ? 1 : 2;
}

function normaliseEntry(e: InlineEntry, maxLength: number): InlineEntry {
  const single = firstLine(e.text);
  const truncated = truncate(single, maxLength);
  const needsLong = truncated !== e.text || e.longText !== undefined;
  return { ...e, text: truncated, longText: needsLong ? (e.longText ?? e.text) : undefined };
}

/** First line of a (possibly multi-line) message, trimmed. */
export function firstLine(text: string): string {
  const nl = text.indexOf('\n');
  return (nl === -1 ? text : text.slice(0, nl)).trim();
}

export function truncate(text: string, max: number): string {
  if (max <= 0 || text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

export interface InlineText {
  kind: InlineEntry['kind'];
  text: string;
  /** Full text(s) for the hover. */
  longTexts: string[];
  /** Number of entries folded into `text`. */
  count: number;
}

/**
 * The single after-text for a line: an error beats a value beats a log; several logs/values are
 * joined with ', ' up to `maxLogsPerLine` (the remainder is summarised), and the result is capped at
 * `maxLength`.
 */
export function inlineTextFor(view: LineView, options: Partial<LineViewOptions> = {}): InlineText | undefined {
  const opts: LineViewOptions = { ...DEFAULT_LINE_VIEW_OPTIONS, ...options };
  const pick = (kind: InlineEntry['kind']) => view.entries.filter(e => e.kind === kind);
  const errors = opts.showErrors ? pick('error') : [];
  if (errors.length > 0) {
    const e = errors[0];
    return { kind: 'error', text: truncate(e.text, opts.maxLength), longTexts: errors.map(x => x.longText ?? x.text), count: errors.length };
  }
  const values = opts.showValues ? pick('value') : [];
  const logs = opts.showLogs ? pick('log') : [];
  const chosen = values.length > 0 ? values : logs;
  if (chosen.length === 0) return undefined;
  const max = Math.max(1, opts.maxLogsPerLine);
  const shown = chosen.slice(0, max).map(e => e.text);
  const rest = chosen.length - shown.length;
  const joined = shown.join(', ') + (rest > 0 ? `, … +${rest}` : '');
  return { kind: values.length > 0 ? 'value' : 'log', text: truncate(joined, opts.maxLength), longTexts: chosen.map(x => x.longText ?? x.text), count: chosen.length };
}

// ---------------------------------------------------------------------------------------------
// Parsed tree <-> runtime results
// ---------------------------------------------------------------------------------------------

export interface NodeMatch { node: ParsedNode; ancestry: ParsedNode[]; }

export interface MatchResult {
  byNode: Map<ParsedNode, TestRecord[]>;
  byKey: Map<string, NodeMatch>;
  /** Records that no parsed node explains (helper-registered or dynamic tests). */
  unmatched: TestRecord[];
  /** Test nodes with no record (never registered at runtime, or not run yet). */
  staticWithoutResult: ParsedNode[];
  /** The underlying core/testIds entries (kind, stable nodeId, row labels, runtime-only ancestry). */
  reconciled?: Map<string, ReconciledTest>;
}

/**
 * Node-keyed view over core/testIds `reconcile()`: exact/duplicate/location matches and `.each`
 * rows map to their static node (several rows share one node); runtime-only results are
 * `unmatched`. Records are ordered by declaration line and duplicate index first, as `reconcile`
 * expects Jest's definition order for duplicate ordinals. `ids` only affects the `nodeId`s inside
 * `reconciled` (the Explorer passes its project/relPath; views may leave it out).
 */
export function matchRecordsToNodes(parsed: ParsedFile, records: readonly TestRecord[], ids: ReconcileIds = { projectId: '', relPath: parsed.path }): MatchResult {
  const ordered = orderForReconcile(records);
  const reconciled = reconcile(parsed, ordered, ids);
  const byNode = new Map<ParsedNode, TestRecord[]>();
  const byKey = new Map<string, NodeMatch>();
  const unmatched: TestRecord[] = [];
  for (const r of ordered) {
    const m = reconciled.get(r.testKey);
    if (!m || !m.node) { unmatched.push(r); continue; }
    byKey.set(r.testKey, { node: m.node, ancestry: m.ancestry });
    let list = byNode.get(m.node);
    if (!list) byNode.set(m.node, (list = []));
    list.push(r);
  }
  const staticWithoutResult = walkTests(parsed).filter(e => !byNode.has(e.node)).map(e => e.node);
  return { byNode, byKey, unmatched, staticWithoutResult, reconciled };
}

/** Records sorted by declaration line (unknown last), full name, then duplicate index. */
export function orderForReconcile<T extends { testKey: string; fullName: string; location: { line: number } | null }>(records: readonly T[]): T[] {
  return [...records].sort((a, b) =>
    (a.location?.line ?? 1e9) - (b.location?.line ?? 1e9)
    || a.fullName.localeCompare(b.fullName)
    || parseTestKey(a.testKey).dupIndex - parseTestKey(b.testKey).dupIndex);
}

/** Innermost test node whose range contains the 0-based line (core/testIds `findTestAtLine`). */
export function deepestTestAt(parsed: ParsedFile, line: number): NodeMatch | undefined {
  return findTestAtLine(parsed, line) ?? undefined;
}

/** Innermost node (describe or test) whose range contains the 0-based line (core/testIds `findNodeAtLine`). */
export function deepestNodeAt(parsed: ParsedFile, line: number): NodeMatch | undefined {
  return findNodeAtLine(parsed, line) ?? undefined;
}

export function walkNodes(nodes: readonly ParsedNode[], visit: (node: ParsedNode, ancestry: ParsedNode[]) => void, ancestry: ParsedNode[] = []): void {
  for (const n of nodes) {
    visit(n, ancestry);
    if (n.children.length) walkNodes(n.children, visit, [...ancestry, n]);
  }
}

function collectDescendantRecords(node: ParsedNode, matches: MatchResult): TestRecord[] {
  const out: TestRecord[] = [];
  walkNodes(node.children, child => { if (child.kind === 'test') out.push(...(matches.byNode.get(child) ?? [])); });
  return out;
}

/** Aggregated status of a set of results: failed > passed > skipped > unknown. */
export function aggregateStatus(records: readonly TestRecord[]): TestStatus | 'unknown' {
  if (records.length === 0) return 'unknown';
  if (records.some(r => isFailingStatus(r.status))) return 'failed';
  if (records.some(r => r.status === 'passed' || r.status === 'focused')) return 'passed';
  if (records.every(r => r.status === 'todo')) return 'todo';
  return 'skipped';
}

/** Static full name of a parsed test node (undefined when a title in the chain is not static). */
export function staticFullName(m: NodeMatch): string | undefined {
  if (!hasStaticFullName(m.ancestry, m.node)) return undefined;
  return fullNameOfNode(m.ancestry, m.node);
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}

// ---------------------------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------------------------

/** First frame of a failure that lies inside `file`. */
export function firstFrameIn(failure: FailureInfo, file: string): Frame | undefined {
  return failure.frames.find(f => f.file === file);
}

// ---------------------------------------------------------------------------------------------
// Expected / actual word diff
// ---------------------------------------------------------------------------------------------

export interface DiffSegment { kind: 'same' | 'del' | 'ins'; text: string; }

/** Word-level diff (LCS over whitespace/word tokens); `del` comes from `expected`, `ins` from `actual`. */
export function wordDiff(expected: string, actual: string): DiffSegment[] {
  const a = tokenize(expected);
  const b = tokenize(actual);
  // LCS table (inputs are capped to keep hovers cheap).
  const n = a.length, m = b.length;
  const dp: Uint16Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffSegment[] = [];
  const push = (kind: DiffSegment['kind'], text: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push('same', a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push('del', a[i]); i++; }
    else { push('ins', b[j]); j++; }
  }
  while (i < n) push('del', a[i++]);
  while (j < m) push('ins', b[j++]);
  return out;
}

const MAX_DIFF_TOKENS = 4000;

function tokenize(text: string): string[] {
  const tokens = text.match(/\s+|\w+|[^\s\w]/g) ?? [];
  if (tokens.length <= MAX_DIFF_TOKENS) return tokens;
  return [...tokens.slice(0, MAX_DIFF_TOKENS), '…'];
}

export interface CompactDiffLine { text: string; changed: boolean; }

/**
 * Renders diff segments as lines marked with the given delimiters and truncates unchanged runs to
 * `context` lines around changes (Wallaby keeps 4). Changed text is wrapped by `mark(kind, text)`.
 */
export function compactDiff(segments: DiffSegment[], mark: (kind: 'del' | 'ins', text: string) => string, context = 4, ellipsis = '…'): string {
  // Build lines: each line is a list of segments.
  const lines: Array<{ parts: string[]; changed: boolean }> = [{ parts: [], changed: false }];
  for (const seg of segments) {
    const pieces = seg.text.split('\n');
    pieces.forEach((piece, idx) => {
      if (idx > 0) lines.push({ parts: [], changed: false });
      if (piece.length === 0) return;
      const cur = lines[lines.length - 1];
      if (seg.kind === 'same') cur.parts.push(piece);
      else { cur.parts.push(mark(seg.kind, piece)); cur.changed = true; }
    });
  }
  // Context truncation over runs of unchanged lines.
  const out: string[] = [];
  let run: string[] = [];
  const flushRun = (position: 'start' | 'middle' | 'end') => {
    if (run.length === 0) return;
    const limit = position === 'middle' ? context * 2 : context;
    if (run.length <= limit) out.push(...run);
    else if (position === 'start') out.push(ellipsis, ...run.slice(run.length - context));
    else if (position === 'end') out.push(...run.slice(0, context), ellipsis);
    else out.push(...run.slice(0, context), ellipsis, ...run.slice(run.length - context));
    run = [];
  };
  let seenChange = false;
  for (const l of lines) {
    const text = l.parts.join('');
    if (l.changed) { flushRun(seenChange ? 'middle' : 'start'); seenChange = true; out.push(text); }
    else run.push(text);
  }
  flushRun(seenChange ? 'end' : 'start');
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------------------------

/** Memoises `computeLineView` per path; call `invalidate(paths)` from the store's change event. */
export class LineViewCache {
  private readonly views = new Map<string, LineViewFile>();
  constructor(private readonly store: ResultStore, private readonly options: () => Partial<LineViewOptions>) {}

  get(path: string): LineViewFile {
    let v = this.views.get(path);
    if (!v) this.views.set(path, (v = computeLineView(this.store, path, this.options())));
    return v;
  }

  invalidate(paths?: Iterable<string>): void {
    if (!paths) { this.views.clear(); return; }
    for (const p of paths) this.views.delete(p);
  }
}
