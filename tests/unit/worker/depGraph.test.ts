import { buildDepGraph, toGraphResult, updateDepGraph, type GraphContextEntry } from '../../../src/worker/depGraph';
import type { JestChain } from '../../../src/worker/jestChain';

function busyWait(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

/** Fake chain + context: `n` files, each importing the next one; resolution costs `costMs` of CPU. */
function fixture(n: number, costMs: number, onResolve: (file: string) => void = () => {}) {
  const files = Array.from({ length: n }, (_, i) => `/p/src/f${i}${i % 10 === 0 ? '.test' : ''}.js`);
  const context = {
    hasteFS: {
      getAllFiles: () => [...files, '/p/README.md'],
      getDependencies: (f: string) => (files.indexOf(f) + 1 < n ? ['./next'] : []),
      exists: (f: string) => files.includes(f),
    },
    resolver: { isCoreModule: () => false },
  };
  const chain = {
    modules: {
      snapshot: { buildSnapshotResolver: async () => ({}) },
      resolveDeps: {
        DependencyResolver: class {
          resolve(f: string): string[] {
            onResolve(f);
            busyWait(costMs);
            const i = files.indexOf(f);
            return i + 1 < n ? [files[i + 1]] : [];
          }
        },
      },
      core: { SearchSource: class { isTestFilePath(p: string) { return p.includes('.test.'); } } },
    },
  } as unknown as JestChain;
  const entries: GraphContextEntry[] = [{ cfg: { moduleFileExtensions: ['js'] }, context }];
  return { files, chain, entries };
}

describe('depGraph', () => {
  it('builds forward edges and test files, skipping foreign extensions', async () => {
    const { files, chain, entries } = fixture(12, 0);
    const graph = await buildDepGraph(entries, chain);
    expect(graph.forward.size).toBe(12);
    expect(graph.forward.get(files[0])).toEqual([files[1]]);
    expect(graph.forward.has('/p/README.md')).toBe(false);
    expect([...graph.testFiles].sort()).toEqual([files[0], files[10]].sort());
    expect(toGraphResult(graph)).toMatchObject({ unresolved: 0, testFiles: expect.arrayContaining([files[0]]) });
  });

  it('yields to the event loop while resolving so IPC (cancel, ping) is handled', async () => {
    let tick = false;
    let resolvedAfterTick = 0;
    const { chain, entries } = fixture(40, 3, () => { if (tick) resolvedAfterTick++; });
    setImmediate(() => { tick = true; });
    const graph = await buildDepGraph(entries, chain);
    expect(graph.forward.size).toBe(40);
    // Without yields every file would be resolved before the setImmediate callback ran.
    expect(resolvedAfterTick).toBeGreaterThan(0);
  });

  it('updateDepGraph re-resolves given paths, drops unknown ones and yields too', async () => {
    let tick = false;
    let resolvedAfterTick = 0;
    const { files, chain, entries } = fixture(40, 3, () => { if (tick) resolvedAfterTick++; });
    const graph = await buildDepGraph(entries, chain);
    graph.forward.set('/p/src/gone.js', []);
    graph.testFiles.add('/p/src/gone.js');
    tick = false;
    resolvedAfterTick = 0;
    setImmediate(() => { tick = true; });
    await updateDepGraph(graph, entries, chain, [...files, '/p/src/gone.js']);
    expect(graph.forward.has('/p/src/gone.js')).toBe(false);
    expect(graph.testFiles.has('/p/src/gone.js')).toBe(false);
    expect(resolvedAfterTick).toBeGreaterThan(0);
  });
});
