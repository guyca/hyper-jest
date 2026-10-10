import { hasCachePruneSeam, installHooksOnPrototype, pruneTransformCache, type ProbeModule } from '../../../src/worker/transformHooks';
import { isEnvironmentClass } from '../../../src/worker/envWrapper';
import { capturedSource, resetSourceCapture } from '../../../src/worker/sourceCapture';

class FakeEnv {
  global: Record<string, unknown> = {};
  constructor(_config: unknown, _context: unknown) {}
  getVmContext() { return null; }
  async setup() {}
  async teardown() {}
}

function makeProto(mods: Record<string, unknown>) {
  const log: string[] = [];
  const proto: any = {
    async requireAndTranspileModule(name: string, callback?: (m: unknown) => unknown) {
      log.push(`require ${name}${callback ? ' cb' : ''}`);
      const mod = mods[name];
      if (callback) await callback(mod);
      return mod;
    },
    _getTransformer(filename: string) {
      log.push(`get ${filename}`);
      return filename.endsWith('.ts') ? this._entry : null;
    },
    _entry: { transformer: { process: () => ({ code: 'x' }), getCacheKey: () => 'k' }, transformerConfig: {} },
  };
  return { proto, log };
}

describe('transformHooks', () => {
  it('captures cached original source for sync/async entry points without changing their results', async () => {
    resetSourceCapture();
    const result = { code: 'compiled', originalCode: 'const original = 1;' };
    const proto = {
      transform: jest.fn(() => result),
      transformAsync: jest.fn(async () => result),
      transformSource: jest.fn(() => result),
      transformSourceAsync: jest.fn(async () => result),
    };
    installHooksOnPrototype(proto, { liveComments: false, envDeps: {} });
    for (const method of Object.keys(proto)) {
      expect(await (proto as any)[method]('/source.js')).toBe(result);
      expect(capturedSource('/source.js')).toBe(result.originalCode);
    }
    result.originalCode = 'const different = 2;';
    (proto.transform as any)('/source.js');
    expect(capturedSource('/source.js')).toBeUndefined(); // a file execution mixed revisions
    resetSourceCapture();
    (proto.transform as any)('/source.js');
    expect(capturedSource('/source.js')).toBe(result.originalCode);
  });
  it('wraps environment classes returned by requireAndTranspileModule and leaves everything else alone', async () => {
    const runner = () => 'framework';
    const { proto, log } = makeProto({ '/env.js': FakeEnv, '/runner.js': runner });
    const seams = installHooksOnPrototype(proto, { liveComments: false, envDeps: {} });
    expect(seams).toEqual({ envWrapper: true, probeTransformer: false });
    const Wrapped = await proto.requireAndTranspileModule('/env.js');
    expect(Wrapped).not.toBe(FakeEnv);
    expect(Object.getPrototypeOf(Wrapped)).toBe(FakeEnv);
    expect(isEnvironmentClass(Wrapped)).toBe(true);
    expect(await proto.requireAndTranspileModule('/env.js')).toBe(Wrapped); // memoised per Base
    expect(await proto.requireAndTranspileModule('/runner.js')).toBe(runner);
    // Callback form (globalSetup, snapshot resolver) passes through untouched.
    const seen: unknown[] = [];
    expect(await proto.requireAndTranspileModule('/env.js', (m: unknown) => { seen.push(m); })).toBe(FakeEnv);
    expect(seen).toEqual([FakeEnv]);
    expect(log).toContain('require /env.js cb');
    // Idempotent per prototype.
    expect(installHooksOnPrototype(proto, { liveComments: true, envDeps: {} })).toEqual({ envWrapper: true, probeTransformer: false });
  });

  it('routes the project transformer through the probe module when live comments are enabled', () => {
    const { proto } = makeProto({});
    const probe: ProbeModule = { wrapTransformer: inner => ({ ...inner, probed: true }) };
    const seams = installHooksOnPrototype(proto, { liveComments: true, probe, probeDeps: { babelCore: {}, babelParser: {}, probeVersion: '1' }, envDeps: {} });
    expect(seams.probeTransformer).toBe(true);
    const a = proto._getTransformer('/x.ts');
    expect(a.transformer.probed).toBe(true);
    expect(a.transformer).not.toBe(proto._entry.transformer);
    expect(proto._getTransformer('/x.ts')).toBe(a); // stable wrapped entry
    expect(proto._getTransformer('/y.json')).toBeNull();
  });

  it('degrades when the probe module throws or when seams are missing', () => {
    const { proto } = makeProto({});
    const probe: ProbeModule = { wrapTransformer: () => { throw new Error('nope'); } };
    installHooksOnPrototype(proto, { liveComments: true, probe, probeDeps: { babelCore: {}, babelParser: {}, probeVersion: '1' }, envDeps: {} });
    expect(proto._getTransformer('/x.ts')).toBe(proto._entry);
    expect(installHooksOnPrototype({}, { liveComments: true, envDeps: {} })).toEqual({ envWrapper: false, probeTransformer: false });
  });

  it('prunes transform cache entries by filename prefix', () => {
    const transformedFiles = new Map<string, unknown>([
      ['/p/a.js_1700000000_instrumented', 1], ['/p/a.js_1700000001', 2], ['/p/ab.js_1700000000', 3], ['/p/b.js_1', 4],
    ]);
    const transformer = { _cache: { transformedFiles } };
    expect(hasCachePruneSeam(transformer)).toBe(true);
    expect(pruneTransformCache(transformer, ['/p/a.js'])).toBe(2);
    expect([...transformedFiles.keys()]).toEqual(['/p/ab.js_1700000000', '/p/b.js_1']);
    expect(pruneTransformCache(transformer, [])).toBe(0);
    expect(hasCachePruneSeam({})).toBe(false);
    expect(pruneTransformCache({}, ['/p/a.js'])).toBe(-1);
  });
});
