import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { AcquireAbortedError, WorkerPool, WorkerInitError, WorkerKilledError, type ForkLike } from '../../../src/workerPool';
import { DEFAULT_SETTINGS, type HyperJestSettings } from '../../../src/core/settingsModel';
import { noopLogger } from '../../../src/core/logger';
import { PROTOCOL_VERSION, type ProjectSpec, type WorkerFlags, type HostToWorker } from '../../../src/core/protocol';

/** Fake child process: records sent messages, lets the test emit worker->host messages. */
class FakeChild extends EventEmitter {
  pid = Math.floor(Math.random() * 10000) + 100;
  connected = true;
  sent: HostToWorker[] = [];
  stderr = new EventEmitter();
  stdout = new EventEmitter();
  killed = false;
  send(msg: HostToWorker): boolean { this.sent.push(msg); return true; }
  disconnect(): void { this.connected = false; }
  kill(): boolean { this.killed = true; this.connected = false; setImmediate(() => this.emit('exit', 0, null)); return true; }
  /** Simulate the worker finishing its bootstrap. */
  ready(configs = 1): void {
    this.emit('message', { v: PROTOCOL_VERSION, type: 'ready', jestVersion: '29.7.0', nodeVersion: 'v24.19.0', configs: new Array(configs).fill({}), seams: { envWrapper: true, probeTransformer: true, cachePrune: true }, warnings: [], bootstrapMs: 10 });
  }
}

const spec = (id: string): ProjectSpec => ({
  id, displayName: id, repoRoot: '/r', packageDir: `/r/${id}`, flavor: 'implicit', status: 'ok', nodePath: '/usr/bin/node',
  nodeArgs: [], env: {}, cliFilters: { testPathIgnorePatterns: [] }, e2ePatterns: [], warnings: [], jestPkgDir: '/r/node_modules/jest', jestVersion: '29.7.0',
});
const flags: WorkerFlags = { coverage: true, perTestCoverage: true, liveComments: true, instrumentTestFiles: false, globalSetup: 'once', tsJestDiagnostics: 'keep', trace: false };

function makePool(settings: Partial<HyperJestSettings> = {}, cpuCount = 4) {
  const children: FakeChild[] = [];
  const fork: ForkLike = () => { const c = new FakeChild(); children.push(c); return c as unknown as ChildProcess; };
  const s: HyperJestSettings = { ...DEFAULT_SETTINGS, ...settings };
  const pool = new WorkerPool({ workerEntry: '/ext/dist/worker/hyperjestWorker.cjs', workerAssetsDir: '/ext/dist/worker', getSettings: () => s, log: noopLogger, cpuCount, totalMemoryBytes: 16e9, forkImpl: fork, sweepIntervalMs: 0 });
  return { pool, children, settings: s };
}

const tick = () => new Promise(r => setImmediate(r));

describe('WorkerPool', () => {
  it('spawns a worker with init and resolves acquire after ready', async () => {
    const { pool, children } = makePool();
    pool.registerProject(spec('a'), flags);
    const p = pool.acquire('a');
    await tick();
    expect(children).toHaveLength(1);
    expect(children[0].sent[0]).toMatchObject({ type: 'init', slot: 0, spec: { id: 'a' } });
    children[0].ready();
    const w = await p;
    expect(w.state).toBe('busy');
    expect(pool.stats().busy).toBe(1); // a hot spare may also be starting
  });

  it('starts a hot spare for runs but not for spare:false acquires', async () => {
    const { pool, children } = makePool({ maxWorkersPerProject: 4 });
    pool.registerProject(spec('a'), flags);
    pool.registerProject(spec('b'), flags);
    const pa = pool.acquire('a', { spare: false }); await tick(); children[0].ready();
    await pa; await tick();
    expect(children).toHaveLength(1);
    const pb = pool.acquire('b'); await tick(); children[1].ready();
    await pb; await tick();
    expect(children).toHaveLength(3); // b's worker + b's hot spare
    expect(pool.stats().byProject).toEqual({ a: 1, b: 2 });
  });

  it('reuses an idle worker instead of spawning', async () => {
    const { pool, children } = makePool({ maxWorkersPerProject: 1 });
    pool.registerProject(spec('a'), flags);
    const p1 = pool.acquire('a'); await tick(); children[0].ready();
    const w1 = await p1;
    pool.release(w1, { rss: 100, heapUsed: 50 });
    const w2 = await pool.acquire('a');
    expect(w2).toBe(w1);
    expect(children).toHaveLength(1);
  });

  it('queues when the per-project cap is reached and dispatches on release', async () => {
    const { pool, children } = makePool({ maxWorkersPerProject: 1 });
    pool.registerProject(spec('a'), flags);
    const p1 = pool.acquire('a'); await tick(); children[0].ready();
    const w1 = await p1;
    let resolved = false;
    const p2 = pool.acquire('a').then(w => { resolved = true; return w; });
    await tick();
    expect(resolved).toBe(false);
    expect(children).toHaveLength(1);
    pool.release(w1);
    const w2 = await p2;
    expect(w2).toBe(w1);
  });

  it('rejects acquire with WorkerInitError when bootstrap fails', async () => {
    const { pool, children } = makePool();
    pool.registerProject(spec('a'), flags);
    const p = pool.acquire('a'); await tick();
    children[0].emit('message', { v: PROTOCOL_VERSION, type: 'initError', kind: 'jestNotFound', message: 'no jest' });
    await expect(p).rejects.toBeInstanceOf(WorkerInitError);
  });

  it('replays overlay state to workers spawned later and broadcasts to live ones', async () => {
    const { pool, children } = makePool({ maxWorkersPerProject: 2 });
    pool.registerProject(spec('a'), flags);
    const p1 = pool.acquire('a'); await tick(); children[0].ready(); const w1 = await p1;
    pool.broadcast('a', { v: PROTOCOL_VERSION, type: 'overlay', changes: [{ path: '/r/a/x.ts', text: 'new', version: 2 }] });
    expect(children[0].sent.some(m => m.type === 'overlay')).toBe(true);
    const p2 = pool.acquire('a'); await tick();
    // A hot spare may already have been spawned for the project; use the last starting child.
    const c2 = children[children.length - 1];
    c2.ready();
    await p2;
    const replay = c2.sent.find(m => m.type === 'overlay');
    expect(replay).toMatchObject({ changes: [{ path: '/r/a/x.ts', text: 'new' }] });
    pool.release(w1);
  });

  it('recycles a worker whose RSS exceeds the limit', async () => {
    const { pool, children } = makePool({ workerMemoryLimitMB: 1, maxWorkersPerProject: 1 });
    pool.registerProject(spec('a'), flags);
    const p1 = pool.acquire('a'); await tick(); children[0].ready(); const w1 = await p1;
    pool.release(w1, { rss: 5 * 1024 * 1024, heapUsed: 1 });
    expect(children[0].killed).toBe(true);
    expect(w1.alive).toBe(false);
  });

  it('evicts an idle worker of another project when the pool is full', async () => {
    const { pool, children } = makePool({ maxWorkersPerProject: 1 }, 2); // capacity = max(1, 2-1) = 1
    pool.registerProject(spec('a'), flags);
    pool.registerProject(spec('b'), flags);
    const pa = pool.acquire('a'); await tick(); children[0].ready(); const wa = await pa;
    pool.release(wa);
    const pb = pool.acquire('b'); await tick();
    expect(children[0].killed).toBe(true);
    expect(children).toHaveLength(2);
    children[1].ready();
    const wb = await pb;
    expect(wb.projectId).toBe('b');
  });

  it('killProject rejects pending waiters', async () => {
    const { pool } = makePool();
    pool.registerProject(spec('a'), flags);
    const p = pool.acquire('a'); await tick();
    pool.killProject('a', 'config changed');
    await expect(p).rejects.toThrow(/config changed/);
  });

  it('fails acquire immediately when the node binary cannot be spawned (error without exit)', async () => {
    const { pool, children } = makePool({ maxWorkersPerProject: 1 });
    pool.registerProject(spec('a'), flags);
    const p = pool.acquire('a'); await tick();
    const c = children[0];
    (c as { pid?: number }).pid = undefined;
    c.emit('error', Object.assign(new Error('spawn /nonexistent/node ENOENT'), { code: 'ENOENT' }));
    await expect(p).rejects.toThrow(/spawn failed.*ENOENT/);
    expect(pool.stats().starting).toBe(0);
    // The next request spawns a fresh worker instead of waiting behind the dead one.
    const p2 = pool.acquire('a'); await tick();
    expect(children).toHaveLength(2);
    children[1].ready();
    await expect(p2).resolves.toBeDefined();
  });

  it('rejects a waiter with a real cause when the worker never reports ready', async () => {
    const children: FakeChild[] = [];
    const fork: ForkLike = () => { const c = new FakeChild(); children.push(c); return c as unknown as ChildProcess; };
    const pool = new WorkerPool({ workerEntry: '/w.cjs', workerAssetsDir: '/ext', getSettings: () => ({ ...DEFAULT_SETTINGS, maxWorkersPerProject: 1 }), log: noopLogger, cpuCount: 4, totalMemoryBytes: 16e9, forkImpl: fork, sweepIntervalMs: 0, readyTimeoutMs: 5 });
    pool.registerProject(spec('a'), flags);
    const p = pool.acquire('a');
    await expect(p).rejects.toThrow(/did not report ready within 5 ms/);
    await expect(p).rejects.not.toBeInstanceOf(WorkerKilledError);
  });

  it('a waiter queued right after killProject is served by a new worker, not rejected by the killed one', async () => {
    const { pool, children } = makePool({ maxWorkersPerProject: 1 });
    pool.registerProject(spec('a'), flags);
    const p1 = pool.acquire('a'); await tick();
    pool.killProject('a', 'toolchain changed');
    const p2 = pool.acquire('a'); // same tick as the kill (registry 'invalidated' -> runner re-queues)
    await expect(p1).rejects.toBeInstanceOf(WorkerKilledError);
    await tick();
    expect(children).toHaveLength(2);
    children[1].ready();
    const w = await p2;
    expect(w.state).toBe('busy');
    expect(pool.stats().idle).toBe(0);
  });

  it('an aborted pending acquire is withdrawn and does not take the next free worker', async () => {
    const { pool, children } = makePool({ maxWorkersPerProject: 1 });
    pool.registerProject(spec('a'), flags);
    const p1 = pool.acquire('a'); await tick(); children[0].ready();
    const w1 = await p1;
    const ac = new AbortController();
    const p2 = pool.acquire('a', { signal: ac.signal });
    expect(pool.stats().waiters).toBe(1);
    ac.abort();
    await expect(p2).rejects.toBeInstanceOf(AcquireAbortedError);
    expect(pool.stats().waiters).toBe(0);
    pool.release(w1);
    expect(w1.state).toBe('idle');
    // Already aborted: rejected without queueing; aborting after hand-out is a no-op.
    await expect(pool.acquire('a', { signal: ac.signal })).rejects.toBeInstanceOf(AcquireAbortedError);
    const ac2 = new AbortController();
    const w = await pool.acquire('a', { signal: ac2.signal });
    ac2.abort();
    expect(w).toBe(w1);
    expect(w.state).toBe('busy');
  });

  it('rejects the waiter right away when fork() throws synchronously', async () => {
    let calls = 0;
    const fork: ForkLike = () => { calls++; throw new Error('EAGAIN'); };
    const pool = new WorkerPool({ workerEntry: '/w.cjs', workerAssetsDir: '/ext', getSettings: () => DEFAULT_SETTINGS, log: noopLogger, cpuCount: 4, totalMemoryBytes: 16e9, forkImpl: fork, sweepIntervalMs: 0 });
    pool.registerProject(spec('a'), flags);
    const settled = await Promise.race([pool.acquire('a').then(() => 'resolved', (e: Error) => e.message), tick().then(() => 'pending')]);
    expect(settled).toMatch(/worker spawn failed for a: EAGAIN/);
    expect(pool.stats().waiters).toBe(0);
    expect(calls).toBe(1);
  });
});
