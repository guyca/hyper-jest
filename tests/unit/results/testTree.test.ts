// NOTE: VS Code forbids \0 in TestItem ids; TestExplorer maps the \0 separator to \u001f for item ids.
jest.mock('vscode', () => require('./fakeVscode'));

import * as vscode from 'vscode';
import { __state, findItem, FakeTestController, FakeTestRun } from './fakeVscode';
import { ResultStore } from '../../../src/results/resultStore';
import { TestExplorer, messagesFor, recordParsed } from '../../../src/testTree';
import type { RunnerApi, RunHandle, RunnerState, SnapshotScope } from '../../../src/runnerApi';
import type { ProjectSpec, RunTestSelection } from '../../../src/core/protocol';
import { DEFAULT_SETTINGS } from '../../../src/core/settingsModel';
import { noopLogger } from '../../../src/core/logger';
import { PROJECT, SPEC, SRC, T, key, applyFullRun, parsedMathSpec, fileStart, testStart, testResult, fileResult, testCoverage, coverageMeta, node, range } from './fixtures';

const spec: ProjectSpec = {
  id: PROJECT, displayName: 'pkg', repoRoot: '/repo', packageDir: '/repo/pkg', flavor: 'implicit', status: 'ok',
  jestVersion: '29.7.0', nodeVersion: 'v24.19.0', nodeArgs: [], env: {}, cliFilters: { testPathIgnorePatterns: [] }, e2ePatterns: [], warnings: [],
};

class FakeRunner implements RunnerApi {
  calls: Array<{ kind: string; arg: unknown }> = [];
  resolveDone: (() => void) | undefined;
  private state: RunnerState = { started: true, running: false, paused: false, runMode: 'onType', activeRuns: 0, queuedFiles: 0 };
  private handle(): RunHandle {
    return { runId: 'rx', done: new Promise<{ wasInterrupted: boolean }>(resolve => { this.resolveDone = () => resolve({ wasInterrupted: false }); }) };
  }
  async runFiles(selections: RunTestSelection[], reason: string, opts?: unknown) { this.calls.push({ kind: 'runFiles', arg: { selections, reason, opts } }); return this.handle(); }
  async runTests(testKeys: string[]) { this.calls.push({ kind: 'runTests', arg: testKeys }); return this.handle(); }
  async debug(selection: RunTestSelection) { this.calls.push({ kind: 'debug', arg: selection }); }
  async updateSnapshots(scope: SnapshotScope) { this.calls.push({ kind: 'updateSnapshots', arg: scope }); return this.handle(); }
  cancel(runId: string | 'all') { this.calls.push({ kind: 'cancel', arg: runId }); }
  pause() { this.state.paused = true; }
  resume() { this.state.paused = false; }
  getState() { return this.state; }
  onDidChangeState() { return { dispose() { /* noop */ } }; }
  watch(selections: RunTestSelection[]) { this.calls.push({ kind: 'watch', arg: selections }); }
}

function setup() {
  const timers: Array<() => void> = [];
  const store = new ResultStore({ setTimer: fn => { timers.push(fn); return 1; }, clearTimer: () => { timers.length = 0; } });
  const runner = new FakeRunner();
  const resolved: unknown[] = [];
  const explorer = new TestExplorer({
    store, runner, settings: () => DEFAULT_SETTINGS, log: noopLogger,
    resolveChildren: target => { resolved.push(target); },
    setTimer: fn => { timers.push(fn); return 2; }, clearTimer: () => undefined,
  });
  const controller = explorer.controller as unknown as FakeTestController;
  const flush = () => { store.flush(); const fns = timers.splice(0); for (const f of fns) f(); };
  return { store, runner, explorer, controller, resolved, flush, timers };
}

beforeEach(() => __state.reset());

describe('TestExplorer tree', () => {
  it('creates the controller, four profiles and lazy project/file items', async () => {
    const { explorer, controller, resolved } = setup();
    expect(controller.id).toBe('hyperjest');
    expect(controller.label).toBe('HyperJest');
    expect(controller.profiles.map(p => [p.label, p.kind, p.isDefault, p.supportsContinuousRun])).toEqual([
      ['Run', vscode.TestRunProfileKind.Run, true, true],
      ['Debug', vscode.TestRunProfileKind.Debug, false, false],
      ['Run with Coverage', vscode.TestRunProfileKind.Coverage, false, false],
      ['Update Snapshots', vscode.TestRunProfileKind.Run, false, false],
    ]);
    expect(controller.profiles[2].loadDetailedCoverage).toBeDefined();
    expect(controller.profiles[2].loadDetailedCoverageForTest).toBeDefined();
    const project = explorer.buildProjectItem(spec);
    expect(project.description).toBe('implicit · jest 29.7.0 · node v24.19.0');
    expect(project.canResolveChildren).toBe(true);
    explorer.setProjectFiles(PROJECT, [SPEC, '/repo/pkg/src/__tests__/greet.test.js']);
    expect(project.children.size).toBe(2);
    const fileItem = explorer.itemForFile(SPEC)!;
    expect(fileItem.id).toBe(`${PROJECT}\u001fsrc/__tests__/math.test.js`);
    expect(fileItem.label).toBe('src/__tests__/math.test.js');
    expect(fileItem.canResolveChildren).toBe(true);
    await controller.resolveHandler(undefined);
    await controller.resolveHandler(project);
    await controller.resolveHandler(fileItem);
    expect(resolved).toEqual([{ kind: 'root' }, { kind: 'project', projectId: PROJECT }, { kind: 'file', projectId: PROJECT, path: SPEC }]);
    explorer.buildProjectItem({ ...spec, id: 'p2', displayName: 'broken', status: 'unavailable', reason: 'no node_modules' });
    expect(findItem(controller.items, 'p2').error).toBe('unavailable: no node_modules');
    explorer.setProjectFiles(PROJECT, [SPEC]);
    expect(project.children.size).toBe(1);
    explorer.dispose();
    expect(controller.disposed).toBe(true);
  });

  it('builds describe/test children from the parsed tree and handles parse errors', () => {
    const { explorer, controller, store } = setup();
    explorer.buildProjectItem(spec);
    explorer.setFileParsed(PROJECT, SPEC, parsedMathSpec());
    expect(store.parsed(SPEC)).toBeDefined();
    const fileItem = explorer.itemForFile(SPEC)!;
    expect(fileItem.canResolveChildren).toBe(false);
    expect(fileItem.children.size).toBe(3);
    const add = findItem(controller.items, `${PROJECT}\u001fsrc/__tests__/math.test.js\u001fdescribe:add`);
    expect(add.children.size).toBe(2);
    const addTwo = findItem(controller.items, `${PROJECT}\u001fsrc/__tests__/math.test.js\u001fdescribe:add\u001ftest:adds two numbers`);
    expect(addTwo.range.start.line).toBe(3);
    const each = findItem(controller.items, `${PROJECT}\u001fsrc/__tests__/math.test.js\u001fdescribe:classify\u001ftest:classify(%i) -> %s`);
    expect(each.description).toBe('.each');
    expect(findItem(controller.items, `${PROJECT}\u001fsrc/__tests__/math.test.js\u001fdescribe:classify\u001ftest:skipped test`).description).toBe('skip');
    explorer.setFileParsed(PROJECT, SPEC, { ...parsedMathSpec(), nodes: [], parseError: { message: 'Unexpected token', line: 5, column: 3 } });
    expect(fileItem.error).toBe('Parse error at 5:3: Unexpected token');
    expect(fileItem.children.size).toBe(3); // previous children kept
    // ... and so does the store: declaration icons, cameras and gutter menus keep the last good tree.
    expect(store.parsed(SPEC)!.nodes.length).toBe(3);
    expect(store.parsed(SPEC)!.parseError).toBeUndefined();
    explorer.setFileNotMatched(SPEC, true);
    expect(fileItem.description).toContain('not matched');
  });

  it('recordParsed keeps the last good parse on an unrecoverable syntax error only', () => {
    const store = new ResultStore();
    const broken = { ...parsedMathSpec(), nodes: [], parseError: { message: 'Unexpected token', line: 5, column: 3 } };
    recordParsed(store, SPEC, broken);
    expect(store.parsed(SPEC)).toBe(broken); // nothing better known yet
    const good = parsedMathSpec();
    recordParsed(store, SPEC, good);
    recordParsed(store, SPEC, broken);
    expect(store.parsed(SPEC)).toBe(good);
    const recovered = { ...parsedMathSpec(), parseError: { message: 'Missing semicolon', line: 2, column: 1 } };
    recordParsed(store, SPEC, recovered);
    expect(store.parsed(SPEC)).toBe(recovered); // errorRecovery still produced a tree
  });

  it('maps any item back to its project and lists/removes project items', () => {
    const { explorer, controller } = setup();
    const project = explorer.buildProjectItem(spec);
    explorer.buildProjectItem({ ...spec, id: 'other', displayName: 'other', packageDir: '/repo/other' });
    explorer.setProjectFiles(PROJECT, [SPEC]);
    explorer.setFileParsed(PROJECT, SPEC, parsedMathSpec());
    const fileItem = explorer.itemForFile(SPEC)!;
    const addTwo = findItem(controller.items, `${PROJECT}\u001fsrc/__tests__/math.test.js\u001fdescribe:add\u001ftest:adds two numbers`);
    expect(explorer.projectIdFor(project)).toBe(PROJECT);
    expect(explorer.projectIdFor(fileItem)).toBe(PROJECT);
    expect(explorer.projectIdFor(addTwo)).toBe(PROJECT);
    expect(explorer.projectIds().sort()).toEqual([PROJECT, 'other'].sort());
    explorer.removeProject('other');
    expect(explorer.projectIds()).toEqual([PROJECT]);
  });

  it('reconciles results: .each rows, runtime-only items, not-registered descriptions, invalidation', () => {
    const { explorer, controller, store, flush } = setup();
    explorer.buildProjectItem(spec);
    explorer.setFileParsed(PROJECT, SPEC, parsedMathSpec());
    applyFullRun(store, 'r1');
    flush();
    const each = findItem(controller.items, `${PROJECT}\u001fsrc/__tests__/math.test.js\u001fdescribe:classify\u001ftest:classify(%i) -> %s`);
    expect(each.children.all().map((c: vscode.TestItem) => c.label).sort()).toEqual(['classify(-5) -> negative', 'classify(0) -> zero']);
    expect(explorer.itemForTestKey(key(T.eachNeg))!.parent).toBe(each);
    expect(explorer.itemForTestKey(key(T.addTwo))!.id).toBe(`${PROJECT}\u001fsrc/__tests__/math.test.js\u001fdescribe:add\u001ftest:adds two numbers`);
    // A narrowed run reports a helper-generated test the parser never saw.
    store.registerRun('r1b', [{ path: SPEC, names: ['classify helper generated'] }]);
    store.apply(fileStart('r1b'), PROJECT);
    store.apply(testResult('r1b', 'classify helper generated', 'passed', { line: 2 }), PROJECT);
    store.apply(fileResult('r1b', 'passed'), PROJECT);
    flush();
    const runtimeOnly = explorer.itemForTestKey(key('classify helper generated'))!;
    expect(runtimeOnly.description).toBe('runtime only');
    // ancestorTitles ['classify'] match the static describe: the item nests under it, not the file.
    expect(runtimeOnly.parent).toBe(findItem(controller.items, `${PROJECT}\u001fsrc/__tests__/math.test.js\u001fdescribe:classify`));
    expect(runtimeOnly.id).toBe(`${PROJECT}\u001fsrc/__tests__/math.test.js\u001fdescribe:classify\u001ftest:helper generated`);
    expect(explorer.itemForTestKey(key(T.divides))).toBeDefined();
    // An unfiltered run without 'adds negative numbers': the static node was never registered and
    // the runtime-only test disappeared.
    applyFullRun(store, 'r2', { includeAddNeg: false });
    flush();
    expect(explorer.itemForTestKey(key('classify helper generated'))).toBeUndefined();
    expect(explorer.itemForTestKey(key(T.addNeg))).toBeUndefined();
    const addNeg = findItem(controller.items, `${PROJECT}\u001fsrc/__tests__/math.test.js\u001fdescribe:add\u001ftest:adds negative numbers`);
    expect(addNeg.description).toBe('not registered');
    applyFullRun(store, 'r3');
    flush();
    expect(addNeg.description).toBeUndefined();
    store.markStale(SPEC);
    flush();
    expect(controller.invalidated).toHaveLength(1);
    expect(controller.invalidated[0]).toBe(explorer.itemForFile(SPEC));
    store.markStale(SPEC);
    flush();
    expect(controller.invalidated).toHaveLength(1);
  });

  it('nests runtime-only tests under intermediate runtime describes, selects and prunes them', () => {
    const { explorer, controller, store, flush } = setup();
    explorer.buildProjectItem(spec);
    explorer.setFileParsed(PROJECT, SPEC, parsedMathSpec());
    const name = 'classify helpers deep generated';
    store.registerRun('r1', [{ path: SPEC, names: [name] }]);
    store.apply(fileStart('r1'), PROJECT);
    store.apply({ ...testResult('r1', name, 'passed', { line: 2 }), ancestorTitles: ['classify', 'helpers', 'deep'], title: 'generated' }, PROJECT);
    store.apply(fileResult('r1', 'passed'), PROJECT);
    flush();
    const base = `${PROJECT}\u001fsrc/__tests__/math.test.js`;
    const classify = findItem(controller.items, `${base}\u001fdescribe:classify`);
    const helpers = findItem(controller.items, `${base}\u001fdescribe:classify\u001fdescribe:helpers`);
    expect(helpers.parent).toBe(classify);
    expect(helpers.description).toBe('runtime only');
    const deep = helpers.children.get(`${base}\u001fdescribe:classify\u001fdescribe:helpers\u001fdescribe:deep`);
    const item = explorer.itemForTestKey(key(name))!;
    expect(item.parent).toBe(deep);
    expect(item.label).toBe('generated');
    expect(item.range!.start.line).toBe(1);
    expect(explorer.selectionsFor([helpers])).toEqual([{ path: SPEC, names: [name] }]);
    expect(explorer.selectionsFor([classify])).toEqual([{ path: SPEC }]); // .each rows unknown yet -> whole file
    expect(explorer.testKeysFor(helpers)).toEqual([key(name)]);
    // No "not registered" after a narrowed run.
    expect(findItem(controller.items, `${base}\u001fdescribe:add\u001ftest:adds two numbers`).description).toBeUndefined();
    // An unfiltered run without it prunes the whole runtime subtree.
    applyFullRun(store, 'r2');
    flush();
    expect(classify.children.get(`${base}\u001fdescribe:classify\u001fdescribe:helpers`)).toBeUndefined();
    expect(explorer.itemForTestKey(key(name))).toBeUndefined();
    expect(explorer.selectionsFor([classify])).toEqual([{ path: SPEC, names: [T.eachNeg, T.eachZero, T.positive, T.skipped, T.todo] }]);
  });

  it('builds a runtime tree from ancestorTitles when the file has not been parsed', () => {
    const { explorer, controller, store, flush } = setup();
    explorer.buildProjectItem(spec);
    explorer.setProjectFiles(PROJECT, [SPEC]);
    applyFullRun(store, 'r1');
    flush();
    const base = `${PROJECT}\u001fsrc/__tests__/math.test.js`;
    const add = findItem(controller.items, `${base}\u001fdescribe:add`);
    expect(add.children.size).toBe(2);
    expect(add.description).toBeUndefined(); // nothing to compare against: no "runtime only" noise
    const item = explorer.itemForTestKey(key(T.addTwo))!;
    expect(item.id).toBe(`${base}\u001fdescribe:add\u001ftest:adds two numbers`);
    expect(item.parent).toBe(add);
    expect(explorer.selectionsFor([add])).toEqual([{ path: SPEC, names: [T.addTwo, T.addNeg] }]);
    expect(explorer.itemForFile(SPEC)!.children.size).toBe(3);
    // Parsing later replaces the runtime tree with parsed items carrying the same ids.
    explorer.setFileParsed(PROJECT, SPEC, parsedMathSpec());
    expect(explorer.itemForTestKey(key(T.addTwo))!.range!.start.line).toBe(3);
    expect(findItem(controller.items, `${base}\u001fdescribe:add`).children.size).toBe(2);
    expect(explorer.itemForTestKey(key(T.eachNeg))!.parent!.id).toBe(`${base}\u001fdescribe:classify\u001ftest:classify(%i) -> %s`);
  });

  it('labels describe.each rows with the runtime suite title and keeps duplicate static tests apart', () => {
    const { explorer, controller, store, flush } = setup();
    explorer.buildProjectItem(spec);
    const parsed = parsedMathSpec();
    parsed.nodes = [
      node('describe', 'suite %s', range(0, 5, 0, 3), { each: true, children: [node('test', 'inner', range(1, 3))] }),
      node('describe', 'dup', range(6, 10, 0, 3), { children: [node('test', 'same', range(7, 7)), node('test', 'same', range(8, 8), { dupIndex: 1 })] }),
    ];
    explorer.setFileParsed(PROJECT, SPEC, parsed);
    store.apply(fileStart('r1'), PROJECT);
    store.apply({ ...testResult('r1', 'suite 1 inner', 'passed', { line: 2 }), ancestorTitles: ['suite 1'], title: 'inner' }, PROJECT);
    store.apply({ ...testResult('r1', 'suite 2 inner', 'failed', { line: 2, failures: [{ message: 'nope', frames: [] }] }), ancestorTitles: ['suite 2'], title: 'inner' }, PROJECT);
    store.apply(testResult('r1', 'dup same', 'passed', { line: 8, dup: 0 }), PROJECT);
    store.apply(testResult('r1', 'dup same', 'failed', { line: 9, dup: 1, failures: [{ message: 'second', frames: [] }] }), PROJECT);
    store.apply(fileResult('r1', 'failed'), PROJECT);
    flush();
    const base = `${PROJECT}\u001fsrc/__tests__/math.test.js`;
    const inner = findItem(controller.items, `${base}\u001fdescribe:suite %s\u001ftest:inner`);
    expect(inner.children.all().map((c: vscode.TestItem) => c.label)).toEqual(['suite 1 inner', 'suite 2 inner']);
    expect(explorer.itemForTestKey(key('suite 2 inner'))!.id).toBe(`${base}\u001fdescribe:suite %s\u001ftest:inner\u001frow:suite 2 inner`);
    expect(explorer.itemForTestKey(key('dup same', 0))!.id).toBe(`${base}\u001fdescribe:dup\u001ftest:same`);
    expect(explorer.itemForTestKey(key('dup same', 1))!.id).toBe(`${base}\u001fdescribe:dup\u001ftest:same#1`);
    expect(explorer.itemForTestKey(key('dup same', 1))!.label).toBe('same #2');
    const live = controller.runs[0] as FakeTestRun;
    expect(live.of('failed').map(e => e.id)).toEqual([`${base}\u001fdescribe:suite %s\u001ftest:inner\u001frow:suite 2 inner`, `${base}\u001fdescribe:dup\u001ftest:same#1`]);
    expect(explorer.selectionsFor([explorer.itemForFile(SPEC)!.children.get(`${base}\u001fdescribe:dup`)!])).toEqual([{ path: SPEC, names: ['dup same'] }]);
  });

  it('computes run selections for projects, files, describes, tests and .each rows', () => {
    const { explorer, controller, store, flush } = setup();
    const project = explorer.buildProjectItem(spec);
    explorer.setProjectFiles(PROJECT, [SPEC, '/repo/pkg/src/__tests__/greet.test.js']);
    explorer.setFileParsed(PROJECT, SPEC, parsedMathSpec());
    const base = `${PROJECT}\u001fsrc/__tests__/math.test.js`;
    expect(explorer.selectionsFor([project])).toEqual([{ path: SPEC }, { path: '/repo/pkg/src/__tests__/greet.test.js' }]);
    expect(explorer.selectionsFor([explorer.itemForFile(SPEC)!])).toEqual([{ path: SPEC }]);
    expect(explorer.selectionsFor([findItem(controller.items, `${base}\u001fdescribe:add`)])).toEqual([{ path: SPEC, names: [T.addTwo, T.addNeg] }]);
    // `.each` without runtime rows cannot be named statically -> whole file.
    expect(explorer.selectionsFor([findItem(controller.items, `${base}\u001fdescribe:classify`)])).toEqual([{ path: SPEC }]);
    applyFullRun(store, 'r1');
    flush();
    expect(explorer.selectionsFor([findItem(controller.items, `${base}\u001fdescribe:classify\u001ftest:classify(%i) -> %s`)])).toEqual([{ path: SPEC, names: [T.eachNeg, T.eachZero] }]);
    expect(explorer.selectionsFor([explorer.itemForTestKey(key(T.eachZero))!])).toEqual([{ path: SPEC, names: [T.eachZero] }]);
    expect(explorer.selectionsFor([findItem(controller.items, `${base}\u001fdescribe:add`)], [findItem(controller.items, `${base}\u001fdescribe:add\u001ftest:adds two numbers`)])).toEqual([{ path: SPEC, names: [T.addNeg] }]);
    expect(explorer.testKeysFor(findItem(controller.items, `${base}\u001fdescribe:add`)).sort()).toEqual([key(T.addNeg), key(T.addTwo)].sort());
    expect(explorer.testKeysFor(explorer.itemForFile(SPEC)!)).toHaveLength(9);
  });
});

describe('profiles and live runs', () => {
  it('Run profile enqueues, delegates to the runner, publishes results into the explicit run and ends it', async () => {
    const { explorer, controller, store, runner, flush } = setup();
    explorer.buildProjectItem(spec);
    explorer.setFileParsed(PROJECT, SPEC, parsedMathSpec());
    const fileItem = explorer.itemForFile(SPEC)!;
    const request = new vscode.TestRunRequest([fileItem], undefined, controller.profiles[0]);
    const token = new vscode.CancellationTokenSource().token;
    const pending = controller.profiles[0].runHandler(request, token) as Promise<void>;
    await Promise.resolve();
    await Promise.resolve();
    expect(runner.calls[0]).toMatchObject({ kind: 'runFiles', arg: { selections: [{ path: SPEC }], reason: 'explicit', opts: { updateSnapshot: 'new', priority: 0 } } });
    const run = controller.runs[0] as FakeTestRun;
    expect(run.isPersisted).toBe(true);
    expect(run.of('enqueued').length).toBe(8); // every leaf item of the file
    applyFullRun(store, 'r1');
    flush();
    expect(run.of('passed').length).toBe(6);
    expect(run.of('failed').length).toBe(1);
    const failed = run.of('failed')[0];
    expect(failed.id).toContain('positive numbers');
    expect(failed.message[0]).toMatchObject({ expectedOutput: 'positiv', actualOutput: 'positive' });
    expect(failed.message[0].location.uri.fsPath).toBe(SPEC);
    expect(failed.message[0].location.range.line).toBe(32);
    expect(failed.message[0].stackTrace).toHaveLength(2);
    expect(run.of('skipped').length).toBe(2);
    expect(controller.runs).toHaveLength(1); // no separate live run while the explicit run covers the file
    runner.resolveDone!();
    await pending;
    expect(run.ended).toBe(true);
  });

  it('continuous requests hand the selections to runner.watch without creating a run', async () => {
    const { explorer, controller, runner } = setup();
    explorer.buildProjectItem(spec);
    explorer.setFileParsed(PROJECT, SPEC, parsedMathSpec());
    const request = new vscode.TestRunRequest([explorer.itemForFile(SPEC)!], undefined, controller.profiles[0], true);
    await controller.profiles[0].runHandler(request, new vscode.CancellationTokenSource().token);
    expect(runner.calls).toEqual([{ kind: 'watch', arg: [{ path: SPEC }] }]);
    expect(controller.runs).toHaveLength(0);
  });

  it('Debug and Update Snapshots profiles call the runner accordingly; cancellation forwards', async () => {
    const { explorer, controller, runner } = setup();
    explorer.buildProjectItem(spec);
    explorer.setFileParsed(PROJECT, SPEC, parsedMathSpec());
    const item = findItem(controller.items, `${PROJECT}\u001fsrc/__tests__/math.test.js\u001fdescribe:add\u001ftest:adds two numbers`);
    await controller.profiles[1].runHandler(new vscode.TestRunRequest([item]), new vscode.CancellationTokenSource().token);
    expect(runner.calls[0]).toEqual({ kind: 'debug', arg: { path: SPEC, names: [T.addTwo] } });
    expect(controller.runs[0].ended).toBe(true);
    const cts = new vscode.CancellationTokenSource();
    const pending = controller.profiles[3].runHandler(new vscode.TestRunRequest([item]), cts.token) as Promise<void>;
    await Promise.resolve();
    await Promise.resolve();
    expect(runner.calls[1]).toEqual({ kind: 'updateSnapshots', arg: { kind: 'selection', selections: [{ path: SPEC, names: [T.addTwo] }] } });
    cts.cancel();
    expect(runner.calls[2]).toEqual({ kind: 'cancel', arg: 'rx' });
    runner.resolveDone!();
    await pending;
  });

  it('Coverage profile adds FileCoverage with includesTests and serves detailed + per-test coverage', async () => {
    const { explorer, controller, store, runner, flush } = setup();
    explorer.buildProjectItem(spec);
    explorer.setFileParsed(PROJECT, SPEC, parsedMathSpec());
    const pending = controller.profiles[2].runHandler(new vscode.TestRunRequest([explorer.itemForFile(SPEC)!]), new vscode.CancellationTokenSource().token) as Promise<void>;
    await Promise.resolve();
    await Promise.resolve();
    applyFullRun(store, 'r1');
    flush();
    runner.resolveDone!();
    await pending;
    const run = controller.runs[0] as FakeTestRun;
    const cov = run.of('coverage');
    expect(cov).toHaveLength(1);
    const fc = cov[0].coverage as vscode.FileCoverage;
    expect(fc.uri.fsPath).toBe(SRC);
    expect(fc.statementCoverage).toEqual({ covered: 9, total: 10 });
    expect(fc.branchCoverage).toEqual({ covered: 6, total: 6 });
    expect(fc.includesTests!.length).toBe(7);
    const details = explorer.loadDetailedCoverage(fc, undefined) as vscode.StatementCoverage[];
    expect(details).toHaveLength(10);
    expect(details[0].executed).toBe(3); // s0: two tests + the file-level union
    expect(details[9].executed).toBe(0);
    expect((details[1].location as vscode.Range).start.line).toBe(5);
    expect(details[1].branches).toHaveLength(2);
    const perTest = explorer.loadDetailedCoverage(fc, explorer.itemForTestKey(key(T.positive))!) as vscode.StatementCoverage[];
    expect(perTest.map(d => d.executed)).toEqual([0, 0, 0, 0, 1, 0, 1, 0, 1, 0]);
    expect(perTest[4].branches).toHaveLength(0);
    expect(explorer.loadDetailedCoverage(new vscode.FileCoverage(vscode.Uri.file('/nope.js'), new vscode.TestCoverageCount(0, 0)), undefined)).toEqual([]);
  });

  it('mirrors store changes into a transient live run that ends when idle', () => {
    const { explorer, controller, store, flush, timers } = setup();
    explorer.buildProjectItem(spec);
    explorer.setFileParsed(PROJECT, SPEC, parsedMathSpec());
    store.markQueued(SPEC, PROJECT);
    flush();
    const live = controller.runs[0] as FakeTestRun;
    expect(live.name).toBe('HyperJest live');
    expect(live.isPersisted).toBe(false);
    expect(live.of('enqueued').length).toBe(8);
    store.apply(fileStart('r1'), PROJECT);
    store.apply(testStart('r1', T.addTwo), PROJECT);
    store.apply(coverageMeta(), PROJECT);
    store.apply(testCoverage('r1', T.addTwo, [0]), PROJECT);
    store.apply(testResult('r1', T.addTwo, 'passed', { line: 4, duration: 7 }), PROJECT);
    flush();
    expect(live.of('passed')).toEqual([{ kind: 'passed', id: `${PROJECT}\u001fsrc/__tests__/math.test.js\u001fdescribe:add\u001ftest:adds two numbers`, duration: 7 }]);
    // Idle check: still running -> not ended.
    expect(live.ended).toBe(false);
    store.apply(fileResult('r1', 'passed'), PROJECT);
    flush();
    expect(live.ended).toBe(true);
    expect(explorer.live.currentLiveRun).toBeUndefined();
    // A later change opens a fresh live run; errored files report on the file item.
    store.apply(fileStart('r2'), PROJECT);
    store.apply(fileResult('r2', 'errored', { testExecError: { message: 'SyntaxError', frames: [{ file: SPEC, line: 1, column: 1 }] } }), PROJECT);
    flush();
    const live2 = controller.runs[1] as FakeTestRun;
    expect(live2.of('errored')[0].id).toBe(explorer.itemForFile(SPEC)!.id);
    expect(timers.length).toBe(0);
    explorer.dispose();
  });

  it('messagesFor builds diff/location/stack messages', () => {
    const store = new ResultStore();
    applyFullRun(store, 'r1');
    const msgs = messagesFor(store.test(key(T.positive))!);
    expect(msgs[0].expectedOutput).toBe('positiv');
    expect(msgs[0].stackTrace![1].label).toBe('utils.js');
    const plain = messagesFor({ ...store.test(key(T.addTwo))!, status: 'failed', failures: [] });
    expect((plain[0].message as string)).toContain('failed');
    expect(plain[0].location!.uri.fsPath).toBe(SPEC);
  });
});
