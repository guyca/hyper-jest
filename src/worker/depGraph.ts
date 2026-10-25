/**
 * Forward dependency graph built with the project's own Jest machinery: `hasteFS.getAllFiles()` for
 * the file list and `jest-resolve-dependencies` for edges (honours moduleNameMapper, custom
 * resolvers, haste platforms, NODE_PATH, adjacent `__mocks__`). The host keeps the inverse map.
 * Incremental: `updateDepGraph` re-resolves only the given paths after an `invalidate{files}`.
 * Resolution is synchronous per file, so the loops yield to the event loop every few milliseconds:
 * a big RN project has tens of thousands of files and `cancel`/`ping` must still be answered.
 * No static Jest imports.
 */
import * as path from 'path';
import type { GraphResultMsg } from '../core/protocol';
import type { JestChain } from './jestChain';

export interface DepGraph {
  /** file -> files it imports (as resolved by Jest). */
  forward: Map<string, string[]>;
  testFiles: Set<string>;
  /** Import specifiers Jest could not resolve (dropped edges), summed over files. */
  unresolved: number;
}

export interface GraphContextEntry {
  cfg: any;
  /** Jest TestContext: {config, hasteFS, moduleMap, resolver}. */
  context: any;
}

interface ResolverBundle {
  entry: GraphContextEntry;
  depResolver: any;
  isTestFile: (p: string) => boolean;
  isCoreModule: (name: string) => boolean;
}

const snapshotResolvers = new WeakMap<object, Promise<any>>();

async function bundleFor(entry: GraphContextEntry, chain: JestChain): Promise<ResolverBundle> {
  let snapP = snapshotResolvers.get(entry.cfg);
  if (!snapP) {
    snapP = chain.modules.snapshot.buildSnapshotResolver(entry.cfg);
    snapshotResolvers.set(entry.cfg, snapP);
  }
  const snapshotResolver = await snapP;
  const depResolver = new chain.modules.resolveDeps.DependencyResolver(entry.context.resolver, entry.context.hasteFS, snapshotResolver);
  const search = new chain.modules.core.SearchSource(entry.context);
  const resolver = entry.context.resolver;
  return {
    entry,
    depResolver,
    isTestFile: (p: string) => { try { return !!search.isTestFilePath(p); } catch { return false; } },
    isCoreModule: (name: string) => { try { return !!resolver.isCoreModule?.(name); } catch { return false; } },
  };
}

/** Longest stretch of synchronous resolution between two yields to the event loop. */
const YIELD_EVERY_MS = 15;

/** Returns a function that, when awaited per file, yields to the event loop once a slice is used up. */
function makeYielder(sliceMs = YIELD_EVERY_MS): () => Promise<void> | undefined {
  let sliceStart = Date.now();
  return () => {
    if (Date.now() - sliceStart < sliceMs) return undefined;
    return new Promise<void>(resolve => setImmediate(() => { sliceStart = Date.now(); resolve(); }));
  };
}

function extOf(file: string): string {
  const i = file.lastIndexOf('.');
  return i >= 0 ? file.slice(i + 1) : '';
}

function resolveFile(b: ResolverBundle, file: string): { deps: string[]; unresolved: number } {
  let raw: string[] = [];
  try { raw = b.entry.context.hasteFS.getDependencies(file) ?? []; } catch { raw = []; }
  let deps: string[] = [];
  try { deps = b.depResolver.resolve(file) ?? []; } catch { deps = []; }
  const unique = [...new Set(deps.map(String))];
  const nonCore = raw.filter(d => !b.isCoreModule(d)).length;
  // resolve() may add adjacent __mocks__ entries, so this is a floor estimate.
  const unresolved = Math.max(0, nonCore - unique.length);
  return { deps: unique, unresolved };
}

/** Builds the forward graph for every file under the configs' roots. */
export async function buildDepGraph(entries: GraphContextEntry[], chain: JestChain): Promise<DepGraph> {
  const graph: DepGraph = { forward: new Map(), testFiles: new Set(), unresolved: 0 };
  const maybeYield = makeYielder();
  for (const entry of entries) {
    const b = await bundleFor(entry, chain);
    const exts = new Set<string>((entry.cfg.moduleFileExtensions ?? []).map(String));
    for (const file of entry.context.hasteFS.getAllFiles() as string[]) {
      if (exts.size && !exts.has(extOf(file))) continue;
      const pause = maybeYield();
      if (pause) await pause;
      const { deps, unresolved } = resolveFile(b, file);
      graph.forward.set(file, deps);
      graph.unresolved += unresolved;
      if (b.isTestFile(file)) graph.testFiles.add(file);
    }
  }
  return graph;
}

/** Re-resolves `paths` against the (possibly rebuilt) contexts; removes files no hasteFS knows. */
export async function updateDepGraph(graph: DepGraph, entries: GraphContextEntry[], chain: JestChain, paths: string[]): Promise<DepGraph> {
  const bundles = await Promise.all(entries.map(e => bundleFor(e, chain)));
  const maybeYield = makeYielder();
  for (const p of paths) {
    const pause = maybeYield();
    if (pause) await pause;
    const b = bundles.find(x => { try { return !!x.entry.context.hasteFS.exists(p); } catch { return false; } });
    if (!b) {
      const known = graph.forward.delete(p);
      if (graph.testFiles.delete(p) || known) continue;
      // Not a known file: a deleted folder arrives as its own path, so drop everything under it.
      const prefix = p.endsWith(path.sep) ? p : p + path.sep;
      for (const key of [...graph.forward.keys()]) if (key.startsWith(prefix)) graph.forward.delete(key);
      for (const key of [...graph.testFiles]) if (key.startsWith(prefix)) graph.testFiles.delete(key);
      continue;
    }
    const { deps } = resolveFile(b, p);
    graph.forward.set(p, deps);
    if (b.isTestFile(p)) graph.testFiles.add(p); else graph.testFiles.delete(p);
  }
  return graph;
}

export function toGraphResult(graph: DepGraph): Omit<GraphResultMsg, 'v' | 'type'> {
  const forward: Record<string, string[]> = {};
  for (const [k, v] of graph.forward) forward[k] = v;
  return { forward, testFiles: [...graph.testFiles], unresolved: graph.unresolved };
}
