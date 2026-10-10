jest.mock('vscode', () => {
  const fake = jest.requireActual('../results/fakeVscode');
  const event = () => ({ dispose() {} });
  return { ...fake, workspace: { ...fake.workspace, onDidChangeTextDocument: event, onDidSaveTextDocument: event, onDidOpenTextDocument: event, onDidCloseTextDocument: event, onDidCreateFiles: event, onDidDeleteFiles: event, onDidRenameFiles: event }, window: { ...fake.window, onDidChangeActiveTextEditor: event, showQuickPick: jest.fn(async (items: any[]) => items[1]) } };
});
jest.mock('../../../src/debug', () => ({ startDebugSession: jest.fn(async () => undefined) }));
import { RunCoordinator } from '../../../src/runner';
import { ResultStore } from '../../../src/results/resultStore';
import { DEFAULT_SETTINGS, type HyperJestSettings } from '../../../src/core/settingsModel';
import { noopLogger } from '../../../src/core/logger';
import { makeTestKey, type RunMsg } from '../../../src/core/protocol';
import { startDebugSession } from '../../../src/debug';
import { makeDocument } from '../results/fakeVscode';
import * as vscode from 'vscode';

const file = '/p/tests/unit/shared.test.js';
const integration = '/p/tests/integration/other.test.js';
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
function setup(options: Partial<HyperJestSettings> = {}, selected = [true, true]) {
  const settings = { ...DEFAULT_SETTINGS, engine: 'warm' as const, smartStart: 'never' as const, snapshots: { updateMode: 'none' as const }, ...options };
  const entries = ['one', 'two'].map((id, index) => ({ spec: { id, selected: selected[index], status: 'ok', displayName: id, packageDir: '/p' }, configsSource: 'worker', readiness: { kind: 'ready' } }));
  let event: (e: any) => void = () => {}, registryEvent: (e: any) => void = () => {};
  const workers = entries.map(e => ({ projectId: e.spec.id, info: { id: e.spec.id, ready: {} }, messages: [] as any[], send(msg: any) { this.messages.push(msg); return true; }, kill() {} }));
  const pool = { on: (cb: any) => { event = cb; return () => {}; }, capacity: () => 2, acquire: async (id: string) => workers.find(w => w.projectId === id), release() {}, killProject() {}, broadcast: jest.fn() };
  const registry = { all: () => entries, get: (id: string) => entries.find(e => e.spec.id === id), projectsFor: () => entries.filter(e => e.spec.selected), projectIdFor: () => entries.find(e => e.spec.selected)?.spec.id,
    onDidChange: (cb: any) => { registryEvent = cb; return { dispose() {} }; }, refresh: async () => registryEvent({ type: 'refreshed', result: { specs: entries.map(e => e.spec), skipped: [] } }),
    resolveMatchers: async () => {}, acceptsTest: (id: string, p: string) => !!entries.find(e => e.spec.id === id)?.spec.selected && p === file, monitorsSource: () => true,
    testFilesOf: async () => [file], isTestFile: (p: string) => p === file, noteReady() {}, setAutoBoot() {}, toolchainFiles: () => new Set<string>(),
  };
  const store = new ResultStore(), runner = new RunCoordinator(pool as any, registry as any, store, () => settings, '/ext/worker', noopLogger);
  const runs = (id: string) => workers.find(w => w.projectId === id)!.messages.filter((m): m is RunMsg => m.type === 'run');
  const complete = (id: string, status: 'passed' | 'failed' = 'passed') => {
    const worker = workers.find(w => w.projectId === id)!, run = runs(id).at(-1)!;
    if (!run) throw new Error(`No run for ${id}`);
    const send = (msg: any) => event({ type: 'message', worker, msg: { v: 1, runId: run.runId, ...msg } });
    send({ type: 'testResult', path: file, testKey: makeTestKey(file, 'shared', 0), fullName: 'shared', ancestorTitles: [], title: 'shared', status, duration: 1, location: { line: 1, column: 1 }, failures: [], invocations: 1 });
    send({ type: 'fileResult', path: file, status, numPassing: status === 'passed' ? 1 : 0, numFailing: status === 'failed' ? 1 : 0, numPending: 0, numTodo: 0 });
    send({ type: 'runComplete', wasInterrupted: false, durationMs: 1, memory: { rss: 0, heapUsed: 0 } });
  };
  return { runner, store, settings, entries, registry, pool, runs, complete, dispose: () => { runner.dispose(); store.dispose(); } };
}

it('runs an overlapping file in both configs, reruns only the failed config, and removes one without losing the other', async () => {
  const t = setup(); await t.runner.start();
  const run = await t.runner.runAll(); await flush();
  expect(t.runs('one')).toHaveLength(1); expect(t.runs('two')).toHaveLength(1);
  t.complete('one', 'failed'); t.complete('two'); await run.done;
  expect(t.store.summary()).toMatchObject({ passed: 1, failed: 1 });
  const rerun = await t.runner.runFailing(); await flush();
  expect(t.runs('one')).toHaveLength(2); expect(t.runs('two')).toHaveLength(1);
  t.complete('one', 'failed'); await rerun.done;
  t.entries[1].spec.selected = false; await t.registry.refresh();
  expect(t.store.summary()).toMatchObject({ passed: 0, failed: 1 });
  expect(t.store.test(makeTestKey(file, 'shared', 0, 'one'))?.status).toBe('failed');
  t.dispose();
});

it('does not restore deselected results when an obsolete active run completes', async () => {
  const t = setup(); await t.runner.start();
  const run = await t.runner.runAll(); await flush();
  t.complete('one', 'failed');
  t.entries[1].spec.selected = false; await t.registry.refresh();
  t.complete('two'); await run.done;
  expect(t.store.allFiles().map(f => f.projectId)).toEqual(['one']);
  expect(t.store.summary()).toMatchObject({ failed: 1, passed: 0 });
  t.dispose();
});

it('replays existing unsaved buffers when a second config is selected', async () => {
  const t = setup({}, [true, false]); await t.runner.start();
  const doc = makeDocument('/p/src/shared.js', 'const value = 7');
  Object.assign(doc, { isDirty: true });
  (vscode.workspace.textDocuments as vscode.TextDocument[]).push(doc);
  try {
    t.entries[1].spec.selected = true; await t.registry.refresh();
    expect(t.runner.overlay.entriesFor('two')[0].text).toBe('const value = 7');
    expect(t.pool.broadcast).toHaveBeenCalledWith('two', expect.objectContaining({ type: 'overlay' }));
    t.runner.docs.update(file, "test('first', () => {});");
    t.runner.docs.markRunBaseline(file, 'one');
    t.runner.docs.update(file, "test('second', () => {});");
    t.runner.docs.markRunBaseline(file, 'two');
    expect(t.runner.docs.baseline(file, 'one')?.text).toContain('first');
    expect(t.runner.docs.baseline(file, 'two')?.text).toContain('second');
  } finally { (vscode.workspace.textDocuments as vscode.TextDocument[]).splice(0); t.dispose(); }
});

it('Smart Start always uses selected configs and manual/never/stopped do not schedule startup runs', async () => {
  expect(DEFAULT_SETTINGS.smartStart).toBe('always');
  for (const options of [{ smartStart: 'always' as const }, { smartStart: 'never' as const }, { smartStart: 'open' as const }, { smartStart: 'always' as const, runMode: 'manual' as const }]) {
    const t = setup(options, [true, false]); await t.runner.start(); await flush();
    expect(t.runs('one')).toHaveLength(options.smartStart === 'always' && options.runMode !== 'manual' ? 1 : 0);
    expect(t.runs('two')).toHaveLength(0);
    if (t.runs('one').length) { t.complete('one'); await flush(); }
    t.runner.stop(); expect((await t.runner.runAll()).notRun).toMatch(/stopped/);
    t.dispose();
  }
});

it('rejects out-of-scope files, broadcasts dirty buffers to both configs and serializes snapshot writers', async () => {
  const t = setup(); await t.runner.start();
  expect((await t.runner.runFiles([{ path: integration }], 'explicit')).notRun).toMatch(/Not matched/);
  const doc = makeDocument('/p/src/shared.js', 'const value = 2');
  Object.assign(doc, { isDirty: true });
  (t.runner.overlay as any).onChange(doc);
  expect(t.pool.broadcast.mock.calls.map(c => c[0])).toEqual(['one', 'two']);
  expect(t.runner.overlay.entriesFor('two')[0].text).toBe('const value = 2');
  const run = await t.runner.runFiles([{ path: file }], 'explicit', { updateSnapshot: 'all' }); await flush();
  expect(t.runs('one').length + t.runs('two').length).toBe(1);
  const first = t.runs('one').length ? 'one' : 'two', second = first === 'one' ? 'two' : 'one';
  t.complete(first); await flush(); expect(t.runs(second)).toHaveLength(1);
  t.complete(second); await run.done; t.dispose();
});

it('keeps Explorer targets and asks for a config when debugging an ambiguous editor file', async () => {
  const t = setup(); await t.runner.start();
  const run = await t.runner.runFiles([{ path: file, projectId: 'two' }], 'explicit'); await flush();
  expect(t.runs('one')).toHaveLength(0); t.complete('two'); await run.done;
  const snapshots = await t.runner.updateSnapshots({ kind: 'project', projectId: 'two' }); await flush();
  expect(t.runs('one')).toHaveLength(0); t.complete('two'); await snapshots.done;
  await t.runner.debug({ path: file }); await flush();
  expect(startDebugSession).toHaveBeenCalledWith(expect.objectContaining({ spec: expect.objectContaining({ id: 'two' }) }));
  t.complete('two'); await flush(); t.dispose();
});
