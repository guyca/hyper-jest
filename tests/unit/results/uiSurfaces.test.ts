jest.mock('vscode', () => require('./fakeVscode'));

import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { __state, makeDocument, makeEditor } from './fakeVscode';
import { ResultStore } from '../../../src/results/resultStore';
import { computeLineView, LineViewCache } from '../../../src/results/lineView';
import { DEFAULT_SETTINGS, type HyperJestSettings } from '../../../src/core/settingsModel';
import { IconAssets } from '../../../src/iconAssets';
import { DecorationManager, INLINE_PREFIX, planDecorations, shouldShowDeclarationIcons, variantKey, declarationKey } from '../../../src/decorations';
import { ContextKeys, contextArraysFor } from '../../../src/contextKeys';
import { buildStatusBarModel, StatusBar } from '../../../src/statusBar';
import { buildDiagnostics, DiagnosticsPublisher } from '../../../src/diagnostics';
import { buildHoverModel, HyperJestHoverProvider, renderDiffHtml, renderHoverMarkdown, commandLink, HOVER_COMMANDS } from '../../../src/hover';
import { buildCodeLenses, TestCodeLensProvider } from '../../../src/codeLens';
import { DoctorContentProvider, renderDoctorReport, showDoctorReport, type DoctorReport } from '../../../src/doctorView';
import { DiffContentProvider, diffContentFor, diffUri, parseDiffUri, TEST_PASSES_PLACEHOLDER } from '../../../src/diffView';
import { PROJECT, SPEC, SRC, T, key, applyFullRun, parsedMathSpec, fileStart, fileResult, consoleMsg, valueMsg, testResult } from './fixtures';

const settings = (over: Partial<HyperJestSettings> = {}): HyperJestSettings => ({ ...DEFAULT_SETTINGS, ...over });
const SRC_TEXT = Array.from({ length: 20 }, (_, i) => (i === 1 ? '  return a + b;' : `line ${i + 1}`)).join('\n');
const SPEC_TEXT = Array.from({ length: 40 }, (_, i) => `    spec line ${i + 1}`).join('\n');

beforeEach(() => __state.reset());

describe('decorations', () => {
  it('plans gutter buckets by state/hollow/snapshot, declaration icons and inline text', () => {
    const store = new ResultStore();
    store.setParsed(SPEC, parsedMathSpec());
    applyFullRun(store, 'r1');
    store.markStale(SRC, [1]);
    const src = planDecorations(computeLineView(store, SRC), settings(), true);
    expect(src.gutter.get(variantKey('covered', true, false))).toEqual([1]);
    expect(src.gutter.get(variantKey('covered', false, false))).toEqual([5, 6, 8]);
    expect(src.gutter.get(variantKey('errorPath', false, false))).toEqual([12, 13, 14]);
    expect(src.gutter.get(variantKey('notCovered', false, false))).toEqual([18]);
    const spec = planDecorations(computeLineView(store, SPEC), settings(), true);
    expect(spec.declarations.get(declarationKey('declPassed', false))).toEqual(expect.arrayContaining([3, 7]));
    expect(spec.declarations.get(declarationKey('declFailed', false))).toEqual(expect.arrayContaining([22, 30]));
    expect(spec.declarations.get(declarationKey('declSkipped', false))).toEqual(expect.arrayContaining([34, 38]));
    expect(spec.gutter.get(variantKey('errorSource', false, false))).toEqual([32]);
    expect(spec.inline).toEqual([{ line: 32, kind: 'error', text: expect.stringContaining('expect(received).toBe(expected)') }]);
    // Declarations hidden -> no declaration buckets; gutter disabled -> no gutter at all.
    expect(planDecorations(computeLineView(store, SPEC), settings(), false).declarations.size).toBe(0);
    expect(planDecorations(computeLineView(store, SRC), settings({ gutter: { enabled: false, testDeclarations: 'auto' } }), true).gutter.size).toBe(0);
    expect(shouldShowDeclarationIcons('auto', true)).toBe(false);
    expect(shouldShowDeclarationIcons('auto', false)).toBe(true);
    expect(shouldShowDeclarationIcons('always', true)).toBe(true);
    expect(shouldShowDeclarationIcons('never', false)).toBe(false);
  });

  it('creates one type per variant and applies every bucket (empty ones included)', () => {
    const icons = new IconAssets('/tmp/hj-icons-test', DEFAULT_SETTINGS.colors);
    const manager = new DecorationManager(icons, () => settings());
    // 5 states x 2 x 2 + 4 declaration states x 2 + 3 inline
    expect(__state.decorationTypes).toHaveLength(20 + 8 + 3);
    const gutterType = __state.decorationTypes.find(t => t.options.gutterIconPath?.includes('covered.'))!;
    expect(gutterType.options).toMatchObject({ isWholeLine: true, rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed, gutterIconSize: 'contain' });
    const inlineErr = __state.decorationTypes.find(t => t.options.after?.color?.id === 'hyperjest.inlineError.foreground')!;
    expect(inlineErr.options.isWholeLine).toBe(true);

    const store = new ResultStore();
    applyFullRun(store, 'r1');
    // A narrowed re-run of one test adds a log without dropping the other tests' results.
    store.registerRun('r2', [{ path: SPEC, names: [T.addTwo] }]);
    store.apply(fileStart('r2'), PROJECT);
    store.apply(consoleMsg('r2', 'greeting', { file: SRC, line: 2, testKey: key(T.addTwo) }), PROJECT);
    store.apply(testResult('r2', T.addTwo, 'passed', { line: 4 }), PROJECT);
    store.apply(fileResult('r2', 'passed'), PROJECT);
    const editor = makeEditor(makeDocument(SRC, SRC_TEXT));
    manager.apply(editor, computeLineView(store, SRC));
    expect(editor.decorations.size).toBe(31);
    const covered = editor.decorations.get(gutterType.key)!;
    expect(covered.map((r: vscode.Range) => r.start.line)).toEqual([1, 5, 6, 8]);
    const logType = __state.decorationTypes.find(t => t.options.after?.color?.id === 'hyperjest.inlineLog.foreground')!;
    const logDecos = editor.decorations.get(logType.key)!;
    expect(logDecos).toHaveLength(1);
    expect(logDecos[0].range.start.character).toBe(2);
    expect(logDecos[0].range.end.character).toBe('  return a + b;'.length);
    expect(logDecos[0].renderOptions.after.contentText).toBe(INLINE_PREFIX + 'greeting');
    // Clearing sets [] everywhere.
    manager.clear(editor);
    expect([...editor.decorations.values()].every(v => v.length === 0)).toBe(true);
    // Hidden declaration icons when VS Code's own testing gutter is on.
    __state.config.set('testing.gutterEnabled', true);
    store.setParsed(SPEC, parsedMathSpec());
    const specEditor = makeEditor(makeDocument(SPEC, SPEC_TEXT));
    manager.refreshAll([specEditor], p => computeLineView(store, p));
    const declType = __state.decorationTypes.find(t => t.options.gutterIconPath?.includes('declPassed.'))!;
    expect(specEditor.decorations.get(declType.key)).toEqual([]);
    __state.config.set('testing.gutterEnabled', false);
    manager.apply(specEditor, computeLineView(store, SPEC));
    expect(specEditor.decorations.get(declType.key)!.length).toBeGreaterThan(0);
    manager.dispose();
    expect(__state.decorationTypes.every(t => t.disposed)).toBe(true);
  });
});

describe('decorations: colours', () => {
  it('recreates the gutter types (and their icons) only when hyperjest.colors.* changed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'hj-deco-'));
    try {
      let current = settings();
      const icons = new IconAssets(dir, current.colors);
      const manager = new DecorationManager(icons, () => current);
      const before = __state.decorationTypes.filter(t => t.options.gutterIconPath);
      expect(before).toHaveLength(28);
      await manager.onColorsChanged();
      expect(__state.decorationTypes).toHaveLength(31);
      current = settings({ colors: { ...current.colors, covered: '#00ff00' } });
      await manager.onColorsChanged();
      expect(before.every(t => t.disposed)).toBe(true);
      expect(__state.decorationTypes).toHaveLength(31 + 28);
      const fresh = __state.decorationTypes.filter(t => !t.disposed && t.options.gutterIconPath?.includes('/covered.'));
      expect(fresh).toHaveLength(4);
      expect(await readFile(fresh[0].options.gutterIconPath, 'utf8')).toContain('#00ff00');
      // The editor is re-decorated with the new types.
      const store = new ResultStore();
      applyFullRun(store, 'r1');
      const editor = makeEditor(makeDocument(SRC, SRC_TEXT));
      manager.apply(editor, computeLineView(store, SRC));
      expect(editor.decorations.get(fresh.find(t => t.options.gutterIconPath.includes('/covered.') && !t.options.gutterIconPath.includes('hollow'))!.key).length).toBeGreaterThan(0);
      manager.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('decorations: colours pushed by the integrator first', () => {
  it('still recreates the types when IconAssets already holds the new colours', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'hj-deco2-'));
    try {
      let current = settings();
      const icons = new IconAssets(dir, current.colors);
      const manager = new DecorationManager(icons, () => current);
      const before = __state.decorationTypes.filter(t => t.options.gutterIconPath);
      current = settings({ colors: { ...current.colors, covered: '#123456' } });
      // An integrator (or a second listener) updated the shared IconAssets before notifying the manager.
      expect(icons.setColors(current.colors)).toBe(true);
      await icons.ensure();
      await manager.onColorsChanged();
      expect(before.every(t => t.disposed)).toBe(true);
      const fresh = __state.decorationTypes.filter(t => !t.disposed && t.options.gutterIconPath?.includes('/covered.'));
      expect(fresh).toHaveLength(4);
      expect(await readFile(fresh[0].options.gutterIconPath, 'utf8')).toContain('#123456');
      const n = __state.decorationTypes.length;
      await manager.onColorsChanged();
      expect(__state.decorationTypes).toHaveLength(n); // unchanged colours: no churn
      manager.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('context keys', () => {
  it('clearEditor resets every editor-scoped key; hasDeferred follows the run state', () => {
    const store = new ResultStore();
    applyFullRun(store, 'r1');
    store.registerRun('r2', [{ path: SPEC, names: [T.addTwo] }]);
    store.apply(fileStart('r2'), PROJECT);
    store.apply(valueMsg('r2', '1', { file: SRC, line: 2, testKey: key(T.addTwo) }), PROJECT);
    store.apply(testResult('r2', T.addTwo, 'passed', { line: 4 }), PROJECT);
    store.apply(fileResult('r2', 'passed'), PROJECT);
    const state = new Map<string, unknown>();
    const keys = new ContextKeys(async (k, v) => { state.set(k, v); });
    keys.updateEditor(computeLineView(store, SRC), { isTestFile: false, isSourceFile: true }, 1);
    expect(state.get('hyperjest.lineHasInlineValues')).toBe(true);
    keys.clearEditor();
    expect(Object.fromEntries([...state].filter(([k]) => k !== 'hyperjest.running'))).toEqual({
      'hyperjest.linesWithTestDeclaration': [], 'hyperjest.linesWithSnapshot': [], 'hyperjest.linesWithError': [], 'hyperjest.linesWithValues': [],
      'hyperjest.coveredLines': [], 'hyperjest.isTestFile': false, 'hyperjest.isSourceFile': false,
      'hyperjest.fileHasInlineValues': false, 'hyperjest.lineHasInlineValues': false,
    });
    keys.updateRunState({ running: false, paused: false, runMode: 'onType', hasDeferred: true });
    expect(state.get('hyperjest.hasDeferred')).toBe(true);
    keys.updateRunState({ running: false, paused: false, runMode: 'onType', hasDeferred: false });
    expect(state.get('hyperjest.hasDeferred')).toBe(false);
  });


  it('computes 1-based arrays and only sends changed keys', () => {
    const store = new ResultStore();
    store.setParsed(SPEC, parsedMathSpec());
    applyFullRun(store, 'r1');
    store.registerRun('r2', [{ path: SPEC, names: [T.addTwo] }]);
    store.apply(fileStart('r2'), PROJECT);
    store.apply(valueMsg('r2', '1', { file: SRC, line: 2, testKey: key(T.addTwo) }), PROJECT);
    store.apply(testResult('r2', T.addTwo, 'passed', { line: 4 }), PROJECT);
    store.apply(fileResult('r2', 'passed'), PROJECT);
    const spec = contextArraysFor(computeLineView(store, SPEC));
    expect(spec.linesWithTestDeclaration).toEqual([3, 4, 8, 13, 14, 18, 23, 24, 31, 35, 39]);
    expect(spec.linesWithError).toEqual([33]);
    const src = contextArraysFor(computeLineView(store, SRC));
    expect(src.linesWithValues).toEqual([2]);
    expect(src.coveredLines).toEqual([2, 6, 7, 9, 13, 14, 15]);
    const calls: Array<[string, unknown]> = [];
    const keys = new ContextKeys(async (k, v) => { calls.push([k, v]); });
    keys.updateEditor(computeLineView(store, SRC), { isTestFile: false, isSourceFile: true }, 1);
    expect(calls.find(c => c[0] === 'hyperjest.coveredLines')![1]).toEqual([2, 6, 7, 9, 13, 14, 15]);
    expect(calls.find(c => c[0] === 'hyperjest.lineHasInlineValues')![1]).toBe(true);
    expect(calls.find(c => c[0] === 'hyperjest.fileHasInlineValues')![1]).toBe(true);
    const n = calls.length;
    keys.updateEditor(computeLineView(store, SRC), { isTestFile: false, isSourceFile: true }, 1);
    expect(calls.length).toBe(n);
    keys.updateCursor(computeLineView(store, SRC), 5);
    expect(calls[calls.length - 1]).toEqual(['hyperjest.lineHasInlineValues', false]);
    keys.updateRunState({ running: true, paused: false, runMode: 'onType' });
    expect(calls.slice(-3).map(c => c[0])).toEqual(['hyperjest.running', 'hyperjest.paused', 'hyperjest.runMode']);
    keys.updateEditor(undefined, { isTestFile: false, isSourceFile: false });
    expect(calls.slice(-2)).toEqual([['hyperjest.isSourceFile', false], ['hyperjest.fileHasInlineValues', false]]);
  });
});

describe('status bar', () => {
  const state = { started: true, running: false, paused: false, runMode: 'onType' as const, activeRuns: 0, queuedFiles: 0 };
  const summary = { passed: 6, failed: 1, pending: 2, running: 0, queued: 0, staleFiles: 0 };

  it('builds text, spinner, paused, cap message and backgrounds', () => {
    expect(buildStatusBarModel({ summary, state, compact: false })).toMatchObject({ text: '$(beaker) HyperJest ✓ 6 ✗ 1 ○ 2', error: true, warning: false });
    expect(buildStatusBarModel({ summary, state, compact: true }).text).toBe('$(beaker) $(check-all) 6 $(error) 1');
    expect(buildStatusBarModel({ summary: { ...summary, running: 1 }, state, compact: false })).toMatchObject({ text: expect.stringContaining('$(loading~spin)'), error: false });
    expect(buildStatusBarModel({ summary: { ...summary, failed: 0 }, state: { ...state, paused: true }, compact: false })).toMatchObject({ text: expect.stringContaining('$(debug-pause)'), warning: true });
    expect(buildStatusBarModel({ summary, state: { ...state, capped: { count: 12, selections: [] } }, compact: false }).text).toContain('12 affected files waiting');
    expect(buildStatusBarModel({ summary, state: { ...state, started: false }, compact: false }).text).toBe('$(beaker) HyperJest stopped');
    expect(buildStatusBarModel({ summary, state, compact: false }).tooltip).toContain('Run mode: onType');
  });

  it('clicking runs the deferred tests while capped ("click to run"), the menu otherwise', () => {
    const capped = { ...state, capped: { count: 12, selections: [] } };
    expect(buildStatusBarModel({ summary, state: capped }).command).toBe('hyperjest.runDeferred');
    expect(buildStatusBarModel({ summary, state }).command).toBe('hyperjest.showMenu');
    const bar = new StatusBar();
    const item = __state.statusBarItems[0];
    bar.update({ summary, state: capped, compact: false });
    expect(item.command).toBe('hyperjest.runDeferred');
    bar.update({ summary, state, compact: false });
    expect(item.command).toBe('hyperjest.showMenu');
    bar.dispose();
  });

  it('drives the StatusBarItem', () => {
    const bar = new StatusBar();
    const item = __state.statusBarItems[0];
    expect(item).toMatchObject({ id: 'hyperjest.status', command: 'hyperjest.showMenu', alignment: vscode.StatusBarAlignment.Right, priority: 100, visible: true });
    bar.update({ summary, state, compact: false });
    expect(item.text).toBe('$(beaker) HyperJest ✓ 6 ✗ 1 ○ 2');
    expect(item.backgroundColor.id).toBe('statusBarItem.errorBackground');
    bar.update({ summary: { ...summary, failed: 0 }, state, compact: false });
    expect(item.backgroundColor).toBeUndefined();
    bar.dispose();
    expect(item.disposed).toBe(true);
  });

  it('reads compact from the settings getter when update() omits it', () => {
    let compact = true;
    const bar = new StatusBar(() => settings({ statusBar: { compact } }));
    const item = __state.statusBarItems[0];
    bar.update({ summary, state });
    expect(item.text).toBe('$(beaker) $(check-all) 6 $(error) 1');
    compact = false;
    bar.update({ summary, state });
    expect(item.text).toBe('$(beaker) HyperJest ✓ 6 ✗ 1 ○ 2');
    bar.update({ summary, state, compact: true });
    expect(item.text).toBe('$(beaker) $(check-all) 6 $(error) 1');
    bar.dispose();
  });
});

describe('diagnostics', () => {
  it('builds one diagnostic at the top in-file frame with related frames plus one at the declaration', () => {
    const store = new ResultStore();
    applyFullRun(store, 'r1');
    const data = buildDiagnostics(SPEC, store.testsInFile(SPEC), store.fileRecord(SPEC));
    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({ line: 32, column: 24, testKey: key(T.positive) });
    expect(data[0].message).toContain('Expected: "positiv"');
    expect(data[0].related[0].file).toContain('jest-circus');
    expect(data[1]).toMatchObject({ line: 30, message: expect.stringContaining(`✗ ${T.positive}: expect(received).toBe(expected)`) });
    const errored = buildDiagnostics(SPEC, [], { path: SPEC, projectId: PROJECT, status: 'errored', testKeys: new Set(), updatedAt: 0, stale: false, testExecError: { message: 'boom', frames: [] } });
    expect(errored).toEqual([{ line: 0, column: 0, message: 'boom', related: [] }]);
  });

  it('publishes to the collection, expands ranges on open documents, honours the gate', () => {
    const store = new ResultStore();
    applyFullRun(store, 'r1');
    let enabled = true;
    const pub = new DiagnosticsPublisher(store, () => enabled);
    __state.textDocuments.push(makeDocument(SPEC, SPEC_TEXT));
    pub.update([SPEC, SRC]);
    const diags = pub.collection.get(vscode.Uri.file(SPEC))!;
    expect(diags).toHaveLength(2);
    expect(diags[0].source).toBe('HyperJest');
    expect(diags[0].severity).toBe(vscode.DiagnosticSeverity.Error);
    // Frame column 25 is beyond the 16-char fixture line: the range covers the line's content.
    expect(diags[0].range.start.character).toBe(4);
    expect(diags[0].range.end.character).toBe('    spec line 33'.length);
    expect(diags[0].relatedInformation).toHaveLength(1);
    expect(pub.collection.has(vscode.Uri.file(SRC))).toBe(false);
    applyFullRun(store, 'r2', { positiveStatus: 'passed' });
    pub.update([SPEC]);
    expect(pub.collection.has(vscode.Uri.file(SPEC))).toBe(false);
    applyFullRun(store, 'r3');
    pub.refreshAll();
    expect(pub.collection.has(vscode.Uri.file(SPEC))).toBe(true);
    enabled = false;
    pub.update([SPEC]);
    expect(pub.collection.has(vscode.Uri.file(SPEC))).toBe(false);
    pub.dispose();
  });
});

describe('hover', () => {
  it('builds a model with test status, failure, diff, frames and coverage, rendered as trusted markdown', () => {
    const store = new ResultStore();
    store.setParsed(SPEC, parsedMathSpec());
    applyFullRun(store, 'r1');
    const view = computeLineView(store, SPEC);
    const errModel = buildHoverModel(store, view, 32)!;
    expect(errModel.errors).toHaveLength(1);
    expect(errModel.errors[0].test!.fullName).toBe(T.positive);
    const md = renderHoverMarkdown(errModel);
    expect(md).toContain('✗ failed');
    expect(md).toContain('command:hyperjest.runLineTests?');
    expect(md).toContain('command:hyperjest.showDiff?');
    expect(md).toContain('**Expected ↔ Actual** (`toBe`)');
    expect(md).toContain('<del>positiv</del>');
    expect(md).toContain('<ins>positive</ins>');
    expect(md).toContain(`command:hyperjest.openFrame?${encodeURIComponent(JSON.stringify([{ file: SPEC, line: 33, column: 25 }]))}`);
    expect(md).not.toContain('jest-circus'); // node_modules frames are hidden
    const declModel = buildHoverModel(store, view, 3)!;
    expect(declModel.declared.map(t => t.fullName)).toEqual([T.addTwo]);
    expect(renderHoverMarkdown(declModel)).toContain('✓ passed · 3 ms');
    const srcModel = buildHoverModel(store, computeLineView(store, SRC), 14)!;
    expect(srcModel.coverage).toMatchObject({ state: 'errorPath', tests: 1, failing: 1, perTest: true });
    expect(renderHoverMarkdown(srcModel)).toContain('covered by 1 test (1 failing)');
    expect(buildHoverModel(store, view, 0)).toBeUndefined();
  });

  it('renders values with a copy link and the provider returns a trusted Hover', () => {
    const store = new ResultStore();
    store.apply(fileStart('r1'), PROJECT);
    store.apply(valueMsg('r1', '{ a: 1,\n  b: 2 }', { file: SRC, line: 2 }), PROJECT);
    store.apply(fileResult('r1', 'passed'), PROJECT);
    const cache = new LineViewCache(store, () => ({}));
    const provider = new HyperJestHoverProvider(store, p => cache.get(p));
    const hover = provider.provideHover(makeDocument(SRC, SRC_TEXT), new vscode.Position(1, 3)) as vscode.Hover;
    expect(hover.contents).toHaveLength(1);
    const md = hover.contents[0] as vscode.MarkdownString;
    expect(md.isTrusted).toEqual({ enabledCommands: HOVER_COMMANDS });
    expect(md.supportHtml).toBe(true);
    expect(md.value).toContain('**Value**');
    expect(md.value).toContain('{ a: 1,\n  b: 2 }');
    expect(md.value).toContain(commandLink('Copy Value', 'hyperjest.copyValue', { path: SRC, line: 2 }, 'Copy the full value'));
    expect(provider.provideHover(makeDocument(SRC, SRC_TEXT), new vscode.Position(10, 0))).toBeUndefined();
  });

  it('escapes html in diffs and keeps context lines', () => {
    const small = renderDiffHtml('<a> x', '<a> y');
    expect(small).toContain('&lt;a&gt; ');
    expect(small).toContain('<del>x</del>');
    expect(small).toContain('<ins>y</ins>');
    const html = renderDiffHtml('<a>\n1\n2\n3\n4\n5\n6\nx', '<a>\n1\n2\n3\n4\n5\n6\ny');
    expect(html.startsWith('<pre>…\n3\n4\n5\n6\n')).toBe(true);
    expect(html).not.toContain('<a>');
  });
});

describe('code lenses', () => {
  it('emits Run/Debug lenses per declaration and a status lens when results exist; gated by the setting', () => {
    const store = new ResultStore();
    store.setParsed(SPEC, parsedMathSpec());
    applyFullRun(store, 'r1');
    const data = buildCodeLenses(parsedMathSpec(), store.testsInFile(SPEC));
    const line3 = data.filter(l => l.line === 3);
    expect(line3.map(l => l.title)).toEqual(['$(run) Run', '$(debug-alt) Debug', '✓ passed 3 ms']);
    expect(line3[0]).toMatchObject({ command: 'hyperjest.runLineTests', args: [{ path: SPEC, line: 4, testKey: key(T.addTwo) }] });
    expect(data.filter(l => l.line === 22).map(l => l.title)).toEqual(['$(run) Run', '$(debug-alt) Debug', '✗ failed 9 ms']);
    expect(data.filter(l => l.line === 38).map(l => l.title)).toEqual(['$(run) Run', '$(debug-alt) Debug', '☐ todo']);
    let enabled = false;
    const provider = new TestCodeLensProvider(store, () => settings({ codeLens: { enabled } }));
    const doc = makeDocument(SPEC, SPEC_TEXT);
    expect(provider.provideCodeLenses(doc)).toEqual([]);
    enabled = true;
    const lenses = provider.provideCodeLenses(doc) as vscode.CodeLens[];
    expect(lenses.length).toBe(data.length);
    expect(lenses[0].range.start.line).toBe(2);
    let fired = 0;
    provider.onDidChangeCodeLenses(() => fired++);
    provider.refresh();
    expect(fired).toBe(1);
    provider.dispose();
  });
});

describe('doctor view', () => {
  const report: DoctorReport = {
    generatedAt: '2026-10-09T10:00:00Z', extensionVersion: '0.1.0', vscodeVersion: '1.141.0', hostNodeVersion: 'v24.21.0',
    workspaceFolders: ['/repo'], settings: { runMode: 'onType' },
    packages: [
      { packageDir: '/repo/pkg', displayName: 'pkg', flavor: 'implicit', status: 'ok', jestVersion: '29.7.0', jestPkgDir: '/repo/node_modules/jest', nodePath: '/usr/bin/node', nodeVersion: 'v24.19.0', nodeSource: '.nvmrc', testFileCount: 12, workerState: 'ready', bootstrapMs: 820, seams: { envWrapper: true, probeTransformer: false, cachePrune: true }, warnings: ['uses jest.config.ts'], fixes: [] },
      { packageDir: '/repo/other', displayName: 'other', flavor: 'unknown', status: 'unavailable', reason: 'node_modules missing', warnings: [], fixes: ['run yarn install'] },
    ],
    workers: { total: 2, busy: 1, maxWorkers: 7, memoryBudgetMB: 8192, rssMB: 410 },
    warnings: ['registry offline'],
    extraSections: [{ title: 'Compare with plain Jest', body: 'identical' }],
  };

  it('renders markdown and serves it through the content provider', async () => {
    const md = renderDoctorReport(report);
    expect(md).toContain('# HyperJest Doctor');
    expect(md).toContain('| ok | 1 |');
    expect(md).toContain('### pkg — ok');
    expect(md).toContain('degraded (probeTransformer unavailable)');
    expect(md).toContain('💡 run yarn install');
    expect(md).toContain('## Compare with plain Jest');
    const provider = new DoctorContentProvider();
    vscode.workspace.registerTextDocumentContentProvider('hyperjest-doctor', provider);
    let changed: vscode.Uri | undefined;
    provider.onDidChange(u => { changed = u; });
    await showDoctorReport(provider, report);
    expect(changed!.toString()).toBe('hyperjest-doctor:report.md');
    expect(__state.shown[0].doc.getText()).toBe(md);
    expect(__state.shown[0].doc.languageId).toBe('markdown');
    expect(provider.provideTextDocumentContent(vscode.Uri.parse('hyperjest-doctor:missing.md'))).toContain('No report yet');
    provider.dispose();
  });
});

describe('diff view', () => {
  it('encodes test keys in URIs and serves expected/actual that update with the store', async () => {
    const store = new ResultStore();
    applyFullRun(store, 'r1');
    const k = key(T.positive);
    const uri = diffUri(k, 'expected');
    expect(uri.scheme).toBe('hyperjest-diff');
    expect(parseDiffUri(uri)).toEqual({ testKey: k, side: 'expected' });
    expect(parseDiffUri(vscode.Uri.parse('hyperjest-diff:/nope'))).toBeUndefined();
    const provider = new DiffContentProvider(store);
    expect(provider.provideTextDocumentContent(uri)).toBe('positiv');
    expect(provider.provideTextDocumentContent(diffUri(k, 'actual'))).toBe('positive');
    await provider.showDiff(k);
    const call = __state.commands[0];
    expect(call.command).toBe('vscode.diff');
    expect(call.args[2]).toBe(`Expected ↔ Actual — ${T.positive}`);
    const fired: string[] = [];
    provider.onDidChange(u => fired.push(u.toString()));
    provider.onStoreChange([SRC]);
    expect(fired).toEqual([]);
    applyFullRun(store, 'r2', { positiveStatus: 'passed' });
    provider.onStoreChange([SPEC]);
    expect(fired).toHaveLength(2);
    expect(provider.provideTextDocumentContent(uri)).toBe(TEST_PASSES_PLACEHOLDER);
    expect(diffContentFor(undefined, k).actual).toContain('No result');
    store.apply(fileStart('r3'), PROJECT);
    store.apply(testResult('r3', T.positive, 'failed', { line: 31, failures: [{ message: 'thrown', frames: [] }] }), PROJECT);
    expect(diffContentFor(store.test(k), k)).toMatchObject({ expected: '', actual: 'thrown' });
    provider.dispose();
  });
});
