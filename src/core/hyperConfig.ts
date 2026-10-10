/** Native HyperJest configuration and Wallaby's portable configuration subset. */
import * as path from 'path';
import picomatch from 'picomatch';
import { type FsView, toPosix } from './paths';
import { tokenize } from './scriptSniffer';

export interface HyperConfig {
  jestConfig?: string;
  tests?: string[];
  files?: string[];
  env?: Record<string, string>;
  nodeArgs?: string[];
}
export interface LoadedHyperConfig { config?: HyperConfig; error?: string; }
export interface HyperConfigFile { file: string; wallaby?: string; }
export interface ConfigScope { baseDir: string; tests?: string[]; files?: string[]; }

export const HYPER_CONFIG_NAME = /^hyperjest(?:\..+)?\.config\.js$/;
const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', 'ios', 'android', 'Pods', 'lib', 'out']);

export function hyperConfigName(wallaby: string): string | undefined {
  const match = /^wallaby(?:\.(.+))?\.js$/.exec(wallaby);
  return match ? `hyperjest${match[1] ? `.${match[1]}` : ''}.config.js` : undefined;
}

/** Scan below a package without crossing another package or following directory symlinks. */
export function findHyperConfigs(packageDir: string, fs: FsView, excluded: (p: string) => boolean = () => false): HyperConfigFile[] {
  const found = new Map<string, HyperConfigFile>();
  const seen = new Set<string>();
  const walk = (dir: string) => {
    const real = fs.realpath(dir);
    if (seen.has(real)) return;
    seen.add(real);
    for (const name of fs.readdir(dir).sort()) {
      if (name.startsWith('.') || SKIP.has(name)) continue;
      const file = path.join(dir, name);
      if (excluded(file)) continue;
      if (fs.isDirectory(file)) {
        if (!fs.isFile(path.join(file, 'package.json')) && fs.realpath(file) === file) walk(file);
      } else if (fs.isFile(file)) {
        const target = hyperConfigName(name);
        if (target) {
          const dest = path.join(dir, target);
          found.set(dest, { ...found.get(dest), file: dest, wallaby: file });
        } else if (HYPER_CONFIG_NAME.test(name)) found.set(file, { ...found.get(file), file });
      }
    }
  };
  walk(packageDir);
  return [...found.values()].sort((a, b) => a.file.localeCompare(b.file));
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every(x => typeof x === 'string' && x.length > 0)) throw new Error(`${label} must be an array of non-empty strings`);
  return value;
}
function supported(obj: Record<string, unknown>, keys: string[], label: string): void {
  const unknown = Object.keys(obj).filter(k => !keys.includes(k));
  if (unknown.length) throw new Error(`Unsupported ${label}: ${unknown.join(', ')}`);
}
function literalTokens(text: string): ReturnType<typeof tokenize> {
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && quote !== "'") {
      if (++i === text.length) throw new Error('Unfinished escape in Wallaby environment or Node arguments');
    } else if (c === quote) quote = undefined;
    else if (!quote && (c === '"' || c === "'")) quote = c;
  }
  if (quote) throw new Error('Unclosed quote in Wallaby environment or Node arguments');
  const tokens = tokenize(text);
  if (tokens.some(t => t.op || /\$|`/.test(t.text))) throw new Error('Wallaby environment and Node arguments must be literal');
  return tokens;
}
export function validateHyperConfig(value: unknown): HyperConfig {
  const obj = object(value, 'HyperJest config');
  supported(obj, ['jestConfig', 'tests', 'files', 'env', 'nodeArgs'], 'HyperJest option');
  const config: HyperConfig = {};
  if (obj.jestConfig !== undefined) {
    if (typeof obj.jestConfig !== 'string' || !obj.jestConfig) throw new Error('jestConfig must be a non-empty path');
    config.jestConfig = obj.jestConfig;
  }
  for (const key of ['tests', 'files', 'nodeArgs'] as const) if (obj[key] !== undefined) config[key] = strings(obj[key], key);
  if (obj.env !== undefined) {
    const env = object(obj.env, 'env');
    if (!Object.values(env).every(v => typeof v === 'string')) throw new Error('env values must be strings');
    config.env = env as Record<string, string>;
  }
  return config;
}

function wallabyPatterns(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a pattern array; dynamic Wallaby pattern callbacks are not supported`);
  return value.map(item => {
    if (typeof item === 'string' && item) return item;
    const obj = object(item, label);
    supported(obj, ['pattern', 'ignore'], `${label} file option`);
    if (typeof obj.pattern !== 'string' || !obj.pattern || (obj.ignore !== undefined && typeof obj.ignore !== 'boolean')) throw new Error(`Invalid ${label} pattern`);
    return obj.ignore ? (obj.pattern.startsWith('!') ? obj.pattern.slice(1) : `!${obj.pattern}`) : obj.pattern;
  });
}

export function importWallaby(value: unknown): HyperConfig {
  const obj = object(value, 'Wallaby config');
  supported(obj, ['autoDetect', 'testFramework', 'tests', 'files', 'env'], 'Wallaby option');
  if (obj.autoDetect !== undefined && obj.autoDetect !== true) throw new Error('Only automatic Jest Wallaby configurations are supported');
  const result: HyperConfig = {};
  if (obj.testFramework !== undefined) {
    const framework = typeof obj.testFramework === 'string' ? { name: obj.testFramework } : object(obj.testFramework, 'testFramework');
    supported(framework, ['name', 'configFile'], 'testFramework option');
    if (framework.name !== undefined && framework.name !== 'jest') throw new Error('Only Jest Wallaby configurations are supported');
    if (framework.configFile !== undefined) result.jestConfig = framework.configFile as string;
  }
  for (const key of ['tests', 'files'] as const) if (obj[key] !== undefined) result[key] = wallabyPatterns(obj[key], key);
  if (obj.env !== undefined) {
    const env = object(obj.env, 'Wallaby env');
    supported(env, ['type', 'params'], 'Wallaby env option');
    if (env.type !== undefined && env.type !== 'node') throw new Error('Only Node Wallaby environments are supported');
    if (env.params !== undefined) {
      const params = object(env.params, 'env.params');
      supported(params, ['env', 'runner'], 'env.params option');
      if (params.env !== undefined) {
        if (typeof params.env !== 'string') throw new Error('env.params.env must be an assignment string');
        for (const token of literalTokens(params.env)) {
          const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(token.text);
          if (token.op || !match || /\$|`/.test(match[2])) throw new Error('Wallaby environment must contain literal NAME=value assignments');
          if (match[1] === 'NODE_OPTIONS') result.nodeArgs = literalTokens(match[2]).map(t => t.text);
          else (result.env ??= {})[match[1]] = match[2];
        }
      }
      if (params.runner !== undefined) {
        if (typeof params.runner !== 'string') throw new Error('env.params.runner must be a string');
        const args = literalTokens(params.runner);
        result.nodeArgs = [...(result.nodeArgs ?? []), ...args.map(t => t.text)];
      }
    }
  }
  return validateHyperConfig(result);
}

/** Exclusions always win, independently of order, as in Wallaby. */
export function scopeMatches(file: string, baseDir: string, patterns: readonly string[] | undefined): boolean {
  if (patterns === undefined) return true;
  const relative = toPosix(path.relative(baseDir, file));
  const matches = (pattern: string) => picomatch(pattern)(path.isAbsolute(pattern) ? toPosix(file) : relative);
  return patterns.some(p => !p.startsWith('!') && matches(p)) && !patterns.some(p => p.startsWith('!') && matches(p.slice(1)));
}

/** Apply source scope to reporting, without restricting Jest's module loader. */
export function scopedMessage<T extends import('./protocol').WorkerToHost>(msg: T, scope: ConfigScope | undefined): T | undefined {
  if (!scope?.files) return msg;
  const allowed = (file: string) => scopeMatches(file, scope.baseDir, scope.files);
  if (msg.type === 'coverageMeta') return allowed(msg.path) ? msg : undefined;
  if (msg.type === 'testCoverage' || msg.type === 'fileCoverage') return { ...msg, files: msg.files.filter(f => allowed(f.path)) } as T;
  if (msg.type === 'fileLoad') return { ...msg, files: msg.files.filter(allowed), shared: msg.shared?.filter(f => allowed(f.path)) } as T;
  return msg;
}
