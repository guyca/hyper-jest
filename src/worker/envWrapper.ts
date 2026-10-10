/**
 * Wraps the project's Jest test environment class (jest-environment-node, jsdom, react-native,
 * shono's customNodeEnv, a `@jest-environment` docblock env: whatever `requireAndTranspileModule`
 * returns) in a subclass that observes jest-circus events via `handleTestEvent`. The wrapper is
 * installed through the prototype seam in transformHooks.ts, so the ProjectConfig stays untouched
 * and the user's transform cache is reused byte-for-byte.
 *
 * Responsibilities (plan section "envWrapper"):
 * - `setup`: `state.includeTestLocationInResult = true` (1-based `test()` call-site locations) and a
 *   baseline `__coverage__` snapshot.
 * - `add_test`: force `concurrent = false` on the new test (serial runs make per-test diffs valid)
 *   and record the test's dupIndex in definition order.
 * - `run_start`: files whose module scope executed while loading the test file -> `fileLoad`.
 * - `test_start`: skip when the run was cancelled or a name selection excludes the test
 *   (`test.mode = 'skip'`; circus awaits handlers before reading `mode`), else snapshot counters.
 * - `test_done`: counter diff -> `testCoverage {testKey, files:[{path, stmts}]}`.
 * - `run_finish` / `teardown`: union `fileCoverage` for the file.
 * - Console: wraps the per-file console Jest injects (`context.console` == `global.console`) and
 *   tags entries with the current testKey and the user's call-site frame (source-mapped).
 * - Values: `global.__hj_v(file, line, col, v)` records a pretty-formatted value and returns `v`.
 *
 * Per-run state is a module-level context set by warmEngine before each run.
 * No Jest imports; everything Jest-shaped is injected or read off `this`.
 */
import * as util from 'util';
import { makeTestKey, type ConsoleMsg, type WorkerFlags, type CoverageHit } from '../core/protocol';
import type { OutgoingMsg } from './ipc';
import {
  buildCoverageMeta, coverageHash, diffSnapshots, hitBranchArms, hitStatements, hitFunctions, takeSnapshot,
  type CoverageMap, type CoverageSnapshot, type IstanbulFileCoverage, type TraceMappingLike,
} from './coverageDiff';
import { stripAnsi, topUserFrame } from './stacks';

export interface EnvDeps {
  prettyFormat?: { format: (v: unknown, o?: Record<string, unknown>) => string };
  traceMapping?: TraceMappingLike;
}

export interface CurrentTest {
  testPath: string;
  fullName: string;
  dupIndex: number;
  testKey: string;
}

/** Run-scoped state shared between warmEngine and every environment instance created during the run. */
export interface EnvRunContext {
  runId: string;
  flags: WorkerFlags;
  send: (m: OutgoingMsg) => void;
  /** Full names selected for a test file; undefined = run every test. */
  selectionFor: (testPath: string) => Set<string> | undefined;
  cancelled: boolean;
  /** Identity of the most recently started test (kept until the next test_start) for exact testKeys. */
  current?: CurrentTest;
  /** Test files whose console was captured per test (fileResult.console is then omitted). */
  consoleCapturedFiles: Set<string>;
  /** Test files for which a `fileCoverage` message was already sent (engine fallback skips them). */
  fileCoverageSent: Set<string>;
  onError?: (where: string, err: unknown) => void;
}

let runContext: EnvRunContext | undefined;
export function setRunContext(ctx: EnvRunContext | undefined): void { runContext = ctx; resetMetaSent(); }
export function getRunContext(): EnvRunContext | undefined { return runContext; }

/** Limits (Wallaby-like): keep IPC bounded under chatty tests. */
export const CONSOLE_MAX_PER_TEST = 100;
export const CONSOLE_MAX_PER_FILE = 1000;
export const VALUE_MAX_DEPTH = 5;
export const VALUE_MAX_LENGTH = 8192;
export const VALUE_THROTTLE_PER_MARKER = 50;
export const VALUE_THROTTLE_PER_FILE = 500;
export const VALUE_THROTTLED_DEPTH = 2;
export const VALUE_THROTTLED_LENGTH = 256;
export const VALUE_MAX_PER_FILE = 5000;

/** Events circus dispatches synchronously (`dispatchSync`); our handling must not wait for `super`. */
const SYNC_EVENTS = new Set(['start_describe_definition', 'finish_describe_definition', 'add_hook', 'add_test', 'error']);

/** `coverageMeta` is static per (path, hash): sent once per worker process. */
const metaSent = new Set<string>();
export function resetMetaSent(): void { metaSent.clear(); }

/** Sends `coverageMeta` for an instrumented file unless this process already did. */
export function ensureCoverageMeta(send: (m: OutgoingMsg) => void, fc: IstanbulFileCoverage, traceMapping?: TraceMappingLike): string | undefined {
  if (!fc || typeof fc !== 'object' || !fc.statementMap) return undefined;
  const meta = buildCoverageMeta(fc, traceMapping);
  const key = `${fc.path}\0${meta.revision ?? meta.hash}`;
  if (metaSent.has(key)) return meta.revision;
  try {
    send({ type: 'coverageMeta', ...meta });
    metaSent.add(key);
    return meta.revision;
  } catch (e) {
    runContext?.onError?.('coverageMeta', e);
    return undefined;
  }
}

/** True for a class whose prototype has Jest's mandatory environment methods. */
export function isEnvironmentClass(mod: unknown): boolean {
  if (typeof mod !== 'function') return false;
  const proto = (mod as { prototype?: Record<string, unknown> }).prototype;
  return !!proto && typeof proto.getVmContext === 'function' && typeof proto.setup === 'function';
}

/** Circus `getTestID`: describe titles (root excluded) + test title, joined by single spaces. */
export function fullNameOfTest(test: { name: string; parent?: { name: string; parent?: unknown } | null }): string {
  const names: string[] = [];
  let p = test.parent as { name: string; parent?: unknown } | null | undefined;
  while (p && p.parent) {
    names.unshift(p.name);
    p = p.parent as typeof p;
  }
  names.push(test.name);
  return names.join(' ');
}

export function levelOfLogType(type: string): ConsoleMsg['level'] {
  switch (type) {
    case 'info': case 'warn': case 'error': case 'debug': case 'dir':
      return type;
    default:
      return 'log';
  }
}

export interface FormatOptions { maxDepth: number; maxLength: number; min?: boolean }

/** pretty-format (the project's) with a hard length cap; falls back to util.inspect. Never throws. */
export function formatValue(value: unknown, prettyFormat: EnvDeps['prettyFormat'], opts: FormatOptions): string {
  let text: string;
  try {
    if (prettyFormat && typeof prettyFormat.format === 'function') {
      text = prettyFormat.format(value, { maxDepth: opts.maxDepth, min: opts.min !== false, printFunctionName: false, printBasicPrototype: false });
    } else {
      text = util.inspect(value, { depth: opts.maxDepth, breakLength: Infinity, maxStringLength: opts.maxLength });
    }
  } catch {
    try { text = String(value); } catch { text = '[unprintable]'; }
  }
  if (text.length > opts.maxLength) text = `${text.slice(0, opts.maxLength)}…`;
  return text;
}

interface InstanceState {
  testPath: string;
  deps: EnvDeps;
  baseline?: CoverageSnapshot;
  testSnap?: CoverageSnapshot;
  current?: CurrentTest;
  dupOf: WeakMap<object, number>;
  nameCounts: Map<string, number>;
  consoleCountTest: number;
  consoleCountFile: number;
  valueHits: Map<string, number>;
  valueCountFile: number;
  fileCoverageEmitted: boolean;
  shared: Map<string, CoverageHit>;
  sharedSnap?: CoverageSnapshot;
  trackingComplete: boolean;
}

const stateOf = new WeakMap<object, InstanceState>();

function createInstanceState(testPath: string, deps: EnvDeps): InstanceState {
  return {
    testPath, deps, dupOf: new WeakMap(), nameCounts: new Map(), consoleCountTest: 0, consoleCountFile: 0,
    valueHits: new Map(), valueCountFile: 0, fileCoverageEmitted: false, shared: new Map(), trackingComplete: true,
  };
}

function coverageOf(env: { global?: Record<string, unknown> }): CoverageMap | undefined {
  const cov = env.global?.__coverage__;
  return cov && typeof cov === 'object' ? (cov as CoverageMap) : undefined;
}

// --------------------------------------------------------------------------------------------
// Event handling
// --------------------------------------------------------------------------------------------

function handleEvent(env: any, st: InstanceState, event: any, state: any): void {
  const ctx = runContext;
  switch (event?.name) {
    case 'setup': {
      try { state.includeTestLocationInResult = true; } catch (e) { ctx?.onError?.('includeTestLocationInResult', e); }
      st.baseline = takeSnapshot(coverageOf(env));
      break;
    }
    case 'add_test':
      onAddTest(st, event, state);
      break;
    case 'run_start':
      onRunStart(env, st, ctx);
      break;
    case 'test_start':
      onTestStart(env, st, ctx, event);
      break;
    case 'hook_start':
      if (event.hook?.type === 'beforeAll' || event.hook?.type === 'afterAll') st.sharedSnap = takeSnapshot(coverageOf(env));
      break;
    case 'hook_success':
    case 'hook_failure':
      if (st.sharedSnap) { recordShared(env, st, ctx, st.sharedSnap); st.sharedSnap = undefined; }
      if (event.name === 'hook_failure') st.trackingComplete = false;
      break;
    case 'test_skip':
    case 'test_todo':
      st.current = undefined; st.testSnap = undefined;
      break;
    case 'test_done':
      onTestDone(env, st, ctx);
      break;
    case 'run_finish':
      recordShared(env, st, ctx, st.baseline);
      emitShared(st, ctx);
      emitFileCoverage(env, st, ctx);
      break;
    case 'teardown':
      emitFileCoverage(env, st, ctx);
      break;
    default:
      break;
  }
}

function onAddTest(st: InstanceState, event: any, state: any): void {
  const children: any[] | undefined = state?.currentDescribeBlock?.children;
  if (!children || !children.length) return;
  let test: any;
  for (let i = children.length - 1; i >= 0; i--) {
    const c = children[i];
    if (c && c.type === 'test' && (c.fn === event.fn || c.name === event.testName)) { test = c; break; }
  }
  if (!test) return;
  // Serialise test.concurrent: per-test windows need one test at a time (Wallaby patches the same).
  test.concurrent = false;
  const fullName = fullNameOfTest(test);
  const n = st.nameCounts.get(fullName) ?? 0;
  st.nameCounts.set(fullName, n + 1);
  st.dupOf.set(test, n);
}

function onRunStart(env: any, st: InstanceState, ctx: EnvRunContext | undefined): void {
  if (!ctx || !ctx.flags.coverage) return;
  const cov = coverageOf(env);
  const files = cov ? Object.keys(cov) : [];
  recordShared(env, st, ctx);
  st.baseline = takeSnapshot(cov);
  ctx.send({ type: 'fileLoad', runId: ctx.runId, path: st.testPath, files });
}

/** Shared hooks can load additional sources; empty hits still prove a source was observed. */
function recordShared(env: any, st: InstanceState, ctx: EnvRunContext | undefined, before?: CoverageSnapshot): void {
  if (!ctx || !ctx.flags.coverage) return;
  const cov = coverageOf(env);
  if (!cov) return;
  const changes = before ? new Map(diffSnapshots(before, cov).map(f => [f.path, f])) : undefined;
  for (const [path, fc] of Object.entries(cov)) {
    const revision = ensureCoverageMeta(ctx.send, fc, st.deps.traceMapping);
    const key = `${path}\0${revision ?? coverageHash(fc)}`;
    const prior = st.shared.get(key);
    const hit = changes ? changes.get(path) : { stmts: hitStatements(fc), fns: hitFunctions(fc) };
    st.shared.set(key, { path, revision, hash: coverageHash(fc),
      stmts: [...new Set([...(prior?.stmts ?? []), ...(hit?.stmts ?? [])])],
      fns: [...new Set([...(prior?.fns ?? []), ...(hit?.fns ?? [])])],
    });
  }
}

function emitShared(st: InstanceState, ctx: EnvRunContext | undefined): void {
  if (!ctx || !ctx.flags.coverage) return;
  ctx.send({ type: 'fileLoad', runId: ctx.runId, path: st.testPath,
    files: [...new Set([...st.shared.values()].map(f => f.path))], shared: [...st.shared.values()],
    complete: ctx.flags.perTestCoverage && st.trackingComplete && !ctx.cancelled,
  });
}

function onTestStart(env: any, st: InstanceState, ctx: EnvRunContext | undefined, event: any): void {
  const test = event?.test;
  if (!test || !ctx) return;
  recordShared(env, st, ctx, st.baseline);
  st.baseline = takeSnapshot(coverageOf(env));
  const fullName = fullNameOfTest(test);
  const selection = ctx.selectionFor(st.testPath);
  if (ctx.cancelled || (selection && !selection.has(fullName))) {
    test.mode = 'skip';
    st.current = undefined;
    st.testSnap = undefined;
    return;
  }
  const dupIndex = st.dupOf.get(test) ?? 0;
  const cur: CurrentTest = { testPath: st.testPath, fullName, dupIndex, testKey: makeTestKey(st.testPath, fullName, dupIndex) };
  st.current = cur;
  ctx.current = cur;
  st.consoleCountTest = 0;
  st.testSnap = ctx.flags.coverage && ctx.flags.perTestCoverage ? takeSnapshot(coverageOf(env)) : undefined;
}

function onTestDone(env: any, st: InstanceState, ctx: EnvRunContext | undefined): void {
  const cur = st.current;
  st.current = undefined;
  if (!cur || !ctx) return;
  if (ctx.flags.coverage && ctx.flags.perTestCoverage) {
    const cov = coverageOf(env);
    const files = diffSnapshots(st.testSnap ?? new Map(), cov).map(d => ({ ...d,
      revision: ensureCoverageMeta(ctx.send, cov![d.path], st.deps.traceMapping), hash: coverageHash(cov![d.path]),
    }));
    ctx.send({ type: 'testCoverage', runId: ctx.runId, path: st.testPath, testKey: cur.testKey, files });
  }
  st.testSnap = undefined;
  st.baseline = takeSnapshot(coverageOf(env));
}

function emitFileCoverage(env: any, st: InstanceState, ctx: EnvRunContext | undefined): void {
  if (!ctx || st.fileCoverageEmitted || !ctx.flags.coverage) return;
  st.fileCoverageEmitted = true;
  const cov = coverageOf(env);
  const files = cov
    ? Object.keys(cov).map(p => {
      const fc = cov[p];
      const revision = ensureCoverageMeta(ctx.send, fc, st.deps.traceMapping);
      return { path: p, revision, hash: coverageHash(fc), hitStmts: hitStatements(fc), hitBranchArms: hitBranchArms(fc) };
    })
    : [];
  ctx.send({ type: 'fileCoverage', runId: ctx.runId, path: st.testPath, files });
  ctx.fileCoverageSent.add(st.testPath);
}

// --------------------------------------------------------------------------------------------
// Console and value capture
// --------------------------------------------------------------------------------------------

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'dir'] as const;

function captureConsole(st: InstanceState, type: string, message: string, stack: string | undefined): void {
  const ctx = runContext;
  if (!ctx) return;
  st.consoleCountFile += 1;
  st.consoleCountTest += 1;
  if (st.consoleCountFile > CONSOLE_MAX_PER_FILE || (st.current && st.consoleCountTest > CONSOLE_MAX_PER_TEST)) return;
  const frame = topUserFrame(stack);
  ctx.send({
    type: 'console', runId: ctx.runId, path: st.testPath, testKey: st.current?.testKey, level: levelOfLogType(type),
    text: stripAnsi(message), file: frame?.file, line: frame?.line, column: frame?.column,
  });
}

/**
 * Wraps the console Jest created for this test file. BufferedConsole/CustomConsole funnel every
 * level through `_log(type, message)` (message already util.format'ed); NullConsole (silent) never
 * calls it, which is the desired behaviour. Environments without `_log` get their public methods
 * wrapped instead.
 */
function installConsoleCapture(testConsole: any, st: InstanceState): void {
  if (!testConsole || typeof testConsole !== 'object') return;
  const ctx = runContext;
  if (!ctx) return;
  if (typeof testConsole._log === 'function') {
    const orig = testConsole._log;
    testConsole._log = function hjLog(this: unknown, type: string, message: string) {
      try { captureConsole(st, type, String(message), new Error().stack); } catch (e) { ctx.onError?.('console', e); }
      return orig.call(this, type, message);
    };
  } else {
    for (const level of CONSOLE_METHODS) {
      const orig = testConsole[level];
      if (typeof orig !== 'function') continue;
      testConsole[level] = function hjConsole(this: unknown, ...args: unknown[]) {
        try { captureConsole(st, level, util.format(...args), new Error().stack); } catch (e) { ctx.onError?.('console', e); }
        return orig.apply(this, args);
      };
    }
  }
  ctx.consoleCapturedFiles.add(st.testPath);
}

function recordValue(st: InstanceState, file: string, line: number, column: number, value: unknown): void {
  const ctx = runContext;
  if (!ctx) return;
  const marker = `${file}:${line}:${column}`;
  const hits = (st.valueHits.get(marker) ?? 0) + 1;
  st.valueHits.set(marker, hits);
  st.valueCountFile += 1;
  if (st.valueCountFile > VALUE_MAX_PER_FILE) return;
  const throttled = hits > VALUE_THROTTLE_PER_MARKER || st.valueCountFile > VALUE_THROTTLE_PER_FILE;
  const text = formatValue(value, st.deps.prettyFormat, throttled
    ? { maxDepth: VALUE_THROTTLED_DEPTH, maxLength: VALUE_THROTTLED_LENGTH }
    : { maxDepth: VALUE_MAX_DEPTH, maxLength: VALUE_MAX_LENGTH });
  ctx.send({ type: 'value', runId: ctx.runId, path: st.testPath, testKey: st.current?.testKey, file: String(file), line: Number(line) || 0, column: Number(column) || 0, text });
}

function installValueProbe(global: any, st: InstanceState): void {
  if (!global || (typeof global !== 'object' && typeof global !== 'function')) return;
  const probe = (file: string, line: number, column: number, value: unknown): unknown => {
    try { recordValue(st, file, line, column, value); } catch (e) { runContext?.onError?.('value', e); }
    return value;
  };
  try {
    Object.defineProperty(global, '__hj_v', { value: probe, configurable: true, writable: true, enumerable: false });
  } catch {
    try { global.__hj_v = probe; } catch { /* exotic global: live values unavailable for this env */ }
  }
}

// --------------------------------------------------------------------------------------------
// Class factory
// --------------------------------------------------------------------------------------------

/** One wrapper per base class; `deps` is refreshed on every `wrapEnvironment` call so new instances see the latest. */
const wrappedClasses = new WeakMap<Function, { cls: any; deps: EnvDeps }>();

/** Our handler runs after `super.handleTestEvent` for async events and before it for sync ones. */
function makeHandler(self: any, baseHandle: ((event: any, state: any) => unknown) | undefined) {
  return function handleTestEvent(event: any, state: any): unknown {
    const st = stateOf.get(self);
    const ours = () => { if (st) { try { handleEvent(self, st, event, state); } catch (e) { st.trackingComplete = false; runContext?.onError?.(`event ${event?.name}`, e); } } };
    if (!baseHandle) { ours(); return undefined; }
    if (SYNC_EVENTS.has(event?.name)) { ours(); return baseHandle.call(self, event, state); }
    const r = baseHandle.call(self, event, state);
    if (r && typeof (r as Promise<unknown>).then === 'function') return (r as Promise<unknown>).then(() => { ours(); });
    ours();
    return r;
  };
}

/**
 * Returns a memoised subclass of `Base` (any Jest environment class) that reports per-test data
 * to the current run context. Non-class inputs are returned unchanged.
 */
export function wrapEnvironment(Base: any, deps: EnvDeps): any {
  if (!isEnvironmentClass(Base)) return Base;
  const cached = wrappedClasses.get(Base);
  if (cached) { cached.deps = deps; return cached.cls; }
  const entry: { cls: any; deps: EnvDeps } = { cls: undefined, deps };
  const protoHandle = typeof Base.prototype.handleTestEvent === 'function' ? Base.prototype.handleTestEvent : undefined;

  class HyperJestEnvironment extends (Base as new (...args: any[]) => any) {
    constructor(config: any, context: any) {
      super(config, context);
      const st = createInstanceState(String(context?.testPath ?? ''), entry.deps);
      stateOf.set(this, st);
      // A base class that assigns `handleTestEvent` on the instance would shadow our prototype method.
      if (Object.prototype.hasOwnProperty.call(this, 'handleTestEvent')) {
        const own = (this as any).handleTestEvent;
        Object.defineProperty(this, 'handleTestEvent', {
          value: makeHandler(this, typeof own === 'function' ? own : undefined), configurable: true, writable: true,
        });
      }
      try { installConsoleCapture(context?.console, st); } catch (e) { runContext?.onError?.('console install', e); }
      try { installValueProbe((this as any).global, st); } catch (e) { runContext?.onError?.('value probe install', e); }
    }

    handleTestEvent(event: any, state: any): unknown {
      return makeHandler(this, protoHandle)(event, state);
    }
  }
  try { Object.defineProperty(HyperJestEnvironment, 'name', { value: `HyperJest(${Base.name || 'Environment'})` }); } catch { /* ignore */ }
  entry.cls = HyperJestEnvironment;
  wrappedClasses.set(Base, entry);
  return HyperJestEnvironment;
}
