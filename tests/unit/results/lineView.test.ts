import { ResultStore } from '../../../src/results/resultStore';
import {
  computeLineView, inlineTextFor, matchRecordsToNodes, aggregateStatus, wordDiff, compactDiff, LineViewCache, truncate, strongerState, deepestTestAt,
} from '../../../src/results/lineView';
import type { LineView, TestRecord } from '../../../src/core/resultModel';
import type { ParsedFile } from '../../../src/core/testModel';
import {
  PROJECT, SPEC, SRC, T, key, applyFullRun, parsedMathSpec, fileStart, fileResult, fileCoverage, coverageMeta, consoleMsg, valueMsg, testResult, testCoverage, node, range,
} from './fixtures';

const L = (n: number) => n - 1; // 1-based source line -> 0-based view line

function record(fullName: string, status: TestRecord['status'], line: number | null, dup = 0): TestRecord {
  const parts = fullName.split(' ');
  return {
    testKey: key(fullName, dup), path: SPEC, projectId: PROJECT, fullName, ancestorTitles: [parts[0]], title: parts.slice(1).join(' '),
    status, duration: 1, location: line ? { line, column: 3 } : null, failures: [], invocations: 1, lastRunId: 'r', updatedAt: 1, stale: false,
  };
}

describe('computeLineView: coverage states', () => {
  it('computes covered / errorPath / notCovered from per-test hits + file union', () => {
    const store = new ResultStore();
    applyFullRun(store, 'r1');
    const view = computeLineView(store, SRC);
    expect(view.lines.get(L(2))?.state).toBe('covered');
    expect(view.lines.get(L(6))?.state).toBe('covered');     // both arms of the divide branch hit
    expect(view.lines.get(L(7))?.state).toBe('covered');
    expect(view.lines.get(L(9))?.state).toBe('covered');
    expect(view.lines.get(L(13))?.state).toBe('errorPath');  // executed by the failing test
    expect(view.lines.get(L(14))?.state).toBe('errorPath');
    expect(view.lines.get(L(15))?.state).toBe('errorPath');
    expect(view.lines.get(L(19))?.state).toBe('notCovered');
    expect(view.lines.get(L(2))?.tests.sort()).toEqual([key(T.addNeg), key(T.addTwo)].sort());
    expect(view.lines.get(L(15))?.failingTests).toEqual([key(T.positive)]);
    expect(view.lines.get(L(1))).toBeUndefined();            // function declaration line has no statement
    store.dispose();
  });

  it('flips the error path back to covered when the failing test passes', () => {
    const store = new ResultStore();
    applyFullRun(store, 'r1');
    applyFullRun(store, 'r2', { positiveStatus: 'passed' });
    const view = computeLineView(store, SRC);
    expect(view.lines.get(L(13))?.state).toBe('covered');
    expect(view.lines.get(L(15))?.state).toBe('covered');
    expect(view.lines.get(L(15))?.failingTests).toEqual([]);
    const spec = computeLineView(store, SPEC);
    expect(spec.lines.get(L(33))?.state).toBeUndefined();
    expect([...spec.lines.values()].some(v => v.entries.some(e => e.kind === 'error'))).toBe(false);
    store.dispose();
  });

  it('marks a line partially covered when a statement or branch arm on it was never hit', () => {
    const store = new ResultStore();
    store.apply(coverageMeta(), PROJECT);
    store.apply(fileStart('r1'), PROJECT);
    // s4 (if n<0) hit, s5 (return 'negative') not hit; divide's else arm (0:1) never taken.
    store.apply(fileCoverage('r1', [1, 2, 4, 6, 7], [0, 0, 1, 1, 2, 0, 2, 1]), PROJECT);
    store.apply(fileResult('r1', 'passed'), PROJECT);
    const view = computeLineView(store, SRC);
    expect(view.lines.get(L(6))?.state).toBe('partiallyCovered');
    expect(view.lines.get(L(13))?.state).toBe('partiallyCovered');
    expect(view.lines.get(L(14))?.state).toBe('covered');
    expect(view.lines.get(L(9))?.state).toBe('notCovered');
    expect(view.lines.get(L(13))?.tests).toEqual([]); // file-level mode: no per-test attribution
  });

  it('file-level mode cannot derive error paths (covered instead) but still marks error sources', () => {
    const store = new ResultStore();
    applyFullRun(store, 'r1', { perTest: false });
    const src = computeLineView(store, SRC);
    expect(src.lines.get(L(15))?.state).toBe('covered');
    const spec = computeLineView(store, SPEC);
    expect(spec.lines.get(L(33))?.state).toBe('errorSource');
  });
});

describe('computeLineView: errors, declarations, inline entries, stale', () => {
  it('marks error sources from frames and adds an inline error entry with the full message kept', () => {
    const store = new ResultStore();
    applyFullRun(store, 'r1');
    const view = computeLineView(store, SPEC, { maxLength: 30 });
    const line = view.lines.get(L(33))!;
    expect(line.state).toBe('errorSource');
    expect(line.failingTests).toEqual([key(T.positive)]);
    const err = line.entries.find(e => e.kind === 'error')!;
    expect(err.text).toBe('expect(received).toBe(expecte…');
    expect(err.longText).toContain('Received: "positive"');
    expect(inlineTextFor(line)!.kind).toBe('error');
  });

  it('falls back to the declaration line when a failure has no in-file frame and marks the body as error path', () => {
    const store = new ResultStore();
    store.setParsed(SPEC, parsedMathSpec());
    store.apply(fileStart('r1'), PROJECT);
    store.apply(testResult('r1', T.divides, 'failed', { line: 14, failures: [{ message: 'Timeout', frames: [{ file: '/elsewhere/x.js', line: 1, column: 1 }] }] }), PROJECT);
    store.apply(fileResult('r1', 'failed'), PROJECT);
    const view = computeLineView(store, SPEC);
    expect(view.lines.get(13)?.state).toBe('errorSource');   // location line 14 -> 0-based 13
    expect(view.lines.get(14)?.state).toBe('errorPath');     // rest of the test body (range 13..15)
    expect(view.lines.get(15)?.state).toBe('errorPath');
    expect(view.lines.get(13)?.entries[0]).toMatchObject({ kind: 'error', text: 'Timeout' });
    expect(view.declarations.get(13)).toEqual({ status: 'failed', testKeys: [key(T.divides)] });
  });

  it('reports a testExecError at its top in-file frame', () => {
    const store = new ResultStore();
    store.apply(fileStart('r1'), PROJECT);
    store.apply(fileResult('r1', 'errored', { testExecError: { message: 'Cannot find module ../lib/nope', frames: [{ file: SPEC, line: 1, column: 20 }] } }), PROJECT);
    const view = computeLineView(store, SPEC);
    expect(view.lines.get(0)?.state).toBe('errorSource');
    expect(view.lines.get(0)?.entries[0]).toMatchObject({ kind: 'error', text: 'Cannot find module ../lib/nope' });
  });

  it('aggregates declaration statuses from parsed nodes including .each rows and describes', () => {
    const store = new ResultStore();
    store.setParsed(SPEC, parsedMathSpec());
    applyFullRun(store, 'r1');
    const view = computeLineView(store, SPEC);
    expect(view.declarations.get(3)).toEqual({ status: 'passed', testKeys: [key(T.addTwo)] });
    expect(view.declarations.get(2)?.status).toBe('passed');                       // describe add
    expect(view.declarations.get(22)?.status).toBe('failed');                      // describe classify
    expect(view.declarations.get(23)?.testKeys.sort()).toEqual([key(T.eachNeg), key(T.eachZero)].sort()); // .each via location
    expect(view.declarations.get(30)?.status).toBe('failed');
    expect(view.declarations.get(34)?.status).toBe('skipped');
    expect(view.declarations.get(38)?.status).toBe('todo');
    expect(view.declarations.size).toBe(11);
  });

  it('renders inline logs and values with precedence, joining and truncation', () => {
    const store = new ResultStore();
    store.apply(fileStart('r1'), PROJECT);
    for (const t of ['one', 'two', 'three', 'four']) store.apply(consoleMsg('r1', t, { file: SRC, line: 5 }), PROJECT);
    store.apply(valueMsg('r1', '{ a: 1 }', { file: SRC, line: 5 }), PROJECT);
    store.apply(consoleMsg('r1', 'line two\nmore', { file: SRC, line: 6 }), PROJECT);
    store.apply(fileResult('r1', 'passed'), PROJECT);
    const view = computeLineView(store, SRC, { maxLogsPerLine: 3 });
    const l5 = view.lines.get(4)!;
    expect(inlineTextFor(l5, { maxLogsPerLine: 3 })).toMatchObject({ kind: 'value', text: '{ a: 1 }', count: 1 });
    const onlyLogs = { ...l5, entries: l5.entries.filter(e => e.kind === 'log') };
    expect(inlineTextFor(onlyLogs, { maxLogsPerLine: 3 })).toMatchObject({ kind: 'log', text: 'one, two, three, … +1', count: 4 });
    expect(inlineTextFor(onlyLogs, { maxLogsPerLine: 3, maxLength: 10 })!.text).toBe('one, two,…');
    expect(inlineTextFor(onlyLogs, { showLogs: false })).toBeUndefined();
    const l6 = view.lines.get(5)!;
    expect(l6.entries[0].text).toBe('line two');
    expect(l6.entries[0].longText).toBe('line two\nmore');
    expect(computeLineView(store, SRC, { showLogs: false, showValues: false }).lines.has(4)).toBe(false);
  });

  it('applies stale flags per line or for the whole file', () => {
    const store = new ResultStore();
    applyFullRun(store, 'r1');
    store.markStale(SRC, [L(13)]);
    let view = computeLineView(store, SRC);
    expect(view.lines.get(L(13))?.stale).toBe(true);
    expect(view.lines.get(L(2))?.stale).toBe(false);
    store.markStale(SRC);
    view = computeLineView(store, SRC);
    expect([...view.lines.values()].every(v => v.stale)).toBe(true);
    store.markStale(SPEC);
    expect([...computeLineView(store, SPEC).lines.values()].every(v => v.stale)).toBe(true);
  });

  it('flags snapshot lines and gives them a state from the owning test when the spec is not instrumented', () => {
    const store = new ResultStore();
    const parsed = parsedMathSpec();
    parsed.snapshotLines = [4, 31];
    store.setParsed(SPEC, parsed);
    applyFullRun(store, 'r1');
    const view = computeLineView(store, SPEC);
    expect(view.lines.get(4)).toMatchObject({ snapshot: true, state: 'covered' });
    expect(view.lines.get(31)).toMatchObject({ snapshot: true, state: 'errorPath' });
  });
});

describe('matchRecordsToNodes', () => {
  const parsed = parsedMathSpec();

  it('matches structurally, by k-th duplicate and by location for .each rows', () => {
    const records = [record(T.addTwo, 'passed', 4), record(T.eachNeg, 'passed', 24), record(T.eachZero, 'passed', 24), record('classify made up', 'passed', null)];
    const m = matchRecordsToNodes(parsed, records);
    expect(m.byKey.get(key(T.addTwo))!.node.title).toBe('adds two numbers');
    const each = parsed.nodes[2].children[0];
    expect(m.byNode.get(each)!.map(r => r.fullName).sort()).toEqual([T.eachNeg, T.eachZero].sort());
    expect(m.unmatched.map(r => r.fullName)).toEqual(['classify made up']);
    expect(m.staticWithoutResult.map(n => n.title)).toEqual(['adds negative numbers', 'divides', 'throws on zero', 'positive numbers (intentionally failing)', 'skipped test', 'todo test']);
  });

  it('maps duplicate names in document order, across same-named describes too', () => {
    const dupParsed = {
      ...parsed,
      nodes: [
        { ...parsed.nodes[0], title: 'a', children: [{ ...parsed.nodes[0].children[0], title: 'x', dupIndex: 0 }, { ...parsed.nodes[0].children[1], title: 'x', dupIndex: 1 }] },
        { ...parsed.nodes[1], title: 'a', dupIndex: 1, children: [{ ...parsed.nodes[1].children[0], title: 'x', dupIndex: 0 }] },
      ],
    };
    const m = matchRecordsToNodes(dupParsed, [record('a x', 'passed', 4, 0), record('a x', 'failed', 8, 1), record('a x', 'passed', 14, 2)]);
    expect(m.byKey.get(key('a x', 0))!.node.range.startLine).toBe(3);
    expect(m.byKey.get(key('a x', 1))!.node.range.startLine).toBe(7);
    expect(m.byKey.get(key('a x', 2))!.node.range.startLine).toBe(13);
    expect(m.unmatched).toEqual([]);
  });

  it('does not let the location hint steal a static node', () => {
    // A runtime test whose name matches nothing and whose location points into a static test.
    const m = matchRecordsToNodes(parsed, [record('add generated', 'passed', 4)]);
    expect(m.unmatched).toHaveLength(1);
  });

  it('aggregateStatus and helpers', () => {
    expect(aggregateStatus([])).toBe('unknown');
    expect(aggregateStatus([record('a b', 'passed', 1), record('a c', 'failed', 2)])).toBe('failed');
    expect(aggregateStatus([record('a b', 'passed', 1), record('a c', 'pending', 2)])).toBe('passed');
    expect(aggregateStatus([record('a c', 'pending', 2)])).toBe('skipped');
    expect(aggregateStatus([record('a c', 'todo', 2)])).toBe('todo');
    expect(strongerState('covered', 'errorPath')).toBe('errorPath');
    expect(strongerState(undefined, 'covered')).toBe('covered');
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(deepestTestAt(parsed, 24)!.node.each).toBe(true);
  });
});

describe('word diff', () => {
  it('produces del/ins segments at word granularity', () => {
    const segs = wordDiff('hello world', 'hello there world');
    expect(segs).toEqual([{ kind: 'same', text: 'hello ' }, { kind: 'ins', text: 'there ' }, { kind: 'same', text: 'world' }]);
    expect(wordDiff('positiv', 'positive')).toEqual([{ kind: 'del', text: 'positiv' }, { kind: 'ins', text: 'positive' }]);
  });

  it('compactDiff keeps 4 lines of context around changes', () => {
    const expected = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n');
    const actual = expected.replace('line 6', 'line six');
    const out = compactDiff(wordDiff(expected, actual), (k, t) => (k === 'del' ? `[-${t}-]` : `[+${t}+]`));
    const lines = out.split('\n');
    expect(lines[0]).toBe('…');
    expect(lines.slice(1, 5)).toEqual(['line 2', 'line 3', 'line 4', 'line 5']);
    expect(lines[5]).toBe('line [-6-][+six+]');
    expect(lines.slice(6, 10)).toEqual(['line 7', 'line 8', 'line 9', 'line 10']);
    expect(lines[10]).toBe('…');
    expect(lines).toHaveLength(11);
  });
});

describe('LineViewCache', () => {
  it('memoises per path and invalidates selectively', () => {
    const store = new ResultStore();
    applyFullRun(store, 'r1');
    const cache = new LineViewCache(store, () => ({}));
    const a = cache.get(SRC);
    expect(cache.get(SRC)).toBe(a);
    cache.invalidate([SPEC]);
    expect(cache.get(SRC)).toBe(a);
    cache.invalidate([SRC]);
    expect(cache.get(SRC)).not.toBe(a);
    cache.invalidate();
    store.apply(fileStart('r2'), PROJECT);
    store.apply(testCoverage('r2', T.addTwo, [0, 9]), PROJECT);
    store.apply(testResult('r2', T.addTwo, 'passed', { line: 4 }), PROJECT);
    expect(cache.get(SRC).lines.get(L(19))?.state).toBe('covered');
  });
});

describe('computeLineView: source-file error sources and inline precedence', () => {
  it('marks the throw site in a source file as errorSource (beats errorPath) with the failing test and message', () => {
    const store = new ResultStore();
    applyFullRun(store, 'r1');
    const failure = { message: 'TypeError: boom\n    at classify (math.js:15:3)', frames: [{ file: SRC, line: 15, column: 3, functionName: 'classify' }, { file: SPEC, line: 32, column: 5 }] };
    store.registerRun('r2', [{ path: SPEC, names: [T.positive] }]);
    store.apply(fileStart('r2'), PROJECT);
    store.apply(testCoverage('r2', T.positive, [4, 6, 8]), PROJECT);
    store.apply(testResult('r2', T.positive, 'failed', { line: 31, failures: [failure] }), PROJECT);
    store.apply(fileResult('r2', 'failed'), PROJECT);
    const src = computeLineView(store, SRC);
    expect(src.lines.get(L(15))?.state).toBe('errorSource');
    expect(src.lines.get(L(15))?.failingTests).toEqual([key(T.positive)]);
    expect(src.lines.get(L(15))?.entries[0]).toMatchObject({ kind: 'error', text: 'TypeError: boom', testKey: key(T.positive), runId: 'r2' });
    expect(src.lines.get(L(13))?.state).toBe('errorPath');
    expect(src.lines.get(L(2))?.state).toBe('covered'); // other tests kept by the narrowed run
    const spec = computeLineView(store, SPEC);
    expect(spec.lines.get(L(32))?.state).toBe('errorSource');
    expect(spec.lines.get(L(32))?.entries).toHaveLength(1);
  });

  it('inlineTextFor falls through to values, then logs, as kinds are hidden', () => {
    const view: LineView = {
      line: 0, stale: false, snapshot: false, tests: [], failingTests: [],
      entries: [{ kind: 'error', text: 'E', runId: 'r' }, { kind: 'value', text: '1', runId: 'r' }, { kind: 'log', text: 'l', runId: 'r', level: 'log' }],
    };
    expect(inlineTextFor(view)).toMatchObject({ kind: 'error', text: 'E', count: 1 });
    expect(inlineTextFor(view, { showErrors: false })).toMatchObject({ kind: 'value', text: '1' });
    expect(inlineTextFor(view, { showErrors: false, showValues: false })).toMatchObject({ kind: 'log', text: 'l' });
    expect(inlineTextFor(view, { showErrors: false, showValues: false, showLogs: false })).toBeUndefined();
  });

  it('exposes the core/testIds entries: describe.each rows and runtime-only ancestry', () => {
    const parsed: ParsedFile = {
      ...parsedMathSpec(),
      nodes: [node('describe', 'suite %s', range(0, 5, 0, 3), { each: true, children: [node('test', 'inner', range(1, 3))] })],
    };
    const rec = (ancestors: string[], title: string, line: number): TestRecord => ({
      ...record([...ancestors, title].join(' '), 'passed', line), ancestorTitles: ancestors, title,
    });
    const m = matchRecordsToNodes(parsed, [rec(['suite 2'], 'inner', 2), rec(['suite 1'], 'inner', 2), rec(['elsewhere', 'deep'], 'other', 9)], { projectId: 'p', relPath: 'm.test.js' });
    const inner = parsed.nodes[0].children[0];
    expect(m.byNode.get(inner)!.map(r => r.fullName)).toEqual(['suite 1 inner', 'suite 2 inner']);
    expect(m.unmatched.map(r => r.fullName)).toEqual(['elsewhere deep other']);
    expect(m.staticWithoutResult).toEqual([]);
    const rows = [...m.reconciled!.values()].filter(r => r.kind === 'eachRow');
    expect(rows.map(r => r.rowLabel)).toEqual(['suite 1 inner', 'suite 2 inner']);
    expect(rows[0].nodeId).toBe('p\0m.test.js\0describe:suite %s\0test:inner\0row:suite 1 inner');
    const only = m.reconciled!.get(key('elsewhere deep other'))!;
    expect(only).toMatchObject({ kind: 'runtimeOnly', parentId: 'p\0m.test.js', extraAncestors: ['elsewhere', 'deep'] });
    expect(only.nodeId).toBe('p\0m.test.js\0describe:elsewhere\0describe:deep\0test:other');
  });
});
