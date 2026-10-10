import { diffLineArrays, diffLines, hunksTouchLine, splitLines, touchedOldLines, type LineChange } from '../../../src/core/textDiff';

/** Apply hunks to old lines; must reproduce the new lines exactly for the diff to be correct. */
function apply(oldLines: string[], newLines: string[], hunks: LineChange[]): string[] {
  const out: string[] = [];
  let oldPos = 0;
  for (const h of hunks) {
    expect(h.oldStart).toBeGreaterThanOrEqual(oldPos);
    out.push(...oldLines.slice(oldPos, h.oldStart));
    out.push(...newLines.slice(h.start, h.end));
    oldPos = h.oldEnd;
  }
  out.push(...oldLines.slice(oldPos));
  return out;
}

/** Deterministic PRNG for fuzzing. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

describe('splitLines', () => {
  it('splits on any newline style and ignores the trailing newline', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a')).toEqual(['a']);
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\r\nb\rc')).toEqual(['a', 'b', 'c']);
    expect(splitLines('\n')).toEqual(['']);
  });
});

describe('diffLines', () => {
  it('returns no hunks for identical text', () => {
    expect(diffLines('a\nb', 'a\nb')).toEqual([]);
    expect(diffLines('', '')).toEqual([]);
  });

  it('reports a single-line replacement', () => {
    expect(diffLines('a\nb\nc', 'a\nB\nc')).toEqual([{ start: 1, end: 2, oldStart: 1, oldEnd: 2 }]);
  });

  it('reports an insertion as a range in the new text with an empty old range', () => {
    expect(diffLines('a\nc', 'a\nb\nc')).toEqual([{ start: 1, end: 2, oldStart: 1, oldEnd: 1 }]);
  });

  it('reports a deletion as an empty new range anchored at the join point', () => {
    expect(diffLines('a\nb\nc', 'a\nc')).toEqual([{ start: 1, end: 1, oldStart: 1, oldEnd: 2 }]);
  });

  it('splits edits in two distant places into two hunks', () => {
    const oldText = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].join('\n');
    const newText = ['0', 'X', '2', '3', '4', '5', '6', '7', 'Y', 'Y2', '9'].join('\n');
    const hunks = diffLines(oldText, newText);
    expect(hunks).toEqual([
      { start: 1, end: 2, oldStart: 1, oldEnd: 2 },
      { start: 8, end: 10, oldStart: 8, oldEnd: 9 },
    ]);
  });

  it('handles edits at the start and end of the file', () => {
    expect(diffLines('a\nb', 'X\nb')).toEqual([{ start: 0, end: 1, oldStart: 0, oldEnd: 1 }]);
    expect(diffLines('a\nb', 'a\nY')).toEqual([{ start: 1, end: 2, oldStart: 1, oldEnd: 2 }]);
    expect(diffLines('a', '')).toEqual([{ start: 0, end: 0, oldStart: 0, oldEnd: 1 }]);
    expect(diffLines('', 'a')).toEqual([{ start: 0, end: 1, oldStart: 0, oldEnd: 0 }]);
  });

  it('round-trips random edits (fuzz)', () => {
    const rand = rng(42);
    for (let iter = 0; iter < 300; iter++) {
      const n = Math.floor(rand() * 40);
      const oldLines = Array.from({ length: n }, () => String(Math.floor(rand() * 6)));
      const newLines = [...oldLines];
      const edits = 1 + Math.floor(rand() * 4);
      for (let e = 0; e < edits; e++) {
        const at = Math.floor(rand() * (newLines.length + 1));
        const del = Math.floor(rand() * 3);
        const ins = Array.from({ length: Math.floor(rand() * 3) }, () => String(Math.floor(rand() * 6)));
        newLines.splice(at, del, ...ins);
      }
      const hunks = diffLineArrays(oldLines, newLines);
      expect(apply(oldLines, newLines, hunks)).toEqual(newLines);
      for (const h of hunks) {
        expect(h.end).toBeGreaterThanOrEqual(h.start);
        expect(h.oldEnd).toBeGreaterThanOrEqual(h.oldStart);
        expect(h.end - h.start + (h.oldEnd - h.oldStart)).toBeGreaterThan(0);
      }
    }
  });

  it('falls back to one hunk for very large middles but stays correct', () => {
    const oldLines = Array.from({ length: 12_000 }, (_, i) => `line ${i}`);
    const newLines = [...oldLines];
    newLines[10] = 'changed';
    newLines[11_000] = 'changed too';
    const hunks = diffLineArrays(oldLines, newLines);
    expect(hunks).toHaveLength(1);
    expect(apply(oldLines, newLines, hunks)).toEqual(newLines);
  });
});

describe('hunk helpers', () => {
  it('hunksTouchLine covers ranges and deletion anchors', () => {
    const hunks: LineChange[] = [{ start: 2, end: 4, oldStart: 2, oldEnd: 3 }, { start: 9, end: 9, oldStart: 9, oldEnd: 11 }];
    expect(hunksTouchLine(hunks, 1)).toBe(false);
    expect(hunksTouchLine(hunks, 2)).toBe(true);
    expect(hunksTouchLine(hunks, 3)).toBe(true);
    expect(hunksTouchLine(hunks, 4)).toBe(false);
    expect(hunksTouchLine(hunks, 9)).toBe(true);
  });

  it('touchedOldLines maps replacements, and insertions to their neighbours (clamped)', () => {
    expect(touchedOldLines({ start: 0, end: 1, oldStart: 5, oldEnd: 8 }, 100)).toEqual({ first: 5, last: 7 });
    expect(touchedOldLines({ start: 0, end: 1, oldStart: 5, oldEnd: 5 }, 100)).toEqual({ first: 4, last: 5 });
    expect(touchedOldLines({ start: 0, end: 1, oldStart: 0, oldEnd: 0 }, 100)).toEqual({ first: 0, last: 0 });
    expect(touchedOldLines({ start: 0, end: 1, oldStart: 10, oldEnd: 10 }, 10)).toEqual({ first: 9, last: 9 });
  });
});
