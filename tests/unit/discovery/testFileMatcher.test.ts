import {
  JEST_CONFIG_EXT_ORDER, JEST_DEFAULTS, applyCliFilters, createMatcher, createMultiMatcher, escapeGlobCharacters, globsToMatcher, jestDefaultsFor, normalizeMatcherConfig,
  replaceRootDirInPath, shonoProjectConfigs,
} from '../../../src/core/testFileMatcher';

describe('testFileMatcher', () => {
  it('replicates jest-config normalisation', () => {
    expect(replaceRootDirInPath('/p', '<rootDir>/src/**/*.ts')).toBe('/p/src/**/*.ts');
    expect(replaceRootDirInPath('/p', 'src/x')).toBe('src/x');
    expect(escapeGlobCharacters('/p/(x)/[y]')).toBe('/p/\\(x\\)/\\[y\\]');
    const n = normalizeMatcherConfig({ rootDir: '/p', roots: ['<rootDir>/src', 'tests'], testPathIgnorePatterns: ['<rootDir>/skip/'] });
    expect(n.roots).toEqual(['/p/src', '/p/tests']);
    expect(n.testPathIgnorePatterns).toEqual(['/p/skip/']);
    expect(n.testMatch).toEqual(JEST_DEFAULTS[29].testMatch);
    expect(normalizeMatcherConfig({ rootDir: '/p', testRegex: 'x' }).testMatch).toEqual([]);
    expect(normalizeMatcherConfig({ rootDir: '/p', testRegex: ['a', 'b'] }).testRegex).toEqual(['a', 'b']);
    expect(jestDefaultsFor(30)).toBe(JEST_DEFAULTS[30]);
    expect(jestDefaultsFor(undefined)).toBe(JEST_DEFAULTS[29]);
    expect(JEST_CONFIG_EXT_ORDER[29]).toEqual(['.js', '.ts', '.mjs', '.cjs', '.json']);
    expect(JEST_CONFIG_EXT_ORDER[30]).toEqual(['.js', '.ts', '.mjs', '.mts', '.cjs', '.cts', '.json']);
  });

  it('matches Jest 29 / 30 defaults (dot files included, node_modules ignored, .mts only on 30)', () => {
    const m29 = createMatcher({ rootDir: '/p' }, { jestMajor: 29 });
    const m30 = createMatcher({ rootDir: '/p' }, { jestMajor: 30 });
    expect(m29.isTestFile('/p/src/a.test.ts')).toBe(true);
    expect(m29.isTestFile('/p/src/__tests__/a.ts')).toBe(true);
    expect(m29.isTestFile('/p/src/a.spec.jsx')).toBe(true);
    expect(m29.isTestFile('/p/.hidden/a.test.ts')).toBe(true);
    expect(m29.isTestFile('/p/src/a.ts')).toBe(false);
    expect(m29.isTestFile('/p/node_modules/x/a.test.ts')).toBe(false);
    expect(m29.isTestFile('/other/a.test.ts')).toBe(false);
    expect(m29.isTestFile('/p/src/a.test.mts')).toBe(false);
    expect(m30.isTestFile('/p/src/a.test.mts')).toBe(true);
    expect(m30.isTestFile('/p/src/__tests__/a.cjs')).toBe(true);
    expect(m29.explain('/p/node_modules/x/a.test.ts')).toMatchObject({ roots: true, testMatch: true, testPathIgnorePatterns: false, matched: false });
  });

  it('applies roots, <rootDir> testMatch, testRegex and ignore patterns', () => {
    const roots = createMatcher({ rootDir: '/p', roots: ['<rootDir>/src', 'tests'] });
    expect(roots.isTestFile('/p/src/a.test.ts')).toBe(true);
    expect(roots.isTestFile('/p/tests/a.test.ts')).toBe(true);
    expect(roots.isTestFile('/p/lib/a.test.ts')).toBe(false);
    const regex = createMatcher({ rootDir: '/p', testRegex: '(/__tests__/.*|(\\.|/)(test))\\.(tsx?|jsx?)$' });
    expect(regex.isTestFile('/p/src/x.test.ts')).toBe(true);
    expect(regex.isTestFile('/p/src/x.spec.ts')).toBe(false);
    const tm = createMatcher({ rootDir: '/p', testMatch: ['<rootDir>/unitTests/**/*.spec.ts?(x)'] });
    expect(tm.isTestFile('/p/unitTests/a/b.spec.tsx')).toBe(true);
    expect(tm.isTestFile('/p/src/b.spec.ts')).toBe(false);
    const ign = createMatcher({ rootDir: '/p', testPathIgnorePatterns: ['<rootDir>/tests/integration/'] });
    expect(ign.isTestFile('/p/tests/integration/a.test.ts')).toBe(false);
    expect(ign.isTestFile('/p/tests/unit/a.test.ts')).toBe(true);
    expect(ign.isTestFile('/p/node_modules/a.test.ts')).toBe(true); // default /node_modules/ replaced, as in Jest
    const mod = createMatcher({ rootDir: '/p', modulePathIgnorePatterns: ['dist'] });
    expect(mod.isTestFile('/p/dist/a.spec.ts')).toBe(false);
    expect(mod.isTestFile('/p/src/redistribute.spec.ts')).toBe(false); // Jest regex semantics: 'dist' matches anywhere
    expect(mod.isTestFile('/p/src/a.spec.ts')).toBe(true);
    const parens = createMatcher({ rootDir: '/p/(x)', testMatch: ['<rootDir>/**/*.test.ts'] });
    expect(parens.isTestFile('/p/(x)/a.test.ts')).toBe(true);
  });

  it('implements globsToMatcher negation semantics', () => {
    const m = globsToMatcher(['**/*.test.ts', '!**/skip/**']);
    expect(m('/p/a.test.ts')).toBe(true);
    expect(m('/p/skip/a.test.ts')).toBe(false);
    expect(globsToMatcher(['!**/skip/**'])('/p/a.ts')).toBe(true);
    expect(globsToMatcher([])('/p/a.test.ts')).toBe(false);
  });

  it('models shono-testjs projects', () => {
    const multi = createMultiMatcher(shonoProjectConfigs('/p'));
    const names = (f: string) => multi.projectsFor(f).map(m => m.config.displayName);
    expect(names('/p/unitTests/a.spec.ts')).toEqual(['Unit Tests']);
    expect(names('/p/src/deep/a.spec.tsx')).toEqual(['Unit Tests']);
    expect(names('/p/headlessTests/h.spec.ts')).toEqual(['Headless Tests']);
    expect(names('/p/src/a.test.legacy.js')).toEqual(['Legacy Unit Tests']);
    expect(names('/p/src/__tests__/a.spec.legacy.tsx')).toEqual(['Legacy Unit Tests']);
    expect(names('/p/detox/a.test.ts')).toEqual([]);
    expect(names('/p/src/a.test.ts')).toEqual([]);
    expect(names('/p/tests/a.spec.ts')).toEqual([]);
    expect(names('/p/dist/unitTests/a.spec.ts')).toEqual([]);
    expect(multi.isTestFile('/p/unitTests/a.spec.ts')).toBe(true);
    const v136 = createMultiMatcher(shonoProjectConfigs('/p', { unitTestsFolders: ['unitTests', 'tests'] }));
    expect(v136.projectsFor('/p/tests/a.spec.ts').map(m => m.config.displayName)).toEqual(['Unit Tests']);
  });

  it('applies CLI filters like setFromArgv', () => {
    const { config, pathPattern } = applyCliFilters({ rootDir: '/p' }, { testPathIgnorePatterns: ['tests/integration'], testPathPatterns: ['src/.*\\.spec\\.ts'] });
    expect(config.testPathIgnorePatterns).toEqual(['tests/integration']);
    const m = createMatcher(config);
    expect(m.isTestFile('/p/tests/integration/a.test.ts')).toBe(false);
    expect(m.isTestFile('/p/tests/unit/a.test.ts')).toBe(true);
    expect(pathPattern!('/p/src/a.spec.ts')).toBe(true);
    expect(pathPattern!('/p/tests/a.spec.ts')).toBe(false);
    expect(applyCliFilters({ rootDir: '/p' }, { testPathIgnorePatterns: [] })).toEqual({ config: { rootDir: '/p' } });
    expect(applyCliFilters({ rootDir: '/p' }, undefined).pathPattern).toBeUndefined();
  });
});
