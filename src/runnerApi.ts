/**
 * Contract between the UI surfaces (Test Explorer profiles, hover/code-lens commands, status bar)
 * and the RunCoordinator (runner.ts, owned by another module). Pure types; no 'vscode'.
 */
import type { RunMsg, RunTestSelection, UpdateSnapshotMode } from './core/protocol';
import type { RunMode } from './core/settingsModel';

export type RunReason = RunMsg['reason'];

export interface RunOptions {
  /** Snapshot mode for the run; defaults to the `hyperjest.snapshots.updateMode` setting. */
  updateSnapshot?: UpdateSnapshotMode;
  /** Queue priority (0 = explicit, highest). */
  priority?: number;
}

export interface RunOutcome {
  wasInterrupted: boolean;
  error?: string;
}

export interface RunHandle {
  /** Protocol runId; results for the run flow into the ResultStore under this id. */
  runId: string;
  /** Resolves when every file of the run completed, was cancelled or failed to start. */
  done: Promise<RunOutcome>;
  /** Set when nothing was queued (stopped, no Jest project, project not runnable): why, for the user. */
  notRun?: string;
}

export type SnapshotScope =
  | { kind: 'test'; testKey: string }
  | { kind: 'file'; path: string }
  | { kind: 'project'; projectId: string }
  | { kind: 'selection'; selections: RunTestSelection[] };

export interface RunnerState {
  /** False while HyperJest is stopped (no workers). */
  started: boolean;
  running: boolean;
  paused: boolean;
  runMode: RunMode;
  activeRuns: number;
  queuedFiles: number;
  /** Set when an edit affected more test files than `liveRun.maxTestFilesPerEdit`. */
  capped?: { count: number; selections: RunTestSelection[] };
  lastError?: string;
}

export interface CancellationLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface RunnerApi {
  /** Runs whole files or named tests within them. */
  runFiles(selections: RunTestSelection[], reason: RunReason, opts?: RunOptions): Promise<RunHandle>;
  /** Runs specific tests by store key (`path\0fullName\0dupIndex`). */
  runTests(testKeys: string[], reason?: RunReason, opts?: RunOptions): Promise<RunHandle>;
  /** Starts a js-debug session for one file / named test; resolves when the session ends. */
  debug(selection: RunTestSelection): Promise<void>;
  updateSnapshots(scope: SnapshotScope): Promise<RunHandle>;
  cancel(runId: string | 'all'): void;
  pause(): void;
  resume(): void;
  getState(): RunnerState;
  onDidChangeState(listener: (state: RunnerState) => void): { dispose(): void };
  /** Continuous (Explorer "watch") mode: keep `selections` re-running on change until cancelled. */
  watch(selections: RunTestSelection[], token: CancellationLike): void;
  /** Project owning a file, when known. */
  projectIdForFile?(path: string): string | undefined;
}
