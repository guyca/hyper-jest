import {
  HYPERJEST_WORKER_SOURCE_RE, isNoiseFrame, parseFrames, parseStackLine, splitMessageStack, stripAnsi, topUserFrame,
} from '../../../src/worker/stacks';

describe('stacks', () => {
  it('strips ANSI escape codes', () => {
    expect(stripAnsi('\u001b[31mred\u001b[39m plain \u001b[1mbold\u001b[22m')).toBe('red plain bold');
  });

  it('parses V8 frame variants', () => {
    expect(parseStackLine('    at Object.toBe (/a/b/math.test.js:32:25)')).toEqual({ file: '/a/b/math.test.js', line: 32, column: 25, functionName: 'Object.toBe' });
    expect(parseStackLine('    at /a/b/c.js:1:2')).toEqual({ file: '/a/b/c.js', line: 1, column: 2 });
    expect(parseStackLine('    at async run (/x/y.js:10:5)')).toEqual({ file: '/x/y.js', line: 10, column: 5, functionName: 'run' });
    expect(parseStackLine('    at new Foo (file:///tmp/foo.mjs:3:4)')).toEqual({ file: '/tmp/foo.mjs', line: 3, column: 4, functionName: 'new Foo' });
    expect(parseStackLine('    at fn (C:\\proj\\a.js:7:8)')).toEqual({ file: 'C:\\proj\\a.js', line: 7, column: 8, functionName: 'fn' });
    expect(parseStackLine('Error: boom')).toBeNull();
    expect(parseStackLine('    at new Promise (<anonymous>)')).toBeNull();
  });

  it('classifies noise frames including our own source-mapped worker modules', () => {
    expect(isNoiseFrame('node:internal/process/task_queues')).toBe(true);
    expect(isNoiseFrame('/p/node_modules/jest-circus/build/run.js')).toBe(true);
    expect(isNoiseFrame('/ext/dist/worker/hyperjestWorker.cjs')).toBe(true);
    expect(isNoiseFrame('/ext/src/worker/envWrapper.ts')).toBe(true);
    expect(HYPERJEST_WORKER_SOURCE_RE.test('/ext/src/worker/stacks.ts')).toBe(true);
    expect(isNoiseFrame('/proj/src/worker/myWorker.ts')).toBe(false);
    expect(isNoiseFrame('/proj/src/lib/greet.js')).toBe(false);
  });

  it('parseFrames drops noise but falls back to all frames when everything is noise', () => {
    const stack = [
      '    at hjLog (/ext/src/worker/envWrapper.ts:311:55)',
      '    at BufferedConsole.log (/p/node_modules/@jest/console/build/BufferedConsole.js:117:10)',
      '    at greet (/proj/src/lib/greet.js:6:11)',
      '    at Object.<anonymous> (/proj/src/__tests__/greet.test.js:5:12)',
      '    at node:internal/main:1:1',
    ].join('\n');
    expect(parseFrames(stack).map(f => `${f.file}:${f.line}`)).toEqual(['/proj/src/lib/greet.js:6', '/proj/src/__tests__/greet.test.js:5']);
    expect(parseFrames('    at x (/p/node_modules/a.js:1:1)')).toEqual([{ file: '/p/node_modules/a.js', line: 1, column: 1, functionName: 'x' }]);
    expect(parseFrames(undefined)).toEqual([]);
    expect(parseFrames('    at rel (relative/path.js:1:1)')).toEqual([]);
    expect(topUserFrame(stack)?.file).toBe('/proj/src/lib/greet.js');
    expect(topUserFrame('    at x (/p/node_modules/a.js:1:1)')).toBeUndefined();
  });

  it('splits message from stack', () => {
    const { message, stack } = splitMessageStack('expect(received).toBe(expected)\n\nExpected: 1\nReceived: 2\n    at Object.toBe (/t.js:3:4)\n    at run (/r.js:1:1)');
    expect(message).toBe('expect(received).toBe(expected)\n\nExpected: 1\nReceived: 2');
    expect(stack.split('\n')).toHaveLength(2);
    expect(splitMessageStack('just a message')).toEqual({ message: 'just a message', stack: '' });
  });
});
