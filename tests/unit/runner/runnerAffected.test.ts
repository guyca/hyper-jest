/**
 * RunCoordinator affected-test selection and invalidation paths: the static graph's test files,
 * graph re-requests, continuous runs across projects, save after an on-type run, toolchain edits,
 * readiness re-evaluation of open editors, worker memory on release and CLI side messages.
 * The pool, registry and CLI engine are fakes; the ResultStore and DocumentIndex are real.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
jest.mock('vscode', () => {
  const fake = jest.requireActual('../results/fakeVscode');
  const handlers: Record<string, Array<(e: any) => void>> = {};
  const on = (name: string) => (l: (e: any) => void) => { (handlers[name] ??= []).push(l); return { dispose() { /* noop */ } }; };
  return {
    ...fake,
    __handlers: handlers,
    workspace: {
      ...fake.workspace,
      get textDocuments() { return fake.__state.textDocuments; },
      onDidChangeTextDocument: on('change'), onDidSaveTextDocument: on('save'), onDidOpenTextDocument: on('open'), onDidCloseTextDocument: on('close'),
      onDidCreateFiles: on('create'), onDidDeleteFiles: on('delete'), onDidRenameFiles: on('rename'),
    },
    window: { ...fake.window, onDidChangeActiveTextEditor: on('active'), showWarningMessage: jest.fn(async () => undefined), showInformationMessage: jest.fn(async () => undefined) },
  };
});
jest.mock('../../../src/cliEngine', () => ({ runCli: jest.fn(), findRelatedTests: jest.fn(async () => []) }));
jest.mock('../../../src/debug', () => ({ startDebugSession: jest.fn(async () => undefined) }));

import * as vscode from 'vscode';
import { RunCoordinator } from '../../../src/runner';
import { ResultStore } from '../../../src/results/resultStore';
import { DEFAULT_SETTINGS, type HyperJestSettings } from '../../../src/core/settingsModel';
import { PROTOCOL_VERSION, type HostToWorker, type ProjectSpec, type RunMsg, type WorkerToHost } from '../../../src/core/protocol';
import * as cliEngine from '../../../src/cliEngine';
import { __state, makeDocument, Uri } from '../results/fakeVscode';
import { metadata } from '../results/coverageRevisionFixtures';
import { makeTestKey } from '../../../src/core/protocol';

const P1 = 'p1';
const P2 = 'p2';
const A = '/repo/pkg/a.test.js';
const SRC = '/repo/pkg/src/x.js';
const C = '/repo/other/c.test.js';
const SRC2 = '/repo/other/src/y.js';
const TEXT = "test('x', () => { expect(1).toBe(1); });\n";

const handlers = (vscode as any).__handlers as Record<string, Array<(e: any) => void>>;
const fire = (name: string, e: any) => { for (const l of handlers[name] ?? []) l(e); };

class FakeWorker {
  readonly info = { id: 0, ready: {} };
  readonly sent: HostToWorker[] = [];
  constructor(readonly projectId: string, id: number) { this.info.id = id; }
  send(msg: HostToWorker): boolean { this.sent.push(msg); return true; }
  kill(): void { /* noop */ }
  runs(): RunMsg[] { return this.sent.filter((m): m is RunMsg => m.type === 'run'); }
  graphs(): number { return this.sent.filter(m => m.type === 'graph').length; }
}

function setup(overrides: Partial<HyperJestSettings> = {}) {
  for (const k of Object.keys(handlers)) delete handlers[k];
  __state.textDocuments.length = 0;
  const settings: HyperJestSettings = { ...DEFAULT_SETTINGS, smartStart: 'never', engine: 'warm' as any, onSaveDebounceMs: 0, ...overrides };
  let poolListener: (e: any) => void = () => undefined;
  let registryListener: (e: any) => void = () => undefined;
  let workerSeq = 0;
  const workers = new Map<string, FakeWorker>([[P1, new FakeWorker(P1, ++workerSeq)], [P2, new FakeWorker(P2, ++workerSeq)]]);
  const pool = {
    on: (l: (e: any) => void) => { poolListener = l; return () => undefined; },
    acquire: jest.fn(async (pid: string) => workers.get(pid)!),
    release: jest.fn(),
    capacity: () => 2,
    killProject: jest.fn(),
    broadcast: jest.fn(),
  };
  const specs = new Map<string, ProjectSpec>([
    [P1, { id: P1, displayName: 'pkg', status: 'ok' } as unknown as ProjectSpec],
    [P2, { id: P2, displayName: 'other', status: 'ok' } as unknown as ProjectSpec],
  ]);
  const entries = new Map<string, any>([...specs].map(([id, spec]) => [id, { spec, configsSource: 'worker', readiness: { kind: 'ready' } }]));
  const testFile = { isTest: (p: string) => p.endsWith('.test.js') };
  const projectIdFor = (p: string) => (p.startsWith('/repo/pkg/') ? P1 : p.startsWith('/repo/other/') ? P2 : undefined);
  const registry = {
    onDidChange: (l: (e: any) => void) => { registryListener = l; return { dispose() { /* noop */ } }; },
    projectIdFor,
    projectsFor: (p: string) => { const id = projectIdFor(p); return id ? [entries.get(id)] : []; },
    resolveMatchers: jest.fn(async () => ({})),
    acceptsTest: (_id: string, p: string) => testFile.isTest(p),
    monitorsSource: () => true,
    get: (id: string) => entries.get(id),
    projectFor: (p: string) => { const id = projectIdFor(p); return id ? entries.get(id) : undefined; },
    all: () => [...entries.values()],
    refresh: async () => undefined,
    setAutoBoot: jest.fn(),
    noteReady: jest.fn(),
    ensureReady: jest.fn(async () => ({})),
    invalidate: jest.fn(),
    isTestFile: (p: string) => testFile.isTest(p),
    testFilesOf: async () => [A],
    toolchainFiles: () => new Set<string>(),
  };
  const log = { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const store = new ResultStore();
  const runner = new RunCoordinator(pool as any, registry as any, store, () => settings, '/ext/dist/worker', log);
  const workerMsg = (worker: FakeWorker, msg: Partial<WorkerToHost>) => poolListener({ type: 'message', worker, msg: { v: PROTOCOL_VERSION, ...msg } });
  const complete = (worker: FakeWorker, runId: string, extra: Record<string, unknown> = {}) =>
    workerMsg(worker, { type: 'runComplete', runId, wasInterrupted: false, durationMs: 1, memory: { rss: 0, heapUsed: 0 }, ...extra } as any);
  const completeAll = () => { for (const w of workers.values()) for (const r of w.runs()) complete(w, r.runId); };
  return {
    runner, store, pool, registry, settings, entries, testFile, workers, log, complete, completeAll, workerMsg,
    w1: workers.get(P1)!, w2: workers.get(P2)!,
    poolEvent: (e: any) => poolListener(e),
    registryEvent: (e: any) => registryListener(e),
  };
}

const tick = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('RunCoordinator live scheduling', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); jest.clearAllMocks(); });
  const advance = (ms = 0) => jest.advanceTimersByTimeAsync(ms);
  const edit = (path: string, text: string) => {
    const doc = makeDocument(path, text);
    Object.assign(doc, { isDirty: true });
    const index = __state.textDocuments.findIndex(d => d.uri.fsPath === path);
    if (index < 0) __state.textDocuments.push(doc); else __state.textDocuments[index] = doc;
    fire('change', { document: doc, contentChanges: [{}] });
    return doc;
  };

  it('runs once after 500 ms idle using the latest unsaved edit', async () => {
    const { runner, store, w1 } = setup();
    await runner.start();
    store.forProject(P1);
    edit(A, TEXT);
    expect(store.staleInfo(A)).toBeDefined();
    await advance(300);
    expect(w1.runs()).toHaveLength(0);
    edit(A, TEXT.replace('1', '2'));
    await advance(499);
    expect(w1.runs()).toHaveLength(0);
    await advance(1);
    expect(w1.runs()).toHaveLength(1);
    expect(runner.overlay.entriesFor(P1)[0].text).toContain('expect(2)');
    runner.dispose(); store.dispose();
  });

  it('lets a slow run finish and coalesces all edits into one latest rerun', async () => {
    const { runner, store, w1, complete } = setup();
    await runner.start();
    edit(A, TEXT);
    await advance(500);
    for (const value of ['2', '3', '4']) {
      edit(A, TEXT.replace('1', value));
      await advance(500);
    }
    expect(w1.runs()).toHaveLength(1);
    expect(w1.sent.filter(m => m.type === 'cancel')).toHaveLength(0);
    complete(w1, w1.runs()[0].runId);
    await advance();
    expect(w1.runs()).toHaveLength(2);
    expect(runner.overlay.entriesFor(P1)[0].text).toContain('expect(4)');
    complete(w1, w1.runs()[1].runId);
    await advance(1000);
    expect(w1.runs()).toHaveLength(2);
    runner.dispose(); store.dispose();
  });

  it('waits for typing to settle even if the previous run finishes first', async () => {
    const { runner, store, w1, complete } = setup();
    await runner.start();
    edit(A, TEXT);
    await advance(500);
    edit(A, TEXT.replace('1', '2'));
    complete(w1, w1.runs()[0].runId);
    await advance(499);
    expect(w1.runs()).toHaveLength(1);
    await advance(1);
    expect(w1.runs()).toHaveLength(2);
    runner.dispose(); store.dispose();
  });

  it('coalesces saves and cancels an older saved-text timer when typing resumes', async () => {
    const { runner, store, w1, complete } = setup({ onSaveDebounceMs: 100 });
    await runner.start();
    const doc = edit(A, TEXT);
    fire('save', doc);
    await advance(50);
    edit(A, TEXT.replace('1', '2'));
    await advance(100);
    expect(w1.runs()).toHaveLength(0);
    const latest = __state.textDocuments[0];
    fire('save', latest);
    fire('save', latest);
    await advance(100);
    expect(w1.runs()).toHaveLength(1);
    fire('save', latest);
    complete(w1, w1.runs()[0].runId);
    await advance(1000);
    expect(w1.runs()).toHaveLength(1);
    runner.dispose(); store.dispose();
  });

  it('saving one file does not shorten a sibling buffer\'s typing debounce', async () => {
    const { runner, store, w1, workerMsg } = setup({ onSaveDebounceMs: 100 });
    await runner.start();
    const other = '/repo/pkg/src/other.js';
    workerMsg(w1, { type: 'graphResult', forward: { [A]: [SRC, other] }, testFiles: [A], unresolved: 0 } as any);
    const saved = edit(SRC, 'export const x = 1;');
    await advance(100);
    edit(other, 'export const y = 2;');
    await advance(100);
    fire('save', saved);
    await advance(100);
    expect(w1.runs()).toHaveLength(0);
    await advance(299);
    expect(w1.runs()).toHaveLength(0);
    await advance(1);
    expect(w1.runs()).toHaveLength(1);
    runner.dispose(); store.dispose();
  });

  it('cancels pending timers on stop so restart does not run an old edit', async () => {
    const { runner, store, w1 } = setup();
    await runner.start();
    edit(A, TEXT);
    runner.stop();
    await runner.start();
    await advance(1000);
    expect(w1.runs()).toHaveLength(0);
    runner.dispose(); store.dispose();
  });

  it('does not dispatch obsolete selections after asynchronous dependency discovery', async () => {
    const { runner, store, w1 } = setup();
    let resolve!: (files: string[]) => void;
    (cliEngine.findRelatedTests as jest.Mock).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    await runner.start();
    edit(SRC, 'export const x = 1;');
    await advance(500);
    edit(SRC, 'export const x = 2;');
    resolve([A]);
    await advance();
    expect(w1.runs()).toHaveLength(0);
    (cliEngine.findRelatedTests as jest.Mock).mockResolvedValueOnce([A]);
    await advance(500);
    expect(w1.runs()).toHaveLength(1);
    runner.dispose(); store.dispose();
  });

  it('keeps continuous selections when related-test discovery finishes before their matcher lookup', async () => {
    const { runner, store, w1, registry, complete } = setup();
    await runner.start();
    runner.watch([{ path: A }], { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
    await advance();
    complete(w1, w1.runs()[0].runId);
    await advance();
    let resolve!: () => void;
    registry.resolveMatchers.mockImplementationOnce(() => new Promise(r => { resolve = () => r({}); }));
    const related = '/repo/pkg/related.test.js';
    (cliEngine.findRelatedTests as jest.Mock).mockResolvedValueOnce([related]);
    const doc = edit(SRC, 'export const x = 1;');
    await advance(500);
    resolve();
    await advance();
    expect(w1.runs().slice(1).flatMap(r => r.tests.map(t => t.path)).sort()).toEqual([A, related].sort());
    for (const run of w1.runs().slice(1)) complete(w1, run.runId);
    await advance();
    fire('save', doc);
    await advance(100);
    expect(w1.runs()).toHaveLength(3);
    runner.dispose(); store.dispose();
  });

  it.each([{ related: [] }, { related: [A] }])('keeps the watch and merges overlaps when discovery returns $related', async ({ related }) => {
    const { runner, store, w1, complete } = setup();
    await runner.start();
    runner.watch([{ path: A, names: ['x'] }], { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
    await advance();
    complete(w1, w1.runs()[0].runId);
    await advance();
    (cliEngine.findRelatedTests as jest.Mock).mockResolvedValueOnce(related);
    edit(SRC, 'export const x = 1;');
    await advance(500);
    expect(w1.runs()).toHaveLength(2);
    expect(w1.runs()[1].tests).toEqual(related.length ? [{ path: A }] : [{ path: A, names: ['x'] }]);
    complete(w1, w1.runs()[1].runId);
    await advance(1000);
    expect(w1.runs()).toHaveLength(2);
    runner.dispose(); store.dispose();
  });

  it('merges overlapping affected selections from multiple edited files in a project', async () => {
    const { runner, store, w1, workerMsg, complete } = setup();
    await runner.start();
    const other = '/repo/pkg/src/other.js';
    workerMsg(w1, { type: 'graphResult', forward: { [A]: [SRC, other] }, testFiles: [A], unresolved: 0 } as any);
    edit(SRC, 'export const x = 1;');
    await advance(300);
    edit(other, 'export const y = 2;');
    await advance(499);
    expect(w1.runs()).toHaveLength(0);
    await advance(1);
    expect(w1.runs()).toHaveLength(1);
    complete(w1, w1.runs()[0].runId);
    await advance(1000);
    expect(w1.runs()).toHaveLength(1);
    runner.dispose(); store.dispose();
  });

  it('automatically drains affected files beyond the live cap after the first batch', async () => {
    const { runner, store, w1, workerMsg, complete } = setup({ liveRun: { maxTestFilesPerEdit: 1 } });
    await runner.start();
    const b = '/repo/pkg/b.test.js';
    workerMsg(w1, { type: 'graphResult', forward: { [A]: [SRC], [b]: [SRC] }, testFiles: [A, b], unresolved: 0 } as any);
    edit(SRC, 'export const x = 1;');
    await advance(500);
    expect(w1.runs()).toHaveLength(1);
    expect(runner.getState().capped?.count).toBe(1);
    complete(w1, w1.runs()[0].runId);
    await advance();
    expect(w1.runs()).toHaveLength(2);
    expect(w1.runs()[1].tests).toEqual([{ path: b }]);
    expect(runner.getState().capped).toBeUndefined();
    runner.dispose(); store.dispose();
  });

  it('reserves a deferred batch while asynchronous matcher resolution is pending', async () => {
    const { runner, store, w1, w2, registry, workerMsg, complete } = setup({ liveRun: { maxTestFilesPerEdit: 1 } });
    await runner.start();
    const b = '/repo/pkg/b.test.js', c = '/repo/pkg/c.test.js';
    workerMsg(w1, { type: 'graphResult', forward: { [A]: [SRC], [b]: [SRC], [c]: [SRC] }, testFiles: [A, b, c], unresolved: 0 } as any);
    edit(SRC, 'export const x = 1;');
    await advance(500);
    await runner.runFiles([{ path: C }], 'explicit');
    await advance();
    let resolve!: () => void;
    registry.resolveMatchers.mockImplementationOnce(() => new Promise(r => { resolve = () => r({}); }));
    complete(w1, w1.runs()[0].runId);
    await advance();
    expect(runner.getState().capped?.count).toBe(1);
    // Completing another project pumps the queue while b is still resolving its matchers.
    complete(w2, w2.runs()[0].runId);
    await advance();
    expect(runner.getState().capped?.count).toBe(1);
    expect(w1.runs()).toHaveLength(1);
    resolve();
    await advance();
    expect(w1.runs()).toHaveLength(2);
    expect(w1.runs()[1].tests).toEqual([{ path: b }]);
    complete(w1, w1.runs()[1].runId);
    await advance();
    expect(w1.runs()).toHaveLength(3);
    expect(w1.runs()[2].tests).toEqual([{ path: c }]);
    runner.dispose(); store.dispose();
  });

  it('retains pending edits while paused and runs the latest text on resume', async () => {
    const { runner, store, w1 } = setup();
    await runner.start();
    runner.pause();
    edit(A, TEXT);
    await advance(500);
    edit(A, TEXT.replace('1', '2'));
    await advance(500);
    expect(w1.runs()).toHaveLength(0);
    runner.resume();
    await advance();
    expect(w1.runs()).toHaveLength(1);
    runner.dispose(); store.dispose();
  });

  it.each(['manual', 'onSave'] as const)('respects %s mode', async runMode => {
    const { runner, store, w1 } = setup({ runMode });
    await runner.start();
    const doc = edit(A, TEXT);
    await advance(1000);
    expect(w1.runs()).toHaveLength(0);
    fire('save', doc);
    await advance(100);
    expect(w1.runs()).toHaveLength(runMode === 'manual' ? 0 : 1);
    runner.dispose(); store.dispose();
  });

  it('does not let a busy project delay live tests in another project', async () => {
    const { runner, store, w1, w2 } = setup();
    await runner.start();
    await runner.runFiles([{ path: A }], 'explicit');
    await advance();
    edit(A, TEXT);
    edit(C, TEXT);
    await advance(500);
    expect(w1.runs()).toHaveLength(1);
    expect(w2.runs()).toHaveLength(1);
    runner.dispose(); store.dispose();
  });

  it.each(['manual', 'onSave'] as const)('discards an unsaved on-type batch when switched to %s', async mode => {
    const { runner, store, w1, settings } = setup();
    await runner.start();
    edit(A, TEXT);
    settings.runMode = mode;
    await advance(500);
    expect(w1.runs()).toHaveLength(0);
    runner.dispose(); store.dispose();
  });

  it('does not resurrect work cancelled while resolving matchers', async () => {
    const { runner, store, w1, registry } = setup();
    let resolve!: () => void;
    registry.resolveMatchers.mockImplementationOnce(() => new Promise(r => { resolve = () => r({}); }));
    await runner.start();
    const pending = runner.runFiles([{ path: A }], 'onSave');
    runner.stop();
    await runner.start();
    resolve();
    const handle = await pending;
    expect(await handle.done).toMatchObject({ wasInterrupted: true });
    await advance();
    expect(w1.runs()).toHaveLength(0);
    runner.dispose(); store.dispose();
  });
});

describe('RunCoordinator affected selection', () => {
  afterEach(() => jest.clearAllMocks());

  it('dispatches function names using recorded source text rather than the current editor buffer', async () => {
    const { runner, store, w1, completeAll } = setup();
    await runner.start();
    const text = 'function a() { return 1; }\nfunction b() { return 2; }\nmodule.exports = { a, b };';
    const meta = metadata(text, SRC);
    const apply = (m: any) => store.apply({ v: PROTOCOL_VERSION, ...m }, P1);
    store.registerRun('baseline', [{ path: A }]);
    apply({ type: 'fileStart', runId: 'baseline', path: A });
    apply({ type: 'coverageMeta', ...meta });
    for (const [name, fn] of [['a', 0], ['b', 1]] as const) {
      const testKey = makeTestKey(A, name, 0);
      apply({ type: 'testCoverage', runId: 'baseline', path: A, testKey, files: [{ path: SRC, revision: meta.revision, stmts: [fn], fns: [fn] }] });
      apply({ type: 'testResult', runId: 'baseline', path: A, testKey, fullName: name, title: name, ancestorTitles: [], status: 'passed', duration: 1, location: null, failures: [], invocations: 1 });
    }
    apply({ type: 'fileLoad', runId: 'baseline', path: A, files: [SRC], complete: true, shared: [{ path: SRC, revision: meta.revision, stmts: [], fns: [] }] });
    apply({ type: 'fileResult', runId: 'baseline', path: A, status: 'passed', numPassing: 2 });
    apply({ type: 'runComplete', runId: 'baseline', wasInterrupted: false });
    const edited = text.replace('return 1', 'return 3');
    __state.textDocuments.push(makeDocument(SRC, edited));
    expect(await runner.runAffected(SRC, edited, 'onType')).toMatchObject({ runs: [{ path: A, names: ['a'] }] });
    await tick();
    expect(w1.runs()[0].tests).toEqual([{ path: A, names: ['a'] }]);
    completeAll(); await tick(); runner.dispose(); store.dispose();
  });

  it('selects never-run spec files the static graph knows (graphResult.testFiles)', async () => {
    const { runner, w1, workerMsg } = setup();
    await runner.start();
    workerMsg(w1, { type: 'graphResult', forward: { [A]: [SRC] }, testFiles: [A], unresolved: 0 } as any);
    const result = await runner.runAffected(SRC, 'export const x = 2;', 'onType');
    expect(result).toMatchObject({ kind: 'runs', runs: [{ path: A }] });
  });

  it('asks a new worker for the graph once the worker that had it is gone', async () => {
    const { runner, pool, w1, complete, poolEvent } = setup();
    await runner.start();
    await runner.runFiles([{ path: A }], 'explicit');
    await tick();
    expect(w1.graphs()).toBe(1);
    complete(w1, w1.runs()[0].runId);
    await tick();
    poolEvent({ type: 'exit', worker: w1, code: 0, signal: null, reason: 'idle timeout' });
    const w3 = new FakeWorker(P1, 3);
    pool.acquire.mockImplementation(async () => w3 as any);
    await runner.runFiles([{ path: A }], 'explicit');
    await tick();
    expect(w3.graphs()).toBe(1);
    // Graph requested after the run message: the run is not delayed by the graph build.
    expect(w3.sent.map(m => m.type)).toEqual(['run', 'graph']);
  });

  it('files created from VS Code rebuild the workers\' haste maps and refresh the graph', async () => {
    const { runner, pool, w1, complete } = setup();
    await runner.start();
    await runner.runFiles([{ path: A }], 'explicit');
    await tick();
    complete(w1, w1.runs()[0].runId);
    await tick();
    fire('create', { files: [Uri.file('/repo/pkg/new.test.js'), Uri.file('/repo/pkg/node_modules/x/index.js'), Uri.file('/elsewhere/z.js')] });
    expect(pool.broadcast).toHaveBeenCalledWith(P1, expect.objectContaining({ type: 'invalidate', reason: 'files', paths: ['/repo/pkg/new.test.js'] }));
    expect(pool.broadcast).toHaveBeenCalledTimes(1);
    await runner.runFiles([{ path: A }], 'explicit');
    await tick();
    expect(w1.graphs()).toBe(2);
  });

  it('continuous runs over two packages re-run each package\'s part on its edits, whatever the edit affects', async () => {
    const { runner, w2, completeAll, settings } = setup();
    settings.affected = { ...settings.affected, discoverWithJest: false };
    await runner.start();
    runner.watch([{ path: A }, { path: C }], { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() { /* noop */ } }) });
    await tick();
    expect(w2.runs()).toHaveLength(1);
    completeAll();
    await tick();
    const result = await runner.runAffected(SRC2, 'export const y = 1;', 'onType');
    expect(result?.kind).toBe('discover');
    await tick();
    expect(w2.runs()).toHaveLength(2);
    expect(w2.runs()[1].tests).toEqual([{ path: C }]);
  });

  it('a toolchain edit invalidates through the registry instead of messaging busy workers', async () => {
    const { runner, pool, registry } = setup();
    await runner.start();
    const result = await runner.runAffected('/repo/pkg/jest.config.js', 'module.exports = {};', 'onType');
    expect(result?.kind).toBe('invalidateConfig');
    expect(registry.invalidate).toHaveBeenCalledWith(P1, ['/repo/pkg/jest.config.js']);
    expect(pool.broadcast).not.toHaveBeenCalledWith(P1, expect.objectContaining({ type: 'invalidate' }));
  });
});

describe('RunCoordinator save after an on-type run', () => {
  afterEach(() => jest.clearAllMocks());

  it('does not re-run a file saved with the text its on-type run already ran', async () => {
    const { runner, w1, complete } = setup();
    await runner.start();
    await runner.runAffected(A, TEXT, 'onType');
    await tick();
    expect(w1.runs()).toHaveLength(1);
    complete(w1, w1.runs()[0].runId);
    await tick();
    fire('save', makeDocument(A, TEXT));
    await sleep(5);
    await tick();
    expect(w1.runs()).toHaveLength(1);
    // A different text (typed after the on-type run) runs on save.
    fire('save', makeDocument(A, `${TEXT}\n`));
    await sleep(5);
    await tick();
    expect(w1.runs()).toHaveLength(2);
  });

  it('re-runs on save when the on-type run could not write an inline snapshot into the unsaved file', async () => {
    const { runner, w1, complete, workerMsg } = setup();
    await runner.start();
    await runner.runAffected(A, TEXT, 'onType');
    await tick();
    workerMsg(w1, { type: 'overlayWriteBlocked', path: A } as any);
    complete(w1, w1.runs()[0].runId);
    await tick();
    // The warning told the user to save: that save must run the file again.
    fire('save', makeDocument(A, TEXT));
    await sleep(5);
    await tick();
    expect(w1.runs()).toHaveLength(2);
  });

  it('re-runs on save when the on-type run was interrupted', async () => {
    const { runner, w1, complete } = setup();
    await runner.start();
    await runner.runAffected(A, TEXT, 'onType');
    await tick();
    complete(w1, w1.runs()[0].runId, { wasInterrupted: true });
    await tick();
    fire('save', makeDocument(A, TEXT));
    await sleep(5);
    await tick();
    expect(w1.runs()).toHaveLength(2);
  });
});

describe('RunCoordinator readiness and documents', () => {
  afterEach(() => jest.clearAllMocks());

  it('re-evaluates open editors when a project becomes ready, and boots projects still on default matchers', async () => {
    const { runner, w1, registry, entries, testFile, registryEvent } = setup({ smartStart: 'open' });
    entries.get(P1).configsSource = 'static';
    entries.get(P1).readiness = { kind: 'cold' };
    testFile.isTest = () => false; // Jest's default testMatch does not know `*.unit.js`
    const U = '/repo/pkg/a.unit.js';
    __state.textDocuments.push(makeDocument(U, TEXT));
    await runner.start();
    expect(registry.resolveMatchers).toHaveBeenCalledWith(P1);
    await tick();
    expect(w1.runs()).toHaveLength(0);
    testFile.isTest = p => p === U;
    entries.get(P1).configsSource = 'worker';
    entries.get(P1).readiness = { kind: 'ready' };
    registryEvent({ type: 'ready', projectId: P1, ready: {} });
    await tick();
    expect(w1.runs()).toHaveLength(1);
    expect(w1.runs()[0]).toMatchObject({ tests: [{ path: U }], reason: 'open' });
  });

  it('Run Line keeps targeting the right test while the file has an unrecoverable syntax error', async () => {
    const { runner, w1 } = setup();
    await runner.start();
    const GOOD = "describe('d', () => {\n  test('a', () => {});\n  test('b', () => {});\n});\n";
    runner.docs.update(A, GOOD);
    const broken = makeDocument(A, `${GOOD}const x = {{;\n`);
    __state.textDocuments.push(broken);
    expect(runner.docs.ensure(A)?.nodes).toEqual([]); // the broken buffer has no tree
    await runner.runLine(A, 2, 'run');
    await tick();
    expect(w1.runs()[0].tests).toEqual([{ path: A, names: ['d b'] }]);
  });

  it('Run Line maps shifted lines back to the last good parse instead of choosing a neighbour or the file', async () => {
    const { runner, w1, complete } = setup();
    await runner.start();
    const good = "describe('d', () => {\n  test('a', () => {});\n  test('b', () => {});\n});\n";
    runner.docs.update(A, good);
    const broken = good.replace("  test('a'", "  const x = {{;\n  test('a'");
    __state.textDocuments.push(makeDocument(A, broken));
    expect(runner.docs.ensure(A)?.nodes).toEqual([]);
    expect(runner.docs.lookupAtLine(A, 1)).toBeUndefined(); // newly inserted, unparseable line
    expect(runner.docs.lookupAtLine(A, 2)?.line).toBe(1); // a moved from line 2 to 3
    expect(runner.docs.lookupAtLine(A, 3)?.line).toBe(2); // b moved from line 3 to 4

    await runner.runLine(A, 2, 'run');
    await tick();
    expect(w1.runs()[0].tests).toEqual([{ path: A, names: ['d a'] }]);
    complete(w1, w1.runs()[0].runId);
    await tick();
    await runner.runLine(A, 3, 'run');
    await tick();
    expect(w1.runs()[1].tests).toEqual([{ path: A, names: ['d b'] }]);
  });

  it('Run Line does not run the whole file for a line added after the last good parse', async () => {
    const { runner, w1 } = setup();
    await runner.start();
    const good = "test('a', () => {});\n";
    runner.docs.update(A, good);
    __state.textDocuments.push(makeDocument(A, `const x = {{;\n${good}`));
    await runner.runLine(A, 0, 'run');
    await tick();
    expect(w1.runs()).toHaveLength(0);
  });

  it('closing a virtual document with the same fsPath keeps the real document\'s parse', async () => {
    const { runner } = setup();
    await runner.start();
    runner.docs.update(A, TEXT);
    fire('close', { uri: Uri.parse(`git:${A}`) });
    expect(runner.docs.parsed(A)).toBeDefined();
    fire('close', { uri: Uri.file(A) });
    expect(runner.docs.parsed(A)).toBeUndefined();
  });

  it('says why nothing was queued', async () => {
    const { runner, entries } = setup();
    expect((await runner.runFiles([{ path: A }], 'explicit')).notRun).toMatch(/stopped/);
    await runner.start();
    expect((await runner.runFiles([{ path: '/elsewhere/x.test.js' }], 'explicit')).notRun).toMatch(/no Jest project/);
    entries.get(P2).spec = { ...entries.get(P2).spec, status: 'unavailable', reason: 'jest does not resolve; run yarn install' };
    expect((await runner.runFiles([{ path: C }], 'explicit')).notRun).toMatch(/yarn install/);
    expect((await runner.runFiles([{ path: A }], 'explicit')).notRun).toBeUndefined();
  });
});

describe('RunCoordinator worker messages', () => {
  afterEach(() => jest.clearAllMocks());

  it('hands the memory reported with runComplete to the pool', async () => {
    const { runner, pool, w1, complete } = setup();
    await runner.start();
    await runner.runFiles([{ path: A }], 'explicit');
    await tick();
    complete(w1, w1.runs()[0].runId, { memory: { rss: 3e9, heapUsed: 1e9 } });
    await tick();
    expect(pool.release).toHaveBeenCalledWith(w1, { rss: 3e9, heapUsed: 1e9 });
  });

  it('logs CLI-run log messages and shows the blocked inline-snapshot warning', async () => {
    const { runner, log } = setup({ engine: 'cli' });
    let onMessage!: (msg: WorkerToHost) => void;
    let finish!: () => void;
    (cliEngine.runCli as jest.Mock).mockImplementationOnce((opts: any) => {
      onMessage = opts.onMessage;
      return { done: new Promise(r => { finish = () => r({ wasInterrupted: false }); }), cancel: () => undefined };
    });
    await runner.start();
    const h = await runner.runFiles([{ path: A }], 'explicit');
    await tick();
    onMessage({ v: PROTOCOL_VERSION, type: 'log', level: 'warn', text: 'overlay manifest unreadable' } as any);
    onMessage({ v: PROTOCOL_VERSION, type: 'overlayWriteBlocked', path: A } as any);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('overlay manifest unreadable'));
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('a.test.js'));
    finish();
    await h.done;
  });
});
