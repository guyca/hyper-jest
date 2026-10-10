/**
 * Host-side result store types. Pure; no 'vscode'. The store is fed by WorkerToHost messages and
 * read by decorations, diagnostics, hover, status bar and the Test Explorer.
 */
import type { FailureInfo, SnapshotSummary, TestStatus } from './protocol';

/** Gutter state per line, in priority order (first wins). */
export type LineState = 'errorSource' | 'errorPath' | 'partiallyCovered' | 'covered' | 'notCovered';
export const LINE_STATE_PRIORITY: LineState[] = ['errorSource', 'errorPath', 'partiallyCovered', 'covered', 'notCovered'];

export interface TestRecord {
  testKey: string;
  path: string;
  projectId: string;
  fullName: string;
  ancestorTitles: string[];
  title: string;
  status: TestStatus;
  duration: number | null;
  /** 1-based (Jest). */
  location: { line: number; column: number } | null;
  failures: FailureInfo[];
  invocations: number;
  lastRunId: string;
  updatedAt: number;
  /** Results predate an unsaved edit of this file or a dependency. */
  stale: boolean;
}

export interface FileRecord {
  path: string;
  projectId: string;
  status: 'passed' | 'failed' | 'errored' | 'skipped' | 'notMatched' | 'running' | 'queued' | 'unknown';
  testExecError?: FailureInfo;
  snapshot?: SnapshotSummary;
  testKeys: Set<string>;
  lastRunId?: string;
  updatedAt: number;
  stale: boolean;
}

/** Static shape of an instrumented source file (from CoverageMetaMsg). */
export interface CoverageMeta {
  hash: string;
  stmtStartLine: number[];
  stmtEndLine: number[];
  fnDeclLine: number[];
  /** 1-based last line per function id, parallel to `fnDeclLine` (optional; from CoverageMetaMsg.fnEndLine). */
  fnEndLine?: number[];
  /** [branchId, armIndex, line] triples flattened. */
  branchArms: number[];
  remapped: boolean;
}

/** Dynamic coverage of one source file, aggregated over the latest run of each test file. */
export interface FileCoverage {
  meta?: CoverageMeta;
  /** statementId -> testKeys that executed it (per-test mode) */
  stmtHitBy: Map<number, Set<string>>;
  /** statementId -> test FILE paths whose latest run hit it (file-level mode / union). */
  stmtHitByFile: Map<number, Set<string>>;
  /** `${branchId}:${armIndex}` -> test file paths that hit the arm. */
  branchArmHitByFile: Map<string, Set<string>>;
}

export interface InlineEntry {
  kind: 'error' | 'log' | 'value';
  text: string;
  /** Full text for the hover (may be multi-line). */
  longText?: string;
  testKey?: string;
  runId: string;
  level?: string;
}

export interface LineView {
  /** 0-based line. */
  line: number;
  state?: LineState;
  /** True when the state is from stale (pre-edit) data: drawn hollow. */
  stale: boolean;
  snapshot: boolean;
  entries: InlineEntry[];
  /** Test keys that executed this line (per-test mode) */
  tests: string[];
  failingTests: string[];
}

export interface LineViewFile {
  path: string;
  lines: Map<number, LineView>;
  /** 0-based lines with a test declaration and the aggregated status for the declaration gutter icon. */
  declarations: Map<number, { status: TestStatus | 'unknown'; testKeys: string[] }>;
}

export interface RunSummary {
  passed: number;
  failed: number;
  pending: number;
  running: number;
  queued: number;
  staleFiles: number;
}
