/**
 * Synthetic worker messages and a parsed tree mirroring tests/fixtures/sample-project/math.test.js.
 * Statement ids for src/lib/math.js (1-based lines):
 *   s0 L2 return a+b | s1 L6 if | s2 L7 throw | s3 L9 return | s4 L13 if | s5 L13 return 'negative'
 *   s6 L14 if | s7 L14 return 'zero' | s8 L15 return 'positive' | s9 L19 return (neverCalled)
 * Branches: b0 (divide if) arms 0/1 at L6; b1 arms at L13; b2 arms at L14.
 */
import type {
  ConsoleMsg, CoverageMetaMsg, FailureInfo, FileCoverageMsg, FileLoadMsg, FileResultMsg, FileStartMsg,
  RunCompleteMsg, TestCoverageMsg, TestResultMsg, TestStartMsg, TestStatus, ValueMsg,
} from '../../../src/core/protocol';
import { makeTestKey } from '../../../src/core/protocol';
import type { ParsedFile, ParsedNode, ParsedRange } from '../../../src/core/testModel';

export const PROJECT = 'proj-1';
export const SPEC = '/repo/pkg/src/__tests__/math.test.js';
export const SRC = '/repo/pkg/src/lib/math.js';
export const V = 1;

export const T = {
  addTwo: 'add adds two numbers',
  addNeg: 'add adds negative numbers',
  divides: 'divide divides',
  throws: 'divide throws on zero',
  eachNeg: 'classify classify(-5) -> negative',
  eachZero: 'classify classify(0) -> zero',
  positive: 'classify positive numbers (intentionally failing)',
  skipped: 'classify skipped test',
  todo: 'classify todo test',
};

export function key(fullName: string, dup = 0, path = SPEC): string {
  return makeTestKey(path, fullName, dup);
}

export function fileStart(runId: string, path = SPEC): FileStartMsg {
  return { v: V, type: 'fileStart', runId, path };
}

export function testStart(runId: string, fullName: string, path = SPEC): TestStartMsg {
  const parts = fullName.split(' ');
  return { v: V, type: 'testStart', runId, path, fullName, ancestorTitles: [parts[0]], title: parts.slice(1).join(' ') };
}

export function testResult(runId: string, fullName: string, status: TestStatus, opts: {
  line?: number; duration?: number | null; failures?: FailureInfo[]; dup?: number; path?: string;
} = {}): TestResultMsg {
  const path = opts.path ?? SPEC;
  const parts = fullName.split(' ');
  return {
    v: V, type: 'testResult', runId, path, fullName,
    ancestorTitles: [parts[0]], title: parts.slice(1).join(' '),
    testKey: makeTestKey(path, fullName, opts.dup ?? 0),
    status, duration: opts.duration === undefined ? 3 : opts.duration,
    location: opts.line ? { line: opts.line, column: 3 } : null,
    failures: opts.failures ?? [],
    invocations: 1,
  };
}

export const POSITIVE_FAILURE: FailureInfo = {
  message: 'expect(received).toBe(expected) // Object.is equality\n\nExpected: "positiv"\nReceived: "positive"',
  frames: [{ file: SPEC, line: 33, column: 25 }, { file: '/repo/pkg/node_modules/jest-circus/build/utils.js', line: 10, column: 1 }],
  matcherName: 'toBe',
  expected: 'positiv',
  actual: 'positive',
};

export function testCoverage(runId: string, fullName: string, stmts: number[], opts: { dup?: number; src?: string; path?: string } = {}): TestCoverageMsg {
  const path = opts.path ?? SPEC;
  return { v: V, type: 'testCoverage', runId, path, testKey: makeTestKey(path, fullName, opts.dup ?? 0), files: [{ path: opts.src ?? SRC, stmts }] };
}

export function fileLoad(runId: string, files: string[], path = SPEC): FileLoadMsg {
  return { v: V, type: 'fileLoad', runId, path, files };
}

export function coverageMeta(hash = 'h1', path = SRC): CoverageMetaMsg {
  return {
    v: V, type: 'coverageMeta', path, hash,
    stmtStartLine: [2, 6, 7, 9, 13, 13, 14, 14, 15, 19],
    stmtEndLine: [2, 8, 7, 9, 13, 13, 14, 14, 15, 19],
    fnDeclLine: [1, 5, 12, 18],
    branchArms: [0, 0, 6, 0, 1, 6, 1, 0, 13, 1, 1, 13, 2, 0, 14, 2, 1, 14],
    remapped: false,
  };
}

export function fileCoverage(runId: string, hitStmts: number[], hitBranchArms: number[], opts: { hash?: string; src?: string; path?: string } = {}): FileCoverageMsg {
  return { v: V, type: 'fileCoverage', runId, path: opts.path ?? SPEC, files: [{ path: opts.src ?? SRC, hash: opts.hash ?? 'h1', hitStmts, hitBranchArms }] };
}

export function consoleMsg(runId: string, text: string, opts: { testKey?: string; file?: string; line?: number; level?: ConsoleMsg['level']; path?: string } = {}): ConsoleMsg {
  return { v: V, type: 'console', runId, path: opts.path ?? SPEC, testKey: opts.testKey, level: opts.level ?? 'log', text, file: opts.file, line: opts.line, column: 1 };
}

export function valueMsg(runId: string, text: string, opts: { testKey?: string; file?: string; line: number; path?: string }): ValueMsg {
  return { v: V, type: 'value', runId, path: opts.path ?? SPEC, testKey: opts.testKey, file: opts.file ?? SRC, line: opts.line, column: 1, text };
}

export function fileResult(runId: string, status: FileResultMsg['status'], opts: Partial<FileResultMsg> = {}): FileResultMsg {
  return { v: V, type: 'fileResult', runId, path: SPEC, status, numPassing: 0, numFailing: 0, numPending: 0, numTodo: 0, ...opts };
}

export function runComplete(runId: string, wasInterrupted = false, error?: string): RunCompleteMsg {
  return { v: V, type: 'runComplete', runId, wasInterrupted, durationMs: 10, memory: { rss: 1, heapUsed: 1 }, error };
}

export function range(startLine: number, endLine = startLine, startColumn = 2, endColumn = 4): ParsedRange {
  return { startLine, startColumn, endLine, endColumn };
}

export function node(kind: ParsedNode['kind'], title: string, r: ParsedRange, extra: Partial<ParsedNode> = {}): ParsedNode {
  return { kind, title, titleKind: 'static', mode: 'default', each: false, concurrent: false, range: r, nameRange: range(r.startLine, r.startLine, r.startColumn + 3, r.startColumn + 3 + title.length), children: [], dupIndex: 0, ...extra };
}

/** Parsed tree for math.test.js (0-based lines, matching the fixture file's layout). */
export function parsedMathSpec(): ParsedFile {
  return {
    path: SPEC,
    hash: 'spec-hash',
    functionCount: 9,
    snapshotLines: [],
    nodes: [
      node('describe', 'add', range(2, 10, 0, 3), { children: [
        node('test', 'adds two numbers', range(3, 5)),
        node('test', 'adds negative numbers', range(7, 9)),
      ] }),
      node('describe', 'divide', range(12, 20, 0, 3), { children: [
        node('test', 'divides', range(13, 15)),
        node('test', 'throws on zero', range(17, 19)),
      ] }),
      node('describe', 'classify', range(22, 39, 0, 3), { children: [
        node('test', 'classify(%i) -> %s', range(23, 28), { each: true, titleKind: 'template' }),
        node('test', 'positive numbers (intentionally failing)', range(30, 32)),
        node('test', 'skipped test', range(34, 36), { mode: 'skip' }),
        node('test', 'todo test', range(38, 38), { mode: 'todo' }),
      ] }),
    ],
  };
}

/** Applies a complete, successful-but-one-failing run of math.test.js (per-test + file coverage). */
export function applyFullRun(store: { apply(msg: any, projectId: string): void }, runId: string, opts: { positiveStatus?: TestStatus; perTest?: boolean; fileLevel?: boolean; includeAddNeg?: boolean } = {}): void {
  const perTest = opts.perTest ?? true;
  const fileLevel = opts.fileLevel ?? true;
  const positive = opts.positiveStatus ?? 'failed';
  const a = (m: any) => store.apply(m, PROJECT);
  a(fileStart(runId));
  a(coverageMeta());
  a(fileLoad(runId, [SRC]));
  const run = (fullName: string, status: TestStatus, line: number, stmts: number[], failures: FailureInfo[] = []) => {
    a(testStart(runId, fullName));
    if (perTest) a(testCoverage(runId, fullName, stmts));
    a(testResult(runId, fullName, status, { line, failures }));
  };
  run(T.addTwo, 'passed', 4, [0]);
  if (opts.includeAddNeg ?? true) run(T.addNeg, 'passed', 8, [0]);
  run(T.divides, 'passed', 14, [1, 3]);
  run(T.throws, 'passed', 18, [1, 2]);
  run(T.eachNeg, 'passed', 24, [4, 5]);
  run(T.eachZero, 'passed', 24, [4, 6, 7]);
  run(T.positive, positive, 31, [4, 6, 8], positive === 'failed' ? [POSITIVE_FAILURE] : []);
  a(testResult(runId, T.skipped, 'pending', { line: 35, duration: null }));
  a(testResult(runId, T.todo, 'todo', { line: 39, duration: null }));
  if (fileLevel) a(fileCoverage(runId, [0, 1, 2, 3, 4, 5, 6, 7, 8], [0, 0, 0, 1, 1, 0, 1, 1, 2, 0, 2, 1]));
  a(fileResult(runId, positive === 'failed' ? 'failed' : 'passed', { numPassing: 6, numFailing: positive === 'failed' ? 1 : 0, numPending: 1, numTodo: 1 }));
  a(runComplete(runId));
}
