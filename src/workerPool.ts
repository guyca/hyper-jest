/**
 * Multi-core worker pool. Spawns long-lived HyperJest worker processes (dist/worker/hyperjestWorker.cjs)
 * with the PROJECT's node binary, cwd = package dir, JSON IPC. The pool knows nothing about Jest or
 * VS Code: it hands out ready, idle workers per project, replays project state (overlay) to new
 * workers, enforces capacity (cpus-1, per-project cap, memory budget), recycles unhealthy or tired
 * workers, keeps one hot spare per active project, and emits every worker message to the runner.
 *
 * No 'vscode' import: unit-tested with a fake fork.
 */
import { fork as nodeFork, type ChildProcess, type ForkOptions } from 'child_process';
import * as os from 'os';
import * as crypto from 'crypto';
import { buildChildEnv } from './core/childEnv';
import type { Logger } from './core/logger';
import type { HyperJestSettings } from './core/settingsModel';
import {
  PROTOCOL_VERSION,
  type HostToWorker, type InitErrorMsg, type InitMsg, type OverlayChange, type ProjectSpec, type ReadyMsg,
  type WorkerFlags, type WorkerToHost,
} from './core/protocol';

export type WorkerState = 'starting' | 'idle' | 'busy' | 'dead';

export interface WorkerInfo {
  id: number;
  projectId: string;
  slot: number;
  state: WorkerState;
  pid?: number;
  runs: number;
  rss: number;
  heapUsed: number;
  startedAt: number;
  lastUsed: number;
  ready?: ReadyMsg;
}

export type PoolEvent =
  | { type: 'spawned'; worker: WorkerHandle }
  | { type: 'ready'; worker: WorkerHandle; msg: ReadyMsg }
  | { type: 'initError'; worker: WorkerHandle; msg: InitErrorMsg }
  | { type: 'message'; worker: WorkerHandle; msg: WorkerToHost }
  | { type: 'exit'; worker: WorkerHandle; code: number | null; signal: NodeJS.Signals | null; reason: string }
  | { type: 'stderr'; worker: WorkerHandle; text: string };

export interface ForkLike {
  (modulePath: string, args: readonly string[], options: ForkOptions): ChildProcess;
}

export interface PoolOptions {
  /** Absolute path of dist/worker/hyperjestWorker.cjs */
  workerEntry: string;
  /** Absolute path of dist/worker (reporter/preload live here). */
  workerAssetsDir: string;
  getSettings: () => HyperJestSettings;
  log: Logger;
  cpuCount?: number;
  totalMemoryBytes?: number;
  forkImpl?: ForkLike;
  now?: () => number;
  /** Interval for ping/idle sweeps (ms). 0 disables timers (tests). */
  sweepIntervalMs?: number;
  /** How long a worker may take from fork to `ready` before it is killed. */
  readyTimeoutMs?: number;
}

export class WorkerInitError extends Error {
  constructor(readonly msg: InitErrorMsg) {
    super(`${msg.kind}: ${msg.message}`);
    this.name = 'WorkerInitError';
  }
}

/** A pending `acquire` was withdrawn through its `signal` before a worker was handed out. */
export class AcquireAbortedError extends Error {
  constructor() {
    super('worker request withdrawn');
    this.name = 'AcquireAbortedError';
  }
}

/** The subset of AbortSignal that `acquire` uses (a real AbortSignal fits). */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

/**
 * The pool (or a caller) deliberately stopped a worker or a project's pending requests: killProject,
 * shutdown, kill before ready. Not a bootstrap failure, so it must not be reported as an init error.
 */
export class WorkerKilledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerKilledError';
  }
}

interface ProjectState {
  spec: ProjectSpec;
  flags: WorkerFlags;
  overlay: Map<string, OverlayChange>;
  lastActivity: number;
  nextSlot: number;
}

interface Waiter {
  projectId: string;
  priority: number;
  seq: number;
  affinityKey?: string;
  /** False: do not start a hot spare for this request (config-learning boots, Show Resolved Config). */
  spare: boolean;
  resolve: (w: WorkerHandle) => void;
  reject: (e: Error) => void;
}

let nextWorkerId = 1;

/** A live worker process. Obtained from WorkerPool.acquire(); must be released or killed. */
export class WorkerHandle {
  readonly info: WorkerInfo;
  private readonly child: ChildProcess;
  private readyResolve?: (m: ReadyMsg) => void;
  private readyReject?: (e: Error) => void;
  readonly readyPromise: Promise<ReadyMsg>;
  private killed = false;

  constructor(
    readonly projectId: string,
    slot: number,
    child: ChildProcess,
    private readonly pool: WorkerPool,
    now: number,
  ) {
    this.child = child;
    this.info = {
      id: nextWorkerId++, projectId, slot, state: 'starting', pid: child.pid, runs: 0, rss: 0, heapUsed: 0,
      startedAt: now, lastUsed: now,
    };
    this.readyPromise = new Promise<ReadyMsg>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // Avoid unhandled rejections when nobody awaits readiness (e.g. hot spares).
    this.readyPromise.catch(() => undefined);
  }

  get state(): WorkerState { return this.info.state; }
  get pid(): number | undefined { return this.child.pid; }
  get alive(): boolean { return !this.killed && this.info.state !== 'dead'; }

  /** Sends a protocol message; returns false if the channel is gone. */
  send(msg: HostToWorker): boolean {
    if (!this.alive || !this.child.connected) return false;
    try {
      this.child.send(msg);
      return true;
    } catch (e) {
      this.pool['log'].warn(`worker ${this.info.id}: send failed: ${(e as Error).message}`);
      return false;
    }
  }

  /** Terminates the process (SIGTERM, then SIGKILL after 2 s). */
  kill(reason: string): void {
    if (this.killed) return;
    this.killed = true;
    this.pool['log'].debug(`worker ${this.info.id} (${this.projectId}): kill (${reason})`);
    this.readyReject?.(new WorkerKilledError(`worker killed before ready: ${reason}`));
    try {
      if (this.child.connected) this.child.disconnect();
    } catch { /* ignore */ }
    try { this.child.kill('SIGTERM'); } catch { /* ignore */ }
    const t = setTimeout(() => { try { this.child.kill('SIGKILL'); } catch { /* ignore */ } }, 2000);
    t.unref?.();
  }

  /** @internal */
  _onReady(msg: ReadyMsg): void {
    this.info.ready = msg;
    if (this.info.state === 'starting') this.info.state = 'idle';
    this.readyResolve?.(msg);
  }
  /** @internal */
  _onInitError(msg: InitErrorMsg): void {
    this.readyReject?.(new WorkerInitError(msg));
  }
  /** @internal Bootstrap failed for a reason other than an `initError` message (spawn error, ready timeout). */
  _onBootFailure(err: Error): void {
    this.readyReject?.(err);
  }
  /** @internal */
  _onExit(): void {
    this.info.state = 'dead';
    this.readyReject?.(new Error('worker exited before ready'));
  }
  /** @internal */
  _setState(s: WorkerState): void { this.info.state = s; }
}

export class WorkerPool {
  private readonly workers = new Map<number, WorkerHandle>();
  private readonly projects = new Map<string, ProjectState>();
  private readonly waiters: Waiter[] = [];
  private readonly listeners = new Set<(e: PoolEvent) => void>();
  private readonly fork: ForkLike;
  private readonly now: () => number;
  private readonly log: Logger;
  private sweepTimer?: NodeJS.Timeout;
  private waiterSeq = 0;
  private disposed = false;
  /** Message of the last synchronous fork() failure (reported to the waiter that asked for the worker). */
  private lastSpawnError: string | undefined;

  constructor(private readonly opts: PoolOptions) {
    this.fork = opts.forkImpl ?? (nodeFork as unknown as ForkLike);
    this.now = opts.now ?? Date.now;
    this.log = opts.log;
    const interval = opts.sweepIntervalMs ?? 15000;
    if (interval > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), interval);
      this.sweepTimer.unref?.();
    }
  }

  // ------------------------------------------------------------------ public API

  on(listener: (e: PoolEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Total worker capacity: `hyperjest.maxWorkers` or max(1, cpus - 1). */
  capacity(): number {
    const s = this.opts.getSettings();
    const cpus = this.opts.cpuCount ?? os.cpus().length;
    return s.maxWorkers > 0 ? s.maxWorkers : Math.max(1, cpus - 1);
  }

  /** Registers (or refreshes) the project's spec/flags used for new workers. */
  registerProject(spec: ProjectSpec, flags: WorkerFlags): void {
    const existing = this.projects.get(spec.id);
    if (existing) {
      const changed = JSON.stringify(existing.spec) !== JSON.stringify(spec) || JSON.stringify(existing.flags) !== JSON.stringify(flags);
      existing.spec = spec;
      existing.flags = flags;
      if (changed) this.killProject(spec.id, 'project spec changed');
    } else {
      this.projects.set(spec.id, { spec, flags, overlay: new Map(), lastActivity: this.now(), nextSlot: 0 });
    }
  }

  /**
   * Resolves with a ready, idle worker for the project (marked busy). Spawns when capacity allows,
   * evicts idle workers of other projects when the pool is full, otherwise waits (priority FIFO).
   * Rejects with WorkerInitError when the worker cannot bootstrap Jest for this project. Aborting
   * `signal` while the request still waits withdraws it (rejects with AcquireAbortedError) so no worker
   * is handed to a caller that no longer needs one.
   */
  acquire(projectId: string, opts: { priority?: number; affinityKey?: string; signal?: AbortSignalLike; spare?: boolean } = {}): Promise<WorkerHandle> {
    const ps = this.projects.get(projectId);
    if (!ps) return Promise.reject(new Error(`project ${projectId} not registered`));
    const { signal } = opts;
    if (signal?.aborted) return Promise.reject(new AcquireAbortedError());
    ps.lastActivity = this.now();
    return new Promise<WorkerHandle>((resolve, reject) => {
      let waiter: Waiter;
      const onAbort = () => {
        if (!this.waiters.includes(waiter)) return; // already handed out or rejected
        this.removeWaiter(waiter);
        reject(new AcquireAbortedError());
      };
      const settle = <T>(fn: (v: T) => void) => (v: T) => { signal?.removeEventListener('abort', onAbort); fn(v); };
      waiter = { projectId, priority: opts.priority ?? 5, seq: this.waiterSeq++, affinityKey: opts.affinityKey, spare: opts.spare !== false, resolve: settle(resolve), reject: settle(reject) };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
      this.waiters.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      this.dispatch();
    });
  }

  /** Returns a worker to the idle set (or recycles it when it is tired/oversized). */
  release(worker: WorkerHandle, runMemory?: { rss: number; heapUsed: number }): void {
    if (!worker.alive) { this.dispatch(); return; }
    const s = this.opts.getSettings();
    worker.info.runs++;
    worker.info.lastUsed = this.now();
    if (runMemory) { worker.info.rss = runMemory.rss; worker.info.heapUsed = runMemory.heapUsed; }
    const limitBytes = s.workerMemoryLimitMB * 1024 * 1024;
    if (limitBytes > 0 && worker.info.rss > limitBytes) {
      this.recycle(worker, `rss ${(worker.info.rss / 1048576).toFixed(0)} MB > limit ${s.workerMemoryLimitMB} MB`);
    } else if (s.workerRecycleAfterRuns > 0 && worker.info.runs >= s.workerRecycleAfterRuns) {
      this.recycle(worker, `${worker.info.runs} runs`);
    } else {
      worker._setState('idle');
    }
    this.dispatch();
  }

  /**
   * Sends a message to every live worker of the project. Overlay changes are also recorded so that
   * workers spawned later start with the same unsaved-buffer state.
   */
  broadcast(projectId: string, msg: HostToWorker): void {
    const ps = this.projects.get(projectId);
    if (ps && msg.type === 'overlay') {
      for (const c of msg.changes) {
        if (c.text === null) ps.overlay.delete(c.path);
        else ps.overlay.set(c.path, c);
      }
    }
    for (const w of this.workersOf(projectId)) {
      if (w.state === 'starting') continue; // replayed from project state after `ready`
      w.send(msg);
    }
  }

  /** Current overlay state of a project (for the CLI engine / debug launches). */
  overlayOf(projectId: string): OverlayChange[] {
    return [...(this.projects.get(projectId)?.overlay.values() ?? [])];
  }

  workersOf(projectId: string): WorkerHandle[] {
    return [...this.workers.values()].filter(w => w.projectId === projectId && w.alive);
  }

  /** Kills every worker of a project (config change, restart). Pending waiters are rejected. */
  killProject(projectId: string, reason: string): void {
    for (const w of this.workersOf(projectId)) this.terminate(w, reason);
    for (const wt of this.waiters.filter(w => w.projectId === projectId)) {
      wt.reject(new WorkerKilledError(`project workers killed: ${reason}`));
    }
    this.waiters.splice(0, this.waiters.length, ...this.waiters.filter(w => w.projectId !== projectId));
  }

  /** Spawns one idle worker for the project if none is idle and capacity allows (hot spare). */
  ensureSpare(projectId: string): void {
    const s = this.opts.getSettings();
    if (s.maxWorkersPerProject <= 1) return;
    const ws = this.workersOf(projectId);
    if (ws.some(w => w.state === 'idle' || w.state === 'starting')) return;
    if (!this.hasCapacity(projectId, false)) return;
    this.spawn(projectId);
  }

  stats(): { capacity: number; live: number; busy: number; idle: number; starting: number; rssBytes: number; waiters: number; byProject: Record<string, number> } {
    const live = [...this.workers.values()].filter(w => w.alive);
    const byProject: Record<string, number> = {};
    for (const w of live) byProject[w.projectId] = (byProject[w.projectId] ?? 0) + 1;
    return {
      capacity: this.capacity(),
      live: live.length,
      busy: live.filter(w => w.state === 'busy').length,
      idle: live.filter(w => w.state === 'idle').length,
      starting: live.filter(w => w.state === 'starting').length,
      rssBytes: live.reduce((a, w) => a + w.info.rss, 0),
      waiters: this.waiters.length,
      byProject,
    };
  }

  /** Graceful shutdown: `shutdown` to every worker, SIGKILL after the grace period. */
  shutdownAll(): void {
    this.disposed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const w of [...this.workers.values()]) {
      w.send({ v: PROTOCOL_VERSION, type: 'shutdown' });
      w.kill('shutdown');
    }
    for (const wt of this.waiters) wt.reject(new WorkerKilledError('pool shut down'));
    this.waiters.length = 0;
  }

  // ------------------------------------------------------------------ internals

  private emit(e: PoolEvent): void {
    for (const l of this.listeners) {
      try { l(e); } catch (err) { this.log.error(err as Error); }
    }
  }

  private memoryBudgetBytes(): number {
    const s = this.opts.getSettings();
    if (s.memoryBudgetMB > 0) return s.memoryBudgetMB * 1024 * 1024;
    return Math.floor((this.opts.totalMemoryBytes ?? os.totalmem()) / 2);
  }

  /** Can one more worker be added for the project (optionally after evicting idle workers elsewhere)? */
  private hasCapacity(projectId: string, allowEvict: boolean): boolean {
    const s = this.opts.getSettings();
    const live = [...this.workers.values()].filter(w => w.alive);
    const projectLive = live.filter(w => w.projectId === projectId).length;
    if (projectLive >= Math.max(1, s.maxWorkersPerProject)) return false;
    const rss = live.reduce((a, w) => a + w.info.rss, 0);
    const avg = live.length ? rss / live.length : 300 * 1024 * 1024;
    const memoryOk = rss + avg <= this.memoryBudgetBytes() || live.length === 0;
    if (live.length < this.capacity() && memoryOk) return true;
    if (!allowEvict) return false;
    // Evict the least recently used idle worker of ANOTHER project to make room.
    const victim = live
      .filter(w => w.projectId !== projectId && w.state === 'idle')
      .sort((a, b) => a.info.lastUsed - b.info.lastUsed)[0];
    if (victim) {
      this.terminate(victim, 'evicted (pool full)');
      return true;
    }
    return false;
  }

  private dispatch(): void {
    if (this.disposed) return;
    for (const wt of [...this.waiters]) {
      const idle = this.pickIdle(wt.projectId, wt.affinityKey);
      if (idle) {
        this.removeWaiter(wt);
        idle._setState('busy');
        idle.info.lastUsed = this.now();
        wt.resolve(idle);
        if (wt.spare) this.ensureSpare(wt.projectId);
        continue;
      }
      const starting = this.workersOf(wt.projectId).filter(w => w.state === 'starting');
      const pendingForProject = this.waiters.filter(w => w.projectId === wt.projectId).length;
      if (starting.length >= pendingForProject) continue; // a worker is already on its way
      if (this.hasCapacity(wt.projectId, true)) {
        const w = this.spawn(wt.projectId);
        if (!w) {
          // fork() threw (or the project is gone): no worker will come for this request, fail it now
          // instead of leaving it queued until some later dispatch.
          this.removeWaiter(wt);
          wt.reject(new Error(this.lastSpawnError ?? `could not start a worker for ${wt.projectId}`));
          continue;
        }
        w.readyPromise.then(() => this.dispatch(), err => {
          // A deliberate kill (killProject / shutdown) already settled the waiters it concerns; a waiter
          // queued after it (same tick) belongs to a newer worker and must not inherit this rejection.
          if (!(err instanceof WorkerKilledError)) {
            // Bootstrap failed: fail the oldest waiter of this project with the real cause.
            const victimWaiter = this.waiters.find(x => x.projectId === wt.projectId);
            if (victimWaiter) { this.removeWaiter(victimWaiter); victimWaiter.reject(err as Error); }
          }
          this.dispatch();
        });
      }
    }
  }

  private removeWaiter(wt: Waiter): void {
    const i = this.waiters.indexOf(wt);
    if (i >= 0) this.waiters.splice(i, 1);
  }

  private pickIdle(projectId: string, affinityKey?: string): WorkerHandle | undefined {
    const idle = this.workersOf(projectId).filter(w => w.state === 'idle').sort((a, b) => a.info.slot - b.info.slot);
    if (!idle.length) return undefined;
    if (affinityKey) {
      const all = this.workersOf(projectId).sort((a, b) => a.info.slot - b.info.slot);
      const h = crypto.createHash('sha1').update(affinityKey).digest();
      const preferred = all[h.readUInt32BE(0) % all.length];
      if (preferred?.state === 'idle') return preferred;
    }
    return idle[0];
  }

  private spawn(projectId: string): WorkerHandle | undefined {
    const ps = this.projects.get(projectId);
    this.lastSpawnError = undefined;
    if (!ps || this.disposed) return undefined;
    const s = this.opts.getSettings();
    const spec = ps.spec;
    const nodePath = spec.nodePath || process.execPath;
    const electronAsNode = nodePath === process.execPath && !!process.versions.electron;
    const env = buildChildEnv({
      base: process.env, nodePath, projectEnv: spec.env, userEnv: s.env, electronAsNode,
      extra: { HYPERJEST_WORKER: '1', HYPERJEST_PROJECT_ID: spec.id },
    });
    const slot = ps.nextSlot++;
    let child: ChildProcess;
    try {
      child = this.fork(this.opts.workerEntry, [], {
        cwd: spec.packageDir,
        execPath: nodePath,
        execArgv: [...spec.nodeArgs, ...s.nodeArgs],
        env,
        serialization: 'json',
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      } as ForkOptions);
    } catch (e) {
      this.lastSpawnError = `worker spawn failed for ${spec.displayName}: ${(e as Error).message}`;
      this.log.error(this.lastSpawnError);
      return undefined;
    }
    const w = new WorkerHandle(projectId, slot, child, this, this.now());
    this.workers.set(w.info.id, w);
    this.log.info(`worker ${w.info.id} spawned for ${spec.displayName} (slot ${slot}, pid ${child.pid}, node ${spec.nodeVersion ?? '?'})`);
    this.emit({ type: 'spawned', worker: w });

    const readyTimeoutMs = this.opts.readyTimeoutMs ?? 120000;
    const readyTimeout = setTimeout(() => {
      if (w.state !== 'starting') return;
      w._onBootFailure(new Error(`worker did not report ready within ${readyTimeoutMs} ms`));
      this.terminate(w, `no ready after ${readyTimeoutMs} ms`);
    }, readyTimeoutMs);
    readyTimeout.unref?.();

    let stderrBuf = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderrBuf += d.toString();
      let i: number;
      while ((i = stderrBuf.indexOf('\n')) >= 0) {
        const line = stderrBuf.slice(0, i); stderrBuf = stderrBuf.slice(i + 1);
        if (line.trim()) { this.log.debug(`[worker ${w.info.id}] ${line}`); this.emit({ type: 'stderr', worker: w, text: line }); }
      }
    });
    child.stdout?.on('data', (d: Buffer) => this.log.trace(`[worker ${w.info.id} stdout] ${d.toString().trimEnd()}`));

    child.on('message', (raw: unknown) => {
      const msg = raw as WorkerToHost;
      if (!msg || typeof msg !== 'object' || !('type' in msg)) return;
      if ((msg as { v?: number }).v !== undefined && (msg as { v: number }).v !== PROTOCOL_VERSION) {
        this.log.warn(`worker ${w.info.id}: protocol version mismatch (${(msg as { v: number }).v} != ${PROTOCOL_VERSION})`);
      }
      switch (msg.type) {
        case 'ready':
          clearTimeout(readyTimeout);
          w._onReady(msg);
          // Replay unsaved-buffer state so this worker sees the same files as its siblings.
          if (ps.overlay.size) w.send({ v: PROTOCOL_VERSION, type: 'overlay', changes: [...ps.overlay.values()] });
          this.log.info(`worker ${w.info.id} ready: jest ${msg.jestVersion}, node ${msg.nodeVersion}, ${msg.configs.length} config(s), ${msg.bootstrapMs} ms`);
          this.emit({ type: 'ready', worker: w, msg });
          this.dispatch();
          break;
        case 'initError':
          clearTimeout(readyTimeout);
          this.log.warn(`worker ${w.info.id} init error (${msg.kind}): ${msg.message}`);
          w._onInitError(msg);
          this.emit({ type: 'initError', worker: w, msg });
          this.terminate(w, `init error: ${msg.kind}`);
          break;
        case 'pong':
          w.info.rss = msg.rss; w.info.heapUsed = msg.heapUsed;
          break;
        default:
          break;
      }
      this.emit({ type: 'message', worker: w, msg });
    });

    child.on('exit', (code, signal) => {
      clearTimeout(readyTimeout);
      const wasBusy = w.state === 'busy';
      w._onExit();
      this.workers.delete(w.info.id);
      const reason = `exit code=${code} signal=${signal}`;
      this.log.info(`worker ${w.info.id} exited (${reason})`);
      this.emit({ type: 'exit', worker: w, code, signal, reason });
      if (wasBusy || this.waiters.some(x => x.projectId === projectId)) this.dispatch();
    });
    child.on('error', err => {
      this.log.error(`worker ${w.info.id} error: ${err.message}`);
      // Exec failures (ENOENT/EACCES/EMFILE/EAGAIN) emit 'error' and never 'exit': fail the boot now
      // instead of leaving the worker 'starting' until the ready timeout. Running workers are left to
      // their 'exit' event (an 'error' there is a failed send/kill).
      if (w.state !== 'starting' || !w.alive) return;
      clearTimeout(readyTimeout);
      w._onBootFailure(new Error(`worker spawn failed (${nodePath}): ${err.message}`));
      this.terminate(w, `spawn error: ${(err as NodeJS.ErrnoException).code ?? err.message}`);
      if (child.pid === undefined) this.emit({ type: 'exit', worker: w, code: null, signal: null, reason: `spawn error: ${err.message}` });
    });

    const init: InitMsg = {
      v: PROTOCOL_VERSION, type: 'init', spec, flags: ps.flags, slot, workerAssetsDir: this.opts.workerAssetsDir,
    };
    w.send(init);
    return w;
  }

  private recycle(w: WorkerHandle, reason: string): void {
    this.log.info(`worker ${w.info.id} recycled: ${reason}`);
    this.terminate(w, `recycle: ${reason}`);
    this.ensureSpare(w.projectId);
  }

  private terminate(w: WorkerHandle, reason: string): void {
    w.kill(reason);
    w._setState('dead');
    this.workers.delete(w.info.id);
  }

  /** Periodic: ping live workers (memory refresh) and reap idle workers past the idle timeout. */
  private sweep(): void {
    const s = this.opts.getSettings();
    const now = this.now();
    for (const w of [...this.workers.values()]) {
      if (!w.alive) continue;
      if (w.state === 'idle' && s.workerIdleTimeoutMs > 0 && now - w.info.lastUsed > s.workerIdleTimeoutMs) {
        this.terminate(w, 'idle timeout');
        continue;
      }
      if (w.state !== 'starting') w.send({ v: PROTOCOL_VERSION, type: 'ping' });
    }
  }
}
