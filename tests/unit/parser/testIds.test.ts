import { makeTestKey, fullNameOf } from '../../../src/core/protocol';
import { parsedNodeId } from '../../../src/core/testModel';
import { parseTestFile } from '../../../src/core/testParser';
import {
  fileIdOf, findNodeAtLine, findTestAtLine, fullNameOfNode, hasStaticFullName, nodeIdOf, reconcile, testFullNames,
  titleMatches, titlePattern, unreportedNodes, walkTests, type RuntimeTestLike,
} from '../../../src/core/testIds';

const IDS = { projectId: 'proj', relPath: 'src/a.spec.ts' };
const FILE = '/repo/src/a.spec.ts';

/** Build runtime results in definition order; testKey dupIndex counts duplicates like the worker does. */
function results(specs: Array<[string[], string, number | null]>): RuntimeTestLike[] {
  const seen = new Map<string, number>();
  return specs.map(([ancestorTitles, title, line]) => {
    const fullName = fullNameOf(ancestorTitles, title);
    const dup = seen.get(fullName) ?? 0;
    seen.set(fullName, dup + 1);
    return { fullName, ancestorTitles, title, location: line === null ? null : { line, column: 3 }, testKey: makeTestKey(FILE, fullName, dup) };
  });
}

const parse = (src: string) => parseTestFile(src, FILE);

/** Readable view of a reconciliation: `kind nodeSegments` per result in order. */
function view(map: ReturnType<typeof reconcile>, rs: RuntimeTestLike[]): string[] {
  return rs.map(r => {
    const m = map.get(r.testKey)!;
    const segs = m.nodeId.slice(fileIdOf(IDS).length + 1).split('\0').join(' / ');
    return `${m.kind} ${segs}${m.rowLabel ? ` (label "${m.rowLabel}")` : ''}${m.extraAncestors.length ? ` extra=${JSON.stringify(m.extraAncestors)}` : ''}`;
  });
}

describe('reconcile: structural matching', () => {
  const parsed = parse(`
describe('greet', () => {
  it('greets once', () => {});
  it('duplicate name', () => {});
  it('duplicate name', () => {});
});
it('top level', () => {});
`);

  it('maps exact chains and duplicate ordinals to the k-th static node', () => {
    const rs = results([
      [['greet'], 'greets once', 3],
      [['greet'], 'duplicate name', 4],
      [['greet'], 'duplicate name', 5],
      [[], 'top level', 7],
    ]);
    const map = reconcile(parsed, rs, IDS);
    expect(view(map, rs)).toEqual([
      'exact describe:greet / test:greets once',
      'dupOrdinal describe:greet / test:duplicate name',
      'dupOrdinal describe:greet / test:duplicate name#1',
      'exact test:top level',
    ]);
    const first = map.get(rs[1].testKey)!;
    const second = map.get(rs[2].testKey)!;
    expect(first.node).toBe(parsed.nodes[0].children[1]);
    expect(second.node).toBe(parsed.nodes[0].children[2]);
    expect(second.nodeId).toBe(parsedNodeId(IDS.projectId, IDS.relPath, [parsed.nodes[0]], parsed.nodes[0].children[2]));
    expect(second.parentId).toBe(nodeIdOf(IDS, [], parsed.nodes[0]));
    expect(second.ancestry).toEqual([parsed.nodes[0]]);
  });

  it('does not depend on location for exact matches', () => {
    const rs = results([[['greet'], 'greets once', null]]);
    expect(view(reconcile(parsed, rs, IDS), rs)).toEqual(['exact describe:greet / test:greets once']);
  });

  it('turns a third runtime duplicate into a runtime-only item with a non-colliding id', () => {
    const rs = results([
      [['greet'], 'duplicate name', 4],
      [['greet'], 'duplicate name', 5],
      [['greet'], 'duplicate name', 99],
    ]);
    const map = reconcile(parsed, rs, IDS);
    expect(view(map, rs)[2]).toBe('runtimeOnly describe:greet / test:duplicate name#2');
    expect(map.get(rs[2].testKey)!.parentId).toBe(nodeIdOf(IDS, [], parsed.nodes[0]));
  });
});

describe('reconcile: .each, loops, templates', () => {
  it('expands it.each rows as children of the static node', () => {
    const parsed = parse(`
describe('classify', () => {
  it.each([[-5, 'negative'], [0, 'zero']])('classify(%i) -> %s', () => {});
  it('positive', () => {});
});
`);
    const rs = results([
      [['classify'], 'classify(-5) -> negative', 3],
      [['classify'], 'classify(0) -> zero', 3],
      [['classify'], 'positive', 4],
    ]);
    const map = reconcile(parsed, rs, IDS);
    expect(view(map, rs)).toEqual([
      'eachRow describe:classify / test:classify(%i) -> %s / row:classify(-5) -> negative (label "classify(-5) -> negative")',
      'eachRow describe:classify / test:classify(%i) -> %s / row:classify(0) -> zero (label "classify(0) -> zero")',
      'exact describe:classify / test:positive',
    ]);
    const row = map.get(rs[0].testKey)!;
    expect(row.node).toBe(parsed.nodes[0].children[0]);
    expect(row.parentId).toBe(nodeIdOf(IDS, [parsed.nodes[0]], parsed.nodes[0].children[0]));
    expect(unreportedNodes(parsed, rs, IDS)).toEqual([]);
  });

  it('handles tagged-template each with $var titles and %% literals', () => {
    const parsed = parse('test.each`\n a | b\n ${1} | ${2}\n`(\'$a + $b = 100%%\', () => {});');
    const rs = results([[[], '1 + 2 = 100%', 1]]);
    expect(view(reconcile(parsed, rs, IDS), rs)).toEqual(['eachRow test:$a + $b = 100%% / row:1 + 2 = 100% (label "1 + 2 = 100%")']);
  });

  it('qualifies describe.each rows with the runtime suite title', () => {
    const parsed = parse(`
describe.each([[1], [2]])('suite %s', () => {
  it('inner', () => {});
  it('other', () => {});
});
`);
    const rs = results([
      [['suite 1'], 'inner', 3],
      [['suite 1'], 'other', 4],
      [['suite 2'], 'inner', 3],
      [['suite 2'], 'other', 4],
    ]);
    expect(view(reconcile(parsed, rs, IDS), rs)).toEqual([
      'eachRow describe:suite %s / test:inner / row:suite 1 inner (label "suite 1 inner")',
      'eachRow describe:suite %s / test:other / row:suite 1 other (label "suite 1 other")',
      'eachRow describe:suite %s / test:inner / row:suite 2 inner (label "suite 2 inner")',
      'eachRow describe:suite %s / test:other / row:suite 2 other (label "suite 2 other")',
    ]);
  });

  it('maps forEach-generated tests: first result direct, further results as rows (ids stay stable)', () => {
    const parsed = parse(`
describe('loop', () => {
  ['a', 'b', 'c'].forEach(n => {
    it(\`handles \${n}\`, () => {});
    it('same title', () => {});
  });
});
`);
    const rs = results([
      [['loop'], 'handles a', 4], [['loop'], 'same title', 5],
      [['loop'], 'handles b', 4], [['loop'], 'same title', 5],
      [['loop'], 'handles c', 4], [['loop'], 'same title', 5],
    ]);
    expect(view(reconcile(parsed, rs, IDS), rs)).toEqual([
      'exact describe:loop / test:handles ${n}',
      'exact describe:loop / test:same title',
      'eachRow describe:loop / test:handles ${n} / row:handles b (label "handles b")',
      'eachRow describe:loop / test:same title / row:same title (label "same title")',
      'eachRow describe:loop / test:handles ${n} / row:handles c (label "handles c")',
      'eachRow describe:loop / test:same title / row:same title#1 (label "same title")',
    ]);
  });

  it('matches template describe titles by pattern and keeps static children direct', () => {
    const parsed = parse('describe(`${name} suite`, () => { it(\'works\', () => {}); });');
    const rs = results([[['Foo suite'], 'works', 1]]);
    expect(view(reconcile(parsed, rs, IDS), rs)).toEqual(['exact describe:${name} suite / test:works']);
  });

  it('matches dynamic (identifier) titles loosely', () => {
    const parsed = parse('describe(MyClass, () => { it(title, () => {}); });');
    const rs = results([[['MyClass'], 'anything goes', 1]]);
    expect(view(reconcile(parsed, rs, IDS), rs)).toEqual(['exact describe:MyClass / test:title']);
  });
});

describe('reconcile: location hints and runtime-only items', () => {
  it('uses the location hint only when the title is compatible', () => {
    // Helper-registered tests: the runtime ancestry does not match the static tree, but the line does.
    const parsed = parse(`
describe('outer', () => {
  it('registered elsewhere', () => {});
  it('fixed', () => {});
});
`);
    const rs = results([
      [['outer', 'helper'], 'registered elsewhere', 3],
      [['outer', 'helper'], 'fixed', 2],             // line points at a different title → not a hint
    ]);
    const map = reconcile(parsed, rs, IDS);
    expect(view(map, rs)).toEqual([
      'locationHint describe:outer / test:registered elsewhere',
      'runtimeOnly describe:outer / describe:helper / test:fixed extra=["helper"]',
    ]);
    const ro = map.get(rs[1].testKey)!;
    expect(ro.node).toBeNull();
    expect(ro.parentId).toBe(nodeIdOf(IDS, [], parsed.nodes[0]));
    expect(ro.ancestry).toEqual([parsed.nodes[0]]);
  });

  it('accepts a hint on any line between the call start and the title argument (multi-line .each tables)', () => {
    const parsed = parse(`
it.each([
  [1],
  [2],
])('n %i', () => {});
`);
    const rs = results([[['other'], 'n 1', 4], [['other'], 'n 2', 4]]);
    expect(view(reconcile(parsed, rs, IDS), rs)).toEqual([
      'eachRow test:n %i / row:n 1 (label "n 1")',
      'eachRow test:n %i / row:n 2 (label "n 2")',
    ]);
  });

  it('parents unmatched results under the file when no describe matches', () => {
    const parsed = parse(`it('a', () => {});`);
    const rs = results([[['dyn'], 'x', null], [['dyn'], 'x', null], [[], 'b', null]]);
    const map = reconcile(parsed, rs, IDS);
    expect(view(map, rs)).toEqual([
      'runtimeOnly describe:dyn / test:x extra=["dyn"]',
      'runtimeOnly describe:dyn / test:x#1 extra=["dyn"]',
      'runtimeOnly test:b',
    ]);
    expect(map.get(rs[2].testKey)!.parentId).toBe(fileIdOf(IDS));
  });

  it('offsets runtime-only ids past static siblings sharing the title', () => {
    const parsed = parse(`describe('d', () => { it('x', () => {}); });`);
    // Two static-looking results but only one static node: the second cannot be exact, is a row under the single candidate.
    const rs = results([[['d'], 'x', null], [['d'], 'x', null]]);
    expect(view(reconcile(parsed, rs, IDS), rs)).toEqual(['exact describe:d / test:x', 'eachRow describe:d / test:x / row:x (label "x")']);
  });

  it('reports static tests that never produced a result', () => {
    const parsed = parse(`
describe('d', () => {
  it('ran', () => {});
  if (process.env.X) it('conditional', () => {});
  it.each([[1]])('each %i', () => {});
});
`);
    const rs = results([[['d'], 'ran', 3]]);
    const un = unreportedNodes(parsed, rs, IDS);
    expect(un.map(u => u.node.title)).toEqual(['conditional', 'each %i']);
    expect(un[0].nodeId).toBe(nodeIdOf(IDS, [parsed.nodes[0]], parsed.nodes[0].children[1]));
  });
});

describe('tree helpers', () => {
  const parsed = parse(`
describe('a', () => {
  it('t1', () => {
    expect(1).toBe(1);
  });
  describe('b', () => {
    it.each([[1]])('e %i', () => {});
  });
});
it(\`dyn \${x}\`, () => {});
`);

  it('findNodeAtLine / findTestAtLine return the innermost node and its ancestry', () => {
    expect(findNodeAtLine(parsed, 3)?.node.title).toBe('t1');
    expect(findNodeAtLine(parsed, 3)?.ancestry.map(a => a.title)).toEqual(['a']);
    expect(findNodeAtLine(parsed, 5)?.node.title).toBe('b');
    expect(findNodeAtLine(parsed, 0)).toBeNull();
    expect(findNodeAtLine(parsed, 50)).toBeNull();
    expect(findTestAtLine(parsed, 5)).toBeNull();           // describe line, not inside a test
    expect(findTestAtLine(parsed, 6)?.node.title).toBe('e %i');
    expect(findTestAtLine(parsed, 6)?.ancestry.map(a => a.title)).toEqual(['a', 'b']);
  });

  it('fullNameOfNode / hasStaticFullName / testFullNames', () => {
    const [a, dyn] = parsed.nodes;
    const t1 = a.children[0];
    const b = a.children[1];
    expect(fullNameOfNode([a], t1)).toBe('a t1');
    expect(hasStaticFullName([a], t1)).toBe(true);
    expect(hasStaticFullName([a, b], b.children[0])).toBe(false);
    expect(hasStaticFullName([], dyn)).toBe(false);
    expect(testFullNames([], a)).toEqual({ names: ['a t1', 'a b e %i'], exact: false });
    expect(testFullNames([a], t1)).toEqual({ names: ['a t1'], exact: true });
    expect(walkTests(parsed).map(e => e.node.title)).toEqual(['t1', 'e %i', 'dyn ${x}']);
  });

  it('titlePattern / titleMatches cover printf, $var, %$, %%, template and escaping', () => {
    const each = parse(`it.each([[1]])('a.b (%s) [%d] $x.y %# %$ 100%% $#', () => {});`).nodes[0];
    expect(titlePattern(each)!.source).toBe('^a\\.b \\((.*?)\\) \\[(.*?)\\] (.*?) (.*?) (.*?) 100% (.*?)$');
    expect(titleMatches(each, 'a.b (hello) [3] value 0 1 100% 0')).toBe(true);
    expect(titleMatches(each, 'a.b hello')).toBe(false);
    const tpl = parse('it(`x ${a + {b: 1}.b} y`, () => {});').nodes[0];
    expect(titleMatches(tpl, 'x 42 y')).toBe(true);
    expect(titleMatches(tpl, 'x y')).toBe(false);
    const plain = parse(`it('plain (title)', () => {});`).nodes[0];
    expect(titlePattern(plain)).toBeNull();
    expect(titleMatches(plain, 'plain (title)')).toBe(true);
    expect(titleMatches(plain, 'plain')).toBe(false);
  });
});
