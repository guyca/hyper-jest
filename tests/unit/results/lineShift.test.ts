import { LineShift, LineShiftTracker, mapLineThroughEdit, type LineEdit } from '../../../src/results/lineShift';
import { ResultStore } from '../../../src/results/resultStore';
import { computeLineView } from '../../../src/results/lineView';
import { SRC, applyFullRun } from './fixtures';

const L = (n: number) => n - 1;
const edit = (startLine: number, startCharacter: number, endLine: number, endCharacter: number, text: string): LineEdit =>
  ({ startLine, startCharacter, endLine, endCharacter, text });

describe('mapLineThroughEdit', () => {
  it('shifts lines below an inserted line and keeps lines above', () => {
    const enterAtEndOfLine2 = edit(2, 10, 2, 10, '\n');
    expect(mapLineThroughEdit(enterAtEndOfLine2, 1)).toBe(1);
    expect(mapLineThroughEdit(enterAtEndOfLine2, 2)).toBe(2);
    expect(mapLineThroughEdit(enterAtEndOfLine2, 3)).toBe(4);
  });

  it('moves a line down when lines are inserted at its first column', () => {
    expect(mapLineThroughEdit(edit(0, 0, 0, 0, 'a\nb\n'), 0)).toBe(2);
    expect(mapLineThroughEdit(edit(0, 0, 0, 0, 'a\nb\n'), 5)).toBe(7);
  });

  it('drops deleted lines and pulls the following ones up', () => {
    const deleteLines3to4 = edit(3, 0, 5, 0, '');
    expect(mapLineThroughEdit(deleteLines3to4, 2)).toBe(2);
    expect(mapLineThroughEdit(deleteLines3to4, 3)).toBeUndefined();
    expect(mapLineThroughEdit(deleteLines3to4, 4)).toBeUndefined();
    expect(mapLineThroughEdit(deleteLines3to4, 5)).toBe(3);
    expect(mapLineThroughEdit(deleteLines3to4, 9)).toBe(7);
  });

  it('joining two lines keeps the first one', () => {
    const backspaceAtStartOfLine4 = edit(3, 7, 4, 0, '');
    expect(mapLineThroughEdit(backspaceAtStartOfLine4, 3)).toBe(3);
    expect(mapLineThroughEdit(backspaceAtStartOfLine4, 4)).toBeUndefined();
    expect(mapLineThroughEdit(backspaceAtStartOfLine4, 6)).toBe(5);
  });
});

describe('LineShift', () => {
  it('composes edits in order and ignores typing inside a line', () => {
    const s = new LineShift();
    s.apply([edit(4, 3, 4, 3, 'x')], 1);
    expect(s.empty).toBe(true);
    s.apply([edit(0, 0, 0, 0, '\n\n')], 2);   // two lines at the top
    s.apply([edit(5, 0, 6, 0, '')], 3);       // then delete (new) line 5
    expect(s.map(0)).toBe(2);
    expect(s.map(3)).toBeUndefined();         // old 3 -> 5 -> deleted
    expect(s.map(4)).toBe(5);                 // old 4 -> 6 -> 5
    s.dropUpTo(2);
    expect(s.map(5)).toBeUndefined();
    expect(s.map(6)).toBe(5);
  });
});

describe('LineShiftTracker + computeLineView', () => {
  it('keeps coverage states on their lines after lines are inserted above them', () => {
    let now = 100;
    const store = new ResultStore({ now: () => now });
    applyFullRun(store, 'r1');
    const before = computeLineView(store, SRC);
    expect(before.lines.get(L(2))?.state).toBe('covered');
    const tracker = new LineShiftTracker(store, () => now);
    now = 200;
    store.markStale(SRC);
    tracker.noteEdit(SRC, [edit(0, 0, 0, 0, '// a\n// b\n')]);
    const shift = tracker.get(SRC)!;
    expect(shift).toBeDefined();
    const after = computeLineView(store, SRC, { mapLine: l => shift.map(l) });
    expect(after.lines.get(L(4))?.state).toBe(before.lines.get(L(2))?.state);
    expect(after.lines.get(L(15))?.state).toBe(before.lines.get(L(13))?.state);
    expect(after.lines.get(L(21))?.state).toBe('notCovered');
    // Once a run started after the edit refreshes the file, its data is current again.
    store.clearStale(SRC);
    expect(tracker.get(SRC)).toBeUndefined();
    store.dispose();
  });

  it('a source file\'s shift drops the edits a run that refreshed its coverage already saw', () => {
    let now = 100;
    const store = new ResultStore({ now: () => now, setTimer: () => 1, clearTimer: () => undefined });
    const tracker = new LineShiftTracker(store, () => now);
    applyFullRun(store, 'r1');
    now = 200; store.markStale(SRC); tracker.noteEdit(SRC, [edit(0, 0, 0, 0, '\n')]);
    now = 400; store.markStale(SRC); tracker.noteEdit(SRC, [edit(0, 0, 0, 0, '\n')]); // typed while r2 runs
    now = 300; applyFullRun(store, 'r2'); // started at 300: its SRC lines already include the first edit
    expect(store.lastRun(SRC)).toBeUndefined(); // SRC is a source file: only the spec has a lastRun
    expect(store.staleInfo(SRC)).toBeDefined();
    expect(tracker.get(SRC)?.map(L(2))).toBe(L(3));
    store.dispose();
  });

  it('a further edit only notifies the store when the stale state changes', () => {
    const store = new ResultStore({ setTimer: () => 1, clearTimer: () => undefined });
    applyFullRun(store, 'r1');
    const gen = store.generation;
    store.markStale(SRC);
    const afterFirst = store.generation;
    expect(afterFirst).toBeGreaterThan(gen);
    store.markStale(SRC);
    store.markStale(SRC);
    expect(store.generation).toBe(afterFirst);
    expect(store.staleInfo(SRC)?.all).toBe(true);
    store.dispose();
  });
});
