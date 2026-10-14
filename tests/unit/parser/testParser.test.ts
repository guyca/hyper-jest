import * as fs from 'fs';
import * as path from 'path';
import { parseTestFile, pluginSetsFor, sha1 } from '../../../src/core/testParser';
import type { ParsedNode } from '../../../src/core/testModel';

const FIXTURES = path.resolve(__dirname, '../../fixtures/sample-project/src/__tests__');

/** Compact tree rendering for readable assertions: `kind "title" [titleKind] mode (each) (#dup) Lstart-end`. */
function render(nodes: ParsedNode[], depth = 0): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    const flags = [n.each ? 'each' : '', n.concurrent ? 'concurrent' : '', n.dupIndex ? `#${n.dupIndex}` : ''].filter(Boolean).join(' ');
    out.push(`${'  '.repeat(depth)}${n.kind} "${n.title}" [${n.titleKind}] ${n.mode}${flags ? ' ' + flags : ''} L${n.range.startLine}-${n.range.endLine}`);
    out.push(...render(n.children, depth + 1));
  }
  return out;
}

describe('parseTestFile: sample-project fixtures', () => {
  it('parses math.test.js into the expected tree (it.each, skip, todo)', () => {
    const file = path.join(FIXTURES, 'math.test.js');
    const parsed = parseTestFile(fs.readFileSync(file, 'utf8'), file);
    expect(parsed.parseError).toBeUndefined();
    expect(render(parsed.nodes)).toEqual([
      'describe "add" [static] default L2-10',
      '  test "adds two numbers" [static] default L3-5',
      '  test "adds negative numbers" [static] default L7-9',
      'describe "divide" [static] default L12-20',
      '  test "divides" [static] default L13-15',
      '  test "throws on zero" [static] default L17-19',
      'describe "classify" [static] default L22-39',
      '  test "classify(%i) -> %s" [static] default each L23-28',
      '  test "positive numbers (intentionally failing)" [static] default L30-32',
      '  test "skipped test" [static] skip L34-36',
      '  test "todo test" [static] todo L38-38',
    ]);
    expect(parsed.snapshotLines).toEqual([]);
    expect(parsed.functionCount).toBe(11);
    expect(parsed.hash).toBe(sha1(fs.readFileSync(file, 'utf8')));
  });

  it('parses greet.test.js with duplicate names (dupIndex) and the snapshot line', () => {
    const file = path.join(FIXTURES, 'greet.test.js');
    const parsed = parseTestFile(fs.readFileSync(file, 'utf8'), file);
    expect(render(parsed.nodes)).toEqual([
      'describe "greet" [static] default L2-17',
      '  test "greets once" [static] default L3-5',
      '  test "greets twice" [static] default L7-9',
      '  test "matches snapshot" [static] default L11-13',
      '  test "duplicate name" [static] default L15-15',
      '  test "duplicate name" [static] default #1 L16-16',
    ]);
    expect(parsed.snapshotLines).toEqual([12]);
    // nameRange points at the title argument (0-based line/column).
    const greet = parsed.nodes[0];
    expect(greet.nameRange).toEqual({ startLine: 2, startColumn: 9, endLine: 2, endColumn: 16 });
    expect(greet.children[0].nameRange.startLine).toBe(3);
  });
});

describe('parseTestFile: constructs', () => {
  const parse = (src: string, file = '/p/a.spec.ts') => parseTestFile(src, file);

  it('recognises every root and modifier form', () => {
    const parsed = parse(`
describe('d', () => {
  it('a', () => {});
  test('b', () => {});
  fit('c', () => {});
  xit('d', () => {});
  xtest('e', () => {});
  it.only('f', () => {});
  it.skip('g', () => {});
  test.todo('h');
  test.failing('i', () => {});
  test.concurrent('j', async () => {});
  test.concurrent.only('k', async () => {});
  test.only.failing('l', () => {});
  test.skip.failing('m', () => {});
});
fdescribe('fd', () => {});
xdescribe('xd', () => {});
describe.only('do', () => {});
describe.skip('ds', () => {});
`);
    expect(render(parsed.nodes)).toEqual([
      'describe "d" [static] default L1-15',
      '  test "a" [static] default L2-2',
      '  test "b" [static] default L3-3',
      '  test "c" [static] only L4-4',
      '  test "d" [static] skip L5-5',
      '  test "e" [static] skip L6-6',
      '  test "f" [static] only L7-7',
      '  test "g" [static] skip L8-8',
      '  test "h" [static] todo L9-9',
      '  test "i" [static] failing L10-10',
      '  test "j" [static] default concurrent L11-11',
      '  test "k" [static] only concurrent L12-12',
      '  test "l" [static] only L13-13',
      '  test "m" [static] skip L14-14',
      'describe "fd" [static] only L16-16',
      'describe "xd" [static] skip L17-17',
      'describe "do" [static] only L18-18',
      'describe "ds" [static] skip L19-19',
    ]);
  });

  it('handles both .each shapes, nested describe.each, and ignores un-applied .each tables', () => {
    const parsed = parse(`
test.each([[1, 2]])('adds %i + %i', (a, b) => {});
test.concurrent.only.each([[1]])('row %s', () => {});
describe.each\`
  a | b
  \${1} | \${2}
\`('suite $a', () => {
  it('inner', () => {});
});
it.each([[1]])(\`template \${x}\`, () => {});
it.each([1]);
const table = it.each([[1]]);
`);
    expect(render(parsed.nodes)).toEqual([
      'test "adds %i + %i" [static] default each L1-1',
      'test "row %s" [static] only each concurrent L2-2',
      'describe "suite $a" [static] default each L3-8',
      '  test "inner" [static] default L7-7',
      'test "template ${x}" [template] default each L9-9',
    ]);
  });

  it('accepts member, sequence, TS-wrapped and aliased callees and rejects non-Jest chains', () => {
    const parsed = parse(`
import { it as spec, describe as suite, test as check } from '@jest/globals';
import { it as other } from 'vitest';
suite('aliased', () => { spec('inner', () => {}); check.skip('skipped', () => {}); });
(0, _globals.it)('seq', () => {});
it!('bang', () => {});
(it as any)('cast', () => {});
globals.test.skip('ns skip', () => {});
foo.bar.it('deep namespace', () => {});
other('vitest alias', () => {});
it.each.only([[1]])('bad order', () => {});
describe.todo('no describe todo', () => {});
`);
    expect(render(parsed.nodes)).toEqual([
      'describe "aliased" [static] default L3-3',
      '  test "inner" [static] default L3-3',
      '  test "skipped" [static] skip L3-3',
      'test "seq" [static] default L4-4',
      'test "bang" [static] default L5-5',
      'test "cast" [static] default L6-6',
      'test "ns skip" [static] skip L7-7',
    ]);
  });

  it('classifies titles: static folding, template placeholders, dynamic identifiers/expressions', () => {
    const parsed = parse(`
it('a' + 'b' + 1, () => {});
it(\`no expr\`, () => {});
it(\`renders \${name} twice\`, () => {});
it(name, () => {});
it(obj.prop, () => {});
it(123, () => {});
it(\`a \${fn(1, {x: 2})} b\`, () => {});
it(   someCall(   1,
   2), () => {});
`);
    expect(parsed.nodes.map(n => [n.title, n.titleKind])).toEqual([
      ['ab1', 'static'],
      ['no expr', 'static'],
      ['renders ${name} twice', 'template'],
      ['name', 'dynamic'],
      ['obj.prop', 'dynamic'],
      ['123', 'static'],
      ['a ${fn(1, {x: 2})} b', 'template'],
      ['someCall( 1, 2)', 'dynamic'],
    ]);
  });

  it('skips calls without a title argument', () => {
    const parsed = parse(`it(); describe(); it('ok', () => {});`);
    expect(parsed.nodes.map(n => n.title)).toEqual(['ok']);
  });

  it('assigns dupIndex per sibling group (kind + title) in source order', () => {
    const parsed = parse(`
describe('dup', () => {
  it('d', () => {});
  it('d', () => {});
  it('e', () => {});
  it('d', () => {});
  describe('d', () => {});
});
describe('dup', () => {});
`);
    const [dup, dup2] = parsed.nodes;
    expect(dup.children.map(c => `${c.kind}:${c.title}#${c.dupIndex}`)).toEqual(['test:d#0', 'test:d#1', 'test:e#0', 'test:d#2', 'describe:d#0']);
    expect(dup2.dupIndex).toBe(1);
  });

  it('nests tests found inside loops and helper callbacks under the enclosing describe', () => {
    const parsed = parse(`
describe('loop', () => {
  [1, 2].forEach(n => {
    it(\`n is \${n}\`, () => {});
    it('same title', () => {});
  });
});
`);
    expect(render(parsed.nodes)).toEqual([
      'describe "loop" [static] default L1-6',
      '  test "n is ${n}" [template] default L3-3',
      '  test "same title" [static] default L4-4',
    ]);
  });

  it('recognises @jest-decorated classes and methods', () => {
    const parsed = parse(`
@Describe()
class UseProfile {
  @BeforeEach() setup() {}
  @Test() loadsProfile() {}
  @It('named test') other() {}
  @Test.skip() skipped() {}
}
@Describe('custom suite')
export class Other { @Test() 'string key'() {} }
`);
    expect(render(parsed.nodes)).toEqual([
      'describe "UseProfile" [static] default L1-7',
      '  test "loadsProfile" [static] default L4-4',
      '  test "named test" [static] default L5-5',
      '  test "skipped" [static] skip L6-6',
      'describe "custom suite" [static] default L8-9',
      '  test "string key" [static] default L9-9',
    ]);
  });

  it('records snapshot matcher lines (0-based, on the matcher line) and counts functions', () => {
    const parsed = parse(`
it('s', () => {
  expect(a).toMatchSnapshot();
  expect(b)
    .toMatchInlineSnapshot(\`x\`);
  expect(() => f()).toThrowErrorMatchingSnapshot();
  expect(() => g()).toThrowErrorMatchingInlineSnapshot();
  expect(c).toMatchSnapshot(); expect(d).toMatchSnapshot();
});
function decl() {}
const arrow = () => {};
const obj = { method() {}, prop: function () {} };
class K { m() {} }
`);
    expect(parsed.snapshotLines).toEqual([2, 4, 5, 6, 7]);
    // it callback, 2 matcher arrows, decl, arrow, method, prop fn, class method = 8
    expect(parsed.functionCount).toBe(8);
  });
});

describe('parseTestFile: languages and recovery', () => {
  it('chooses plugin sets by extension', () => {
    expect(pluginSetsFor('/a/b.ts', '')[0]).toEqual(['typescript', 'decorators-legacy']);
    expect(pluginSetsFor('/a/b.tsx', '')[0]).toEqual(['typescript', 'jsx', 'decorators-legacy']);
    expect(pluginSetsFor('/a/b.js', '')[0]).toEqual(['jsx', 'decorators-legacy']);
    // Babel 8 removed decorator plugin options; fallback must use the bare plugin name.
    const jsWithAt = pluginSetsFor('/a/b.js', '@x');
    expect(jsWithAt).toContainEqual(['jsx', 'decorators']);
    expect(JSON.stringify(jsWithAt)).not.toContain('decoratorsBeforeExport');
  });

  it('parses modern and legacy decorators without decoratorsBeforeExport (Babel 8)', () => {
    const modernBeforeExport = parseTestFile(`
function Dec() { return () => {}; }
@Dec()
export class Suite {
  @Test()
  'modern'() {}
}
`, '/x/modern-dec.test.ts');
    expect(modernBeforeExport.parseError).toBeUndefined();

    const modernAfterExport = parseTestFile(`
function Dec() { return () => {}; }
export
@Dec()
class Suite {
  @Test()
  'after-export'() {}
}
`, '/x/modern-dec-after.test.ts');
    expect(modernAfterExport.parseError).toBeUndefined();

    const legacy = parseTestFile(`
function Dec(target) {}
@Dec
class LegacySuite {
  @Test()
  'legacy'() {}
}
`, '/x/legacy-dec.test.ts');
    expect(legacy.parseError).toBeUndefined();
  });

  it('constant-folds BigInt titles and ignores import() callees (Babel 8 AST)', () => {
    const parsed = parseTestFile(`it(1n, () => {});\nimport('x').then(() => {});\nit('ok', () => {});`, '/x/bigint.test.ts');
    expect(parsed.parseError).toBeUndefined();
    expect(parsed.nodes.map(n => n.title)).toEqual(['1', 'ok']);
  });

  it('parses TSX, JSX in .js, Flow in .js, and JSX in a .ts file via fallback', () => {
    expect(parseTestFile(`it('j', () => { const el = <div>{x}</div>; });`, '/x/a.test.tsx').nodes.map(n => n.title)).toEqual(['j']);
    expect(parseTestFile(`it('j', () => { const el = <div>{x}</div>; });`, '/x/a.test.js').nodes.map(n => n.title)).toEqual(['j']);
    const flow = parseTestFile(`// @flow\nfunction f(x: number): string { return ''; }\nit('fl', () => {});`, '/x/a.test.js');
    expect(flow.parseError).toBeUndefined();
    expect(flow.nodes.map(n => n.title)).toEqual(['fl']);
    const tsWithJsx = parseTestFile(`it('j', () => { const el = <div>{x}</div>; });`, '/x/a.test.ts');
    expect(tsWithJsx.parseError).toBeUndefined();
    expect(tsWithJsx.nodes.map(n => n.title)).toEqual(['j']);
  });

  it('parses TypeScript-specific syntax (generics, casts, decorators, enums, satisfies)', () => {
    const parsed = parseTestFile(`
enum E { A }
const x = <T,>(v: T) => v satisfies unknown;
type Fn = (a: number) => void;
describe('ts', () => {
  it('generic', async <T>() => { const y = x<number>(1) as unknown as T; });
});
`, '/x/a.test.ts');
    expect(parsed.parseError).toBeUndefined();
    expect(parsed.nodes[0].children[0].title).toBe('generic');
  });

  it('keeps the tree for recoverable errors and reports the first one (0-based)', () => {
    const parsed = parseTestFile(`it('a', () => {\n  const x = 1\n  let x = 2\n});\nit('b', () => {});`, '/x/c.test.ts');
    expect(parsed.nodes.map(n => n.title)).toEqual(['a', 'b']);
    expect(parsed.parseError).toEqual({ message: "Identifier 'x' has already been declared.", line: 2, column: 6 });
  });

  it('returns an empty tree plus parseError for unrecoverable syntax errors', () => {
    const parsed = parseTestFile(`describe('a', () => {\n  it('b', () => {\n`, '/x/b.test.ts');
    expect(parsed.nodes).toEqual([]);
    expect(parsed.parseError).toMatchObject({ message: 'Unexpected token', line: 2, column: 0 });
    expect(parsed.hash).toHaveLength(40);
  });

  it('never throws on garbage input', () => {
    expect(() => parseTestFile('\u0000￿ )))) {{{{ <<<', '/x/g.test.js')).not.toThrow();
    expect(() => parseTestFile('', '/x/empty.test.js')).not.toThrow();
    expect(parseTestFile('', '/x/empty.test.js')).toMatchObject({ nodes: [], snapshotLines: [], functionCount: 0 });
  });

  it('accepts top-level await/return and script-mode code', () => {
    const parsed = parseTestFile(`const m = await import('x');\nif (!m) return;\nit('ok', () => {});`, '/x/s.test.js');
    expect(parsed.parseError).toBeUndefined();
    expect(parsed.nodes.map(n => n.title)).toEqual(['ok']);
  });
});
