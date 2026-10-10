import * as path from 'path';
import {
  GLOBAL_CONFIG_DELETE, buildGlobalConfig, classifyInitError, createConfigMatchers, isRunnerSupported, matchConfigIndex, namesToPattern,
  normalizeStatus, runnerPackageName, stableProjectConfig, statusOfFile, toFailureInfo, toSnapshotSummary, WarmEngine,
} from '../../../src/worker/warmEngine';
import { PROTOCOL_VERSION, type InitMsg, type WorkerFlags } from '../../../src/core/protocol';
import { noopLogger } from '../../../src/core/logger';
import type { OutgoingMsg } from '../../../src/worker/ipc';

const flags: WorkerFlags = { coverage: true, perTestCoverage: true, liveComments: true, instrumentTestFiles: false, globalSetup: 'once', tsJestDiagnostics: 'keep', trace: false };
// The real jest-util of this repo (same function SearchSource uses).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { globsToMatcher } = require('jest-util') as { globsToMatcher: (g: string[]) => (p: string) => boolean };

describe('warmEngine helpers', () => {
  it('builds a stable in-band GlobalConfig with babel coverage and no reporters', () => {
    const g = buildGlobalConfig({ rootDir: '/r', maxWorkers: 8, watch: true, reporters: [['default', {}]], workerIdleMemoryLimit: 100, bail: 1, collectCoverageFrom: ['src/**'], testPathPattern: '' }, flags);
    expect(g).toMatchObject({ rootDir: '/r', maxWorkers: 1, watch: false, watchAll: false, bail: 0, reporters: [], collectCoverage: true, coverageProvider: 'babel', collectCoverageFrom: [], coverageReporters: [], verbose: false, silent: false });
    for (const k of GLOBAL_CONFIG_DELETE) expect(k in g).toBe(false);
    expect(buildGlobalConfig({}, { ...flags, coverage: false }).collectCoverage).toBe(false);
  });

  it('recognises supported runners from resolved paths', () => {
    expect(runnerPackageName('/r/node_modules/jest-runner/build/index.js')).toBe('jest-runner');
    expect(runnerPackageName('/r/node_modules/@jest/core/node_modules/jest-runner/build/index.js')).toBe('jest-runner');
    expect(runnerPackageName('/r/node_modules/jest-runner-groups/index.js')).toBe('jest-runner-groups');
    expect(runnerPackageName('/r/node_modules/@scope/custom-runner/index.js')).toBe('@scope/custom-runner');
    expect(runnerPackageName('/r/tools/my-runner.js')).toBe('my-runner');
    expect(isRunnerSupported('/r/node_modules/jest-runner/build/index.js')).toBe(true);
    expect(isRunnerSupported('/r/node_modules/jest-runner-eslint/index.js')).toBe(false);
  });

  it('copies project configs, altering them only for opt-in flags', () => {
    const cfg = Object.freeze({ rootDir: '/r', transform: [['^.+\\.ts$', '/r/node_modules/ts-jest/dist/index.js', { isolatedModules: true }], ['\\.js$', '/r/node_modules/babel-jest/build/index.js', {}]], forceCoverageMatch: [] });
    expect(stableProjectConfig(cfg, flags)).toEqual(cfg);
    expect(stableProjectConfig(cfg, flags)).not.toBe(cfg);
    expect(stableProjectConfig(cfg, { ...flags, instrumentTestFiles: true }).forceCoverageMatch).toEqual(['**/*']);
    const off = stableProjectConfig(cfg, { ...flags, tsJestDiagnostics: 'off' });
    expect(off.transform[0][2]).toEqual({ isolatedModules: true, diagnostics: false });
    expect(off.transform[1]).toBe(cfg.transform[1]);
  });

  it('builds an exact-match testNamePattern', () => {
    const p = namesToPattern(['classify classify(-5) -> negative', 'a.b']);
    const re = new RegExp(p, 'i');
    expect(re.test('classify classify(-5) -> negative')).toBe(true);
    expect(re.test('a.b')).toBe(true);
    expect(re.test('axb')).toBe(false);
    expect(re.test('classify classify(-5) -> negative extra')).toBe(false);
  });

  it('maps files to the project whose roots/testMatch/testRegex accept them (longest root wins)', () => {
    const configs = [
      { rootDir: '/r', roots: ['/r/packages'], testMatch: ['**/__tests__/**/*.test.js'], testPathIgnorePatterns: ['/node_modules/'] },
      { rootDir: '/r/packages/a', roots: ['/r/packages/a/src'], testMatch: ['**/*.test.js'], testPathIgnorePatterns: ['/node_modules/', '/e2e/'] },
      { rootDir: '/r/packages/b', roots: ['/r/packages/b'], testMatch: [], testRegex: ['\\.spec\\.ts$'], testPathIgnorePatterns: [] },
    ];
    const m = createConfigMatchers(configs, globsToMatcher);
    expect(matchConfigIndex(m, '/r/packages/a/src/__tests__/x.test.js')).toBe(1);
    expect(matchConfigIndex(m, '/r/packages/a/src/x.test.js')).toBe(1);
    expect(matchConfigIndex(m, '/r/packages/a/src/e2e/x.test.js')).toBe(-1);
    expect(matchConfigIndex(m, '/r/packages/c/__tests__/y.test.js')).toBe(0);
    expect(matchConfigIndex(m, '/r/packages/c/y.test.js')).toBe(-1);
    expect(matchConfigIndex(m, '/r/packages/b/z.spec.ts')).toBe(2);
    expect(matchConfigIndex(m, '/r/packages/b/z.test.ts')).toBe(-1);
    expect(matchConfigIndex(m, '/elsewhere/x.test.js')).toBe(-1);
    expect(matchConfigIndex(m, path.join('/r/packages/a/src', 'x.test.js'))).toBe(1);
  });

  it('converts Jest failure messages into FailureInfo with frames and matcher data', () => {
    const raw = '\u001b[31mexpect(received).toBe(expected)\u001b[39m\n\nExpected: "positiv"\nReceived: "positive"\n    at Object.toBe (/p/src/__tests__/math.test.js:32:25)\n    at Promise.then.completed (/p/node_modules/jest-circus/build/utils.js:298:28)';
    const info = toFailureInfo(raw, { matcherResult: { name: 'toBe', expected: 'positiv', actual: 'positive', pass: false } }, { prettyFormat: { format: v => JSON.stringify(v) } });
    expect(info.message).toBe('expect(received).toBe(expected)\n\nExpected: "positiv"\nReceived: "positive"');
    expect(info.frames).toEqual([{ file: '/p/src/__tests__/math.test.js', line: 32, column: 25, functionName: 'Object.toBe' }]);
    expect(info.matcherName).toBe('toBe');
    expect(info.expected).toBe('"positiv"');
    expect(info.actual).toBe('"positive"');
    expect(info.stack).toContain('at Object.toBe');
    const viaUtil = toFailureInfo('msg\n    at f (/x.js:1:1)', undefined, { messageUtil: { separateMessageFromStack: s => ({ message: 'M:' + s.split('\n')[0], stack: '    at g (/y.js:2:2)' }) } });
    expect(viaUtil.message).toBe('M:msg');
    expect(viaUtil.frames[0].file).toBe('/y.js');
    expect(toFailureInfo(undefined, undefined)).toEqual({ message: '', frames: [] });
  });

  it('maps snapshot summaries, file statuses, test statuses and init errors', () => {
    expect(toSnapshotSummary({ added: 1, matched: 2, unmatched: 0, updated: 0, unchecked: 3, uncheckedKeys: ['k'], fileDeleted: false })).toEqual({ added: 1, matched: 2, unmatched: 0, updated: 0, unchecked: 3, uncheckedKeys: ['k'], fileDeleted: false });
    expect(toSnapshotSummary(undefined)).toBeUndefined();
    expect(statusOfFile({ testExecError: { message: 'x' } })).toBe('errored');
    expect(statusOfFile({ numFailingTests: 2 })).toBe('failed');
    expect(statusOfFile({ numFailingTests: 0, skipped: true })).toBe('skipped');
    expect(statusOfFile({ numFailingTests: 0 })).toBe('passed');
    expect(normalizeStatus('todo')).toBe('todo');
    expect(normalizeStatus('weird')).toBe('errored');
    expect(classifyInitError(new Error('Multiple configurations found: a, b')).kind).toBe('multipleConfigs');
    expect(classifyInitError(new Error("Jest: 'ts-node' is required for the TypeScript configuration files.")).kind).toBe('tsLoader');
    expect(classifyInitError(Object.assign(new Error("Cannot find module 'jest-cli'"), { code: 'MODULE_NOT_FOUND' })).kind).toBe('jestNotFound');
    expect(classifyInitError(new Error('Validation Error: unknown option')).kind).toBe('configLoad');
    expect(classifyInitError('plain string').message).toBe('plain string');
  });
});

describe('WarmEngine run lifecycle', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  function makeEngine(over: Partial<WorkerFlags> = {}) {
    const sent: OutgoingMsg[] = [];
    const init = { v: PROTOCOL_VERSION, type: 'init', spec: {} as any, flags: { ...flags, ...over }, slot: 0, workerAssetsDir: '/x' } as InitMsg;
    const engine = new WarmEngine(init, { send: m => { sent.push(m); }, log: noopLogger, overlay: {} as any });
    return { engine, sent, e: engine as any };
  }
  const runMsg = { v: PROTOCOL_VERSION, type: 'run' as const, runId: 'r1', tests: [{ path: '/p/a.test.js' }], updateSnapshot: 'none' as const };

  it('always sends runComplete with the error when the run throws before runTests', async () => {
    const { engine, sent, e } = makeEngine();
    e.ready = true;
    e.chain = { modules: { watcher: { TestWatcher: class { constructor() { throw new Error('watcher boom'); } } } } };
    await engine.run(runMsg as any);
    const done = sent.filter(m => m.type === 'runComplete');
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ runId: 'r1', wasInterrupted: false });
    expect((done[0] as any).error).toContain('watcher boom');
    expect(engine.activeRunId).toBeUndefined();
  });

  it('sends runComplete when a per-file step outside the file try throws (matcher lookup)', async () => {
    const { engine, sent, e } = makeEngine();
    e.ready = true;
    e.chain = { modules: { watcher: { TestWatcher: class { isInterrupted() { return false; } } }, resolve: { default: {} } } };
    e.matchers = null; // matchConfigIndex throws
    await engine.run(runMsg as any);
    expect(sent.filter(m => m.type === 'runComplete')).toHaveLength(1);
    expect((sent.find(m => m.type === 'runComplete') as any).error).toBeTruthy();
  });

  it('degraded mode sends fileCoverage before fileResult', () => {
    const { sent, e } = makeEngine();
    const ctx = { consoleCapturedFiles: new Set(), fileCoverageSent: new Set() };
    e.onFileSuccess({ runId: 'r1', ctx }, '/p/a.test.js', { numPassingTests: 1, testResults: [], coverage: {} }, new Set());
    expect(sent.map(m => m.type)).toEqual(['fileCoverage', 'fileResult']);
  });
});
