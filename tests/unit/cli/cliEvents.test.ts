import {
  CLI_EVENTS_VERSION,
  assertionToTestResultEvent,
  consoleEntriesFromBuffer,
  coverageMapToEvent,
  createDupIndexer,
  createNdjsonSplitter,
  failureInfoFromError,
  failureInfoFromMessage,
  fileStatusOf,
  flattenIstanbulFile,
  parseCliEventLine,
  parseCliEvents,
  parseStackFrames,
  splitMessageAndStack,
  testResultToFileResultEvent,
  toWorkerToHost,
  type CliEvent,
  type CliFileCoverageEvent,
  type CliTestResultEvent,
  type IstanbulFileCoverageLike,
} from '../../../src/core/cliEvents';
import { PROTOCOL_VERSION, makeTestKey, type CoverageMetaMsg, type FileCoverageMsg, type FileResultMsg, type TestResultMsg } from '../../../src/core/protocol';

const TEST = '/repo/src/__tests__/a.test.js';

describe('NDJSON parsing', () => {
  it('parses known events and rejects everything else', () => {
    expect(parseCliEventLine('{"v":1,"type":"fileStart","path":"/x"}')).toEqual({ v: 1, type: 'fileStart', path: '/x' });
    expect(parseCliEventLine('﻿{"v":1,"type":"fileStart","path":"/x"}\r')).toMatchObject({ type: 'fileStart' });
    expect(parseCliEventLine('')).toBeUndefined();
    expect(parseCliEventLine('   ')).toBeUndefined();
    expect(parseCliEventLine('not json')).toBeUndefined();
    expect(parseCliEventLine('{"type":')).toBeUndefined();
    expect(parseCliEventLine('[1,2]')).toBeUndefined();
    expect(parseCliEventLine('{"type":"somethingElse"}')).toBeUndefined();
    expect(parseCliEventLine('{"noType":true}')).toBeUndefined();
  });

  it('splits chunks that break lines and multi-byte characters', () => {
    const events: CliEvent[] = [];
    const rejected: string[] = [];
    const splitter = createNdjsonSplitter(e => events.push(e), l => rejected.push(l));
    const line1 = JSON.stringify({ v: 1, type: 'overlayWriteBlocked', path: '/tmp/é.js' });
    const line2 = JSON.stringify({ v: 1, type: 'fileStart', path: '/x' });
    const bytes = Buffer.from(`${line1}\ngarbage\n${line2}\n{"type":"runComplete"}`, 'utf8');
    const cut = bytes.indexOf(Buffer.from('é', 'utf8')) + 1; // inside the 2-byte character
    splitter.push(bytes.subarray(0, cut));
    expect(events).toHaveLength(0);
    splitter.push(bytes.subarray(cut, cut + 30));
    splitter.push(bytes.subarray(cut + 30));
    expect(events.map(e => e.type)).toEqual(['overlayWriteBlocked', 'fileStart']);
    expect((events[0] as { path: string }).path).toBe('/tmp/é.js');
    expect(rejected).toEqual(['garbage']);
    splitter.end(); // trailing partial line without newline is delivered
    expect(events.map(e => e.type)).toEqual(['overlayWriteBlocked', 'fileStart', 'runComplete']);
    expect(splitter.rejected).toBe(1);
  });

  it('concatenates a long line once, not once per chunk', () => {
    const events: CliEvent[] = [];
    const splitter = createNdjsonSplitter(e => events.push(e));
    const big = JSON.stringify({ v: 1, type: 'fileStart', path: `/${'x'.repeat(200_000)}` });
    const bytes = Buffer.from(`${big}\n${big}`, 'utf8');
    const concat = jest.spyOn(Buffer, 'concat');
    try {
      for (let i = 0; i < bytes.length; i += 1024) splitter.push(bytes.subarray(i, i + 1024));
      expect(events).toHaveLength(1);
      splitter.end();
      expect(events).toHaveLength(2);
      expect(concat).toHaveBeenCalledTimes(2);
    } finally {
      concat.mockRestore();
    }
    expect((events[1] as { path: string }).path).toHaveLength(200_001);
  });

  it('never aliases the caller\'s chunk for the pending remainder', () => {
    const events: CliEvent[] = [];
    const splitter = createNdjsonSplitter(e => events.push(e));
    const chunk = Buffer.from('{"v":1,"type":"fileStart","path":"/a"}', 'utf8');
    splitter.push(chunk);
    chunk.fill(0x20);
    splitter.push('\n');
    expect(events.map(e => (e as { path: string }).path)).toEqual(['/a']);
  });

  it('parseCliEvents skips invalid lines', () => {
    expect(parseCliEvents('{"v":1,"type":"fileStart","path":"/a"}\n\nnope\n{"v":1,"type":"fileStart","path":"/b"}').map(e => (e as { path: string }).path)).toEqual(['/a', '/b']);
  });
});

describe('stack and failure parsing', () => {
  const STACK = [
    'Error: expect(received).toBe(expected) // Object.is equality',
    '',
    'Expected: "positiv"',
    'Received: "positive"',
    '    at Object.<anonymous> (/repo/src/__tests__/a.test.js:32:25)',
    '    at Promise.then.completed (/repo/node_modules/jest-circus/build/utils.js:298:28)',
    '    at new Promise (<anonymous>)',
    '    at async run (/repo/node_modules/jest-circus/build/run.js:24:3)',
    '    at node:internal/process/task_queues:95:5',
    '    at helper (/repo/src/helper.js:3:7)',
    '    at file:///repo/src/esm%20dir/mod.mjs:9:11',
    '    at /repo/src/anon.js:1:2',
  ].join('\n');

  it('parses frames, dropping node and jest internals', () => {
    expect(parseStackFrames(STACK)).toEqual([
      { file: '/repo/src/__tests__/a.test.js', line: 32, column: 25, functionName: 'Object.<anonymous>' },
      { file: '/repo/src/helper.js', line: 3, column: 7, functionName: 'helper' },
      { file: '/repo/src/esm dir/mod.mjs', line: 9, column: 11 },
      { file: '/repo/src/anon.js', line: 1, column: 2 },
    ]);
    expect(parseStackFrames(STACK, { keepInternals: true })).toHaveLength(6);
    expect(parseStackFrames(undefined)).toEqual([]);
  });

  it('separates the message from the stack like jest-message-util', () => {
    const { message, stack } = splitMessageAndStack(STACK);
    expect(message).toBe('expect(received).toBe(expected) // Object.is equality\n\nExpected: "positiv"\nReceived: "positive"');
    expect(stack.startsWith('    at Object.<anonymous>')).toBe(true);
    expect(splitMessageAndStack('TypeError: x is not a function\n    at f (/a.js:1:1)').message).toBe('TypeError: x is not a function');
    expect(splitMessageAndStack('just a message')).toEqual({ message: 'just a message', stack: '' });
  });

  it('builds FailureInfo from failureMessages + failureDetails', () => {
    const info = failureInfoFromMessage(`\u001b[1m${STACK}\u001b[22m`, { matcherResult: { name: 'toBe', expected: 'positiv', actual: { deep: [1, 2] }, pass: false } });
    expect(info.message.startsWith('expect(received).toBe(expected)')).toBe(true);
    expect(info.message).not.toContain('\u001b');
    expect(info.frames[0]).toEqual({ file: '/repo/src/__tests__/a.test.js', line: 32, column: 25, functionName: 'Object.<anonymous>' });
    expect(info.matcherName).toBe('toBe');
    expect(info.expected).toBe('positiv');
    expect(info.actual).toBe(JSON.stringify({ deep: [1, 2] }, null, 2));
    expect(info.stack).toContain('jest-circus'); // raw stack kept verbatim
  });

  it('builds FailureInfo from a SerializableError', () => {
    const info = failureInfoFromError({ message: 'Cannot find module \'./nope\'', stack: 'Error: Cannot find module \'./nope\'\n    at Object.<anonymous> (/repo/src/__tests__/a.test.js:1:15)' });
    expect(info.message).toBe("Cannot find module './nope'");
    expect(info.frames).toEqual([{ file: '/repo/src/__tests__/a.test.js', line: 1, column: 15, functionName: 'Object.<anonymous>' }]);
    expect(failureInfoFromError(undefined, 'fallback').message).toBe('fallback');
  });
});

describe('dup indexer and test results', () => {
  it('numbers duplicate names and keeps the index across retries', () => {
    const dup = createDupIndexer();
    expect(dup.next('a b', 1)).toBe(0);
    expect(dup.next('a b', 1)).toBe(1);
    expect(dup.next('a b', 2)).toBe(1); // retry of the previous attempt, not a new duplicate
    expect(dup.next('a b', 3)).toBe(1);
    expect(dup.next('other', 1)).toBe(0);
    expect(dup.next('a b', 1)).toBe(2);
    dup.reset();
    expect(dup.next('a b', 1)).toBe(0);
  });

  it('converts an assertion result', () => {
    const ev = assertionToTestResultEvent(TEST, {
      ancestorTitles: ['classify'], title: 'positive', fullName: 'classify positive', status: 'failed', duration: 3,
      failureMessages: ['Error: boom\n    at Object.<anonymous> (/repo/src/__tests__/a.test.js:32:25)'],
      failureDetails: [{ matcherResult: { name: 'toBe', expected: 1, actual: 2 } }], invocations: 1, location: { line: 31, column: 3 },
    }, 1);
    expect(ev).toMatchObject({ v: CLI_EVENTS_VERSION, type: 'testResult', testKey: makeTestKey(TEST, 'classify positive', 1), dupIndex: 1, status: 'failed', duration: 3, location: { line: 31, column: 3 }, invocations: 1 });
    expect(ev.failures[0]).toMatchObject({ message: 'boom', matcherName: 'toBe', expected: '1', actual: '2' });
    const minimal = assertionToTestResultEvent(TEST, { ancestorTitles: [], title: 't', fullName: 't', status: 'weird', failureMessages: [] }, 0);
    expect(minimal).toMatchObject({ status: 'errored', duration: null, location: null, invocations: 1, failures: [] });
  });

  it('maps console buffers with their origin frame', () => {
    const entries = consoleEntriesFromBuffer([
      { type: 'log', message: 'greeting \u001b[33mworld\u001b[39m', origin: '    at greet (/repo/src/lib/greet.js:6:11)\n    at Object.<anonymous> (/repo/src/__tests__/a.test.js:5:12)' },
      { type: 'dirxml', message: 'x', origin: '' },
      { type: 'assert', message: 'y', origin: 'at node:internal/x:1:1' },
    ]);
    expect(entries).toEqual([
      { level: 'log', text: 'greeting world', file: '/repo/src/lib/greet.js', line: 6, column: 11 },
      { level: 'dir', text: 'x' },
      { level: 'error', text: 'y' },
    ]);
    expect(consoleEntriesFromBuffer(undefined)).toEqual([]);
  });
});

describe('coverage flattening', () => {
  const fc: IstanbulFileCoverageLike = {
    path: '/repo/src/lib/math.js',
    statementMap: { 0: { start: { line: 2, column: 2 }, end: { line: 2, column: 15 } }, 2: { start: { line: 6, column: 2 }, end: { line: 8, column: 3 } } },
    fnMap: { 0: { decl: { start: { line: 1, column: 9 } } } },
    branchMap: { 0: { locations: [{ start: { line: 6, column: 2 } }, { start: { line: 6, column: 2 } }] } },
    s: { 0: 3, 2: 0 },
    f: { 0: 3 },
    b: { 0: [3, 0] },
  };

  it('produces dense arrays, hit ids and branch arms', () => {
    const flat = flattenIstanbulFile(fc);
    expect(flat).toMatchObject({
      path: '/repo/src/lib/math.js', stmtStartLine: [2, 0, 6], stmtEndLine: [2, 0, 8], fnDeclLine: [1],
      branchArms: [0, 0, 6, 0, 1, 6], hitStmts: [0], hitBranchArms: [0, 0], hasInputSourceMap: false,
    });
    expect(flat.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(flat.inputSourceMap).toBeUndefined();
    expect(flattenIstanbulFile({ ...fc, hash: 'abc', inputSourceMap: { version: 3 } })).toMatchObject({ hash: 'abc', hasInputSourceMap: true, inputSourceMap: { version: 3 } });
    expect(flattenIstanbulFile({ ...fc, inputSourceMap: { version: 3 } }, { includeInputSourceMap: false }).inputSourceMap).toBeUndefined();
  });

  it('builds a fileCoverage event and skips malformed entries', () => {
    const ev = coverageMapToEvent(TEST, { '/repo/src/lib/math.js': fc, '/bad': {} as IstanbulFileCoverageLike });
    expect(ev?.files.map(f => f.path)).toEqual(['/repo/src/lib/math.js']);
    expect(coverageMapToEvent(TEST, undefined)).toBeUndefined();
    expect(coverageMapToEvent(TEST, {})).toBeUndefined();
  });
});

describe('file results', () => {
  const base = { testFilePath: TEST, testResults: [], numFailingTests: 0, numPassingTests: 2, numPendingTests: 0, numTodoTests: 0, perfStats: { start: 1, end: 5, runtime: 4, slow: false } };

  it('derives the status', () => {
    expect(fileStatusOf({ ...base, testExecError: { message: 'x' } })).toBe('errored');
    expect(fileStatusOf({ ...base, numFailingTests: 1 })).toBe('failed');
    expect(fileStatusOf({ ...base, numPassingTests: 0, numPendingTests: 2 })).toBe('skipped');
    expect(fileStatusOf({ ...base, skipped: true })).toBe('skipped');
    expect(fileStatusOf(base)).toBe('passed');
  });

  it('converts a TestResult with console, snapshot and exec error', () => {
    const ev = testResultToFileResultEvent({
      ...base, numPassingTests: 0, testExecError: { message: 'Test suite failed to run', stack: 'Error: Test suite failed to run\n    at Object.<anonymous> (/repo/src/__tests__/a.test.js:1:1)' },
      failureMessage: '\u001b[31m● Test suite failed to run\u001b[39m', snapshot: { added: 1, matched: 2, unmatched: 0, updated: 0, unchecked: 1, uncheckedKeys: ['k'], fileDeleted: false },
      console: [{ type: 'warn', message: 'careful', origin: '    at f (/repo/src/x.js:2:3)' }], displayName: { name: 'unit' },
    });
    expect(ev.status).toBe('errored');
    expect(ev.testExecError).toMatchObject({ message: 'Test suite failed to run', frames: [{ file: TEST, line: 1, column: 1 }] });
    expect(ev.snapshot).toEqual({ added: 1, matched: 2, unmatched: 0, updated: 0, unchecked: 1, uncheckedKeys: ['k'], fileDeleted: false });
    expect(ev.console).toEqual([{ level: 'warn', text: 'careful', file: '/repo/src/x.js', line: 2, column: 3 }]);
    expect(ev.failureMessage).toBe('● Test suite failed to run');
    expect(ev.displayName).toBe('unit');
    expect(ev.perfStats).toEqual({ start: 1, end: 5, runtime: 4, slow: false });
  });
});

describe('toWorkerToHost', () => {
  const runId = 'run-1';

  it('maps testResult / fileStart / testStart', () => {
    const tr: CliTestResultEvent = assertionToTestResultEvent(TEST, { ancestorTitles: ['a'], title: 'b', fullName: 'a b', status: 'passed', failureMessages: [], retryReasons: ['flaky'] }, 0);
    const [msg] = toWorkerToHost(tr, runId) as TestResultMsg[];
    expect(msg).toMatchObject({ v: PROTOCOL_VERSION, type: 'testResult', runId, path: TEST, testKey: makeTestKey(TEST, 'a b', 0), status: 'passed', retryReasons: ['flaky'] });
    expect((msg as unknown as { dupIndex?: number }).dupIndex).toBeUndefined();
    expect(toWorkerToHost({ v: 1, type: 'fileStart', path: TEST }, runId)).toEqual([{ v: PROTOCOL_VERSION, type: 'fileStart', runId, path: TEST }]);
    expect(toWorkerToHost({ v: 1, type: 'testStart', path: TEST, fullName: 'a b', ancestorTitles: ['a'], title: 'b', startedAt: 1 }, runId)).toEqual([{ v: PROTOCOL_VERSION, type: 'testStart', runId, path: TEST, fullName: 'a b', ancestorTitles: ['a'], title: 'b' }]);
    expect(toWorkerToHost({ v: 1, type: 'runStart', numTotalTestSuites: 1, startTime: 0, pid: 1 }, runId)).toEqual([]);
  });

  it('maps fileResult with console entries', () => {
    const ev = testResultToFileResultEvent({ testFilePath: TEST, testResults: [], numFailingTests: 1, numPassingTests: 0, numPendingTests: 0, numTodoTests: 0, console: [{ type: 'log', message: 'hi', origin: '' }] });
    const [msg] = toWorkerToHost(ev, runId) as FileResultMsg[];
    expect(msg).toMatchObject({ v: PROTOCOL_VERSION, type: 'fileResult', runId, path: TEST, status: 'failed', numFailing: 1, console: [{ level: 'log', text: 'hi' }] });
    expect(msg.perfStats).toEqual({ start: 0, end: 0, runtime: 0, slow: false });
  });

  it('expands fileCoverage into coverageMeta messages plus one fileCoverage', () => {
    const ev: CliFileCoverageEvent = {
      v: 1, type: 'fileCoverage', path: TEST,
      files: [{ path: '/repo/src/a.ts', hash: 'h1', stmtStartLine: [1, 2], stmtEndLine: [1, 3], fnDeclLine: [1], branchArms: [0, 0, 2], hitStmts: [0], hitBranchArms: [], hasInputSourceMap: true, inputSourceMap: { version: 3 } }],
    };
    const msgs = toWorkerToHost(ev, runId);
    expect(msgs.map(m => m.type)).toEqual(['coverageMeta', 'fileCoverage']);
    expect(msgs[0] as CoverageMetaMsg).toEqual({ v: PROTOCOL_VERSION, type: 'coverageMeta', path: '/repo/src/a.ts', hash: 'h1', stmtStartLine: [1, 2], stmtEndLine: [1, 3], fnDeclLine: [1], branchArms: [0, 0, 2], remapped: false });
    expect(msgs[1] as FileCoverageMsg).toEqual({ v: PROTOCOL_VERSION, type: 'fileCoverage', runId, path: TEST, files: [{ path: '/repo/src/a.ts', hash: 'h1', hitStmts: [0], hitBranchArms: [] }] });
    // Lines the reporter already remapped are flagged as such.
    const remapped = toWorkerToHost({ ...ev, files: [{ ...ev.files[0], remapped: true }] }, runId);
    expect((remapped[0] as CoverageMetaMsg).remapped).toBe(true);
  });

  it('maps runComplete and preload events', () => {
    const complete = toWorkerToHost({
      v: 1, type: 'runComplete', wasInterrupted: true, success: false, numTotalTestSuites: 1, numFailedTestSuites: 0, numRuntimeErrorTestSuites: 1, numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
      snapshot: { added: 0, matched: 0, unmatched: 0, updated: 0, unchecked: 0, filesAdded: 0, filesRemoved: 0, filesUnmatched: 0, filesUpdated: 0, failure: false, didUpdate: false },
      startTime: 0, durationMs: 12, memory: { rss: 1, heapUsed: 2 }, runExecError: { message: 'boom', frames: [] },
    }, runId);
    expect(complete).toEqual([{ v: PROTOCOL_VERSION, type: 'runComplete', runId, wasInterrupted: true, durationMs: 12, memory: { rss: 1, heapUsed: 2 }, error: 'boom' }]);
    expect(toWorkerToHost({ v: 1, type: 'overlayWriteBlocked', path: '/x' }, runId)).toEqual([{ v: PROTOCOL_VERSION, type: 'overlayWriteBlocked', path: '/x' }]);
    expect(toWorkerToHost({ v: 1, type: 'overlayApplied', manifest: '/m', version: 2, files: 3 }, runId)).toMatchObject([{ type: 'log', level: 'debug' }]);
    expect(toWorkerToHost({ v: 1, type: 'overlayError', message: 'bad' }, runId)).toMatchObject([{ type: 'log', level: 'warn', text: 'overlay not applied: bad' }]);
    expect(toWorkerToHost({ v: 1, type: 'reporterError', hook: 'onRunStart', message: 'x' }, runId)).toMatchObject([{ type: 'log', level: 'warn' }]);
  });
});
