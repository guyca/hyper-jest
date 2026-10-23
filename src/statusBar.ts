/**
 * Status bar item `hyperjest.status` (plan: Status bar row). Click opens the quick-pick menu
 * (`hyperjest.showMenu`, owned by commands.ts), or runs the deferred affected tests while on-type runs
 * are capped (`hyperjest.runDeferred`).
 *
 * Wiring: `update()` on every ResultStore change (summary) and on every RunnerApi state change;
 * `compact` comes from `hyperjest.statusBar.compact` (pass a settings getter to the constructor,
 * or `compact` on every update).
 */
import * as vscode from 'vscode';
import type { RunSummary } from './core/resultModel';
import type { HyperJestSettings } from './core/settingsModel';
import type { RunnerState } from './runnerApi';

export interface StatusBarModel {
  text: string;
  tooltip: string;
  /** Use `statusBarItem.errorBackground`. */
  error: boolean;
  /** Use `statusBarItem.warningBackground` (paused / capped). */
  warning: boolean;
  /** Click target: the deferred run while capped ("click to run"), the menu otherwise. */
  command: string;
}

export interface StatusBarInput {
  summary: RunSummary;
  state: RunnerState;
  /** Defaults to `settings().statusBar.compact` when the StatusBar was given a settings getter. */
  compact?: boolean;
}

/** Pure text/tooltip builder. */
export function buildStatusBarModel(input: StatusBarInput): StatusBarModel {
  const { summary, state } = input;
  const compact = input.compact ?? false;
  const parts: string[] = [];
  const tooltip: string[] = [];
  if (!state.started) {
    parts.push('$(beaker) HyperJest');
    if (!compact) parts.push('stopped');
    tooltip.push('HyperJest is stopped. Click for the menu.');
    return { text: parts.join(' '), tooltip: tooltip.join('\n'), error: false, warning: false, command: 'hyperjest.showMenu' };
  }
  const running = state.running || summary.running > 0 || summary.queued > 0;
  parts.push(running ? '$(loading~spin)' : state.paused ? '$(debug-pause)' : '$(beaker)');
  if (!compact) parts.push('HyperJest');
  if (state.capped) {
    parts.push(`${state.capped.count} affected files waiting`);
    tooltip.push(`Remaining affected test files run automatically in batches after current work finishes. Click to queue them now.`);
  } else {
    parts.push(compact ? `$(check-all) ${summary.passed}` : `✓ ${summary.passed}`);
    parts.push(compact ? `$(error) ${summary.failed}` : `✗ ${summary.failed}`);
    if (summary.pending > 0 && !compact) parts.push(`○ ${summary.pending}`);
  }
  tooltip.push(`${summary.passed} passed, ${summary.failed} failed, ${summary.pending} skipped`);
  if (summary.running > 0 || summary.queued > 0) tooltip.push(`${summary.running} running, ${summary.queued} queued`);
  if (summary.staleFiles > 0) tooltip.push(`${summary.staleFiles} file(s) with unsaved changes awaiting a run`);
  tooltip.push(`Run mode: ${state.runMode}${state.paused ? ' (paused)' : ''}`);
  if (state.lastError) tooltip.push(`Last error: ${state.lastError}`);
  if (!state.capped) tooltip.push('Click for the HyperJest menu.');
  return {
    text: parts.join(' '),
    tooltip: tooltip.join('\n'),
    error: summary.failed > 0 && !running,
    warning: summary.failed === 0 && (state.paused || !!state.capped),
    command: state.capped ? 'hyperjest.runDeferred' : 'hyperjest.showMenu',
  };
}

export class StatusBar implements vscode.Disposable {
  readonly item: vscode.StatusBarItem;

  /** @param settings optional getter; supplies `statusBar.compact` when `update()` omits `compact`. */
  constructor(private readonly settings?: () => Pick<HyperJestSettings, 'statusBar'>) {
    this.item = vscode.window.createStatusBarItem('hyperjest.status', vscode.StatusBarAlignment.Right, 100);
    this.item.name = 'HyperJest';
    this.item.command = 'hyperjest.showMenu';
    this.item.text = '$(beaker) HyperJest';
    this.item.show();
  }

  update(input: StatusBarInput): void {
    const compact = input.compact ?? this.settings?.().statusBar.compact ?? false;
    const model = buildStatusBarModel({ ...input, compact });
    this.item.text = model.text;
    this.item.tooltip = model.tooltip;
    this.item.command = model.command;
    this.item.backgroundColor = model.error ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : model.warning ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}
