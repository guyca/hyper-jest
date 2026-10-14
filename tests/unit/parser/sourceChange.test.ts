import { changedFunctions, statementProjection } from '../../../src/core/sourceChange';
import { metadata, SOURCE } from '../results/coverageRevisionFixtures';

describe('source function edits', () => {
  const text = 'function a(x) {\n  return x + 1;\n}\nfunction b(x) {\n  return x * 2;\n}\nmodule.exports = { a, b };\n';

  it('recognizes body edits, line insertions and deletions against original coordinates', () => {
    const meta = metadata(text);
    expect(meta.originalCoordinates).toBe(true);
    expect(changedFunctions(SOURCE, text.replace('x + 1', 'x + 2'), meta)).toEqual(new Set([0]));
    expect(changedFunctions(SOURCE, text.replace('  return x + 1;', '  x++;\n  return x + 1;'), meta)).toEqual(new Set([0]));
    expect(changedFunctions(SOURCE, text.replace('  return x + 1;\n', ''), meta)).toEqual(new Set([0]));
    expect(changedFunctions(SOURCE, text, meta)).toEqual(new Set());
  });

  it('preserves BigInt constants and defaults while selecting function body edits', () => {
    const original = 'const limit = 1n;\nfunction a(x = 2n) {\n  return x + limit;\n}\n';
    const meta = metadata(original);
    expect(changedFunctions(SOURCE, original.replace('x + limit', 'x * limit'), meta)).toEqual(new Set([0]));
    expect(changedFunctions(SOURCE, original.replace('1n', '3n'), meta)).toBeNull();
    expect(changedFunctions(SOURCE, original.replace('2n', '3n'), meta)).toBeNull();
  });

  it('compares native BigInt AST values without throwing, including with Babel 7 installed', () => {
    const original = 'const limit = 1n;\nfunction a(x = 2n) {\n  return x + limit;\n}\n';
    const meta = metadata(original);
    // Babel 8 returns bigint values; normalize Babel 7 output to exercise the same public API.
    jest.doMock('@babel/parser', () => {
      const parser = jest.requireActual('@babel/parser');
      const nativeBigInts = (value: any): void => {
        if (!value || typeof value !== 'object') return;
        if (value.type === 'BigIntLiteral') value.value = BigInt(value.value);
        Object.values(value).forEach(nativeBigInts);
      };
      return { ...parser, parse: (...args: any[]) => {
        const ast = parser.parse(...args);
        nativeBigInts(ast);
        return ast;
      } };
    });
    try {
      jest.isolateModules(() => {
        const native = require('../../../src/core/sourceChange') as typeof import('../../../src/core/sourceChange');
        expect(native.changedFunctions(SOURCE, original.replace('x + limit', 'x * limit'), meta)).toEqual(new Set([0]));
        expect(native.changedFunctions(SOURCE, original.replace('1n', '3n'), meta)).toBeNull();
        expect(native.changedFunctions(SOURCE, original.replace('2n', '3n'), meta)).toBeNull();
      });
    } finally {
      jest.dontMock('@babel/parser');
    }
  });

  it.each([
    ['signature', text.replace('a(x)', 'a(x, y)')],
    ['export', text.replace('{ a, b }', '{ a }')],
    ['syntax error', text.replace('x + 1', 'x +')],
    ['new function', text.replace('return x + 1', 'return (() => x + 1)()')],
    ['module scope', `${text}const x = 1;\n`],
    ['function removal', text.replace('function b(x) {\n  return x * 2;\n}\n', '')],
  ])('falls back for %s', (_name, edited) => {
    expect(changedFunctions(SOURCE, edited, metadata(text))).toBeNull();
  });

  it('handles one-line arrows, methods, empty bodies and nested functions', () => {
    for (const [original, edited, id] of [
      ['const a = x => x + 1;', 'const a = x => x + 2;', 0],
      ['const a = x => (x + 1);', 'const a = x => (x + 2);', 0],
      ['const a = () => {};', 'const a = () => { return 1; };', 0],
      ['class A { method() { return 1; } }', 'class A { method() { return 2; } }', 0],
      ['function a() { return () => 1; }', 'function a() { return () => 2; }', 1],
    ] as const) expect(changedFunctions(SOURCE, edited, metadata(original))).toEqual(new Set([id]));
    const nested = 'function a() {\n  const x = 1;\n  return () => x;\n}';
    expect(changedFunctions(SOURCE, nested.replace('x = 1', 'x = 2'), metadata(nested))).toEqual(new Set([0, 1]));
  });

  it('does not guess between edits to adjacent functions on one line', () => {
    const old = 'const a = () => 1; const b = () => 2;';
    expect(changedFunctions(SOURCE, old.replace('1', '3').replace('2', '4'), metadata(old))).toBeNull();
  });

  it('requires reliable coordinates and maps unchanged statements after inserted lines', () => {
    const before = metadata(text);
    const after = metadata(text.replace('  return x + 1;', '  x++;\n  return x + 1;'));
    expect(statementProjection(before, after).get(1)).toBe(2);
    expect(statementProjection(before, after).get(0)).toBe(1);
    expect(changedFunctions(SOURCE, text.replace('1', '2'), { ...before, originalCoordinates: false })).toBeNull();
  });

  it('distinguishes equal coverage shapes with different source content', () => {
    const before = metadata(text), after = metadata(text.replace('x + 1', 'x + 2'));
    expect(before.hash).toBe(after.hash);
    expect(before.revision).not.toBe(after.revision);
  });
});
