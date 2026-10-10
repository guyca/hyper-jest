/**
 * Per-test coverage from istanbul counters.
 *
 * With `coverageProvider: 'babel'` every instrumented module keeps its counters on
 * `environment.global.__coverage__[path]` (`s` statements, `b` branch arms, `f` functions).
 * Counters only increase (istanbul reuses `coverage[path]` while the file hash is unchanged, even
 * under `resetModules`), so "which statements did this test execute" is the set of ids whose
 * counter grew between `test_start` and `test_done`. Snapshots are Int32Arrays; a diff is a linear
 * scan per loaded file.
 *
 * `coverageMeta` (statement/function/branch lines) is static per (path, hash) and is remapped through
 * `inputSourceMap` (ts-jest: istanbul instruments compiled JS) with @jridgewell/trace-mapping when the
 * project's Jest ships it; otherwise lines stay in generated coordinates and `remapped` is false.
 *
 * Pure; the trace-mapping module is injected.
 */
import { createHash } from 'crypto';
import * as path from 'path';
import { capturedSource } from './sourceCapture';
import type { CoverageMetaMsg } from '../core/protocol';

export interface IstanbulRange { start: { line: number; column: number }; end: { line: number; column: number } }

/** Shape of one `__coverage__[path]` entry (istanbul-lib-instrument 5/6 FileCoverageData). */
export interface IstanbulFileCoverage {
  path: string;
  statementMap: Record<string, IstanbulRange>;
  fnMap: Record<string, { name: string; decl: IstanbulRange; loc: IstanbulRange; line?: number }>;
  branchMap: Record<string, { loc: IstanbulRange; type: string; locations: IstanbulRange[]; line?: number }>;
  s: Record<string, number>;
  f: Record<string, number>;
  b: Record<string, number[]>;
  hash?: string;
  inputSourceMap?: Record<string, unknown>;
}

export type CoverageMap = Record<string, IstanbulFileCoverage>;

export interface FileSnapshot { s: Int32Array; b: Int32Array; f: Int32Array; hash: string }
export type CoverageSnapshot = Map<string, FileSnapshot>;

/** Numeric ids of a counter object in ascending order (istanbul ids are "0".."n-1"). */
export function sortedIds(obj: Record<string, unknown> | undefined): number[] {
  if (!obj) return [];
  return Object.keys(obj).map(Number).filter(n => Number.isInteger(n)).sort((a, b) => a - b);
}

export function snapshotStatements(fc: IstanbulFileCoverage): Int32Array {
  const ids = sortedIds(fc.s);
  const n = ids.length ? ids[ids.length - 1] + 1 : 0;
  const arr = new Int32Array(n);
  for (const id of ids) arr[id] = fc.s[id] | 0;
  return arr;
}

export function snapshotFunctions(fc: IstanbulFileCoverage): Int32Array {
  const ids = sortedIds(fc.f);
  const arr = new Int32Array(ids.length ? ids[ids.length - 1] + 1 : 0);
  for (const id of ids) arr[id] = fc.f[id] | 0;
  return arr;
}

/** Branch arms flattened in (branchId asc, armIndex asc) order. */
export function snapshotBranches(fc: IstanbulFileCoverage): Int32Array {
  const ids = sortedIds(fc.b);
  let total = 0;
  for (const id of ids) total += (fc.b[id] ?? []).length;
  const arr = new Int32Array(total);
  let k = 0;
  for (const id of ids) for (const v of fc.b[id] ?? []) arr[k++] = v | 0;
  return arr;
}

/** Ids whose counter is larger than in `prev` (all non-zero ids when `prev` is missing/shorter). */
export function increasedIds(prev: Int32Array | undefined, now: Int32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < now.length; i++) {
    const before = prev && i < prev.length ? prev[i] : 0;
    if (now[i] > before) out.push(i);
  }
  return out;
}

export function takeSnapshot(cov: CoverageMap | undefined | null): CoverageSnapshot {
  const snap: CoverageSnapshot = new Map();
  if (!cov || typeof cov !== 'object') return snap;
  for (const p of Object.keys(cov)) {
    const fc = cov[p];
    if (!fc || typeof fc !== 'object' || !fc.s) continue;
    snap.set(p, { s: snapshotStatements(fc), b: snapshotBranches(fc), f: snapshotFunctions(fc), hash: coverageHash(fc) });
  }
  return snap;
}

export interface FileDiff { path: string; stmts: number[]; fns: number[] }

/** Files whose statement counters increased since `prev`, with the increased statement ids. */
export function diffSnapshots(prev: CoverageSnapshot, cov: CoverageMap | undefined | null): FileDiff[] {
  const out: FileDiff[] = [];
  if (!cov || typeof cov !== 'object') return out;
  for (const p of Object.keys(cov)) {
    const fc = cov[p];
    if (!fc || typeof fc !== 'object' || !fc.s) continue;
    const before = prev.get(p);
    const same = before?.hash === coverageHash(fc) ? before : undefined;
    const stmts = increasedIds(same?.s, snapshotStatements(fc));
    const fns = increasedIds(same?.f, snapshotFunctions(fc));
    if (stmts.length || fns.length) out.push({ path: p, stmts, fns });
  }
  return out;
}

export function hitFunctions(fc: IstanbulFileCoverage): number[] {
  return sortedIds(fc.f).filter(id => fc.f[id] > 0);
}

/** Statement ids with a non-zero counter. */
export function hitStatements(fc: IstanbulFileCoverage): number[] {
  const out: number[] = [];
  for (const id of sortedIds(fc.s)) if ((fc.s[id] | 0) > 0) out.push(id);
  return out;
}

/** Branch arms with a non-zero counter as flattened [branchId, armIndex, ...] pairs. */
export function hitBranchArms(fc: IstanbulFileCoverage): number[] {
  const out: number[] = [];
  for (const id of sortedIds(fc.b)) {
    const arms = fc.b[id] ?? [];
    for (let i = 0; i < arms.length; i++) if ((arms[i] | 0) > 0) out.push(id, i);
  }
  return out;
}

const hashCache = new WeakMap<object, string>();

/** istanbul's own hash when present on the entry, else a sha1 of the static maps (stable per file content). */
export function coverageHash(fc: IstanbulFileCoverage): string {
  if (typeof fc.hash === 'string' && fc.hash) return fc.hash;
  const cached = hashCache.get(fc);
  if (cached) return cached;
  const h = createHash('sha1').update(JSON.stringify([fc.statementMap, fc.fnMap, fc.branchMap])).digest('hex');
  hashCache.set(fc, h);
  return h;
}

export interface TraceMappingLike {
  TraceMap: new (map: unknown) => unknown;
  originalPositionFor: (tracer: unknown, pos: { line: number; column: number }) => { line: number | null; column: number | null; source?: string | null };
}

export type LineRemapper = (line: number, column: number) => number | undefined;

/** Builds a generated->original line remapper from an istanbul `inputSourceMap`; undefined when unusable. */
export function makeLineRemapper(inputSourceMap: unknown, tm: TraceMappingLike | undefined): LineRemapper | undefined {
  if (!inputSourceMap || !tm || typeof tm.TraceMap !== 'function') return undefined;
  let tracer: unknown;
  try {
    tracer = new tm.TraceMap(inputSourceMap);
  } catch {
    return undefined;
  }
  return (line, column) => {
    try {
      const pos = tm.originalPositionFor(tracer, { line, column: Math.max(0, column | 0) });
      return pos && typeof pos.line === 'number' && pos.line > 0 ? pos.line : undefined;
    } catch {
      return undefined;
    }
  };
}

export type CoverageMetaBody = Omit<CoverageMetaMsg, 'v' | 'type'>;
const metaCache = new WeakMap<object, { source: string | undefined; tm: TraceMappingLike | undefined; meta: CoverageMetaBody }>();

/** Static shape of an instrumented file, remapped to original lines when a source map is available. */
export function buildCoverageMeta(fc: IstanbulFileCoverage, tm?: TraceMappingLike): CoverageMetaBody {
  const sourceText = capturedSource(fc.path);
  const cached = metaCache.get(fc);
  if (cached && cached.source === sourceText && cached.tm === tm) return cached.meta;
  let reliable = true;
  let tracer: unknown;
  if (fc.inputSourceMap) {
    try { tracer = tm ? new tm.TraceMap(fc.inputSourceMap) : undefined; } catch { /* conservative fallback */ }
    if (!tracer) reliable = false;
  }
  const mapPosition = (pos: { line: number; column: number } | undefined): { line: number; column: number } => {
    if (!pos || !Number.isInteger(pos.line) || pos.line < 1 || !Number.isInteger(pos.column)) {
      reliable = false;
      return { line: pos?.line || 0, column: pos?.column || 0 };
    }
    if (tracer && tm) {
      try {
        const mapped = tm.originalPositionFor(tracer, pos);
        const source = mapped.source?.replace(/^file:\/\//, '');
        const matches = source && path.resolve(path.dirname(fc.path), source) === path.resolve(fc.path);
        if (mapped.line && mapped.column !== null && matches) return { line: mapped.line, column: mapped.column };
        // Preserve existing display remapping, but do not narrow using partial/multi-source maps.
        reliable = false;
        if (mapped.line && mapped.column !== null) return { line: mapped.line, column: mapped.column };
      } catch { reliable = false; }
    }
    return pos;
  };
  const stmtStartLine: number[] = [], stmtEndLine: number[] = [];
  const stmtStartColumn: number[] = [], stmtEndColumn: number[] = [];
  for (const id of sortedIds(fc.statementMap)) {
    const r = fc.statementMap[id];
    const start = mapPosition(r?.start), end = mapPosition(r?.end);
    stmtStartLine[id] = start.line; stmtEndLine[id] = end.line;
    stmtStartColumn[id] = start.column; stmtEndColumn[id] = end.column;
  }
  const fnDeclLine: number[] = [], fnEndLine: number[] = [];
  const fnDeclColumn: number[] = [], fnEndColumn: number[] = [];
  for (const id of sortedIds(fc.fnMap)) {
    const fn = fc.fnMap[id];
    const start = mapPosition(fn?.decl?.start ?? fn?.loc?.start), end = mapPosition(fn?.loc?.end);
    fnDeclLine[id] = start.line; fnEndLine[id] = end.line;
    fnDeclColumn[id] = start.column; fnEndColumn[id] = end.column;
  }
  const branchArms: number[] = [];
  for (const id of sortedIds(fc.branchMap)) {
    const br = fc.branchMap[id];
    const locs = br?.locations?.length ? br.locations : br?.loc ? [br.loc] : [];
    locs.forEach((loc, armIndex) => {
      const start = loc?.start && typeof loc.start.line === 'number' ? loc.start : br.loc?.start;
      branchArms.push(id, armIndex, mapPosition(start).line);
    });
  }
  for (const array of [stmtStartLine, stmtEndLine, stmtStartColumn, stmtEndColumn, fnDeclLine, fnEndLine, fnDeclColumn, fnEndColumn]) {
    for (let i = 0; i < array.length; i++) if (array[i] === undefined) array[i] = 0;
  }
  const hash = coverageHash(fc);
  // Include resolved coordinates/reliability too: two transforms can expose the same raw maps.
  const shape = { stmtStartLine, stmtEndLine, stmtStartColumn, stmtEndColumn, fnDeclLine, fnEndLine, fnDeclColumn, fnEndColumn, branchArms };
  const originalCoordinates = reliable && sourceText !== undefined;
  const revision = sourceText === undefined ? undefined : createHash('sha1')
    .update(JSON.stringify([hash, sourceText, shape, originalCoordinates])).digest('hex');
  const meta = { path: fc.path, hash, ...shape, remapped: !!tracer, sourceText, revision, originalCoordinates };
  metaCache.set(fc, { source: sourceText, tm, meta });
  return meta;
}
