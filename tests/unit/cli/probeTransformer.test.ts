import * as path from 'path';
import {
  DEFAULT_PROBE_VERSION,
  PROBE_GLOBAL,
  findLiveMarkers,
  hasLiveMarkers,
  instrumentWithProbes,
  markersHash,
  parseMarkerValue,
  wrapTransformer,
  type ProbeDeps,
} from '../../../src/worker/probeTransformer';

/* eslint-disable @typescript-eslint/no-var-requires */
const babelCore = require('@babel/core');
const babelParser = require('@babel/parser');
const traceMapping = require('@jridgewell/trace-mapping');
/* eslint-enable @typescript-eslint/no-var-requires */

const FILE = '/proj/src/sample.js';
const deps = (log?: (m: string) => void): ProbeDeps => ({ babelCore, babelParser, traceMapping, probeVersion: DEFAULT_PROBE_VERSION, log });

const SOURCE = [
  'const a = 1 + 2; //?',
  'function f(x) {',
  '  return x * 2; //?',
  '}',
  'f(a); //?',
  'const b = [1, 2, 3]; //? $.length',
  'const c = f(a) /*?*/ + 1;',
  'function g() {} //?',
  "const d = 'http://?not'; //?",
  'const e = `tpl`; // ? not a marker (space)',
  'module.exports = { a, b, c, d, e, f, g };',
].join('\n');

type Hit = [string, number, number, unknown];

/** A recording `__hj_v` installed for the whole test, so functions exported by instrumented code can be called later. */
const hits: Hit[] = [];
const g = globalThis as { __hj_v?: unknown };
beforeEach(() => {
  hits.length = 0;
  g.__hj_v = (f: string, l: number, c: number, v: unknown) => { hits.push([f, l, c, v]); return v; };
});
afterEach(() => { delete g.__hj_v; });

/** Evaluates instrumented CJS code; returns the shared hits array and module.exports. */
function run(code: string): { hits: Hit[]; exports: Record<string, unknown> } {
  const m = { exports: {} as Record<string, unknown> };
  new Function('require', 'module', 'exports', code)(require, m, m.exports);
  return { hits, exports: m.exports };
}

describe('marker detection', () => {
  it('hasLiveMarkers is a fast pre-check that ignores URLs and spaced question marks', () => {
    expect(hasLiveMarkers('x //?')).toBe(true);
    expect(hasLiveMarkers('x //?\n')).toBe(true);
    expect(hasLiveMarkers('x //? $.length')).toBe(true);
    expect(hasLiveMarkers('x //?.')).toBe(true);
    expect(hasLiveMarkers('x /*?*/ + 1')).toBe(true);
    expect(hasLiveMarkers('x /*?.*/')).toBe(true);
    expect(hasLiveMarkers("const u = 'http://?x'")).toBe(false);
    expect(hasLiveMarkers('// ? hmm')).toBe(false);
    expect(hasLiveMarkers('//?what')).toBe(false);
    expect(hasLiveMarkers('plain code')).toBe(false);
  });

  it('parseMarkerValue classifies modifiers and expressions', () => {
    expect(parseMarkerValue('?')).toEqual({ kind: 'value' });
    expect(parseMarkerValue('? $.length')).toEqual({ kind: 'value', expression: '$.length' });
    expect(parseMarkerValue('?$.length')).toEqual({ kind: 'value', expression: '$.length' });
    expect(parseMarkerValue('?.')).toEqual({ kind: 'timing' });
    expect(parseMarkerValue('??')).toEqual({ kind: 'proxy' });
    expect(parseMarkerValue('?+')).toEqual({ kind: 'expand' });
    expect(parseMarkerValue('?foo')).toBeUndefined();
    expect(parseMarkerValue(' ?')).toBeUndefined();
    expect(parseMarkerValue('TODO?')).toBeUndefined();
  });

  it('findLiveMarkers uses the parser so strings never count, and records target positions', () => {
    const markers = findLiveMarkers(SOURCE, FILE, babelParser);
    expect(markers.map(m => [m.line, m.column, m.kind, m.commentKind, m.expression ?? null])).toEqual([
      [1, 17, 'value', 'line', null],
      [3, 16, 'value', 'line', null],
      [5, 6, 'value', 'line', null],
      [6, 21, 'value', 'line', '$.length'],
      [7, 15, 'value', 'block', null],
      [8, 16, 'value', 'line', null],
      [9, 25, 'value', 'line', null],
    ]);
    expect(markers[0].targetStart).toEqual({ line: 1, column: 10 });
    expect(markers[0].targetEnd).toEqual({ line: 1, column: 15 });
    expect(markers[4].targetStart).toEqual({ line: 7, column: 10 });
    expect(findLiveMarkers('no markers', FILE, babelParser)).toEqual([]);
    expect(findLiveMarkers('const x: number = 1; //?', '/proj/a.ts', babelParser)).toHaveLength(1);
    expect(markersHash(markers)).toMatch(/^[0-9a-f]{40}$/);
    expect(markersHash(markers)).not.toBe(markersHash(markers.slice(1)));
  });
});

describe('instrumentWithProbes (comment pairing)', () => {
  it.each([
    ['trailing', 'const { currentPage } = context; //? currentPage.url', 2, 33],
    ['following', 'const { currentPage } = context;\n//? currentPage.url', 3, 0],
  ])('evaluates an independent expression after a destructuring statement (%s)', (_placement, declaration, line, column) => {
    const src = [
      'const context = { currentPage: { url: "https://example.test" } };',
      declaration,
      'module.exports = currentPage.url;',
    ].join('\n');
    const out = instrumentWithProbes({ code: src, source: src, filename: FILE, deps: deps() })!;
    expect(out.wrapped).toBe(1);
    const { exports } = run(out.code);
    expect(exports).toBe('https://example.test');
    expect(hits).toEqual([[FILE, line, column, 'https://example.test']]);
  });

  it('still binds $ to the preceding value on the following line', () => {
    const src = 'const values = [1, 2, 3];\n//? $.length\nmodule.exports = values;';
    const out = instrumentWithProbes({ code: src, source: src, filename: FILE, deps: deps() })!;
    expect(out.wrapped).toBe(1);
    const { exports } = run(out.code);
    expect(exports).toEqual([1, 2, 3]);
    expect(hits).toEqual([[FILE, 2, 0, 3]]);
  });

  it('wraps the right expressions with original coordinates and keeps the code runnable', () => {
    const out = instrumentWithProbes({ code: SOURCE, source: SOURCE, filename: FILE, deps: deps() })!;
    expect(out.mode).toBe('comments');
    expect(out.wrapped).toBe(7);
    expect(out.code).toContain(`${PROBE_GLOBAL}("${FILE}", 1, 17, 1 + 2)`);
    expect(out.code).toContain(`${PROBE_GLOBAL}("${FILE}", 3, 16, x * 2)`);
    expect(out.code).toContain(`${PROBE_GLOBAL}("${FILE}", 5, 6, f(a))`);
    expect(out.code).toContain(`${PROBE_GLOBAL}("${FILE}", 6, 21, __hj_t.length)`);
    expect(out.code).toContain(`${PROBE_GLOBAL}("${FILE}", 7, 15, f(a)) /*?*/ + 1`);
    expect(out.code).toContain(`${PROBE_GLOBAL}("${FILE}", 8, 16, g)`);
    expect(out.code).toContain(`${PROBE_GLOBAL}("${FILE}", 9, 25, 'http://?not')`);
    expect(out.code.startsWith(`if (typeof globalThis.${PROBE_GLOBAL} !== "function")`)).toBe(true);
    expect(out.map).toMatchObject({ version: 3, sources: expect.any(Array), mappings: expect.any(String) });

    const { hits, exports } = run(out.code);
    expect(exports).toMatchObject({ a: 3, b: [1, 2, 3], c: 7, d: 'http://?not' });
    expect(hits.map(h => [h[1], h[2], typeof h[3] === 'function' ? 'fn' : h[3]])).toEqual([
      [1, 17, 3], [3, 16, 6], [5, 6, 6], [6, 21, 3], [3, 16, 6], [7, 15, 6], [8, 16, 'fn'], [9, 25, 'http://?not'],
    ]);
    expect(hits.every(h => h[0] === FILE)).toBe(true);
  });

  it('runs even when __hj_v is absent (prelude installs a no-op)', () => {
    const out = instrumentWithProbes({ code: SOURCE, source: SOURCE, filename: FILE, deps: deps() })!;
    delete g.__hj_v;
    const m = { exports: {} as Record<string, unknown> };
    new Function('require', 'module', 'exports', out.code)(require, m, m.exports);
    expect(m.exports.c).toBe(7);
    expect(typeof g.__hj_v).toBe('function');
    expect(hits).toEqual([]); // the no-op was installed by the prelude, not our recorder
  });

  it('prefers the whole expression over its last token and the declaration over its body', () => {
    const src = [
      'const o = { p: 5, q: { r: 6 } };',
      'o.p //?',
      'o.q.r; //?',
      'const t = true ? 1 : 2 //?',
      'class K {} //?',
      'let m = 1;',
      'const obj = {',
      '  k: 7, //?',
      '  m //?',
      '};',
      'module.exports = { o, t, K, obj };',
    ].join('\n');
    const out = instrumentWithProbes({ code: src, source: src, filename: FILE, deps: deps() })!;
    expect(out.wrapped).toBe(6);
    expect(out.code).toContain(`${PROBE_GLOBAL}("${FILE}", 2, 4, o.p)`);
    expect(out.code).toContain(`${PROBE_GLOBAL}("${FILE}", 3, 7, o.q.r)`);
    expect(out.code).toContain(`${PROBE_GLOBAL}("${FILE}", 4, 23, true ? 1 : 2)`);
    expect(out.code).toContain(`${PROBE_GLOBAL}("${FILE}", 5, 11, K)`);
    expect(out.code).toContain(`k: globalThis.${PROBE_GLOBAL}("${FILE}", 8, 8, 7)`);
    expect(out.code).toContain(`m: globalThis.${PROBE_GLOBAL}("${FILE}", 9, 4, m)`);
    const { exports } = run(out.code);
    expect(exports.obj).toEqual({ k: 7, m: 1 });
    expect(hits.map(h => [h[1], typeof h[3] === 'function' ? 'fn' : h[3]])).toEqual([[2, 5], [3, 6], [4, 1], [5, 'fn'], [8, 7], [9, 1]]);
  });

  it('never wraps module sources or import/export specifiers', () => {
    const src = ["import x from 'y'; //?", "export { x } from 'y'; //?", 'export default x; //?'].join('\n');
    const out = instrumentWithProbes({ code: src, source: src, filename: FILE, deps: deps() })!;
    expect(out.wrapped).toBe(1);
    expect(out.code).toContain(`export default globalThis.${PROBE_GLOBAL}("${FILE}", 3, 18, x)`);
    expect(out.code).toContain("from 'y'; //?");
  });

  it('supports timing markers and await-safe wrapping', async () => {
    const src = ['async function go(p) {', '  const v = await p; //?', '  return v + 1; //?.', '}', 'module.exports = { go };'].join('\n');
    const out = instrumentWithProbes({ code: src, source: src, filename: FILE, deps: deps() })!;
    expect(out.wrapped).toBe(2);
    const { hits, exports } = run(out.code);
    await expect((exports.go as (p: Promise<number>) => Promise<number>)(Promise.resolve(41))).resolves.toBe(42);
    expect(hits[0].slice(1)).toEqual([2, 21, 41]);
    expect(hits[1][1]).toBe(3);
    expect(String(hits[1][3])).toMatch(/^\d+ ms$/);
  });

  it('skips markers with no wrappable target instead of failing', () => {
    const src = ['if (true) { //?', '  foo( //?', '  1);', '}', 'function foo() {}'].join('\n');
    const log: string[] = [];
    expect(instrumentWithProbes({ code: src, source: src, filename: FILE, deps: deps(m => log.push(m)) })).toBeUndefined();
  });

  it('uses the inner source map when a transformer drops comments', () => {
    const inner = babelCore.transformSync(SOURCE, { filename: FILE, babelrc: false, configFile: false, comments: false, sourceMaps: true, retainLines: false, compact: false });
    expect(hasLiveMarkers(inner.code)).toBe(false); // ('http://?not' is still there, but it is not a marker)
    const out = instrumentWithProbes({ code: inner.code, map: inner.map, source: SOURCE, filename: FILE, deps: deps() })!;
    expect(out.mode).toBe('sourceMap');
    expect(out.code).toContain(`${PROBE_GLOBAL}("${FILE}", 1, 17, 1 + 2)`);
    expect(out.code).toContain(`${PROBE_GLOBAL}("${FILE}", 5, 6, f(a))`);
    expect(out.code).toContain(`${PROBE_GLOBAL}("${FILE}", 7, 15, f(a)) + 1`); // end bound keeps `+ 1` outside
    const { exports } = run(out.code);
    expect(exports.c).toBe(7);
    // combined map still points at the original source
    const tracer = new traceMapping.TraceMap(out.map);
    const line = out.code.split('\n').findIndex(l => l.includes(', 7, 15,')) + 1;
    expect(traceMapping.originalPositionFor(tracer, { line, column: 0 }).line).toBe(7);
  });

  it('uses the source map for an independent expression when comments are dropped', () => {
    for (const [comment, line, column] of [[' //? currentPage.url', 2, 33], ['\n//? currentPage.url', 3, 0]] as const) {
      hits.length = 0;
      const src = `const context = { currentPage: { url: "mapped" } };\nconst { currentPage } = context;${comment}\nmodule.exports = currentPage.url;`;
      const inner = babelCore.transformSync(src, { filename: FILE, babelrc: false, configFile: false, comments: false, sourceMaps: true });
      const out = instrumentWithProbes({ code: inner.code, map: inner.map, source: src, filename: FILE, deps: deps() })!;
      expect(out.mode).toBe('sourceMap');
      expect(out.wrapped).toBe(1);
      run(out.code);
      expect(hits).toEqual([[FILE, line, column, 'mapped']]);
    }
  });

  it('skips everything without a map or trace-mapping when comments are gone', () => {
    const inner = babelCore.transformSync(SOURCE, { filename: FILE, babelrc: false, configFile: false, comments: false });
    const log: string[] = [];
    expect(instrumentWithProbes({ code: inner.code, source: SOURCE, filename: FILE, deps: { ...deps(m => log.push(m)), traceMapping: undefined } })).toBeUndefined();
    expect(log.join('\n')).toMatch(/live comments skipped/);
  });
});

describe('wrapTransformer', () => {
  const identity = () => {
    const results: unknown[] = [];
    const inner = {
      canInstrument: false,
      process: jest.fn((code: string) => { const r = { code }; results.push(r); return r; }),
      getCacheKey: jest.fn((_code: string, p: string) => `inner:${path.basename(p)}`),
    };
    return { inner, results };
  };

  it('passes marker-free files through by identity, cache key included', () => {
    const { inner, results } = identity();
    const w = wrapTransformer(inner, deps());
    const out = w.process('const x = 1;', FILE, { configString: '{}', instrument: false });
    expect(out).toBe(results[0]);
    expect(w.getCacheKey('const x = 1;', FILE, {})).toBe('inner:sample.js');
    expect(w.canInstrument).toBe(false);
    expect(w.processAsync).toBeUndefined();
    expect(w.getCacheKeyAsync).toBeUndefined();
    expect(wrapTransformer(w, deps())).toBe(w); // never double-wraps
  });

  it('instruments marker files and derives a distinct, marker-sensitive cache key', () => {
    const { inner } = identity();
    const w = wrapTransformer(inner, deps());
    const out = w.process(SOURCE, FILE, { configString: '{}', instrument: false });
    expect(out.code).toContain(`${PROBE_GLOBAL}("${FILE}", 1, 17, 1 + 2)`);
    expect(out.map).toBeDefined();
    const k1 = w.getCacheKey(SOURCE, FILE, {});
    const k2 = w.getCacheKey(SOURCE.replace('//? $.length', '//?'), FILE, {});
    const k3 = wrapTransformer(identity().inner, { ...deps(), probeVersion: '3' }).getCacheKey(SOURCE, FILE, {});
    expect(k1).toMatch(/^[0-9a-f]{40}$/);
    expect(k1).not.toBe('inner:sample.js');
    expect(new Set([k1, k2, k3]).size).toBe(3);
  });

  it('handles inner transformers without getCacheKey and with async methods', async () => {
    const inner = {
      processAsync: async (code: string) => ({ code, map: null }),
      getCacheKeyAsync: async () => 'async-inner',
    };
    const w = wrapTransformer(inner, deps());
    expect(w.process).toBeUndefined();
    expect(w.getCacheKey('const x = 1;', FILE, { configString: 'c', instrument: true })).toBeUndefined();
    const key = w.getCacheKey(SOURCE, FILE, { configString: 'c', instrument: true });
    expect(key).toMatch(/^[0-9a-f]{40}$/);
    expect(key).not.toBe(w.getCacheKey(SOURCE, FILE, { configString: 'c', instrument: false }));
    expect(await w.getCacheKeyAsync(SOURCE, FILE, {})).not.toBe('async-inner');
    const out = await w.processAsync(SOURCE, FILE, {});
    expect(out.code).toContain(`${PROBE_GLOBAL}("${FILE}", 5, 6, f(a))`);
  });

  it('degrades to the inner result when the probe pass cannot parse the output', () => {
    const inner = { process: () => ({ code: 'this is not javascript {{{' }) };
    const log: string[] = [];
    const w = wrapTransformer(inner, deps(m => log.push(m)));
    expect(w.process(SOURCE, FILE, {})).toEqual({ code: 'this is not javascript {{{' });
    expect(log.join('\n')).toMatch(/instrumentation failed/);
  });

  it('works with real babel-jest (createTransformer) on the fixture greet.js', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const babelJest = require('babel-jest').default;
    const fixture = path.resolve(__dirname, '../../fixtures/sample-project');
    const file = path.join(fixture, 'src/lib/greet.js');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src = require('fs').readFileSync(file, 'utf8') as string;
    const inner = babelJest.createTransformer({});
    const w = wrapTransformer(inner, deps());
    const options = { config: { cwd: fixture, rootDir: fixture }, configString: '{}', instrument: false, cacheFS: new Map(), transformerConfig: {}, supportsDynamicImport: false, supportsExportNamespaceFrom: false, supportsStaticESM: false, supportsTopLevelAwait: false };
    expect(w.canInstrument).toBe(true);
    const out = w.process(src, file, options);
    expect(out.code).toContain(`${PROBE_GLOBAL}("${file}", 5, 32, \`hello \${name}\`)`);
    const { hits, exports } = run(out.code.replace(/require\('\.\/math'\)/, `require(${JSON.stringify(path.join(fixture, 'src/lib/math.js'))})`));
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect((exports.greet as (n: string, t: number) => string)('x', 1)).toBe('hello x');
    } finally {
      spy.mockRestore();
    }
    expect(hits).toEqual([[file, 5, 32, 'hello x']]);
    expect(w.getCacheKey(src, file, options)).not.toBe(inner.getCacheKey(src, file, options));
  });
});
