import {
  CONSOLE_MAX_PER_TEST, VALUE_THROTTLE_PER_MARKER, formatValue, fullNameOfTest, isEnvironmentClass, resetMetaSent, setRunContext,
  wrapEnvironment, type EnvRunContext,
} from '../../../src/worker/envWrapper';
import type { WorkerFlags, WorkerToHost } from '../../../src/core/protocol';
import type { OutgoingMsg } from '../../../src/worker/ipc';

const flags: WorkerFlags = { coverage: true, perTestCoverage: true, liveComments: true, instrumentTestFiles: false, globalSetup: 'once', tsJestDiagnostics: 'keep', trace: false };

class BaseEnv {
  global: Record<string, any>;
  events: string[] = [];
  constructor(public config: unknown, public context: { console: unknown; testPath: string }) { this.global = {}; }
  getVmContext() { return null; }
  async setup() {}
  async teardown() {}
  async handleTestEvent(event: { name: string }) { this.events.push(event.name); }
}

class BareEnv {
  global: Record<string, any> = {};
  constructor(_c: unknown, _ctx: unknown) {}
  getVmContext() { return null; }
  async setup() {}
}

/** Minimal BufferedConsole look-alike. */
class FakeConsole {
  buffer: Array<{ type: string; message: string }> = [];
  _log(type: string, message: string) { this.buffer.push({ type, message }); }
  log(...a: unknown[]) { this._log('log', a.join(' ')); }
}

function makeTest(name: string, parent: any, fn: () => void = () => {}) {
  return { type: 'test', name, parent, fn, mode: undefined as string | undefined, concurrent: true, errors: [] as unknown[] };
}

function ctxWith(over: Partial<EnvRunContext> = {}): { ctx: EnvRunContext; out: OutgoingMsg[] } {
  const out: OutgoingMsg[] = [];
  const ctx: EnvRunContext = {
    runId: 'r1', flags, send: m => out.push(m), selectionFor: () => undefined, cancelled: false,
    consoleCapturedFiles: new Set(), fileCoverageSent: new Set(), onError: (w, e) => { throw new Error(`${w}: ${(e as Error).message}`); }, ...over,
  };
  return { ctx, out };
}

const cov = (path: string, s: number[]) => ({
  path, statementMap: Object.fromEntries(s.map((_, i) => [i, { start: { line: i + 1, column: 0 }, end: { line: i + 1, column: 5 } }])),
  fnMap: {}, branchMap: {}, s: Object.fromEntries(s.map((v, i) => [i, v])), f: {}, b: {},
});

describe('envWrapper', () => {
  beforeEach(() => resetMetaSent());
  afterEach(() => setRunContext(undefined));

  it('separates initialization and shared hooks from individual test windows', async () => {
    const { ctx, out } = ctxWith();
    setRunContext(ctx);
    const W = wrapEnvironment(BareEnv, {});
    const env = new W({}, { testPath: '/t/hooks.test.js' });
    const file = { ...cov('/t/lib.js', [1]), f: { 0: 1, 1: 0, 2: 0, 3: 0 } };
    env.global.__coverage__ = { '/t/lib.js': file };
    const event = async (name: string, extra = {}) => env.handleTestEvent({ name, ...extra }, {});
    await event('run_start');
    await event('hook_start', { hook: { type: 'beforeAll' } });
    file.f[1]++;
    await event('hook_success');
    const test = makeTest('t', { name: 'ROOT' });
    await event('test_start', { test });
    // beforeEach, test and afterEach are all inside this window.
    file.f[2]++;
    await event('test_done', { test });
    await event('hook_start', { hook: { type: 'afterAll' } });
    file.f[3]++;
    await event('hook_success');
    await event('run_finish');
    const perTest = out.find(m => m.type === 'testCoverage') as Extract<WorkerToHost, { type: 'testCoverage' }>;
    expect(perTest.files[0].fns).toEqual([2]);
    const shared = out.filter(m => m.type === 'fileLoad').at(-1) as Extract<WorkerToHost, { type: 'fileLoad' }>;
    expect(shared.complete).toBe(true);
    expect(shared.shared?.[0].fns).toEqual([0, 1, 3]);
  });

  it('detects environment classes and memoises wrappers', () => {
    expect(isEnvironmentClass(BaseEnv)).toBe(true);
    expect(isEnvironmentClass(BareEnv)).toBe(true);
    expect(isEnvironmentClass(() => 1)).toBe(false);
    expect(isEnvironmentClass({ prototype: { getVmContext() {} } })).toBe(false);
    const W = wrapEnvironment(BaseEnv, {});
    expect(wrapEnvironment(BaseEnv, {})).toBe(W);
    expect(W.name).toBe('HyperJest(BaseEnv)');
    expect(wrapEnvironment(42, {})).toBe(42);
  });

  it('computes circus full names from the describe chain', () => {
    const root = { name: 'ROOT_DESCRIBE_BLOCK', parent: undefined };
    const d1 = { name: 'outer', parent: root };
    const d2 = { name: 'inner', parent: d1 };
    expect(fullNameOfTest({ name: 't', parent: d2 })).toBe('outer inner t');
    expect(fullNameOfTest({ name: 't', parent: root })).toBe('t');
  });

  it('streams per-test coverage, file load, console and values through the circus lifecycle', async () => {
    const { ctx, out } = ctxWith();
    setRunContext(ctx);
    const W = wrapEnvironment(BaseEnv, { prettyFormat: { format: (v: unknown) => `pf:${JSON.stringify(v)}` } });
    const fakeConsole = new FakeConsole();
    const env = new W({ globalConfig: {}, projectConfig: {} }, { console: fakeConsole, testPath: '/t/a.test.js' });
    expect(ctx.consoleCapturedFiles.has('/t/a.test.js')).toBe(true);

    const root: any = { name: 'ROOT', parent: undefined, children: [] };
    const state: any = { currentDescribeBlock: root, includeTestLocationInResult: false };
    await env.handleTestEvent({ name: 'setup' }, state);
    expect(state.includeTestLocationInResult).toBe(true);

    const t1 = makeTest('dup', root); const t2 = makeTest('dup', root); const t3 = makeTest('other', root);
    for (const t of [t1, t2, t3]) { root.children.push(t); await env.handleTestEvent({ name: 'add_test', testName: t.name, fn: t.fn }, state); }
    expect([t1.concurrent, t2.concurrent, t3.concurrent]).toEqual([false, false, false]);
    expect(env.events).toEqual(['setup', 'add_test', 'add_test', 'add_test']); // super.handleTestEvent still called

    // Module scope executed statements 0 of lib.js before run_start.
    env.global.__coverage__ = { '/t/lib.js': cov('/t/lib.js', [1, 0, 0]) };
    await env.handleTestEvent({ name: 'run_start' }, state);
    expect(out.filter(m => m.type === 'coverageMeta')).toHaveLength(1);
    expect(out.find(m => m.type === 'fileLoad')).toEqual({ type: 'fileLoad', runId: 'r1', path: '/t/a.test.js', files: ['/t/lib.js'] });

    await env.handleTestEvent({ name: 'test_start', test: t1 }, state);
    expect(ctx.current?.testKey).toBe('/t/a.test.js\0dup\x000');
    env.global.__coverage__['/t/lib.js'].s[1] = 1;
    fakeConsole.log('hello', 'world');
    env.global.__hj_v('/t/lib.js', 5, 29, { a: 1 });
    await env.handleTestEvent({ name: 'test_done', test: t1 }, state);
    const c1 = out.find(m => m.type === 'testCoverage') as Extract<WorkerToHost, { type: 'testCoverage' }>;
    expect(c1.testKey).toBe('/t/a.test.js\0dup\x000');
    expect(c1.files).toMatchObject([{ path: '/t/lib.js', stmts: [1] }]);
    const con = out.find(m => m.type === 'console') as Extract<WorkerToHost, { type: 'console' }>;
    expect(con).toMatchObject({ level: 'log', text: 'hello world', testKey: '/t/a.test.js\0dup\x000', path: '/t/a.test.js' });
    expect(con.file).toBe(__filename);
    expect(fakeConsole.buffer).toEqual([{ type: 'log', message: 'hello world' }]); // original console still fed
    const val = out.find(m => m.type === 'value') as Extract<WorkerToHost, { type: 'value' }>;
    expect(val).toMatchObject({ file: '/t/lib.js', line: 5, column: 29, text: 'pf:{"a":1}', testKey: '/t/a.test.js\0dup\x000' });

    // Second duplicate gets dupIndex 1; statement 2 is new for it.
    await env.handleTestEvent({ name: 'test_start', test: t2 }, state);
    env.global.__coverage__['/t/lib.js'].s[2] = 1;
    env.global.__coverage__['/t/lib.js'].s[1] = 2;
    await env.handleTestEvent({ name: 'test_done', test: t2 }, state);
    const c2 = out.filter(m => m.type === 'testCoverage')[1] as Extract<WorkerToHost, { type: 'testCoverage' }>;
    expect(c2.testKey).toBe('/t/a.test.js\0dup\x001');
    expect(c2.files).toMatchObject([{ path: '/t/lib.js', stmts: [1, 2] }]);

    await env.handleTestEvent({ name: 'run_finish' }, state);
    await env.handleTestEvent({ name: 'teardown' }, state);
    const fileCov = out.filter(m => m.type === 'fileCoverage') as Array<Extract<WorkerToHost, { type: 'fileCoverage' }>>;
    expect(fileCov).toHaveLength(1);
    expect(fileCov[0].files[0]).toMatchObject({ path: '/t/lib.js', hitStmts: [0, 1, 2] });
    expect(ctx.fileCoverageSent.has('/t/a.test.js')).toBe(true);
    expect(out.filter(m => m.type === 'coverageMeta')).toHaveLength(1); // once per (path, hash)
  });

  it('skips tests excluded by the selection or after a cancel, and works without a base handler', async () => {
    const { ctx, out } = ctxWith({ selectionFor: () => new Set(['keep']) });
    setRunContext(ctx);
    const W = wrapEnvironment(BareEnv, {});
    const env = new W({}, { console: undefined, testPath: '/t/b.test.js' });
    const root: any = { name: 'ROOT', parent: undefined, children: [] };
    const state: any = { currentDescribeBlock: root };
    const keep = makeTest('keep', root); const drop = makeTest('drop', root);
    for (const t of [keep, drop]) { root.children.push(t); env.handleTestEvent({ name: 'add_test', testName: t.name, fn: t.fn }, state); }
    env.handleTestEvent({ name: 'test_start', test: drop }, state);
    expect(drop.mode).toBe('skip');
    env.handleTestEvent({ name: 'test_start', test: keep }, state);
    expect(keep.mode).toBeUndefined();
    env.handleTestEvent({ name: 'test_done', test: keep }, state);
    expect(out.filter(m => m.type === 'testCoverage')).toHaveLength(1);
    ctx.cancelled = true;
    const late = makeTest('keep', root);
    env.handleTestEvent({ name: 'test_start', test: late }, state);
    expect(late.mode).toBe('skip');
  });

  it('caps console entries per test and throttles value formatting after many hits', () => {
    const { ctx, out } = ctxWith();
    setRunContext(ctx);
    const W = wrapEnvironment(BareEnv, {});
    const fakeConsole = new FakeConsole();
    const env = new W({}, { console: fakeConsole, testPath: '/t/c.test.js' });
    const root: any = { name: 'ROOT', parent: undefined, children: [] };
    const t = makeTest('loud', root); root.children.push(t);
    const state: any = { currentDescribeBlock: root };
    env.handleTestEvent({ name: 'add_test', testName: 'loud', fn: t.fn }, state);
    env.handleTestEvent({ name: 'test_start', test: t }, state);
    for (let i = 0; i < CONSOLE_MAX_PER_TEST + 20; i++) fakeConsole.log('x', i);
    expect(out.filter(m => m.type === 'console')).toHaveLength(CONSOLE_MAX_PER_TEST);
    expect(fakeConsole.buffer).toHaveLength(CONSOLE_MAX_PER_TEST + 20);
    const big = { deep: { a: { b: { c: { d: 'x'.repeat(400) } } } } };
    for (let i = 0; i < VALUE_THROTTLE_PER_MARKER + 1; i++) expect(env.global.__hj_v('/t/c.js', 1, 1, big)).toBe(big);
    const values = out.filter(m => m.type === 'value') as Array<Extract<WorkerToHost, { type: 'value' }>>;
    expect(values).toHaveLength(VALUE_THROTTLE_PER_MARKER + 1);
    expect(values[0].text.length).toBeGreaterThan(256);
    expect(values[VALUE_THROTTLE_PER_MARKER].text.length).toBeLessThanOrEqual(257);
  });

  it('formatValue caps length and survives throwing formatters', () => {
    expect(formatValue('abc', undefined, { maxDepth: 5, maxLength: 100 })).toBe("'abc'");
    expect(formatValue('x'.repeat(50), undefined, { maxDepth: 5, maxLength: 10 })).toHaveLength(11);
    expect(formatValue({ a: 1 }, { format: () => { throw new Error('bad'); } }, { maxDepth: 5, maxLength: 100 })).toBe('[object Object]');
    expect(formatValue([1, 2], { format: v => JSON.stringify(v) }, { maxDepth: 5, maxLength: 100 })).toBe('[1,2]');
  });
});
