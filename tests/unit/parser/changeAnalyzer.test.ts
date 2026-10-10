import { analyzeChange, structureSignature } from '../../../src/core/changeAnalyzer';
import { parseTestFile } from '../../../src/core/testParser';
import { diffLines } from '../../../src/core/textDiff';

const FILE = '/repo/src/a.spec.ts';
const BASE = `
import { f } from './f';
describe('suite', () => {
  it('one', () => {
    const a = f(1);
    expect(a).toBe(1);
  });
  it('two', () => {
    expect(f(2)).toBe(2);
  });
  it.each([[1]])('each %i', () => {
    expect(1).toBe(1);
  });
});
`;

/** Analyse BASE -> edited text. */
function analyze(newText: string, oldText = BASE) {
  const oldParsed = parseTestFile(oldText, FILE);
  const newParsed = parseTestFile(newText, FILE);
  return analyzeChange(oldParsed, newParsed, diffLines(oldText, newText));
}

describe('analyzeChange', () => {
  it('selects a single test when the edit stays strictly inside one body', () => {
    const edited = BASE.replace('expect(a).toBe(1);', 'expect(a).toBe(2);');
    const result = analyze(edited);
    expect(result).toMatchObject({ kind: 'singleTest', fullNames: ['suite one'] });
    if (result.kind === 'singleTest') {
      expect(result.node.title).toBe('one');
      expect(result.ancestry.map(a => a.title)).toEqual(['suite']);
    }
  });

  it('accepts multi-line insertions and deletions inside one body', () => {
    const inserted = BASE.replace('    const a = f(1);\n', '    const a = f(1);\n    const b = 2;\n    const c = 3;\n');
    expect(analyze(inserted)).toMatchObject({ kind: 'singleTest', fullNames: ['suite one'] });
    const deleted = BASE.replace('    const a = f(1);\n', '');
    // Deleting `const a` changes nothing structural; `a` is still referenced but that is runtime business.
    expect(analyze(deleted)).toMatchObject({ kind: 'singleTest', fullNames: ['suite one'] });
    const deletedFirstBodyLine = BASE.replace("  it('two', () => {\n    expect(f(2)).toBe(2);\n", "  it('two', () => {\n");
    expect(analyze(deletedFirstBodyLine)).toMatchObject({ kind: 'singleTest', fullNames: ['suite two'] });
  });

  it('is wholeFile when edits touch two tests, the declaration line, or module scope', () => {
    const two = BASE.replace('expect(a).toBe(1);', 'expect(a).toBe(2);').replace('expect(f(2)).toBe(2);', 'expect(f(2)).toBe(3);');
    expect(analyze(two)).toEqual({ kind: 'wholeFile', reason: 'multipleTests' });
    const declLine = BASE.replace("it('one', () => {", "it('one', async () => {");
    expect(analyze(declLine)).toEqual({ kind: 'wholeFile', reason: 'outsideTestBody' });
    const moduleScope = BASE.replace("import { f } from './f';", "import { f } from './g';");
    expect(analyze(moduleScope)).toEqual({ kind: 'wholeFile', reason: 'outsideTestBody' });
    const describeScope = BASE.replace("describe('suite', () => {\n", "describe('suite', () => {\n  const shared = 1;\n");
    expect(analyze(describeScope)).toEqual({ kind: 'wholeFile', reason: 'outsideTestBody' });
  });

  it('is wholeFile for an edit inside an .each body (name not exact) and when the function count changes', () => {
    const each = BASE.replace('    expect(1).toBe(1);\n  });\n});', '    expect(2).toBe(2);\n  });\n});');
    expect(analyze(each)).toEqual({ kind: 'wholeFile', reason: 'dynamicName' });
    const fn = BASE.replace('expect(a).toBe(1);', 'expect(a).toBe(1); const g = () => 1;');
    expect(analyze(fn)).toEqual({ kind: 'wholeFile', reason: 'functionCountChanged' });
  });

  it('is structural when test names, counts or modes change', () => {
    expect(analyze(BASE.replace("it('two'", "it('deux'"))).toEqual({ kind: 'structural', reason: 'treeChanged' });
    expect(analyze(BASE.replace("it('two'", "it.skip('two'"))).toEqual({ kind: 'structural', reason: 'treeChanged' });
    expect(analyze(BASE.replace("  it('two', () => {\n    expect(f(2)).toBe(2);\n  });\n", ''))).toEqual({ kind: 'structural', reason: 'treeChanged' });
    expect(analyze(BASE + "\nit('three', () => {});\n")).toEqual({ kind: 'structural', reason: 'treeChanged' });
  });

  it('is wholeFile on parse errors and when nothing changed', () => {
    expect(analyze(BASE.replace('expect(a).toBe(1);', 'expect(a).toBe(1'))).toEqual({ kind: 'wholeFile', reason: 'parseError' });
    expect(analyze(BASE)).toEqual({ kind: 'wholeFile', reason: 'noLineChanges' });
  });

  it('structureSignature ignores body changes but not shape changes', () => {
    const a = parseTestFile(BASE, FILE);
    const b = parseTestFile(BASE.replace('expect(a).toBe(1);', 'expect(a).toBe(2);'), FILE);
    const c = parseTestFile(BASE.replace("it('two'", "it('two!'"), FILE);
    expect(structureSignature(a)).toBe(structureSignature(b));
    expect(structureSignature(a)).not.toBe(structureSignature(c));
  });
});
