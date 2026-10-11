/* eslint-disable @typescript-eslint/no-explicit-any */
jest.mock('vscode', () => {
  const f = jest.requireActual('./fakeVscode');
  const registered = new Map<string, (...args: any[]) => any>();
  class Selection extends f.Range {
    constructor(public readonly anchor: any, public readonly active: any) { super(anchor, active); }
  }
  return {
    ...f,
    Selection,
    TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
    __registered: registered,
    window: {
      ...f.window,
      showInformationMessage: jest.fn(async () => undefined),
      showWarningMessage: jest.fn(async () => undefined),
      showErrorMessage: jest.fn(async () => undefined),
      showQuickPick: jest.fn(async () => undefined),
      setStatusBarMessage: jest.fn(),
    },
    workspace: { ...f.workspace, workspaceFolders: [] },
    commands: {
      ...f.commands,
      registerCommand: (id: string, cb: (...args: any[]) => any) => { registered.set(id, cb); return new f.Disposable(() => registered.delete(id)); },
    },
  };
});

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { __state, FakeTestController, makeDocument, makeEditor } from './fakeVscode';
import { ResultStore } from '../../../src/results/resultStore';
import { registerCommands, isTestItem, testItemOf, overrideTargets, type CommandDeps } from '../../../src/commands';
import { ConfigCache } from '../../../src/discovery/configCache';
import { DEFAULT_SETTINGS, type HyperJestSettings, type ProjectOverride } from '../../../src/core/settingsModel';
import { PROJECT, SPEC, SRC, T, key, applyFullRun, parsedMathSpec } from './fixtures';

const v = vscode as any;
const registered: Map<string, (...args: any[]) => any> = v.__registered;
const run = (id: string, ...args: unknown[]) => registered.get(id)!(...args);

class MemoryMemento {
  readonly values = new Map<string, unknown>();
  keys() { return [...this.values.keys()]; }
  get<T>(k: string, dflt?: T): T | undefined { return this.values.has(k) ? (this.values.get(k) as T) : dflt; }
  async update(k: string, value: unknown) { if (value === undefined) this.values.delete(k); else this.values.set(k, value); }
}

const spec = (id: string, packageDir: string, configArg?: string, flavor = 'script-config') => ({
  id, displayName: id, packageDir, configArg, flavor, status: 'ok', jestVersion: '29.7.0', env: {},
});

function setup(opts: { projects?: ProjectOverride[]; entries?: any[] } = {}) {
  registered.clear();
  const store = new ResultStore();
  store.setParsed(SPEC, parsedMathSpec());
  applyFullRun(store, 'r1');
  const runnerCalls: Array<[string, unknown]> = [];
  const handles: { next: any } = { next: { runId: 'g1', done: Promise.resolve({ wasInterrupted: false }) } };
  const runner: any = {
    runProject: async (id: string) => { runnerCalls.push(['runProject', id]); return handles.next; },
    runFiles: async (sels: unknown) => { runnerCalls.push(['runFiles', sels]); return handles.next; },
    updateSnapshots: async (scope: unknown) => { runnerCalls.push(['updateSnapshots', scope]); },
    runTests: async (keys: unknown) => { runnerCalls.push(['runTests', keys]); },
    docs: { ensure: () => parsedMathSpec(), lookupAtLine: (_path: string, line: number) => ({ parsed: parsedMathSpec(), line }) },
    getState: () => ({ started: true, running: false, paused: false, runMode: 'onType' }),
    relearnOpenDocuments: jest.fn(),
  };
  const entries = opts.entries ?? [{ spec: spec(PROJECT, '/repo/pkg') }];
  const registry: any = {
    all: () => entries,
    get: (id: string) => entries.find(e => e.spec.id === id),
    projectFor: (p: string) => entries.find(e => p.startsWith(e.spec.packageDir)),
    projectsFor: (p: string) => entries.filter(e => p.startsWith(e.spec.packageDir) && e.spec.selected !== false),
    isTestFile: (p: string) => p.endsWith('.test.js'),
    clearConfigCache: jest.fn(),
  };
  let current: HyperJestSettings = { ...DEFAULT_SETTINGS, projects: opts.projects ?? [] };
  const updates: Array<[string, unknown]> = [];
  const settings: any = { get: () => current, update: async (k: string, value: unknown) => { updates.push([k, value]); current = { ...current, [k]: value }; } };
  const memento = new MemoryMemento();
  const killed: string[] = [];
  const diffShown: string[] = [];
  const explorer = {
    selectionsFor: jest.fn((_items: readonly vscode.TestItem[]) => [{ path: SPEC, names: [T.addTwo] }]),
    testKeysFor: jest.fn((_item: vscode.TestItem) => [key(T.addTwo), key(T.positive)]),
    projectIdFor: jest.fn((_item: vscode.TestItem) => PROJECT),
  };
  const deps: CommandDeps = {
    context: { globalState: memento, extension: { packageJSON: { version: '0.0.0' } } } as any,
    runner, registry, store, settings,
    pool: { killProject: (id: string) => killed.push(id) } as any,
    log: { error: () => undefined, show: () => undefined } as any,
    doctor: {} as any,
    diff: { showDiff: async (k: string) => { diffShown.push(k); } } as any,
    workerAssetsDir: '/x',
    clearInline: () => undefined,
    toggleCoverage: () => undefined,
    explorer: () => explorer,
  };
  registerCommands(deps);
  return { store, runner, runnerCalls, handles, updates, memento, killed, diffShown, explorer, entries, registry, settings: () => current };
}

function specEditor(): any {
  const editor: any = makeEditor(makeDocument(SPEC, 'x'));
  editor.selection = new v.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));
  return editor;
}

/** A TestItem as the Explorer creates it (the context menus hand back these objects). */
function testItem(id: string, label = id): vscode.TestItem {
  return new FakeTestController('hyperjest', 'HyperJest').createTestItem(id, label, vscode.Uri.file(SPEC));
}

beforeEach(() => {
  __state.reset();
  v.window.activeTextEditor = undefined;
  v.window.visibleTextEditors = [];
  for (const fn of ['showInformationMessage', 'showWarningMessage', 'showQuickPick']) v.window[fn].mockReset().mockImplementation(async () => undefined);
});

describe('Test Explorer command arguments', () => {
  it('recognises TestItems and { test, message } context args', () => {
    const item = testItem('a');
    expect(isTestItem(item)).toBe(true);
    expect(isTestItem({ lineNumber: 1, uri: vscode.Uri.file(SPEC) })).toBe(false);
    expect(testItemOf({ test: item, message: new vscode.TestMessage('x') })).toBe(item);
    expect(testItemOf({ testKey: 'k' })).toBeUndefined();
  });

  it('Update Test Snapshots on an Explorer item updates that item, not the active editor', async () => {
    const t = setup();
    v.window.activeTextEditor = specEditor();
    const item = testItem('item-1');
    await run('hyperjest.updateTestSnapshots', item);
    expect(t.explorer.selectionsFor).toHaveBeenCalledWith([item]);
    expect(t.runnerCalls).toEqual([['updateSnapshots', { kind: 'selection', selections: [{ path: SPEC, names: [T.addTwo] }] }]]);
  });

  it('Update Test Snapshots uses the mapped line and skips an unmappable line', async () => {
    const t = setup();
    t.runner.docs.lookupAtLine = jest.fn(() => ({ parsed: parsedMathSpec(), line: 3 }));
    await run('hyperjest.updateTestSnapshots', { path: SPEC, line: 9 });
    expect(t.runnerCalls).toEqual([['updateSnapshots', { kind: 'selection', selections: [{ path: SPEC, names: [T.addTwo] }] }]]);

    t.runnerCalls.length = 0;
    t.runner.docs.lookupAtLine = jest.fn(() => undefined);
    await run('hyperjest.updateTestSnapshots', { path: SPEC, line: 9 });
    expect(t.runnerCalls).toEqual([]);
    expect(v.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('cannot identify a test'));
  });

  it('Show Diff on a test message opens the diff of that message\'s test', async () => {
    const t = setup();
    const item = testItem('positive');
    t.explorer.testKeysFor.mockReturnValue([key(T.positive)]);
    await run('hyperjest.showDiff', { test: item, message: new vscode.TestMessage('boom') });
    expect(t.explorer.testKeysFor).toHaveBeenCalledWith(item);
    expect(t.diffShown).toEqual([key(T.positive)]);
  });

  it('Jump to Error Source on an Explorer item opens the failure of that item', async () => {
    const t = setup();
    await run('hyperjest.jumpToErrorSource', testItem('describe'));
    expect(t.explorer.testKeysFor).toHaveBeenCalled();
    // POSITIVE_FAILURE's first non-node_modules frame: math.test.js:33:25.
    expect(__state.shown).toHaveLength(1);
    expect(__state.shown[0].options.selection.start).toMatchObject({ line: 32, character: 24 });
    t.explorer.testKeysFor.mockReturnValue([key(T.addTwo)]);
    await run('hyperjest.jumpToErrorSource', testItem('passing'));
    expect(__state.shown).toHaveLength(1);
    expect(v.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('no failing test'));
  });
});

describe('Show Line Details', () => {
  it('moves the cursor to the clicked gutter line before showing the hover', async () => {
    setup();
    const editor: any = makeEditor(makeDocument(SRC, Array.from({ length: 20 }, (_, i) => `  line ${i}`).join('\n')));
    editor.selection = new v.Selection(new vscode.Position(1, 0), new vscode.Position(1, 0));
    editor.revealed = [] as any[];
    editor.revealRange = (r: unknown) => editor.revealed.push(r);
    v.window.activeTextEditor = editor;
    await run('hyperjest.showLineDetails', { lineNumber: 13, uri: vscode.Uri.file(SRC) });
    expect(editor.selection.active).toMatchObject({ line: 12, character: 2 });
    expect(editor.revealed).toHaveLength(1);
    expect(__state.commands.map(c => c.command)).toEqual(['editor.action.showHover']);
  });
});

describe('Clear Caches', () => {
  it('clears the persisted config cache for good, even through another ConfigCache instance', async () => {
    const t = setup();
    // The registry's own instance on the same memento.
    const registryCache = new ConfigCache(t.memento as any);
    await registryCache.set(PROJECT, 'fp', [], '29.7.0');
    const cleared: string[] = [];
    const orig = t.store.clearProject.bind(t.store);
    t.store.clearProject = (id: string) => { cleared.push(id); orig(id); };
    await run('hyperjest.clearCache');
    expect(cleared).toEqual([PROJECT]);
    expect(t.killed).toEqual([PROJECT]);
    expect(t.registry.clearConfigCache).toHaveBeenCalledTimes(1);
    expect(t.runner.relearnOpenDocuments).toHaveBeenCalledTimes(1);
    expect(registryCache.get(PROJECT, 'fp')).toBeUndefined();
    // A later ready of another project must not resurrect the cleared entries.
    await registryCache.set('other', 'fp2', [], '29.7.0');
    expect(registryCache.get(PROJECT, 'fp')).toBeUndefined();
    expect(Object.keys(t.memento.get<Record<string, unknown>>(ConfigCache.KEY)!)).toEqual(['other']);
  });
});

describe('Select Configurations', () => {
  const unit = { spec: spec('unit', '/repo/pkg', '/repo/pkg/jest.config.js') };
  const integ = { spec: spec('integ', '/repo/pkg', '/repo/pkg/jest.integration.config.js') };

  it('saves multiple configs and replaces a legacy pin while preserving overrides', async () => {
    const t = setup({ entries: [unit, integ], projects: [{ packageDir: '/repo/pkg', configArg: 'old.config.js', env: { A: '1' } }, { packageDir: '/repo/other', disabled: true }] });
    v.window.showQuickPick.mockImplementation(async (items: any[]) => items);
    await run('hyperjest.selectConfigurations');
    expect(v.window.showQuickPick).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ canPickMany: true }));
    expect(t.updates).toEqual([['projects', [
      { packageDir: '/repo/other', disabled: true },
      { packageDir: '/repo/pkg', configFiles: ['jest.config.js', 'jest.integration.config.js'], env: { A: '1' } },
    ]]]);
  });

  it('keeps selection on cancel and saves an explicit empty selection through the legacy alias', async () => {
    const t = setup({ entries: [unit, integ] });
    v.window.showQuickPick.mockResolvedValue(undefined);
    await run('hyperjest.selectConfigurations');
    expect(t.updates).toEqual([]);
    v.window.showQuickPick.mockResolvedValue([]);
    await run('hyperjest.selectProjectForFile');
    expect(t.updates).toEqual([['projects', [{ packageDir: '/repo/pkg', configFiles: [] }]]]);
  });

  it('selects a script config without converting it into an environment-losing configArg pin', async () => {
    const custom = { spec: spec('custom', '/repo/pkg', '/repo/config/jest.config.js', 'script-config') };
    const t = setup({ entries: [unit, custom] });
    v.window.showQuickPick.mockImplementation(async (items: any[]) => items.filter(i => i.spec.id === 'custom'));
    await run('hyperjest.selectConfigurations');
    expect(t.updates).toEqual([['projects', [{ packageDir: '/repo/pkg', configFiles: ['../config/jest.config.js'] }]]]);
  });

  it('matches relative and absolute override dirs', () => {
    expect(overrideTargets('/repo/pkg', '/repo/pkg', [])).toBe(true);
    expect(overrideTargets('pkg', '/repo/pkg', ['/repo'])).toBe(true);
    expect(overrideTargets('pkg', '/repo/pkg', ['/elsewhere'])).toBe(false);
  });
});

describe('package.json contributions', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'));

  it('contributes every registered command with the HyperJest category, and nothing unregistered', () => {
    setup();
    const contributed = manifest.contributes.commands as Array<{ command: string; category?: string }>;
    expect(contributed.map(c => c.command).sort()).toEqual([...registered.keys()].sort());
    expect(contributed.filter(c => c.category !== 'HyperJest')).toEqual([]);
    const palette = manifest.contributes.menus.commandPalette as Array<{ command: string; when: string }>;
    expect(palette.find(p => p.command === 'hyperjest.runDeferred')?.when).toBe('hyperjest.hasDeferred');
  });

  it('keeps the Esc and Esc Esc bindings mutually exclusive (a live chord would swallow the single Esc)', () => {
    const esc = (manifest.contributes.keybindings as Array<{ command: string; key: string; when: string }>).filter(k => /^escape/.test(k.key));
    const single = esc.find(k => k.key === 'escape')!;
    const chord = esc.find(k => k.key === 'escape escape')!;
    expect(single.command).toBe('hyperjest.clearValues');
    expect(chord.command).toBe('hyperjest.clearFileValues');
    expect(single.when).toMatch(/(^|&& )hyperjest\.lineHasInlineValues( &&|$)/);
    expect(chord.when).toContain('!hyperjest.lineHasInlineValues');
  });
});

describe('Run File Tests feedback', () => {
  it('on a covered source file runs the test files that cover it', async () => {
    const { runnerCalls } = setup();
    await run('hyperjest.runFileTests', vscode.Uri.file(SRC));
    expect(runnerCalls).toEqual([['runFiles', [{ path: SPEC }]]]);
  });

  it('says why when nothing could be queued', async () => {
    const { handles } = setup();
    handles.next = { runId: 'g1', done: Promise.resolve({ wasInterrupted: false, error: 'pkg: jest does not resolve' }), notRun: 'pkg: jest does not resolve' };
    await run('hyperjest.runFileTests', vscode.Uri.file('/repo/pkg/a.test.js'));
    expect(v.window.showWarningMessage).toHaveBeenCalledWith('HyperJest: pkg: jest does not resolve', 'Doctor');
  });

  it('says so when the file turned out not to be a test file of its project', async () => {
    const { handles, store } = setup();
    const file = '/repo/pkg/src/other.js';
    handles.next = { runId: 'g1', done: Promise.resolve({ wasInterrupted: false }) };
    store.apply({ v: 1, type: 'fileStart', runId: 'r9', path: file }, PROJECT);
    store.apply({ v: 1, type: 'fileResult', runId: 'r9', path: file, status: 'notMatched', numPassing: 0, numFailing: 0, numPending: 0, numTodo: 0 }, PROJECT);
    await run('hyperjest.runFileTests', vscode.Uri.file(file));
    await new Promise(r => setImmediate(r));
    expect(v.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('other.js is not a test file'), 'Doctor');
  });
});
