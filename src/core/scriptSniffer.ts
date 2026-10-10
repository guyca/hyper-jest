/**
 * package.json script sniffer.
 *
 * Tokenises `scripts` entries shell-style, splits `&&` / `||` / `;` / `|` chains, peels wrappers
 * (`yarn`, `npx`, `cross-env`, `env`, `node`, ...), follows `yarn run <script>` / `npm run <script>`
 * references inside the same package, and classifies every command by its test runner. For Jest
 * commands it extracts `-c/--config`, `--testPathIgnorePatterns` (both `=` and space forms, greedy
 * arrays like yargs), positional path patterns and environment prefixes (`FOO=bar jest`,
 * `cross-env FOO=bar jest`, `export FOO=bar && jest`, `NODE_OPTIONS=... jest`).
 *
 * Pure and dependency-free (no fs, no 'vscode').
 */
import * as path from 'path';

export type Runner =
  | 'jest'
  | 'shono-testjs'
  | 'node-test'
  | 'mocha'
  | 'wdio'
  | 'detox'
  | 'vitest'
  | 'playwright'
  | 'cypress'
  | 'other';

/** Runners that are tests but not Jest (listed by Doctor as not-jest / e2e). */
export const NON_JEST_TEST_RUNNERS: readonly Runner[] = ['node-test', 'mocha', 'wdio', 'detox', 'vitest', 'playwright', 'cypress'];

export interface JestArgs {
  /** Raw value of `-c` / `--config` (relative to the package dir unless absolute). */
  configArg?: string;
  /** `--testPathIgnorePatterns` values (regex strings). Replaces the config's own list when non-empty. */
  testPathIgnorePatterns: string[];
  /** Positional path patterns plus `--testPathPattern(s)` values (regex strings). */
  testPathPatterns: string[];
  testNamePattern?: string;
  /** Every other option, with `--no-x` recorded as `x: false`. Array options keep all values. */
  flags: Record<string, string | boolean | string[]>;
  /** Raw positional arguments (before merging into testPathPatterns). */
  positional: string[];
}

export interface ShonoArgs {
  /** Optional positional test file / folder passed to `shono testjs`. */
  fileName?: string;
  flags: string[];
}

export interface CommandInfo {
  /** Script whose text contains this command. */
  script: string;
  /** Scripts that led here through `yarn run` / `npm run` references (outermost first). */
  via: string[];
  runner: Runner;
  /** The token that identified the runner (e.g. `jest`, `../../../node_modules/jest/bin/jest.js`). */
  bin: string;
  /** Tokens after the bin. */
  args: string[];
  /** Environment in effect for the command: `export X=`, `X=... cmd`, `cross-env X=...`, `env X=...`. */
  env: Record<string, string>;
  /** Wrappers peeled before the bin (e.g. `['yarn', 'cross-env']`). */
  wrappers: string[];
  jest?: JestArgs;
  shono?: ShonoArgs;
}

export interface ScriptInfo {
  name: string;
  raw: string;
  commands: CommandInfo[];
}

// ---------------------------------------------------------------------------------------------
// Tokeniser
// ---------------------------------------------------------------------------------------------

export interface Token {
  text: string;
  /** True for control operators: `&&`, `||`, `|`, `;`, `&`. */
  op: boolean;
}

/**
 * Shell-like tokeniser: whitespace separation, single/double quotes, backslash escapes outside single
 * quotes, control operators. `$VAR` and `$(...)` are kept literally.
 */
export function tokenize(cmdline: string): Token[] {
  const tokens: Token[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  const flush = () => {
    if (has) tokens.push({ text: cur, op: false });
    cur = '';
    has = false;
  };
  for (let i = 0; i < cmdline.length; i++) {
    const ch = cmdline[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < cmdline.length && '"\\$`'.includes(cmdline[i + 1])) {
        cur += cmdline[++i];
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === '\\' && i + 1 < cmdline.length) {
      cur += cmdline[++i];
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    if (ch === '&' || ch === '|') {
      flush();
      if (cmdline[i + 1] === ch) {
        tokens.push({ text: ch + ch, op: true });
        i++;
      } else {
        tokens.push({ text: ch, op: true });
      }
      continue;
    }
    if (ch === ';') {
      flush();
      tokens.push({ text: ';', op: true });
      continue;
    }
    cur += ch;
    has = true;
  }
  flush();
  return tokens;
}

/** Split a token stream into commands at control operators. */
export function splitCommands(tokens: Token[]): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  for (const t of tokens) {
    if (t.op) {
      if (cur.length) out.push(cur);
      cur = [];
    } else {
      cur.push(t.text);
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Jest argv parsing (mirrors jest-cli's yargs option table for the options that matter here)
// ---------------------------------------------------------------------------------------------

/** Options that take a single string value (next token or `=value`). */
const JEST_STRING_OPTIONS = new Set([
  'c', 'config', 't', 'testNamePattern', 'w', 'maxWorkers', 'maxConcurrency', 'testTimeout', 'rootDir',
  'testEnvironment', 'env', 'coverageDirectory', 'coverageProvider', 'coverageThreshold', 'outputFile',
  'changedSince', 'shard', 'seed', 'filter', 'globalSetup', 'globalTeardown', 'haste', 'moduleNameMapper',
  'preset', 'resolver', 'runner', 'testResultsProcessor', 'testRunner', 'testSequencer', 'transform',
  'cacheDirectory', 'snapshotResolver', 'workerIdleMemoryLimit', 'dependencyExtractor', 'prettierPath',
  'testFailureExitCode', 'displayName', 'globals', 'openHandlesTimeout', 'slowTestThreshold',
  'testEnvironmentOptions', 'testLocationInResults', 'snapshotFormat', 'fakeTimers', 'injectGlobals',
]);

/** Options yargs parses as arrays: they greedily consume following non-flag tokens. */
const JEST_ARRAY_OPTIONS = new Set([
  'testPathIgnorePatterns', 'testPathPattern', 'testPathPatterns', 'testMatch', 'roots', 'reporters',
  'setupFiles', 'setupFilesAfterEnv', 'projects', 'collectCoverageFrom', 'coveragePathIgnorePatterns',
  'coverageReporters', 'modulePathIgnorePatterns', 'modulePaths', 'moduleFileExtensions', 'moduleDirectories',
  'transformIgnorePatterns', 'unmockedModulePathPatterns', 'watchPathIgnorePatterns', 'snapshotSerializers',
  'selectProjects', 'ignoreProjects', 'watchPlugins', 'sandboxInjectedGlobals', 'testRegex',
]);

const JEST_SHORT_ALIASES: Record<string, string> = { c: 'config', t: 'testNamePattern', w: 'maxWorkers' };

/** Parse the argv that follows a Jest bin. */
export function parseJestArgs(args: string[]): JestArgs {
  const flags: Record<string, string | boolean | string[]> = {};
  const positional: string[] = [];
  let afterDoubleDash = false;
  const setFlag = (name: string, value: string | boolean) => {
    const key = JEST_SHORT_ALIASES[name] ?? name;
    if (JEST_ARRAY_OPTIONS.has(key)) {
      const prev = flags[key];
      const arr = Array.isArray(prev) ? prev : typeof prev === 'string' ? [prev] : [];
      if (typeof value === 'string') arr.push(value);
      flags[key] = arr;
    } else {
      flags[key] = value;
    }
  };
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (afterDoubleDash || !tok.startsWith('-') || tok === '-') {
      positional.push(tok);
      continue;
    }
    if (tok === '--') {
      afterDoubleDash = true;
      continue;
    }
    const long = tok.startsWith('--');
    const body = tok.slice(long ? 2 : 1);
    const eq = body.indexOf('=');
    let name = eq === -1 ? body : body.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : body.slice(eq + 1);
    if (long && name.startsWith('no-') && inlineValue === undefined) {
      setFlag(name.slice(3), false);
      continue;
    }
    if (!long && name.length > 1 && !JEST_SHORT_ALIASES[name]) {
      // Combined short booleans like `-ui`: record each letter.
      for (const ch of name) setFlag(ch, true);
      continue;
    }
    name = JEST_SHORT_ALIASES[name] ?? name;
    if (inlineValue !== undefined) {
      if (JEST_ARRAY_OPTIONS.has(name)) {
        // yargs still consumes following non-flag tokens for array options given with `=`.
        setFlag(name, inlineValue);
        while (i + 1 < args.length && !args[i + 1].startsWith('-')) setFlag(name, args[++i]);
      } else {
        setFlag(name, inlineValue === 'false' ? false : inlineValue === 'true' ? true : inlineValue);
      }
      continue;
    }
    if (JEST_ARRAY_OPTIONS.has(name)) {
      let consumed = false;
      while (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        setFlag(name, args[++i]);
        consumed = true;
      }
      if (!consumed) setFlag(name, true);
      continue;
    }
    if (JEST_STRING_OPTIONS.has(name)) {
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        setFlag(name, args[++i]);
      } else {
        setFlag(name, true);
      }
      continue;
    }
    setFlag(name, true);
  }
  const asArray = (v: string | boolean | string[] | undefined): string[] =>
    Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  const configArg = typeof flags.config === 'string' ? flags.config : undefined;
  const testNamePattern = typeof flags.testNamePattern === 'string' ? flags.testNamePattern : undefined;
  return {
    configArg,
    testPathIgnorePatterns: asArray(flags.testPathIgnorePatterns),
    testPathPatterns: [...positional, ...asArray(flags.testPathPattern), ...asArray(flags.testPathPatterns)],
    testNamePattern,
    flags,
    positional,
  };
}

/** Split a NODE_OPTIONS string into node arguments (quotes already removed by the tokeniser). */
export function nodeOptionsToArgs(nodeOptions: string): string[] {
  return nodeOptions.split(/\s+/).map(s => s.replace(/^["']|["']$/g, '')).filter(Boolean);
}

/** True for `<something>/shono-testjs/dist/src/jestConfig.js` (the inlined shono command form). */
export function isShonoConfigPath(p: string | undefined): boolean {
  return !!p && /shono-testjs[\\/]dist[\\/]src[\\/]jestConfig\.(js|cjs)$/.test(p);
}

// ---------------------------------------------------------------------------------------------
// Command classification
// ---------------------------------------------------------------------------------------------

const ENV_ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const JEST_BIN = /(^|[\\/])(jest|jest-cli)(\.c?js)?$/;
const YARN_BUILTINS = new Set([
  'add', 'bin', 'cache', 'config', 'constraints', 'dedupe', 'dlx', 'explain', 'info', 'init', 'install',
  'link', 'npm', 'pack', 'patch', 'plugin', 'rebuild', 'remove', 'set', 'stage', 'unlink', 'unplug', 'up',
  'upgrade', 'version', 'why', 'workspace', 'workspaces', 'why', 'global', 'list', 'outdated', 'owner',
  'publish', 'tag', 'team', 'audit', 'autoclean', 'check', 'create', 'generate-lock-entry', 'import',
  'licenses', 'login', 'logout', 'policies',
]);

interface Peeled {
  env: Record<string, string>;
  wrappers: string[];
  /** Remaining tokens: [bin, ...args]. Empty when the command was env-only (`export X=1`). */
  rest: string[];
  /** `yarn run X` / `npm run X` reference to another script in the same package. */
  scriptRef?: string;
  exportsEnv: boolean;
}

function takeAssignments(tokens: string[], start: number, env: Record<string, string>): number {
  let i = start;
  while (i < tokens.length) {
    const m = ENV_ASSIGN.exec(tokens[i]);
    if (!m) break;
    env[m[1]] = m[2];
    i++;
  }
  return i;
}

/** Peel env prefixes and package-manager / helper wrappers off a command. */
function peel(tokens: string[], scriptNames: ReadonlySet<string>): Peeled {
  const env: Record<string, string> = {};
  const wrappers: string[] = [];
  let i = 0;
  let exportsEnv = false;
  if (tokens[0] === 'export') {
    exportsEnv = true;
    takeAssignments(tokens, 1, env);
    return { env, wrappers, rest: [], exportsEnv };
  }
  for (let guard = 0; guard < 8 && i < tokens.length; guard++) {
    i = takeAssignments(tokens, i, env);
    const tok = tokens[i];
    if (tok === undefined) break;
    const base = path.basename(tok);
    if (base === 'cross-env' || base === 'cross-env-shell' || base === 'env') {
      wrappers.push(base);
      i++;
      if (base === 'env') while (tokens[i] === '-i' || tokens[i] === '-u') i += tokens[i] === '-u' ? 2 : 1;
      continue;
    }
    if (base === 'dotenv' || base === 'dotenvx') {
      wrappers.push(base);
      i++;
      while (i < tokens.length && tokens[i].startsWith('-') && tokens[i] !== '--') i += tokens[i] === '-e' || tokens[i] === '-c' ? 2 : 1;
      if (tokens[i] === '--') i++;
      if (base === 'dotenvx' && tokens[i] === 'run') i++;
      continue;
    }
    if (base === 'yarn' || base === 'yarnpkg') {
      wrappers.push('yarn');
      i++;
      while (i < tokens.length && tokens[i].startsWith('-')) i++;
      const sub = tokens[i];
      if (sub === 'run' || sub === 'exec') {
        i++;
        while (i < tokens.length && tokens[i].startsWith('-')) i++;
        const target = tokens[i];
        if (sub === 'run' && target !== undefined && scriptNames.has(target)) return { env, wrappers, rest: tokens.slice(i), scriptRef: target, exportsEnv };
        continue;
      }
      if (sub === 'node') {
        continue; // `yarn node x.js` -> handled by the `node` branch below
      }
      if (sub !== undefined && scriptNames.has(sub)) return { env, wrappers, rest: tokens.slice(i), scriptRef: sub, exportsEnv };
      if (sub !== undefined && YARN_BUILTINS.has(sub)) return { env, wrappers, rest: tokens.slice(i), exportsEnv };
      continue; // `yarn jest ...`
    }
    if (base === 'npm' || base === 'pnpm' || base === 'bun') {
      wrappers.push(base);
      i++;
      while (i < tokens.length && tokens[i].startsWith('-')) i++;
      const sub = tokens[i];
      if (sub === 'run' || sub === 'run-script') {
        i++;
        while (i < tokens.length && tokens[i].startsWith('-')) i++;
        const target = tokens[i];
        if (target !== undefined && scriptNames.has(target)) return { env, wrappers, rest: tokens.slice(i), scriptRef: target, exportsEnv };
        return { env, wrappers, rest: tokens.slice(i), exportsEnv };
      }
      if ((sub === 'test' || sub === 't' || sub === 'tst') && scriptNames.has('test')) return { env, wrappers, rest: tokens.slice(i), scriptRef: 'test', exportsEnv };
      if (sub === 'exec' || sub === 'x' || sub === 'dlx') {
        i++;
        while (i < tokens.length && tokens[i].startsWith('-') && tokens[i] !== '--') i++;
        if (tokens[i] === '--') i++;
        continue;
      }
      if (base !== 'npm' && sub !== undefined && scriptNames.has(sub)) return { env, wrappers, rest: tokens.slice(i), scriptRef: sub, exportsEnv };
      if (base === 'npm') return { env, wrappers, rest: tokens.slice(i), exportsEnv };
      continue;
    }
    if (base === 'npx' || base === 'bunx' || base === 'pnpx') {
      wrappers.push(base);
      i++;
      while (i < tokens.length && tokens[i].startsWith('-') && tokens[i] !== '--') {
        const f = tokens[i];
        i += (f === '-p' || f === '--package' || f === '-c' || f === '--call') ? 2 : 1;
      }
      if (tokens[i] === '--') i++;
      continue;
    }
    break;
  }
  return { env, wrappers, rest: tokens.slice(i), exportsEnv };
}

/** Classify a `node ...` invocation. */
function classifyNode(rest: string[]): { runner: Runner; bin: string; args: string[]; nodeArgs: string[] } {
  const nodeArgs: string[] = [];
  let i = 1;
  let isNodeTest = false;
  while (i < rest.length && rest[i].startsWith('-')) {
    const f = rest[i];
    if (f === '--test' || f.startsWith('--test=') || f === '--test-only') isNodeTest = true;
    nodeArgs.push(f);
    // Flags with a separate value.
    if ((f === '-r' || f === '--require' || f === '--import' || f === '--loader' || f === '--experimental-loader' || f === '-e' || f === '--eval') && i + 1 < rest.length) {
      nodeArgs.push(rest[++i]);
    }
    i++;
  }
  const script = rest[i];
  if (isNodeTest) return { runner: 'node-test', bin: 'node --test', args: rest.slice(i), nodeArgs };
  if (script === undefined) return { runner: 'other', bin: 'node', args: [], nodeArgs };
  if (JEST_BIN.test(script)) return { runner: 'jest', bin: script, args: rest.slice(i + 1), nodeArgs };
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(script) || /\*.*\.(test|spec)\./.test(script)) {
    return { runner: 'node-test', bin: `node ${script}`, args: rest.slice(i + 1), nodeArgs };
  }
  return { runner: 'other', bin: `node ${script}`, args: rest.slice(i + 1), nodeArgs };
}

function classifyRest(rest: string[]): { runner: Runner; bin: string; args: string[]; env?: Record<string, string> } {
  if (!rest.length) return { runner: 'other', bin: '', args: [] };
  const bin = rest[0];
  const base = path.basename(bin);
  const stem = base.replace(/\.(c|m)?js$/, '');
  if (stem === 'node' || stem === 'nodejs') {
    const n = classifyNode(rest);
    const env = n.nodeArgs.length ? { NODE_OPTIONS: n.nodeArgs.join(' ') } : undefined;
    return { runner: n.runner, bin: n.bin, args: n.args, env };
  }
  if (JEST_BIN.test(bin)) return { runner: 'jest', bin, args: rest.slice(1) };
  if (stem === 'shono' || stem === 'shono-lib') {
    const sub = rest[1];
    if (sub === 'testjs') return { runner: 'shono-testjs', bin: `${stem} testjs`, args: rest.slice(2) };
    return { runner: 'other', bin: `${stem} ${sub ?? ''}`.trim(), args: rest.slice(2) };
  }
  if (stem === 'shono-testjs') return { runner: 'shono-testjs', bin: stem, args: rest.slice(1) };
  if (stem === 'mocha' || stem === '_mocha') return { runner: 'mocha', bin, args: rest.slice(1) };
  if (stem === 'wdio') return { runner: 'wdio', bin, args: rest.slice(1) };
  if (stem === 'detox') return { runner: 'detox', bin, args: rest.slice(1) };
  if (stem === 'vitest') return { runner: 'vitest', bin, args: rest.slice(1) };
  if (stem === 'playwright') return { runner: 'playwright', bin, args: rest.slice(1) };
  if (stem === 'cypress') return { runner: 'cypress', bin, args: rest.slice(1) };
  if ((stem === 'tsx' || stem === 'ts-node') && rest.includes('--test')) return { runner: 'node-test', bin: `${stem} --test`, args: rest.slice(1) };
  return { runner: 'other', bin, args: rest.slice(1) };
}

function parseShonoArgs(args: string[]): ShonoArgs {
  const flags: string[] = [];
  let fileName: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') continue;
    if (a.startsWith('-')) {
      flags.push(a);
      if (a === '-e' || a === '--excluded-modules') i++;
      continue;
    }
    if (fileName === undefined) fileName = a;
    else flags.push(a);
  }
  return { fileName, flags };
}

// ---------------------------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------------------------

const MAX_SCRIPT_REF_DEPTH = 4;

/**
 * Sniff every script of a package. Script references (`yarn run x`, `npm run x`, `yarn x`) are
 * expanded inline (depth-limited, cycle-safe) so `test: "yarn run shono:test"` yields a
 * `shono-testjs` command attributed to `shono:test` via `test`.
 */
export function sniffScripts(scripts: Record<string, string> | undefined): ScriptInfo[] {
  if (!scripts) return [];
  const names = new Set(Object.keys(scripts));
  const out: ScriptInfo[] = [];
  for (const [name, raw] of Object.entries(scripts)) {
    if (typeof raw !== 'string') continue;
    out.push({ name, raw, commands: sniffCommandLine(raw, name, [], names, scripts, new Set([name])) });
  }
  return out;
}

function sniffCommandLine(
  raw: string,
  script: string,
  via: string[],
  names: ReadonlySet<string>,
  scripts: Record<string, string>,
  visiting: Set<string>,
): CommandInfo[] {
  const out: CommandInfo[] = [];
  const exported: Record<string, string> = {};
  for (const tokens of splitCommands(tokenize(raw))) {
    const peeled = peel(tokens, names);
    if (peeled.exportsEnv) {
      Object.assign(exported, peeled.env);
      continue;
    }
    const env = { ...exported, ...peeled.env };
    if (peeled.scriptRef !== undefined) {
      const ref = peeled.scriptRef;
      if (via.length + 1 <= MAX_SCRIPT_REF_DEPTH && !visiting.has(ref) && typeof scripts[ref] === 'string') {
        visiting.add(ref);
        const nested = sniffCommandLine(scripts[ref], ref, [...via, script], names, scripts, visiting);
        visiting.delete(ref);
        // Env set around the reference applies to the referenced commands (shell inheritance).
        for (const c of nested) out.push({ ...c, env: { ...env, ...c.env } });
      } else {
        out.push({ script, via, runner: 'other', bin: `run ${ref}`, args: [], env, wrappers: peeled.wrappers });
      }
      continue;
    }
    const cls = classifyRest(peeled.rest);
    const info: CommandInfo = {
      script,
      via,
      runner: cls.runner,
      bin: cls.bin,
      args: cls.args,
      env: { ...env, ...(cls.env ?? {}) },
      wrappers: peeled.wrappers,
    };
    if (cls.runner === 'jest') info.jest = parseJestArgs(cls.args);
    if (cls.runner === 'shono-testjs') info.shono = parseShonoArgs(cls.args);
    out.push(info);
  }
  return out;
}

/** Every command across all scripts, flattened. */
export function allCommands(infos: ScriptInfo[]): CommandInfo[] {
  return infos.flatMap(s => s.commands);
}

/** True when the script name looks test-related (`test`, `test:js`, `testjs`, `test-unit`, `jest`, `spec`...). */
export function isTestLikeScriptName(name: string): boolean {
  return /(^|[:._-])(pre|post)?(test|tests|testjs|spec|specs|jest|unit|integration|it|e2e)([:._-]|$)/i.test(name) || /^test/i.test(name);
}

/** True when the script name signals end-to-end tests (`test:e2e`, `e2e:ios`, `detox`). */
export function isE2eScriptName(name: string): boolean {
  return /(^|[:._-])(e2e|detox|appium|cypress|playwright)([:._-]|$)/i.test(name);
}

/**
 * Priority of a script name for choosing the "primary" command of a project: lower is better.
 * `test` (0) < `test:js` / `testjs` / `test-js` (1) < `test:unit` (2) < other `test*` (3) < others (5); e2e-ish names sink to 8.
 */
export function scriptPriority(name: string): number {
  if (isE2eScriptName(name)) return 8;
  if (name === 'test') return 0;
  if (/^test[:._-]?js$/i.test(name) || name === 'testjs') return 1;
  if (/^test[:._-](unit|units|js:unit)$/i.test(name)) return 2;
  if (/^test/i.test(name)) return 3;
  if (isTestLikeScriptName(name)) return 4;
  return 5;
}

/** Best (lowest) priority across the script and the chain of scripts that referenced it. */
export function commandPriority(cmd: CommandInfo): number {
  return Math.min(scriptPriority(cmd.script), ...cmd.via.map(scriptPriority));
}
