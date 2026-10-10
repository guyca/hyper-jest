/**
 * Worker-side process plumbing: typed `send` over Node IPC (the host forks us with
 * `serialization: 'json'`), a `log` helper that forwards to the host as `log` messages, a Logger
 * adapter, and the `process.exit` guard. No Jest, no 'vscode'.
 *
 * When there is no IPC channel (e.g. the worker is started by hand without `fork`), messages are
 * written to stdout as NDJSON so the module stays debuggable.
 */
import { PROTOCOL_VERSION, type LogMsg, type WorkerToHost } from '../core/protocol';
import type { Logger } from '../core/logger';

/** `Omit` that distributes over a union (plain `Omit` would collapse the discriminated union). */
export type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

/** A worker->host message before the protocol version is stamped on it. */
export type OutgoingMsg = DistributiveOmit<WorkerToHost, 'v'>;
export type Sender = (msg: OutgoingMsg) => void;

type RawSend = (msg: WorkerToHost) => void;

function defaultRawSend(msg: WorkerToHost): void {
  if (typeof process.send === 'function') {
    try {
      process.send(msg);
      return;
    } catch (e) {
      process.stderr.write(`[hyperjest-worker] IPC send failed (${(e as Error).message}) for ${msg.type}\n`);
      return;
    }
  }
  try {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  } catch {
    // stdout closed: nothing sensible left to do.
  }
}

let rawSend: RawSend = defaultRawSend;

/** Replaces the transport (tests, or a host that wants an in-process worker). Pass undefined to restore. */
export function setSendImpl(fn?: RawSend): void {
  rawSend = fn ?? defaultRawSend;
}

/** Stamps PROTOCOL_VERSION and sends. Never throws. */
export const send: Sender = msg => {
  rawSend({ ...msg, v: PROTOCOL_VERSION } as WorkerToHost);
};

export function log(level: LogMsg['level'], text: string): void {
  send({ type: 'log', level, text });
}

/** Logger that forwards to the host as `log` messages (trace only when enabled). */
export function createWorkerLogger(trace: boolean): Logger {
  const fmt = (msg: string | Error, args: unknown[]): string => {
    const head = msg instanceof Error ? (msg.stack ?? msg.message) : msg;
    if (!args.length) return head;
    return `${head} ${args.map(a => (typeof a === 'string' ? a : safeJson(a))).join(' ')}`;
  };
  return {
    trace: (m, ...a) => { if (trace) log('trace', fmt(m, a)); },
    debug: (m, ...a) => log('debug', fmt(m, a)),
    info: (m, ...a) => log('info', fmt(m, a)),
    warn: (m, ...a) => log('warn', fmt(m, a)),
    error: (m, ...a) => log('error', fmt(m, a)),
  };
}

export function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Thrown (instead of exiting) when Jest or user code calls `process.exit` inside the worker. */
export class HyperJestExitError extends Error {
  constructor(readonly code: number | string | undefined, readonly runId?: string) {
    super(`process.exit(${code ?? ''}) called inside the HyperJest worker${runId ? ` during run ${runId}` : ''}; the worker stays alive`);
    this.name = 'HyperJestExitError';
  }
}

export interface ExitGuard {
  /** The original `process.exit`, for the worker's own shutdown path. */
  realExit: (code?: number) => never;
  /** Restores `process.exit` (tests). */
  restore: () => void;
}

/**
 * Replaces `process.exit` with a guard that logs and throws HyperJestExitError. Jest calls exit on
 * `--showConfig`, bail, missing getVmContext, etc.; user code may call it from tests. Throwing turns
 * the call into an ordinary failure of the current file instead of killing the warm worker.
 */
export function installExitGuard(getRunId: () => string | undefined, onExitAttempt?: (err: HyperJestExitError) => void): ExitGuard {
  const original = process.exit;
  const realExit = original.bind(process) as (code?: number) => never;
  const guard = ((code?: number | string) => {
    const err = new HyperJestExitError(code, getRunId());
    try { onExitAttempt?.(err); } catch { /* never let the guard itself throw twice */ }
    throw err;
  }) as unknown as typeof process.exit;
  process.exit = guard;
  return { realExit, restore: () => { process.exit = original; } };
}
