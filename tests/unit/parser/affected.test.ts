import { makeTestKey } from '../../../src/core/protocol';
import {
  inverseClosure, isToolchainFile, narrowByFunctions, selectAffected, snapshotOwner,
  type AffectedCoverage, type AffectedInput,
} from '../../../src/core/affected';

const SRC = '/repo/src/math.ts';
const T1 = '/repo/src/__tests__/math.test.ts';
const T2 = '/repo/src/__tests__/greet.test.ts';
const T3 = '/repo/src/__tests__/far.test.ts';
const HELPER = '/repo/src/__tests__/helpers.test.ts';

const key = (file: string, name: string, dup = 0) => makeTestKey(file, name, dup);

function base(overrides: Partial<AffectedInput> = {}): AffectedInput {
  return {
    changedFile: SRC,
    changedLines: [{ start: 5, end: 6, oldStart: 5, oldEnd: 6 }],
    execBy: new Map(),
    loadedBy: new Map(),
    inverseStaticGraph: new Map(),
    testFiles: new Set([T1, T2, T3, HELPER]),
    failingTestsByFile: new Map(),
    settings: { maxTestFilesPerEdit: 8, alwaysRunFailing: true, useStaticGraph: true, trackFileLoading: true },
    ...overrides,
  };
}

const setMap = <V>(entries: Array<[string, V[]]>) => new Map(entries.map(([k, v]) => [k, new Set(v)]));

describe('selectAffected: classification', () => {
  it('flags toolchain files for config invalidation', () => {
    for (const f of ['/r/jest.config.js', '/r/jest.unit.config.cjs', '/r/jest.config.ts', '/r/package.json', '/r/babel.config.js',
      '/r/.babelrc', '/r/tsconfig.json', '/r/tsconfig.build.json', '/r/yarn.lock', '/r/node_modules/x/index.js']) {
      expect(isToolchainFile(f)).toBe(true);
      expect(selectAffected(base({ changedFile: f }))).toMatchObject({ kind: 'invalidateConfig' });
    }
    expect(isToolchainFile('/r/src/jest-helpers.ts')).toBe(false);
    expect(isToolchainFile('/r/src/package.json.ts')).toBe(false);
    expect(isToolchainFile('/r/setup.ts', new Set(['/r/setup.ts']))).toBe(true);
    expect(selectAffected(base({ changedFile: '/r/setup.ts', toolchainFiles: new Set(['/r/setup.ts']) }))).toMatchObject({ kind: 'invalidateConfig' });
  });

  it('maps .snap files to their owning test file', () => {
    expect(snapshotOwner('/r/src/__tests__/__snapshots__/a.test.ts.snap')).toBe('/r/src/__tests__/a.test.ts');
    expect(snapshotOwner('/r/src/__tests__/a.test.ts.snap')).toBeNull();
    expect(snapshotOwner('/r/__snapshots__/a.test.ts.txt')).toBeNull();
    const result = selectAffected(base({ changedFile: '/repo/src/__tests__/__snapshots__/math.test.ts.snap' }));
    expect(result).toMatchObject({ kind: 'runs', runs: [{ path: T1 }], truncated: false });
    const unknown = selectAffected(base({ changedFile: '/repo/elsewhere/__snapshots__/nope.test.ts.snap' }));
    expect(unknown).toMatchObject({ kind: 'none' });
    // Custom snapshotResolver: the inverse graph (Jest's own inverse map) links snap -> test.
    const custom = selectAffected(base({
      changedFile: '/repo/snaps/custom.snap',
      inverseStaticGraph: setMap([['/repo/snaps/custom.snap', [T2]]]),
    }));
    expect(custom).toMatchObject({ kind: 'runs', runs: [{ path: T2 }] });
  });
});

describe('selectAffected: test-file edits', () => {
  it('runs the single test plus previously failing tests of that file', () => {
    const result = selectAffected(base({
      changedFile: T1,
      analysis: { kind: 'singleTest', fullNames: ['add adds'], node: {} as never, ancestry: [] },
      failingTestsByFile: setMap([[T1, [key(T1, 'divide throws')]], [T2, [key(T2, 'unrelated')]]]),
    }));
    expect(result).toMatchObject({
      kind: 'runs',
      runs: [{ path: T1, names: ['add adds', 'divide throws'] }],
      truncated: false,
      sources: { self: 1, failingAdded: 1 },
    });
  });

  it('runs the whole file for structural/whole-file analyses or when none is given', () => {
    expect(selectAffected(base({ changedFile: T1 }))).toMatchObject({ kind: 'runs', runs: [{ path: T1 }] });
    expect(selectAffected(base({ changedFile: T1, analysis: { kind: 'structural', reason: 'treeChanged' } }))).toMatchObject({ runs: [{ path: T1 }] });
    const whole = selectAffected(base({ changedFile: T1, analysis: { kind: 'wholeFile', reason: 'multipleTests' }, failingTestsByFile: setMap([[T1, [key(T1, 'x')]]]) }));
    // A whole-file run already includes the failing tests; names stay undefined.
    expect(whole).toMatchObject({ kind: 'runs', runs: [{ path: T1 }], sources: { failingAdded: 0 } });
    if (whole.kind === 'runs') expect(whole.runs[0].names).toBeUndefined();
  });

  it('re-runs specs that load or import the edited test helper', () => {
    const result = selectAffected(base({
      changedFile: HELPER,
      loadedBy: setMap([[HELPER, [T1, HELPER]]]),
      inverseStaticGraph: setMap([[HELPER, [T2, '/repo/src/util.ts']], ['/repo/src/util.ts', [T3]]]),
      runtimeTrackedTestFiles: new Set([T1, T3]),
    }));
    expect(result).toMatchObject({
      kind: 'runs',
      runs: [{ path: HELPER }, { path: T1 }, { path: T2 }],
      sources: { self: 1, loadedBy: 1, staticGraph: 1 },
    });
  });
});

describe('selectAffected: source-file edits', () => {
  it('unions execBy (narrowed names), loadedBy (whole files) and the static closure, whole wins', () => {
    const result = selectAffected(base({
      execBy: setMap([[SRC, [key(T1, 'add adds'), key(T1, 'add negative'), key(T2, 'greet once')]]]),
      loadedBy: setMap([[SRC, [T2]]]),
      inverseStaticGraph: setMap([[SRC, ['/repo/src/greet.ts']], ['/repo/src/greet.ts', [T3, T1]]]),
      runtimeTrackedTestFiles: new Set([T1, T2]),
      failingTestsByFile: setMap([[T1, [key(T1, 'add failing')]], [T3, [key(T3, 'far')]]]),
    }));
    // Ordered by source priority (execBy before static graph), then path; T2 is whole because it loaded the file.
    expect(result).toMatchObject({
      kind: 'runs',
      runs: [
        { path: T2 },
        { path: T1, names: ['add adds', 'add failing', 'add negative'] },
        { path: T3 },
      ],
      truncated: false,
      sources: { execBy: 2, loadedBy: 1, staticGraph: 1, failingAdded: 1, narrowed: false },
    });
    if (result.kind === 'runs') {
      expect(result.runs[0].names).toBeUndefined();
      expect(result.reason).toBe('3 test files: 2 executed it, 1 loaded it, 1 import it');
    }
  });

  it('follows the inverse graph transitively with cycle protection', () => {
    const inverse = setMap([
      [SRC, ['/repo/src/a.ts']],
      ['/repo/src/a.ts', ['/repo/src/b.ts', T1]],
      ['/repo/src/b.ts', ['/repo/src/a.ts', SRC, T2]],   // cycle back to a and the start
      [T2, [T3]],                                        // test importing a test
    ]);
    expect(inverseClosure(inverse, SRC, new Set([T1, T2, T3]))).toEqual([T2, T3, T1].sort());
    const result = selectAffected(base({ inverseStaticGraph: inverse }));
    expect(result).toMatchObject({ kind: 'runs', runs: [{ path: T3 }, { path: T1 }, { path: T2 }].sort((a, b) => a.path.localeCompare(b.path)) });
  });

  it('skips runtime-tracked files in the static closure and honours the useStaticGraph / trackFileLoading switches', () => {
    const input = base({
      loadedBy: setMap([[SRC, [T1]]]),
      inverseStaticGraph: setMap([[SRC, [T2, T3]]]),
      runtimeTrackedTestFiles: new Set([T2]),
    });
    expect(selectAffected(input)).toMatchObject({ runs: [{ path: T1 }, { path: T3 }] });
    expect(selectAffected({ ...input, settings: { ...input.settings, useStaticGraph: false } })).toMatchObject({ runs: [{ path: T1 }] });
    expect(selectAffected({ ...input, settings: { ...input.settings, trackFileLoading: false } })).toMatchObject({ runs: [{ path: T3 }] });
  });

  it('returns discover when no data exists at all, none when a graph exists but nothing imports the file', () => {
    expect(selectAffected(base({ inverseStaticGraph: null }))).toMatchObject({ kind: 'discover' });
    expect(selectAffected(base({ inverseStaticGraph: new Map() }))).toMatchObject({ kind: 'none', reason: 'no tests cover math.ts' });
    expect(selectAffected(base({ inverseStaticGraph: null, loadedBy: setMap([['/repo/other.ts', [T1]]]) }))).toMatchObject({ kind: 'discover' });
  });

  it('still discovers an untracked source when other sources already have passing runtime data', () => {
    expect(selectAffected(base({
      inverseStaticGraph: null,
      loadedBy: new Map([['/repo/unrelated.ts', new Set(['/repo/other.test.ts'])]]),
    }))).toMatchObject({ kind: 'discover' });
  });

  it('caps the number of files per edit, deferring lower-priority files', () => {
    const many = Array.from({ length: 12 }, (_, i) => `/repo/src/__tests__/t${String(i).padStart(2, '0')}.test.ts`);
    const result = selectAffected(base({
      execBy: setMap([[SRC, [key(many[11], 'x')]]]),
      loadedBy: setMap([[SRC, many.slice(0, 4)]]),
      inverseStaticGraph: setMap([[SRC, many.slice(4, 11)]]),
      testFiles: new Set(many),
      settings: { maxTestFilesPerEdit: 5, alwaysRunFailing: true, useStaticGraph: true, trackFileLoading: true },
    }));
    expect(result.kind).toBe('runs');
    if (result.kind !== 'runs') return;
    expect(result.truncated).toBe(true);
    expect(result.runs.map(r => r.path)).toEqual([many[11], ...many.slice(0, 4)]);   // execBy first, then loadedBy
    expect(result.runs[0].names).toEqual(['x']);
    expect(result.deferred.map(r => r.path)).toEqual(many.slice(4, 11));
    expect(result.reason).toContain('7 deferred by cap 5');
    expect(selectAffected(base({ loadedBy: setMap([[SRC, many]]), testFiles: new Set(many), settings: { ...base().settings, maxTestFilesPerEdit: 0 } }))).toMatchObject({ truncated: false });
  });
});

describe('narrowByFunctions', () => {
  // Old text layout (1-based): fn A lines 1-5, fn B lines 7-12 containing inner arrow C lines 9-10, module scope 14.
  const coverage: AffectedCoverage = {
    meta: {
      stmtStartLine: [2, 3, 8, 9, 11, 14],
      stmtEndLine: [2, 3, 8, 10, 11, 14],
      fnDeclLine: [1, 7, 9],
      fnEndLine: [5, 12, 10],
    },
    stmtHitBy: new Map([
      [0, new Set([key(T1, 'a1'), key(T1, 'a2')])],
      [1, new Set([key(T1, 'a1')])],
      [2, new Set([key(T2, 'b1')])],
      [3, new Set([key(T2, 'b1'), key(T2, 'c-only')])],
      [4, new Set([key(T2, 'b1')])],
      [5, new Set([key(T1, 'a1'), key(T2, 'b1')])],
    ]),
    oldLineCount: 15,
  };
  const all = new Set([key(T1, 'a1'), key(T1, 'a2'), key(T2, 'b1'), key(T2, 'c-only'), key(T3, 'never')]);

  it('narrows to tests that executed the innermost edited function', () => {
    // Edit old line 3 (inside A).
    const a = narrowByFunctions(all, [{ start: 2, end: 3, oldStart: 2, oldEnd: 3 }], coverage);
    expect(a).toEqual({ keys: new Set([key(T1, 'a1'), key(T1, 'a2')]), narrowed: true });
    // Edit old line 10 (inside C, nested in B): only C's statements count.
    const c = narrowByFunctions(all, [{ start: 9, end: 10, oldStart: 9, oldEnd: 10 }], coverage);
    expect(c).toEqual({ keys: new Set([key(T2, 'b1'), key(T2, 'c-only')]), narrowed: true });
    // Edit old line 11 (inside B, outside C).
    const b = narrowByFunctions(all, [{ start: 10, end: 11, oldStart: 10, oldEnd: 11 }], coverage);
    expect(b.keys).toEqual(new Set([key(T2, 'b1'), key(T2, 'c-only')]));
  });

  it('treats insertions by their neighbouring old lines', () => {
    // Insert after old line 2 (between lines 2 and 3, inside A).
    const r = narrowByFunctions(all, [{ start: 2, end: 4, oldStart: 2, oldEnd: 2 }], coverage);
    expect(r).toEqual({ keys: new Set([key(T1, 'a1'), key(T1, 'a2')]), narrowed: true });
  });

  it('does not narrow for module-scope edits, unknown extents, or metadata without function spans', () => {
    expect(narrowByFunctions(all, [{ start: 13, end: 14, oldStart: 13, oldEnd: 14 }], coverage)).toEqual({ keys: all, narrowed: false });
    expect(narrowByFunctions(all, null, coverage)).toEqual({ keys: all, narrowed: false });
    expect(narrowByFunctions(all, [], coverage)).toEqual({ keys: all, narrowed: false });
    const noSpans: AffectedCoverage = { ...coverage, meta: { ...coverage.meta, fnEndLine: undefined } };
    expect(narrowByFunctions(all, [{ start: 2, end: 3, oldStart: 2, oldEnd: 3 }], noSpans)).toEqual({ keys: all, narrowed: false });
    expect(narrowByFunctions(all, [{ start: 2, end: 3, oldStart: 2, oldEnd: 3 }], null)).toEqual({ keys: all, narrowed: false });
  });

  it('is wired into selectAffected and reported in sources.narrowed', () => {
    const result = selectAffected(base({
      changedLines: [{ start: 2, end: 3, oldStart: 2, oldEnd: 3 }],
      execBy: new Map([[SRC, all]]),
      coverage,
    }));
    expect(result).toMatchObject({
      kind: 'runs',
      runs: [{ path: T1, names: ['a1', 'a2'] }],
      sources: { execBy: 1, narrowed: true },
    });
    if (result.kind === 'runs') expect(result.reason).toContain('narrowed');
  });
});
