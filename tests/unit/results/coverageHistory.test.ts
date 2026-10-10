import { ResultStore } from '../../../src/results/resultStore';
import { makeTestKey, PROTOCOL_VERSION as v, type WorkerToHost } from '../../../src/core/protocol';
import { selectAffected } from '../../../src/core/affected';
import { metadata, SOURCE } from './coverageRevisionFixtures';
import { CoverageHistory } from '../../../src/results/coverageHistory';

const SPEC = '/repo/math.test.js', OTHER = '/repo/other.test.js', PROJECT = 'p';
const TEXT = 'function a(x) {\n  return x + 1;\n}\nfunction b(x) {\n  return x * 2;\n}\nmodule.exports = { a, b };\n';
type Meta = ReturnType<typeof metadata>;

function setup() {
  const store = new ResultStore();
  const apply = (m: Omit<WorkerToHost, 'v'> | any) => store.apply({ v, ...m }, PROJECT);
  let count = 0;
  const begin = (meta: Meta, file = SPEC, names?: string[]) => {
    const runId = `r${++count}`;
    store.registerRun(runId, [{ path: file, names }]);
    apply({ type: 'fileStart', runId, path: file });
    apply({ type: 'coverageMeta', ...meta });
    return runId;
  };
  const test = (runId: string, meta: Meta, name: string, fn: number, file = SPEC) => {
    const testKey = makeTestKey(file, name, 0);
    const stmts = meta.stmtStartLine.flatMap((line, id) => line > meta.fnDeclLine[fn] && line <= meta.fnEndLine![fn] ? [id] : []);
    apply({ type: 'testCoverage', runId, path: file, testKey, files: [{ path: SOURCE, revision: meta.revision, hash: meta.hash, stmts, fns: [fn] }] });
    apply({ type: 'testResult', runId, path: file, testKey, fullName: name, ancestorTitles: [], title: name, status: 'passed', duration: 1, location: null, failures: [], invocations: 1 });
  };
  const finish = (runId: string, meta: Meta, shared: number[] = [], file = SPEC, complete = true) => {
    apply({ type: 'fileLoad', runId, path: file, files: [SOURCE], complete,
      shared: [{ path: SOURCE, revision: meta.revision, hash: meta.hash, stmts: [], fns: shared }] });
    apply({ type: 'fileResult', runId, path: file, status: 'passed', numPassing: 2, numFailing: 0, numPending: 0, numTodo: 0 });
    apply({ type: 'runComplete', runId, wasInterrupted: false, durationMs: 1, memory: { rss: 0, heapUsed: 0 } });
  };
  const select = (text: string) => {
    const sourceSelection = store.sourceSelection(SOURCE, text);
    return selectAffected({ changedFile: SOURCE, changedLines: null, sourceSelection,
      execBy: store.execBy(), loadedBy: store.loadedBy(), inverseStaticGraph: new Map([[SOURCE, new Set([SPEC])]]),
      runtimeTrackedTestFiles: sourceSelection.trackedFiles, testFiles: new Set([SPEC, OTHER]), failingTestsByFile: new Map(),
      settings: { maxTestFilesPerEdit: 8, alwaysRunFailing: false, useStaticGraph: true, trackFileLoading: true },
    });
  };
  const initial = (shared: number[] = []) => {
    const meta = metadata(TEXT), run = begin(meta);
    test(run, meta, 'a', 0); test(run, meta, 'b', 1); finish(run, meta, shared);
    return meta;
  };
  return { store, apply, begin, test, finish, select, initial };
}

describe('revision-backed affected selection', () => {
  it('selects tests that called an empty function and releases unreferenced source revisions', () => {
    const h = setup();
    const text = 'function a() {}\nfunction b() { return 2; }\nmodule.exports = { a, b };';
    const meta = metadata(text), run = h.begin(meta);
    h.test(run, meta, 'a', 0); h.test(run, meta, 'b', 1); h.finish(run, meta);
    expect(h.select(text.replace('a() {}', 'a() { return 1; }'))).toMatchObject({ runs: [{ path: SPEC, names: ['a'] }] });
    const history = new CoverageHistory();
    history.addMeta(PROJECT, SOURCE, meta);
    const hit = { path: SOURCE, revision: meta.revision, stmts: [], fns: [0] };
    const bound = history.bind(PROJECT, [hit]);
    history.replaceTest(makeTestKey(SPEC, 'a', 0), bound, 1);
    history.prune([]);
    expect(history.bind(PROJECT, [hit])[0].meta).toBeDefined();
    history.forgetFile(SPEC); history.prune([]);
    expect(history.bind(PROJECT, [hit])[0].meta).toBeUndefined();
    history.addMeta(PROJECT, SOURCE, meta); // worker resends on a later run/undo
    expect(history.bind(PROJECT, [hit])[0].meta).toBeDefined();
  });
  it('narrows ordinary imports and retains skipped tests through shifted metadata and undo', () => {
    const h = setup(); h.initial();
    const first = TEXT.replace('return x + 1;', 'x++;\n  return x + 1;');
    expect(h.select(first)).toMatchObject({ kind: 'runs', runs: [{ path: SPEC, names: ['a'] }] });
    const meta = metadata(first), run = h.begin(meta, SPEC, ['a']);
    h.test(run, meta, 'a', 0); h.finish(run, meta);
    expect(h.store.execBy().get(SOURCE)).toEqual(new Set([makeTestKey(SPEC, 'a', 0), makeTestKey(SPEC, 'b', 0)]));
    const bStmt = meta.stmtStartLine.findIndex(line => line === 6);
    expect(h.store.coverageFor(SOURCE)?.stmtHitBy.get(bStmt)).toContain(makeTestKey(SPEC, 'b', 0));
    expect(h.select(first.replace('x * 2', 'x * 3'))).toMatchObject({ kind: 'runs', runs: [{ path: SPEC, names: ['b'] }] });
    expect(h.select(TEXT)).toMatchObject({ kind: 'runs', runs: [{ path: SPEC, names: ['a'] }] });
  });

  it('retains whole-file runs for initialization/shared hooks, structural edits and incomplete tracking', () => {
    const h = setup(); h.initial([0]);
    expect(h.select(TEXT.replace('x + 1', 'x + 2'))).toMatchObject({ runs: [{ path: SPEC }] });
    const structural = h.select(TEXT.replace('{ a, b }', '{ a }'));
    expect(structural).toMatchObject({ runs: [{ path: SPEC }] });
    if (structural.kind === 'runs') expect(structural.runs[0].names).toBeUndefined();
    const meta = metadata(TEXT), run = h.begin(meta);
    h.test(run, meta, 'a', 0); h.test(run, meta, 'b', 1); h.finish(run, meta, [], SPEC, false);
    const incomplete = h.select(TEXT.replace('x + 1', 'x + 2'));
    if (incomplete.kind !== 'runs') throw new Error('expected fallback');
    expect(incomplete.runs).toEqual([{ path: SPEC }]);
  });

  it('keeps revision IDs aligned when workers interleave and late metadata arrives', () => {
    const h = setup(), old = h.initial();
    const newer = metadata(TEXT.replace('return x + 1;', 'x++;\n  return x + 1;'));
    const slow = h.begin(old, OTHER), fast = h.begin(newer, SPEC, ['a']);
    h.test(fast, newer, 'a', 0); h.finish(fast, newer);
    h.apply({ type: 'coverageMeta', ...old });
    h.test(slow, old, 'b other', 1, OTHER); h.finish(slow, old, [], OTHER);
    expect(h.store.coverageFor(SOURCE)?.meta?.revision).toBe(newer.revision);
    expect(h.store.sourceSelection(SOURCE, newer.sourceText!.replace('x * 2', 'x * 3')).tests)
      .toEqual(new Set([makeTestKey(SPEC, 'b', 0), makeTestKey(OTHER, 'b other', 0)]));
  });

  it('preserves dependencies after a failed load or interruption and clears them with the project', () => {
    const h = setup(), meta = h.initial();
    const run = h.begin(meta);
    h.apply({ type: 'fileResult', runId: run, path: SPEC, status: 'errored', testExecError: { message: 'syntax', frames: [] }, numPassing: 0, numFailing: 0, numPending: 0, numTodo: 0 });
    h.apply({ type: 'runComplete', runId: run, wasInterrupted: false });
    expect(h.store.execBy().get(SOURCE)?.size).toBe(2);
    const cancelled = h.begin(meta);
    h.apply({ type: 'runComplete', runId: cancelled, wasInterrupted: true });
    expect(h.select(TEXT.replace('x + 1', 'x + 2'))).toMatchObject({ runs: [{ path: SPEC }] });
    h.store.clearProject(PROJECT);
    expect(h.store.execBy().size).toBe(0);
    expect(h.store.sourceSelection(SOURCE, TEXT).tests.size).toBe(0);
  });

  it('does not narrow legacy messages without revision data', () => {
    const h = setup(), full = metadata(TEXT);
    const meta = { ...full, revision: undefined, sourceText: undefined, originalCoordinates: false };
    const run = h.begin(meta); h.test(run, meta, 'a', 0); h.test(run, meta, 'b', 1); h.finish(run, meta);
    const result = h.select(TEXT.replace('x + 1', 'x + 2'));
    expect(result).toMatchObject({ runs: [{ path: SPEC }] });
    if (result.kind === 'runs') expect(result.runs[0].names).toBeUndefined();
  });
});
