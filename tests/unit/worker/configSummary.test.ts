import { configJsonReplacer, regexSource, summarizeConfig } from '../../../src/worker/configSummary';

describe('configSummary', () => {
  it('summarises a project config with regex sources as strings', () => {
    const s = summarizeConfig({
      rootDir: '/r', roots: ['/r/src'], testMatch: ['**/*.test.ts'], testRegex: [/x\.spec\.js$/, 'y'], testPathIgnorePatterns: ['/node_modules/'],
      modulePathIgnorePatterns: [], moduleFileExtensions: ['ts', 'js'], testEnvironment: '/r/node_modules/jest-environment-node/build/index.js',
      globalSetup: '', runner: '/r/node_modules/jest-runner/build/index.js', cacheDirectory: '/tmp/jest', displayName: { name: 'unit', color: 'blue' },
    }, 2);
    expect(s).toEqual({
      index: 2, displayName: 'unit', rootDir: '/r', roots: ['/r/src'], testMatch: ['**/*.test.ts'], testRegex: ['x\\.spec\\.js$', 'y'],
      testPathIgnorePatterns: ['/node_modules/'], modulePathIgnorePatterns: [], moduleFileExtensions: ['ts', 'js'],
      testEnvironment: '/r/node_modules/jest-environment-node/build/index.js', globalSetup: undefined,
      runner: '/r/node_modules/jest-runner/build/index.js', cacheDirectory: '/tmp/jest',
    });
    expect(summarizeConfig({ rootDir: '/r', displayName: 'plain', globalSetup: '/r/setup.js' }, 0)).toMatchObject({ displayName: 'plain', globalSetup: '/r/setup.js', roots: [], testRegex: [] });
  });

  it('regexSource and the JSON replacer serialise RegExp, functions and bigint', () => {
    expect(regexSource(/a\/b/)).toBe('a\\/b');
    expect(regexSource('s')).toBe('s');
    expect(JSON.parse(JSON.stringify({ re: /x/, fn: function named() { return 1; }, big: BigInt(5), ok: 1 }, configJsonReplacer)))
      .toEqual({ re: 'x', fn: '[Function named]', big: '5', ok: 1 });
  });
});
