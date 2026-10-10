import * as path from 'path';
import { defaultResolveFrom, loadJestChain, majorOf, resolveJestChainDirs, type ResolveFrom } from '../../../src/worker/jestChain';

describe('jestChain', () => {
  it('follows the dependency chain hop by hop with a fake resolver', () => {
    const edges: string[] = [];
    const fake: ResolveFrom = (name, from) => {
      edges.push(`${path.basename(from)} -> ${name}`);
      if (name === '@jest/source-map' || name === 'convert-source-map') throw new Error('missing');
      return `/nm/${name.replace('/', '__')}`;
    };
    const dirs = resolveJestChainDirs('/proj/pkg', fake);
    expect(dirs.jest).toBe('/nm/jest');
    expect(dirs.config).toBe('/nm/jest-config');
    expect(edges).toEqual(expect.arrayContaining([
      'pkg -> jest', 'jest -> jest-cli', 'jest-cli -> @jest/core', '@jest__core -> jest-config', '@jest__core -> jest-runtime',
      '@jest__core -> jest-runner', '@jest__core -> jest-watcher', '@jest__core -> jest-resolve-dependencies',
      'jest-runtime -> jest-resolve', 'jest-runtime -> @jest/transform', 'jest-runtime -> jest-snapshot', 'jest-runtime -> jest-haste-map',
      'jest-runner -> jest-message-util', 'jest-runner -> jest-util', 'jest-runner -> pretty-format',
      '@jest__transform -> @babel/core', '@jest__transform -> @jridgewell/trace-mapping',
    ]));
    // Never resolved from the package dir (hoisted-copy trap).
    expect(edges.filter(e => e.startsWith('pkg ->'))).toEqual(['pkg -> jest']);
    expect(dirs.convertSourceMap).toBeUndefined();
    expect(dirs.traceMapping).toBe('/nm/@jridgewell__trace-mapping');
  });

  it('short-circuits the first hop when the host already resolved jest', () => {
    const fake: ResolveFrom = (name) => `/x/${name}`;
    const dirs = resolveJestChainDirs('/proj/pkg', fake, '/given/jest');
    expect(dirs.jest).toBe('/given/jest');
  });

  it('resolves and loads the real chain of this repo (jest 29.7)', () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const chain = loadJestChain(repoRoot, undefined, defaultResolveFrom);
    expect(majorOf(chain.version)).toBe(29);
    expect(chain.dirs.jest).toBe(path.join(repoRoot, 'node_modules', 'jest'));
    expect(typeof chain.modules.config.readConfigs).toBe('function');
    expect(typeof chain.modules.Runtime.createContext).toBe('function');
    expect(typeof chain.modules.runner.default).toBe('function');
    expect(typeof chain.modules.watcher.TestWatcher).toBe('function');
    expect(typeof chain.modules.resolve.default.clearDefaultResolverCache).toBe('function');
    expect(typeof chain.modules.transform.createScriptTransformer).toBe('function');
    expect(typeof chain.modules.prettyFormat.format).toBe('function');
    expect(typeof chain.modules.traceMapping?.TraceMap).toBe('function');
  });

  it('majorOf parses versions', () => {
    expect(majorOf('30.5.2')).toBe(30);
    expect(majorOf('junk')).toBe(0);
  });
});
