import * as vscode from 'vscode';
import { DEFAULT_SETTINGS, type HyperJestSettings } from './core/settingsModel';

export const SETTINGS_SECTION = 'hyperjest';

/**
 * Reads `hyperjest.*` into the typed settings model. Re-read on every call (cheap) so callers
 * always see the current value; `onDidChange` fires once per configuration change.
 */
export class Settings {
  private readonly emitter = new vscode.EventEmitter<HyperJestSettings>();
  readonly onDidChange = this.emitter.event;
  private cached: HyperJestSettings | undefined;
  private readonly disposable: vscode.Disposable;

  constructor() {
    this.disposable = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(SETTINGS_SECTION)) {
        this.cached = undefined;
        this.emitter.fire(this.get());
      }
    });
  }

  /** Current settings (workspace-wide; per-resource overrides are rare for this extension). */
  get(resource?: vscode.Uri): HyperJestSettings {
    if (!resource && this.cached) return this.cached;
    const s = readSettings(vscode.workspace.getConfiguration(SETTINGS_SECTION, resource));
    if (!resource) this.cached = s;
    return s;
  }

  async update<K extends string>(key: K, value: unknown, target = vscode.ConfigurationTarget.Workspace): Promise<void> {
    await vscode.workspace.getConfiguration(SETTINGS_SECTION).update(key, value, target);
  }

  dispose(): void {
    this.disposable.dispose();
    this.emitter.dispose();
  }
}

/** Pure mapping from a WorkspaceConfiguration-like getter to the model (unit-testable). */
export function readSettings(cfg: { get<T>(key: string, defaultValue: T): T }): HyperJestSettings {
  const d = DEFAULT_SETTINGS;
  const g = <T>(key: string, def: T): T => cfg.get<T>(key, def);
  return {
    runMode: g('runMode', d.runMode),
    onTypeDebounceMs: g('onTypeDebounceMs', d.onTypeDebounceMs),
    onSaveDebounceMs: g('onSaveDebounceMs', d.onSaveDebounceMs),
    smartStart: g('smartStart', d.smartStart),
    liveRun: { maxTestFilesPerEdit: g('liveRun.maxTestFilesPerEdit', d.liveRun.maxTestFilesPerEdit) },
    engine: g('engine', d.engine),
    maxWorkers: g('maxWorkers', d.maxWorkers),
    maxWorkersPerProject: g('maxWorkersPerProject', d.maxWorkersPerProject),
    workerMemoryLimitMB: g('workerMemoryLimitMB', d.workerMemoryLimitMB),
    memoryBudgetMB: g('memoryBudgetMB', d.memoryBudgetMB),
    workerRecycleAfterRuns: g('workerRecycleAfterRuns', d.workerRecycleAfterRuns),
    workerIdleTimeoutMs: g('workerIdleTimeoutMs', d.workerIdleTimeoutMs),
    nodePath: g('nodePath', d.nodePath),
    nodeArgs: g('nodeArgs', d.nodeArgs),
    env: g('env', d.env),
    projects: g('projects', d.projects),
    discovery: {
      exclude: g('discovery.exclude', d.discovery.exclude),
      e2ePatterns: g('discovery.e2ePatterns', d.discovery.e2ePatterns),
      preferScriptConfigs: g('discovery.preferScriptConfigs', d.discovery.preferScriptConfigs),
    },
    shono: { enabled: g('shono.enabled', d.shono.enabled) },
    globalSetup: g('globalSetup', d.globalSetup),
    tsJest: { diagnostics: g('tsJest.diagnostics', d.tsJest.diagnostics) },
    coverage: {
      enabled: g('coverage.enabled', d.coverage.enabled),
      perTest: g('coverage.perTest', d.coverage.perTest),
      instrumentTestFiles: g('coverage.instrumentTestFiles', d.coverage.instrumentTestFiles),
    },
    affected: {
      useStaticGraph: g('affected.useStaticGraph', d.affected.useStaticGraph),
      trackFileLoading: g('affected.trackFileLoading', d.affected.trackFileLoading),
      discoverWithJest: g('affected.discoverWithJest', d.affected.discoverWithJest),
      alwaysRunFailing: g('affected.alwaysRunFailing', d.affected.alwaysRunFailing),
    },
    gutter: { enabled: g('gutter.enabled', d.gutter.enabled), testDeclarations: g('gutter.testDeclarations', d.gutter.testDeclarations) },
    colors: {
      covered: g('colors.covered', d.colors.covered),
      partiallyCovered: g('colors.partiallyCovered', d.colors.partiallyCovered),
      notCovered: g('colors.notCovered', d.colors.notCovered),
      errorPath: g('colors.errorPath', d.colors.errorPath),
      errorSource: g('colors.errorSource', d.colors.errorSource),
    },
    inline: {
      showErrors: g('inline.showErrors', d.inline.showErrors),
      showLogs: g('inline.showLogs', d.inline.showLogs),
      showValues: g('inline.showValues', d.inline.showValues),
      maxLength: g('inline.maxLength', d.inline.maxLength),
      maxLogsPerLine: g('inline.maxLogsPerLine', d.inline.maxLogsPerLine),
    },
    liveComments: {
      enabled: g('liveComments.enabled', d.liveComments.enabled),
      maxDepth: g('liveComments.maxDepth', d.liveComments.maxDepth),
      maxStringLength: g('liveComments.maxStringLength', d.liveComments.maxStringLength),
    },
    console: { maxEntriesPerTest: g('console.maxEntriesPerTest', d.console.maxEntriesPerTest) },
    reportFailuresAsProblems: g('reportFailuresAsProblems', d.reportFailuresAsProblems),
    codeLens: { enabled: g('codeLens.enabled', d.codeLens.enabled) },
    testExplorer: { enabled: g('testExplorer.enabled', d.testExplorer.enabled) },
    statusBar: { compact: g('statusBar.compact', d.statusBar.compact) },
    snapshots: { updateMode: g('snapshots.updateMode', d.snapshots.updateMode) },
    debug: { saveBeforeDebug: g('debug.saveBeforeDebug', d.debug.saveBeforeDebug), console: g('debug.console', d.debug.console) },
    runTimeoutMs: g('runTimeoutMs', d.runTimeoutMs),
    keepRunArtifacts: g('keepRunArtifacts', d.keepRunArtifacts),
    trace: g('trace', d.trace),
  };
}
