import * as vscode from 'vscode';
import type { Logger } from '../core/logger';

/**
 * Finds candidate package.json files in the workspace. Discovery proper (flavors, jest/node
 * resolution) is pure code in src/core/projectSpec.ts; this module only knows about VS Code.
 */
export async function scanPackageJsons(exclude: string[], log: Logger, token?: vscode.CancellationToken): Promise<string[]> {
  const excludeGlob = exclude.length === 1 ? exclude[0] : `{${exclude.join(',')}}`;
  const started = Date.now();
  const uris = await vscode.workspace.findFiles('**/package.json', excludeGlob, 20000, token);
  const paths = uris.map(u => u.fsPath).sort();
  log.debug(`packageScanner: ${paths.length} package.json files in ${Date.now() - started} ms`);
  return paths;
}

/** Workspace folder that contains `fsPath`, or undefined. */
export function workspaceFolderOf(fsPath: string): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath));
}
