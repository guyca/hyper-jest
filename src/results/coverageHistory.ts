/** Coverage IDs are local to an immutable source revision, never to the latest metadata arrival. */
import type { CoverageHit } from '../core/protocol';
import { parseTestKey } from '../core/protocol';
import type { CoverageMeta, FileCoverage } from '../core/resultModel';
import { changedFunctions, statementProjection, unchangedLines } from '../core/sourceChange';

export interface RecordedHit extends CoverageHit { meta?: CoverageMeta; arms?: number[]; stale?: boolean }
export interface SourceSelection {
  tests: Set<string>;
  wholeFiles: Set<string>;
  /** Files with complete, usable runtime evidence for this source and edit. */
  trackedFiles: Set<string>;
}

export class CoverageHistory {
  private readonly metas = new Map<string, CoverageMeta>();
  private readonly tests = new Map<string, RecordedHit[]>();
  private readonly files = new Map<string, RecordedHit[]>();
  private readonly shared = new Map<string, RecordedHit[]>();
  private readonly complete = new Set<string>();
  private readonly latest = new Map<string, { meta: CoverageMeta; sequence: number }>();

  addMeta(project: string, path: string, meta: CoverageMeta): void {
    const key = `${project}\0${path}\0${meta.revision ?? meta.hash}`;
    if (!this.metas.has(key)) this.metas.set(key, meta);
  }

  bind(project: string, hits: CoverageHit[]): RecordedHit[] {
    return hits.map(h => ({ ...h, stmts: [...h.stmts], fns: h.fns?.slice(),
      meta: this.metas.get(`${project}\0${h.path}\0${h.revision ?? h.hash}`),
    }));
  }

  replaceTest(key: string, hits: RecordedHit[], sequence: number): Set<string> {
    const touched = new Set([...(this.tests.get(key) ?? []), ...hits].map(h => h.path));
    if (hits.length) this.tests.set(key, hits); else this.tests.delete(key);
    this.noteLatest(hits, sequence);
    return touched;
  }

  commitFile(file: string, hits: RecordedHit[], shared: RecordedHit[], complete: boolean, filtered: boolean, sequence: number): void {
    this.files.set(file, filtered ? advanceHits(this.files.get(file) ?? [], hits, false) : hits);
    this.shared.set(file, filtered ? advanceHits(this.shared.get(file) ?? [], shared, true) : shared);
    if (!filtered) { if (complete) this.complete.add(file); else this.complete.delete(file); }
    else if (!complete) this.complete.delete(file);
    this.noteLatest([...hits, ...shared], sequence);
  }

  private noteLatest(hits: RecordedHit[], sequence: number): void {
    for (const h of hits) if (h.meta && sequence >= (this.latest.get(h.path)?.sequence ?? -1)) {
      this.latest.set(h.path, { meta: h.meta, sequence });
    }
  }

  forgetFile(file: string): void {
    for (const key of this.tests.keys()) if (parseTestKey(key).path === file) this.tests.delete(key);
    this.files.delete(file); this.shared.delete(file); this.complete.delete(file);
  }

  invalidate(file: string): void { this.complete.delete(file); }

  /** Entries bind metadata eagerly; after a run, keep only revisions still referenced by data. */
  prune(pending: Iterable<RecordedHit>): void {
    const live = new Set<CoverageMeta>();
    const paths = new Set<string>();
    for (const h of [...this.tests.values(), ...this.files.values(), ...this.shared.values(), [...pending]].flat()) {
      paths.add(h.path); if (h.meta) live.add(h.meta);
    }
    for (const [path, entry] of this.latest) {
      if (paths.has(path)) live.add(entry.meta); else this.latest.delete(path);
    }
    for (const [key, meta] of this.metas) if (!live.has(meta)) this.metas.delete(key);
  }

  select(path: string, text: string): SourceSelection {
    const result: SourceSelection = { tests: new Set(), wholeFiles: new Set(), trackedFiles: new Set() };
    const analyses = new Map<CoverageMeta, Set<number> | null>();
    const analyze = (hit: RecordedHit): Set<number> | null => {
      if (!hit.meta || !hit.revision || !hit.fns) return null;
      if (!analyses.has(hit.meta)) analyses.set(hit.meta, changedFunctions(path, text, hit.meta));
      return analyses.get(hit.meta)!;
    };
    const observed = new Set<string>(), uncertain = new Set<string>();
    for (const [key, hits] of this.tests) {
      const file = parseTestKey(key).path;
      for (const h of hits) {
        if (h.path !== path) continue;
        observed.add(file);
        const changed = analyze(h);
        if (changed === null) uncertain.add(file);
        if (changed === null || h.fns!.some(id => changed.has(id))) result.tests.add(key);
      }
    }
    for (const [file, hits] of this.shared) for (const h of hits) {
      if (h.path !== path) continue;
      observed.add(file);
      const changed = analyze(h);
      if (changed === null) uncertain.add(file);
      if (changed === null || h.fns!.some(id => changed.has(id))) result.wholeFiles.add(file);
    }
    for (const file of observed) if (this.complete.has(file) && !uncertain.has(file)) result.trackedFiles.add(file);
    return result;
  }

  /** Rebuild the display projection without ever merging raw IDs from different revisions. */
  project(path: string, target: FileCoverage): void {
    const meta = this.latest.get(path)?.meta ?? target.meta;
    target.meta = meta;
    target.stmtHitBy.clear(); target.stmtHitByFile.clear(); target.branchArmHitByFile.clear();
    target.stale = false;
    const projections = new Map<CoverageMeta, Map<number, number>>();
    const projected = (h: RecordedHit): number[] => {
      if (!meta || !h.meta) { target.stale ||= h.stmts.length > 0; return []; }
      let mapping = projections.get(h.meta);
      if (!mapping) { mapping = statementProjection(h.meta, meta); projections.set(h.meta, mapping); }
      const ids = h.stmts.flatMap(id => mapping!.has(id) ? [mapping!.get(id)!] : []);
      target.stale ||= ids.length !== h.stmts.length;
      return ids;
    };
    for (const [key, hits] of this.tests) for (const h of hits) {
      if (h.path !== path) continue;
      for (const id of projected(h)) add(target.stmtHitBy, id, key);
    }
    for (const [file, hits] of this.files) for (const h of hits) {
      if (h.path !== path) continue;
      for (const id of projected(h)) add(target.stmtHitByFile, id, file);
      target.stale ||= h.stale === true;
      if (h.meta === meta || (h.revision && h.revision === meta?.revision) || (!h.revision && h.hash === meta?.hash)) {
        for (let i = 0; i + 1 < (h.arms?.length ?? 0); i += 2) add(target.branchArmHitByFile, `${h.arms![i]}:${h.arms![i + 1]}`, file);
      }
    }
  }
}

/** Carry unchanged aggregate contributions forward so each keystroke doesn't retain a source copy.
 * Per-test histories remain untouched. Unmappable shared executions retain their original revision.
 */
function advanceHits(previous: RecordedHit[], incoming: RecordedHit[], shared: boolean): RecordedHit[] {
  const advanced = previous.map(old => {
    const next = incoming.find(h => h.path === old.path);
    if (!next?.meta || !old.meta || next.revision === old.revision) return old;
    const mapLine = unchangedLines(old.meta, next.meta);
    if (!mapLine) return old;
    const stmts = statementProjection(old.meta, next.meta);
    const fns: number[] = [];
    if (shared) {
      if (!old.fns) return old;
      for (const id of old.fns) {
        const first = old.meta.fnDeclLine[id], last = old.meta.fnEndLine?.[id];
        if (!last) return old;
        // An edit anywhere in this shared function may invalidate the old dependency.
        for (let line = first; line <= last; line++) if (mapLine(line) !== mapLine(first)! + line - first) return old;
        const candidates = next.meta.fnDeclLine.flatMap((line, i) =>
          line === mapLine(first) && next.meta!.fnEndLine?.[i] === mapLine(last)
          && old.meta!.fnDeclColumn?.[id] === next.meta!.fnDeclColumn?.[i]
          && old.meta!.fnEndColumn?.[id] === next.meta!.fnEndColumn?.[i] ? [i] : []);
        if (candidates.length !== 1) return old;
        fns.push(candidates[0]);
      }
    }
    const arms: number[] = [];
    let stale = old.stale;
    for (let i = 0; i + 1 < (old.arms?.length ?? 0); i += 2) {
      const branch = old.arms![i], arm = old.arms![i + 1];
      const triples = old.meta.branchArms;
      const at = triples.findIndex((value, j) => j % 3 === 0 && value === branch && triples[j + 1] === arm);
      const line = at < 0 ? undefined : mapLine(triples[at + 2]);
      if (line === undefined) continue; // changed code's current counters supersede the old union
      const candidates: number[] = [];
      for (let j = 0; j < next.meta.branchArms.length; j += 3) {
        if (next.meta.branchArms[j + 1] === arm && next.meta.branchArms[j + 2] === line) candidates.push(next.meta.branchArms[j]);
      }
      if (candidates.length === 1) arms.push(candidates[0], arm); else stale = true;
    }
    return { ...next, fns: shared ? fns : undefined, stmts: old.stmts.flatMap(id => stmts.has(id) ? [stmts.get(id)!] : []), arms, stale };
  });
  return mergeHits(advanced, incoming);
}

function add<K>(map: Map<K, Set<string>>, key: K, value: string): void {
  let set = map.get(key); if (!set) map.set(key, set = new Set()); set.add(value);
}

export function mergeHits(a: RecordedHit[], b: RecordedHit[]): RecordedHit[] {
  const merged = new Map<string, RecordedHit>();
  for (const h of [...a, ...b]) {
    const key = `${h.path}\0${h.revision ?? h.hash ?? '?'}`;
    const prev = merged.get(key);
    merged.set(key, { ...h, meta: h.meta ?? prev?.meta,
      stmts: [...new Set([...(prev?.stmts ?? []), ...h.stmts])],
      fns: h.fns && (!prev || prev.fns) ? [...new Set([...(prev?.fns ?? []), ...h.fns])] : undefined,
      arms: uniquePairs([...(prev?.arms ?? []), ...(h.arms ?? [])]),
      stale: prev?.stale || h.stale,
    });
  }
  return [...merged.values()];
}

/** Keep branch ID/arm pairs together when merging flat arrays. */
function uniquePairs(values: number[]): number[] {
  const out: number[] = [], seen = new Set<string>();
  for (let i = 0; i + 1 < values.length; i += 2) {
    const key = `${values[i]}:${values[i + 1]}`;
    if (!seen.has(key)) { seen.add(key); out.push(values[i], values[i + 1]); }
  }
  return out;
}
