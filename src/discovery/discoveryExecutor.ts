import { Worker } from 'worker_threads';
import { discoverProjectsAsync, type DiscoveryResult } from '../core/projectSpec';
import type { Logger } from '../core/logger';
import type { DiscoveryExecutor, DiscoveryReply, DiscoveryRequest, WorkerDiscoveryInput } from './discoveryProtocol';

class DiscoveryWorkerFailure extends Error {
  constructor(cause: unknown) { super(String(cause)); }
}

/** One host-Node worker is reused across refreshes; only transport failures use host discovery. */
export class WorkerDiscoveryExecutor implements DiscoveryExecutor {
  private worker: Worker | undefined;
  private pending = new Map<number, { resolve: (reply: DiscoveryReply) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private fallbackForRefresh = false;

  constructor(private readonly workerEntry: string, private readonly log: Logger) {}

  beginRefresh(): void { this.fallbackForRefresh = false; }

  discover(input: WorkerDiscoveryInput): Promise<DiscoveryResult> {
    // Serial requests keep cache updates ordered, including the preliminary and config-aware passes.
    const run = () => this.discoverOnce(input);
    const current = this.queue.then(run, run);
    this.queue = current.catch(() => undefined);
    return current;
  }

  private async discoverOnce(input: WorkerDiscoveryInput): Promise<DiscoveryResult> {
    if (this.disposed) throw new Error('Discovery executor disposed');
    if (this.fallbackForRefresh) return discoverProjectsAsync(input);
    try {
      const reply = await this.request(input);
      if ('error' in reply) {
        const error = new Error(reply.error.message);
        if (reply.error.stack) error.stack = reply.error.stack;
        throw error;
      }
      if (!Array.isArray(reply.nodeVersionCacheEntries)) throw new DiscoveryWorkerFailure('invalid worker cache response');
      for (const [key, version] of reply.nodeVersionCacheEntries) input.nodeVersionCache?.set(key, version);
      return reply.result;
    } catch (error) {
      if (this.disposed || !(error instanceof DiscoveryWorkerFailure)) throw error;
      this.fallbackForRefresh = true;
      this.log.warn(`Discovery worker failed; using extension-host discovery for this refresh: ${error.message}`);
      return discoverProjectsAsync(input);
    }
  }

  private request(input: WorkerDiscoveryInput): Promise<DiscoveryReply> {
    let worker: Worker;
    try { worker = this.ensureWorker(); }
    catch (error) { return Promise.reject(new DiscoveryWorkerFailure(error)); }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { worker.postMessage({ id, input } satisfies DiscoveryRequest); }
      catch (error) { this.failWorker(worker, error); }
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.workerEntry);
    this.worker = worker;
    worker.on('message', (reply: DiscoveryReply) => {
      if (this.worker !== worker) return;
      const pending = this.pending.get(reply?.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      pending.resolve(reply);
    });
    worker.on('error', error => this.failWorker(worker, error));
    worker.on('exit', code => this.failWorker(worker, new Error(`worker exited with code ${code}`)));
    return worker;
  }

  private failWorker(worker: Worker, cause: unknown): void {
    if (this.worker !== worker) return;
    const hadPending = this.pending.size > 0;
    this.worker = undefined;
    this.fallbackForRefresh = true;
    void worker.terminate().catch(() => undefined);
    const error = new DiscoveryWorkerFailure(cause);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (!hadPending && !this.disposed) this.log.warn(`Discovery worker stopped while idle; it will restart on the next refresh: ${error.message}`);
  }

  dispose(): void {
    this.disposed = true;
    const worker = this.worker;
    this.worker = undefined;
    if (worker) void worker.terminate().catch(() => undefined);
    for (const pending of this.pending.values()) pending.reject(new Error('Discovery executor disposed'));
    this.pending.clear();
  }
}
