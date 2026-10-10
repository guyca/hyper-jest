import type { CliEvent, CliFileCoverageEvent, CliFileResultEvent, CliRunCompleteEvent, CliTestResultEvent } from '../../../src/core/cliEvents';

/** The reporter is a CommonJS module (module.exports = class); describe its surface locally. */
interface ReporterInstance {
  write(event: CliEvent): void;
  onRunStart(aggregated?: unknown): void;
  onTestFileStart(test: { path: string }): void;
  onTestCaseStart(test: { path: string }, info: unknown): void;
  onTestCaseResult(test: { path: string }, result: unknown): void;
  onTestFileResult(test: { path: string }, result: unknown): void;
  onRunComplete(contexts: unknown, results?: unknown): void;
  getLastError(): Error | undefined;
  traceMapping: TraceMappingLike | null | undefined;
}
interface Fd3WriterInstance { write(line: string): void; finalFlush(): boolean; disabled: boolean; dropped: number; readonly backlog: number }
interface TraceMappingLike {
  TraceMap: new (map: unknown) => unknown;
  originalPositionFor: (tracer: unknown, pos: { line: number; column: number }) => { line: number | null; column: number | null };
}
interface ReporterModule {
  new (globalConfig?: unknown, options?: unknown, context?: unknown): ReporterInstance;
  resolveTraceMapping(entryFile: string | undefined): TraceMappingLike | undefined;
  Fd3Writer: new (fd?: number, writeSync?: (fd: number, buf: Buffer, off: number, len: number) => number) => Fd3WriterInstance;
  version: number;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const HyperJestReporter = require('../../../src/worker/reporter') as ReporterModule;

const PATH = '/repo/src/__tests__/a.test.js';

function capture(): { reporter: ReporterInstance; events: CliEvent[] } {
  const reporter = new HyperJestReporter({}, {}, {});
  const events: CliEvent[] = [];
  reporter.write = e => { events.push(e); };
  return { reporter, events };
}

const assertion = (fullName: string, status = 'passed', invocations = 1) => ({
  ancestorTitles: fullName.split(' ').slice(0, -1), title: fullName.split(' ').slice(-1)[0], fullName, status, duration: 1,
  failureMessages: status === 'failed' ? [`Error: nope\n    at Object.<anonymous> (${PATH}:5:3)`] : [], failureDetails: [], invocations, location: { line: 4, column: 3 },
});

describe('HyperJestReporter', () => {
  it('exports the class as module.exports (what Jest\'s interopRequireDefault expects)', () => {
    expect(typeof HyperJestReporter).toBe('function');
    expect((HyperJestReporter as unknown as { __esModule?: boolean }).__esModule).toBeUndefined();
    expect(HyperJestReporter.version).toBe(1);
  });

  it('streams a full run: dup indices, retries, missed cases, console, coverage, derived success', () => {
    const { reporter, events } = capture();
    reporter.onRunStart({ numTotalTestSuites: 1, startTime: 1000 });
    reporter.onTestFileStart({ path: PATH });
    reporter.onTestCaseStart({ path: PATH }, { ancestorTitles: ['d'], fullName: 'd same', title: 'same', startedAt: 5 });
    reporter.onTestCaseResult({ path: PATH }, assertion('d same'));
    reporter.onTestCaseResult({ path: PATH }, assertion('d same'));
    reporter.onTestCaseResult({ path: PATH }, assertion('d flaky', 'failed', 1));
    reporter.onTestCaseResult({ path: PATH }, assertion('d flaky', 'passed', 2)); // retry: same dupIndex
    reporter.onTestFileResult({ path: PATH }, {
      testFilePath: PATH,
      testResults: [assertion('d same'), assertion('d same'), assertion('d flaky', 'passed', 2), assertion('d missed')],
      numFailingTests: 0, numPassingTests: 4, numPendingTests: 0, numTodoTests: 0, skipped: false,
      snapshot: { added: 0, matched: 1, unmatched: 0, updated: 0, unchecked: 0, uncheckedKeys: [], fileDeleted: false },
      perfStats: { start: 1, end: 2, runtime: 1, slow: false },
      console: [{ type: 'log', message: 'hello', origin: `    at Object.<anonymous> (${PATH}:9:11)` }],
      coverage: { '/repo/src/lib.js': { path: '/repo/src/lib.js', hash: 'h', statementMap: { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 5 } } }, fnMap: {}, branchMap: {}, s: { 0: 1 }, f: {}, b: {} } },
    });
    reporter.onRunComplete([], { numTotalTestSuites: 1, numFailedTestSuites: 0, numRuntimeErrorTestSuites: 0, numTotalTests: 4, numPassedTests: 4, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, startTime: 1000, success: false, wasInterrupted: false, snapshot: { added: 0, failure: false } });

    expect(events.map(e => e.type)).toEqual(['runStart', 'fileStart', 'testStart', 'testResult', 'testResult', 'testResult', 'testResult', 'testResult', 'fileCoverage', 'fileResult', 'runComplete']);
    const results = events.filter((e): e is CliTestResultEvent => e.type === 'testResult');
    expect(results.map(r => [r.fullName, r.dupIndex, r.status, r.invocations])).toEqual([
      ['d same', 0, 'passed', 1], ['d same', 1, 'passed', 1], ['d flaky', 0, 'failed', 1], ['d flaky', 0, 'passed', 2], ['d missed', 0, 'passed', 1],
    ]);
    expect(results[2].failures[0].frames).toEqual([{ file: PATH, line: 5, column: 3, functionName: 'Object.<anonymous>' }]);
    const file = events.find((e): e is CliFileResultEvent => e.type === 'fileResult')!;
    expect(file).toMatchObject({ status: 'passed', numPassing: 4, console: [{ level: 'log', text: 'hello', file: PATH, line: 9, column: 11 }], snapshot: { matched: 1 } });
    const cov = events.find((e): e is CliFileCoverageEvent => e.type === 'fileCoverage')!;
    expect(cov.files[0]).toMatchObject({ path: '/repo/src/lib.js', hash: 'h', hitStmts: [0], stmtStartLine: [1] });
    const done = events.find((e): e is CliRunCompleteEvent => e.type === 'runComplete')!;
    expect(done).toMatchObject({ success: true, wasInterrupted: false, numPassedTests: 4, startTime: 1000 });
    expect(done.memory.rss).toBeGreaterThan(0);
    expect(events.every(e => e.v === 1)).toBe(true);
    expect(reporter.getLastError()).toBeUndefined();
  });

  it('remaps ts-jest coverage lines through inputSourceMap once per (path, hash) and never ships the map', () => {
    const { reporter, events } = capture();
    const constructed: unknown[] = [];
    reporter.traceMapping = {
      TraceMap: class { constructor(map: unknown) { constructed.push(map); } },
      originalPositionFor: (_t, pos) => ({ line: pos.line + 10, column: pos.column }),
    };
    const ts = {
      path: '/repo/src/a.ts', hash: 'ha', inputSourceMap: { version: 3, mappings: '' },
      statementMap: { 0: { start: { line: 3, column: 0 }, end: { line: 4, column: 1 } } },
      fnMap: { 0: { name: 'f', decl: { start: { line: 2, column: 9 }, end: { line: 2, column: 10 } }, loc: { start: { line: 2, column: 0 }, end: { line: 5, column: 1 } } } },
      branchMap: { 0: { type: 'if', loc: { start: { line: 3, column: 0 }, end: { line: 4, column: 1 } }, locations: [{ start: { line: 3, column: 0 }, end: { line: 4, column: 1 } }, { start: { line: 3, column: 0 }, end: { line: 4, column: 1 } }] } },
      s: { 0: 1 }, f: { 0: 1 }, b: { 0: [1, 0] },
    };
    const js = { path: '/repo/src/b.js', hash: 'hb', statementMap: { 0: { start: { line: 7, column: 0 }, end: { line: 7, column: 5 } } }, fnMap: {}, branchMap: {}, s: { 0: 1 }, f: {}, b: {} };
    const fileResult = (testFilePath: string) => ({ testFilePath, testResults: [], numFailingTests: 0, numPassingTests: 1, numPendingTests: 0, numTodoTests: 0, coverage: { [ts.path]: ts, [js.path]: js } });
    reporter.onTestFileResult({ path: PATH }, fileResult(PATH));
    reporter.onTestFileResult({ path: '/repo/src/__tests__/b.test.js' }, fileResult('/repo/src/__tests__/b.test.js'));
    const covs = events.filter((e): e is CliFileCoverageEvent => e.type === 'fileCoverage');
    expect(covs).toHaveLength(2);
    for (const cov of covs) {
      const [a, b] = cov.files;
      expect(a).toMatchObject({ path: ts.path, stmtStartLine: [13], stmtEndLine: [14], fnDeclLine: [12], branchArms: [0, 0, 13, 0, 1, 13], hitStmts: [0], hitBranchArms: [0, 0], hasInputSourceMap: true, remapped: true });
      expect(a.inputSourceMap).toBeUndefined();
      expect(b).toMatchObject({ path: js.path, stmtStartLine: [7], hasInputSourceMap: false });
      expect(b.remapped).toBeUndefined();
    }
    expect(constructed).toHaveLength(1);
  });

  it('leaves coverage unremapped when trace-mapping is unavailable', () => {
    const { reporter, events } = capture();
    reporter.traceMapping = null;
    reporter.onTestFileResult({ path: PATH }, {
      testFilePath: PATH, testResults: [], numFailingTests: 0, numPassingTests: 1, numPendingTests: 0, numTodoTests: 0,
      coverage: { '/repo/src/a.ts': { path: '/repo/src/a.ts', hash: 'h', inputSourceMap: { version: 3 }, statementMap: { 0: { start: { line: 3, column: 0 }, end: { line: 3, column: 5 } } }, fnMap: {}, branchMap: {}, s: { 0: 1 }, f: {}, b: {} } },
    });
    const cov = events.find((e): e is CliFileCoverageEvent => e.type === 'fileCoverage')!;
    expect(cov.files[0]).toMatchObject({ stmtStartLine: [3], hasInputSourceMap: true });
    expect(cov.files[0].remapped).toBeUndefined();
  });

  it('resolves the trace-mapping of the running Jest from its bin file', () => {
    const tm = HyperJestReporter.resolveTraceMapping(require('path').join(__dirname, '../../../node_modules/jest/bin/jest.js'));
    expect(typeof tm?.TraceMap).toBe('function');
    expect(typeof tm?.originalPositionFor).toBe('function');
    expect(HyperJestReporter.resolveTraceMapping(undefined)).toBeUndefined();
    expect(HyperJestReporter.resolveTraceMapping('/nonexistent/dir/jest.js')).toBeUndefined();
  });

  it('reports exec errors and keeps success false when suites failed', () => {
    const { reporter, events } = capture();
    reporter.onTestFileResult({ path: PATH }, { testFilePath: PATH, testResults: [], numFailingTests: 0, numPassingTests: 0, numPendingTests: 0, numTodoTests: 0, testExecError: { message: 'Cannot find module', stack: `Error: Cannot find module\n    at Object.<anonymous> (${PATH}:1:1)` }, failureMessage: '● Test suite failed to run' });
    reporter.onRunComplete([], { numTotalTestSuites: 1, numFailedTestSuites: 1, numRuntimeErrorTestSuites: 1, numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, startTime: Date.now(), success: false, wasInterrupted: false, snapshot: {} });
    const file = events.find((e): e is CliFileResultEvent => e.type === 'fileResult')!;
    expect(file.status).toBe('errored');
    expect(file.testExecError).toMatchObject({ message: 'Cannot find module', frames: [{ file: PATH, line: 1, column: 1 }] });
    expect((events.find(e => e.type === 'runComplete') as CliRunCompleteEvent).success).toBe(false);
  });

  it('never throws into Jest: hook failures become reporterError events', () => {
    const { reporter, events } = capture();
    expect(() => reporter.onTestCaseResult({ path: PATH }, null)).not.toThrow();
    expect(() => reporter.onTestFileResult({ path: PATH }, undefined)).not.toThrow();
    expect(events.map(e => e.type)).toEqual(['reporterError', 'reporterError']);
    expect(events[0]).toMatchObject({ hook: 'onTestCaseResult' });
  });
});

describe('Fd3Writer', () => {
  type WriteSync = (fd: number, buf: Buffer, off: number, len: number) => number;
  const errno = (code: string) => Object.assign(new Error(code), { code });

  it('writes whole lines, handling partial writes', () => {
    const out: string[] = [];
    const writeSync: WriteSync = (_fd, buf, off, len) => { const n = Math.min(len, 4); out.push(buf.subarray(off, off + n).toString()); return n; };
    const w = new HyperJestReporter.Fd3Writer(3, writeSync);
    w.write('{"type":"x"}\n');
    expect(out.join('')).toBe('{"type":"x"}\n');
    expect(w.backlog).toBe(0);
  });

  it('buffers on EAGAIN and delivers the backlog in order', () => {
    const out: string[] = [];
    let fail = 2;
    const writeSync: WriteSync = (_fd, buf, off, len) => { if (fail-- > 0) throw errno('EAGAIN'); out.push(buf.subarray(off, off + len).toString()); return len; };
    const w = new HyperJestReporter.Fd3Writer(3, writeSync);
    w.write('a\n');
    expect(w.backlog).toBe(1);
    w.write('b\n');
    w.write('c\n');
    expect(out.join('')).toBe('a\nb\nc\n');
    expect(w.disabled).toBe(false);
  });

  it('goes silent on EBADF/EPIPE and makes one final attempt', () => {
    const out: string[] = [];
    let dead = true;
    const writeSync: WriteSync = (_fd, buf, off, len) => { if (dead) throw errno('EBADF'); out.push(buf.subarray(off, off + len).toString()); return len; };
    const w = new HyperJestReporter.Fd3Writer(3, writeSync);
    w.write('a\n');
    w.write('b\n');
    expect(w.disabled).toBe(true);
    expect(out).toEqual([]);
    expect(w.finalFlush()).toBe(false); // still dead
    dead = false;
    expect(w.finalFlush()).toBe(true);
    expect(out.join('')).toBe('a\nb\n');
  });

  it('bounds the backlog', () => {
    const writeSync: WriteSync = () => { throw errno('EPIPE'); };
    const w = new HyperJestReporter.Fd3Writer(3, writeSync);
    const big = `${'x'.repeat(1024 * 1024)}\n`;
    for (let i = 0; i < 20; i++) w.write(big);
    expect(w.dropped).toBeGreaterThan(0);
    expect(w.backlog).toBeLessThan(20);
  });
});
