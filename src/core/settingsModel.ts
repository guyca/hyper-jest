/** Typed view of the `hyperjest.*` settings. Pure (no 'vscode'); the host fills it from workspace config. */
export type RunMode = 'onType' | 'onSave' | 'manual';
export type Engine = 'auto' | 'warm' | 'cli';
export type SmartStart = 'open' | 'always' | 'never';

export interface ProjectOverride {
  packageDir: string;
  configArg?: string;
  /** Package-relative config paths; omitted = automatic, [] = none. */
  configFiles?: string[];
  env?: Record<string, string>;
  nodePath?: string;
  disabled?: boolean;
}

export interface GutterColors {
  covered: string;
  partiallyCovered: string;
  notCovered: string;
  errorPath: string;
  errorSource: string;
}

export interface HyperJestSettings {
  runMode: RunMode;
  onTypeDebounceMs: number;
  onSaveDebounceMs: number;
  smartStart: SmartStart;
  liveRun: { maxTestFilesPerEdit: number };
  engine: Engine;
  maxWorkers: number;
  maxWorkersPerProject: number;
  workerMemoryLimitMB: number;
  memoryBudgetMB: number;
  workerRecycleAfterRuns: number;
  workerIdleTimeoutMs: number;
  nodePath: string;
  nodeArgs: string[];
  env: Record<string, string>;
  projects: ProjectOverride[];
  discovery: { exclude: string[]; e2ePatterns: string[]; preferScriptConfigs: boolean };
  globalSetup: 'once' | 'skip';
  tsJest: { diagnostics: 'keep' | 'off' };
  coverage: { enabled: boolean; perTest: boolean; instrumentTestFiles: boolean };
  affected: { useStaticGraph: boolean; trackFileLoading: boolean; discoverWithJest: boolean; alwaysRunFailing: boolean };
  gutter: { enabled: boolean; testDeclarations: 'auto' | 'always' | 'never' };
  colors: GutterColors;
  inline: { showErrors: boolean; showLogs: boolean; showValues: boolean; maxLength: number; maxLogsPerLine: number };
  liveComments: { enabled: boolean; maxDepth: number; maxStringLength: number };
  console: { maxEntriesPerTest: number };
  reportFailuresAsProblems: boolean;
  codeLens: { enabled: boolean };
  testExplorer: { enabled: boolean };
  statusBar: { compact: boolean };
  snapshots: { updateMode: 'new' | 'none' };
  debug: { saveBeforeDebug: boolean; console: 'integratedTerminal' | 'internalConsole' };
  runTimeoutMs: number;
  keepRunArtifacts: boolean;
  trace: boolean;
}

export const DEFAULT_SETTINGS: HyperJestSettings = {
  runMode: 'onType',
  onTypeDebounceMs: 300,
  onSaveDebounceMs: 100,
  smartStart: 'always',
  liveRun: { maxTestFilesPerEdit: 8 },
  engine: 'auto',
  maxWorkers: 0,
  maxWorkersPerProject: 4,
  workerMemoryLimitMB: 2048,
  memoryBudgetMB: 0,
  workerRecycleAfterRuns: 200,
  workerIdleTimeoutMs: 600000,
  nodePath: '',
  nodeArgs: [],
  env: {},
  projects: [],
  discovery: {
    exclude: ['**/node_modules/**', '**/.claude/worktrees/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/ios/**', '**/android/**', '**/Pods/**'],
    e2ePatterns: ['**/e2e/**', '**/*.e2e.*'],
    preferScriptConfigs: true,
  },
  globalSetup: 'once',
  tsJest: { diagnostics: 'keep' },
  coverage: { enabled: true, perTest: true, instrumentTestFiles: false },
  affected: { useStaticGraph: true, trackFileLoading: true, discoverWithJest: true, alwaysRunFailing: true },
  gutter: { enabled: true, testDeclarations: 'auto' },
  colors: { covered: '#62b455', partiallyCovered: '#d2a032', notCovered: '#cccccc', errorPath: '#ffa0a0', errorSource: '#fe536a' },
  inline: { showErrors: true, showLogs: true, showValues: true, maxLength: 120, maxLogsPerLine: 3 },
  liveComments: { enabled: true, maxDepth: 5, maxStringLength: 8192 },
  console: { maxEntriesPerTest: 100 },
  reportFailuresAsProblems: true,
  codeLens: { enabled: false },
  testExplorer: { enabled: true },
  statusBar: { compact: false },
  snapshots: { updateMode: 'new' },
  debug: { saveBeforeDebug: true, console: 'integratedTerminal' },
  runTimeoutMs: 300000,
  keepRunArtifacts: false,
  trace: false,
};
