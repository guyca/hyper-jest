import * as path from 'path';
import * as vscode from 'vscode';
import type { RunCoordinator } from './runner';
import type { ProjectRegistry } from './discovery/projectRegistry';
import type { ResultStore } from './results/resultStore';
import type { Settings } from './settings';
import type { WorkerPool } from './workerPool';
import type { OutputLogger } from './log';
import { DoctorContentProvider, uriFor as doctorUri } from './doctorView';
import { ConfigCache } from './discovery/configCache';
import { DiffContentProvider } from './diffView';
import { buildDoctorReport } from './doctor';
import { PROTOCOL_VERSION, parseTestKey, type Frame, type WorkerToHost } from './core/protocol';
import { computeLineView } from './results/lineView';
import { isFailingStatus } from './results/resultStore';
import type { TestRecord } from './core/resultModel';
import type { TestExplorer } from './testTree';
import type { RunMode } from './core/settingsModel';
import { toRunSpecProject } from './cliEngine';
import { buildRunSpec } from './core/runSpec';
import type { RunHandle } from './runnerApi';

export interface CommandDeps {
  context: vscode.ExtensionContext;
  runner: RunCoordinator;
  registry: ProjectRegistry;
  store: ResultStore;
  settings: Settings;
  pool: WorkerPool;
  log: OutputLogger;
  doctor: DoctorContentProvider;
  diff: DiffContentProvider;
  workerAssetsDir: string;
  clearInline: (path: string, line?: number) => void;
  toggleCoverage: () => void;
  /**
   * Maps a recorded (run data) 0-based line of a file onto its current buffer after unsaved edits, as
   * the decorations do (results/lineShift); undefined when the data matches the buffer.
   */
  mapLine?: (path: string) => ((line: number) => number | undefined) | undefined;
  /** The Test Explorer, when `hyperjest.testExplorer.enabled` (maps context-menu TestItems to test keys). */
  explorer: () => Pick<TestExplorer, 'testKeysFor' | 'selectionsFor' | 'projectIdFor'> | undefined;
}

/** `testing/item/context` passes the extension's own TestItem. */
export function isTestItem(arg: unknown): arg is vscode.TestItem {
  if (!arg || typeof arg !== 'object') return false;
  const a = arg as { id?: unknown; children?: { forEach?: unknown } };
  return typeof a.id === 'string' && typeof a.children?.forEach === 'function';
}

/** The TestItem behind a Test Explorer command argument: an item, or `{ test, message }` (`testing/message/context`). */
export function testItemOf(arg: unknown): vscode.TestItem | undefined {
  if (isTestItem(arg)) return arg;
  if (arg && typeof arg === 'object' && 'test' in arg && isTestItem((arg as { test: unknown }).test)) return (arg as { test: vscode.TestItem }).test;
  return undefined;
}

function activeFile(): { path: string; line: number } | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.uri.scheme !== 'file') return undefined;
  return { path: ed.document.uri.fsPath, line: ed.selection.active.line };
}

/** Registers every `hyperjest.*` command from package.json. */
export function registerCommands(d: CommandDeps): vscode.Disposable[] {
  const { runner, registry, store, log } = d;
  const reg = (id: string, fn: (...args: unknown[]) => unknown) =>
    vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      try {
        return await fn(...args);
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        log.error(`${id}: ${msg}`);
        void vscode.window.showErrorMessage(`HyperJest: ${msg}`, 'Show Output').then(c => c && log.show());
        return undefined;
      }
    });

  /** Resolves a command argument to a 0-based line. */
  const lineOf = (arg: unknown): { path: string; line: number; testKey?: string } | undefined => {
    if (arg && typeof arg === 'object') {
      // Gutter context menu passes { lineNumber (1-based), uri }.
      if ('lineNumber' in arg && 'uri' in arg) {
        const a = arg as { lineNumber: number; uri: vscode.Uri };
        return { path: a.uri.fsPath, line: a.lineNumber - 1 };
      }
      // Hover links and code lenses pass a LineTarget { path, line (1-based), testKey? }.
      if ('path' in arg && 'line' in arg) {
        const a = arg as { path: string; line: number; testKey?: string };
        if (typeof a.path === 'string' && typeof a.line === 'number') return { path: a.path, line: Math.max(0, a.line - 1), testKey: a.testKey };
      }
    }
    return activeFile();
  };

  /** Run/Debug Line: a test line runs that test; a source line runs the tests that covered it. */
  /**
   * Tells the user when a run command did nothing: nothing could be queued (stopped, no Jest project,
   * package unavailable / not Jest), or the single file run turned out not to be a test file of its project.
   */
  const reportRun = (h: RunHandle | undefined, file?: string) => {
    if (!h) return;
    if (h.notRun) {
      void vscode.window.showWarningMessage(`HyperJest: ${h.notRun}`, 'Doctor').then(c => c && vscode.commands.executeCommand('hyperjest.doctor'));
      return;
    }
    if (!file) return;
    void h.done.then(() => {
      if (store.fileRecord(file)?.status !== 'notMatched') return;
      void vscode.window.showInformationMessage(
        `HyperJest: ${path.basename(file)} is not a test file of its Jest project (testMatch / testRegex / roots), and no recorded test covers it yet.`, 'Doctor',
      ).then(c => c && vscode.commands.executeCommand('hyperjest.doctor'));
    });
  };

  /** Test files whose recorded runs executed or loaded a source file. */
  const testFilesCovering = (p: string): string[] => {
    const files = new Set<string>(store.loadedBy().get(p) ?? []);
    for (const key of store.execBy().get(p) ?? []) files.add(parseTestKey(key).path);
    files.delete(p);
    return [...files].sort();
  };

  /** "Run File Tests": the file itself, or for a source file the test files that cover it. */
  const runFileTests = async (p: string) => {
    const covering = registry.isTestFile(p) ? [] : testFilesCovering(p);
    if (covering.length) { reportRun(await runner.runFiles(covering.map(f => ({ path: f })), 'explicit')); return; }
    reportRun(await runner.runFiles([{ path: p }], 'explicit'), p);
  };

  const runLineTarget = async (arg: unknown, mode: 'run' | 'debug') => {
    const t = lineOf(arg);
    if (!t) return;
    if (t.testKey && mode === 'run') { reportRun(await runner.runTests([t.testKey])); return; }
    if (registry.isTestFile(t.path)) { reportRun(await runner.runLine(t.path, t.line, mode), t.path); return; }
    const covering = computeLineView(store, t.path, { maxLength: 80, mapLine: d.mapLine?.(t.path) }).lines.get(t.line)?.tests ?? [];
    if (!covering.length) {
      void vscode.window.showInformationMessage(`HyperJest: no test covers line ${t.line + 1} of ${path.basename(t.path)} yet.`);
      return;
    }
    if (mode === 'run') { reportRun(await runner.runTests(covering)); return; }
    // Debug the first covering test (debugging several files at once is not supported).
    const first = store.test(covering[0]);
    const { path: testPath, fullName } = parseTestKey(covering[0]);
    await runner.debug({ path: testPath, names: [first?.fullName ?? fullName] });
  };

  const openFrame = async (frame: Frame) => {
    const doc = await vscode.workspace.openTextDocument(frame.file);
    const pos = new vscode.Position(Math.max(0, frame.line - 1), Math.max(0, frame.column - 1));
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos) });
  };

  const jumpToFailingTest = async () => {
    const af = activeFile();
    const candidates = store.failingTests();
    if (!candidates.length) { void vscode.window.showInformationMessage('HyperJest: no failing tests.'); return; }
    // Prefer failing tests whose error path touches the current line, then the current file, then any.
    const scored = candidates.map(t => {
      let score = 0;
      if (af && t.path === af.path) score += 2;
      if (af && t.failures.some(f => f.frames.some(fr => fr.file === af.path && fr.line - 1 === af.line))) score += 4;
      return { t, score };
    }).sort((a, b) => b.score - a.score);
    const pick = scored.length === 1 || scored[0].score > 0 ? scored[0].t
      : await vscode.window.showQuickPick(scored.map(s => ({ label: s.t.fullName, description: path.basename(s.t.path), t: s.t })), { placeHolder: 'Failing test' }).then(i => i?.t);
    if (!pick) return;
    const line = pick.location?.line ?? (pick.failures[0]?.frames.find(f => f.file === pick.path)?.line ?? 1);
    await openFrame({ file: pick.path, line, column: 1 });
  };

  /** Store records behind a Test Explorer item. */
  const recordsOf = (item: vscode.TestItem): TestRecord[] =>
    (d.explorer()?.testKeysFor(item) ?? []).map(k => store.test(k)).filter((t): t is TestRecord => !!t);

  const jumpToErrorSource = async (arg?: unknown) => {
    const item = testItemOf(arg);
    let t: TestRecord | undefined;
    if (item) {
      t = recordsOf(item).find(x => isFailingStatus(x.status));
      if (!t) { void vscode.window.showInformationMessage(`HyperJest: ${item.label} has no failing test.`); return; }
    } else {
      const af = activeFile();
      const tests = af ? store.testsInFile(af.path).filter(x => isFailingStatus(x.status)) : store.failingTests();
      const list = tests.length ? tests : store.failingTests();
      if (!list.length) { void vscode.window.showInformationMessage('HyperJest: no failing tests.'); return; }
      t = af ? (list.find(x => x.location && x.location.line - 1 === af.line) ?? list[0]) : list[0];
    }
    const frame = t.failures.flatMap(f => f.frames).find(fr => !fr.file.includes('/node_modules/')) ?? t.failures[0]?.frames[0];
    if (!frame) { void vscode.window.showInformationMessage('HyperJest: the failure has no source location.'); return; }
    await openFrame(frame);
  };

  /** Moves the cursor to the clicked line (gutter menu, code lens) so the hover opens there, not at the old cursor. */
  const showLineDetails = async (arg: unknown) => {
    const target = lineOf(arg);
    if (!target) return;
    const isTarget = (ed: vscode.TextEditor | undefined) => !!ed && ed.document.uri.scheme === 'file' && ed.document.uri.fsPath === target.path;
    const active = vscode.window.activeTextEditor;
    const editor = isTarget(active) ? active!
      : await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(target.path)), { viewColumn: vscode.window.visibleTextEditors.find(isTarget)?.viewColumn });
    const line = Math.min(target.line, Math.max(0, editor.document.lineCount - 1));
    const pos = new vscode.Position(line, editor.document.lineAt(line).firstNonWhitespaceCharacterIndex);
    if (editor.selection.active.line !== line) editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    await vscode.commands.executeCommand('editor.action.showHover');
  };

  const copyValue = async (arg: unknown) => {
    const target = lineOf(arg);
    if (!target) return;
    const view = computeLineView(store, target.path, { maxLength: 1e9, mapLine: d.mapLine?.(target.path) });
    const entries = view.lines.get(target.line)?.entries ?? [];
    const text = entries.map(e => e.longText ?? e.text).join('\n');
    if (!text) { void vscode.window.showInformationMessage('HyperJest: no value on this line.'); return; }
    await vscode.env.clipboard.writeText(text);
  };

  const showResolvedConfig = async (arg?: unknown) => {
    const item = testItemOf(arg);
    const itemProject = item ? d.explorer()?.projectIdFor(item) : undefined;
    const itemFile = item?.uri?.scheme === 'file' && registry.isTestFile(item.uri.fsPath) ? item.uri.fsPath : undefined;
    const af = item ? (itemFile ? { path: itemFile, line: 0 } : undefined) : activeFile();
    const entry = itemProject ? registry.get(itemProject) : af ? registry.projectFor(af.path) : undefined;
    const target = entry ?? (await pickProject(registry));
    if (!target) return;
    const spec = target.spec;
    let configJson = '(worker not ready — start HyperJest or open a test file of this project)';
    try {
      const w = await d.pool.acquire(spec.id, { priority: 0, spare: false });
      try {
        configJson = await new Promise<string>((resolve, reject) => {
          const off = d.pool.on(e => {
            if (e.type === 'message' && e.worker === w && (e.msg as WorkerToHost).type === 'showConfigResult') { off(); resolve((e.msg as { json: string }).json); }
          });
          setTimeout(() => { off(); reject(new Error('timeout waiting for showConfig')); }, 30000);
          w.send({ v: PROTOCOL_VERSION, type: 'showConfig' });
        });
      } finally {
        d.pool.release(w);
      }
    } catch (e) {
      configJson = `(unavailable: ${(e as Error).message})`;
    }
    const sample = spec.jestPkgDir ? buildRunSpec({ project: toRunSpecProject(spec), workerAssetsDir: d.workerAssetsDir, tests: [{ path: af?.path ?? '<test file>' }], runId: 'manual', extraEnv: d.settings.get().env }) : undefined;
    const body = [
      `# HyperJest resolved configuration — ${spec.displayName}`, '',
      '## Project spec', '```json', JSON.stringify(spec, null, 2), '```', '',
      '## Equivalent shell command', '```bash',
      sample ? `cd ${spec.packageDir} && ${Object.entries(spec.env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')} ${sample.command} ${sample.args.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}` : '(jest not resolved)',
      '```', '',
      '## Jest --showConfig (globalConfig + project configs)', '```json', configJson, '```',
    ].join('\n');
    const uri = d.doctor.setContent(body, `config-${spec.id.slice(0, 8)}.md`);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
  };

  const doctor = async () => {
    await registry.refresh();
    const report = buildDoctorReport(registry, d.pool, d.settings.get(), String(d.context.extension.packageJSON.version));
    const uri = d.doctor.setReport(report);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
  };

  /**
   * Chooses which of the package's Jest configs runs the active file. The only lever is a package-level
   * `hyperjest.projects` override (core/projectSpec `findOverride`), which pins the WHOLE package to one
   * config, so this is offered only between sibling configs of the file's own package, says so in a
   * confirmation, replaces any earlier pin of that package and can remove the pin again.
   */
  const selectProjectForFile = async () => {
    const af = activeFile();
    if (!af) return;
    const current = registry.projectFor(af.path);
    if (!current) { void vscode.window.showInformationMessage(`HyperJest: ${path.basename(af.path)} is not inside a Jest project.`); return; }
    const pkgDir = current.spec.packageDir;
    const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    const overrides = d.settings.get().projects;
    const existing = overrides.find(o => overrideTargets(o.packageDir, pkgDir, folders));
    const others = overrides.filter(o => o !== existing);
    const siblings = registry.all().filter(e => e.spec.status === 'ok' && e.spec.packageDir === pkgDir);
    if (siblings.length < 2) {
      if (existing?.configArg) {
        const ok = await vscode.window.showInformationMessage(`HyperJest: ${current.spec.displayName} is pinned to ${existing.configArg} by hyperjest.projects. Remove the pin and rediscover the package's Jest configs?`, { modal: true }, 'Remove Pin');
        if (ok !== 'Remove Pin') return;
        const { configArg: _dropped, ...rest } = existing;
        const keep = Object.keys(rest).some(k => k !== 'packageDir');
        await d.settings.update('projects', keep ? [...others, rest] : others);
      } else {
        void vscode.window.showInformationMessage(`HyperJest: ${path.basename(af.path)} belongs to ${current.spec.displayName}, the only Jest project of its package.`);
      }
      return;
    }
    const pick = await vscode.window.showQuickPick(siblings.map(e => ({
      label: e.spec.displayName,
      description: `${e.spec.flavor}${e === current ? ' · current' : ''}`,
      detail: e.spec.configArg ?? '(implicit config)',
      e,
    })), { placeHolder: `Jest config for ${path.basename(af.path)}` }).then(i => i?.e);
    if (!pick || pick === current) return;
    if (!pick.spec.configArg || pick.spec.flavor === 'shono') {
      void vscode.window.showInformationMessage(`HyperJest: ${pick.spec.displayName} cannot be pinned with hyperjest.projects (${pick.spec.flavor === 'shono' ? 'a configArg override would drop shono\'s environment' : 'it has no config file'}).`);
      return;
    }
    const dropped = siblings.filter(e => e !== pick).map(e => e.spec.displayName).join(', ');
    const ok = await vscode.window.showWarningMessage(
      `Pin ${path.basename(pkgDir)} to ${path.relative(pkgDir, pick.spec.configArg) || pick.spec.configArg}? This writes a hyperjest.projects override: the package's other Jest projects (${dropped}) are no longer discovered until the pin is removed (run this command again).`,
      { modal: true }, 'Pin');
    if (ok !== 'Pin') return;
    await d.settings.update('projects', [...others, { ...existing, packageDir: pkgDir, configArg: pick.spec.configArg }]);
  };

  const showMenu = async () => {
    const state = runner.getState();
    const items: Array<vscode.QuickPickItem & { cmd: string }> = [
      { label: '$(run-all) Run All Tests', cmd: 'hyperjest.runAll' },
      { label: '$(run) Run File Tests', cmd: 'hyperjest.runFileTests' },
      { label: '$(debug-alt) Debug Line Test', cmd: 'hyperjest.debugLineTest' },
      { label: '$(error) Run Failing Tests', cmd: 'hyperjest.runFailingTests' },
      { label: '$(arrow-right) Jump to Failing Test', cmd: 'hyperjest.jumpToFailingTest' },
      { label: state.paused ? '$(debug-start) Resume Live Runs' : '$(debug-pause) Pause Live Runs', cmd: 'hyperjest.togglePause' },
      { label: `$(settings-gear) Run Mode: ${state.runMode} (toggle)`, cmd: 'hyperjest.toggleRunMode' },
      { label: '$(pulse) Doctor', cmd: 'hyperjest.doctor' },
      { label: '$(json) Show Resolved Jest Config', cmd: 'hyperjest.showResolvedConfig' },
      { label: '$(output) Show Output', cmd: 'hyperjest.showOutput' },
      { label: state.started ? '$(debug-stop) Stop HyperJest' : '$(play) Start HyperJest', cmd: state.started ? 'hyperjest.stop' : 'hyperjest.start' },
    ];
    if (state.capped) items.unshift({ label: `$(zap) Run ${state.capped.count} deferred affected test file(s)`, cmd: 'hyperjest.runDeferred' });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'HyperJest' });
    if (pick) await vscode.commands.executeCommand(pick.cmd);
  };

  return [
    reg('hyperjest.start', () => runner.start()),
    reg('hyperjest.stop', () => runner.stop()),
    reg('hyperjest.restart', () => runner.restart()),
    reg('hyperjest.togglePause', () => (runner.getState().paused ? runner.resume() : runner.pause())),
    reg('hyperjest.toggleRunMode', async () => {
      const order: RunMode[] = ['onType', 'onSave', 'manual'];
      const cur = d.settings.get().runMode;
      const next = order[(order.indexOf(cur) + 1) % order.length];
      await d.settings.update('runMode', next);
      void vscode.window.setStatusBarMessage(`HyperJest run mode: ${next}`, 2000);
    }),
    reg('hyperjest.runAll', async () => reportRun(await runner.runAll())),
    reg('hyperjest.runProjectTests', async () => {
      const af = activeFile();
      const entry = af ? registry.projectFor(af.path) : await pickProject(registry);
      if (entry) reportRun(await runner.runProject(entry.spec.id));
      else if (af) void vscode.window.showWarningMessage(`HyperJest: no Jest project contains ${path.basename(af.path)}.`, 'Doctor').then(c => c && vscode.commands.executeCommand('hyperjest.doctor'));
    }),
    reg('hyperjest.runFileTests', async (arg) => {
      const uri = arg instanceof vscode.Uri ? arg : undefined;
      const p = uri?.fsPath ?? activeFile()?.path;
      if (p) await runFileTests(p);
    }),
    reg('hyperjest.runLineTests', (arg) => runLineTarget(arg, 'run')),
    reg('hyperjest.runFailingTests', () => runner.runFailing()),
    reg('hyperjest.runDeferred', () => runner.runDeferred()),
    reg('hyperjest.debugLineTest', (arg) => runLineTarget(arg, 'debug')),
    reg('hyperjest.debugFileTests', async (arg) => {
      const uri = arg instanceof vscode.Uri ? arg : undefined;
      const p = uri?.fsPath ?? activeFile()?.path;
      if (p) await runner.debug({ path: p });
    }),
    reg('hyperjest.updateTestSnapshots', async (arg) => {
      if (arg && typeof arg === 'object' && 'testKey' in arg) { await runner.updateSnapshots({ kind: 'test', testKey: (arg as { testKey: string }).testKey }); return; }
      const item = testItemOf(arg);
      if (item) {
        const selections = d.explorer()?.selectionsFor([item]) ?? [];
        if (selections.length) await runner.updateSnapshots({ kind: 'selection', selections });
        return;
      }
      const t = lineOf(arg);
      if (!t) return;
      const parsed = runner.docs.ensureForLookup(t.path);
      const { findTestAtLine, testFullNames } = await import('./core/testIds');
      const hit = parsed ? findTestAtLine(parsed, t.line) : null;
      const names = hit ? testFullNames(hit.ancestry, hit.node) : undefined;
      await runner.updateSnapshots({ kind: 'selection', selections: [{ path: t.path, names: names?.exact ? names.names : undefined }] });
    }),
    reg('hyperjest.updateFileSnapshots', async (arg) => {
      const uri = arg instanceof vscode.Uri ? arg : undefined;
      const p = uri?.fsPath ?? activeFile()?.path;
      if (p) reportRun(await runner.updateSnapshots({ kind: 'file', path: p }), p);
    }),
    reg('hyperjest.updateProjectSnapshots', async () => {
      const af = activeFile();
      const entry = af ? registry.projectFor(af.path) : await pickProject(registry);
      if (!entry) return;
      const ok = await vscode.window.showWarningMessage(`Update ALL snapshots of ${entry.spec.displayName}?`, { modal: true }, 'Update');
      if (ok === 'Update') await runner.updateSnapshots({ kind: 'project', projectId: entry.spec.id });
    }),
    reg('hyperjest.jumpToFailingTest', jumpToFailingTest),
    reg('hyperjest.jumpToErrorSource', jumpToErrorSource),
    reg('hyperjest.showLineDetails', showLineDetails),
    reg('hyperjest.showDiff', async (arg) => {
      const hasDiff = (x: TestRecord) => isFailingStatus(x.status) && x.failures.some(f => f.expected !== undefined);
      const item = testItemOf(arg);
      const key = arg && typeof arg === 'object' && 'testKey' in arg ? (arg as { testKey: string }).testKey : typeof arg === 'string' ? arg : undefined;
      const af = item ? undefined : activeFile();
      const t = item ? recordsOf(item).find(hasDiff)
        : key ? store.test(key) : af ? store.testsInFile(af.path).find(hasDiff) : undefined;
      if (!t) { void vscode.window.showInformationMessage('HyperJest: no expected/actual diff available here.'); return; }
      await d.diff.showDiff(t.testKey);
    }),
    reg('hyperjest.copyValue', copyValue),
    reg('hyperjest.clearValues', (arg) => { const t = lineOf(arg); if (t) d.clearInline(t.path, t.line); }),
    reg('hyperjest.clearFileValues', (arg) => { const t = lineOf(arg); if (t) d.clearInline(t.path); }),
    reg('hyperjest.toggleCoverage', () => d.toggleCoverage()),
    reg('hyperjest.selectProjectForFile', () => selectProjectForFile()),
    reg('hyperjest.showResolvedConfig', showResolvedConfig),
    reg('hyperjest.doctor', doctor),
    reg('hyperjest.copyDiagnostics', async () => {
      const report = buildDoctorReport(registry, d.pool, d.settings.get(), String(d.context.extension.packageJSON.version));
      const { renderDoctorReport } = await import('./doctorView');
      await vscode.env.clipboard.writeText(renderDoctorReport(report));
      void vscode.window.showInformationMessage('HyperJest: diagnostics report copied to the clipboard.');
    }),
    reg('hyperjest.clearCache', async () => {
      for (const e of registry.all()) { store.clearProject(e.spec.id); d.pool.killProject(e.spec.id, 'clear cache'); }
      // ConfigCache keeps no in-memory copy, so the registry's instance sees the cleared memento too.
      await new ConfigCache(d.context.globalState).clear();
      // ...and the matchers it learned from those configs fall back to Jest's defaults.
      registry.clearConfigCache();
      // Open files of projects with a custom testMatch/testRegex would otherwise stay misclassified.
      runner.relearnOpenDocuments();
      void vscode.window.showInformationMessage('HyperJest: caches cleared; workers will restart on demand.');
    }),
    reg('hyperjest.showOutput', () => log.show()),
    reg('hyperjest.showMenu', showMenu),
    reg('hyperjest.openFrame', (arg) => {
      const f = typeof arg === 'string' ? (JSON.parse(arg) as Frame) : (arg as Frame);
      return openFrame(f);
    }),
    reg('hyperjest.openDoctorReport', async () => {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(doctorUri()), { preview: true });
    }),
  ];
}

/** Whether a `hyperjest.projects[].packageDir` (absolute or workspace-relative) names `packageDir`. */
export function overrideTargets(overrideDir: string, packageDir: string, workspaceFolders: readonly string[]): boolean {
  const bases = path.isAbsolute(overrideDir) ? [overrideDir] : workspaceFolders.length ? workspaceFolders.map(f => path.join(f, overrideDir)) : [path.resolve(overrideDir)];
  return bases.some(b => path.resolve(b) === path.resolve(packageDir));
}

async function pickProject(registry: ProjectRegistry) {
  const entries = registry.all().filter(e => e.spec.status === 'ok');
  if (entries.length === 1) return entries[0];
  const pick = await vscode.window.showQuickPick(entries.map(e => ({ label: e.spec.displayName, description: `${e.spec.flavor} · jest ${e.spec.jestVersion ?? '?'}`, detail: e.spec.packageDir, e })), { placeHolder: 'Jest project' });
  return pick?.e;
}
