/**
 * Minimal line-level diff between two texts. Pure; no deps; no 'vscode'.
 *
 * Used by the change analyzer (which lines of a spec file changed since the last parse/run) and by
 * the affected-test selector (which old lines a source edit touched). Lines are 0-based.
 *
 * Strategy: strip the common prefix and suffix (O(n), covers the typical "typing in one place"
 * edit), then run a bounded Myers O(ND) diff on the remaining middle to split multi-location edits
 * into separate hunks. When the middle is too large for the budget the single trimmed range is
 * returned, which is always a correct (if coarse) over-approximation.
 */

/** One changed hunk. `start/end` are in the NEW text, `oldStart/oldEnd` in the OLD text; ends exclusive. */
export interface LineChange {
  /** 0-based first changed line in the new text. */
  start: number;
  /** Exclusive end line in the new text (`start === end` for a pure deletion). */
  end: number;
  /** 0-based first replaced line in the old text. */
  oldStart: number;
  /** Exclusive end line in the old text (`oldStart === oldEnd` for a pure insertion). */
  oldEnd: number;
}

/** Myers budget: the middle section is diffed exactly only while (n + m) * D stays below this. */
const MYERS_BUDGET = 1_000_000;
/** Middle sections with more lines than this on either side are returned as a single hunk. */
const MYERS_MAX_LINES = 5_000;

/** Split text into lines; the trailing newline does not produce an extra empty line. */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Compute the changed line hunks that turn `oldText` into `newText`.
 * Returns an empty array when the texts have identical lines.
 */
export function diffLines(oldText: string, newText: string): LineChange[] {
  if (oldText === newText) return [];
  return diffLineArrays(splitLines(oldText), splitLines(newText));
}

/** Same as {@link diffLines} for texts already split into lines. */
export function diffLineArrays(oldLines: readonly string[], newLines: readonly string[]): LineChange[] {
  const n = oldLines.length;
  const m = newLines.length;

  // Common prefix.
  let prefix = 0;
  const maxPrefix = Math.min(n, m);
  while (prefix < maxPrefix && oldLines[prefix] === newLines[prefix]) prefix++;

  // Common suffix (never overlapping the prefix).
  let suffix = 0;
  const maxSuffix = Math.min(n, m) - prefix;
  while (suffix < maxSuffix && oldLines[n - 1 - suffix] === newLines[m - 1 - suffix]) suffix++;

  const oldMid = n - prefix - suffix;
  const newMid = m - prefix - suffix;
  if (oldMid === 0 && newMid === 0) return [];

  const single: LineChange = { start: prefix, end: m - suffix, oldStart: prefix, oldEnd: n - suffix };
  if (oldMid === 0 || newMid === 0) return [single];
  if (oldMid > MYERS_MAX_LINES || newMid > MYERS_MAX_LINES) return [single];

  const hunks = myersHunks(oldLines, prefix, n - suffix, newLines, prefix, m - suffix);
  return hunks ?? [single];
}

/**
 * Bounded Myers diff over old[oStart, oEnd) and new[nStart, nEnd). Returns null when the edit
 * distance exceeds the budget so the caller can fall back to the single trimmed hunk.
 */
function myersHunks(
  oldLines: readonly string[], oStart: number, oEnd: number,
  newLines: readonly string[], nStart: number, nEnd: number,
): LineChange[] | null {
  const n = oEnd - oStart;
  const m = nEnd - nStart;
  const max = n + m;
  const offset = max;
  // V arrays per D step are kept to reconstruct the path (classic Myers with trace).
  const trace: Int32Array[] = [];
  let v = new Int32Array(2 * max + 2);
  v[offset + 1] = 0;
  let found = false;
  for (let d = 0; d <= max; d++) {
    if ((n + m) * d > MYERS_BUDGET) return null;
    const snapshot = new Int32Array(v);
    trace.push(snapshot);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && oldLines[oStart + x] === newLines[nStart + y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = true; break; }
    }
    if (found) break;
  }
  if (!found) return null;

  // Backtrack: collect (oldIndex, newIndex) edit operations, then coalesce into hunks.
  // ops: 'd' = delete old line x, 'i' = insert new line y.
  const ops: Array<{ type: 'd' | 'i'; x: number; y: number }> = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vd[offset + prevK];
    const prevY = prevX - prevK;
    // Diagonal (matches) first, walking backwards.
    while (x > prevX && y > prevY) { x--; y--; }
    if (d > 0) {
      if (x === prevX) ops.push({ type: 'i', x, y: y - 1 });   // insertion of new[y-1]
      else ops.push({ type: 'd', x: x - 1, y });                // deletion of old[x-1]
    }
    x = prevX;
    y = prevY;
  }
  ops.reverse();

  // Coalesce adjacent ops into hunks. Ops are in forward order; an op continues the current hunk
  // when no matched (diagonal) line lies between them, i.e. it starts exactly at the hunk's cursor.
  const hunks: LineChange[] = [];
  let cur: LineChange | null = null;
  for (const op of ops) {
    // (op.x, op.y) is the old/new index the op sits at; a deletion consumes old[x], an insertion new[y].
    const oldEndCandidate = op.type === 'd' ? op.x + 1 : op.x;
    const newEndCandidate = op.type === 'i' ? op.y + 1 : op.y;
    if (cur && op.x <= cur.oldEnd - oStart && op.y <= cur.end - nStart) {
      cur.oldEnd = Math.max(cur.oldEnd, oStart + oldEndCandidate);
      cur.end = Math.max(cur.end, nStart + newEndCandidate);
    } else {
      cur = { start: nStart + op.y, end: nStart + newEndCandidate, oldStart: oStart + op.x, oldEnd: oStart + oldEndCandidate };
      hunks.push(cur);
    }
  }
  return hunks;
}

/** True when `line` (0-based, new text) is inside any hunk, counting a pure deletion as touching its anchor line. */
export function hunksTouchLine(hunks: readonly LineChange[], line: number): boolean {
  for (const h of hunks) {
    if (h.start === h.end ? line === h.start : line >= h.start && line < h.end) return true;
  }
  return false;
}

/**
 * The OLD-text lines a hunk touched, inclusive, 0-based. A pure insertion touches the two old
 * lines it was inserted between (clamped to the file), so "did the edit land inside function F"
 * questions can be answered against coverage data recorded for the old text.
 */
export function touchedOldLines(h: LineChange, oldLineCount: number): { first: number; last: number } {
  if (h.oldEnd > h.oldStart) return { first: h.oldStart, last: h.oldEnd - 1 };
  const first = Math.max(0, h.oldStart - 1);
  const last = Math.min(Math.max(0, oldLineCount - 1), h.oldStart);
  return { first, last: Math.max(first, last) };
}
