/**
 * Static replica of Jest's `SearchSource.isTestFilePath` (verified identical in @jest/core 29.7
 * `SearchSource.js:139-227` and 30.5 `index.js:425-503`):
 *
 *   every([ roots regex, globsToMatcher(testMatch), !testPathIgnorePatterns regex, testRegex ])
 *
 * plus the haste-map exclusion `modulePathIgnorePatterns` (files matching it are never in the module
 * map, so they can never be tests). Normalisation follows jest-config `normalize.js`:
 *   - roots:                   path.resolve(rootDir, replaceRootDirInPath(rootDir, root))
 *   - testMatch:               replaceRootDirInPath(escapeGlobCharacters(rootDir), glob) -> replacePathSepForGlob
 *   - *IgnorePatterns:         pattern.replace(/<rootDir>/g, rootDir) -> replacePathSepForRegex
 *   - testRegex:               string | string[] -> string[]; when set and testMatch is not explicit, testMatch = []
 * Globs are matched with picomatch `{dot: true}` against absolute paths (jest-util `globsToMatcher`).
 *
 * Also provides the default tables for Jest 29 / 30 (from jest-config `Defaults.js` / `index.js`).
 *
 * Pure: no fs, no 'vscode'.
 */
import * as path from 'path';
import picomatch from 'picomatch';

export interface MatcherConfig {
  rootDir: string;
  displayName?: string;
  roots?: string[];
  testMatch?: string[];
  testRegex?: string | string[];
  testPathIgnorePatterns?: string[];
  modulePathIgnorePatterns?: string[];
}

export interface NormalizedMatcherConfig {
  rootDir: string;
  displayName?: string;
  roots: string[];
  testMatch: string[];
  testRegex: string[];
  testPathIgnorePatterns: string[];
  modulePathIgnorePatterns: string[];
}

export interface MatchExplanation {
  roots: boolean;
  testMatch: boolean;
  testPathIgnorePatterns: boolean;
  testRegex: boolean;
  modulePathIgnorePatterns: boolean;
  matched: boolean;
}

export interface TestFileMatcher {
  config: NormalizedMatcherConfig;
  isTestFile(absPath: string): boolean;
  explain(absPath: string): MatchExplanation;
}

export interface MatcherOptions {
  /** Jest major used for default tables (29 or 30). Default 29. */
  jestMajor?: number;
}

// ---------------------------------------------------------------------------------------------
// jest-config / jest-util / jest-regex-util replicas
// ---------------------------------------------------------------------------------------------

export const ROOT_DIR_TAG = '<rootDir>';

/** jest-config utils `replaceRootDirInPath`. */
export function replaceRootDirInPath(rootDir: string, filePath: string): string {
  if (!/^<rootDir>/.test(filePath)) return filePath;
  return path.resolve(rootDir, path.normalize(`./${filePath.substring(ROOT_DIR_TAG.length)}`));
}

/** jest-config utils `escapeGlobCharacters`. */
export function escapeGlobCharacters(p: string): string {
  return p.replace(/([()*{}[\]!?\\])/g, '\\$1');
}

/** jest-util `replacePathSepForGlob`. */
export function replacePathSepForGlob(p: string): string {
  return p.replace(/\\(?![{}()+?.^$])/g, '/');
}

/** jest-regex-util `escapeStrForRegex`. */
export function escapeStrForRegex(s: string): string {
  return s.replace(/[[\]{}()*+?.\\^$|]/g, '\\$&');
}

/** jest-regex-util `replacePathSepForRegex` (identity on POSIX). */
export function replacePathSepForRegex(s: string): string {
  if (path.sep === '\\') {
    return s.replace(/(\/|(.)?\\(?![[\]{}()*+?.^$|\\]))/g, (_m, _1, p2: string | undefined) => (p2 && p2 !== '\\' ? `${p2}\\\\` : '\\\\'));
  }
  return s;
}

/** jest-regex-util `escapePathForRegex`. */
export function escapePathForRegex(dir: string): string {
  if (path.sep === '\\') dir = dir.replace(/\\/g, '/');
  return replacePathSepForRegex(escapeStrForRegex(dir));
}

/** jest-config `normalizeUnmockedModulePathPatterns`: raw `<rootDir>` substitution (not escaped, as in Jest). */
export function normalizeIgnorePatterns(rootDir: string, patterns: readonly string[] | undefined): string[] {
  return (patterns ?? []).map(p => replacePathSepForRegex(p.replace(/<rootDir>/g, rootDir)));
}

const picomatchOptions = { dot: true } as const;
const matcherCache = new Map<string, { isMatch: (p: string) => boolean; negated: boolean }>();

/** jest-util `globsToMatcher` (negation semantics included). */
export function globsToMatcher(globs: readonly string[]): (p: string) => boolean {
  if (globs.length === 0) return () => false;
  const matchers = globs.map(glob => {
    let m = matcherCache.get(glob);
    if (!m) {
      const isMatch = picomatch(glob, picomatchOptions, true) as ((p: string) => boolean) & { state?: { negated?: boolean; negatedExtglob?: boolean } };
      m = { isMatch, negated: !!(isMatch.state?.negated || isMatch.state?.negatedExtglob) };
      matcherCache.set(glob, m);
    }
    return m;
  });
  return p => {
    const replaced = replacePathSepForGlob(p);
    let kept: boolean | undefined;
    let negatives = 0;
    for (const { isMatch, negated } of matchers) {
      if (negated) negatives++;
      const matched = isMatch(replaced);
      if (!matched && negated) kept = false;
      else if (matched && !negated) kept = true;
    }
    return negatives === matchers.length ? kept !== false : !!kept;
  };
}

// ---------------------------------------------------------------------------------------------
// Default tables
// ---------------------------------------------------------------------------------------------

export interface JestDefaultTable {
  roots: string[];
  testMatch: string[];
  testRegex: string[];
  testPathIgnorePatterns: string[];
  modulePathIgnorePatterns: string[];
  moduleFileExtensions: string[];
}

/** jest-config defaults (29.7 `Defaults.js`; 30.4/30.5 `index.js` "./src/Defaults.ts"). */
export const JEST_DEFAULTS: Readonly<Record<29 | 30, JestDefaultTable>> = Object.freeze({
  29: {
    roots: ['<rootDir>'],
    testMatch: ['**/__tests__/**/*.[jt]s?(x)', '**/?(*.)+(spec|test).[tj]s?(x)'],
    testRegex: [],
    testPathIgnorePatterns: ['/node_modules/'],
    modulePathIgnorePatterns: [],
    moduleFileExtensions: ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'node'],
  },
  30: {
    roots: ['<rootDir>'],
    testMatch: ['**/__tests__/**/*.?([mc])[jt]s?(x)', '**/?(*.)+(spec|test).?([mc])[jt]s?(x)'],
    testRegex: [],
    testPathIgnorePatterns: ['/node_modules/'],
    modulePathIgnorePatterns: [],
    moduleFileExtensions: ['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'json', 'node'],
  },
});

/** Default table for a Jest major (anything below 30 uses the 29 table, 30+ uses 30). */
export function jestDefaultsFor(major: number | undefined): JestDefaultTable {
  return (major ?? 29) >= 30 ? JEST_DEFAULTS[30] : JEST_DEFAULTS[29];
}

/** Jest config file extensions in resolution order per major (jest-config `constants.js` / `index.js:716`). */
export const JEST_CONFIG_EXT_ORDER: Readonly<Record<29 | 30, readonly string[]>> = Object.freeze({
  29: ['.js', '.ts', '.mjs', '.cjs', '.json'],
  30: ['.js', '.ts', '.mjs', '.mts', '.cjs', '.cts', '.json'],
});

export function jestConfigExtOrderFor(major: number | undefined): readonly string[] {
  return (major ?? 30) >= 30 ? JEST_CONFIG_EXT_ORDER[30] : JEST_CONFIG_EXT_ORDER[29];
}

// ---------------------------------------------------------------------------------------------
// Matcher
// ---------------------------------------------------------------------------------------------

/** Apply jest-config normalisation to a raw matcher config. */
export function normalizeMatcherConfig(cfg: MatcherConfig, opts: MatcherOptions = {}): NormalizedMatcherConfig {
  const defaults = jestDefaultsFor(opts.jestMajor);
  const rootDir = path.resolve(cfg.rootDir);
  const roots = (cfg.roots ?? defaults.roots).map(r => path.resolve(rootDir, replaceRootDirInPath(rootDir, r)));
  const testRegex = cfg.testRegex === undefined ? [] : (Array.isArray(cfg.testRegex) ? cfg.testRegex : [cfg.testRegex]).map(replacePathSepForRegex);
  // normalize.js:1109 — an explicit testRegex suppresses the DEFAULT testMatch (an explicit testMatch stays and Jest would throw).
  const rawTestMatch = cfg.testMatch ?? (testRegex.length > 0 ? [] : defaults.testMatch);
  const testMatch = rawTestMatch.map(g => replacePathSepForGlob(replaceRootDirInPath(escapeGlobCharacters(rootDir), g)));
  return {
    rootDir,
    displayName: cfg.displayName,
    roots,
    testMatch,
    testRegex,
    testPathIgnorePatterns: normalizeIgnorePatterns(rootDir, cfg.testPathIgnorePatterns ?? defaults.testPathIgnorePatterns),
    modulePathIgnorePatterns: normalizeIgnorePatterns(rootDir, cfg.modulePathIgnorePatterns ?? defaults.modulePathIgnorePatterns),
  };
}

function regexToMatcher(testRegex: readonly string[]): (p: string) => boolean {
  const regexes = testRegex.map(r => new RegExp(r));
  return p =>
    regexes.some(regex => {
      const result = regex.test(p);
      regex.lastIndex = 0; // prevent stateful regexes from breaking, just in case (SearchSource.js:120)
      return result;
    });
}

/** Build a matcher that answers `isTestFilePath` for absolute paths exactly like Jest would. */
export function createMatcher(cfg: MatcherConfig, opts: MatcherOptions = {}): TestFileMatcher {
  const config = normalizeMatcherConfig(cfg, opts);
  const rootPattern = new RegExp(config.roots.map(dir => escapePathForRegex(dir + path.sep)).join('|'));
  const testMatch = config.testMatch.length ? globsToMatcher(config.testMatch) : undefined;
  const ignore = config.testPathIgnorePatterns.length ? new RegExp(config.testPathIgnorePatterns.join('|')) : undefined;
  const testRegex = config.testRegex.length ? regexToMatcher(config.testRegex) : undefined;
  const moduleIgnore = config.modulePathIgnorePatterns.length ? new RegExp(config.modulePathIgnorePatterns.join('|')) : undefined;

  const explain = (absPath: string): MatchExplanation => {
    const p = path.resolve(absPath);
    const e = {
      roots: rootPattern.test(p),
      testMatch: testMatch ? testMatch(p) : true,
      testPathIgnorePatterns: ignore ? !ignore.test(p) : true,
      testRegex: testRegex ? testRegex(p) : true,
      modulePathIgnorePatterns: moduleIgnore ? !moduleIgnore.test(p) : true,
    };
    return { ...e, matched: e.roots && e.testMatch && e.testPathIgnorePatterns && e.testRegex && e.modulePathIgnorePatterns };
  };
  return { config, isTestFile: p => explain(p).matched, explain };
}

/** CLI filters carried on a ProjectSpec (`--testPathIgnorePatterns` replaces the config list; patterns narrow). */
export interface CliFilters {
  testPathIgnorePatterns: string[];
  testPathPatterns?: string[];
}

/**
 * Apply script CLI filters the way jest-config's `setFromArgv` does: `--testPathIgnorePatterns` REPLACES the
 * config value (including the `/node_modules/` default). Path patterns are returned as a separate predicate
 * because Jest applies them after `isTestFilePath` (testPathPattern(s) regexes against the absolute path).
 */
export function applyCliFilters(cfg: MatcherConfig, filters: CliFilters | undefined): { config: MatcherConfig; pathPattern?: (absPath: string) => boolean } {
  if (!filters) return { config: cfg };
  const config: MatcherConfig = filters.testPathIgnorePatterns.length ? { ...cfg, testPathIgnorePatterns: filters.testPathIgnorePatterns } : cfg;
  const patterns = (filters.testPathPatterns ?? []).map(p => replacePathSepForRegex(p));
  if (!patterns.length) return { config };
  const regexes = patterns.map(p => {
    try {
      return new RegExp(p, 'i');
    } catch {
      return new RegExp(escapeStrForRegex(p), 'i');
    }
  });
  return { config, pathPattern: absPath => regexes.some(r => r.test(replacePathSepForGlob(path.resolve(absPath)))) };
}

/** Matcher over several projects: a file belongs to EVERY project whose matcher accepts it (Jest runs it once per project). */
export function createMultiMatcher(configs: MatcherConfig[], opts: MatcherOptions = {}): { matchers: TestFileMatcher[]; projectsFor(absPath: string): TestFileMatcher[]; isTestFile(absPath: string): boolean } {
  const matchers = configs.map(c => createMatcher(c, opts));
  return {
    matchers,
    projectsFor: p => matchers.filter(m => m.isTestFile(p)),
    isTestFile: p => matchers.some(m => m.isTestFile(p)),
  };
}
