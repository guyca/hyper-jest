import * as fs from 'fs';
import * as vscode from 'vscode';
import { parseTestFile } from './core/testParser';
import type { ParsedFile } from './core/testModel';

interface Entry { text: string; parsed: ParsedFile; }

/**
 * Parse cache for test files: the latest ParsedFile per path (from the editor buffer when open,
 * otherwise from disk) and the text it was parsed from, so callers can diff against it.
 */
export class DocumentIndex {
  private readonly entries = new Map<string, Entry>();
  /** Text that the last dispatched run of a test file saw (baseline for change analysis). */
  private readonly runBaseline = new Map<string, Entry>();
  /** Last parse per path that produced a test tree (kept while the file has an unrecoverable syntax error). */
  private readonly lastWithNodes = new Map<string, ParsedFile>();
  private readonly listeners = new Set<(path: string, parsed: ParsedFile) => void>();

  /** Fires after a file was (re)parsed. */
  onDidParse(listener: (path: string, parsed: ParsedFile) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  parsed(path: string): ParsedFile | undefined { return this.entries.get(path)?.parsed; }
  text(path: string): string | undefined { return this.entries.get(path)?.text; }
  baseline(path: string): Entry | undefined { return this.runBaseline.get(path); }

  /** Parses `text` (if it changed) and returns the ParsedFile. */
  update(path: string, text: string): ParsedFile {
    const existing = this.entries.get(path);
    if (existing && existing.text === text) return existing.parsed;
    const parsed = parseTestFile(text, path);
    this.entries.set(path, { text, parsed });
    if (!isUnparsable(parsed)) this.lastWithNodes.set(path, parsed);
    for (const l of this.listeners) l(path, parsed);
    return parsed;
  }

  /** Parses from the open document when available, else from disk. */
  ensure(path: string): ParsedFile | undefined {
    const open = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === path);
    if (open) return this.update(path, open.getText());
    const existing = this.entries.get(path);
    if (existing) return existing.parsed;
    try {
      return this.update(path, fs.readFileSync(path, 'utf8'));
    } catch {
      return undefined;
    }
  }

  /**
   * For test-at-line lookups (Run/Debug Line, snapshot at line): the current parse, or while the file is
   * temporarily broken beyond recovery (`nodes: []` + `parseError`), the last parse that had a tree.
   */
  ensureForLookup(path: string): ParsedFile | undefined {
    const parsed = this.ensure(path);
    return parsed && isUnparsable(parsed) ? this.lastWithNodes.get(path) ?? parsed : parsed;
  }

  /** Records the current parse as the baseline for the next change analysis. */
  markRunBaseline(path: string): void {
    const e = this.entries.get(path);
    if (e) this.runBaseline.set(path, e);
  }

  forget(path: string): void {
    this.entries.delete(path);
    this.runBaseline.delete(path);
    this.lastWithNodes.delete(path);
  }
}

/** An unrecoverable syntax error: the parser produced no tree at all. */
function isUnparsable(parsed: ParsedFile): boolean {
  return !!parsed.parseError && parsed.nodes.length === 0;
}
