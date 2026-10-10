import * as vscode from 'vscode';
import { PROTOCOL_VERSION, type OverlayChange } from './core/protocol';

/**
 * Tracks dirty (unsaved) documents and turns them into overlay changes for the workers, so on-type
 * runs see the editor buffer instead of the file on disk. Saving or closing a document removes its
 * overlay entry (the mtime change then invalidates Jest's own caches).
 *
 * Only `file:` documents that exist on disk can be overlaid (Jest stats them); untitled buffers are
 * reported through `onUntitled` so the UI can hint "save first".
 */
export class OverlayTracker implements vscode.Disposable {
  private readonly entries = new Map<string, OverlayChange>();
  private readonly emitter = new vscode.EventEmitter<{ projectResolver: (path: string) => string | undefined; changes: OverlayChange[] }>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly isInteresting: (doc: vscode.TextDocument) => boolean,
    private readonly projectIdOf: (fsPath: string) => string | string[] | undefined,
    private readonly send: (projectId: string, changes: OverlayChange[]) => void,
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(e => this.onChange(e.document)),
      vscode.workspace.onDidSaveTextDocument(doc => this.remove(doc)),
      vscode.workspace.onDidCloseTextDocument(doc => this.remove(doc)),
    );
    // Documents already dirty at activation.
    this.refresh();
  }

  /** Discovery/selection can make an already dirty buffer applicable to a new config. */
  refresh(): void {
    for (const doc of vscode.workspace.textDocuments) if (doc.isDirty) this.onChange(doc);
  }

  /** All overlay entries for a project (used when launching CLI/debug processes). */
  entriesFor(projectId: string): OverlayChange[] {
    return [...this.entries.values()].filter(c => this.projectsOf(c.path).includes(projectId));
  }

  private projectsOf(p: string): string[] {
    const result = this.projectIdOf(p);
    return result === undefined ? [] : Array.isArray(result) ? result : [result];
  }

  has(fsPath: string): boolean {
    return this.entries.has(fsPath);
  }

  private onChange(doc: vscode.TextDocument): void {
    if (doc.uri.scheme !== 'file' || !this.isInteresting(doc)) return;
    const projectIds = this.projectsOf(doc.uri.fsPath);
    if (!projectIds.length) return;
    if (!doc.isDirty) { this.remove(doc); return; }
    const change: OverlayChange = { path: doc.uri.fsPath, text: doc.getText(), version: doc.version };
    this.entries.set(doc.uri.fsPath, change);
    for (const projectId of projectIds) this.send(projectId, [change]);
  }

  private remove(doc: vscode.TextDocument): void {
    const fsPath = doc.uri.fsPath;
    if (!this.entries.has(fsPath)) return;
    this.entries.delete(fsPath);
    for (const projectId of this.projectsOf(fsPath)) this.send(projectId, [{ path: fsPath, text: null, version: doc.version }]);
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this.emitter.dispose();
  }
}

export function overlayMessage(changes: OverlayChange[]) {
  return { v: PROTOCOL_VERSION, type: 'overlay' as const, changes };
}
