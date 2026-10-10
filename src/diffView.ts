/**
 * Side-by-side expected ↔ actual diff for a failing test, as two virtual documents on the
 * `hyperjest-diff:` scheme opened with `vscode.diff`. Documents update live from the store: once
 * the test passes they show `<TEST PASSES>` (Wallaby behaviour).
 */
import * as vscode from 'vscode';
import { parseTestKey } from './core/protocol';
import type { TestRecord } from './core/resultModel';
import type { ResultStore } from './results/resultStore';

export const DIFF_SCHEME = 'hyperjest-diff';
export const TEST_PASSES_PLACEHOLDER = '<TEST PASSES>';

export interface DiffContent { expected: string; actual: string; title: string; }

/** Pure: expected/actual text of a test's first failure carrying a diff. */
export function diffContentFor(test: TestRecord | undefined, testKey: string): DiffContent {
  const title = test?.fullName ?? parseTestKey(testKey).fullName;
  if (!test) return { expected: '', actual: 'No result for this test yet.', title };
  if (test.status !== 'failed' && test.status !== 'errored') return { expected: TEST_PASSES_PLACEHOLDER, actual: TEST_PASSES_PLACEHOLDER, title };
  const withDiff = test.failures.find(f => f.expected !== undefined && f.actual !== undefined);
  if (withDiff) return { expected: withDiff.expected ?? '', actual: withDiff.actual ?? '', title };
  const first = test.failures[0];
  return { expected: '', actual: first?.message ?? 'Test failed without a message.', title };
}

export function encodeKey(testKey: string): string {
  return Buffer.from(testKey, 'utf8').toString('base64url');
}
export function decodeKey(encoded: string): string {
  return Buffer.from(encoded, 'base64url').toString('utf8');
}

/** `hyperjest-diff:/<base64url(testKey)>/expected.txt` (or `actual.txt`). */
export function diffUri(testKey: string, side: 'expected' | 'actual'): vscode.Uri {
  return vscode.Uri.parse(`${DIFF_SCHEME}:/${encodeKey(testKey)}/${side}.txt`);
}

export function parseDiffUri(uri: vscode.Uri): { testKey: string; side: 'expected' | 'actual' } | undefined {
  const m = /^\/?([A-Za-z0-9_-]+)\/(expected|actual)\.txt$/.exec(uri.path);
  if (!m) return undefined;
  try {
    return { testKey: decodeKey(m[1]), side: m[2] as 'expected' | 'actual' };
  } catch {
    return undefined;
  }
}

export class DiffContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  /** Tests whose diff documents were opened (refreshed on store changes). */
  private readonly open = new Set<string>();

  constructor(private readonly store: ResultStore) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    const parsed = parseDiffUri(uri);
    if (!parsed) return '';
    const content = diffContentFor(this.store.test(parsed.testKey), parsed.testKey);
    return parsed.side === 'expected' ? content.expected : content.actual;
  }

  /** Call from the store's change event: refreshes open diff documents of changed test files. */
  onStoreChange(changedPaths: readonly string[]): void {
    const changed = new Set(changedPaths);
    for (const key of this.open) {
      if (changed.has(parseTestKey(key).path)) {
        this.emitter.fire(diffUri(key, 'expected'));
        this.emitter.fire(diffUri(key, 'actual'));
      }
    }
  }

  /** Opens the diff editor titled "Expected ↔ Actual" beside the current editor. */
  async showDiff(testKey: string): Promise<void> {
    this.open.add(testKey);
    const content = diffContentFor(this.store.test(testKey), testKey);
    await vscode.commands.executeCommand('vscode.diff', diffUri(testKey, 'expected'), diffUri(testKey, 'actual'),
      `Expected ↔ Actual — ${content.title}`, { preview: true, viewColumn: vscode.ViewColumn.Beside } as vscode.TextDocumentShowOptions);
  }

  dispose(): void {
    this.emitter.dispose();
    this.open.clear();
  }
}
