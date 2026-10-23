/** Config-isolated result partitions, with an aggregate view for editor decorations. */
import { makeTestKey, parseTestKey, type RunTestSelection, type WorkerToHost } from '../core/protocol';
import type { FileCoverage, FileRecord, InlineEntry, RunSummary, TestRecord } from '../core/resultModel';
import type { ParsedFile } from '../core/testModel';
import { statementProjection } from '../core/sourceChange';
import type { SourceSelection } from './coverageHistory';
import { ProjectResultStore, type ResultStoreOptions, type ChangeListener, type StaleInfo, type LastRunInfo, type StartedTest } from './projectResultStore';
export { ProjectResultStore, isFailingStatus, isInactiveStatus } from './projectResultStore';
export type { ResultStoreOptions, ChangeListener, StaleInfo, LastRunInfo, StartedTest } from './projectResultStore';

export function projectTestKey(key: string, projectId: string): string {
  const test = parseTestKey(key);
  return makeTestKey(test.path, test.fullName, test.dupIndex, projectId);
}

export class ResultStore {
  private readonly partitions = new Map<string, ProjectResultStore>();
  private readonly parses = new Map<string, ParsedFile>();
  private readonly listeners = new Set<ChangeListener>();
  private readonly registrations = new Map<string, RunTestSelection[]>();
  private readonly labels = new Map<string, string>();
  private epoch = 0;
  private readonly pendingStale = new Map<string, number[] | undefined>();
  constructor(private readonly options: ResultStoreOptions = {}) {}
  get generation(): number { return this.epoch + this.stores().reduce((n, s) => n + s.generation, 0); }
  setProjectLabel(id: string, label: string): void { this.labels.set(id, label); }
  projectLabel(id: string): string { return this.labels.get(id) ?? id; }
  forProject(id: string): ProjectResultStore {
    let store = this.partitions.get(id);
    if (!store) {
      store = new ProjectResultStore(this.options);
      for (const [p, parsed] of this.parses) store.setParsed(p, parsed);
      for (const [p, lines] of this.pendingStale) store.markStale(p, lines);
      store.onDidChange(paths => this.notify(paths));
      this.partitions.set(id, store);
    }
    return store;
  }
  private stores(id?: string): ProjectResultStore[] { return id === undefined ? [...this.partitions.values()] : this.partitions.has(id) ? [this.partitions.get(id)!] : []; }
  private notify(paths: string[]): void { for (const listener of this.listeners) listener(paths); }
  registerRun(runId: string, tests: RunTestSelection[]): void {
    this.registrations.set(runId, tests);
    for (const test of tests) if (test.projectId) this.forProject(test.projectId).registerRun(runId, tests.filter(t => t.projectId === test.projectId));
  }
  markQueued(p: string, projectId = this.fileRecord(p)?.projectId ?? ''): void { this.forProject(projectId).markQueued(p, projectId); }
  unmarkQueued(p: string, projectId?: string): void { for (const s of this.stores(projectId)) s.unmarkQueued(p); }
  markRunning(p: string, run?: { runId: string; names?: string[]; projectId?: string }): void { this.forProject(run?.projectId ?? this.fileRecord(p)?.projectId ?? '').markRunning(p, run); }
  markStale(p: string, lines?: Iterable<number>): void { const copy = lines ? [...lines] : undefined; this.pendingStale.set(p, copy); for (const s of this.stores()) s.markStale(p, copy); }
  clearStale(p: string): void { this.pendingStale.delete(p); for (const s of this.stores()) s.clearStale(p); }
  clearFile(p: string, projectId?: string): void { for (const s of this.stores(projectId)) s.clearFile(p); if (projectId === undefined) this.parses.delete(p); }
  clearProject(id: string): void {
    const store = this.partitions.get(id);
    if (!store) return;
    store.clearProject(id); store.flush(); this.epoch += store.generation + 1; store.dispose(); this.partitions.delete(id);
    this.labels.delete(id);
  }
  abortRun(id: string): void { for (const s of this.stores()) s.abortRun(id); this.registrations.delete(id); }
  setParsed(p: string, parsed: ParsedFile): void {
    this.parses.set(p, parsed); this.epoch++;
    for (const s of this.stores()) s.setParsed(p, parsed);
    if (!this.partitions.size) this.notify([p]);
  }
  apply(message: WorkerToHost, projectId: string): void {
    const store = this.forProject(projectId);
    let msg = message;
    if ('testKey' in msg && msg.testKey) msg = { ...msg, testKey: projectTestKey(msg.testKey, projectId) } as WorkerToHost;
    if (msg.type === 'testResult' && !msg.testKey) msg = { ...msg, testKey: makeTestKey(msg.path, msg.fullName, 0, projectId) };
    if ('runId' in msg) {
      const tests = this.registrations.get(msg.runId);
      if (tests) store.registerRun(msg.runId, tests.filter(t => !t.projectId || t.projectId === projectId));
      if (msg.type === 'runComplete') this.registrations.delete(msg.runId);
    }
    store.apply(msg, projectId);
  }
  fileRecord(p: string, projectId?: string): FileRecord | undefined {
    const rank: Record<FileRecord['status'], number> = { running: 0, errored: 1, failed: 2, queued: 3, passed: 4, skipped: 5, notMatched: 6, unknown: 7 };
    return this.stores(projectId).map(s => s.fileRecord(p)).filter((f): f is FileRecord => !!f).sort((a, b) => rank[a.status] - rank[b.status])[0];
  }
  test(key: string): TestRecord | undefined {
    const id = parseTestKey(key).projectId;
    if (id) return this.partitions.get(id)?.test(key);
    for (const [project, store] of this.partitions) { const record = store.test(projectTestKey(key, project)) ?? store.test(key); if (record) return record; }
    return undefined;
  }
  parsed(p: string): ParsedFile | undefined { return this.parses.get(p); }
  allFiles(): FileRecord[] { return this.stores().flatMap(s => s.allFiles()); }
  allTests(): TestRecord[] { return this.stores().flatMap(s => s.allTests()); }
  testsInFile(p: string, projectId?: string): TestRecord[] { return this.stores(projectId).flatMap(s => s.testsInFile(p)); }
  failingTests(): TestRecord[] { return this.stores().flatMap(s => s.failingTests()); }
  summary(): RunSummary {
    const out: RunSummary = { passed: 0, failed: 0, pending: 0, running: 0, queued: 0, staleFiles: 0 };
    for (const store of this.stores()) { const s = store.summary(); for (const k of Object.keys(out) as Array<keyof RunSummary>) out[k] += s[k]; }
    return out;
  }
  staleInfo(p: string): StaleInfo | undefined {
    const stores = this.stores();
    const contributors = stores.filter(s => s.hasResultsFor(p));
    // Edit markers are broadcast (and replayed into new partitions), but unrelated configs never
    // run this file and cannot clear theirs. Only contributors can keep displayed results stale.
    // Before the first result, retain edit markers so in-flight work still tracks buffer changes.
    return (contributors.length ? contributors : stores).map(s => s.staleInfo(p))
      .filter((x): x is StaleInfo => !!x).sort((a, b) => b.at - a.at)[0];
  }
  lastRun(p: string, projectId?: string): LastRunInfo | undefined { return this.stores(projectId).map(s => s.lastRun(p)).filter((x): x is LastRunInfo => !!x).sort((a, b) => b.at - a.at)[0]; }
  dataStartedAt(p: string): number | undefined {
    const times = this.stores().map(s => s.dataStartedAt(p)).filter((n): n is number => n !== undefined);
    return times.length ? Math.min(...times) : undefined;
  }
  started(p: string, projectId?: string): StartedTest[] { return this.stores(projectId).flatMap(s => s.started(p)); }
  execBy(): Map<string, Set<string>> { return unionMaps(this.stores().map(s => s.execBy())); }
  loadedBy(): Map<string, Set<string>> { return unionMaps(this.stores().map(s => s.loadedBy())); }
  coveredSourcesOf(p: string, projectId?: string): Set<string> { return new Set(this.stores(projectId).flatMap(s => [...s.coveredSourcesOf(p)])); }
  sourceSelection(p: string, text: string): SourceSelection {
    const values = this.stores().map(s => s.sourceSelection(p, text));
    return { tests: new Set(values.flatMap(v => [...v.tests])), wholeFiles: new Set(values.flatMap(v => [...v.wholeFiles])), trackedFiles: new Set(values.flatMap(v => [...v.trackedFiles])) };
  }
  entriesFor(p: string): Map<number, InlineEntry[]> {
    const out = new Map<number, InlineEntry[]>();
    const contributors = [...this.partitions].map(([id, store]) => ({ id, lines: store.entriesFor(p) })).filter(({ lines }) => lines.size > 0);
    for (const { id, lines } of contributors) for (const [line, entries] of lines) {
      const labelled = contributors.length > 1 ? entries.map(e => ({ ...e, text: `[${this.projectLabel(id)}] ${e.text}`, longText: `[${this.projectLabel(id)}] ${e.longText ?? e.text}` })) : entries;
      out.set(line, [...(out.get(line) ?? []), ...labelled]);
    }
    return out;
  }
  clearInlineEntries(p: string, line?: number): void { for (const s of this.stores()) s.clearInlineEntries(p, line); }
  coverageFor(p: string, projectId?: string | readonly string[]): FileCoverage | undefined {
    const selected = projectId === undefined ? [...this.partitions.keys()] : typeof projectId === 'string' ? [projectId] : projectId;
    const values = selected.flatMap(id => this.stores(id).map(s => ({ id, cov: s.coverageFor(p), at: s.dataStartedAt(p) ?? 0 }))).filter(x => x.cov?.meta).sort((a, b) => b.at - a.at);
    if (!values.length) return undefined;
    if (values.length === 1) return values[0].cov;
    const meta = values[0].cov!.meta!;
    const result: FileCoverage = { meta, stmtHitBy: new Map(), stmtHitByFile: new Map(), branchArmHitByFile: new Map() };
    for (const { id: project, cov: value } of values) {
      const cov = value!;
      const from = cov.meta!;
      const sameShape = JSON.stringify([from.stmtStartLine, from.stmtEndLine, from.stmtStartColumn, from.stmtEndColumn]) === JSON.stringify([meta.stmtStartLine, meta.stmtEndLine, meta.stmtStartColumn, meta.stmtEndColumn]);
      const projection = sameShape ? statementProjection(from, meta)
        : statementProjection({ ...from, revision: undefined, hash: 'from' }, { ...meta, revision: undefined, hash: 'to' });
      result.stale ||= cov.stale;
      for (const key of ['stmtHitBy', 'stmtHitByFile'] as const) for (const [id, hits] of cov[key]) {
        const next = projection.get(id);
        if (next === undefined) { result.stale = true; continue; }
        addSet(result[key], next, key === 'stmtHitBy' ? hits : [...hits].map(file => `${project}\0${file}`));
      }
      if (cov.meta!.hash === meta.hash && JSON.stringify(cov.meta!.branchArms) === JSON.stringify(meta.branchArms))
        for (const [id, hits] of cov.branchArmHitByFile) addSet(result.branchArmHitByFile, id, [...hits].map(file => `${project}\0${file}`));
    }
    return result;
  }
  onDidChange(listener: ChangeListener): { dispose(): void } { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }
  flush(): void { for (const s of this.stores()) s.flush(); }
  dispose(): void { for (const s of this.stores()) s.dispose(); this.listeners.clear(); }
}
function addSet<K>(map: Map<K, Set<string>>, key: K, values: Iterable<string>): void {
  const set = map.get(key) ?? new Set<string>(); for (const value of values) set.add(value); map.set(key, set);
}
function unionMaps(maps: Map<string, Set<string>>[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>(); for (const map of maps) for (const [key, values] of map) addSet(out, key, values); return out;
}
