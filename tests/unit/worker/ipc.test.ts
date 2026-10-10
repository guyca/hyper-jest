import { HyperJestExitError, createWorkerLogger, installExitGuard, send, setSendImpl } from '../../../src/worker/ipc';
import { PROTOCOL_VERSION, type WorkerToHost } from '../../../src/core/protocol';

describe('ipc', () => {
  afterEach(() => setSendImpl(undefined));

  it('stamps the protocol version on every message', () => {
    const out: WorkerToHost[] = [];
    setSendImpl(m => out.push(m));
    send({ type: 'pong', rss: 1, heapUsed: 2 });
    expect(out).toEqual([{ type: 'pong', rss: 1, heapUsed: 2, v: PROTOCOL_VERSION }]);
  });

  it('forwards logger calls as log messages, trace only when enabled', () => {
    const out: WorkerToHost[] = [];
    setSendImpl(m => out.push(m));
    createWorkerLogger(false).trace('hidden');
    createWorkerLogger(true).trace('shown', { a: 1 });
    createWorkerLogger(false).error(new Error('boom'));
    expect(out.map(m => (m as { level: string }).level)).toEqual(['trace', 'error']);
    expect((out[0] as { text: string }).text).toBe('shown {"a":1}');
    expect((out[1] as { text: string }).text).toMatch(/^Error: boom/);
  });

  it('turns process.exit into a HyperJestExitError tagged with the run id', () => {
    const attempts: HyperJestExitError[] = [];
    const guard = installExitGuard(() => 'run-7', e => attempts.push(e));
    try {
      expect(() => process.exit(3)).toThrow(HyperJestExitError);
      expect(attempts[0].code).toBe(3);
      expect(attempts[0].runId).toBe('run-7');
      expect(attempts[0].message).toMatch(/run run-7/);
    } finally {
      guard.restore();
    }
    expect(typeof guard.realExit).toBe('function');
  });
});
