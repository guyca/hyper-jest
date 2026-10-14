/**
 * End-to-end test of the warm worker against an isolated copy of tests/fixtures/sample-project.
 * HYPERJEST_JEST_PACKAGE selects the actual Jest runtime, independently of this suite's harness.
 *
 * Side effects on the fixture (cleaned up here): the `__snapshots__` dir written by `updateSnapshot:
 * 'new'` and a temporary slow test file used to prove mid-file cancellation.
 */
import { fork, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { copyRuntimeFixture, jestPackageDir, jestVersion } from '../helpers/jestRuntime';
import { ResultStore } from '../../src/results/resultStore';
import { selectAffected } from '../../src/core/affected';
import {
  PROTOCOL_VERSION, type HostToWorker, type InitMsg, type ProjectSpec, type ReadyMsg, type RunCompleteMsg, type RunMsg, type TestResultMsg, type WorkerFlags,
  type WorkerToHost,
} from '../../src/core/protocol';

const IT = process.env.HYPERJEST_IT === '1';
const d = IT ? describe : describe.skip;

const repoRoot = path.resolve(__dirname, '..', '..');
const workerEntry = path.join(repoRoot, 'dist', 'worker', 'hyperjestWorker.cjs');
const fixtureSource = path.join(repoRoot, 'tests', 'fixtures', 'sample-project');
const fixture = IT ? copyRuntimeFixture(fixtureSource, 'warm') : fixtureSource;
const testsDir = path.join(fixture, 'src', '__tests__');
const mathTest = path.join(testsDir, 'math.test.js');
const greetTest = path.join(testsDir, 'greet.test.js');
const greetSrc = path.join(fixture, 'src', 'lib', 'greet.js');
const mathSrc = path.join(fixture, 'src', 'lib', 'math.js');
const snapshotsDir = path.join(testsDir, '__snapshots__');
const slowTest = path.join(testsDir, 'slow.hjtmp.test.js');

type Msg = WorkerToHost;
type Of<T extends Msg['type']> = Extract<Msg, { type: T }>;
/** Omit over each member of a union (plain Omit collapses the union to its common keys). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

class WorkerClient {
  readonly child: ChildProcess;
  readonly all: Msg[] = [];
  private waiters: Array<{ pred: (m: Msg) => boolean; resolve: (m: Msg) => void }> = [];
  readonly stderr: string[] = [];

  constructor() {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test', BABEL_ENV: 'test', FORCE_COLOR: '0', NO_COLOR: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    this.child = fork(workerEntry, [], { cwd: fixture, env, serialization: 'json', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    this.child.stderr?.on('data', (b: Buffer) => this.stderr.push(b.toString()));
    this.child.on('message', (raw: unknown) => {
      const m = raw as Msg;
      this.all.push(m);
      this.waiters = this.waiters.filter(w => { if (w.pred(m)) { w.resolve(m); return false; } return true; });
    });
  }

  send(msg: DistributiveOmit<HostToWorker, 'v'>): void {
    this.child.send({ v: PROTOCOL_VERSION, ...msg });
  }

  waitFor<T extends Msg>(pred: (m: Msg) => m is T, timeoutMs?: number): Promise<T>;
  waitFor(pred: (m: Msg) => boolean, timeoutMs?: number): Promise<Msg>;
  waitFor(pred: (m: Msg) => boolean, timeoutMs = 15000): Promise<Msg> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for message; stderr:\n${this.stderr.join('')}`)), timeoutMs);
      this.waiters.push({ pred, resolve: m => { clearTimeout(t); resolve(m); } });
    });
  }

  /** Sends a run and returns every message of that run up to and including runComplete. */
  async run(tests: RunMsg['tests'], updateSnapshot: RunMsg['updateSnapshot'] = 'new', onMessage?: (m: Msg) => void): Promise<{ msgs: Msg[]; complete: RunCompleteMsg; wallMs: number }> {
    const runId = `it-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const start = this.all.length;
    const t0 = Date.now();
    const listener = (raw: unknown) => onMessage?.(raw as Msg);
    if (onMessage) this.child.on('message', listener);
    this.send({ type: 'run', runId, tests, updateSnapshot, priority: 0, reason: 'explicit' });
    const complete = await this.waitFor((m): m is RunCompleteMsg => m.type === 'runComplete' && m.runId === runId, 30000);
    const wallMs = Date.now() - t0;
    if (onMessage) this.child.off('message', listener);
    const msgs = this.all.slice(start).filter(m => !('runId' in m) || (m as { runId?: string }).runId === runId);
    return { msgs, complete, wallMs };
  }

  kill(): void {
    try { this.send({ type: 'shutdown' }); } catch { /* ignore */ }
    setTimeout(() => { try { this.child.kill('SIGKILL'); } catch { /* ignore */ } }, 1000).unref();
  }
}

const flags: WorkerFlags = { coverage: true, perTestCoverage: true, liveComments: true, instrumentTestFiles: false, globalSetup: 'once', tsJestDiagnostics: 'keep', trace: false };

function spec(): ProjectSpec {
  const jestPkgDir = jestPackageDir;
  return {
    id: 'it-fixture', displayName: 'sample-project', repoRoot: fixture, packageDir: fixture, flavor: 'implicit', status: 'ok',
    jestPkgDir, jestVersion, jestBinPath: path.join(jestPkgDir, 'bin', 'jest.js'), nodePath: process.execPath, nodeArgs: [], env: {},
    cliFilters: { testPathIgnorePatterns: [] }, e2ePatterns: [], warnings: [],
  };
}

const byType = <T extends Msg['type']>(msgs: Msg[], type: T): Of<T>[] => msgs.filter((m): m is Of<T> => m.type === type);
const results = (msgs: Msg[]) => byType(msgs, 'testResult');
const resultOf = (msgs: Msg[], fullName: string): TestResultMsg => {
  const r = results(msgs).find(m => m.fullName === fullName);
  if (!r) throw new Error(`no testResult for ${fullName}; got ${results(msgs).map(m => m.fullName).join(' | ')}`);
  return r;
};

d(`warm worker (fixture, real Jest ${jestVersion})`, () => {
  let w: WorkerClient;
  let ready: ReadyMsg;
  const timings: Record<string, number> = {};

  beforeAll(async () => {
    if (!fs.existsSync(workerEntry)) throw new Error(`missing ${workerEntry}: run \`node esbuild.mjs\` first`);
    fs.rmSync(snapshotsDir, { recursive: true, force: true });
    fs.rmSync(slowTest, { force: true });
    w = new WorkerClient();
    const init: Omit<InitMsg, 'v'> = { type: 'init', spec: spec(), flags, slot: 2, workerAssetsDir: path.dirname(workerEntry) };
    const t0 = Date.now();
    w.send(init);
    const first = await w.waitFor((m): m is ReadyMsg | Of<'initError'> => m.type === 'ready' || m.type === 'initError', 60000);
    if (first.type === 'initError') throw new Error(`initError ${first.kind}: ${first.message}\n${first.stack ?? ''}`);
    ready = first;
    timings.bootstrapWallMs = Date.now() - t0;
    timings.bootstrapMs = ready.bootstrapMs;
  }, 90000);

  afterAll(() => {
    w?.kill();
    fs.rmSync(snapshotsDir, { recursive: true, force: true });
    fs.rmSync(slowTest, { force: true });
    // eslint-disable-next-line no-console
    console.log(`[warmWorker IT] timings: ${JSON.stringify(timings)}`);
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  it('bootstraps with the selected chain-resolved Jest runtime and warm seams', () => {
    expect(ready.jestVersion).toBe(jestVersion);
    expect(ready.nodeVersion).toBe(process.version);
    expect(ready.seams.envWrapper).toBe(true);
    expect(ready.seams.cachePrune).toBe(true);
    expect(ready.seams.probeTransformer).toBe(true);
    expect(ready.configs).toHaveLength(1);
    expect(ready.configs[0]).toMatchObject({ rootDir: fixture, testMatch: ['**/__tests__/**/*.test.js'], runner: expect.stringContaining('jest-runner') });
    expect(ready.configs[0].testEnvironment).toContain('jest-environment-node');
  });

  it('streams 14 results with statuses, locations, duplicate keys, frames, console, coverage and snapshot summary', async () => {
    const { msgs, complete } = await w.run([{ path: mathTest }, { path: greetTest }], 'new');
    timings.firstRunMs = complete.durationMs;
    timings.firstRunRssMB = Math.round(complete.memory.rss / 1048576);
    expect(complete.wasInterrupted).toBe(false);
    expect(complete.error).toBeUndefined();

    const all = results(msgs);
    expect(all).toHaveLength(14);
    expect(byType(msgs, 'fileStart').map(m => path.basename(m.path))).toEqual(['math.test.js', 'greet.test.js']);

    // statuses
    expect(resultOf(msgs, 'add adds two numbers').status).toBe('passed');
    expect(resultOf(msgs, 'classify skipped test').status).toBe('pending');
    expect(resultOf(msgs, 'classify todo test').status).toBe('todo');
    expect(resultOf(msgs, 'classify classify(-5) -> negative').status).toBe('passed'); // it.each rows
    expect(resultOf(msgs, 'classify classify(0) -> zero').status).toBe('passed');
    expect(all.filter(r => r.status === 'passed')).toHaveLength(11);

    // locations (1-based test() call sites)
    expect(resultOf(msgs, 'add adds two numbers').location).toEqual({ line: 4, column: 3 });
    expect(resultOf(msgs, 'classify positive numbers (intentionally failing)').location?.line).toBe(31);
    expect(resultOf(msgs, 'classify todo test').location?.line).toBe(39);

    // failing test: frames point at the test file line, matcher data present
    const failing = resultOf(msgs, 'classify positive numbers (intentionally failing)');
    expect(failing.status).toBe('failed');
    expect(failing.failures).toHaveLength(1);
    expect(failing.failures[0].frames[0]).toMatchObject({ file: mathTest, line: 32 });
    expect(failing.failures[0].message).toContain('Expected: "positiv"');
    expect(failing.failures[0].message).not.toMatch(/\u001b/);
    expect(failing.failures[0].matcherName).toBe('toBe');
    expect(failing.failures[0].expected).toBe('"positiv"');
    expect(failing.failures[0].actual).toBe('"positive"');

    // duplicate names -> dupIndex 0 and 1, definition order
    const dups = all.filter(r => r.fullName === 'greet duplicate name');
    expect(dups.map(r => r.testKey.split('\0')[2])).toEqual(['0', '1']);
    expect(dups.map(r => r.location?.line)).toEqual([16, 17]);

    // console entries tagged with the test and the user frame
    const consoles = byType(msgs, 'console');
    expect(consoles.map(c => c.text)).toEqual(['greeting world', 'greeting bob', 'greeting snap']);
    for (const c of consoles) {
      expect(c.file).toBe(greetSrc);
      expect(c.line).toBe(6);
      expect(c.testKey).toBeDefined();
    }
    expect(byType(msgs, 'fileResult').every(f => f.console === undefined)).toBe(true); // per-test tagging replaces file console

    // The transform seam must preserve live comments, not just execute the original tests.
    const values = byType(msgs, 'value');
    expect(values.map(value => value.text)).toEqual(['"hello world"', '"hello bob"', '"hello snap"']);
    expect(values.every(value => value.file === greetSrc && value.line === 5 && value.testKey)).toBe(true);

    // per-test coverage of math.js differs between tests
    const covOf = (name: string) => byType(msgs, 'testCoverage').find(c => c.testKey === resultOf(msgs, name).testKey)!;
    const neg = covOf('classify classify(-5) -> negative').files.find(f => f.path === mathSrc)!;
    const zero = covOf('classify classify(0) -> zero').files.find(f => f.path === mathSrc)!;
    expect(neg.stmts.length).toBeGreaterThan(0);
    expect(neg.stmts).not.toEqual(zero.stmts);
    expect(covOf('divide throws on zero').files.find(f => f.path === mathSrc)!.stmts).not.toEqual(covOf('divide divides').files.find(f => f.path === mathSrc)!.stmts);

    // coverage meta once per file with function declaration lines, file load, union coverage
    const metas = byType(msgs, 'coverageMeta');
    expect(metas.map(m => path.basename(m.path)).sort()).toEqual(['greet.js', 'math.js']);
    const mathMeta = metas.find(m => m.path === mathSrc)!;
    expect(mathMeta.fnDeclLine).toEqual([1, 5, 12, 18]);
    expect(mathMeta.remapped).toBe(false);
    expect(mathMeta.stmtStartLine.length).toBeGreaterThan(5);
    const greetLoad = byType(msgs, 'fileLoad').find(m => m.path === greetTest)!;
    expect(greetLoad.files.sort()).toEqual([greetSrc, mathSrc].sort());
    const greetCov = byType(msgs, 'fileCoverage').find(m => m.path === greetTest)!;
    expect(greetCov.files.map(f => f.path).sort()).toEqual([greetSrc, mathSrc].sort());

    // file results and snapshot summary
    const files = byType(msgs, 'fileResult');
    expect(files.find(f => f.path === mathTest)).toMatchObject({ status: 'failed', numPassing: 6, numFailing: 1, numPending: 1, numTodo: 1 });
    expect(files.find(f => f.path === greetTest)).toMatchObject({ status: 'passed', numPassing: 5, snapshot: expect.objectContaining({ added: 1 }) });
    expect(fs.existsSync(path.join(snapshotsDir, 'greet.test.js.snap'))).toBe(true);
  }, 60000);

  it('narrows real imported functions across successive unsaved revisions and preserves skipped hits', async () => {
    const store = new ResultStore();
    const original = fs.readFileSync(mathSrc, 'utf8');
    const runAndStore = async (tests: RunMsg['tests']) => {
      const result = await w.run(tests, 'none');
      store.registerRun(result.complete.runId, tests);
      for (const message of result.msgs) store.apply(message, 'it-fixture');
      return result;
    };
    const select = (text: string) => {
      const sourceSelection = store.sourceSelection(mathSrc, text);
      return selectAffected({ changedFile: mathSrc, changedLines: null, sourceSelection,
        execBy: store.execBy(), loadedBy: store.loadedBy(), inverseStaticGraph: new Map([[mathSrc, new Set([mathTest])]]),
        runtimeTrackedTestFiles: sourceSelection.trackedFiles, testFiles: new Set([mathTest]), failingTestsByFile: new Map(),
        settings: { maxTestFilesPerEdit: 8, alwaysRunFailing: false, useStaticGraph: true, trackFileLoading: true },
      });
    };
    try {
      const initial = await runAndStore([{ path: mathTest }]);
      const baseline = byType(initial.msgs, 'coverageMeta').find(m => m.path === mathSrc)!;
      const branchCount = store.coverageFor(mathSrc)!.branchArmHitByFile.size;
      expect(baseline).toMatchObject({ sourceText: original, originalCoordinates: true, fnEndLine: [3, 10, 16, 20] });
      const first = original.replace('return a + b;', 'const result = a + b;\n  return result;');
      const affected = select(first);
      expect(affected).toMatchObject({ kind: 'runs', runs: [{ path: mathTest, names: ['add adds negative numbers', 'add adds two numbers'] }] });
      if (affected.kind !== 'runs') throw new Error('expected add selection');
      w.send({ type: 'overlay', changes: [{ path: mathSrc, text: first, version: 201 }] });
      const updated = await runAndStore(affected.runs);
      expect(byType(updated.msgs, 'coverageMeta').find(m => m.path === mathSrc)?.sourceText).toBe(first);
      expect(store.execBy().get(mathSrc)?.size).toBe(7);
      expect(store.coverageFor(mathSrc)?.branchArmHitByFile.size).toBe(branchCount);
      expect(store.coverageFor(mathSrc)?.stale).toBe(false);
      const second = first.replace('return a / b;', 'return a / b + 0;');
      const next = select(second);
      expect(next).toMatchObject({ kind: 'runs', runs: [{ path: mathTest, names: ['divide divides', 'divide throws on zero'] }] });
      if (next.kind !== 'runs') throw new Error('expected divide selection');
      w.send({ type: 'overlay', changes: [{ path: mathSrc, text: second, version: 202 }] });
      await runAndStore(next.runs);
      expect(select(original)).toMatchObject({ kind: 'runs', runs: [{ path: mathTest, names: ['add adds negative numbers', 'add adds two numbers', 'divide divides', 'divide throws on zero'] }] });
      expect(fs.readFileSync(mathSrc, 'utf8')).toBe(original);
    } finally {
      w.send({ type: 'overlay', changes: [{ path: mathSrc, text: null, version: 203 }] });
      store.dispose();
    }
  }, 30000);

  it('keeps module initialization and shared hooks broad, while attributing beforeEach to tests', async () => {
    const store = new ResultStore();
    const originalSpec = fs.readFileSync(mathTest, 'utf8');
    const source = fs.readFileSync(mathSrc, 'utf8');
    const editedSpec = `${originalSpec}\nadd(1, 2);\nbeforeAll(() => divide(6, 3));\nafterAll(() => classify(1));\nbeforeEach(() => require('../lib/math').neverCalled());\n`;
    try {
      w.send({ type: 'overlay', changes: [{ path: mathTest, text: editedSpec, version: 301 }] });
      const run = await w.run([{ path: mathTest }], 'none');
      store.registerRun(run.complete.runId, [{ path: mathTest }]);
      for (const message of run.msgs) store.apply(message, 'it-fixture');
      for (const [oldBody, newBody] of [['a + b', 'a + b + 0'], ['a / b', 'a / b + 0'], ["return 'positive'", "return 'other'"]]) {
        expect(store.sourceSelection(mathSrc, source.replace(oldBody, newBody)).wholeFiles).toContain(mathTest);
      }
      const perTest = store.sourceSelection(mathSrc, source.replace('unreachable in tests', 'now reached'));
      expect(perTest.wholeFiles.size).toBe(0);
      expect(perTest.tests.size).toBe(7);
      expect(perTest.trackedFiles).toContain(mathTest);
    } finally {
      w.send({ type: 'overlay', changes: [{ path: mathTest, text: null, version: 302 }] });
      store.dispose();
    }
  }, 30000);

  it('re-runs a warm file in well under a second', async () => {
    const { msgs, complete, wallMs } = await w.run([{ path: greetTest }], 'new');
    timings.rerunMs = complete.durationMs;
    timings.rerunWallMs = wallMs;
    timings.rerunRssMB = Math.round(complete.memory.rss / 1048576);
    expect(complete.durationMs).toBeLessThan(1000);
    expect(results(msgs)).toHaveLength(5);
    expect(byType(msgs, 'fileResult')[0].snapshot).toMatchObject({ matched: 1, added: 0 });
  });

  it('narrows to selected test names: only they report non-pending', async () => {
    const { msgs } = await w.run([{ path: mathTest, names: ['add adds two numbers', 'divide divides'] }], 'none');
    const all = results(msgs);
    expect(all).toHaveLength(9);
    expect(all.filter(r => r.status !== 'pending').map(r => r.fullName).sort()).toEqual(['add adds two numbers', 'divide divides']);
    expect(byType(msgs, 'testCoverage')).toHaveLength(2);
  });

  it('runs from overlay (unsaved) content without touching disk, then from disk again once the overlay is removed', async () => {
    const original = fs.readFileSync(greetSrc, 'utf8');
    const edited = original.replace('hello ${name}', 'hi ${name}');
    expect(edited).not.toBe(original);
    w.send({ type: 'overlay', changes: [{ path: greetSrc, text: edited, version: 5 }] });
    const run1 = await w.run([{ path: greetTest }], 'none');
    const once = resultOf(run1.msgs, 'greet greets once');
    expect(once.status).toBe('failed');
    expect(once.failures[0].message).toContain('hi world');
    expect(fs.readFileSync(greetSrc, 'utf8')).toBe(original);
    expect(byType(run1.msgs, 'console').map(c => c.line)).toEqual([6, 6, 6]);
    if (ready.seams.probeTransformer) {
      const values = byType(run1.msgs, 'value');
      expect(values.map(v => v.text)).toEqual(['"hi world"', '"hi bob"', '"hi snap"']);
      expect(values[0]).toMatchObject({ file: greetSrc, line: 5 });
    }
    expect(byType(run1.msgs, 'fileResult')[0].snapshot).toMatchObject({ unmatched: 1 });

    w.send({ type: 'overlay', changes: [{ path: greetSrc, text: null, version: 6 }] });
    const run2 = await w.run([{ path: greetTest }], 'none');
    expect(resultOf(run2.msgs, 'greet greets once').status).toBe('passed');
    expect(byType(run2.msgs, 'fileResult')[0].status).toBe('passed');
  });

  it('cancels mid-file: remaining tests skip and later files never start', async () => {
    fs.writeFileSync(slowTest, [
      "const wait = ms => new Promise(r => setTimeout(r, ms));",
      "describe('slow', () => {",
      "  for (let i = 1; i <= 8; i++) it(`step ${i}`, async () => { await wait(40); expect(i).toBeGreaterThan(0); });",
      '});', '',
    ].join('\n'));
    try {
      let cancelled = false;
      const { msgs, complete } = await w.run([{ path: slowTest }, { path: mathTest }], 'none', m => {
        if (!cancelled && m.type === 'testResult') {
          cancelled = true;
          w.send({ type: 'cancel', runId: m.runId });
        }
      });
      expect(complete.wasInterrupted).toBe(true);
      const slow = results(msgs).filter(r => r.path === slowTest);
      expect(slow).toHaveLength(8);
      expect(slow.filter(r => r.status === 'passed').length).toBeGreaterThanOrEqual(1);
      expect(slow.filter(r => r.status === 'pending').length).toBeGreaterThanOrEqual(5);
      expect(byType(msgs, 'fileStart').map(m => m.path)).toEqual([slowTest]);
      expect(results(msgs).some(r => r.path === mathTest)).toBe(false);
    } finally {
      fs.rmSync(slowTest, { force: true });
    }
    // Stale cancel ids are ignored and the worker still serves runs.
    w.send({ type: 'cancel', runId: 'stale-run' });
    const after = await w.run([{ path: mathTest }], 'none');
    expect(results(after.msgs)).toHaveLength(9);
    expect(after.complete.wasInterrupted).toBe(false);
  }, 30000);

  it('answers listTests, showConfig, graph and ping', async () => {
    w.send({ type: 'listTests' });
    const list = await w.waitFor((m): m is Of<'listTestsResult'> => m.type === 'listTestsResult');
    expect(list.files.sort()).toEqual([greetTest, mathTest].sort());

    w.send({ type: 'showConfig' });
    const cfg = await w.waitFor((m): m is Of<'showConfigResult'> => m.type === 'showConfigResult');
    const parsed = JSON.parse(cfg.json);
    expect(parsed.globalConfig).toMatchObject({ maxWorkers: 1, collectCoverage: true, coverageProvider: 'babel', reporters: [] });
    expect(parsed.configs[0].rootDir).toBe(fixture);

    w.send({ type: 'graph' });
    const graph = await w.waitFor((m): m is Of<'graphResult'> => m.type === 'graphResult');
    expect(graph.forward[greetTest]).toEqual([greetSrc]);
    expect(graph.forward[greetSrc]).toEqual([mathSrc]);
    expect(graph.testFiles.sort()).toEqual([greetTest, mathTest].sort());

    w.send({ type: 'ping' });
    const pong = await w.waitFor((m): m is Of<'pong'> => m.type === 'pong');
    expect(pong.rss).toBeGreaterThan(0);
  });

  it('never let process.exit or uncaught errors kill the worker', async () => {
    // JEST_WORKER_ID must reflect the slot (3 = slot 2 + 1) even though runTests sets '1'.
    const probe = path.join(testsDir, 'env.hjtmp.test.js');
    fs.writeFileSync(probe, "it('reports worker id', () => { expect(process.env.JEST_WORKER_ID).toBe('3'); });\nit('exit is guarded', () => { expect(() => process.exit(5)).toThrow(/HyperJest worker/); });\n");
    try {
      const { msgs } = await w.run([{ path: probe }], 'none');
      expect(results(msgs).map(r => r.status)).toEqual(['passed', 'passed']);
    } finally {
      fs.rmSync(probe, { force: true });
    }
    expect(w.child.exitCode).toBeNull();
  });
});
