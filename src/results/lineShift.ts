/**
 * Line remapping for results recorded against an older text of a file. While the user edits, the
 * store's coverage / inline entries / error lines still refer to the text the last run saw;
 * replaying the editor's content changes onto those line numbers keeps decorations on the lines
 * they belong to until a run refreshes the data. Pure; no 'vscode'.
 */

/** One editor content change (VS Code `TextDocumentContentChangeEvent`, 0-based positions). */
export interface LineEdit {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  /** Replacement text. */
  text: string;
}

/** Edits kept per file; beyond this the map gives up and maps lines unchanged (the pre-remap behaviour). */
const MAX_EDITS = 1000;

/**
 * Maps a 0-based line of the text before `edit` to the text after it. `undefined` when the line's
 * content was removed (or merged into another line that keeps its identity).
 */
export function mapLineThroughEdit(edit: LineEdit, line: number): number | undefined {
  const s = edit.startLine;
  const e = edit.endLine;
  const added = countNewlines(edit.text);
  if (line < s) return line;
  if (line > e) return line + added - (e - s);
  if (line === s) {
    // A surviving prefix keeps the line where it is; an edit starting at column 0 pushes its rest down.
    if (edit.startCharacter > 0) return line;
    return s === e ? s + added : undefined;
  }
  if (line === e) {
    // The last line survives whole when the range ends at its first column, unless it merges into line `s`.
    return edit.endCharacter === 0 && (edit.startCharacter === 0 || added > 0) ? s + added : undefined;
  }
  return undefined; // strictly inside a replaced multi-line range
}

/** Edits replayed onto old line numbers, oldest first, each stamped with the time it happened. */
export class LineShift {
  private edits: Array<{ edit: LineEdit; at: number }> = [];
  private overflow = false;
  /** Bumped whenever the mapping changes (view caches key on it). */
  version = 0;

  /** True when no edit moves a line (or the history overflowed: lines are then left as recorded). */
  get empty(): boolean { return this.edits.length === 0 || this.overflow; }
  get overflowed(): boolean { return this.overflow; }

  /**
   * Records one event's changes in the order the editor reports them (each change's range is valid
   * after the previous ones). Edits that keep every line where it is (typing inside a line) are skipped.
   */
  apply(changes: readonly LineEdit[], at: number): void {
    for (const edit of changes) {
      if (edit.startLine === edit.endLine && countNewlines(edit.text) === 0) continue;
      if (this.edits.length >= MAX_EDITS) { this.overflow = true; this.edits = []; }
      if (this.overflow) continue;
      this.edits.push({ edit, at });
      this.version++;
    }
  }

  /** Forgets the edits made at or before `time`: data recorded by a run started then already reflects them. */
  dropUpTo(time: number): void {
    const before = this.edits.length;
    this.edits = this.edits.filter(x => x.at > time);
    if (this.edits.length !== before) this.version++;
  }

  /** Current line of a 0-based line of the recorded text; `undefined` when it no longer exists. */
  map(line: number): number | undefined {
    if (this.overflow) return line;
    let l: number | undefined = line;
    for (const { edit } of this.edits) {
      l = mapLineThroughEdit(edit, l);
      if (l === undefined) return undefined;
    }
    return l;
  }
}

function countNewlines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** What the tracker needs from the ResultStore. */
export interface LineShiftStore {
  staleInfo(path: string): unknown;
  lastRun(path: string): { startedAt: number } | undefined;
  /** Start of the newest run whose data touched the path (source files have no `lastRun`). */
  dataStartedAt?(path: string): number | undefined;
}

/**
 * Per-file {@link LineShift}s from the editor's content changes. A file's shift lasts while the store
 * says its data is stale; edits made before the newest run that refreshed the file's data started
 * are dropped once that run's results are in (they are already in its line numbers).
 */
export class LineShiftTracker {
  private readonly shifts = new Map<string, LineShift>();

  constructor(private readonly store: LineShiftStore, private readonly now: () => number = Date.now) {}

  noteEdit(path: string, changes: readonly LineEdit[]): void {
    const shift = this.shifts.get(path) ?? new LineShift();
    shift.apply(changes, this.now());
    if (!shift.empty || shift.overflowed) this.shifts.set(path, shift);
  }

  forget(path: string): void { this.shifts.delete(path); }

  clear(): void { this.shifts.clear(); }

  /** The shift to apply to `path`'s run data, or undefined when that data matches the buffer. */
  get(path: string): LineShift | undefined {
    const shift = this.shifts.get(path);
    if (!shift) return undefined;
    if (!this.store.staleInfo(path)) { this.shifts.delete(path); return undefined; }
    // Source files have no lastRun: their data comes from test-file runs (dataStartedAt).
    const startedAt = this.store.dataStartedAt?.(path) ?? this.store.lastRun(path)?.startedAt;
    if (startedAt !== undefined) shift.dropUpTo(startedAt);
    if (shift.overflowed) return undefined;
    if (shift.empty) { this.shifts.delete(path); return undefined; }
    return shift;
  }
}
