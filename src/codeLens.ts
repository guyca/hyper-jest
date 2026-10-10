/**
 * Optional Run / Debug code lenses on test declaration lines (`hyperjest.codeLens.enabled`, off by
 * default). A third lens shows the latest status and duration.
 */
import * as vscode from 'vscode';
import type { TestRecord } from './core/resultModel';
import type { HyperJestSettings } from './core/settingsModel';
import type { ParsedFile, ParsedNode } from './core/testModel';
import type { ResultStore } from './results/resultStore';
import { aggregateStatus, matchRecordsToNodes, walkNodes } from './results/lineView';
import { statusIcon } from './hover';

export interface CodeLensData {
  /** 0-based line */
  line: number;
  title: string;
  command: string;
  args: unknown[];
}

export interface LineTarget { path: string; /** 1-based */ line: number; testKey?: string; }

/** Pure: lens descriptors for every test/describe node of a parsed file. */
export function buildCodeLenses(parsed: ParsedFile, records: readonly TestRecord[]): CodeLensData[] {
  const matches = matchRecordsToNodes(parsed, records);
  const out: CodeLensData[] = [];
  const seenLines = new Set<number>();
  walkNodes(parsed.nodes, (node: ParsedNode) => {
    const line = node.range.startLine;
    if (seenLines.has(line)) return;
    seenLines.add(line);
    const nodeRecords = node.kind === 'test' ? matches.byNode.get(node) ?? [] : descendants(node, matches.byNode);
    const target: LineTarget = { path: parsed.path, line: line + 1, testKey: nodeRecords.length === 1 ? nodeRecords[0].testKey : undefined };
    out.push({ line, title: '$(run) Run', command: 'hyperjest.runLineTests', args: [target] });
    out.push({ line, title: '$(debug-alt) Debug', command: 'hyperjest.debugLineTest', args: [target] });
    const status = aggregateStatus(nodeRecords);
    if (status !== 'unknown') {
      const total = nodeRecords.reduce((sum, r) => sum + (r.duration ?? 0), 0);
      const duration = nodeRecords.some(r => r.duration !== null) ? ` ${total} ms` : '';
      const stale = nodeRecords.some(r => r.stale) ? ' (stale)' : '';
      out.push({ line, title: `${statusIcon(status)} ${status}${duration}${stale}`, command: 'hyperjest.showLineDetails', args: [target] });
    }
  });
  return out;
}

function descendants(node: ParsedNode, byNode: Map<ParsedNode, TestRecord[]>): TestRecord[] {
  const out: TestRecord[] = [];
  walkNodes(node.children, child => { if (child.kind === 'test') out.push(...(byNode.get(child) ?? [])); });
  return out;
}

export class TestCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly store: ResultStore, private readonly settings: () => HyperJestSettings) {}

  /** Call from the store's change event (and when the setting toggles). */
  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.ProviderResult<vscode.CodeLens[]> {
    if (!this.settings().codeLens.enabled || document.uri.scheme !== 'file') return [];
    const path = document.uri.fsPath;
    const parsed = this.store.parsed(path);
    if (!parsed) return [];
    return buildCodeLenses(parsed, this.store.testsInFile(path))
      .filter(l => l.line < document.lineCount)
      .map(l => new vscode.CodeLens(document.lineAt(l.line).range, { title: l.title, command: l.command, arguments: l.args }));
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
