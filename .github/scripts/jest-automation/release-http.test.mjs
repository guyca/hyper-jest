import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubApi } from './release.mjs';
import { ReleaseDeadlineExceeded, releaseRequest } from './release-http.mjs';

test('GitHub reads retry transport and service errors with a fresh timeout', async () => {
  const signals = [];
  const waits = [];
  const api = new GitHubApi('guyca/hyper-jest', 'test-token', async (url, options) => {
    signals.push(options.signal);
    if (signals.length === 1) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    if (signals.length === 2) return new Response('', { status: 503 });
    return Response.json({ id: 30 });
  }, async delay => waits.push(delay));
  assert.deepEqual(await api.pull(30), { id: 30 });
  assert.equal(new Set(signals).size, 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test('interrupted asset response bodies are downloaded again', async () => {
  let calls = 0;
  const api = new GitHubApi('guyca/hyper-jest', 'test-token', async () => {
    calls++;
    return calls === 1
      ? { status: 200, ok: true, arrayBuffer: async () => { throw new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } }); } }
      : new Response('retained VSIX');
  }, async () => {});
  assert.equal((await api.asset(123)).toString(), 'retained VSIX');
  assert.equal(calls, 2);
});

test('exhausted reads identify the operation and transport code without exposing secrets', async () => {
  let calls = 0;
  const api = new GitHubApi('guyca/hyper-jest', 'secret-token', async () => {
    calls++;
    throw new TypeError('fetch failed https://signed.example/secret-token', { cause: { code: 'ENOTFOUND' } });
  }, async () => {});
  await assert.rejects(api.asset(123), error => {
    assert.equal(error.message, 'GitHub GET releases/assets/123 failed after 3 attempt(s) (ENOTFOUND).');
    return true;
  });
  assert.equal(calls, 3);
});

test('authorization errors are terminal and optional missing releases remain missing', async () => {
  let calls = 0;
  const api = new GitHubApi('guyca/hyper-jest', 'test-token', async () => {
    calls++;
    return new Response('', { status: 403 });
  }, async () => assert.fail('Must not retry authorization failures'));
  await assert.rejects(api.pull(30), /GitHub GET pulls\/30 failed \(HTTP 403\)/);
  assert.equal(calls, 1);
  api.fetcher = async () => new Response('', { status: 404 });
  assert.equal(await api.request('releases/tags/v0.2.0', { missing: true }), null);
});

test('release writes are never retried after an ambiguous transport or service failure', async () => {
  for (const failure of ['transport', 'service']) {
    let calls = 0;
    const api = new GitHubApi('guyca/hyper-jest', 'test-token', async () => {
      calls++;
      if (failure === 'transport') throw new TypeError('fetch failed');
      return new Response('', { status: 503 });
    }, async () => assert.fail('Must not retry mutations'));
    await assert.rejects(api.createRelease({ tag_name: 'v0.2.0' }), /GitHub POST releases failed after 1 attempt/);
    assert.equal(calls, 1);
  }
});

function remainingBudget(clock, deadline) {
  return () => {
    const remaining = deadline - clock.time;
    if (remaining <= 0) throw new ReleaseDeadlineExceeded();
    return remaining;
  };
}

test('retry backoff uses the remaining deadline and cannot start another request after expiry', async t => {
  const clock = { time: 0 };
  const timeouts = [];
  const waits = [];
  let calls = 0;
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    timeouts.push(milliseconds);
    return new AbortController().signal;
  });
  await assert.rejects(releaseRequest('https://example.test', {}, {
    label: 'Deadline test', retry: true, remainingTime: remainingBudget(clock, 2500),
    fetcher: async () => { calls++; clock.time += 2000; throw new TypeError('fetch failed'); },
    wait: async milliseconds => { waits.push(milliseconds); clock.time += milliseconds; },
  }), ReleaseDeadlineExceeded);
  assert.equal(calls, 1);
  assert.deepEqual(timeouts, [2500]);
  assert.deepEqual(waits, [500]);
  assert.equal(clock.time, 2500);
});

for (const phase of ['request', 'response body']) {
  test(`deadline aborts an in-flight ${phase} without retrying`, async t => {
    const clock = { time: 0 };
    const timeouts = [];
    let calls = 0;
    t.mock.method(AbortSignal, 'timeout', milliseconds => {
      timeouts.push(milliseconds);
      const controller = new AbortController();
      queueMicrotask(() => {
        clock.time += milliseconds;
        controller.abort(new DOMException('Timed out', 'TimeoutError'));
      });
      return controller.signal;
    });
    const untilAborted = signal => new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    await assert.rejects(releaseRequest('https://example.test', {}, {
      label: 'Deadline test', retry: true, remainingTime: remainingBudget(clock, 25),
      fetcher: async (url, { signal }) => {
        calls++;
        return phase === 'request' ? untilAborted(signal)
          : { status: 200, ok: true, json: () => untilAborted(signal) };
      },
      wait: async () => assert.fail('Deadline expiry must not retry'),
    }), ReleaseDeadlineExceeded);
    assert.equal(calls, 1);
    assert.deepEqual(timeouts, [25]);
  });
}
