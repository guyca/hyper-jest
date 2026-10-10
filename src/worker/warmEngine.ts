import { resetSourceCapture } from './sourceCapture';
/**
 * The warm in-band Jest engine (plan section "Warm engine"). One instance per worker process.
 *
 * Bootstrap once: chain-resolve the project's Jest, `readConfigs` with cwd = package dir, spread-copy
 * the frozen configs ONCE (the transform cache key is the stringified ProjectConfig, so the copies
 * must stay stable), build the base GlobalConfig (in-band, coverage via babel, no reporters), keep
 * only jest-runner/jest-runner-groups projects, install the prototype seams, run globalSetup once,
 * send `ready`. Haste contexts are created lazily per project (cold builds serialised).
 *
 * Per run: clear jest-resolve's fs cache, prune overlay entries from the in-memory transform cache,
 * `new TestRunner(g).runTests([{path, context}], watcher, {serial: true})`, stream the runner's
 * events as protocol messages, `runComplete`. Cancel = `watcher.setState({interrupted: true})` plus
 * the env wrapper skipping remaining tests. Identical code path for Jest 29.7, 30.4 and 30.5.
 *
 * No static Jest imports; everything comes from the chain.
 */
import * as path from 'path';
import { scopeMatches } from '../core/hyperConfig';
import type { Logger } from '../core/logger';
import {
  makeTestKey,
  type ConsoleMsg, type FailureInfo, type FileResultMsg, type InitErrorKind, type InitMsg, type InvalidateMsg,
  type OverlayChange, type RunMsg, type RunTestSelection, type SnapshotSummary, type TestResultMsg, type TestStatus,
  type WorkerFlags,
} from '../core/protocol';
import { configJsonReplacer, summarizeConfig } from './configSummary';
import { coverageHash, hitBranchArms, hitStatements, type CoverageMap, type TraceMappingLike } from './coverageDiff';
import { buildDepGraph, toGraphResult, updateDepGraph, type DepGraph } from './depGraph';
import { ensureCoverageMeta, formatValue, levelOfLogType, setRunContext, type EnvDeps, type EnvRunContext } from './envWrapper';
import type { OutgoingMsg, Sender } from './ipc';
import { loadJestChain, majorOf, type JestChain } from './jestChain';
import type { OverlayStore } from './overlayFs';
import { parseFrames, splitMessageStack, stripAnsi, topUserFrame } from './stacks';
import { installTransformHooks, loadProbeModule, PROBE_VERSION, pruneTransformCache, type Seams } from './transformHooks';

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit-tested without Jest)
// ---------------------------------------------------------------------------------------------

/** GlobalConfig keys that would make Jest watch, exit, spawn workers or post-process results. */
export const GLOBAL_CONFIG_DELETE = [
  'workerIdleMemoryLimit', 'testResultsProcessor', 'watchPlugins', 'onlyChanged', 'onlyFailures', 'findRelatedTests',
  'listTests', 'outputFile', 'forceExit', 'changedSince',
] as const;

/** The stable base GlobalConfig for every run (per-run fields: updateSnapshot, testNamePattern). */
export function buildGlobalConfig(g0: Record<string, any>, flags: WorkerFlags): Record<string, any> {
  const g: Record<string, any> = {
    ...g0,
    maxWorkers: 1, watch: false, watchAll: false, bail: 0, notify: false, json: false, useStderr: false,
    detectLeaks: false, detectOpenHandles: false, errorOnDeprecated: false, verbose: false, silent: false,
    reporters: [],
    collectCoverage: flags.coverage, coverageProvider: 'babel', collectCoverageFrom: [], coverageReporters: [],
  };
  for (const k of GLOBAL_CONFIG_DELETE) delete g[k];
  return g;
}

/** Package name of a resolved runner path (`.../node_modules/jest-runner/build/index.js` -> `jest-runner`). */
export function runnerPackageName(runnerPath: string): string {
  const s = String(runnerPath ?? '').replace(/\\/g, '/');
  const re = /node_modules\/((?:@[^/]+\/)?[^/]+)/g;
  let last: string | undefined;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) last = m[1];
  if (last) return last;
  if (s === 'jest-runner' || s === 'jest-runner-groups') return s;
  const base = s.split('/').pop() ?? s;
  return base.replace(/\.[cm]?js$/, '');
}

export function isRunnerSupported(runnerPath: string): boolean {
  const n = runnerPackageName(runnerPath);
  return n === 'jest-runner' || n === 'jest-runner-groups';
}

/**
 * One spread copy of a frozen ProjectConfig. Only opt-in flags alter it (each alteration changes
 * Jest's transform cache key once): `instrumentTestFiles` -> forceCoverageMatch, ts-jest diagnostics off.
 */
export function stableProjectConfig(cfg: Record<string, any>, flags: WorkerFlags): Record<string, any> {
  const copy: Record<string, any> = { ...cfg };
  if (flags.instrumentTestFiles && (!Array.isArray(copy.forceCoverageMatch) || copy.forceCoverageMatch.length === 0)) {
    copy.forceCoverageMatch = ['**/*'];
  }
  if (flags.tsJestDiagnostics === 'off' && Array.isArray(copy.transform)) {
    copy.transform = copy.transform.map((entry: unknown) => {
      if (!Array.isArray(entry)) return entry;
      const [re, p, opts] = entry as [unknown, unknown, Record<string, unknown> | undefined];
      return /ts-jest/.test(String(p)) ? [re, p, { ...(opts ?? {}), diagnostics: false }] : entry;
    });
  }
  return copy;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `-t`-style pattern that matches exactly the given full names (circus tests it with flag `i`). */
export function namesToPattern(names: string[]): string {
  return `^(?:${names.map(escapeRegExp).join('|')})$`;
}

export interface ConfigMatcher {
  index: number;
  roots: string[];
  testMatch?: (p: string) => boolean;
  ignore?: RegExp;
  testRegex: RegExp[];
}

/** Replica of SearchSource's test-path cases: roots -> testMatch -> testPathIgnorePatterns -> testRegex. */
export function createConfigMatchers(configs: Array<Record<string, any>>, globsToMatcher?: (globs: string[]) => (p: string) => boolean): ConfigMatcher[] {
  return configs.map((cfg, index) => {
    const roots: string[] = (Array.isArray(cfg.roots) && cfg.roots.length ? cfg.roots : [cfg.rootDir]).map((r: string) => path.normalize(String(r)));
    const testMatch: string[] = Array.isArray(cfg.testMatch) ? cfg.testMatch : [];
    const ignore: string[] = Array.isArray(cfg.testPathIgnorePatterns) ? cfg.testPathIgnorePatterns : [];
    const testRegex: unknown[] = Array.isArray(cfg.testRegex) ? cfg.testRegex : cfg.testRegex ? [cfg.testRegex] : [];
    return {
      index,
      roots,
      testMatch: testMatch.length && globsToMatcher ? globsToMatcher(testMatch) : undefined,
      ignore: ignore.length ? new RegExp(ignore.join('|')) : undefined,
      testRegex: testRegex.map(r => (r instanceof RegExp ? r : new RegExp(String(r)))),
    };
  });
}

function isUnderRoot(file: string, root: string): boolean {
  return file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** Index of the project whose matchers accept the file (longest matching root wins), or -1. */
export function matchConfigIndex(matchers: ConfigMatcher[], file: string): number {
  const p = path.normalize(file);
  let best = -1;
  let bestLen = -1;
  for (const m of matchers) {
    const root = m.roots.filter(r => isUnderRoot(p, r)).sort((a, b) => b.length - a.length)[0];
    if (root === undefined) continue;
    if (m.testMatch && !m.testMatch(p)) continue;
    if (m.ignore && m.ignore.test(p)) continue;
    if (m.testRegex.length && !m.testRegex.some(re => re.test(p))) continue;
    if (root.length > bestLen) { best = m.index; bestLen = root.length; }
  }
  return best;
}

export function normalizeStatus(s: unknown): TestStatus {
  switch (s) {
    case 'passed': case 'failed': case 'skipped': case 'pending': case 'todo': case 'disabled': case 'focused':
      return s;
    default:
      return 'errored';
  }
}

export interface FailureDeps {
  messageUtil?: { separateMessageFromStack?: (s: string) => { message: string; stack: string } };
  prettyFormat?: EnvDeps['prettyFormat'];
}

/** FailureInfo from a Jest failure message (ANSI stripped, frames parsed) plus expect's matcherResult. */
export function toFailureInfo(raw: unknown, detail: unknown, deps: FailureDeps = {}): FailureInfo {
  const clean = stripAnsi(String(raw ?? ''));
  let message: string;
  let stack: string;
  if (deps.messageUtil && typeof deps.messageUtil.separateMessageFromStack === 'function') {
    ({ message, stack } = deps.messageUtil.separateMessageFromStack(clean));
  } else {
    ({ message, stack } = splitMessageStack(clean));
  }
  const info: FailureInfo = { message: message.trim(), frames: parseFrames(stack) };
  if (stack) info.stack = stack;
  const mr = detail && typeof detail === 'object' ? (detail as { matcherResult?: Record<string, unknown> }).matcherResult : undefined;
  if (mr && typeof mr === 'object') {
    if (typeof mr.name === 'string') info.matcherName = mr.name;
    const fmt = (v: unknown) => formatValue(v, deps.prettyFormat, { maxDepth: 8, maxLength: 20000, min: false });
    if ('expected' in mr) info.expected = fmt(mr.expected);
    if ('actual' in mr) info.actual = fmt(mr.actual);
  }
  return info;
}

export function toSnapshotSummary(s: Record<string, any> | undefined): SnapshotSummary | undefined {
  if (!s || typeof s !== 'object') return undefined;
  return {
    added: s.added | 0, matched: s.matched | 0, unmatched: s.unmatched | 0, updated: s.updated | 0, unchecked: s.unchecked | 0,
    uncheckedKeys: Array.isArray(s.uncheckedKeys) ? s.uncheckedKeys.map(String) : [], fileDeleted: !!s.fileDeleted,
  };
}

export function statusOfFile(result: Record<string, any>): FileResultMsg['status'] {
  if (result.testExecError) return 'errored';
  if ((result.numFailingTests | 0) > 0) return 'failed';
  if (result.skipped) return 'skipped';
  return 'passed';
}

/** Maps a config-loading error to an InitError kind. */
export function classifyInitError(e: unknown): { kind: InitErrorKind; message: string; stack?: string } {
  const err = e as { message?: string; stack?: string; code?: string } | undefined;
  const message = String(err?.message ?? e);
  const stack = typeof err?.stack === 'string' ? err.stack : undefined;
  if (/Multiple configurations found/i.test(message)) return { kind: 'multipleConfigs', message, stack };
  if (/ts-node|typescript|\.ts' config|Jest: Failed to parse the TypeScript config|@jest-config-loader|esbuild-register/i.test(message)) {
    return { kind: 'tsLoader', message, stack };
  }
  if (/Cannot find module 'jest|jest-cli|@jest\/core/.test(message) && err?.code === 'MODULE_NOT_FOUND') return { kind: 'jestNotFound', message, stack };
  if (/runner/i.test(message) && /Cannot find module|could not be found/i.test(message)) return { kind: 'runnerUnsupported', message, stack };
  if (/Jest: Failed to parse|Validation Error|configuration|config file|No tests found|rootDir/i.test(message)) return { kind: 'configLoad', message, stack };
  return { kind: 'configLoad', message, stack };
}

// ---------------------------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------------------------

export interface EngineDeps {
  send: Sender;
  log: Logger;
  overlay: OverlayStore;
  /** Called on `invalidate {reason:'config'}`: the process should exit so the pool recycles it. */
  onInvalidateConfig?: () => void;
}

interface ActiveRun {
  runId: string;
  watcher: any;
  ctx: EnvRunContext;
  startedAt: number;
  errors: string[];
}

export class WarmEngine {
  chain?: JestChain;
  private gBase: Record<string, any> = {};
  private configs: Array<Record<string, any>> = [];
  private matchers: ReturnType<typeof createConfigMatchers> = [];
  private readonly contexts = new Map<number, Promise<any>>();
  private contextQueue: Promise<unknown> = Promise.resolve();
  private readonly transformers = new Map<number, Promise<any>>();
  private readonly prunedGeneration = new Map<number, number>();
  private readonly runners = new Map<string, Promise<any>>();
  private seams: Seams = { envWrapper: false, probeTransformer: false, cachePrune: false };
  private envDeps: EnvDeps = {};
  private active?: ActiveRun;
  private runQueue: Promise<unknown> = Promise.resolve();
  private graphCache?: DepGraph;
  private readonly pendingGraphPaths = new Set<string>();
  /** Serialises graph builds (see graph()). */
  private graphChain: Promise<void> = Promise.resolve();
  private readonly warnings: string[] = [];
  private ready = false;

  constructor(private readonly init: InitMsg, private readonly deps: EngineDeps) {}

  get activeRunId(): string | undefined { return this.active?.runId; }
  get isReady(): boolean { return this.ready; }
  get installedSeams(): Seams { return this.seams; }

  private get send(): Sender { return this.deps.send; }
  private get log(): Logger { return this.deps.log; }
  private get flags(): WorkerFlags { return this.init.flags; }

  // ------------------------------------------------------------------ bootstrap

  /** Resolves Jest, reads configs, installs seams, runs globalSetup, sends `ready` (or `initError`). */
  async bootstrap(): Promise<boolean> {
    const t0 = Date.now();
    const { spec, flags } = this.init;
    process.env.JEST_WORKER_ID = String(this.init.slot + 1);

    try {
      this.chain = loadJestChain(spec.packageDir, spec.jestPkgDir);
    } catch (e) {
      this.sendInitError('jestNotFound', `Could not resolve the project's Jest from ${spec.packageDir}: ${(e as Error).message}`, (e as Error).stack);
      return false;
    }
    const chain = this.chain;
    if (majorOf(chain.version) < 29) {
      this.sendInitError('unknown', `Jest ${chain.version} is not supported (HyperJest needs 29 or newer)`);
      return false;
    }
    this.log.info(`jest ${chain.version} at ${chain.dirs.jest}; jest-config ${chain.dirs.config}; jest-runner ${chain.dirs.runner}`);

    const argv: Record<string, unknown> = {
      $0: 'hyperjest', _: [], ci: false, watch: false, watchAll: false,
      ...(spec.configArg ? { config: spec.configArg } : {}),
      ...(spec.cliFilters?.testPathIgnorePatterns?.length ? { testPathIgnorePatterns: spec.cliFilters.testPathIgnorePatterns } : {}),
    };
    let read: { globalConfig: any; configs: any[]; hasDeprecationWarnings: boolean };
    try {
      read = await chain.modules.config.readConfigs(argv, [spec.packageDir]);
    } catch (e) {
      const c = classifyInitError(e);
      this.sendInitError(c.kind, c.message, c.stack);
      return false;
    }
    if (read.hasDeprecationWarnings) this.warnings.push('Jest reported deprecated options in the config');

    this.gBase = buildGlobalConfig(read.globalConfig, flags);
    const kept: Array<Record<string, any>> = [];
    for (const c of read.configs) {
      if (isRunnerSupported(c.runner)) kept.push(stableProjectConfig(c, flags));
      else this.warnings.push(`project "${displayNameOf(c)}" uses runner ${c.runner}; only jest-runner and jest-runner-groups are supported: skipped`);
    }
    if (!kept.length) {
      this.sendInitError('runnerUnsupported', this.warnings.join('\n') || 'no supported Jest project found');
      return false;
    }
    this.configs = kept;
    this.matchers = createConfigMatchers(kept, chain.modules.util.globsToMatcher);
    this.envDeps = { prettyFormat: chain.modules.prettyFormat, traceMapping: chain.modules.traceMapping as TraceMappingLike | undefined };

    try {
      const probe = flags.liveComments ? loadProbeModule() : undefined;
      const probeDeps = chain.modules.babelCore && chain.modules.babelParser
        ? {
          babelCore: chain.modules.babelCore, babelParser: chain.modules.babelParser, convertSourceMap: chain.modules.convertSourceMap,
          traceMapping: chain.modules.traceMapping, probeVersion: PROBE_VERSION,
        }
        : undefined;
      const { seams, transformer } = await installTransformHooks(chain.modules.transform, kept[0], {
        liveComments: flags.liveComments, probe, probeDeps, envDeps: this.envDeps, log: this.log,
      });
      this.seams = seams;
      this.transformers.set(0, Promise.resolve(transformer));
      if (flags.liveComments && !probe) this.warnings.push('live comments (//?) unavailable: probe transformer module not bundled');
      else if (flags.liveComments && !probeDeps) this.warnings.push('live comments (//?) unavailable: @babel/core or @babel/parser not resolvable from the project\'s @jest/transform');
    } catch (e) {
      this.warnings.push(`warm seams unavailable: ${(e as Error).message}`);
    }
    if (!this.seams.envWrapper) this.warnings.push('per-test coverage, console tagging and test locations unavailable (ScriptTransformer.requireAndTranspileModule seam missing): file-level data only');
    if (!this.seams.cachePrune) this.warnings.push('transform cache prune seam missing: overlay edits rely on synthetic mtimes only');
    if (!chain.modules.traceMapping) this.warnings.push('@jridgewell/trace-mapping not resolvable: coverage of transpiled (ts-jest) files stays in generated coordinates');

    if (flags.globalSetup === 'once') await this.runGlobalSetup();

    this.ready = true;
    this.send({
      type: 'ready', jestVersion: chain.version, nodeVersion: process.version,
      configs: kept.map((c, i) => summarizeConfig(c, i)), seams: this.seams, warnings: [...this.warnings], bootstrapMs: Date.now() - t0,
    });
    return true;
  }

  private sendInitError(kind: InitErrorKind, message: string, stack?: string): void {
    this.send({ type: 'initError', kind, message, stack });
  }

  /** globalSetup once per worker lifetime (Jest only runs it from runJest, which we bypass). */
  private async runGlobalSetup(): Promise<void> {
    const seen = new Set<string>();
    const jobs: Array<{ modulePath: string; index: number }> = [];
    this.configs.forEach((cfg, index) => {
      if (typeof cfg.globalSetup === 'string' && cfg.globalSetup && !seen.has(cfg.globalSetup)) { seen.add(cfg.globalSetup); jobs.push({ modulePath: cfg.globalSetup, index }); }
    });
    if (typeof this.gBase.globalSetup === 'string' && this.gBase.globalSetup && !seen.has(this.gBase.globalSetup)) jobs.push({ modulePath: this.gBase.globalSetup, index: 0 });
    for (const job of jobs) {
      const t0 = Date.now();
      try {
        const transformer = await this.getTransformer(job.index);
        const cfg = this.configs[job.index];
        await transformer.requireAndTranspileModule(job.modulePath, async (mod: unknown) => {
          const fn = typeof mod === 'function' ? mod : (mod as { default?: unknown })?.default;
          if (typeof fn !== 'function') throw new TypeError(`globalSetup file must export a function at ${job.modulePath}`);
          await (fn as (g: unknown, p: unknown) => unknown)(this.gBase, cfg);
        });
        this.log.info(`globalSetup ${job.modulePath} ran in ${Date.now() - t0} ms`);
      } catch (e) {
        this.warnings.push(`globalSetup ${job.modulePath} failed: ${(e as Error).message}`);
      }
    }
  }

  // ------------------------------------------------------------------ lazy per-project state

  private getContext(index: number): Promise<any> {
    let p = this.contexts.get(index);
    if (!p) {
      // Cold haste-map builds are serialised: the cache write is non-atomic.
      p = this.contextQueue.then(() => this.createContext(index));
      this.contextQueue = p.catch(() => undefined);
      this.contexts.set(index, p);
      p.catch(() => this.contexts.delete(index));
    }
    return p;
  }

  private async createContext(index: number): Promise<any> {
    const cfg = this.configs[index];
    const t0 = Date.now();
    const ctx = await this.chain!.modules.Runtime.createContext(cfg, { maxWorkers: 1, watchman: false, watch: false });
    this.log.debug(`haste context for "${displayNameOf(cfg)}" built in ${Date.now() - t0} ms (${ctx.hasteFS?.getAllFiles?.().length ?? '?'} files)`);
    return ctx;
  }

  private getTransformer(index: number): Promise<any> {
    let p = this.transformers.get(index);
    if (!p) {
      p = this.chain!.modules.transform.createScriptTransformer(this.configs[index]);
      this.transformers.set(index, p);
    }
    return p;
  }

  private async pruneOverlay(index: number): Promise<void> {
    if (!this.seams.cachePrune) return;
    const since = this.prunedGeneration.get(index) ?? 0;
    const { paths, generation } = this.deps.overlay.changedSince(since);
    this.prunedGeneration.set(index, generation);
    if (!paths.length) return;
    const transformer = await this.getTransformer(index);
    const removed = pruneTransformCache(transformer, paths);
    this.log.trace(`pruned ${removed} transform cache entries for ${paths.length} overlay path(s)`);
  }

  private loadRunner(cfg: Record<string, any>): Promise<any> {
    const key = String(cfg.runner);
    let p = this.runners.get(key);
    if (!p) {
      p = (async () => {
        if (runnerPackageName(key) === 'jest-runner') return this.chain!.modules.runner.default;
        return this.chain!.modules.util.requireOrImportModule(key, true);
      })();
      this.runners.set(key, p);
    }
    return p;
  }

  // ------------------------------------------------------------------ runs

  /** Runs are serialised inside the worker (the host already does, this is belt and braces). */
  run(msg: RunMsg): Promise<void> {
    const p = this.runQueue.then(() => this.runNow(msg));
    this.runQueue = p.catch(() => undefined);
    return p;
  }

  /**
   * Always ends with exactly one `runComplete`, even when something throws before, around or after
   * `runner.runTests` (the host would otherwise wait for the watchdog with the file pinned).
   */
  private async runNow(msg: RunMsg): Promise<void> {
    const startedAt = Date.now();
    const { runId } = msg;
    let watcher: any;
    let active: ActiveRun | undefined;
    const errors: string[] = [];
    try {
      if (!this.ready || !this.chain) { errors.push('worker is not ready'); return; }
      const chain = this.chain;
      watcher = new chain.modules.watcher.TestWatcher({ isWatchMode: true });
      const selections = new Map<string, Set<string> | undefined>();
      for (const t of msg.tests) selections.set(path.resolve(t.path), t.names && t.names.length ? new Set(t.names) : undefined);
      const ctx: EnvRunContext = {
        runId, flags: this.flags, send: this.send,
        selectionFor: p => selections.get(path.resolve(p)),
        cancelled: false, consoleCapturedFiles: new Set(), fileCoverageSent: new Set(),
        onError: (where, err) => this.log.warn(`envWrapper ${where}: ${(err as Error)?.stack ?? String(err)}`),
      };
      active = { runId, watcher, ctx, startedAt, errors };
      this.active = active;
      setRunContext(ctx);
      try { chain.modules.resolve.default.clearDefaultResolverCache(); } catch { /* older resolver without the static */ }
      for (const sel of msg.tests) {
        if (watcher.isInterrupted()) break;
        const testPath = path.resolve(sel.path);
        const index = matchConfigIndex(this.matchers, testPath);
        if (index < 0 || (this.init.spec.scope && !scopeMatches(testPath, this.init.spec.scope.baseDir, this.init.spec.scope.tests))) {
          this.send({ type: 'fileResult', runId, path: testPath, status: 'notMatched', numPassing: 0, numFailing: 0, numPending: 0, numTodo: 0 });
          continue;
        }
        const g = { ...this.gBase, updateSnapshot: msg.updateSnapshot, testNamePattern: sel.names && sel.names.length ? namesToPattern(sel.names) : undefined };
        try {
          await this.runOne(active, { ...sel, path: testPath }, g, index);
        } catch (e) {
          const err = e as Error;
          if (watcher.isInterrupted() && err?.name === 'CancelRun') break;
          errors.push(err?.stack ?? String(e));
          this.send({
            type: 'fileResult', runId, path: testPath, status: 'errored', numPassing: 0, numFailing: 0, numPending: 0, numTodo: 0,
            testExecError: toFailureInfo(err?.stack ?? String(e), undefined, this.failureDeps()),
          });
        }
      }
    } catch (e) {
      errors.push((e as Error)?.stack ?? String(e));
    } finally {
      if (active) {
        setRunContext(undefined);
        if (this.active === active) this.active = undefined;
      }
      let wasInterrupted = false;
      try { wasInterrupted = !!watcher?.isInterrupted(); } catch { /* broken watcher: not interrupted */ }
      try {
        this.send({
          type: 'runComplete', runId, wasInterrupted, durationMs: active ? Date.now() - startedAt : 0, memory: memory(),
          error: errors.length ? errors.join('\n') : undefined,
        });
      } catch (e) {
        this.log.warn(`run ${runId}: could not send runComplete: ${(e as Error)?.message ?? String(e)}`);
      }
    }
  }

  private failureDeps(): FailureDeps {
    return { messageUtil: this.chain?.modules.messageUtil, prettyFormat: this.envDeps.prettyFormat };
  }

  private async runOne(run: ActiveRun, sel: RunTestSelection, g: Record<string, any>, index: number): Promise<void> {
    resetSourceCapture();
    const cfg = this.configs[index];
    const context = await this.getContext(index);
    await this.pruneOverlay(index);
    const Runner = await this.loadRunner(cfg);
    // 3rd argument (runnerOptions) is read by v30 and ignored by v29.
    const runner = new Runner(g, { changedFiles: undefined, sourcesRelatedToTestsInChangedFiles: undefined }, cfg.runnerOptions);
    const { runId, watcher, ctx } = run;
    const testPath = sel.path;
    const streamed = new Set<string>();
    const arrivals = new Map<string, number>();

    const onFileStart = () => this.send({ type: 'fileStart', runId, path: testPath });
    const onCaseStart = (info: any) => this.send({
      type: 'testStart', runId, path: testPath, fullName: String(info?.fullName ?? ''), ancestorTitles: info?.ancestorTitles ?? [], title: String(info?.title ?? ''),
    });
    const onCaseResult = (r: any) => {
      const key = this.keyForStreamed(ctx, testPath, r, arrivals);
      streamed.add(key);
      this.send(this.toTestResult(runId, testPath, r, key));
    };
    const onFileSuccess = (result: any) => this.onFileSuccess(run, testPath, result, streamed);
    const onFileFailure = (err: any) => {
      if (watcher.isInterrupted() && err?.name === 'CancelRun') return;
      this.send({
        type: 'fileResult', runId, path: testPath, status: 'errored', numPassing: 0, numFailing: 0, numPending: 0, numTodo: 0,
        testExecError: toFailureInfo(err?.stack ?? err?.message ?? String(err), undefined, this.failureDeps()),
      });
    };

    const unsubscribe: Array<() => void> = [];
    const tests = [{ path: testPath, context }];
    let promise: Promise<void>;
    if (runner.supportsEventEmitters && typeof runner.on === 'function') {
      const on = (name: string, fn: (args: any[]) => void) => {
        const off = runner.on(name, fn);
        if (typeof off === 'function') unsubscribe.push(off);
      };
      on('test-file-start', () => onFileStart());
      on('test-case-start', ([, info]) => onCaseStart(info));
      on('test-case-result', ([, r]) => onCaseResult(r));
      on('test-file-success', ([, result]) => onFileSuccess(result));
      on('test-file-failure', ([, err]) => onFileFailure(err));
      promise = runner.runTests(tests, watcher, { serial: true });
    } else {
      // Legacy callback runner (CallbackTestRunner).
      promise = runner.runTests(tests, watcher, onFileStart, (_t: unknown, result: any) => onFileSuccess(result), (_t: unknown, err: any) => onFileFailure(err), { serial: true });
    }
    // runTests sets JEST_WORKER_ID='1' synchronously; restore our slot id before any test code runs.
    process.env.JEST_WORKER_ID = String(this.init.slot + 1);
    try {
      await promise;
    } finally {
      for (const off of unsubscribe) { try { off(); } catch { /* ignore */ } }
    }
  }

  /** Exact key from the env wrapper's definition-order dupIndex when available, else arrival order. */
  private keyForStreamed(ctx: EnvRunContext, testPath: string, r: any, arrivals: Map<string, number>): string {
    const fullName = String(r?.fullName ?? '');
    const cur = ctx.current;
    if (cur && cur.testPath === testPath && cur.fullName === fullName) {
      arrivals.set(fullName, cur.dupIndex + 1);
      return cur.testKey;
    }
    const n = arrivals.get(fullName) ?? 0;
    arrivals.set(fullName, n + 1);
    return makeTestKey(testPath, fullName, n);
  }

  private toTestResult(runId: string, testPath: string, r: any, testKey: string): Omit<TestResultMsg, 'v'> {
    const failureMessages: unknown[] = Array.isArray(r?.failureMessages) ? r.failureMessages : [];
    const details: unknown[] = Array.isArray(r?.failureDetails) ? r.failureDetails : [];
    const location = r?.location && typeof r.location.line === 'number' ? { line: r.location.line, column: Number(r.location.column) || 0 } : null;
    const retry: unknown[] | undefined = Array.isArray(r?.retryReasons) && r.retryReasons.length ? r.retryReasons : undefined;
    return {
      type: 'testResult', runId, path: testPath,
      fullName: String(r?.fullName ?? ''), ancestorTitles: Array.isArray(r?.ancestorTitles) ? r.ancestorTitles.map(String) : [], title: String(r?.title ?? ''),
      testKey, status: normalizeStatus(r?.status), duration: typeof r?.duration === 'number' ? r.duration : null, location,
      failures: failureMessages.map((m, i) => toFailureInfo(m, details[i], this.failureDeps())),
      invocations: typeof r?.invocations === 'number' ? r.invocations : 1,
      retryReasons: retry?.map(x => stripAnsi(String((x as { message?: string })?.message ?? x))),
    };
  }

  private onFileSuccess(run: ActiveRun, testPath: string, result: any, streamed: Set<string>): void {
    const { runId, ctx } = run;
    // Results not streamed as events (skipped/pending/todo, or anything the runner did not emit).
    const counts = new Map<string, number>();
    for (const ar of (result?.testResults ?? []) as any[]) {
      const fullName = String(ar?.fullName ?? '');
      const d = counts.get(fullName) ?? 0;
      counts.set(fullName, d + 1);
      const key = makeTestKey(testPath, fullName, d);
      if (!streamed.has(key)) this.send(this.toTestResult(runId, testPath, ar, key));
    }
    const msg: Omit<FileResultMsg, 'v'> = {
      type: 'fileResult', runId, path: testPath, status: statusOfFile(result ?? {}),
      numPassing: result?.numPassingTests | 0, numFailing: result?.numFailingTests | 0, numPending: result?.numPendingTests | 0, numTodo: result?.numTodoTests | 0,
      snapshot: toSnapshotSummary(result?.snapshot),
    };
    if (result?.perfStats) {
      const ps = result.perfStats;
      msg.perfStats = { start: ps.start | 0, end: ps.end | 0, runtime: ps.runtime | 0, slow: !!ps.slow };
    }
    if (result?.testExecError) {
      const te = result.testExecError;
      msg.testExecError = toFailureInfo(te.stack ?? te.message ?? result.failureMessage ?? String(te), undefined, this.failureDeps());
    }
    if (!ctx.consoleCapturedFiles.has(testPath) && Array.isArray(result?.console) && result.console.length) {
      msg.console = result.console.map((entry: { type?: string; message?: string; origin?: string }) => {
        const frame = topUserFrame(entry.origin);
        const level: ConsoleMsg['level'] = levelOfLogType(String(entry.type ?? 'log'));
        return { level, text: stripAnsi(String(entry.message ?? '')), file: frame?.file, line: frame?.line, column: frame?.column };
      });
    }
    // Degraded mode (no env seam) or per-test coverage off: file-level coverage from the raw map, sent
    // before fileResult (documented order: ... fileCoverage -> fileResult).
    if (this.flags.coverage && !ctx.fileCoverageSent.has(testPath) && result?.coverage && typeof result.coverage === 'object') {
      const cov = result.coverage as CoverageMap;
      const files = Object.keys(cov).map(p => {
        const fc = cov[p];
        const revision = ensureCoverageMeta(this.send, fc, this.envDeps.traceMapping);
        return { path: p, revision, hash: coverageHash(fc), hitStmts: hitStatements(fc), hitBranchArms: hitBranchArms(fc) };
      });
      this.send({ type: 'fileCoverage', runId, path: testPath, files });
      ctx.fileCoverageSent.add(testPath);
    }
    this.send(msg);
  }

  // ------------------------------------------------------------------ control messages

  /** Cooperative cancel: stops before the next file and skips the remaining tests of the current one. */
  cancel(runId: string): void {
    const active = this.active;
    if (!active || active.runId !== runId) {
      this.log.trace(`cancel for ${runId} ignored (active: ${active?.runId ?? 'none'})`);
      return;
    }
    active.ctx.cancelled = true;
    try {
      const r = active.watcher.setState({ interrupted: true });
      if (r && typeof r.catch === 'function') r.catch(() => undefined);
    } catch (e) {
      this.log.warn(`cancel: watcher.setState failed: ${(e as Error).message}`);
    }
  }

  applyOverlay(changes: OverlayChange[]): void {
    for (const c of changes) {
      if (c.text === null) this.deps.overlay.delete(c.path);
      else this.deps.overlay.set(c.path, c.text, c.version);
    }
    this.log.trace(`overlay: ${changes.length} change(s), ${this.deps.overlay.size} file(s) overlaid`);
  }

  async invalidate(msg: InvalidateMsg): Promise<void> {
    if (msg.reason === 'config') {
      this.log.info('config invalidated: this worker will exit so the pool can recycle it');
      this.deps.onInvalidateConfig?.();
      return;
    }
    try { this.chain?.modules.resolve.default.clearDefaultResolverCache(); } catch { /* ignore */ }
    // Haste maps are static: rebuild lazily so added/removed files are known to resolvers and SearchSource.
    this.contexts.clear();
    for (const p of msg.paths) this.pendingGraphPaths.add(path.resolve(p));
    this.log.debug(`invalidated ${msg.paths.length} path(s); haste contexts will be rebuilt on next use`);
  }

  /**
   * Builds (or incrementally updates) the static graph. Requests are serialised: the build yields to
   * the event loop, so a second `graph` or an `invalidate{files}` can arrive while it runs. Paths
   * invalidated during a build stay pending for the next request instead of being cleared with it.
   */
  graph(): Promise<void> {
    const next = this.graphChain.then(() => this.graphOnce());
    this.graphChain = next.catch(() => undefined);
    return next;
  }

  private async graphOnce(): Promise<void> {
    if (!this.chain) return;
    const paths = [...this.pendingGraphPaths];
    this.pendingGraphPaths.clear();
    const t0 = Date.now();
    try {
      const entries = await Promise.all(this.configs.map(async (cfg, i) => ({ cfg, context: await this.getContext(i) })));
      if (!this.graphCache) {
        this.graphCache = await buildDepGraph(entries, this.chain);
      } else if (paths.length) {
        await updateDepGraph(this.graphCache, entries, this.chain, paths);
      }
    } catch (e) {
      for (const p of paths) this.pendingGraphPaths.add(p);
      throw e;
    }
    this.log.debug(`dependency graph: ${this.graphCache.forward.size} files, ${this.graphCache.testFiles.size} test files in ${Date.now() - t0} ms`);
    const graph = toGraphResult(this.graphCache);
    if (this.init.spec.scope) graph.testFiles = graph.testFiles.filter(f => scopeMatches(f, this.init.spec.scope!.baseDir, this.init.spec.scope!.tests));
    this.send({ type: 'graphResult', ...graph });
  }

  showConfig(): void {
    this.send({ type: 'showConfigResult', json: JSON.stringify({ globalConfig: this.gBase, configs: this.configs, seams: this.seams }, configJsonReplacer, 2) });
  }

  async listTests(): Promise<void> {
    if (!this.chain) return;
    const files = new Set<string>();
    for (let i = 0; i < this.configs.length; i++) {
      const context = await this.getContext(i);
      const search = new this.chain.modules.core.SearchSource(context);
      for (const f of context.hasteFS.getAllFiles() as string[]) if (search.isTestFilePath(f) && (!this.init.spec.scope || scopeMatches(f, this.init.spec.scope.baseDir, this.init.spec.scope.tests))) files.add(f);
    }
    this.send({ type: 'listTestsResult', files: [...files].sort() });
  }

  /** Called by the entry's uncaughtException/unhandledRejection handlers. */
  noteRuntimeError(err: unknown): void {
    const text = (err as Error)?.stack ?? String(err);
    if (this.active) this.active.errors.push(text);
  }
}

function displayNameOf(cfg: Record<string, any>): string {
  const d = cfg.displayName;
  if (typeof d === 'string') return d;
  if (d && typeof d.name === 'string') return d.name;
  return path.basename(String(cfg.rootDir ?? ''));
}

function memory(): { rss: number; heapUsed: number } {
  const m = process.memoryUsage();
  return { rss: m.rss, heapUsed: m.heapUsed };
}

export type { OutgoingMsg };
