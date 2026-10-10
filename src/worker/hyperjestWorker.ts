/**
 * HyperJest worker entry (dist/worker/hyperjestWorker.cjs). Forked by the host with the PROJECT's
 * node, cwd = package dir, JSON IPC. Long-lived: bootstraps the warm Jest engine on `init` and then
 * serves runs until `shutdown` or the IPC channel disconnects.
 *
 * Order matters:
 *   1. overlayFs.install() before anything can require graceful-fs (it clones `fs` on first require).
 *   2. Guards: process.exit -> throw (Jest/user code must not kill the warm worker), uncaught errors
 *      tagged with the current runId and forwarded as `log`.
 *   3. IPC loop. Every HostToWorker message is handled; stale `cancel` runIds are ignored.
 *
 * Nothing here imports Jest statically; the engine chain-resolves it from the project.
 */
import type { HostToWorker, InitMsg } from '../core/protocol';
import { createWorkerLogger, HyperJestExitError, installExitGuard, log, send } from './ipc';
import { install as installOverlay } from './overlayFs';
import { WarmEngine } from './warmEngine';

const overlay = installOverlay();

let engine: WarmEngine | undefined;
const currentRunId = (): string | undefined => engine?.activeRunId;
const exitGuard = installExitGuard(currentRunId, err => log('warn', err.message));

overlay.onWriteBlocked(p => send({ type: 'overlayWriteBlocked', path: p }));

function tag(): string {
  const runId = currentRunId();
  return runId ? ` (run ${runId})` : '';
}

process.on('uncaughtException', (err: unknown) => {
  const e = err as Error | undefined;
  const text = `uncaughtException${tag()}: ${e?.stack ?? String(err)}`;
  log(err instanceof HyperJestExitError ? 'warn' : 'error', text);
  engine?.noteRuntimeError(err);
});

process.on('unhandledRejection', (reason: unknown) => {
  const e = reason as Error | undefined;
  const text = `unhandledRejection${tag()}: ${e?.stack ?? String(reason)}`;
  log(reason instanceof HyperJestExitError ? 'warn' : 'error', text);
  engine?.noteRuntimeError(reason);
});

process.on('disconnect', () => exitGuard.realExit(0));

function onInit(msg: InitMsg): Promise<void> {
  if (engine) {
    log('warn', 'duplicate init ignored');
    return Promise.resolve();
  }
  engine = new WarmEngine(msg, {
    send,
    log: createWorkerLogger(msg.flags.trace),
    overlay,
    onInvalidateConfig: () => {
      // Give the log message a tick to flush, then let the pool recycle us.
      setTimeout(() => exitGuard.realExit(0), 20);
    },
  });
  return engine.bootstrap().then(() => undefined);
}

async function handle(msg: HostToWorker): Promise<void> {
  switch (msg.type) {
    case 'init':
      await onInit(msg);
      return;
    case 'ping': {
      const m = process.memoryUsage();
      send({ type: 'pong', rss: m.rss, heapUsed: m.heapUsed });
      return;
    }
    case 'shutdown':
      exitGuard.realExit(0);
      return;
    default:
      break;
  }
  if (!engine) {
    log('warn', `message "${msg.type}" received before init; ignored`);
    return;
  }
  switch (msg.type) {
    case 'run':
      await engine.run(msg);
      return;
    case 'cancel':
      engine.cancel(msg.runId);
      return;
    case 'overlay':
      engine.applyOverlay(msg.changes);
      return;
    case 'invalidate':
      await engine.invalidate(msg);
      return;
    case 'graph':
      await engine.graph();
      return;
    case 'showConfig':
      engine.showConfig();
      return;
    case 'listTests':
      await engine.listTests();
      return;
    default:
      log('warn', `unknown message type ${(msg as { type?: string }).type}`);
  }
}

process.on('message', (raw: unknown) => {
  const msg = raw as HostToWorker;
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
  handle(msg).catch(e => {
    log('error', `handler for "${msg.type}" failed${tag()}: ${(e as Error)?.stack ?? String(e)}`);
  });
});

if (typeof process.send !== 'function') {
  process.stderr.write('[hyperjest-worker] started without an IPC channel; messages will be printed to stdout as NDJSON\n');
}
