import { ResultStore } from '../../../src/results/resultStore';
import {
  PROJECT, SPEC, SRC, T, key, applyFullRun, fileStart, testStart, testResult, testCoverage, fileCoverage, fileResult,
  runComplete, consoleMsg, valueMsg, coverageMeta, POSITIVE_FAILURE, fileLoad,
} from './fixtures';

function makeStore() {
  const timers: Array<() => void> = [];
  const store = new ResultStore({
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => { timers.length = 0; },
    now: () => ++clock,
  });
  const fire = () => { const fns = timers.splice(0); for (const f of fns) f(); };
  return { store, fire };
}
let clock = 1000;

describe('ResultStore', () => {
  beforeEach(() => { clock = 1000; });

  it('records test results, file status and summary for a full run', () => {
    const { store } = makeStore();
    applyFullRun(store, 'r1');
    const file = store.fileRecord(SPEC)!;
    expect(file.status).toBe('failed');
    expect(file.projectId).toBe(PROJECT);
    expect(file.testKeys.size).toBe(9);
    expect(file.lastRunId).toBe('r1');
    const positive = store.test(key(T.positive))!;
    expect(positive.status).toBe('failed');
    expect(positive.failures[0].expected).toBe('positiv');
    expect(positive.location).toEqual({ line: 31, column: 3 });
    expect(store.summary()).toEqual({ passed: 6, failed: 1, pending: 2, running: 0, queued: 0, staleFiles: 0 });
    expect(store.failingTests().map(t => t.fullName)).toEqual([T.positive]);
    expect(store.testsInFile(SPEC).map(t => t.fullName)[0]).toBe(T.addTwo);
    expect(store.lastRun(SPEC)).toMatchObject({ runId: 'r1', filtered: false });
  });

  it('attributes per-test coverage, file-level union and loadedBy', () => {
    const { store } = makeStore();
    applyFullRun(store, 'r1');
    const cov = store.coverageFor(SRC)!;
    expect(cov.meta?.hash).toBe('h1');
    expect([...cov.stmtHitBy.get(0)!].sort()).toEqual([key(T.addNeg), key(T.addTwo)].sort());
    expect([...cov.stmtHitBy.get(8)!]).toEqual([key(T.positive)]);
    expect(cov.stmtHitBy.has(9)).toBe(false);
    expect([...cov.stmtHitByFile.get(4)!]).toEqual([SPEC]);
    expect(cov.branchArmHitByFile.has('0:1')).toBe(true);
    expect([...store.execBy().get(SRC)!]).toHaveLength(7);
    expect([...store.loadedBy().get(SRC)!]).toEqual([SPEC]);
    expect([...store.coveredSourcesOf(SPEC)]).toEqual([SRC]);
  });

  it('replaces a test file\'s contributions when its next run completes (fail -> pass flip)', () => {
    const { store } = makeStore();
    applyFullRun(store, 'r1');
    applyFullRun(store, 'r2', { positiveStatus: 'passed' });
    const positive = store.test(key(T.positive))!;
    expect(positive.status).toBe('passed');
    expect(positive.lastRunId).toBe('r2');
    expect(store.failingTests()).toEqual([]);
    const cov = store.coverageFor(SRC)!;
    // Still exactly one owner per statement: nothing duplicated across generations.
    expect([...cov.stmtHitBy.get(8)!]).toEqual([key(T.positive)]);
    expect([...cov.stmtHitByFile.get(4)!]).toEqual([SPEC]);
    expect(store.summary().failed).toBe(0);
  });

  it('drops a test that disappeared from the file after an unfiltered run', () => {
    const { store } = makeStore();
    applyFullRun(store, 'r1');
    expect(store.test(key(T.addNeg))).toBeDefined();
    applyFullRun(store, 'r2', { includeAddNeg: false });
    expect(store.test(key(T.addNeg))).toBeUndefined();
    expect(store.fileRecord(SPEC)!.testKeys.has(key(T.addNeg))).toBe(false);
    expect([...store.coverageFor(SRC)!.stmtHitBy.get(0)!]).toEqual([key(T.addTwo)]);
  });

  it('keeps de-selected tests of a narrowed run (reported as pending by Jest)', () => {
    const { store } = makeStore();
    applyFullRun(store, 'r1');
    store.registerRun('r3', [{ path: SPEC, names: [T.positive] }]);
    store.apply(fileStart('r3'), PROJECT);
    store.apply(testResult('r3', T.addTwo, 'pending', { line: 4, duration: null }), PROJECT);
    store.apply(testCoverage('r3', T.positive, [4, 6, 8]), PROJECT);
    store.apply(testResult('r3', T.positive, 'passed', { line: 31 }), PROJECT);
    store.apply(fileResult('r3', 'passed'), PROJECT);
    store.apply(runComplete('r3'), PROJECT);
    expect(store.test(key(T.addTwo))!.status).toBe('passed');
    expect(store.test(key(T.addTwo))!.lastRunId).toBe('r1');
    expect(store.test(key(T.positive))!.status).toBe('passed');
    // Other tests were not deleted although the narrowed run never reported them.
    expect(store.test(key(T.divides))).toBeDefined();
    expect(store.lastRun(SPEC)).toMatchObject({ runId: 'r3', filtered: true, names: [T.positive] });
    // Coverage of the kept tests survived; the re-run test's hits were replaced.
    expect([...store.coverageFor(SRC)!.stmtHitBy.get(0)!]).toHaveLength(2);
    expect([...store.coverageFor(SRC)!.stmtHitBy.get(8)!]).toEqual([key(T.positive)]);
  });

  it('merges (not replaces) file-level coverage and loadedBy for a narrowed run', () => {
    const { store } = makeStore();
    applyFullRun(store, 'r1');
    store.registerRun('r3', [{ path: SPEC, names: [T.addTwo] }]);
    store.apply(fileStart('r3'), PROJECT);
    store.apply(testResult('r3', T.addTwo, 'passed', { line: 4 }), PROJECT);
    store.apply(fileCoverage('r3', [0], []), PROJECT);
    store.apply(fileLoad('r3', ['/repo/pkg/src/lib/extra.js']), PROJECT);
    store.apply(fileResult('r3', 'passed'), PROJECT);
    const cov = store.coverageFor(SRC)!;
    expect(cov.stmtHitByFile.size).toBe(9);
    expect(cov.branchArmHitByFile.size).toBe(6);
    expect([...store.loadedBy().get(SRC)!]).toEqual([SPEC]);
    expect([...store.loadedBy().get('/repo/pkg/src/lib/extra.js')!]).toEqual([SPEC]);
    // The next unfiltered run replaces everything again.
    applyFullRun(store, 'r4');
    expect(store.loadedBy().has('/repo/pkg/src/lib/extra.js')).toBe(false);
  });

  it('uses the dupIndex scheme: duplicate names are distinct tests', () => {
    const { store } = makeStore();
    store.apply(fileStart('r1'), PROJECT);
    store.apply(testResult('r1', 'greet duplicate name', 'passed', { line: 16, dup: 0 }), PROJECT);
    store.apply(testResult('r1', 'greet duplicate name', 'failed', { line: 17, dup: 1, failures: [{ message: 'boom', frames: [] }] }), PROJECT);
    store.apply(fileResult('r1', 'failed'), PROJECT);
    expect(store.test(key('greet duplicate name', 0))!.status).toBe('passed');
    expect(store.test(key('greet duplicate name', 1))!.status).toBe('failed');
    expect(store.testsInFile(SPEC)).toHaveLength(2);
  });

  it('commits per-test coverage whether it arrives before or after the result', () => {
    const { store } = makeStore();
    store.apply(coverageMeta(), PROJECT);
    store.apply(fileStart('r1'), PROJECT);
    // before
    store.apply(testCoverage('r1', T.addTwo, [0]), PROJECT);
    store.apply(testResult('r1', T.addTwo, 'passed', { line: 4 }), PROJECT);
    expect([...store.coverageFor(SRC)!.stmtHitBy.get(0)!]).toEqual([key(T.addTwo)]);
    // after
    store.apply(testResult('r1', T.divides, 'passed', { line: 14 }), PROJECT);
    store.apply(testCoverage('r1', T.divides, [1, 3]), PROJECT);
    expect([...store.coverageFor(SRC)!.stmtHitBy.get(3)!]).toEqual([key(T.divides)]);
    expect([...store.execBy().get(SRC)!].sort()).toEqual([key(T.addTwo), key(T.divides)].sort());
  });

  it('works in file-level mode (no per-test data)', () => {
    const { store } = makeStore();
    applyFullRun(store, 'r1', { perTest: false });
    const cov = store.coverageFor(SRC)!;
    expect(cov.stmtHitBy.size).toBe(0);
    expect(cov.stmtHitByFile.size).toBe(9);
    expect(store.execBy().size).toBe(0);
  });

  it('keeps console and value entries per file/line with run generation and replaces them on the next run', () => {
    const { store } = makeStore();
    store.apply(fileStart('r1'), PROJECT);
    store.apply(consoleMsg('r1', 'greeting bob', { testKey: key(T.addTwo), file: SRC, line: 5 }), PROJECT);
    store.apply(valueMsg('r1', '"hello"', { testKey: key(T.addTwo), file: SRC, line: 6 }), PROJECT);
    store.apply(consoleMsg('r1', 'module scope', { file: SRC, line: 1 }), PROJECT);
    // Tagged entries wait for the test's result.
    expect(store.entriesFor(SRC).size).toBe(0);
    store.apply(testResult('r1', T.addTwo, 'passed', { line: 4 }), PROJECT);
    expect(store.entriesFor(SRC).get(4)![0]).toMatchObject({ kind: 'log', text: 'greeting bob', runId: 'r1', level: 'log' });
    expect(store.entriesFor(SRC).get(5)![0]).toMatchObject({ kind: 'value', text: '"hello"' });
    // Untagged entries land with fileResult, along with Jest's buffered console.
    store.apply(fileResult('r1', 'passed', { console: [{ level: 'warn', text: 'buffered', file: SRC, line: 2 }] }), PROJECT);
    expect(store.entriesFor(SRC).get(0)![0].text).toBe('module scope');
    expect(store.entriesFor(SRC).get(1)![0]).toMatchObject({ text: 'buffered', level: 'warn' });

    // Next run: the test logs something else and nothing at module scope.
    store.apply(fileStart('r2'), PROJECT);
    store.apply(consoleMsg('r2', 'greeting alice', { testKey: key(T.addTwo), file: SRC, line: 5 }), PROJECT);
    store.apply(testResult('r2', T.addTwo, 'passed', { line: 4 }), PROJECT);
    expect(store.entriesFor(SRC).get(4)!.map(e => e.text)).toEqual(['greeting alice']);
    expect(store.entriesFor(SRC).get(5)).toBeUndefined();
    store.apply(fileResult('r2', 'passed'), PROJECT);
    expect(store.entriesFor(SRC).has(0)).toBe(false);
    expect(store.entriesFor(SRC).has(1)).toBe(false);
    expect(store.entriesFor(SRC).get(4)!.map(e => e.text)).toEqual(['greeting alice']);
  });

  it('clearInlineEntries removes a line or a whole file', () => {
    const { store } = makeStore();
    store.apply(fileStart('r1'), PROJECT);
    store.apply(consoleMsg('r1', 'a', { file: SRC, line: 1 }), PROJECT);
    store.apply(consoleMsg('r1', 'b', { file: SRC, line: 2 }), PROJECT);
    store.apply(fileResult('r1', 'passed'), PROJECT);
    store.clearInlineEntries(SRC, 0);
    expect([...store.entriesFor(SRC).keys()]).toEqual([1]);
    store.clearInlineEntries(SRC);
    expect(store.entriesFor(SRC).size).toBe(0);
  });

  it('marks stale lines/files and clears them when a later run commits', () => {
    const { store } = makeStore();
    applyFullRun(store, 'r1');
    store.markStale(SRC, [12, 13]);
    expect(store.staleInfo(SRC)).toMatchObject({ all: false });
    expect([...store.staleInfo(SRC)!.lines]).toEqual([12, 13]);
    store.markStale(SPEC);
    expect(store.fileRecord(SPEC)!.stale).toBe(true);
    expect(store.test(key(T.addTwo))!.stale).toBe(true);
    expect(store.summary().staleFiles).toBe(1);
    applyFullRun(store, 'r2');
    expect(store.staleInfo(SRC)).toBeUndefined();
    expect(store.fileRecord(SPEC)!.stale).toBe(false);
    expect(store.test(key(T.addTwo))!.stale).toBe(false);
  });

  it('does not clear a stale mark set after the run started', () => {
    const { store } = makeStore();
    applyFullRun(store, 'r1');
    store.apply(fileStart('r2'), PROJECT);
    store.markStale(SRC);
    store.apply(fileCoverage('r2', [0], []), PROJECT);
    store.apply(fileResult('r2', 'passed'), PROJECT);
    expect(store.staleInfo(SRC)?.all).toBe(true);
    store.clearStale(SRC);
    expect(store.staleInfo(SRC)).toBeUndefined();
  });

  it('commits fileCoverage and fileLoad that arrive after fileResult (CLI reporter order)', () => {
    const { store } = makeStore();
    store.markStale(SRC);
    store.apply(fileStart('r1'), PROJECT);
    store.apply(coverageMeta(), PROJECT);
    store.apply(testResult('r1', T.addTwo, 'passed', { line: 4 }), PROJECT);
    store.apply(fileResult('r1', 'passed', { numPassing: 1 }), PROJECT);
    store.apply(fileCoverage('r1', [0, 3], [0, 1]), PROJECT);
    store.apply(fileLoad('r1', ['/repo/pkg/src/lib/extra.js']), PROJECT);
    store.apply(runComplete('r1'), PROJECT);
    const cov = store.coverageFor(SRC)!;
    expect([...cov.stmtHitByFile.keys()].sort()).toEqual([0, 3]);
    expect([...cov.branchArmHitByFile.keys()]).toEqual(['0:1']);
    expect([...store.loadedBy().get('/repo/pkg/src/lib/extra.js')!]).toEqual([SPEC]);
    expect(store.coveredSourcesOf(SPEC).has(SRC)).toBe(true);
    // runComplete must not turn the already-committed file into an error.
    expect(store.fileRecord(SPEC)!.status).toBe('passed');
    expect(store.fileRecord(SPEC)!.testExecError).toBeUndefined();
    expect(store.staleInfo(SRC)).toBeUndefined();
    // The next unfiltered run replaces the late contributions like any other.
    store.apply(fileStart('r2'), PROJECT);
    store.apply(fileResult('r2', 'passed'), PROJECT);
    expect(store.coverageFor(SRC)!.stmtHitByFile.size).toBe(0);
  });

  it('tracks queued/running state and started tests', () => {
    const { store } = makeStore();
    store.markQueued(SPEC, PROJECT);
    expect(store.fileRecord(SPEC)!.status).toBe('queued');
    expect(store.summary().queued).toBe(1);
    store.apply(fileStart('r1'), PROJECT);
    store.apply(testStart('r1', T.addTwo), PROJECT);
    expect(store.fileRecord(SPEC)!.status).toBe('running');
    expect(store.started(SPEC).map(s => s.fullName)).toEqual([T.addTwo]);
    expect(store.summary().running).toBe(1);
    store.apply(fileResult('r1', 'passed'), PROJECT);
    expect(store.started(SPEC)).toEqual([]);
    expect(store.fileRecord(SPEC)!.status).toBe('passed');
  });

  it('unmarkQueued restores the status from before markQueued', () => {
    const { store } = makeStore();
    applyFullRun(store, 'r1');
    expect(store.fileRecord(SPEC)!.status).toBe('failed');
    store.markQueued(SPEC, PROJECT);
    store.markQueued(SPEC, PROJECT); // re-queue keeps the original status
    expect(store.summary().queued).toBe(1);
    store.unmarkQueued(SPEC);
    expect(store.fileRecord(SPEC)!.status).toBe('failed');
    expect(store.summary().queued).toBe(0);
    // A never-run file goes back to unknown; a running file is left alone.
    store.markQueued('/repo/pkg/new.test.js', PROJECT);
    store.unmarkQueued('/repo/pkg/new.test.js');
    expect(store.fileRecord('/repo/pkg/new.test.js')!.status).toBe('unknown');
    store.markQueued(SPEC, PROJECT);
    store.apply(fileStart('r2'), PROJECT);
    store.unmarkQueued(SPEC);
    expect(store.fileRecord(SPEC)!.status).toBe('running');
  });

  it('discards pending data of an interrupted run and restores the file status', () => {
    const { store } = makeStore();
    applyFullRun(store, 'r1');
    store.apply(fileStart('r2'), PROJECT);
    store.apply(fileLoad('r2', ['/repo/pkg/src/lib/other.js']), PROJECT);
    store.apply(runComplete('r2', true), PROJECT);
    expect(store.fileRecord(SPEC)!.status).toBe('failed');
    expect(store.loadedBy().has('/repo/pkg/src/lib/other.js')).toBe(false);
    expect([...store.loadedBy().get(SRC)!]).toEqual([SPEC]);
  });

  it('turns a run that ends without a fileResult into a file-level error', () => {
    const { store } = makeStore();
    store.apply(fileStart('r1'), PROJECT);
    store.apply(runComplete('r1', false, 'worker crashed'), PROJECT);
    const file = store.fileRecord(SPEC)!;
    expect(file.status).toBe('errored');
    expect(file.testExecError?.message).toBe('worker crashed');
    expect(store.summary().failed).toBe(1);
  });

  it('records testExecError and resets coverage when a source file\'s hash changes', () => {
    const { store } = makeStore();
    applyFullRun(store, 'r1');
    store.apply(coverageMeta('h2'), PROJECT);
    const cov = store.coverageFor(SRC)!;
    expect(cov.meta?.hash).toBe('h2');
    expect(cov.stmtHitBy.size).toBe(0);
    expect(cov.stmtHitByFile.size).toBe(0);
    expect(store.execBy().has(SRC)).toBe(false);
    store.apply(fileStart('r2'), PROJECT);
    store.apply(fileResult('r2', 'errored', { testExecError: { message: 'SyntaxError: unexpected token', frames: [{ file: SPEC, line: 1, column: 1 }] } }), PROJECT);
    expect(store.fileRecord(SPEC)!.status).toBe('errored');
    expect(store.fileRecord(SPEC)!.testExecError?.message).toContain('SyntaxError');
  });

  it('clearFile and clearProject remove every contribution', () => {
    const { store } = makeStore();
    applyFullRun(store, 'r1');
    store.setParsed(SPEC, { path: SPEC, nodes: [], snapshotLines: [], functionCount: 0, hash: 'x' });
    store.clearFile(SPEC);
    expect(store.fileRecord(SPEC)).toBeUndefined();
    expect(store.testsInFile(SPEC)).toEqual([]);
    expect(store.parsed(SPEC)).toBeUndefined();
    expect(store.coverageFor(SRC)!.stmtHitBy.size).toBe(0);
    expect(store.coverageFor(SRC)!.stmtHitByFile.size).toBe(0);
    expect(store.loadedBy().size).toBe(0);
    expect(store.execBy().size).toBe(0);
    applyFullRun(store, 'r2');
    store.clearProject(PROJECT);
    expect(store.allFiles()).toEqual([]);
    expect(store.allTests()).toEqual([]);
  });

  it('coalesces change notifications and reports every touched path once', () => {
    const { store, fire } = makeStore();
    const batches: string[][] = [];
    store.onDidChange(paths => batches.push(paths));
    applyFullRun(store, 'r1');
    expect(batches).toEqual([]);
    fire();
    expect(batches).toHaveLength(1);
    expect(batches[0].sort()).toEqual([SPEC, SRC].sort());
    store.markStale(SRC);
    store.markStale(SRC);
    fire();
    expect(batches[1]).toEqual([SRC]);
    expect(store.generation).toBeGreaterThan(0);
  });

  it('uses the real timer by default (16 ms)', async () => {
    const store = new ResultStore();
    const seen: string[][] = [];
    store.onDidChange(p => seen.push(p));
    store.apply(fileStart('r1'), PROJECT);
    await new Promise(r => setTimeout(r, 40));
    expect(seen).toEqual([[SPEC]]);
    store.dispose();
  });

  it('ignores messages that carry no result data and ignores a console entry without a line', () => {
    const { store } = makeStore();
    store.apply({ v: 1, type: 'pong', rss: 1, heapUsed: 1 }, PROJECT);
    store.apply(consoleMsg('r1', 'no line'), PROJECT);
    expect(store.allFiles()).toEqual([]);
    store.apply(fileResult('r1', 'passed'), PROJECT);
    expect(store.entriesFor(SPEC).size).toBe(0);
  });

  it('exposes the failure frames for errorSource computation', () => {
    const { store } = makeStore();
    applyFullRun(store, 'r1');
    expect(store.test(key(T.positive))!.failures[0].frames[0]).toEqual(POSITIVE_FAILURE.frames[0]);
  });

  it('accepts every non-result WorkerToHost message without throwing and leaves the store untouched', () => {
    const { store } = makeStore();
    const inert = [
      { v: 1, type: 'ready', jestVersion: '29.7.0', nodeVersion: 'v24.19.0', configs: [], seams: { envWrapper: true, probeTransformer: true, cachePrune: true }, warnings: [], bootstrapMs: 1 },
      { v: 1, type: 'initError', kind: 'unknown', message: 'x' },
      { v: 1, type: 'graphResult', forward: {}, testFiles: [], unresolved: 0 },
      { v: 1, type: 'showConfigResult', json: '{}' },
      { v: 1, type: 'listTestsResult', files: [] },
      { v: 1, type: 'log', level: 'info', text: 'hi' },
      { v: 1, type: 'pong', rss: 1, heapUsed: 1 },
      { v: 1, type: 'overlayWriteBlocked', path: SPEC },
    ] as const;
    for (const m of inert) store.apply(m as unknown as Parameters<typeof store.apply>[0], PROJECT);
    expect(store.allFiles()).toEqual([]);
    expect(store.generation).toBe(0);
  });

  it('passes fnEndLine through coverageMeta and records notMatched files', () => {
    const { store } = makeStore();
    store.apply({ ...coverageMeta(), fnEndLine: [3, 10, 16, 20] }, PROJECT);
    expect(store.coverageFor(SRC)!.meta!.fnEndLine).toEqual([3, 10, 16, 20]);
    store.apply(fileResult('r1', 'notMatched'), PROJECT);
    expect(store.fileRecord(SPEC)!.status).toBe('notMatched');
    expect(store.summary()).toMatchObject({ failed: 0, running: 0, queued: 0 });
  });

  it('markRunning with names narrows the run without registerRun; abortRun discards it', () => {
    const { store } = makeStore();
    applyFullRun(store, 'r1');
    store.markRunning(SPEC, { runId: 'r2', names: [T.addTwo] });
    expect(store.fileRecord(SPEC)!.status).toBe('running');
    store.apply(testResult('r2', T.divides, 'pending', { line: 14, duration: null }), PROJECT);
    expect(store.test(key(T.divides))!.status).toBe('passed'); // de-selected: previous result kept
    store.abortRun('r2');
    expect(store.fileRecord(SPEC)!.status).toBe('failed');
    expect(store.lastRun(SPEC)!.runId).toBe('r1');
    // A fresh file: markRunning before any message creates the record.
    store.markRunning('/repo/pkg/other.test.js', { runId: 'r3', projectId: PROJECT });
    expect(store.fileRecord('/repo/pkg/other.test.js')).toMatchObject({ status: 'running', projectId: PROJECT });
  });

  it('caps inline entries per line and run generation', () => {
    const store = new ResultStore({ maxEntriesPerLine: 2 });
    store.apply(fileStart('r1'), PROJECT);
    for (let i = 0; i < 5; i++) store.apply(consoleMsg('r1', `m${i}`, { file: SRC, line: 3 }), PROJECT);
    store.apply(fileResult('r1', 'passed'), PROJECT);
    expect(store.entriesFor(SRC).get(2)!.map(e => e.text)).toEqual(['m0', 'm1']);
    store.dispose();
  });

  it('stops notifying after a listener or the store is disposed', () => {
    const { store, fire } = makeStore();
    const seen: string[][] = [];
    const sub = store.onDidChange(p => seen.push(p));
    store.markQueued(SPEC, PROJECT);
    sub.dispose();
    fire();
    expect(seen).toEqual([]);
    store.onDidChange(p => seen.push(p));
    store.markStale(SRC);
    store.dispose();
    fire();
    expect(seen).toEqual([]);
  });

  it('a newer in-flight generation for a file supersedes an older one', () => {
    const { store } = makeStore();
    applyFullRun(store, 'r1');
    store.apply(fileStart('r2'), PROJECT);
    store.apply(testCoverage('r2', T.addTwo, [9]), PROJECT);
    store.apply(fileStart('r3'), PROJECT);
    store.apply(testCoverage('r3', T.addTwo, [0]), PROJECT);
    store.apply(testResult('r3', T.addTwo, 'passed', { line: 4 }), PROJECT);
    // r2's stashed coverage was dropped with its pending run; r3's is committed.
    expect(store.coverageFor(SRC)!.stmtHitBy.has(9)).toBe(false);
    expect([...store.coverageFor(SRC)!.stmtHitBy.get(0)!]).toContain(key(T.addTwo));
    store.apply(testResult('r2', T.addTwo, 'failed', { line: 4, failures: [{ message: 'late', frames: [] }] }), PROJECT);
    // A late message of the superseded run re-creates a pending run for r2 but r3 keeps the file.
    store.apply(fileResult('r3', 'passed'), PROJECT);
    expect(store.fileRecord(SPEC)!.lastRunId).toBe('r3');
  });
});
