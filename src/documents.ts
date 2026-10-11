import * as fs from 'fs';
import * as vscode from 'vscode';
import { parseTestFile } from './core/testParser';
import { diffLines, type LineChange } from './core/textDiff';
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
  /** Last parse and its source text, kept while the file has an unrecoverable syntax error. */
  private readonly lastWithNodes = new Map<string, Entry>();
  private readonly listeners = new Set<(path: string, parsed: ParsedFile) => void>();

  /** Fires after a file was (re)parsed. */
  onDidParse(listener: (path: string, parsed: ParsedFile) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  parsed(path: string): ParsedFile | undefined { return this.entries.get(path)?.parsed; }
  text(path: string): string | undefined { return this.entries.get(path)?.text; }
  baseline(path: string, projectId: string): Entry | undefined { return this.runBaseline.get(`${projectId}\0${path}`); }

  /** Parses `text` (if it changed) and returns the ParsedFile. */
  update(path: string, text: string): ParsedFile {
    const existing = this.entries.get(path);
    if (existing && existing.text === text) return existing.parsed;
    const parsed = parseTestFile(text, path);
    const entry = { text, parsed };
    this.entries.set(path, entry);
    if (!isUnparsable(parsed)) this.lastWithNodes.set(path, entry);
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
   * For test-at-line lookups: use the current parse, or map the cursor back to the last parse
   * with a tree while the file is broken. A changed line has no trustworthy old counterpart.
   */
  lookupAtLine(path: string, line: number): { parsed: ParsedFile; line: number } | undefined {
    const parsed = this.ensure(path);
    if (!parsed) return undefined;
    if (!isUnparsable(parsed)) return { parsed, line };
    const last = this.lastWithNodes.get(path);
    const current = this.entries.get(path);
    if (!last || !current) return undefined;
    const oldLine = mapNewLineToOld(diffLines(last.text, current.text), line);
    return oldLine === undefined ? undefined : { parsed: last.parsed, line: oldLine };
  }

  /** Records the current parse as the baseline for the next change analysis. */
  markRunBaseline(path: string, projectId: string): void {
    const e = this.entries.get(path);
    if (e) this.runBaseline.set(`${projectId}\0${path}`, e);
  }

  clearProject(projectId: string): void {
    for (const key of this.runBaseline.keys()) if (key.startsWith(`${projectId}\0`)) this.runBaseline.delete(key);
  }

  forget(path: string): void {
    this.entries.delete(path);
    for (const key of this.runBaseline.keys()) if (key.endsWith(`\0${path}`)) this.runBaseline.delete(key);
    this.lastWithNodes.delete(path);
  }
}

/** Map an unchanged current line to the last parsed text; changed/inserted lines are ambiguous. */
function mapNewLineToOld(changes: readonly LineChange[], line: number): number | undefined {
  let offset = 0;
  for (const change of changes) {
    if (line < change.start) break;
    if (line < change.end) return undefined;
    offset = change.oldEnd - change.end;
  }
  return line + offset;
}

/** An unrecoverable syntax error: the parser produced no tree at all. */
function isUnparsable(parsed: ParsedFile): boolean {
  return !!parsed.parseError && parsed.nodes.length === 0;
}
