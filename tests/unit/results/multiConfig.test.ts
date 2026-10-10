import { ResultStore } from '../../../src/results/resultStore';
import { makeTestKey } from '../../../src/core/protocol';
import { applyFullRun, PROJECT, SPEC, SRC, T, key, fileStart, testResult, testCoverage, coverageMeta, fileResult, runComplete } from './fixtures';

it('keeps the same file and test independent across configurations, including reruns and removal', () => {
  const store = new ResultStore();
  applyFullRun(store, 'unit');
  const other = 'other';
  store.registerRun('other-run', [{ projectId: other, path: SPEC }]);
  store.apply(fileStart('other-run'), other);
  store.apply(testResult('other-run', T.positive, 'passed', { line: 31 }), other);
  store.apply(fileResult('other-run', 'passed'), other);
  store.apply(runComplete('other-run'), other);
  expect(store.test(key(T.positive))?.status).toBe('failed');
  expect(store.test(makeTestKey(SPEC, T.positive, 0, other))?.status).toBe('passed');
  expect(store.fileRecord(SPEC, PROJECT)?.status).toBe('failed');
  expect(store.fileRecord(SPEC, other)?.status).toBe('passed');
  expect(store.failingTests().map(t => t.projectId)).toEqual([PROJECT]);
  expect(store.forProject(other).sourceSelection(SRC, '').tests.size).toBe(0);
  store.clearProject(other);
  expect(store.test(key(T.positive))?.status).toBe('failed');
  expect(store.coverageFor(SRC)?.stmtHitBy.get(8)).toContain(key(T.positive));
  expect(store.allFiles().every(f => f.projectId === PROJECT)).toBe(true);
  store.dispose();
});

it('projects coverage by source coordinates when configs assign different statement IDs', () => {
  let now = 0;
  const store = new ResultStore({ now: () => ++now });
  const meta = { ...coverageMeta(), hash: 'same-source', revision: 'same-revision', sourceText: 'a();\nb();\n', originalCoordinates: true, stmtStartColumn: [0, 0], stmtEndColumn: [4, 4], fnDeclLine: [], branchArms: [] };
  for (const [id, lines] of [['one', [1, 2]], ['two', [2, 1]]] as const) {
    store.apply(fileStart(id), id);
    store.apply({ ...meta, stmtStartLine: [...lines], stmtEndLine: [...lines] }, id);
    const hit = testCoverage(id, T.addTwo, [0]);
    store.apply({ ...hit, files: hit.files.map(f => ({ ...f, revision: meta.revision })) }, id);
    store.apply(testResult(id, T.addTwo, 'passed'), id);
    store.apply(fileResult(id, 'passed'), id);
    store.apply(runComplete(id), id);
  }
  const coverage = store.coverageFor(SRC)!;
  expect(coverage.meta!.stmtStartLine).toEqual([2, 1]);
  expect(coverage.stmtHitBy.get(0)).toEqual(new Set([makeTestKey(SPEC, T.addTwo, 0, 'two')]));
  expect(coverage.stmtHitBy.get(1)).toEqual(new Set([makeTestKey(SPEC, T.addTwo, 0, 'one')]));
  store.dispose();
});
