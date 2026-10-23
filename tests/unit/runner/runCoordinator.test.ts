/**
 * RunCoordinator queue / run-group lifecycle: cancel and settle semantics, merging and supersession,
 * queued-status bookkeeping, stopped gating, CLI start failures and the warm-run watchdog.
 * The pool, registry and CLI engine are fakes; the ResultStore is real.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
jest.mock('vscode', () => {
  const fake = jest.requireActual('../results/fakeVscode');
  const noEvent = () => ({ dispose() { /* noop */ } });
  return {
    ...fake,
    workspace: {
      ...fake.workspace,
      onDidChangeTextDocument: noEvent, onDidSaveTextDocument: noEvent, onDidOpenTextDocument: noEvent, onDidCloseTextDocument: noEvent,
      onDidCreateFiles: noEvent, onDidDeleteFiles: noEvent, onDidRenameFiles: noEvent,
    },
    window: { ...fake.window, onDidChangeActiveTextEditor: noEvent, showWarningMessage: async () => undefined },
  };
});
jest.mock('../../../src/cliEngine', () => ({ runCli: jest.fn(), findRelatedTests: jest.fn(async () => []) }));
jest.mock('../../../src/debug', () => ({ startDebugSession: jest.fn(async () => undefined) }));

import { RunCoordinator } from '../../../src/runner';
import { ResultStore } from '../../../src/results/resultStore';
import { DEFAULT_SETTINGS, type HyperJestSettings } from '../../../src/core/settingsModel';
import { noopLogger } from '../../../src/core/logger';
import { PROTOCOL_VERSION, type HostToWorker, type ProjectSpec, type RunMsg, type WorkerToHost } from '../../../src/core/protocol';
import type { RunOutcome } from '../../../src/runnerApi';
import * as cliEngine from '../../../src/cliEngine';

const PID = 'p1';
const A = '/repo/pkg/a.test.js';
const B = '/repo/pkg/b.test.js';

const spec = { id: PID, displayName: 'pkg', status: 'ok' } as unknown as ProjectSpec;

class FakeWorker {
  readonly projectId = PID;
  readonly info = { id: 1, ready: {} };
  readonly sent: HostToWorker[] = [];
  killed: string | undefined;
  send(msg: HostToWorker): boolean { this.sent.push(msg); return true; }
  kill(reason: string): void { this.killed = reason; }
  runs(): RunMsg[] { return this.sent.filter((m): m is RunMsg => m.type === 'run'); }
}

function setup(overrides: Partial<HyperJestSettings> = {}) {
  const settings: HyperJestSettings = { ...DEFAULT_SETTINGS, smartStart: 'never', engine: 'warm' as any, ...overrides };
  let poolListener: (e: any) => void = () => undefined;
  const worker = new FakeWorker();
  const pool = {
    on: (l: (e: any) => void) => { poolListener = l; return () => undefined; },
    acquire: jest.fn(async () => worker),
    release: jest.fn(),
    capacity: () => 1,
    killProject: jest.fn(),
    broadcast: jest.fn(),
  };
  const entry = { spec };
  const registry = {
    onDidChange: () => ({ dispose() { /* noop */ } }),
    projectIdFor: (p: string) => (p.startsWith('/repo/pkg/') ? PID : undefined),
    get: (id: string) => (id === PID ? entry : undefined),
    projectFor: () => entry,
    projectsFor: (p: string) => p.startsWith('/repo/pkg/') ? [entry] : [],
    resolveMatchers: async () => undefined,
    acceptsTest: () => true,
    monitorsSource: () => true,
    all: () => [{ spec }],
    refresh: async () => undefined,
    setAutoBoot: jest.fn(),
    noteReady: () => undefined,
    isTestFile: () => true,
    testFilesOf: async () => [A, B],
    toolchainFiles: () => [],
  };
  const store = new ResultStore();
  const runner = new RunCoordinator(pool as any, registry as any, store, () => settings, '/ext/dist/worker', noopLogger);
  const send = (msg: WorkerToHost) => poolListener({ type: 'message', worker, msg });
  const complete = (runId: string, wasInterrupted = false) =>
    send({ v: PROTOCOL_VERSION, type: 'runComplete', runId, wasInterrupted, durationMs: 1, memory: { rss: 0, heapUsed: 0 } } as WorkerToHost);
  return { runner, store, pool, registry, worker, settings, complete };
}

const tick = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
/** Resolves to the outcome, or 'pending' when `done` has not settled after a few turns. */
async function peek(done: Promise<RunOutcome>): Promise<RunOutcome | 'pending'> {
  return Promise.race([done, tick().then(() => 'pending' as const)]);
}

describe('RunCoordinator run groups', () => {
  afterEach(() => jest.clearAllMocks());

  it('cancel(runId) of queued files settles the group and un-queues the files', async () => {
    const { runner, store, pool } = setup();
    await runner.start();
    runner.pause();
    const h = await runner.runFiles([{ path: A }, { path: B }], 'explicit');
    expect(store.summary().queued).toBe(2);
    runner.cancel(h.runId);
    expect(await peek(h.done)).toEqual({ wasInterrupted: true, error: undefined });
    expect(store.summary().queued).toBe(0);
    expect(store.fileRecord(A)?.status).not.toBe('queued');
    runner.resume();
    await tick();
    expect(pool.acquire).not.toHaveBeenCalled();
  });

  it('merging a request into a queued item keeps every group waiting for the run', async () => {
    const { runner, worker, complete } = setup();
    await runner.start();
    runner.pause();
    const explicit = await runner.runFiles([{ path: A }], 'explicit');
    const onType = await runner.runFiles([{ path: A, names: ['x'] }], 'onType');
    expect(await peek(explicit.done)).toBe('pending');
    runner.resume();
    await tick();
    expect(worker.runs()).toHaveLength(1);
    expect(worker.runs()[0]).toMatchObject({ tests: [{ path: A }], priority: 0 });
    expect(worker.runs()[0].tests[0].names).toBeUndefined();
    complete(worker.runs()[0].runId);
    expect(await peek(explicit.done)).toEqual({ wasInterrupted: false, error: undefined });
    expect(await peek(onType.done)).toEqual({ wasInterrupted: false, error: undefined });
  });

  it('duplicate paths in one group wait for the merged run', async () => {
    const { runner, worker, complete } = setup();
    await runner.start();
    runner.pause();
    const h = await runner.runFiles([{ path: A, names: ['x'] }, { path: A, names: ['y'] }], 'explicit');
    expect(await peek(h.done)).toBe('pending');
    runner.resume();
    await tick();
    expect(worker.runs()[0].tests).toEqual([{ path: A, names: ['x', 'y'] }]);
    complete(worker.runs()[0].runId);
    expect(await peek(h.done)).toEqual({ wasInterrupted: false, error: undefined });
  });

  it('cancelling one group of a merged item leaves the run to the other group', async () => {
    const { runner, worker, complete } = setup();
    await runner.start();
    runner.pause();
    const first = await runner.runFiles([{ path: A }], 'explicit');
    const second = await runner.runFiles([{ path: A }], 'explicit');
    runner.cancel(first.runId);
    expect(await peek(first.done)).toEqual({ wasInterrupted: true, error: undefined });
    runner.resume();
    await tick();
    expect(worker.runs()).toHaveLength(1);
    complete(worker.runs()[0].runId);
    expect(await peek(second.done)).toEqual({ wasInterrupted: false, error: undefined });
  });

  it('automatic requests merge into one pending rerun without cancelling the active run', async () => {
    const { runner, store, worker, complete } = setup();
    await runner.start();
    const first = await runner.runFiles([{ path: A, names: ['x'] }], 'onType');
    await tick();
    expect(worker.runs()).toHaveLength(1);
    const r1 = worker.runs()[0].runId;
    const second = await runner.runFiles([{ path: A, names: ['y'] }], 'onType');
    const third = await runner.runFiles([{ path: A, names: ['z'] }], 'onType');
    expect(worker.sent.some(m => m.type === 'cancel')).toBe(false);
    complete(r1);
    await tick();
    expect(worker.runs()).toHaveLength(2);
    expect(worker.runs()[1].tests).toEqual([{ path: A, names: ['y', 'z'] }]);
    expect(await peek(first.done)).toEqual({ wasInterrupted: false, error: undefined });
    complete(worker.runs()[1].runId);
    expect(await peek(first.done)).toEqual({ wasInterrupted: false, error: undefined });
    expect(await peek(second.done)).toEqual({ wasInterrupted: false, error: undefined });
    expect(await peek(third.done)).toEqual({ wasInterrupted: false, error: undefined });
    expect(store.summary().queued).toBe(0);
  });

  it("cancel('all') keeps the stale marks of queued files", async () => {
    const { runner, store } = setup();
    await runner.start();
    runner.pause();
    const h = await runner.runFiles([{ path: A }], 'onType');
    store.markStale(A);
    runner.cancel('all');
    expect(await peek(h.done)).toEqual({ wasInterrupted: true, error: undefined });
    expect(store.fileRecord(A)?.stale).toBe(true);
    expect(store.summary().queued).toBe(0);
  });

  it('a run cancelled while waiting for a worker does not stay queued', async () => {
    const { runner, store, pool } = setup();
    let release!: () => void;
    const worker = new FakeWorker();
    pool.acquire.mockImplementationOnce(() => new Promise(r => { release = () => r(worker); }) as any);
    await runner.start();
    const h = await runner.runFiles([{ path: A }], 'explicit');
    await tick();
    expect(store.fileRecord(A)?.status).toBe('queued');
    runner.cancel(h.runId);
    expect((await h.done).wasInterrupted).toBe(true);
    release();
    await tick();
    expect(store.summary().queued).toBe(0);
    expect(worker.runs()).toHaveLength(0);
  });

  it('cancelling a run that waits for a worker withdraws the pool request and restores the file status', async () => {
    const { runner, store, pool } = setup();
    store.markRunning(A, { runId: 'prev', projectId: PID });
    store.apply({ v: PROTOCOL_VERSION, type: 'fileResult', runId: 'prev', path: A, status: 'passed', numPassing: 1, numFailing: 0, numPending: 0, numTodo: 0 } as WorkerToHost, PID);
    expect(store.fileRecord(A)?.status).toBe('passed');
    let signal: AbortSignal | undefined;
    pool.acquire.mockImplementationOnce(((_id: string, opts: { signal?: AbortSignal }) => { signal = opts.signal; return new Promise(() => undefined); }) as any);
    await runner.start();
    const h = await runner.runFiles([{ path: A }], 'explicit');
    await tick();
    expect(signal?.aborted).toBe(false);
    runner.cancel(h.runId);
    expect((await h.done).wasInterrupted).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(store.fileRecord(A)?.status).toBe('passed');
  });

  it('a CLI run that throws while starting fails the run and frees the file', async () => {
    const { runner, store, worker, complete, settings } = setup({ engine: 'cli' });
    (cliEngine.runCli as jest.Mock).mockImplementationOnce(() => { throw new Error('EACCES: tmp'); });
    await runner.start();
    const h = await runner.runFiles([{ path: A }], 'explicit');
    const outcome = await h.done;
    expect(outcome.error).toMatch(/EACCES: tmp/);
    expect(runner.getState().activeRuns).toBe(0);
    expect(store.fileRecord(A)?.status).not.toBe('running');
    // The file is not pinned: the next run dispatches (warm engine this time).
    settings.engine = 'warm' as any;
    const again = await runner.runFiles([{ path: A }], 'explicit');
    await tick();
    expect(worker.runs()).toHaveLength(1);
    complete(worker.runs()[0].runId);
    expect((await again.done).error).toBeUndefined();
  });

  it('runs nothing while stopped and reports why', async () => {
    const { runner, pool } = setup();
    const h = await runner.runFiles([{ path: A }], 'explicit');
    expect((await h.done).error).toMatch(/stopped/);
    await runner.start();
    runner.stop();
    const h2 = await runner.runFiles([{ path: A }], 'explicit');
    expect((await h2.done).error).toMatch(/stopped/);
    await tick();
    expect(pool.acquire).not.toHaveBeenCalled();
    expect(runner.getState().queuedFiles).toBe(0);
  });

  it('start/stop drive the registry gate for implicit worker boots', async () => {
    const { runner, registry, pool } = setup();
    await runner.start();
    expect(registry.setAutoBoot).toHaveBeenLastCalledWith(true);
    // The gate closes before the projects are killed (a lookup racing the kill must not re-boot).
    pool.killProject.mockImplementationOnce(() => { expect(registry.setAutoBoot).toHaveBeenLastCalledWith(false); });
    runner.stop();
    expect(registry.setAutoBoot).toHaveBeenLastCalledWith(false);
    expect(pool.killProject).toHaveBeenCalled();
  });

  it('a request with nothing runnable does not report an unrelated earlier error', async () => {
    const { runner } = setup({ engine: 'cli' });
    (cliEngine.runCli as jest.Mock).mockImplementationOnce(() => { throw new Error('earlier failure'); });
    await runner.start();
    await (await runner.runFiles([{ path: A }], 'explicit')).done;
    expect(runner.getState().lastError).toMatch(/earlier failure/);
    expect(await (await runner.runFailing()).done).toEqual({ wasInterrupted: false, error: undefined });
    expect((await (await runner.runFiles([{ path: '/elsewhere/x.test.js' }], 'explicit')).done).error).toMatch(/no Jest project/);
  });

  it('kills the worker and ends the run as interrupted when runComplete never arrives', async () => {
    const { runner, store, worker, pool } = setup({ runTimeoutMs: 30 });
    await runner.start();
    const h = await runner.runFiles([{ path: A }], 'explicit');
    const outcome = await h.done;
    expect(outcome.wasInterrupted).toBe(true);
    expect(outcome.error).toMatch(/timed out after 30 ms/);
    expect(worker.killed).toBe('run timeout');
    expect(pool.release).toHaveBeenCalledWith(worker, undefined);
    expect(store.fileRecord(A)?.status).not.toBe('running');
    expect(runner.getState().activeRuns).toBe(0);
  });

  it('a run that completes in time clears its watchdog', async () => {
    const { runner, worker, complete } = setup({ runTimeoutMs: 30 });
    await runner.start();
    const h = await runner.runFiles([{ path: A }], 'explicit');
    await tick();
    complete(worker.runs()[0].runId);
    expect((await h.done).wasInterrupted).toBe(false);
    await new Promise(r => setTimeout(r, 60));
    expect(worker.killed).toBeUndefined();
  });
});
