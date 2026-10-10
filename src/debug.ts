import * as vscode from 'vscode';
import type { Logger } from './core/logger';
import { buildDebugConfig } from './core/runSpec';
import type { OverlayChange, ProjectSpec, RunTestSelection } from './core/protocol';
import type { HyperJestSettings } from './core/settingsModel';
import { toRunSpecProject } from './cliEngine';
import { removeRunArtifacts, writeOverlayManifest } from './overlayManifest';

export interface DebugRequest {
  spec: ProjectSpec;
  tests: RunTestSelection[];
  title: string;
  overlay: readonly OverlayChange[];
  workerAssetsDir: string;
  settings: HyperJestSettings;
  log: Logger;
}

/**
 * Launches a js-debug session running the project's jest in-band for the selection and resolves when
 * the session terminates. The warm worker is never debugged: a fresh process keeps breakpoints and
 * source maps simple. Results do not flow back from a debug session (fd 3 is absent under js-debug);
 * the caller re-runs the file afterwards to refresh the store.
 */
export async function startDebugSession(req: DebugRequest): Promise<void> {
  if (req.settings.debug.saveBeforeDebug) await vscode.workspace.saveAll(false);
  const runId = `debug-${Date.now().toString(36)}`;
  const overlayManifestPath = req.settings.debug.saveBeforeDebug ? undefined : writeOverlayManifest(runId, req.overlay);
  const config = buildDebugConfig({
    project: toRunSpecProject(req.spec),
    workerAssetsDir: req.workerAssetsDir,
    tests: req.tests,
    title: req.title,
    runId,
    overlayManifestPath,
    extraEnv: req.settings.env,
    console: req.settings.debug.console,
  });
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(req.spec.packageDir));
  req.log.info(`debug: ${config.name} (${config.runtimeExecutable} ${config.program} ${config.args.join(' ')})`);

  try {
    // A rejected launch must not leave the overlay manifest behind either.
    const started = await vscode.debug.startDebugging(folder, config as unknown as vscode.DebugConfiguration);
    if (!started) throw new Error('VS Code refused to start the debug session (is the JavaScript debugger available?)');
    await new Promise<void>(resolve => {
      const sub = vscode.debug.onDidTerminateDebugSession(session => {
        if (session.name === config.name || session.configuration?.name === config.name) {
          sub.dispose();
          resolve();
        }
      });
    });
  } finally {
    removeRunArtifacts(runId);
  }
}
