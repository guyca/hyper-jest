/**
 * RunCoordinator: the heart of HyperJest's host side. Owns the run queue, dispatches test files to
 * warm workers (or the CLI engine), routes results into the ResultStore, and implements the live
 * behaviours: on-type / on-save affected runs from unsaved buffers, Smart Start, continuous runs,
 * snapshot updates, debugging and cancellation.
 */
import * as path from 'path';
import { scopedMessage } from './core/hyperConfig';
import * as vscode from 'vscode';
import type { Logger } from './core/logger';
import type { HyperJestSettings, RunMode } from './core/settingsModel';
import {
  PROTOCOL_VERSION, type OverlayChange, type RunMsg, type RunTestSelection, type UpdateSnapshotMode, type WorkerToHost,
} from './core/protocol';
import { selectAffected, type AffectedResult } from './core/affected';
import { analyzeChange, type ChangeAnalysis } from './core/changeAnalyzer';
import { diffLines } from './core/textDiff';
import { findTestAtLine, testFullNames } from './core/testIds';
import { parseTestKey } from './core/protocol';
import type { ResultStore } from './results/resultStore';
import { WorkerInitError, type WorkerHandle, type WorkerPool } from './workerPool';
import { ProjectRegistry } from './discovery/projectRegistry';
import { OverlayTracker } from './overlay';
import { DocumentIndex } from './documents';
import { findRelatedTests, runCli, type CliRunHandle } from './cliEngine';
import { startDebugSession } from './debug';
import type { CancellationLike, RunHandle, RunOptions, RunOutcome, RunReason, RunnerApi, RunnerState, SnapshotScope } from './runnerApi';

const PRIORITY: Record<RunReason, number> = { explicit: 0, failing: 0, continuous: 1, onType: 2, affected: 2, onSave: 3, open: 4, smartStart: 5 };

interface QueuedFile {
  key: string;
  projectId: string;
  selection: RunTestSelection;
  priority: number;
  reason: RunReason;
  updateSnapshot: UpdateSnapshotMode;
  seq: number;
  /** Every run group waiting for this file (merged requests share one queued item). */
  groups: Set<RunGroup>;
}

interface RunGroup {
  id: string;
  /** Queued/running items this group still waits for. */
  pending: Set<QueuedFile>;
  interrupted: boolean;
  error?: string;
  resolve: (o: RunOutcome) => void;
  done: Promise<RunOutcome>;
}

interface ActiveRun {
  runId: string;
  item: QueuedFile;
  worker?: WorkerHandle;
  cli?: CliRunHandle;
  /** Withdraws the pool request while the run still waits for a worker. */
  acquireAbort?: AbortController;
  cancelled: boolean;
  completed?: Promise<unknown>;
  /** Fires when a warm run never reports `runComplete` within `runTimeoutMs`. */
  watchdog?: NodeJS.Timeout;
  /** Worker memory reported with `runComplete` (lets the pool recycle an oversized worker right away). */
  memory?: { rss: number; heapUsed: number };
  finish: (interrupted: boolean, error?: string) => void;
}

let seq = 0;
let groupSeq = 0;

export class RunCoordinator implements RunnerApi, vscode.Disposable {
  private readonly queue = new Map<string, QueuedFile>();
  private readonly active = new Map<string, ActiveRun>();           // runId -> run
  private readonly activeByFile = new Map<string, ActiveRun>();     // fileKey -> run
  private readonly cliFallback = new Map<string, string>();         // projectId -> reason
  private readonly inverseGraph = new Map<string, Map<string, Set<string>>>(); // projectId -> file -> importers
  private readonly graphTestFiles = new Map<string, Set<string>>();               // projectId -> test files Jest knows
  /** projectId -> the worker asked for the static graph (asked again once that worker is gone). */
  private readonly graphRequested = new Map<string, WorkerHandle>();
  /** watch id -> projectId -> selections of a continuous run. */
  private readonly continuous = new Map<string, Map<string, RunTestSelection[]>>();
  /** On-type affected runs per edited file: the text they ran for, so a save of that same text does not re-run. */
  private readonly onTypeRuns = new Map<string, { text: string; outcome?: RunOutcome; done: Promise<RunOutcome> | undefined }>();
  private readonly deferred = new Map<string, RunTestSelection>();  // path -> selection (capped on-type runs)
  private readonly changeTimers = new Map<string, NodeJS.Timeout>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly stateEmitter = new vscode.EventEmitter<RunnerState>();
  readonly overlay: OverlayTracker;
  readonly docs = new DocumentIndex();
  private started = false;
  private initializing = false;
  private readonly debuggingFiles = new Set<string>();
  private knownSpecs = new Map<string, string>();
  private paused = false;
  private stateTimer: NodeJS.Timeout | undefined;
  private lastError: string | undefined;

  constructor(
    private readonly pool: WorkerPool,
    private readonly registry: ProjectRegistry,
    private readonly store: ResultStore,
    private readonly settings: () => HyperJestSettings,
    private readonly workerAssetsDir: string,
    private readonly log: Logger,
  ) {
    this.overlay = new OverlayTracker(
      doc => this.isInteresting(doc),
      p => registry.projectsFor(p).map(e => e.spec.id),
      (projectId, changes) => this.sendOverlay(projectId, changes),
    );
    this.disposables.push(
      this.overlay,
      { dispose: pool.on(e => this.onPoolEvent(e)) },
      registry.onDidChange(e => this.onRegistryEvent(e)),
      vscode.workspace.onDidChangeTextDocument(e => this.onDocumentChanged(e.document, e.contentChanges.length > 0)),
      vscode.workspace.onDidSaveTextDocument(doc => this.onDocumentSaved(doc)),
      vscode.workspace.onDidOpenTextDocument(doc => this.onDocumentOpened(doc)),
      // Virtual documents (git:, diff views) share the fsPath of the real file; only the real one owns its parse.
      vscode.workspace.onDidCloseTextDocument(doc => {
        if (doc.uri.scheme !== 'file') return;
        this.docs.forget(doc.uri.fsPath);
        for (const key of this.onTypeRuns.keys()) if (key.endsWith(`\0${doc.uri.fsPath}`)) this.onTypeRuns.delete(key);
      }),
      vscode.workspace.onDidCreateFiles(e => this.onFilesChanged(e.files)),
      vscode.workspace.onDidDeleteFiles(e => this.onFilesChanged(e.files)),
      vscode.workspace.onDidRenameFiles(e => this.onFilesChanged(e.files.flatMap(f => [f.oldUri, f.newUri]))),
      vscode.window.onDidChangeActiveTextEditor(ed => ed && this.onDocumentOpened(ed.document)),
    );
  }

  // ------------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.registry.setAutoBoot(true);
    this.emitState();
    this.initializing = true;
    try {
      await this.registry.refresh();
      if (!this.started) return;
      for (const doc of vscode.workspace.textDocuments) this.onDocumentOpened(doc);
      if (this.settings().smartStart === 'always' && this.settings().runMode !== 'manual') await this.runAll('smartStart');
    } finally { this.initializing = false; }
    if (this.settings().smartStart !== 'always') for (const doc of vscode.workspace.textDocuments) this.onDocumentOpened(doc);
  }

  stop(): void {
    this.started = false;
    // Before the kills: a lookup racing the stop (sibling tie, opened file) must not boot a worker again.
    this.registry.setAutoBoot(false);
    this.cancel('all');
    for (const e of this.registry.all()) this.pool.killProject(e.spec.id, 'stopped');
    this.graphRequested.clear();
    this.emitState();
  }

  async restart(): Promise<void> {
    this.stop();
    await this.start();
  }

  pause(): void { this.paused = true; this.emitState(); }
  resume(): void { this.paused = false; this.emitState(); this.pump(); }

  setRunMode(mode: RunMode): void {
    void vscode.workspace.getConfiguration('hyperjest').update('runMode', mode, vscode.ConfigurationTarget.Workspace);
    this.emitState();
  }

  dispose(): void {
    this.cancel('all');
    this.disposables.forEach(d => d.dispose());
    for (const t of this.changeTimers.values()) clearTimeout(t);
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.stateEmitter.dispose();
  }

  // ------------------------------------------------------------------ RunnerApi

  getState(): RunnerState {
    const s = this.settings();
    const capped = this.deferred.size ? { count: this.deferred.size, selections: [...this.deferred.values()] } : undefined;
    return {
      started: this.started, running: this.active.size > 0, paused: this.paused, runMode: s.runMode,
      activeRuns: this.active.size, queuedFiles: this.queue.size, capped, lastError: this.lastError,
    };
  }

  onDidChangeState(listener: (state: RunnerState) => void): { dispose(): void } {
    return this.stateEmitter.event(listener);
  }

  projectIdForFile(p: string): string | undefined { return this.registry.projectIdFor(p); }

  async runFiles(selections: RunTestSelection[], reason: RunReason, opts: RunOptions = {}): Promise<RunHandle> {
    const group = this.newGroup();
    if (!this.started) {
      // Stopped means no runs at all (the status bar says so); nothing is queued or spawned.
      const notRun = 'HyperJest is stopped (run "HyperJest: Start")';
      group.resolve({ wasInterrupted: false, error: notRun });
      return { runId: group.id, done: group.done, notRun };
    }
    const updateSnapshot = opts.updateSnapshot ?? this.defaultSnapshotMode();
    let count = 0;
    let skipError: string | undefined;
    for (const sel of selections) {
      const entries = sel.projectId ? [this.registry.get(sel.projectId)].filter((e): e is NonNullable<typeof e> => !!e)
        : this.registry.projectsFor(sel.path);
      for (const entry of entries) {
        const projectId = entry.spec.id;
        if (entry.spec.status !== 'ok' || entry.spec.selected === false) { skipError = entry.spec.reason ?? 'Configuration is not selected'; continue; }
        try { await this.registry.resolveMatchers(projectId); }
        catch (error) { skipError = `${entry.spec.displayName}: ${(error as Error).message}`; this.log.warn(skipError); continue; }
        if (!this.started || this.registry.get(projectId) !== entry || this.registry.get(projectId)?.spec.selected === false) continue;
        if (!this.registry.acceptsTest(projectId, sel.path)) { skipError = `Not matched by selected configuration: ${sel.path}`; continue; }
        this.enqueue({ projectId, selection: { ...sel, projectId }, reason, priority: opts.priority ?? PRIORITY[reason], updateSnapshot, group });
        count++;
      }
      if (!entries.length) skipError = `no Jest project selected for ${sel.path}`;
    }
    if (!count) group.resolve({ wasInterrupted: false, error: skipError });
    this.pump();
    return { runId: group.id, done: group.done, notRun: count ? undefined : skipError ?? 'no test files to run' };
  }

  runTests(testKeys: string[], reason: RunReason = 'explicit', opts?: RunOptions): Promise<RunHandle> {
    const byTarget = new Map<string, RunTestSelection>();
    for (const key of testKeys) {
      const record = this.store.test(key);
      const { path: p, fullName, projectId: keyProject } = parseTestKey(key);
      const projectId = record?.projectId ?? keyProject;
      const id = `${projectId ?? ''}\0${p}`;
      const selection = byTarget.get(id) ?? { path: p, projectId, names: [] };
      selection.names!.push(record?.fullName ?? fullName);
      byTarget.set(id, selection);
    }
    return this.runFiles([...byTarget.values()], reason, opts);
  }

  /** Runs the test under the cursor (whole file when the name is dynamic). */
  async runLine(filePath: string, line0: number, mode: 'run' | 'debug'): Promise<RunHandle | undefined> {
    const lookup = this.docs.lookupAtLine(filePath, line0);
    if (!lookup) {
      void vscode.window.showInformationMessage('HyperJest: cannot identify a test on this line while the file has a syntax error.');
      return undefined;
    }
    const hit = findTestAtLine(lookup.parsed, lookup.line);
    const selection: RunTestSelection = { path: filePath };
    if (hit) {
      const { names, exact } = testFullNames(hit.ancestry, hit.node);
      if (exact && names.length) selection.names = names;
    }
    if (mode === 'debug') { await this.debug(selection); return undefined; }
    return this.runFiles([selection], 'explicit');
  }

  async debug(selection: RunTestSelection): Promise<void> {
    const candidates = selection.projectId ? [this.registry.get(selection.projectId)].filter((e): e is NonNullable<typeof e> => !!e)
      : this.registry.projectsFor(selection.path);
    for (const candidate of candidates) await this.registry.resolveMatchers(candidate.spec.id);
    const matching = candidates.filter(e => this.registry.acceptsTest(e.spec.id, selection.path));
    const entry = matching.length === 1 ? matching[0] : (await vscode.window.showQuickPick(matching.map(e => ({ label: e.spec.displayName, e })), { placeHolder: 'Configuration to debug' }))?.e;
    if (!entry) return;
    selection = { ...selection, projectId: entry.spec.id };
    const title = selection.names?.length === 1 ? selection.names[0] : path.basename(selection.path);
    this.debuggingFiles.add(selection.path);
    const active = [...this.active.values()].filter(r => r.item.selection.path === selection.path);
    this.cancelFile(selection.path, 'debug session');
    await Promise.all(active.map(r => r.completed));
    try { await startDebugSession({
      spec: entry.spec, tests: [selection], title, overlay: this.overlay.entriesFor(entry.spec.id),
      workerAssetsDir: this.workerAssetsDir, settings: this.settings(), log: this.log,
    }); } finally { this.debuggingFiles.delete(selection.path); this.pump(); }
    await this.runFiles([{ path: selection.path, projectId: entry.spec.id }], 'explicit');
  }

  async updateSnapshots(scope: SnapshotScope): Promise<RunHandle> {
    const opts: RunOptions = { updateSnapshot: 'all', priority: 0 };
    switch (scope.kind) {
      case 'test': return this.runTests([scope.testKey], 'explicit', opts);
      case 'file': return this.runFiles([{ path: scope.path }], 'explicit', opts);
      case 'selection': return this.runFiles(scope.selections, 'explicit', opts);
      case 'project': {
        const files = await this.registry.testFilesOf(scope.projectId);
        return this.runFiles(files.map(p => ({ path: p, projectId: scope.projectId })), 'explicit', opts);
      }
    }
  }

  cancel(runId: string | 'all'): void {
    if (runId === 'all') {
      // Stale marks stay: no run refreshed those files since their last edit.
      for (const q of [...this.queue.values()]) this.dropQueued(q, true);
      for (const run of [...this.active.values()]) this.cancelRun(run, 'cancel all');
      this.deferred.clear();
      this.emitState();
      return;
    }
    for (const q of [...this.queue.values()]) {
      const group = [...q.groups].find(g => g.id === runId);
      if (!group) continue;
      // A merged item keeps running for its other groups; only this group stops waiting.
      if (q.groups.size > 1) this.detachGroup(q, group, true);
      else this.dropQueued(q, true);
    }
    for (const run of [...this.active.values()]) {
      if (run.runId === runId) { this.cancelRun(run, 'cancelled'); continue; }
      const group = [...run.item.groups].find(g => g.id === runId);
      if (!group) continue;
      if (run.item.groups.size > 1) this.detachGroup(run.item, group, true);
      else this.cancelRun(run, 'cancelled');
    }
    this.emitState();
  }

  watch(selections: RunTestSelection[], token: CancellationLike): void {
    const id = `w${++seq}`;
    // A selection may span several packages: each project re-runs its own part on its edits.
    const byProject = new Map<string, RunTestSelection[]>();
    for (const sel of selections) {
      const ids = sel.projectId ? [sel.projectId] : this.registry.projectsFor(sel.path).map(e => e.spec.id);
      for (const projectId of ids) {
        const list = byProject.get(projectId) ?? [];
        list.push({ ...sel, projectId }); byProject.set(projectId, list);
      }
    }
    if (!byProject.size) return;
    this.continuous.set(id, byProject);
    void this.runFiles(selections, 'continuous');
    token.onCancellationRequested(() => this.continuous.delete(id));
  }

  /** Selections of every continuous run that watches `projectId`. */
  private continuousSelections(projectId: string): RunTestSelection[] {
    return [...this.continuous.values()].flatMap(byProject => byProject.get(projectId) ?? []);
  }

  /** Runs every test file of every runnable project. */
  async runAll(reason: RunReason = 'explicit'): Promise<RunHandle> {
    const selections: RunTestSelection[] = [];
    for (const e of this.registry.all()) {
      if (e.spec.status !== 'ok' || e.spec.selected === false) continue;
      try { for (const f of await this.registry.testFilesOf(e.spec.id)) selections.push({ path: f, projectId: e.spec.id }); }
      catch (error) { this.log.warn(`${e.spec.displayName}: ${String(error)}`); }
    }
    return this.runFiles(selections, reason);
  }

  async runProject(projectId: string): Promise<RunHandle> {
    const files = await this.registry.testFilesOf(projectId);
    return this.runFiles(files.map(p => ({ path: p, projectId })), 'explicit');
  }

  runFailing(): Promise<RunHandle> {
    return this.runTests(this.store.failingTests().map(t => t.testKey), 'failing');
  }

  /** Runs the on-type selections that were deferred by `liveRun.maxTestFilesPerEdit`. */
  runDeferred(): Promise<RunHandle> {
    const sels = [...this.deferred.values()];
    this.deferred.clear();
    this.emitState();
    return this.runFiles(sels, 'onSave');
  }

  // ------------------------------------------------------------------ queue + dispatch

  private newGroup(): RunGroup {
    let resolve!: (o: RunOutcome) => void;
    const done = new Promise<RunOutcome>(r => { resolve = r; });
    return { id: `g${++groupSeq}-${Date.now().toString(36)}`, pending: new Set(), interrupted: false, resolve, done };
  }

  private enqueue(input: { projectId: string; selection: RunTestSelection; reason: RunReason; priority: number; updateSnapshot: UpdateSnapshotMode; group: RunGroup }): void {
    const key = `${input.projectId}\0${input.selection.path}`;
    let item = this.queue.get(key);
    if (item) {
      // Merge: whole file wins over names; the better priority wins; both groups wait for the one run.
      item.selection = mergeSelections(item.selection, input.selection);
      if (input.priority <= item.priority) { item.priority = input.priority; item.reason = input.reason; }
      item.updateSnapshot = mergeSnapshotModes(item.updateSnapshot, input.updateSnapshot);
    } else {
      item = {
        key, projectId: input.projectId, selection: input.selection, priority: input.priority, reason: input.reason,
        updateSnapshot: input.updateSnapshot, seq: ++seq, groups: new Set(),
      };
      this.queue.set(key, item);
    }
    item.groups.add(input.group);
    input.group.pending.add(item);
    this.store.markQueued(item.selection.path, item.projectId);
    // A newer request for a file that is currently running supersedes the run (unless the running one is explicit).
    // The superseded run's tests and waiting groups move to the new item so nothing it covered is lost.
    const running = this.activeByFile.get(key);
    if (running && running.item.priority > 0 && !running.cancelled) {
      item.selection = mergeSelections(running.item.selection, item.selection);
      item.updateSnapshot = mergeSnapshotModes(running.item.updateSnapshot, item.updateSnapshot);
      for (const g of running.item.groups) { g.pending.delete(running.item); g.pending.add(item); item.groups.add(g); }
      running.item.groups.clear();
      this.cancelRun(running, 'superseded by a newer edit');
    }
  }

  private pump(): void {
    if (this.paused || !this.started) return;
    const items = [...this.queue.values()].sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    const budget = Math.max(1, this.pool.capacity() * 2) - this.active.size;
    let startedNow = 0;
    for (const item of items) {
      if (startedNow >= budget) break;
      if (this.activeByFile.has(item.key) || this.debuggingFiles.has(item.selection.path)) continue;
      // Snapshot writes share a physical file even when the results belong to different configs.
      if ([...this.active.values()].some(run => run.item.selection.path === item.selection.path
        && (run.item.updateSnapshot !== 'none' || item.updateSnapshot !== 'none'))) continue;
      this.queue.delete(item.key);
      startedNow++;
      void this.runOne(item);
    }
    this.emitState();
  }

  private async runOne(item: QueuedFile): Promise<void> {
    const runId = `${[...item.groups][0]?.id ?? 'g0'}:${++seq}`;
    const run: ActiveRun = { runId, item, cancelled: false, finish: () => undefined };
    const finished = new Promise<{ interrupted: boolean; error?: string }>(resolve => {
      run.finish = (interrupted, error) => {
        if (run.watchdog) { clearTimeout(run.watchdog); run.watchdog = undefined; }
        resolve({ interrupted, error });
      };
    });
    run.completed = finished;
    this.active.set(runId, run);
    this.activeByFile.set(item.key, run);
    this.store.registerRun(runId, [item.selection]);
    this.docs.markRunBaseline(item.selection.path, item.projectId);
    this.emitState();

    const entry = this.registry.get(item.projectId);
    if (!entry || entry.spec.selected === false || entry.spec.status !== 'ok') { run.finish(false, 'project unavailable'); }
    else {
      const useCli = this.settings().engine === 'cli' || (this.settings().engine === 'auto' && this.cliFallback.has(item.projectId));
      if (useCli) this.startCliRun(run, entry.spec);
      // Not awaited: a run cancelled while waiting for a worker must settle now, not when one frees up
      // (startWarmRun releases a late worker itself).
      else void this.startWarmRun(run, entry.spec);
    }

    const { interrupted, error } = await finished;
    const rec = this.store.fileRecord(item.selection.path, item.projectId);
    const tests = this.store.testsInFile(item.selection.path, item.projectId);
    const counts = { passed: tests.filter(t => t.status === 'passed').length, failed: tests.filter(t => t.status === 'failed' || t.status === 'errored').length, pending: tests.filter(t => t.status === 'pending' || t.status === 'skipped' || t.status === 'todo').length };
    this.log.info(`run ${path.basename(item.selection.path)} (${item.reason}${item.selection.names ? `, ${item.selection.names.length} test(s)` : ''}): ${interrupted ? 'interrupted' : error ? `error: ${error}` : rec?.status ?? 'done'} ✓${counts.passed} ✗${counts.failed} ○${counts.pending}${run.cli ? ' [cli]' : ''}`);
    this.active.delete(runId);
    if (this.activeByFile.get(item.key) === run) this.activeByFile.delete(item.key);
    if (run.worker) this.pool.release(run.worker, run.memory);
    if (interrupted || error) this.store.abortRun(runId);
    // Ended before the file was marked running (cancelled while waiting for a worker, init error...).
    this.releaseQueuedStatus(item);
    if (error) { this.lastError = error; this.log.warn(`run ${runId} (${path.basename(item.selection.path)}): ${error}`); }
    for (const g of [...item.groups]) {
      if (interrupted) g.interrupted = true;
      if (error) g.error = error;
      g.pending.delete(item);
      this.settleGroup(g, false);
    }
    this.pump();
  }

  private async startWarmRun(run: ActiveRun, spec: import('./core/protocol').ProjectSpec): Promise<void> {
    try {
      run.acquireAbort = new AbortController();
      const worker = await this.pool.acquire(spec.id, { priority: run.item.priority, affinityKey: run.item.selection.path, signal: run.acquireAbort.signal });
      run.acquireAbort = undefined;
      if (run.cancelled) { this.pool.release(worker); run.finish(true); return; }
      run.worker = worker;
      this.registry.noteReady(spec.id, worker.info.ready!);
      this.store.markRunning(run.item.selection.path, { runId: run.runId, names: run.item.selection.names, projectId: spec.id });
      const msg: RunMsg = {
        v: PROTOCOL_VERSION, type: 'run', runId: run.runId, tests: [{ path: run.item.selection.path, ...(run.item.selection.names ? { names: run.item.selection.names } : {}) }],
        updateSnapshot: run.item.updateSnapshot, priority: run.item.priority, reason: run.item.reason,
      };
      if (!worker.send(msg)) { run.finish(false, 'worker channel closed'); return; }
      this.armWatchdog(run, worker);
      // After the run message, so a graph (re)build does not delay this run's results.
      this.requestGraph(spec.id, worker);
    } catch (e) {
      if (run.cancelled) { run.finish(true); return; }
      if (e instanceof WorkerInitError) {
        if (this.settings().engine === 'auto') {
          this.cliFallback.set(spec.id, e.message);
          this.log.warn(`${spec.displayName}: warm engine unavailable (${e.message}); falling back to the CLI engine`);
          this.startCliRun(run, spec);
          return;
        }
        run.finish(false, e.message);
      } else {
        run.finish(false, (e as Error).message);
      }
    }
  }

  private startCliRun(run: ActiveRun, spec: import('./core/protocol').ProjectSpec): void {
    const s = this.settings();
    this.store.markRunning(run.item.selection.path, { runId: run.runId, names: run.item.selection.names, projectId: spec.id });
    try {
      run.cli = runCli({
        spec, tests: [{ path: run.item.selection.path, ...(run.item.selection.names ? { names: run.item.selection.names } : {}) }], runId: run.runId, updateSnapshot: run.item.updateSnapshot,
        overlay: this.overlay.entriesFor(spec.id), coverage: s.coverage.enabled, workerAssetsDir: this.workerAssetsDir,
        extraEnv: s.env, timeoutMs: s.runTimeoutMs, keepArtifacts: s.keepRunArtifacts, log: this.log,
        onMessage: msg => this.onRunMessage(msg, spec.id, run),
      });
    } catch (e) {
      // e.g. the overlay manifest / artifacts dir cannot be written: fail this run instead of pinning the file.
      run.finish(false, `could not start the Jest CLI: ${(e as Error).message}`);
      return;
    }
    void run.cli.done.then(r => run.finish(r.wasInterrupted, r.error), (e: unknown) => run.finish(false, (e as Error)?.message ?? String(e)));
  }

  /**
   * A warm run that never reports `runComplete` (synchronous infinite loop in a test, worker bug)
   * would pin the file and the worker forever: after `runTimeoutMs` the worker is killed and the
   * run ends as interrupted.
   */
  private armWatchdog(run: ActiveRun, worker: WorkerHandle): void {
    const ms = this.settings().runTimeoutMs;
    if (!(ms > 0)) return;
    run.watchdog = setTimeout(() => {
      run.watchdog = undefined;
      if (!this.active.has(run.runId)) return;
      const error = `run timed out after ${ms} ms (hyperjest.runTimeoutMs); worker killed`;
      this.log.warn(`run ${run.runId} (${path.basename(run.item.selection.path)}): ${error}`);
      worker.kill('run timeout');
      run.finish(true, error);
    }, ms);
    run.watchdog.unref?.();
  }

  private cancelRun(run: ActiveRun, reason: string): void {
    if (run.cancelled) return;
    run.cancelled = true;
    this.log.debug(`cancel ${run.runId}: ${reason}`);
    if (run.cli) run.cli.cancel();
    else if (run.worker) {
      run.worker.send({ v: PROTOCOL_VERSION, type: 'cancel', runId: run.runId });
      const w = run.worker;
      const grace = Math.max(2000, 5000);
      setTimeout(() => { if (this.active.has(run.runId)) { w.kill('cancel not acknowledged'); run.finish(true); } }, grace).unref?.();
    } else {
      // Still waiting for a worker: withdraw the request so the pool does not hand one to a dead run.
      run.acquireAbort?.abort();
      run.finish(true);
    }
  }

  private cancelFile(p: string, reason: string): void {
    for (const run of this.active.values()) if (run.item.selection.path === p) this.cancelRun(run, reason);
    for (const q of [...this.queue.values()]) if (q.selection.path === p) this.dropQueued(q, false);
  }

  /** Removes a queued item: every group waiting for it settles, and the file stops showing as queued. */
  private dropQueued(item: QueuedFile, interrupted: boolean): void {
    if (this.queue.get(item.key) === item) this.queue.delete(item.key);
    for (const g of [...item.groups]) this.detachGroup(item, g, interrupted);
    this.releaseQueuedStatus(item);
  }

  /** One group stops waiting for an item (the item itself may still run for other groups). */
  private detachGroup(item: QueuedFile, group: RunGroup, interrupted: boolean): void {
    item.groups.delete(group);
    group.pending.delete(item);
    this.settleGroup(group, interrupted);
  }

  /**
   * Keeps the store's `queued` status in line with the queue once an item left it without running
   * to completion. A file still queued (e.g. the request that superseded an aborted run) is marked
   * queued again; a file that will not run now gets its pre-queue status back, otherwise the store's
   * summary keeps counting it and the live TestRun never ends.
   */
  private releaseQueuedStatus(item: QueuedFile): void {
    if (this.activeByFile.has(item.key)) return;
    const queued = this.queue.get(item.key);
    if (queued) { this.store.markQueued(queued.selection.path, queued.projectId); return; }
    this.store.unmarkQueued(item.selection.path, item.projectId);
  }

  private settleGroup(group: RunGroup, interrupted: boolean): void {
    if (interrupted) group.interrupted = true;
    if (group.pending.size === 0) group.resolve({ wasInterrupted: group.interrupted, error: group.error });
  }

  // ------------------------------------------------------------------ messages

  private onPoolEvent(e: import('./workerPool').PoolEvent): void {
    switch (e.type) {
      case 'message': this.onWorkerMessage(e.worker, e.msg); break;
      case 'ready': this.registry.noteReady(e.worker.projectId, e.msg); this.requestGraph(e.worker.projectId, e.worker); break;
      case 'exit': {
        for (const run of [...this.active.values()]) {
          if (run.worker === e.worker) run.finish(run.cancelled, run.cancelled ? undefined : `worker exited (${e.reason})`);
        }
        // The graph lives in that worker (and may never have arrived): the next worker builds a fresh one.
        if (this.graphRequested.get(e.worker.projectId) === e.worker) this.graphRequested.delete(e.worker.projectId);
        break;
      }
      default: break;
    }
  }

  private onWorkerMessage(worker: WorkerHandle, msg: WorkerToHost): void {
    if (this.onSideMessage(msg, `worker ${worker.info.id}`)) return;
    if (msg.type === 'graphResult') { this.storeGraph(worker.projectId, msg.forward, msg.testFiles); return; }
    if (msg.type === 'coverageMeta') { const spec = this.registry.get(worker.projectId)?.spec; const scoped = spec && spec.selected !== false ? scopedMessage(msg, spec.scope) : undefined; if (scoped) this.store.apply(scoped, worker.projectId); return; }
    if ('runId' in msg) {
      const run = this.active.get(msg.runId);
      if (!run) return; // stale generation
      this.onRunMessage(msg, worker.projectId, run);
    }
  }

  /** Messages that are not results (worker logs, blocked snapshot writes), from a worker or a CLI run. */
  private onSideMessage(msg: WorkerToHost, source: string): boolean {
    if (msg.type === 'log') { this.log[msg.level](`[${source}] ${msg.text}`); return true; }
    if (msg.type === 'overlayWriteBlocked') {
      // The save this message asks for must re-run the file: it is not "already handled by on-type".
      for (const key of this.onTypeRuns.keys()) if (key.endsWith(`\0${msg.path}`)) this.onTypeRuns.delete(key);
      void vscode.window.showWarningMessage(`HyperJest: save ${path.basename(msg.path)} to write inline snapshots (writes to unsaved files are blocked).`);
      return true;
    }
    return false;
  }

  private onRunMessage(msg: WorkerToHost, projectId: string, run: ActiveRun): void {
    if (run.cancelled && msg.type !== 'runComplete') return;
    if (run.cli && this.onSideMessage(msg, `cli ${run.runId}`)) return;
    if (msg.type === 'runComplete') {
      run.memory = msg.memory;
      const interrupted = msg.wasInterrupted || run.cancelled;
      // The store closes pending files (discard on interrupt, force-commit otherwise) so no spinner sticks.
      if (run.cancelled) this.store.abortRun(run.runId);
      else this.store.apply({ ...msg, wasInterrupted: interrupted }, projectId);
      run.finish(interrupted, msg.error);
      return;
    }
    const scoped = scopedMessage(msg, this.registry.get(projectId)?.spec.scope);
    if (scoped) this.store.apply(scoped, projectId);
  }

  private requestGraph(projectId: string, worker: WorkerHandle): void {
    if (!this.settings().affected.useStaticGraph || this.graphRequested.has(projectId)) return;
    this.graphRequested.set(projectId, worker);
    worker.send({ v: PROTOCOL_VERSION, type: 'graph' });
  }

  /**
   * Files created, deleted or renamed from VS Code: workers rebuild their haste maps (resolvers and
   * the static graph would not know the files otherwise) and the graph is asked for again.
   */
  private onFilesChanged(uris: readonly vscode.Uri[]): void {
    const byProject = new Map<string, string[]>();
    for (const uri of uris) {
      if (uri.scheme !== 'file' || uri.fsPath.includes(`${path.sep}node_modules${path.sep}`)) continue;
      for (const entry of this.registry.projectsFor(uri.fsPath)) {
        const projectId = entry.spec.id;
        const list = byProject.get(projectId) ?? [];
        list.push(uri.fsPath); byProject.set(projectId, list);
      }
    }
    for (const [projectId, paths] of byProject) {
      this.pool.broadcast(projectId, { v: PROTOCOL_VERSION, type: 'invalidate', reason: 'files', paths });
      this.graphRequested.delete(projectId);
    }
  }

  private storeGraph(projectId: string, forward: Record<string, string[]>, testFiles: readonly string[] = []): void {
    const inverse = new Map<string, Set<string>>();
    for (const [file, deps] of Object.entries(forward)) {
      for (const d of deps) {
        const set = inverse.get(d) ?? new Set<string>();
        set.add(file);
        inverse.set(d, set);
      }
    }
    this.inverseGraph.set(projectId, inverse);
    this.graphTestFiles.set(projectId, new Set(testFiles.filter(f => this.registry.acceptsTest(projectId, f))));
    this.log.debug(`graph for ${projectId}: ${Object.keys(forward).length} files, ${testFiles.length} test files`);
  }

  private onRegistryEvent(e: import('./discovery/projectRegistry').RegistryEvent): void {
    if (e.type === 'invalidated') {
      this.knownSpecs.set(e.projectId, 'invalidated');
      for (const item of [...this.queue.values()]) if (item.projectId === e.projectId) this.dropQueued(item, true);
      this.graphRequested.delete(e.projectId);
      this.inverseGraph.delete(e.projectId);
      this.graphTestFiles.delete(e.projectId);
      this.cliFallback.delete(e.projectId);
      for (const run of [...this.active.values()]) if (run.item.projectId === e.projectId) this.cancelRun(run, 'project invalidated');
      const files = this.store.allFiles().filter(f => f.projectId === e.projectId);
      for (const f of files) this.store.markStale(f.path);
      // The registry refreshes the config first; `refreshed` schedules replacement runs.
    } else if (e.type === 'ready') {
      // Real matchers replace Jest's defaults: open files may only now be recognised as tests.
      if (this.started) for (const doc of vscode.workspace.textDocuments) if (this.registry.acceptsTest(e.projectId, doc.uri.fsPath)) this.onDocumentOpened(doc);
    } else if (e.type === 'refreshed') {
      const current = new Map(e.result.specs.filter(s => s.selected !== false && s.status === 'ok').map(s => [s.id, JSON.stringify(s)]));
      const changed = new Set([...this.knownSpecs.keys()].filter(id => current.get(id) !== this.knownSpecs.get(id)));
      for (const id of changed) {
        for (const run of this.active.values()) if (run.item.projectId === id) this.cancelRun(run, 'configuration selection changed');
        for (const item of [...this.queue.values()]) if (item.projectId === id) this.dropQueued(item, true);
        for (const [key, selection] of this.deferred) if (selection.projectId === id) this.deferred.delete(key);
        if (!current.has(id)) for (const byProject of this.continuous.values()) byProject.delete(id);
        this.docs.clearProject(id);
        this.store.clearProject(id); this.inverseGraph.delete(id); this.graphTestFiles.delete(id); this.graphRequested.delete(id); this.cliFallback.delete(id);
      }
      const added = [...current.keys()].filter(id => current.get(id) !== this.knownSpecs.get(id));
      this.knownSpecs = current;
      this.onTypeRuns.clear();
      this.overlay.refresh();
      for (const spec of e.result.specs) if (spec.selected !== false) this.store.setProjectLabel(spec.id, spec.displayName);
      if (this.started && !this.initializing && this.settings().runMode !== 'manual') {
        if (this.settings().smartStart === 'always') for (const id of added) void this.runProject(id).catch(error => this.log.warn(String(error)));
        else {
          for (const doc of vscode.workspace.textDocuments) this.onDocumentOpened(doc);
          for (const id of added) { const watched = this.continuousSelections(id); if (watched.length) void this.runFiles(watched, 'continuous'); }
        }
      }
      this.emitState();
    }
  }

  // ------------------------------------------------------------------ live behaviour

  private isInteresting(doc: vscode.TextDocument): boolean {
    if (doc.uri.scheme !== 'file') return false;
    const p = doc.uri.fsPath;
    return /\.(?:[cm]?[jt]sx?|json|snap)$/.test(p) && !p.includes(`${path.sep}node_modules${path.sep}`) && !!this.registry.projectIdFor(p);
  }

  private sendOverlay(projectId: string, changes: OverlayChange[]): void {
    this.pool.broadcast(projectId, { v: PROTOCOL_VERSION, type: 'overlay', changes });
  }

  private onDocumentOpened(doc: vscode.TextDocument): void {
    if (!this.started || doc.uri.scheme !== 'file') return;
    const p = doc.uri.fsPath;
    this.learnMatchers(p);
    if (!this.registry.isTestFile(p)) return;
    this.docs.update(p, doc.getText());
    const s = this.settings();
    if (this.initializing || s.smartStart === 'never' || s.runMode === 'manual') return;
    const targets = this.registry.projectsFor(p).filter(e => !this.store.fileRecord(p, e.spec.id) && !this.activeByFile.has(`${e.spec.id}\0${p}`));
    if (targets.length) void this.runFiles(targets.map(e => ({ path: p, projectId: e.spec.id })), 'open');
  }

  /** Boots cold projects of the open documents again (after Clear Caches reset their matchers). */
  relearnOpenDocuments(): void {
    if (!this.started) return;
    for (const doc of vscode.workspace.textDocuments) if (doc.uri.scheme === 'file') this.learnMatchers(doc.uri.fsPath);
  }

  /**
   * A project whose configs are still Jest's defaults (no worker yet, nothing cached) may use another
   * testMatch/testRegex/roots: boot its worker so the file is classified with the real matchers
   * (the registry's `ready` event re-evaluates the open editors).
   */
  private learnMatchers(p: string): void {
    if (!/\.(?:[cm]?[jt]sx?)$/.test(p) || p.includes(`${path.sep}node_modules${path.sep}`)) return;
    for (const entry of this.registry.projectsFor(p)) {
      if (entry.configsSource !== 'static' || entry.readiness?.kind !== 'cold') continue;
      void this.registry.resolveMatchers(entry.spec.id).then(() => {
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === p && d.uri.scheme === 'file');
        if (doc && entry.configsSource !== 'static') this.onDocumentOpened(doc);
      }).catch(() => undefined);
    }
  }

  private onDocumentChanged(doc: vscode.TextDocument, hasChanges: boolean): void {
    if (!hasChanges || !this.started || !this.isInteresting(doc)) return;
    const p = doc.uri.fsPath;
    const s = this.settings();
    if (this.registry.isTestFile(p)) this.docs.update(p, doc.getText());
    this.store.markStale(p);
    if (s.runMode !== 'onType') return;
    const existing = this.changeTimers.get(p);
    if (existing) clearTimeout(existing);
    this.changeTimers.set(p, setTimeout(() => { this.changeTimers.delete(p); void this.runAffected(p, doc.getText(), 'onType'); }, s.onTypeDebounceMs));
  }

  private onDocumentSaved(doc: vscode.TextDocument): void {
    if (!this.started || !this.isInteresting(doc)) return;
    const p = doc.uri.fsPath;
    const s = this.settings();
    if (this.registry.isTestFile(p)) this.docs.update(p, doc.getText());
    if (this.deferred.size) void this.runDeferred();
    if (s.runMode === 'manual') return;
    const existing = this.changeTimers.get(p);
    if (existing) { clearTimeout(existing); this.changeTimers.delete(p); }
    const text = doc.getText();
    // On-type already ran (or is running) the affected tests for exactly this text: saving changes nothing.
    if (!existing && this.onTypeHandled(p, text)) return;
    setTimeout(() => void this.runAffected(p, text, 'onSave'), s.onSaveDebounceMs);
  }

  private onTypeHandled(p: string, text: string): boolean {
    const entries = this.registry.projectsFor(p);
    return entries.length > 0 && entries.every(e => {
      const last = this.onTypeRuns.get(`${e.spec.id}\0${p}`);
      return !!last && last.text === text && (!last.done || !last.outcome || (!last.outcome.wasInterrupted && !last.outcome.error));
    });
  }

  /** Computes and dispatches the tests affected by an edit of `p`. */
  async runAffected(p: string, text: string, reason: 'onType' | 'onSave'): Promise<AffectedResult | undefined> {
    const results = await Promise.all(this.registry.projectsFor(p).map(e => this.runAffectedProject(p, text, reason, e.spec.id)));
    return results.find(r => r?.kind === 'runs') ?? results.find(Boolean);
  }

  private async runAffectedProject(p: string, text: string, reason: 'onType' | 'onSave', projectId: string): Promise<AffectedResult | undefined> {
    const store = this.store.forProject(projectId);
    const entry = projectId ? this.registry.get(projectId) : undefined;
    if (!entry || entry.spec.status !== 'ok') return undefined;
    const s = this.settings();
    const isTest = this.registry.acceptsTest(projectId, p);
    if (!isTest && !this.registry.monitorsSource(projectId, p) && !this.registry.toolchainFiles(projectId).has(p)) return undefined;
    let analysis: ChangeAnalysis | undefined;
    let changedLines: ReturnType<typeof diffLines> | null = null;
    if (isTest) {
      const newParsed = this.docs.update(p, text);
      const base = this.docs.baseline(p, projectId);
      if (base) {
        changedLines = diffLines(base.text, text);
        analysis = analyzeChange(base.parsed, newParsed, changedLines);
      }
    }
    const testFiles = new Set(store.allFiles().filter(f => f.projectId === projectId).map(f => f.path));
    // Specs never run yet (smartStart 'open' runs only opened files) are known from the static graph.
    for (const f of this.graphTestFiles.get(projectId!) ?? []) testFiles.add(f);
    if (isTest) testFiles.add(p);
    const failingTestsByFile = new Map<string, Set<string>>();
    for (const t of store.failingTests()) {
      const set = failingTestsByFile.get(t.path) ?? new Set<string>();
      set.add(t.testKey);
      failingTestsByFile.set(t.path, set);
    }
    const cov = store.coverageFor(p);
    const sourceSelection = isTest ? undefined : store.sourceSelection(p, text);
    const result = selectAffected({
      changedFile: p,
      changedLines,
      isTestFile: isTest,
      analysis,
      sourceSelection,
      execBy: store.execBy(),
      loadedBy: store.loadedBy(),
      inverseStaticGraph: this.inverseGraph.get(projectId!) ?? null,
      testFiles,
      runtimeTrackedTestFiles: sourceSelection?.trackedFiles ?? new Set(store.allFiles().filter(f => f.projectId === projectId && store.coveredSourcesOf(f.path).size > 0).map(f => f.path)),
      failingTestsByFile,
      coverage: cov?.meta ? { meta: cov.meta, stmtHitBy: cov.stmtHitBy } : null,
      toolchainFiles: this.registry.toolchainFiles(projectId!),
      settings: { maxTestFilesPerEdit: s.liveRun.maxTestFilesPerEdit, alwaysRunFailing: s.affected.alwaysRunFailing, useStaticGraph: s.affected.useStaticGraph, trackFileLoading: s.affected.trackFileLoading },
    });
    this.log.info(`affected(${path.basename(p)}, ${reason}): ${result.kind}${result.kind === 'runs' ? ` ${result.runs.length} file(s)${result.deferred.length ? `, ${result.deferred.length} deferred` : ''}` : ''}${'reason' in result ? ` (${result.reason})` : ''}`);
    const runReason = reason === 'onType' ? 'onType' : 'onSave';
    // Continuous runs re-run on every edit of their project, whatever the edit affects.
    const watched = result.kind === 'invalidateConfig' ? [] : this.continuousSelections(projectId!);
    let handle: Promise<RunHandle> | undefined;
    switch (result.kind) {
      case 'runs': {
        // runFiles merges duplicate paths (a whole-file watch absorbs a narrowed affected run).
        const runs = [...result.runs, ...watched];
        if (runs.length) handle = this.runFiles(runs.map(r => ({ ...r, projectId })), runReason);
        for (const d of result.deferred) this.deferred.set(`${projectId}\0${d.path}`, { ...d, projectId });
        if (result.truncated) this.log.info(`affected: ${result.deferred.length} test file(s) deferred (liveRun.maxTestFilesPerEdit)`);
        break;
      }
      case 'discover': {
        if (watched.length) void this.runFiles(watched, 'continuous');
        if (!s.affected.discoverWithJest) break;
        const files = await findRelatedTests(entry.spec, [p], `related-${Date.now().toString(36)}`, s.env, this.log);
        if (files.length) handle = this.runFiles(files.slice(0, s.liveRun.maxTestFilesPerEdit).map(f => ({ path: f, projectId })), runReason);
        else this.log.info(`no tests cover ${path.basename(p)} (jest --findRelatedTests)`);
        break;
      }
      case 'invalidateConfig':
        // Through the registry, like a watched toolchain file: runs are cancelled before the workers
        // recycle, readiness/configs/graph reset, and visible specs re-run on the new config.
        this.registry.invalidate(projectId!, [p]);
        break;
      case 'none':
        if (watched.length) void this.runFiles(watched, 'continuous');
        this.log.info(`no tests cover ${path.basename(p)}`);
        break;
    }
    if (reason === 'onType' && result.kind !== 'invalidateConfig') this.recordOnTypeRun(`${projectId}\0${p}`, text, handle);
    else this.onTypeRuns.delete(`${projectId}\0${p}`);
    this.emitState();
    return result;
  }

  private recordOnTypeRun(p: string, text: string, handle: Promise<RunHandle> | undefined): void {
    const entry: { text: string; outcome?: RunOutcome; done: Promise<RunOutcome> | undefined } = { text, done: undefined };
    this.onTypeRuns.set(p, entry);
    if (!handle) return;
    const done = handle.then(h => h.done);
    entry.done = done;
    void done.then(o => { entry.outcome = o; });
  }

  private defaultSnapshotMode(): UpdateSnapshotMode {
    return this.settings().snapshots.updateMode === 'none' ? 'none' : 'new';
  }

  private emitState(): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => { this.stateTimer = undefined; this.stateEmitter.fire(this.getState()); }, 16);
  }
}

function mergeSnapshotModes(a: UpdateSnapshotMode, b: UpdateSnapshotMode): UpdateSnapshotMode {
  return a === 'all' || b === 'all' ? 'all' : b;
}

function mergeSelections(a: RunTestSelection, b: RunTestSelection): RunTestSelection {
  if (!a.names || !b.names) return { path: a.path };
  return { path: a.path, names: [...new Set([...a.names, ...b.names])].sort() };
}
