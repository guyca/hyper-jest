/**
 * HyperJest extension entry point: wires discovery, the worker pool, the run coordinator, the result
 * store and every UI surface. All heavy lifting lives in the modules; this file only composes them.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { OutputLogger } from './log';
import { Settings } from './settings';
import { WorkerPool } from './workerPool';
import { ProjectRegistry } from './discovery/projectRegistry';
import { WorkerDiscoveryExecutor } from './discovery/discoveryExecutor';
import { ResultStore } from './results/resultStore';
import { computeLineView } from './results/lineView';
import { LineShiftTracker } from './results/lineShift';
import type { LineViewFile } from './core/resultModel';
import type { ProjectSpec } from './core/protocol';
import { RunCoordinator } from './runner';
import { IconAssets } from './iconAssets';
import { DecorationManager } from './decorations';
import { ContextKeys } from './contextKeys';
import { DiagnosticsPublisher } from './diagnostics';
import { HyperJestHoverProvider } from './hover';
import { StatusBar } from './statusBar';
import { recordParsed, TestExplorer } from './testTree';
import { TestCodeLensProvider } from './codeLens';
import { DoctorContentProvider, DOCTOR_SCHEME } from './doctorView';
import { DiffContentProvider, DIFF_SCHEME } from './diffView';
import { registerCommands } from './commands';
import { disposeRunArtifacts } from './overlayManifest';

const LANGUAGES = ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = new OutputLogger('HyperJest');
  const settings = new Settings();
  const version = String(context.extension.packageJSON.version);
  log.info(`HyperJest ${version} activating (VS Code ${vscode.version}, host node ${process.versions.node})`);

  const workerAssetsDir = path.join(context.extensionPath, 'dist', 'worker');
  const pool = new WorkerPool({
    workerEntry: path.join(workerAssetsDir, 'hyperjestWorker.cjs'),
    workerAssetsDir,
    getSettings: () => settings.get(),
    log,
  });
  const discoverySettings = () => { const s = settings.get(); return JSON.stringify([s.projects, s.discovery, s.nodePath, s.nodeArgs, s.env]); };
  let previousDiscoverySettings = discoverySettings();
  const discovery = new WorkerDiscoveryExecutor(path.join(context.extensionPath, 'dist', 'discoveryWorker.js'), log);
  const registry = new ProjectRegistry(pool, () => settings.get(), log, context.globalState, discovery);
  const store = new ResultStore({ maxEntriesPerLine: Math.max(10, settings.get().console.maxEntriesPerTest) });
  const runner = new RunCoordinator(pool, registry, store, () => settings.get(), workerAssetsDir, log);

  // --- UI -------------------------------------------------------------------------------------
  const icons = new IconAssets(path.join(context.globalStorageUri.fsPath, 'icons'), settings.get().colors);
  await icons.ensure();
  const decorations = new DecorationManager(icons, () => settings.get());
  const contextKeys = new ContextKeys();
  const diagnostics = new DiagnosticsPublisher(store, () => settings.get().reportFailuresAsProblems);
  const statusBar = new StatusBar();
  const doctorProvider = new DoctorContentProvider();
  const diffProvider = new DiffContentProvider(store);
  let coverageVisible = true;

  // Unsaved edits move lines: run data (recorded for the text the run saw) is remapped onto the buffer
  // until a run refreshes it, so re-applied decorations stay on their lines.
  const lineShifts = new LineShiftTracker(store);
  // Line views are cheap but computed per visible editor on every store change; cache per generation.
  const viewCache = new Map<string, { gen: number; shift: unknown; shiftVersion: number; view: LineViewFile }>();
  const viewFor = (p: string): LineViewFile | undefined => {
    const shift = lineShifts.get(p);
    const cached = viewCache.get(p);
    if (cached && cached.gen === store.generation && cached.shift === shift && cached.shiftVersion === (shift?.version ?? 0)) return cached.view;
    const s = settings.get();
    const view = computeLineView(store, p, {
      maxLength: s.inline.maxLength, maxLogsPerLine: s.inline.maxLogsPerLine, showErrors: s.inline.showErrors, showLogs: s.inline.showLogs, showValues: s.inline.showValues,
      mapLine: shift ? l => shift.map(l) : undefined,
    });
    if (!coverageVisible) for (const line of view.lines.values()) if (line.state && line.state !== 'errorSource') line.state = undefined;
    viewCache.set(p, { gen: store.generation, shift, shiftVersion: shift?.version ?? 0, view });
    return view;
  };

  // The Test Explorer exists only while `hyperjest.testExplorer.enabled` (created/disposed on change).
  let explorer: TestExplorer | undefined;
  // Projects expanded in the Explorer: their real configs are learned again when HyperJest (re)starts,
  // because expansion while stopped (or before activation finished starting) cannot boot a worker.
  const expandedProjects = new Set<string>();
  let wasStarted = false;
  const onRunnerState = (started: boolean) => {
    if (started && !wasStarted) {
      for (const id of expandedProjects) {
        const e = registry.get(id);
        if (e && e.spec.status === 'ok' && e.configsSource === 'static') void registry.ensureReady(id).catch(() => undefined);
      }
    }
    wasStarted = started;
  };
  const syncExplorerProjects = (ex: TestExplorer, specs: readonly ProjectSpec[]) => {
    const live = new Set<string>();
    for (const spec of specs) if (spec.status !== 'disabled' && spec.selected !== false) {
      ex.buildProjectItem(spec); live.add(spec.id);
      if (ex.isProjectResolved(spec.id)) {
        const entry = registry.get(spec.id), revision = entry?.revision;
        void registry.testFilesOf(spec.id).then(files => {
          if (registry.get(spec.id) === entry && entry?.revision === revision && entry?.spec.selected !== false) ex.setProjectFiles(spec.id, files);
        }, error => log.warn(`Could not refresh ${spec.displayName}: ${String(error)}`));
      }
    }
    for (const id of ex.projectIds()) if (!live.has(id)) ex.removeProject(id);
  };
  const createExplorer = (): TestExplorer => {
    const ex: TestExplorer = new TestExplorer({
      store,
      runner,
      settings: () => settings.get(),
      log,
      resolveChildren: async target => {
        if (target.kind === 'root') {
          await registry.refresh();
          syncExplorerProjects(ex, registry.all().map(e => e.spec));
        } else if (target.kind === 'project') {
          const files = await registry.testFilesOf(target.projectId);
          ex.setProjectFiles(target.projectId, files);
          expandedProjects.add(target.projectId);
          void registry.ensureReady(target.projectId).catch(() => undefined);
        } else {
          const parsed = runner.docs.ensure(target.path);
          if (parsed) ex.setFileParsed(target.projectId, target.path, parsed);
        }
      },
    });
    // Created after discovery (setting re-enabled): show the known projects right away.
    syncExplorerProjects(ex, registry.all().map(e => e.spec));
    return ex;
  };
  const syncExplorerEnabled = () => {
    const enabled = settings.get().testExplorer.enabled;
    if (enabled && !explorer) explorer = createExplorer();
    else if (!enabled && explorer) { explorer.dispose(); explorer = undefined; }
  };
  syncExplorerEnabled();

  // Parsed test files feed the store (declaration lines, snapshot lines) and the Explorer tree.
  // An unrecoverable syntax error keeps the last good parse (recordParsed) while the user is typing.
  context.subscriptions.push(runner.docs.onDidParse((p, parsed) => {
    recordParsed(store, p, parsed);
    if (explorer) for (const entry of registry.projectsFor(p)) if (registry.acceptsTest(entry.spec.id, p)) explorer.setFileParsed(entry.spec.id, p, parsed);
  }));

  const codeLens = new TestCodeLensProvider(store, () => settings.get());

  const refreshEditors = (paths?: readonly string[]) => {
    const editors = vscode.window.visibleTextEditors.filter(ed => ed.document.uri.scheme === 'file' && (!paths || paths.includes(ed.document.uri.fsPath)));
    for (const ed of editors) decorations.apply(ed, viewFor(ed.document.uri.fsPath), store.parsed(ed.document.uri.fsPath));
    const active = vscode.window.activeTextEditor;
    if (active && active.document.uri.scheme === 'file') {
      const p = active.document.uri.fsPath;
      contextKeys.updateEditor(viewFor(p), { isTestFile: registry.isTestFile(p), isSourceFile: registry.isSourceFile(p) }, active.selection.active.line);
    } else if (!paths) {
      // Doctor report, diff side, untitled buffer or no editor: the previous file's keys must not linger.
      contextKeys.clearEditor();
    }
  };
  const refreshStatus = () => {
    const state = runner.getState();
    statusBar.update({ summary: store.summary(), state, compact: settings.get().statusBar.compact });
    contextKeys.updateRunState({ running: state.running, paused: state.paused, runMode: state.runMode, started: state.started, hasDeferred: !!state.capped });
  };

  context.subscriptions.push(
    log, settings, registry, runner, decorations, contextKeys, diagnostics, statusBar, doctorProvider, diffProvider, codeLens,
    { dispose: () => { explorer?.dispose(); explorer = undefined; } },
    { dispose: () => pool.shutdownAll() },
    { dispose: disposeRunArtifacts },
    store.onDidChange(paths => {
      refreshEditors(paths);
      diagnostics.update(paths);
      diffProvider.onStoreChange(paths);
      refreshStatus();
      if (settings.get().codeLens.enabled) codeLens.refresh();
    }),
    runner.onDidChangeState(state => { refreshStatus(); onRunnerState(state.started); }),
    vscode.window.onDidChangeVisibleTextEditors(() => refreshEditors()),
    vscode.window.onDidChangeActiveTextEditor(() => refreshEditors()),
    vscode.window.onDidChangeTextEditorSelection(e => {
      if (e.textEditor === vscode.window.activeTextEditor) contextKeys.updateCursor(viewFor(e.textEditor.document.uri.fsPath), e.selections[0]?.active.line);
    }),
    vscode.workspace.onDidOpenTextDocument(doc => { if (doc.uri.scheme === 'file' && registry.isTestFile(doc.uri.fsPath)) runner.docs.update(doc.uri.fsPath, doc.getText()); }),
    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.scheme !== 'file' || e.contentChanges.length === 0) return;
      lineShifts.noteEdit(e.document.uri.fsPath, e.contentChanges.map(c => ({
        startLine: c.range.start.line, startCharacter: c.range.start.character, endLine: c.range.end.line, endCharacter: c.range.end.character, text: c.text,
      })));
    }),
    // Line views are recomputed on demand; closed documents must not pin theirs for the whole session
    // (and a buffer closed without saving leaves its edits behind).
    vscode.workspace.onDidCloseTextDocument(doc => { if (doc.uri.scheme === 'file') { viewCache.delete(doc.uri.fsPath); lineShifts.forget(doc.uri.fsPath); } }),
    settings.onDidChange(async () => {
      registry.onSettingsChanged();
      const nextDiscoverySettings = discoverySettings();
      if (nextDiscoverySettings !== previousDiscoverySettings) { previousDiscoverySettings = nextDiscoverySettings; await registry.refresh(); }
      syncExplorerEnabled();
      // onColorsChanged pushes hyperjest.colors.* into IconAssets, regenerates icons and recreates the types.
      await decorations.onColorsChanged();
      viewCache.clear();
      refreshEditors();
      diagnostics.refreshAll();
      refreshStatus();
      codeLens.refresh();
    }),
    vscode.languages.registerHoverProvider(LANGUAGES.map(language => ({ language, scheme: 'file' })), new HyperJestHoverProvider(store, viewFor)),
    vscode.workspace.registerTextDocumentContentProvider(DOCTOR_SCHEME, doctorProvider),
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffProvider),
    registry.onDidChange(e => {
      // Projects that disappeared (or became disabled, e.g. a hyperjest.projects pin) leave the tree.
      if (e.type === 'refreshed' && explorer) syncExplorerProjects(explorer, e.result.specs);
      if (e.type === 'ready') {
        // The worker's configs replace the default matchers: open files may only now be (or stop being) tests.
        refreshEditors();
        const ex = explorer;
        if (ex?.isProjectResolved(e.projectId)) void registry.testFilesOf(e.projectId).then(files => ex.setProjectFiles(e.projectId, files), () => undefined);
      }
      if (e.type === 'initError') {
        const entry = registry.get(e.projectId);
        void vscode.window.showWarningMessage(`HyperJest: ${entry?.spec.displayName ?? e.projectId}: ${e.error.error.message}`, 'Doctor', 'Show Output')
          .then(c => c === 'Doctor' ? vscode.commands.executeCommand('hyperjest.doctor') : c === 'Show Output' ? log.show() : undefined);
      }
    }),
  );

  context.subscriptions.push(vscode.languages.registerCodeLensProvider(LANGUAGES.map(language => ({ language, scheme: 'file' })), codeLens));

  context.subscriptions.push(...registerCommands({
    context, runner, registry, store, settings, pool, log, doctor: doctorProvider, diff: diffProvider, workerAssetsDir,
    clearInline: (p, line) => {
      // `line` is a buffer line; the store keys entries by the line the run recorded.
      const shift = line === undefined ? undefined : lineShifts.get(p);
      if (shift) { for (const recorded of [...store.entriesFor(p).keys()]) if (shift.map(recorded) === line) store.clearInlineEntries(p, recorded); }
      else store.clearInlineEntries(p, line);
      viewCache.delete(p); refreshEditors([p]);
    },
    mapLine: p => { const shift = lineShifts.get(p); return shift ? l => shift.map(l) : undefined; },
    toggleCoverage: () => { coverageVisible = !coverageVisible; viewCache.clear(); refreshEditors(); },
    explorer: () => explorer,
  }));

  refreshStatus();
  // Import and select configurations before Smart Start schedules the selected tests.
  await runner.start();
  log.info('HyperJest started');
}

export function deactivate(): void {
  // Everything is registered in context.subscriptions and disposed by VS Code.
}
