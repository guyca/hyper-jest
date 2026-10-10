import {
  buildCoverageMeta, coverageHash, diffSnapshots, hitBranchArms, hitStatements, increasedIds, makeLineRemapper,
  snapshotBranches, snapshotStatements, takeSnapshot, type IstanbulFileCoverage, type TraceMappingLike,
} from '../../../src/worker/coverageDiff';
import { captureTransformedSource, resetSourceCapture } from '../../../src/worker/sourceCapture';

const range = (l1: number, c1: number, l2: number, c2: number) => ({ start: { line: l1, column: c1 }, end: { line: l2, column: c2 } });

function fc(over: Partial<IstanbulFileCoverage> = {}): IstanbulFileCoverage {
  return {
    path: '/p/math.js',
    statementMap: { 0: range(2, 2, 2, 15), 1: range(6, 2, 8, 3), 2: range(7, 4, 7, 40) },
    fnMap: { 0: { name: 'add', decl: range(1, 9, 1, 12), loc: range(1, 19, 3, 1), line: 1 } },
    branchMap: { 0: { loc: range(6, 2, 8, 3), type: 'if', locations: [range(6, 2, 8, 3), { start: { line: undefined as unknown as number, column: undefined as unknown as number }, end: { line: 0, column: 0 } }], line: 6 } },
    s: { 0: 0, 1: 0, 2: 0 },
    f: { 0: 0 },
    b: { 0: [0, 0] },
    ...over,
  };
}

describe('coverageDiff', () => {
  beforeEach(() => resetSourceCapture());
  it('records function calls even when no statement ran', () => {
    const file = fc();
    const before = takeSnapshot({ [file.path]: file });
    file.f[0]++;
    expect(diffSnapshots(before, { [file.path]: file })).toEqual([{ path: file.path, stmts: [], fns: [0] }]);
  });

  it('only trusts complete single-source mappings paired with captured transform text', () => {
    captureTransformedSource('/p/math.js', { originalCode: 'function add(a, b) {\n  return a + b;\n}\n' });
    const complete: TraceMappingLike = { TraceMap: class {}, originalPositionFor: (_t, pos) => ({ ...pos, source: '/p/math.js' }) };
    const file = fc({ inputSourceMap: {} });
    expect(buildCoverageMeta(file, complete).originalCoordinates).toBe(true);
    expect(buildCoverageMeta(file).originalCoordinates).toBe(false);
    const partial: TraceMappingLike = { ...complete, originalPositionFor: (_t, pos) => pos.line === 3 ? { line: null, column: null } : { ...pos, source: '/p/math.js' } };
    expect(buildCoverageMeta(file, partial).originalCoordinates).toBe(false);
    const other: TraceMappingLike = { ...complete, originalPositionFor: (_t, pos) => ({ ...pos, source: '/p/other.js' }) };
    expect(buildCoverageMeta(file, other).originalCoordinates).toBe(false);
  });
  it('snapshots counters in id order and diffs increases', () => {
    const a = fc({ s: { 0: 1, 1: 0, 2: 3 } });
    expect(Array.from(snapshotStatements(a))).toEqual([1, 0, 3]);
    expect(Array.from(snapshotBranches(fc({ b: { 1: [5], 0: [1, 2] } })))).toEqual([1, 2, 5]);
    expect(increasedIds(new Int32Array([1, 0, 3]), new Int32Array([1, 2, 3]))).toEqual([1]);
    expect(increasedIds(undefined, new Int32Array([0, 2, 0, 1]))).toEqual([1, 3]);
    expect(increasedIds(new Int32Array([1]), new Int32Array([1, 4]))).toEqual([1]);
  });

  it('takeSnapshot/diffSnapshots work over a coverage map and ignore junk entries', () => {
    const cov = { '/p/math.js': fc({ s: { 0: 1, 1: 1, 2: 0 } }), junk: {} as IstanbulFileCoverage };
    const snap = takeSnapshot(cov);
    expect([...snap.keys()]).toEqual(['/p/math.js']);
    cov['/p/math.js'].s[2] = 1;
    cov['/p/math.js'].s[0] = 2;
    expect(diffSnapshots(snap, cov)).toEqual([{ path: '/p/math.js', stmts: [0, 2], fns: [] }]);
    expect(diffSnapshots(snap, undefined)).toEqual([]);
    const fresh = { '/p/new.js': fc({ path: '/p/new.js', s: { 0: 0, 1: 7, 2: 0 } }) };
    expect(diffSnapshots(new Map(), fresh)).toEqual([{ path: '/p/new.js', stmts: [1], fns: [] }]);
  });

  it('reports hit statements and branch arms', () => {
    const c = fc({ s: { 0: 2, 1: 0, 2: 1 }, b: { 0: [3, 0], 1: [0, 1, 2] } });
    expect(hitStatements(c)).toEqual([0, 2]);
    expect(hitBranchArms(c)).toEqual([0, 0, 1, 1, 1, 2]);
  });

  it('builds coverage meta in generated coordinates when no source map exists', () => {
    const meta = buildCoverageMeta(fc({ hash: 'abc' }));
    expect(meta).toMatchObject({
      path: '/p/math.js', hash: 'abc', stmtStartLine: [2, 6, 7], stmtEndLine: [2, 8, 7], fnDeclLine: [1], fnEndLine: [3], originalCoordinates: false,
      branchArms: [0, 0, 6, 0, 1, 6], remapped: false,
    });
  });

  it('remaps lines through inputSourceMap using the injected trace-mapping', () => {
    const tm: TraceMappingLike = {
      TraceMap: class { constructor(public map: unknown) {} },
      originalPositionFor: (_t, pos) => ({ line: pos.line * 10, column: pos.column, source: 'x.ts' }),
    };
    const meta = buildCoverageMeta(fc({ inputSourceMap: { version: 3, mappings: '' } }), tm);
    expect(meta.remapped).toBe(true);
    expect(meta.stmtStartLine).toEqual([20, 60, 70]);
    expect(meta.fnDeclLine).toEqual([10]);
    expect(meta.branchArms).toEqual([0, 0, 60, 0, 1, 60]);
    expect(makeLineRemapper(undefined, tm)).toBeUndefined();
    const broken: TraceMappingLike = { TraceMap: class { constructor() { throw new Error('bad map'); } }, originalPositionFor: () => ({ line: null, column: null }) };
    expect(makeLineRemapper({}, broken)).toBeUndefined();
    const unmapped: TraceMappingLike = { TraceMap: class {}, originalPositionFor: () => ({ line: null, column: null }) };
    expect(buildCoverageMeta(fc({ inputSourceMap: {} }), unmapped).stmtStartLine).toEqual([2, 6, 7]);
  });

  it('hashes static maps stably when istanbul does not expose a hash', () => {
    const a = fc();
    const b = fc();
    expect(coverageHash(a)).toBe(coverageHash(b));
    expect(coverageHash(a)).toHaveLength(40);
    expect(coverageHash(fc({ hash: 'given' }))).toBe('given');
    expect(coverageHash(fc({ statementMap: { 0: range(9, 9, 9, 9) } }))).not.toBe(coverageHash(a));
  });
});
