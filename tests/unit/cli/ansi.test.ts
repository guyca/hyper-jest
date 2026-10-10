import { stripAnsi, hasAnsi } from '../../../src/core/ansi';

describe('ansi', () => {
  it('strips CSI colour sequences (chalk output)', () => {
    expect(stripAnsi('\u001b[31mexpect(\u001b[39m\u001b[1mreceived\u001b[22m).toBe(expected)')).toBe('expect(received).toBe(expected)');
  });

  it('strips OSC hyperlinks and cursor sequences', () => {
    expect(stripAnsi('\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007 \u001b[2K\u001b[1Gdone')).toBe('link done');
  });

  it('leaves plain text and non-strings alone', () => {
    expect(stripAnsi('plain\ntext')).toBe('plain\ntext');
    expect(stripAnsi(42 as unknown as string)).toBe(42);
    expect(stripAnsi(undefined as unknown as string)).toBeUndefined();
  });

  it('detects escape sequences without leaving regex state behind', () => {
    expect(hasAnsi('\u001b[32mok\u001b[39m')).toBe(true);
    expect(hasAnsi('\u001b[32mok\u001b[39m')).toBe(true);
    expect(hasAnsi('nothing here')).toBe(false);
  });
});
