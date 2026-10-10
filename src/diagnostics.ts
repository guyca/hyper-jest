/**
 * Problems view integration (plan: Problems row): one Error diagnostic per failure at the top
 * in-file frame (other frames as relatedInformation) plus one at the test declaration line; a
 * file-level `testExecError` gets one diagnostic at its top in-file frame (or line 0). Cleared per
 * test file on every update; gated by `hyperjest.reportFailuresAsProblems`.
 */
import * as vscode from 'vscode';
import type { FailureInfo, Frame } from './core/protocol';
import type { FileRecord, TestRecord } from './core/resultModel';
import type { ResultStore } from './results/resultStore';
import { firstLine } from './results/lineView';

export interface DiagnosticData {
  /** 0-based */
  line: number;
  /** 0-based */
  column: number;
  message: string;
  related: Array<{ file: string; line: number; column: number; message: string }>;
  testKey?: string;
}

function frameLabel(f: Frame): string {
  return `${f.functionName ? f.functionName + ' ' : ''}(${f.file}:${f.line}:${f.column})`;
}

function relatedFrom(frames: Frame[], skip?: Frame): DiagnosticData['related'] {
  return frames.filter(f => f !== skip).map(f => ({ file: f.file, line: Math.max(0, f.line - 1), column: Math.max(0, f.column - 1), message: `at ${frameLabel(f)}` }));
}

/** Pure: diagnostics for one test file from its records. */
export function buildDiagnostics(path: string, tests: readonly TestRecord[], file: FileRecord | undefined): DiagnosticData[] {
  const out: DiagnosticData[] = [];
  const push = (d: DiagnosticData) => {
    if (!out.some(o => o.line === d.line && o.column === d.column && o.message === d.message)) out.push(d);
  };
  for (const t of tests) {
    if (t.status !== 'failed' && t.status !== 'errored') continue;
    const declLine = t.location ? t.location.line - 1 : undefined;
    const failures: FailureInfo[] = t.failures.length > 0 ? t.failures : [{ message: `${t.fullName} failed`, frames: [] }];
    for (const f of failures) {
      const top = f.frames.find(fr => fr.file === path);
      const message = f.message.trim() || `${t.fullName} failed`;
      if (top) {
        push({ line: top.line - 1, column: Math.max(0, top.column - 1), message, related: relatedFrom(f.frames, top), testKey: t.testKey });
        if (declLine !== undefined && declLine !== top.line - 1) {
          push({ line: declLine, column: Math.max(0, (t.location?.column ?? 1) - 1), message: `✗ ${t.fullName}: ${firstLine(message)}`, related: [{ file: path, line: top.line - 1, column: Math.max(0, top.column - 1), message: 'failure location' }], testKey: t.testKey });
        }
      } else {
        push({ line: declLine ?? 0, column: Math.max(0, (t.location?.column ?? 1) - 1), message: `✗ ${t.fullName}: ${message}`, related: relatedFrom(f.frames), testKey: t.testKey });
      }
    }
  }
  if (file?.testExecError) {
    const exec = file.testExecError;
    const top = exec.frames.find(fr => fr.file === path);
    push({ line: top ? top.line - 1 : 0, column: top ? Math.max(0, top.column - 1) : 0, message: exec.message.trim() || 'Test file failed to run', related: relatedFrom(exec.frames, top) });
  }
  return out;
}

export class DiagnosticsPublisher implements vscode.Disposable {
  readonly collection: vscode.DiagnosticCollection;
  private readonly published = new Set<string>();

  constructor(private readonly store: ResultStore, private readonly enabled: () => boolean) {
    this.collection = vscode.languages.createDiagnosticCollection('hyperjest');
  }

  /** Recomputes diagnostics for the given test files (call from the store's change event). */
  update(paths: Iterable<string>): void {
    if (!this.enabled()) { this.clearAll(); return; }
    for (const path of paths) {
      const file = this.store.fileRecord(path);
      if (!file) {
        if (this.published.delete(path)) this.collection.delete(vscode.Uri.file(path));
        continue;
      }
      const records = this.store.allFiles().filter(f => f.path === path);
      const data = records.flatMap(record => buildDiagnostics(path, this.store.testsInFile(path, record.projectId), record).map(d =>
        records.length > 1 ? { ...d, message: `[${this.store.projectLabel(record.projectId)}] ${d.message}` } : d));
      const uri = vscode.Uri.file(path);
      if (data.length === 0) {
        if (this.published.delete(path)) this.collection.delete(uri);
        continue;
      }
      const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === path);
      this.collection.set(uri, data.map(d => this.toDiagnostic(d, doc)));
      this.published.add(path);
    }
  }

  /** Recomputes every published file (settings toggle). */
  refreshAll(): void {
    const paths = new Set<string>(this.published);
    for (const f of this.store.allFiles()) paths.add(f.path);
    this.update(paths);
  }

  clearAll(): void {
    this.collection.clear();
    this.published.clear();
  }

  private toDiagnostic(d: DiagnosticData, doc: vscode.TextDocument | undefined): vscode.Diagnostic {
    let range: vscode.Range;
    if (doc && d.line < doc.lineCount) {
      const text = doc.lineAt(d.line);
      const end = text.range.end.character;
      // Frame columns beyond the line (minified/remapped) fall back to the line's content.
      const start = d.column >= end ? text.firstNonWhitespaceCharacterIndex : Math.max(d.column, text.firstNonWhitespaceCharacterIndex);
      range = new vscode.Range(d.line, start, d.line, end);
    } else {
      range = new vscode.Range(d.line, d.column, d.line, d.column);
    }
    const diag = new vscode.Diagnostic(range, d.message, vscode.DiagnosticSeverity.Error);
    diag.source = 'HyperJest';
    if (d.related.length > 0) {
      diag.relatedInformation = d.related.map(r => new vscode.DiagnosticRelatedInformation(
        new vscode.Location(vscode.Uri.file(r.file), new vscode.Position(r.line, r.column)), r.message));
    }
    return diag;
  }

  dispose(): void {
    this.collection.dispose();
  }
}
