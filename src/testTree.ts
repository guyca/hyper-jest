/**
 * Test Explorer integration (plan: Test Explorer row).
 *
 *  - `TestExplorer` owns `tests.createTestController('hyperjest', 'HyperJest')` and the tree
 *    project -> file -> describe -> test. Projects and files are created by the integrator
 *    (`buildProjectItem`, `setProjectFiles`); children are built from the parser output
 *    (`setFileParsed`). `resolveHandler` asks the integrator's `resolveChildren` callback lazily.
 *  - Runtime results are reconciled with parsed nodes through core/testIds `reconcile()`: exact /
 *    k-th duplicate / location-hint matches land on the static item, `.each`/loop rows become
 *    children of their static node (`rowLabel`), runtime-only tests (helper-registered, dynamic)
 *    become items under the deepest matched describe with intermediate runtime describes, and
 *    static tests without a result after an unfiltered run read "not registered"
 *    (`unreportedNodes`).
 *  - Profiles: Run (default, continuous), Debug, Run with Coverage (detailed + per-test coverage
 *    from the store), Update Snapshots. Handlers call the injected `RunnerApi`.
 *  - `LiveRunPublisher` mirrors store changes into TestRuns: an explicit run while one is active
 *    for the file, otherwise a non-persisted "HyperJest live" run that ends when the store is idle.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import type { Logger } from './core/logger';
import type { FailureInfo, ProjectSpec, RunTestSelection } from './core/protocol';
import { parseTestKey } from './core/protocol';
import type { FileRecord, TestRecord } from './core/resultModel';
import type { HyperJestSettings } from './core/settingsModel';
import { parsedNodeId, type ParsedFile, type ParsedNode } from './core/testModel';
import {
  fileIdOf, fullNameOfNode, hasStaticFullName, nodeIdOf, reconcile, unreportedNodes, walkNodes,
  type ReconcileIds, type ReconciledTest,
} from './core/testIds';
import type { RunnerApi } from './runnerApi';
import type { ResultStore } from './results/resultStore';
import { orderForReconcile, type MatchResult } from './results/lineView';

/**
 * Optional reconciliation override (node-keyed `MatchResult`, see results/lineView). The default
 * is core/testIds `reconcile()`; a custom function built on `matchRecordsToNodes` carries the
 * `reconciled` entries, any other result is adapted (one row per extra record, runtime-only items
 * under the file).
 */
export type ReconcileFn = (parsed: ParsedFile, results: readonly TestRecord[]) => MatchResult;

export type ResolveTarget =
  | { kind: 'root' }
  | { kind: 'project'; projectId: string }
  | { kind: 'file'; projectId: string; path: string };

export interface TestExplorerDeps {
  store: ResultStore;
  runner: RunnerApi;
  settings: () => HyperJestSettings;
  log: Logger;
  /** Lazy loader: root -> projects, project -> file list, file -> parse + `setFileParsed`. */
  resolveChildren?: (target: ResolveTarget) => Promise<void> | void;
  reconcile?: ReconcileFn;
  /** Idle time (ms) after which the live run ends (default 500). Injectable for tests. */
  liveIdleMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface FileEntry {
  projectId: string;
  path: string;
  relPath: string;
  item: vscode.TestItem;
  parsed?: ParsedFile;
  nodeItems: Map<ParsedNode, vscode.TestItem>;
  /** testKey -> item (parsed node, `.each` row or runtime-only child). */
  keyItems: Map<string, vscode.TestItem>;
  /** fullName -> items (for `started` before a testKey is known). */
  nameItems: Map<string, vscode.TestItem[]>;
  /** Items created from runtime results (rows, runtime-only tests, their intermediate describes), by id. */
  runtimeItems: Map<string, vscode.TestItem>;
  notMatched: boolean;
  invalidated: boolean;
}

interface ItemInfo { entry: FileEntry; node?: ParsedNode; testKey?: string; }

type ProfileMode = 'run' | 'debug' | 'coverage' | 'snapshots';

const NOT_REGISTERED = 'not registered';
const RUNTIME_ONLY = 'runtime only';

/**
 * VS Code forbids the NUL character in TestItem ids (it is its own internal separator), while HyperJest's
 * node/test ids use `\0` as separator (core/testIds). Map it to the ASCII unit separator for item ids only;
 * all internal maps key by the created item's id, so the mapping stays consistent.
 */
function itemId(id: string): string {
  return id.replace(/\0/g, '\u001f');
}

/**
 * Records a parse in the store, except that an unrecoverable parse error (no nodes) never replaces a
 * previous parse: declaration icons, snapshot cameras, gutter menus and lenses keep the last good tree
 * while the user is mid-edit (core/testParser returns `nodes: []` for exactly this purpose).
 */
export function recordParsed(store: Pick<ResultStore, 'parsed' | 'setParsed'>, filePath: string, parsed: ParsedFile): void {
  if (parsed.parseError && !parsed.nodes.length && store.parsed(filePath)) return;
  store.setParsed(filePath, parsed);
}

export class TestExplorer implements vscode.Disposable {
  readonly controller: vscode.TestController;
  readonly live: LiveRunPublisher;
  readonly profiles: { run: vscode.TestRunProfile; debug: vscode.TestRunProfile; coverage: vscode.TestRunProfile; snapshots: vscode.TestRunProfile };

  private readonly projects = new Map<string, { spec: ProjectSpec; item: vscode.TestItem; filesListed?: boolean }>();
  private readonly files = new Map<string, FileEntry>();
  private readonly itemIndex = new Map<string, ItemInfo>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly deps: TestExplorerDeps) {
    this.controller = vscode.tests.createTestController('hyperjest', 'HyperJest');
    this.controller.resolveHandler = item => this.resolve(item);
    this.controller.refreshHandler = () => deps.resolveChildren?.({ kind: 'root' });
    const c = this.controller;
    const run = c.createRunProfile('Run', vscode.TestRunProfileKind.Run, (req, token) => this.handleRun(req, token, 'run'), true, undefined, true);
    const debug = c.createRunProfile('Debug', vscode.TestRunProfileKind.Debug, (req, token) => this.handleRun(req, token, 'debug'), false);
    const coverage = c.createRunProfile('Run with Coverage', vscode.TestRunProfileKind.Coverage, (req, token) => this.handleRun(req, token, 'coverage'), false);
    coverage.loadDetailedCoverage = (_run, fileCoverage) => Promise.resolve(this.loadDetailedCoverage(fileCoverage, undefined));
    coverage.loadDetailedCoverageForTest = (_run, fileCoverage, item) => Promise.resolve(this.loadDetailedCoverage(fileCoverage, item));
    const snapshots = c.createRunProfile('Update Snapshots', vscode.TestRunProfileKind.Run, (req, token) => this.handleRun(req, token, 'snapshots'), false);
    this.profiles = { run, debug, coverage, snapshots };
    this.live = new LiveRunPublisher(this.controller, deps.store, this, { idleMs: deps.liveIdleMs, setTimer: deps.setTimer, clearTimer: deps.clearTimer, log: deps.log });
    this.disposables.push(deps.store.onDidChange(paths => this.onStoreChange(paths)));
  }

  // ------------------------------------------------------------------------------------------
  // Tree building (called by the integrator)
  // ------------------------------------------------------------------------------------------

  /** Creates or updates the project item: label = displayName, description = flavor/jest/node. */
  buildProjectItem(spec: ProjectSpec): vscode.TestItem {
    let p = this.projects.get(spec.id);
    if (!p) {
      const item = this.controller.createTestItem(itemId(spec.id), spec.displayName, vscode.Uri.file(spec.packageDir));
      p = { spec, item };
      this.projects.set(spec.id, p);
      this.controller.items.add(item);
    }
    p.spec = spec;
    p.item.label = spec.displayName;
    p.item.description = [spec.flavor, spec.jestVersion ? `jest ${spec.jestVersion}` : 'jest ?', spec.nodeVersion ? `node ${spec.nodeVersion}` : undefined].filter(Boolean).join(' · ');
    p.item.canResolveChildren = spec.status === 'ok';
    p.item.error = spec.status === 'ok' ? undefined : `${spec.status}${spec.reason ? `: ${spec.reason}` : ''}`;
    return p.item;
  }

  removeProject(projectId: string): void {
    const p = this.projects.get(projectId);
    if (!p) return;
    for (const [filePath, entry] of [...this.files]) if (entry.projectId === projectId) this.removeFile(filePath);
    this.controller.items.delete(p.item.id);
    this.projects.delete(projectId);
  }

  /** Replaces a project's file items; entries for unchanged paths keep their children. */
  setProjectFiles(projectId: string, paths: readonly string[]): void {
    const project = this.projects.get(projectId);
    if (!project) { this.deps.log.warn(`testTree: setProjectFiles for unknown project ${projectId}`); return; }
    project.filesListed = true;
    const keep = new Set(paths);
    for (const [filePath, entry] of [...this.files]) if (entry.projectId === projectId && !keep.has(filePath)) this.removeFile(filePath);
    const items: vscode.TestItem[] = [];
    for (const filePath of paths) items.push(this.ensureFile(projectId, filePath).item);
    project.item.children.replace(items.sort((a, b) => a.label.localeCompare(b.label)));
  }

  addFile(projectId: string, filePath: string): vscode.TestItem {
    const entry = this.ensureFile(projectId, filePath);
    this.projects.get(projectId)?.item.children.add(entry.item);
    return entry.item;
  }

  removeFile(filePath: string): void {
    const entry = this.files.get(filePath);
    if (!entry) return;
    this.projects.get(entry.projectId)?.item.children.delete(entry.item.id);
    this.forgetItems(entry);
    this.files.delete(filePath);
  }

  /**
   * Builds describe/test children from the parser output and records it in the store. A parse
   * error keeps the previous children and sets `item.error`.
   */
  setFileParsed(projectId: string, filePath: string, parsed: ParsedFile): void {
    const entry = this.ensureFile(projectId, filePath);
    recordParsed(this.deps.store, filePath, parsed);
    if (parsed.parseError) {
      entry.item.error = `Parse error at ${parsed.parseError.line}:${parsed.parseError.column}: ${parsed.parseError.message}`;
      if (!entry.parsed) entry.parsed = parsed;
      return;
    }
    entry.item.error = undefined;
    entry.parsed = parsed;
    this.forgetItems(entry);
    entry.nodeItems = new Map();
    entry.runtimeItems = new Map();
    const children = this.buildNodeItems(entry, parsed.nodes, []);
    entry.item.children.replace(children);
    entry.item.canResolveChildren = false;
    this.syncRuntimeItems(entry);
  }

  /** Marks a file the project's matchers reject (Detox specs under shono, ...). */
  setFileNotMatched(filePath: string, notMatched: boolean): void {
    const entry = this.files.get(filePath);
    if (!entry) return;
    entry.notMatched = notMatched;
    entry.item.description = notMatched ? 'not matched by the project\'s testMatch' : undefined;
  }

  // ------------------------------------------------------------------------------------------
  // Lookups
  // ------------------------------------------------------------------------------------------

  fileEntry(filePath: string): FileEntry | undefined { return this.files.get(filePath); }
  itemForFile(filePath: string): vscode.TestItem | undefined { return this.files.get(filePath)?.item; }
  itemForTestKey(testKey: string): vscode.TestItem | undefined {
    return this.files.get(parseTestKey(testKey).path)?.keyItems.get(testKey);
  }
  projectSpec(projectId: string): ProjectSpec | undefined { return this.projects.get(projectId)?.spec; }
  /** Ids of every project item in the tree. */
  projectIds(): string[] { return [...this.projects.keys()]; }
  /** True once the project's file list was filled (the user expanded it); a refresh must replace that list. */
  isProjectResolved(projectId: string): boolean { return !!this.projects.get(projectId)?.filesListed; }

  /** The project an Explorer item (project, file, describe, test or runtime row) belongs to. */
  projectIdFor(item: vscode.TestItem): string | undefined {
    const info = this.itemIndex.get(item.id);
    if (info) return info.entry.projectId;
    for (const entry of this.files.values()) if (entry.item === item) return entry.projectId;
    let root = item;
    while (root.parent) root = root.parent;
    for (const [id, p] of this.projects) if (p.item === root) return id;
    return undefined;
  }

  /** Test keys an item stands for (its own record, or every record below it). */
  testKeysFor(item: vscode.TestItem): string[] {
    const info = this.itemIndex.get(item.id);
    if (info?.testKey) return [info.testKey];
    const out: string[] = [];
    if (info) {
      for (const [key, keyed] of info.entry.keyItems) if (keyed === item || isDescendant(keyed, item)) out.push(key);
    } else {
      // File or project item.
      const entry = this.files.get(item.uri?.fsPath ?? '');
      if (entry && entry.item === item) for (const key of entry.keyItems.keys()) out.push(key);
      else item.children.forEach(child => out.push(...this.testKeysFor(child)));
    }
    return [...new Set(out)];
  }

  /**
   * Turns Explorer items into run selections: project -> all its files, file -> `{path}`,
   * describe/test -> `{path, names}` (whole file when a name cannot be determined statically and
   * no runtime rows are known yet).
   */
  selectionsFor(items: readonly vscode.TestItem[], exclude?: readonly vscode.TestItem[]): RunTestSelection[] {
    const excluded = new Set((exclude ?? []).map(i => i.id));
    const whole = new Set<string>();
    const names = new Map<string, Set<string>>();
    const addNames = (filePath: string, list: string[] | undefined) => {
      if (!list) { whole.add(filePath); return; }
      let set = names.get(filePath);
      if (!set) names.set(filePath, (set = new Set()));
      for (const n of list) set.add(n);
    };
    const visit = (item: vscode.TestItem): void => {
      if (excluded.has(item.id)) return;
      const project = this.projects.get(item.id);
      if (project) {
        for (const entry of this.files.values()) if (entry.projectId === project.spec.id && !excluded.has(entry.item.id)) whole.add(entry.path);
        return;
      }
      const info = this.itemIndex.get(item.id);
      if (!info) {
        const entry = [...this.files.values()].find(e => e.item === item);
        if (entry) whole.add(entry.path);
        return;
      }
      if (info.testKey) { addNames(info.entry.path, [parseTestKey(info.testKey).fullName]); return; }
      if (info.node) { addNames(info.entry.path, this.namesForNode(info.entry, info.node, excluded)); return; }
      // A runtime-only describe: whatever runtime tests it holds.
      item.children.forEach(child => visit(child));
    };
    for (const item of items) visit(item);
    const out: RunTestSelection[] = [];
    for (const filePath of whole) out.push({ path: filePath });
    for (const [filePath, set] of names) if (!whole.has(filePath)) out.push({ path: filePath, names: [...set] });
    return out;
  }

  /**
   * Full names for a parsed node: every runtime-known test below it (`.each` rows, runtime-only
   * children) plus the static names of tests that have no result yet; undefined when a test's name
   * is not static and nothing is known about it at runtime (callers fall back to the whole file).
   */
  private namesForNode(entry: FileEntry, node: ParsedNode, excluded: Set<string>): string[] | undefined {
    if (!entry.parsed) return undefined;
    const nodeItem = entry.nodeItems.get(node);
    if (!nodeItem) return undefined;
    const isExcluded = (item: vscode.TestItem): boolean => {
      for (let p: vscode.TestItem | undefined = item; p && p !== nodeItem.parent; p = p.parent) if (excluded.has(p.id)) return true;
      return false;
    };
    const out = new Set<string>();
    const covered = new Set<vscode.TestItem>();
    for (const [key, item] of entry.keyItems) {
      if (item !== nodeItem && !isDescendant(item, nodeItem)) continue;
      if (isExcluded(item)) continue;
      out.add(parseTestKey(key).fullName);
      // The static node whose item is this or an ancestor is runtime-covered.
      for (let p: vscode.TestItem | undefined = item; p && p !== nodeItem.parent; p = p.parent) covered.add(p);
    }
    let unresolved = false;
    const ancestryOf = walkNodes(entry.parsed).find(e => e.node === node)?.ancestry ?? [];
    const visit = (n: ParsedNode, ancestry: ParsedNode[]): void => {
      const item = entry.nodeItems.get(n);
      if (item && excluded.has(item.id)) return;
      if (n.kind === 'test' && !(item && covered.has(item))) {
        if (hasStaticFullName(ancestry, n)) out.add(fullNameOfNode(ancestry, n));
        else unresolved = true;
      }
      for (const c of n.children) visit(c, [...ancestry, n]);
    };
    visit(node, ancestryOf);
    return unresolved ? undefined : [...out];
  }

  // ------------------------------------------------------------------------------------------
  // Store -> tree
  // ------------------------------------------------------------------------------------------

  private onStoreChange(paths: readonly string[]): void {
    for (const p of paths) {
      const entry = this.files.get(p);
      if (!entry) continue;
      const file = this.deps.store.fileRecord(p);
      this.syncRuntimeItems(entry);
      if (file) {
        if (file.status === 'notMatched' && !entry.notMatched) this.setFileNotMatched(p, true);
        if (file.stale && file.status !== 'running' && file.status !== 'queued') {
          if (!entry.invalidated) { entry.invalidated = true; this.controller.invalidateTestResults(entry.item); }
        } else if (!file.stale) {
          entry.invalidated = false;
        }
      }
    }
    this.live.publish(paths);
  }

  /** Reconciles the store's records with the parsed tree: `.each` rows, runtime-only items, descriptions. */
  syncRuntimeItems(entry: FileEntry): void {
    const store = this.deps.store;
    const records = orderForReconcile(store.testsInFile(entry.path));
    const ids: ReconcileIds = { projectId: entry.projectId, relPath: entry.relPath };
    const parsed = entry.parsed && !entry.parsed.parseError ? entry.parsed : undefined;
    const reconciled = parsed ? this.reconcileRecords(parsed, records, ids) : runtimeTree(records, fileIdOf(ids));
    const keyItems = new Map<string, vscode.TestItem>();
    const keep = new Set<string>();

    // Node items start without a record; direct matches below re-attach one.
    for (const [node, item] of entry.nodeItems) this.itemIndex.set(item.id, { entry, node });

    const runtimeItem = (id: string, label: string, parent: vscode.TestItem, init: (item: vscode.TestItem) => void): vscode.TestItem => {
      let item = entry.runtimeItems.get(id);
      if (!item) {
        item = this.controller.createTestItem(itemId(id), label, entry.item.uri);
        init(item);
        entry.runtimeItems.set(id, item);
        parent.children.add(item);
      } else if (item.parent !== parent) {
        parent.children.add(item);
      }
      keep.add(id);
      return item;
    };

    // Walk the records (declaration order) so keyItems/nameItems keep document order.
    for (const record of records) {
      const m = reconciled.get(record.testKey);
      if (!m) continue;
      if (m.kind !== 'runtimeOnly') {
        const node = m.node;
        const nodeItem = node ? entry.nodeItems.get(node) : undefined;
        if (!node || !nodeItem) continue;
        if (m.kind === 'eachRow') {
          const label = m.rowLabel ?? record.title;
          const item = runtimeItem(m.nodeId, label, nodeItem, it => { it.range = toRange(node); it.sortText = sortKey(node.range.startLine, label); });
          keyItems.set(m.testKey, item);
          this.itemIndex.set(item.id, { entry, testKey: m.testKey });
        } else {
          keyItems.set(m.testKey, nodeItem);
          this.itemIndex.set(nodeItem.id, { entry, node, testKey: m.testKey });
        }
        continue;
      }
      // Runtime-only: under the deepest matched static describe (or the file) through intermediate runtime describes.
      const describe = m.ancestry[m.ancestry.length - 1];
      let parent = (describe && entry.nodeItems.get(describe)) ?? entry.item;
      let id = m.parentId;
      const line = record.location ? record.location.line - 1 : 1e6;
      for (const title of m.extraAncestors) {
        id = `${id}\0describe:${title}`;
        parent = runtimeItem(id, title, parent, it => { if (parsed) it.description = RUNTIME_ONLY; it.sortText = sortKey(line, title); });
        this.itemIndex.set(parent.id, { entry });
      }
      const item = runtimeItem(m.nodeId, record.title, parent, it => {
        if (parsed) it.description = RUNTIME_ONLY;
        if (record.location) {
          const c = Math.max(0, record.location.column - 1);
          it.range = new vscode.Range(line, c, line, c);
        }
        it.sortText = sortKey(line, record.fullName);
      });
      keyItems.set(m.testKey, item);
      this.itemIndex.set(item.id, { entry, testKey: m.testKey });
    }

    // Drop runtime items that no record explains any more.
    for (const [id, item] of [...entry.runtimeItems]) {
      if (keep.has(id)) continue;
      item.parent?.children.delete(item.id);
      entry.runtimeItems.delete(id);
      this.itemIndex.delete(id);
    }

    // Static tests without a result after an unfiltered run were never registered at runtime
    // (a file that failed to load reports nothing at all, so it is excluded).
    const lastRun = store.lastRun(entry.path);
    const file = store.fileRecord(entry.path);
    const unreported = parsed && lastRun && !lastRun.filtered && file?.status !== 'errored'
      ? new Set(unreportedNodes(parsed, records, ids).map(u => u.node))
      : undefined;
    for (const [node, item] of entry.nodeItems) {
      if (node.kind !== 'test') continue;
      item.description = describeNode(node, unreported?.has(node) ?? false);
    }

    entry.keyItems = keyItems;
    entry.nameItems = new Map();
    for (const [key, item] of keyItems) {
      const name = parseTestKey(key).fullName;
      const list = entry.nameItems.get(name) ?? [];
      list.push(item);
      entry.nameItems.set(name, list);
    }
  }

  private reconcileRecords(parsed: ParsedFile, records: readonly TestRecord[], ids: ReconcileIds): Map<string, ReconciledTest> {
    if (!this.deps.reconcile) return reconcile(parsed, records, ids);
    const m = this.deps.reconcile(parsed, records);
    return m.reconciled ?? adaptMatchResult(m, records, ids);
  }

  // ------------------------------------------------------------------------------------------
  // Profiles
  // ------------------------------------------------------------------------------------------

  private async handleRun(request: vscode.TestRunRequest, token: vscode.CancellationToken, mode: ProfileMode): Promise<void> {
    const include = request.include ?? [...this.projects.values()].map(p => p.item);
    const selections = this.selectionsFor(include, request.exclude);
    if (selections.length === 0) return;
    if (request.continuous && mode === 'run') {
      this.deps.runner.watch(selections, token);
      return;
    }
    const run = this.controller.createTestRun(request, undefined, true);
    for (const item of include) this.enqueueTree(run, item, new Set((request.exclude ?? []).map(i => i.id)));
    const paths = new Set(selections.map(s => s.path));
    this.live.attachExplicitRun(run, paths);
    try {
      if (mode === 'debug') {
        for (const sel of selections) {
          if (token.isCancellationRequested) break;
          await this.deps.runner.debug(sel);
        }
      } else {
        const handle = mode === 'snapshots'
          ? await this.deps.runner.updateSnapshots({ kind: 'selection', selections })
          : await this.deps.runner.runFiles(selections, 'explicit', { updateSnapshot: this.deps.settings().snapshots.updateMode, priority: 0 });
        const sub = token.onCancellationRequested(() => this.deps.runner.cancel(handle.runId));
        try { await handle.done; } finally { sub.dispose(); }
      }
      this.deps.store.flush();
      if (mode === 'coverage') this.publishCoverage(run, paths);
    } catch (err) {
      const text = err instanceof Error ? err.stack ?? err.message : String(err);
      this.deps.log.error(`testTree: ${mode} failed: ${text}`);
      run.appendOutput(text.replace(/\r?\n/g, '\r\n') + '\r\n');
    } finally {
      this.live.detachExplicitRun(run);
      run.end();
    }
  }

  private enqueueTree(run: vscode.TestRun, item: vscode.TestItem, excluded: Set<string>): void {
    if (excluded.has(item.id)) return;
    if (item.children.size === 0) { run.enqueued(item); return; }
    item.children.forEach(child => this.enqueueTree(run, child, excluded));
  }

  /** `run.addCoverage()` for every source the run's test files touched. */
  private publishCoverage(run: vscode.TestRun, testPaths: Set<string>): void {
    const store = this.deps.store;
    const sources = new Set<string>();
    for (const p of testPaths) {
      for (const s of store.coveredSourcesOf(p)) sources.add(s);
      if (store.coverageFor(p)?.meta) sources.add(p);
    }
    for (const source of sources) {
      const cov = store.coverageFor(source);
      if (!cov?.meta) continue;
      const total = cov.meta.stmtStartLine.length;
      let hit = 0;
      for (let s = 0; s < total; s++) if ((cov.stmtHitBy.get(s)?.size ?? 0) + (cov.stmtHitByFile.get(s)?.size ?? 0) > 0) hit++;
      const armTotal = Math.floor(cov.meta.branchArms.length / 3);
      let armHit = 0;
      for (let i = 0; i + 2 < cov.meta.branchArms.length; i += 3) if (cov.branchArmHitByFile.has(`${cov.meta.branchArms[i]}:${cov.meta.branchArms[i + 1]}`)) armHit++;
      const includes: vscode.TestItem[] = [];
      for (const key of store.execBy().get(source) ?? []) {
        if (!testPaths.has(parseTestKey(key).path)) continue;
        const item = this.itemForTestKey(key);
        if (item) includes.push(item);
      }
      run.addCoverage(new vscode.FileCoverage(
        vscode.Uri.file(source),
        new vscode.TestCoverageCount(hit, total),
        armTotal > 0 ? new vscode.TestCoverageCount(armHit, armTotal) : undefined,
        undefined,
        includes.length > 0 ? includes : undefined,
      ));
    }
  }

  /** Statement/branch details for the Coverage view; `item` narrows to that test's hits. */
  loadDetailedCoverage(fileCoverage: vscode.FileCoverage, item: vscode.TestItem | undefined): vscode.FileCoverageDetail[] {
    const cov = this.deps.store.coverageFor(fileCoverage.uri.fsPath);
    if (!cov?.meta) return [];
    const keys = item ? new Set(this.testKeysFor(item)) : undefined;
    const meta = cov.meta;
    const details: vscode.StatementCoverage[] = [];
    const byLine = new Map<number, vscode.StatementCoverage>();
    for (let s = 0; s < meta.stmtStartLine.length; s++) {
      const start = meta.stmtStartLine[s] - 1;
      const end = Math.max(start, (meta.stmtEndLine[s] ?? meta.stmtStartLine[s]) - 1);
      let executed: number;
      if (keys) {
        executed = 0;
        for (const k of cov.stmtHitBy.get(s) ?? []) if (keys.has(k)) executed++;
      } else {
        executed = (cov.stmtHitBy.get(s)?.size ?? 0) + (cov.stmtHitByFile.get(s)?.size ?? 0);
      }
      const location = end > start ? new vscode.Range(start, 0, end, 10_000) : new vscode.Position(start, 0);
      const sc = new vscode.StatementCoverage(executed, location, []);
      details.push(sc);
      if (!byLine.has(start)) byLine.set(start, sc);
    }
    if (!keys) {
      for (let i = 0; i + 2 < meta.branchArms.length; i += 3) {
        const line = meta.branchArms[i + 2] - 1;
        const owner = byLine.get(line);
        if (!owner) continue;
        const hit = cov.branchArmHitByFile.has(`${meta.branchArms[i]}:${meta.branchArms[i + 1]}`);
        owner.branches.push(new vscode.BranchCoverage(hit, new vscode.Position(line, 0), `branch ${meta.branchArms[i]} arm ${meta.branchArms[i + 1]}`));
      }
    }
    return details;
  }

  // ------------------------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------------------------

  private async resolve(item: vscode.TestItem | undefined): Promise<void> {
    const cb = this.deps.resolveChildren;
    if (!cb) return;
    try {
      if (!item) { await cb({ kind: 'root' }); return; }
      if (this.projects.has(item.id)) { await cb({ kind: 'project', projectId: item.id }); return; }
      const entry = [...this.files.values()].find(e => e.item === item);
      if (entry) await cb({ kind: 'file', projectId: entry.projectId, path: entry.path });
    } catch (err) {
      this.deps.log.error(`testTree: resolve failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private ensureFile(projectId: string, filePath: string): FileEntry {
    let entry = this.files.get(filePath);
    if (entry) return entry;
    let project = this.projects.get(projectId);
    if (!project) {
      // Results can arrive before discovery published the project; keep the tree consistent.
      const item = this.controller.createTestItem(itemId(projectId), projectId);
      project = { spec: { id: projectId, displayName: projectId, repoRoot: '', packageDir: '', flavor: 'implicit', status: 'ok', nodeArgs: [], env: {}, cliFilters: { testPathIgnorePatterns: [] }, e2ePatterns: [], warnings: [] }, item };
      this.projects.set(projectId, project);
      this.controller.items.add(item);
    }
    const base = project.spec.packageDir || project.spec.repoRoot;
    const relPath = base ? path.relative(base, filePath) || path.basename(filePath) : filePath;
    const item = this.controller.createTestItem(itemId(fileIdOf({ projectId, relPath })), relPath, vscode.Uri.file(filePath));
    item.canResolveChildren = true;
    item.sortText = relPath;
    entry = { projectId, path: filePath, relPath, item, nodeItems: new Map(), keyItems: new Map(), nameItems: new Map(), runtimeItems: new Map(), notMatched: false, invalidated: false };
    this.files.set(filePath, entry);
    project.item.children.add(item);
    return entry;
  }

  private buildNodeItems(entry: FileEntry, nodes: readonly ParsedNode[], ancestry: ParsedNode[]): vscode.TestItem[] {
    const out: vscode.TestItem[] = [];
    for (const node of nodes) {
      const id = parsedNodeId(entry.projectId, entry.relPath, ancestry, node);
      const item = this.controller.createTestItem(itemId(id), labelFor(node), entry.item.uri);
      item.range = toRange(node);
      item.sortText = sortKey(node.range.startLine, node.title);
      item.description = describeNode(node, false);
      if (node.children.length) item.children.replace(this.buildNodeItems(entry, node.children, [...ancestry, node]));
      entry.nodeItems.set(node, item);
      this.itemIndex.set(id, { entry, node });
      out.push(item);
    }
    return out;
  }

  private forgetItems(entry: FileEntry): void {
    for (const [id, info] of [...this.itemIndex]) if (info.entry === entry) this.itemIndex.delete(id);
  }

  dispose(): void {
    this.live.dispose();
    for (const d of this.disposables) d.dispose();
    this.controller.dispose();
  }
}

function labelFor(node: ParsedNode): string {
  return node.dupIndex > 0 ? `${node.title} #${node.dupIndex + 1}` : node.title;
}

/** Item description: parser flags (`.each`, `skip`, `concurrent`, ...) plus "not registered". */
function describeNode(node: ParsedNode, unreported: boolean): string | undefined {
  const flags: string[] = [];
  if (node.each) flags.push('.each');
  if (node.mode !== 'default') flags.push(node.mode);
  if (node.concurrent) flags.push('concurrent');
  if (unreported) flags.push(NOT_REGISTERED);
  return flags.length ? flags.join(' · ') : undefined;
}

function toRange(node: ParsedNode): vscode.Range {
  const r = node.range;
  return new vscode.Range(r.startLine, r.startColumn, r.endLine, r.endColumn);
}

function sortKey(line: number, title: string): string {
  return `${String(Math.max(0, Math.min(line, 9_999_999))).padStart(7, '0')} ${title}`;
}

function isDescendant(item: vscode.TestItem, ancestor: vscode.TestItem): boolean {
  for (let p = item.parent; p; p = p.parent) if (p === ancestor) return true;
  return false;
}

/**
 * Reconciliation without a parsed tree: every record is runtime-only, nested under runtime
 * describes built from its `ancestorTitles` (ids follow the `describe:`/`test:` scheme so they
 * coincide with parsed ids once the file parses).
 */
function runtimeTree(records: readonly TestRecord[], fileId: string): Map<string, ReconciledTest> {
  const out = new Map<string, ReconciledTest>();
  const ordinals = new Map<string, number>();
  for (const r of records) {
    const ordKey = [...r.ancestorTitles, r.title].join('\0');
    const n = ordinals.get(ordKey) ?? 0;
    ordinals.set(ordKey, n + 1);
    const segs = [...r.ancestorTitles.map(t => `describe:${t}`), `test:${r.title}${n ? `#${n}` : ''}`];
    out.set(r.testKey, { testKey: r.testKey, kind: 'runtimeOnly', nodeId: [fileId, ...segs].join('\0'), node: null, ancestry: [], parentId: fileId, extraAncestors: r.ancestorTitles });
  }
  return out;
}

/** Adapts a node-keyed MatchResult (custom `ReconcileFn`) to core/testIds entries. */
function adaptMatchResult(m: MatchResult, records: readonly TestRecord[], ids: ReconcileIds): Map<string, ReconciledTest> {
  const out = new Map<string, ReconciledTest>();
  const fileId = fileIdOf(ids);
  const rows = new Map<string, number>();
  const runtimeOnly = new Map<string, number>();
  for (const r of records) {
    const match = m.byKey.get(r.testKey);
    if (!match) {
      const n = runtimeOnly.get(r.fullName) ?? 0;
      runtimeOnly.set(r.fullName, n + 1);
      out.set(r.testKey, { testKey: r.testKey, kind: 'runtimeOnly', nodeId: `${fileId}\0test:${r.title}${n ? `#${n}` : ''}`, node: null, ancestry: [], parentId: fileId, extraAncestors: [] });
      continue;
    }
    const nodeId = nodeIdOf(ids, match.ancestry, match.node);
    const parentId = match.ancestry.length ? nodeIdOf(ids, match.ancestry.slice(0, -1), match.ancestry[match.ancestry.length - 1]) : fileId;
    const list = m.byNode.get(match.node) ?? [];
    const asRow = match.node.each || match.node.titleKind !== 'static' || list.length > 1 || r.title !== match.node.title;
    if (!asRow) {
      out.set(r.testKey, { testKey: r.testKey, kind: 'exact', nodeId, node: match.node, ancestry: match.ancestry, parentId, extraAncestors: [] });
    } else {
      const rowKey = `${nodeId}\0${r.title}`;
      const n = rows.get(rowKey) ?? 0;
      rows.set(rowKey, n + 1);
      out.set(r.testKey, { testKey: r.testKey, kind: 'eachRow', nodeId: `${nodeId}\0row:${r.title}${n ? `#${n}` : ''}`, node: match.node, ancestry: match.ancestry, parentId: nodeId, extraAncestors: [], rowLabel: r.title });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Live run publisher
// ---------------------------------------------------------------------------------------------

interface RunTarget { run: vscode.TestRun; published: Map<string, string>; paths?: Set<string>; }

export interface LiveRunPublisherOptions {
  idleMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log: Logger;
}

/** Mirrors ResultStore state into TestRuns (explicit runs while active, else a transient live run). */
export class LiveRunPublisher implements vscode.Disposable {
  private liveRun: RunTarget | undefined;
  private readonly explicit: RunTarget[] = [];
  private idleTimer: unknown;
  private readonly idleMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    private readonly controller: vscode.TestController,
    private readonly store: ResultStore,
    private readonly explorer: Pick<TestExplorer, 'fileEntry'>,
    opts: LiveRunPublisherOptions,
  ) {
    this.idleMs = opts.idleMs ?? 500;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? (h => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Routes store changes for `paths` into `run` until `detachExplicitRun`. */
  attachExplicitRun(run: vscode.TestRun, paths: Set<string>): void {
    this.explicit.push({ run, published: new Map(), paths });
  }

  detachExplicitRun(run: vscode.TestRun): void {
    const i = this.explicit.findIndex(e => e.run === run);
    if (i >= 0) this.explicit.splice(i, 1);
  }

  /** The current live run, if one is open (tests). */
  get currentLiveRun(): vscode.TestRun | undefined { return this.liveRun?.run; }

  publish(paths: readonly string[]): void {
    let any = false;
    for (const p of paths) {
      const entry = this.explorer.fileEntry(p);
      const file = this.store.fileRecord(p);
      if (!entry || !file) continue;
      const target = this.explicit.find(e => e.paths?.has(p)) ?? this.ensureLive(entry.item);
      this.publishFile(target, file, entry);
      any = true;
    }
    if (any || this.liveRun) this.scheduleIdleCheck();
  }

  private publishFile(target: RunTarget, file: FileRecord, entry: FileEntry): void {
    const { run, published } = target;
    const mark = (item: vscode.TestItem, sig: string): boolean => {
      if (published.get(item.id) === sig) return false;
      published.set(item.id, sig);
      return true;
    };
    if (file.status === 'queued' || file.status === 'running') {
      const started = new Set(file.status === 'running' ? this.store.started(file.path).map(s => s.fullName) : []);
      const nameOf = new Map<vscode.TestItem, string>();
      for (const [name, items] of entry.nameItems) for (const it of items) nameOf.set(it, name);
      const visit = (item: vscode.TestItem) => {
        if (item.children.size > 0) { item.children.forEach(visit); return; }
        const name = nameOf.get(item);
        if (name !== undefined && started.has(name)) { if (mark(item, 'started')) run.started(item); }
        else if (mark(item, 'enqueued')) run.enqueued(item);
      };
      visit(entry.item);
    }
    for (const record of this.store.testsInFile(file.path)) {
      const item = entry.keyItems.get(record.testKey);
      if (!item) continue;
      const sig = `${record.status}|${record.lastRunId}|${record.stale ? 1 : 0}`;
      if (!mark(item, sig)) continue;
      const duration = record.duration ?? undefined;
      switch (record.status) {
        case 'passed': case 'focused': run.passed(item, duration); break;
        case 'failed': run.failed(item, messagesFor(record), duration); break;
        case 'errored': run.errored(item, messagesFor(record), duration); break;
        default: run.skipped(item);
      }
    }
    if (file.status === 'errored' && file.testExecError) {
      if (mark(entry.item, `errored|${file.lastRunId ?? ''}`)) run.errored(entry.item, messageFor(file.testExecError, file.path));
    }
  }

  private ensureLive(first: vscode.TestItem): RunTarget {
    if (!this.liveRun) {
      const run = this.controller.createTestRun(new vscode.TestRunRequest([first]), 'HyperJest live', false);
      this.liveRun = { run, published: new Map() };
    }
    return this.liveRun;
  }

  private scheduleIdleCheck(): void {
    if (this.idleTimer !== undefined) this.clearTimer(this.idleTimer);
    this.idleTimer = this.setTimer(() => {
      this.idleTimer = undefined;
      const s = this.store.summary();
      if (s.running === 0 && s.queued === 0 && this.liveRun) {
        this.liveRun.run.end();
        this.liveRun = undefined;
      } else if (this.liveRun) {
        this.scheduleIdleCheck();
      }
    }, this.idleMs);
  }

  dispose(): void {
    if (this.idleTimer !== undefined) this.clearTimer(this.idleTimer);
    this.liveRun?.run.end();
    this.liveRun = undefined;
    for (const e of this.explicit) e.run.end();
    this.explicit.length = 0;
  }
}

/** TestMessages for a failed/errored record: diff when expected/actual exist, location, stack. */
export function messagesFor(record: TestRecord): vscode.TestMessage[] {
  if (record.failures.length === 0) {
    const m = new vscode.TestMessage(`${record.fullName} ${record.status}`);
    if (record.location) m.location = new vscode.Location(vscode.Uri.file(record.path), new vscode.Position(record.location.line - 1, Math.max(0, record.location.column - 1)));
    return [m];
  }
  return record.failures.map(f => {
    const m = messageFor(f, record.path);
    if (!m.location && record.location) m.location = new vscode.Location(vscode.Uri.file(record.path), new vscode.Position(record.location.line - 1, Math.max(0, record.location.column - 1)));
    return m;
  });
}

export function messageFor(f: FailureInfo, testPath: string): vscode.TestMessage {
  const m = f.expected !== undefined && f.actual !== undefined
    ? vscode.TestMessage.diff(f.message, f.expected, f.actual)
    : new vscode.TestMessage(f.message);
  const top = f.frames.find(fr => fr.file === testPath) ?? f.frames[0];
  if (top) m.location = new vscode.Location(vscode.Uri.file(top.file), new vscode.Position(Math.max(0, top.line - 1), Math.max(0, top.column - 1)));
  if (f.frames.length > 0) {
    m.stackTrace = f.frames.map(fr => new vscode.TestMessageStackFrame(
      fr.functionName ?? path.basename(fr.file), vscode.Uri.file(fr.file), new vscode.Position(Math.max(0, fr.line - 1), Math.max(0, fr.column - 1))));
  }
  return m;
}
