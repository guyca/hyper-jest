/**
 * `setContext` keys that gate the gutter/line-number menus and the Esc keybindings
 * (package.json `editor/lineNumber/context` when-clauses use 1-based `editorLineNumber in <key>`).
 * Values are diffed so unchanged keys are not re-sent.
 */
import * as vscode from 'vscode';
import type { LineViewFile } from './core/resultModel';
import type { RunMode } from './core/settingsModel';

export interface LineContextArrays {
  linesWithTestDeclaration: number[];
  linesWithSnapshot: number[];
  linesWithError: number[];
  linesWithValues: number[];
  coveredLines: number[];
}

/** Pure: 1-based line arrays for the when-clauses. */
export function contextArraysFor(view: LineViewFile | undefined): LineContextArrays {
  const out: LineContextArrays = { linesWithTestDeclaration: [], linesWithSnapshot: [], linesWithError: [], linesWithValues: [], coveredLines: [] };
  if (!view) return out;
  for (const line of view.declarations.keys()) out.linesWithTestDeclaration.push(line + 1);
  for (const lv of view.lines.values()) {
    const n = lv.line + 1;
    if (lv.snapshot) out.linesWithSnapshot.push(n);
    if (lv.state === 'errorSource' || lv.entries.some(e => e.kind === 'error')) out.linesWithError.push(n);
    if (lv.entries.some(e => e.kind === 'log' || e.kind === 'value')) out.linesWithValues.push(n);
    if (lv.state && lv.state !== 'notCovered') out.coveredLines.push(n);
  }
  for (const k of Object.keys(out) as Array<keyof LineContextArrays>) out[k].sort((a, b) => a - b);
  return out;
}

export interface EditorFileFlags { isTestFile: boolean; isSourceFile: boolean; }
export interface RunStateFlags {
  running: boolean;
  paused: boolean;
  runMode: RunMode;
  started?: boolean;
  /** Capped on-type runs are waiting (`hyperjest.runDeferred` enablement). */
  hasDeferred?: boolean;
}

export type SetContextFn = (key: string, value: unknown) => Thenable<unknown>;

export class ContextKeys implements vscode.Disposable {
  private readonly last = new Map<string, string>();
  private readonly setContext: SetContextFn;

  constructor(setContext?: SetContextFn) {
    this.setContext = setContext ?? ((key, value) => vscode.commands.executeCommand('setContext', key, value));
  }

  /** Updates the line arrays and file flags for the active editor (undefined clears them). */
  updateEditor(view: LineViewFile | undefined, flags: EditorFileFlags, cursorLine?: number): void {
    const arrays = contextArraysFor(view);
    this.set('hyperjest.linesWithTestDeclaration', arrays.linesWithTestDeclaration);
    this.set('hyperjest.linesWithSnapshot', arrays.linesWithSnapshot);
    this.set('hyperjest.linesWithError', arrays.linesWithError);
    this.set('hyperjest.linesWithValues', arrays.linesWithValues);
    this.set('hyperjest.coveredLines', arrays.coveredLines);
    this.set('hyperjest.isTestFile', flags.isTestFile);
    this.set('hyperjest.isSourceFile', flags.isSourceFile);
    this.set('hyperjest.fileHasInlineValues', arrays.linesWithValues.length > 0);
    this.updateCursor(view, cursorLine);
  }

  /** Updates `lineHasInlineValues` for the cursor line (0-based). */
  updateCursor(view: LineViewFile | undefined, cursorLine: number | undefined): void {
    const lv = cursorLine === undefined ? undefined : view?.lines.get(cursorLine);
    this.set('hyperjest.lineHasInlineValues', !!lv && lv.entries.some(e => e.kind === 'log' || e.kind === 'value'));
  }

  updateRunState(state: RunStateFlags): void {
    this.set('hyperjest.running', state.running);
    this.set('hyperjest.paused', state.paused);
    this.set('hyperjest.runMode', state.runMode);
    if (state.started !== undefined) this.set('hyperjest.started', state.started);
    if (state.hasDeferred !== undefined) this.set('hyperjest.hasDeferred', state.hasDeferred);
  }

  private set(key: string, value: unknown): void {
    const json = JSON.stringify(value);
    if (this.last.get(key) === json) return;
    this.last.set(key, json);
    void this.setContext(key, value);
  }

  /** Clears every editor-scoped key (no active `file:` editor: Doctor report, diff side, untitled, none). */
  clearEditor(): void {
    this.updateEditor(undefined, { isTestFile: false, isSourceFile: false });
  }

  dispose(): void {
    this.last.clear();
  }
}
