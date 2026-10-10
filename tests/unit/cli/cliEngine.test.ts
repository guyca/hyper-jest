/**
 * cliEngine child-process handling, driven by a fake `jest/bin/jest.js` (a node script) so no Jest
 * is involved: stderr draining, settling on 'close', and artifact cleanup.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findRelatedTests, runCli } from '../../../src/cliEngine';
import { noopLogger } from '../../../src/core/logger';
import type { ProjectSpec, WorkerToHost } from '../../../src/core/protocol';
import { OVERLAY_PRELOAD_BUNDLE } from '../../../src/core/runSpec';
import { setRunArtifactsBaseForTests } from '../../../src/overlayManifest';

let dir: string;

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hj-cliengine-')));
  setRunArtifactsBaseForTests(() => dir);
  fs.writeFileSync(path.join(dir, OVERLAY_PRELOAD_BUNDLE), '// fake preload\n');
});
afterAll(() => {
  setRunArtifactsBaseForTests(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeSpec(script: string): ProjectSpec {
  const bin = path.join(dir, `fake-jest-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(bin, script);
  return {
    id: 'p', displayName: 'p', repoRoot: dir, packageDir: dir, flavor: 'plain', status: 'ok',
    jestPkgDir: dir, jestBinPath: bin, nodePath: process.execPath, nodeArgs: [], env: {},
    cliFilters: { testPathIgnorePatterns: [] }, e2ePatterns: [], warnings: [],
  } as unknown as ProjectSpec;
}

describe('findRelatedTests', () => {
  it('drains stderr so a chatty Jest (>64 KB of warnings) is not blocked', async () => {
    const spec = fakeSpec(`
      const fs = require('fs');
      fs.writeSync(2, 'jest-haste-map: duplicate manual mock found\\n'.repeat(8000)); // ~350 KB, blocks on a full pipe
      process.stdout.write(JSON.stringify(['/a.test.js', '/b.test.js']) + '\\n');
    `);
    const started = Date.now();
    const files = await findRelatedTests(spec, ['/src/a.js'], 'related-1', {}, noopLogger, 10000);
    expect(files).toEqual(['/a.test.js', '/b.test.js']);
    expect(Date.now() - started).toBeLessThan(8000);
  });

  it('reads stdout written right before exit', async () => {
    const big = Array.from({ length: 5000 }, (_, i) => `/pkg/src/__tests__/file-${i}.test.js`);
    const spec = fakeSpec(`process.stdout.write(${JSON.stringify(JSON.stringify(big))} + '\\n');`);
    expect(await findRelatedTests(spec, ['/src/a.js'], 'related-2', {}, noopLogger, 10000)).toEqual(big);
  });
});

describe('runCli', () => {
  it('delivers every fd-3 event, synthesises nothing after a real runComplete and removes the run artifacts', async () => {
    const lines = [
      { v: 1, type: 'fileStart', path: '/t.test.js' },
      { v: 1, type: 'fileResult', path: '/t.test.js', status: 'passed', snapshot: {}, numPassing: 1, numFailing: 0, numPending: 0, numTodo: 0, perfStats: { start: 0, end: 0, runtime: 0, slow: false } },
      { v: 1, type: 'runComplete', wasInterrupted: false, success: true, numTotalTestSuites: 1, numFailedTestSuites: 0, numRuntimeErrorTestSuites: 0, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, snapshot: {}, startTime: 0, durationMs: 1 },
    ].map(l => JSON.stringify(l)).join('\n') + '\n';
    const spec = fakeSpec(`
      const fs = require('fs');
      const overlay = process.env.HYPERJEST_OVERLAY;
      const mode = overlay ? (fs.statSync(overlay).mode & 0o777).toString(8) : 'none';
      fs.writeSync(1, 'overlay-mode=' + mode + '\\n');
      fs.writeSync(3, ${JSON.stringify(lines)});
    `);
    const messages: WorkerToHost[] = [];
    const traces: string[] = [];
    const handle = runCli({
      spec, tests: [{ path: '/t.test.js' }], runId: 'g1-x_1', updateSnapshot: 'none',
      overlay: [{ path: '/src/a.ts', text: 'export const a = 1;', version: 2 }],
      coverage: false, workerAssetsDir: dir, extraEnv: {}, timeoutMs: 10000, keepArtifacts: false,
      onMessage: m => messages.push(m),
      log: { ...noopLogger, trace: (m: string) => traces.push(m) },
    });
    const res = await handle.done;
    expect(res).toMatchObject({ wasInterrupted: false, exitCode: 0 });
    expect(res.error).toBeUndefined();
    expect(messages.map(m => m.type)).toEqual(['fileStart', 'fileResult', 'runComplete']);
    // The manifest was private to this user while the run was alive, and is gone afterwards.
    expect(traces.join('\n')).toContain('overlay-mode=600');
    const sessionDirs = fs.readdirSync(dir).filter(n => /^hyperjest-\d+-/.test(n));
    expect(sessionDirs).toHaveLength(1);
    expect(fs.statSync(path.join(dir, sessionDirs[0])).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.join(dir, sessionDirs[0]))).toEqual([]);
  });

  it('reports a crash with the stderr tail and a synthetic runComplete', async () => {
    const spec = fakeSpec(`process.stderr.write('x'.repeat(50000) + '\\nSyntaxError: boom\\n'); process.exit(3);`);
    const messages: WorkerToHost[] = [];
    const res = await runCli({
      spec, tests: [{ path: '/t.test.js' }], runId: 'g1-x_2', updateSnapshot: 'none', overlay: [],
      coverage: false, workerAssetsDir: dir, extraEnv: {}, timeoutMs: 10000, keepArtifacts: false,
      onMessage: m => messages.push(m), log: noopLogger,
    }).done;
    expect(res.exitCode).toBe(3);
    expect(res.error).toContain('SyntaxError: boom');
    expect(messages.map(m => m.type)).toEqual(['runComplete']);
  });

  it('settles after exit when a process the run left behind keeps stdio open', async () => {
    // The grandchild inherits Jest's stdout/stderr, so 'close' only fires when it exits (8 s).
    const pidFile = path.join(dir, 'grandchild.pid');
    const spec = fakeSpec(`
      const { spawn } = require('child_process');
      const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { stdio: 'inherit', detached: true });
      require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
      g.unref();
      process.exit(0);
    `);
    const started = Date.now();
    const res = await runCli({
      spec, tests: [{ path: '/t.test.js' }], runId: 'g1-x_3', updateSnapshot: 'none', overlay: [],
      coverage: false, workerAssetsDir: dir, extraEnv: {}, timeoutMs: 60000, keepArtifacts: false,
      onMessage: () => undefined, log: noopLogger,
    }).done;
    try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
    expect(res.exitCode).toBe(0);
    expect(Date.now() - started).toBeLessThan(6000);
  }, 15000);
});
