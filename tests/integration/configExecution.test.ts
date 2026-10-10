/** Real warm/CLI execution of a multi-config package; uses only local fixture tests. */
import { fork, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCli } from '../../src/cliEngine';
import { prepareHyperConfig } from '../../src/discovery/hyperConfigLoader';
import { ResultStore } from '../../src/results/resultStore';
import { noopLogger } from '../../src/core/logger';
import { makeTestKey, type ProjectSpec, type WorkerToHost, type HostToWorker, type OverlayChange } from '../../src/core/protocol';

const suite = process.env.HYPERJEST_IT === '1' ? describe : describe.skip;
const repo = path.resolve(__dirname, '../..');
const assets = path.join(repo, 'dist/worker');
const fixture = path.join(repo, 'tests/fixtures/config-project');
const runtime = { nodePath: process.execPath, nodeArgs: [], env: {} };
const flags = { coverage: false, perTestCoverage: false, liveComments: false, instrumentTestFiles: false, globalSetup: 'once' as const, tsJestDiagnostics: 'keep' as const, trace: false };

async function execute(engine: 'warm' | 'cli', spec: ProjectSpec, files: string[], overlay: OverlayChange[] = []): Promise<WorkerToHost[]> {
  const messages: WorkerToHost[] = [];
  const runId = `${engine}-${spec.id}`;
  if (engine === 'cli') {
    const run = runCli({ spec, tests: files.map(p => ({ path: p })), runId, updateSnapshot: 'none', overlay, coverage: false, workerAssetsDir: assets, extraEnv: {}, timeoutMs: 15000, keepArtifacts: false, onMessage: m => messages.push(m), log: noopLogger });
    const result = await run.done;
    expect(result.wasInterrupted).toBe(false);
    expect(result.error).toBeUndefined();
    return messages;
  }
  const child: ChildProcess = fork(path.join(assets, 'hyperjestWorker.cjs'), [], { cwd: spec.packageDir, env: { ...process.env, ...spec.env }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-12000); });
  const wait = (type: WorkerToHost['type']) => new Promise<WorkerToHost>((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', listener); reject(new Error(`Timed out waiting for ${type}: ${stderr}`)); }, 15000);
    const listener = (msg: WorkerToHost) => { if (msg.type === type || msg.type === 'initError') { clearTimeout(timer); child.off('message', listener); if (msg.type === 'initError') reject(new Error(msg.message)); else resolve(msg); } };
    child.on('message', listener);
  });
  child.on('message', (msg: WorkerToHost) => messages.push(msg));
  const send = (msg: HostToWorker) => child.send(msg);
  try {
    const ready = wait('ready'); send({ v: 1, type: 'init', spec, flags, workerAssetsDir: assets, slot: 0 }); await ready;
    if (overlay.length) send({ v: 1, type: 'overlay', changes: overlay });
    const complete = wait('runComplete'); send({ v: 1, type: 'run', runId, tests: files.map(p => ({ path: p })), reason: 'explicit', priority: 0, updateSnapshot: 'none' }); await complete;
    return messages;
  } finally {
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    child.kill('SIGKILL'); await closed;
  }
}

suite.each(['warm', 'cli'] as const)('%s configuration execution', engine => {
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hyperjest-execution-')));
    fs.cpSync(fixture, dir, { recursive: true });
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const spec = (id: string): ProjectSpec => ({
    id, displayName: id, packageDir: dir, repoRoot: dir, flavor: 'hyperjest', status: 'ok', selected: true,
    configArg: path.join(dir, 'jest.config.js'), jestPkgDir: path.join(repo, 'node_modules/jest'), jestBinPath: path.join(repo, 'node_modules/jest/bin/jest.js'), jestVersion: '29.7.0',
    ...runtime, cliFilters: { testPathIgnorePatterns: [] }, e2ePatterns: [], warnings: [],
  });
  it('runs only imported unit scope and enables integration when selected explicitly', async () => {
    const config = (await prepareHyperConfig({ file: path.join(dir, 'hyperjest.config.js'), wallaby: path.join(dir, 'wallaby.js') }, runtime)).config!;
    expect(config).toBeDefined();
    const unit = path.join(dir, 'tests/unit/pass.test.js'), integration = path.join(dir, 'tests/integration/external.test.js');
    const messages = await execute(engine, { ...spec('default'), scope: { baseDir: dir, tests: config.tests } }, [unit, integration]);
    const results = messages.filter(m => m.type === 'testResult');
    expect(results.map(m => [m.path, m.status])).toEqual([[unit, 'passed']]);
    const enabled = await execute(engine, { ...spec('integration'), configArg: path.join(dir, 'jest.integration.config.js') }, [integration]);
    expect(enabled.filter(m => m.type === 'testResult').map(m => [m.path, m.status])).toEqual([[integration, 'failed']]);
  });
  it('uses unsaved edits and keeps different outcomes for the same physical test file under separate configs', async () => {
    const file = path.join(dir, 'tests/unit/pass.test.js');
    fs.writeFileSync(file, "throw new Error('The unsaved buffer must replace this disk content');\n");
    const overlay = [{ path: file, text: "test('same test', () => expect(process.env.HYPERJEST_FIXTURE_VALUE).toBe('pass'));\n", version: 1 }];
    const store = new ResultStore();
    for (const id of ['pass', 'fail']) {
      const messages = await execute(engine, { ...spec(id), env: { HYPERJEST_FIXTURE_VALUE: id } }, [file], overlay);
      for (const msg of messages) store.apply(msg, id);
    }
    expect(store.test(makeTestKey(file, 'same test', 0, 'pass'))?.status).toBe('passed');
    expect(store.test(makeTestKey(file, 'same test', 0, 'fail'))?.status).toBe('failed');
    expect(store.summary()).toMatchObject({ passed: 1, failed: 1 });
    store.dispose();
  });
});
