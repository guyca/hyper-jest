/**
 * Editor hover (plan: Hover row). A trusted MarkdownString with HTML enabled: test name / status /
 * duration, the full failure message or value in a fence, an Expected/Actual word diff with 4 lines
 * of context, stack frames as `command:hyperjest.openFrame` links, "covered by N tests (M failing)"
 * and action links (Run / Debug / Show Diff / Copy Value).
 */
import * as vscode from 'vscode';
import type { FailureInfo, Frame, TestStatus } from './core/protocol';
import type { InlineEntry, LineView, LineViewFile, TestRecord } from './core/resultModel';
import type { ResultStore } from './results/resultStore';
import { compactDiff, wordDiff } from './results/lineView';

export const HOVER_LANGUAGES = ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'] as const;
export const HOVER_SELECTOR: vscode.DocumentSelector = HOVER_LANGUAGES.map(language => ({ language, scheme: 'file' }));

/** Commands the hover may invoke (whitelisted on the MarkdownString). */
export const HOVER_COMMANDS = [
  'hyperjest.runLineTests', 'hyperjest.debugLineTest', 'hyperjest.showDiff', 'hyperjest.copyValue', 'hyperjest.openFrame', 'hyperjest.updateTestSnapshots',
];

export interface HoverError { test?: TestRecord; failure: FailureInfo; }

export interface HoverModel {
  path: string;
  /** 0-based */
  line: number;
  /** Tests declared on this line. */
  declared: TestRecord[];
  /** Failures whose error source is this line. */
  errors: HoverError[];
  entries: InlineEntry[];
  coverage?: { state: NonNullable<LineView['state']>; tests: number; failing: number; perTest: boolean; stale: boolean };
}

/** Pure: collects what the hover shows for a line (undefined when nothing to show). */
export function buildHoverModel(store: ResultStore, view: LineViewFile, line: number): HoverModel | undefined {
  const lv = view.lines.get(line);
  const decl = view.declarations.get(line);
  if (!lv && !decl) return undefined;
  const model: HoverModel = { path: view.path, line, declared: [], errors: [], entries: [] };
  if (decl) for (const key of decl.testKeys) { const t = store.test(key); if (t) model.declared.push(t); }
  if (lv) {
    const seen = new Set<string>();
    for (const key of lv.failingTests) {
      const t = store.test(key);
      if (!t) continue;
      for (const f of t.failures) {
        if (f.frames.some(fr => fr.file === view.path && fr.line - 1 === line) || (f.frames.every(fr => fr.file !== view.path) && t.path === view.path && t.location && t.location.line - 1 === line)) {
          const sig = `${key}|${f.message}`;
          if (!seen.has(sig)) { seen.add(sig); model.errors.push({ test: t, failure: f }); }
        }
      }
      if (t.failures.length === 0 && lv.state === 'errorSource' && !seen.has(key)) { seen.add(key); model.errors.push({ test: t, failure: { message: `${t.fullName} failed`, frames: [] } }); }
    }
    const file = store.fileRecord(view.path);
    if (file?.testExecError) {
      const exec = file.testExecError;
      const top = exec.frames.find(fr => fr.file === view.path);
      if ((top && top.line - 1 === line) || (!top && line === 0 && lv.state === 'errorSource')) model.errors.push({ failure: exec });
    }
    model.entries = lv.entries.filter(e => e.kind !== 'error');
    if (lv.state) {
      model.coverage = { state: lv.state, tests: lv.tests.length, failing: lv.failingTests.length, perTest: lv.tests.length > 0, stale: lv.stale };
    }
  }
  if (model.declared.length === 0 && model.errors.length === 0 && model.entries.length === 0 && !model.coverage) return undefined;
  return model;
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

export function commandLink(title: string, command: string, args: unknown, tooltip?: string): string {
  const uri = `command:${command}?${encodeURIComponent(JSON.stringify([args]))}`;
  return `[${title}](${uri}${tooltip ? ` "${tooltip.replace(/"/g, '\'')}"` : ''})`;
}

export function statusIcon(status: TestStatus | 'unknown'): string {
  switch (status) {
    case 'passed': case 'focused': return '✓';
    case 'failed': case 'errored': return '✗';
    case 'todo': return '☐';
    case 'unknown': return '·';
    default: return '○';
  }
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fence(text: string, lang = ''): string {
  const body = text.replace(/\r\n/g, '\n').trimEnd();
  const ticks = body.includes('```') ? '````' : '```';
  return `${ticks}${lang}\n${body}\n${ticks}\n`;
}

function frameLink(f: Frame): string {
  const label = `${shortPath(f.file)}:${f.line}:${f.column}`;
  return commandLink(label, 'hyperjest.openFrame', { file: f.file, line: f.line, column: f.column }, 'Open this frame') + (f.functionName ? ` — \`${f.functionName}\`` : '');
}

function shortPath(file: string): string {
  const parts = file.split(/[\\/]/);
  return parts.length <= 2 ? file : parts.slice(-2).join('/');
}

/** Expected/actual as an HTML block: deletions (expected-only) and insertions (actual-only). */
export function renderDiffHtml(expected: string, actual: string): string {
  const html = compactDiff(wordDiff(expected, actual), (kind, text) => kind === 'del'
    ? `<span style="color:var(--vscode-gitDecoration-deletedResourceForeground);background-color:var(--vscode-diffEditor-removedTextBackground);"><del>${escapeHtml(text)}</del></span>`
    : `<span style="color:var(--vscode-gitDecoration-addedResourceForeground);background-color:var(--vscode-diffEditor-insertedTextBackground);"><ins>${escapeHtml(text)}</ins></span>`,
    4, '…');
  // Unchanged text was not escaped by the marker callback: escape it now without touching the spans.
  const escaped = html.split(/(<span[^>]*>(?:<del>|<ins>)[\s\S]*?(?:<\/del>|<\/ins>)<\/span>)/g)
    .map((piece, i) => (i % 2 === 1 ? piece : escapeHtml(piece)))
    .join('');
  return `<pre>${escaped}</pre>\n`;
}

const MAX_MESSAGE_LINES = 40;

function clampLines(text: string, max = MAX_MESSAGE_LINES): string {
  const lines = text.split('\n');
  return lines.length <= max ? text : lines.slice(0, max).join('\n') + `\n… (${lines.length - max} more lines)`;
}

export function renderHoverMarkdown(model: HoverModel): string {
  const out: string[] = [];
  const rendered = new Set<string>();
  const header = (t: TestRecord): string => {
    const duration = t.duration !== null && t.duration !== undefined ? ` · ${t.duration} ms` : '';
    const actions = [
      commandLink('Run', 'hyperjest.runLineTests', { testKey: t.testKey }, 'Run this test'),
      commandLink('Debug', 'hyperjest.debugLineTest', { testKey: t.testKey }, 'Debug this test'),
    ];
    if (t.failures.some(f => f.expected !== undefined && f.actual !== undefined)) actions.push(commandLink('Show Diff', 'hyperjest.showDiff', { testKey: t.testKey }, 'Open expected ↔ actual side by side'));
    return `**${escapeMd(t.fullName)}** ${statusIcon(t.status)} ${t.status}${duration}${t.stale ? ' (stale)' : ''} &nbsp; ${actions.join(' · ')}\n`;
  };
  for (const t of model.declared) {
    rendered.add(t.testKey);
    out.push(header(t));
    for (const f of t.failures) out.push(renderFailure(f, model.path));
  }
  for (const e of model.errors) {
    if (e.test) {
      if (!rendered.has(e.test.testKey)) { rendered.add(e.test.testKey); out.push(header(e.test)); }
      else continue; // already rendered with its failures above
    } else {
      out.push('**Test file failed to run** ✗\n');
    }
    out.push(renderFailure(e.failure, model.path));
  }
  if (model.entries.length > 0) {
    if (out.length) out.push('\n---\n');
    const values = model.entries.filter(e => e.kind === 'value');
    const logs = model.entries.filter(e => e.kind === 'log');
    if (values.length) {
      out.push(`**Value${values.length > 1 ? 's' : ''}** &nbsp; ${commandLink('Copy Value', 'hyperjest.copyValue', { path: model.path, line: model.line + 1 }, 'Copy the full value')}\n`);
      for (const v of values) out.push(fence(clampLines(v.longText ?? v.text)));
    }
    if (logs.length) {
      out.push(`**console.${logs[0].level ?? 'log'}**${logs.length > 1 ? ` (${logs.length})` : ''} &nbsp; ${commandLink('Copy', 'hyperjest.copyValue', { path: model.path, line: model.line + 1 }, 'Copy the output')}\n`);
      for (const l of logs) out.push(fence(clampLines(l.longText ?? l.text)));
    }
  }
  if (model.coverage) {
    if (out.length) out.push('\n---\n');
    const c = model.coverage;
    const stale = c.stale ? ' (stale: results predate your edit)' : '';
    if (c.perTest) {
      const failing = c.failing > 0 ? ` (${c.failing} failing)` : '';
      out.push(`${stateLabel(c.state)} — covered by ${c.tests} test${c.tests === 1 ? '' : 's'}${failing}${stale} &nbsp; ${commandLink('Run covering tests', 'hyperjest.runLineTests', { path: model.path, line: model.line + 1 }, 'Run the tests that execute this line')}\n`);
    } else {
      out.push(`${stateLabel(c.state)}${stale}\n`);
    }
  }
  return out.join('\n');
}

function stateLabel(state: NonNullable<LineView['state']>): string {
  switch (state) {
    case 'covered': return 'Covered';
    case 'partiallyCovered': return 'Partially covered (a branch or statement on this line never ran)';
    case 'notCovered': return 'Not covered by any test';
    case 'errorPath': return 'On the execution path of a failing test';
    case 'errorSource': return 'Error source';
  }
}

function renderFailure(f: FailureInfo, path: string): string {
  const out: string[] = [];
  if (f.message.trim()) out.push(fence(clampLines(f.message.trim()), 'text'));
  if (f.expected !== undefined && f.actual !== undefined) {
    out.push(`**Expected ↔ Actual**${f.matcherName ? ` (\`${f.matcherName}\`)` : ''}\n`);
    out.push(renderDiffHtml(f.expected, f.actual));
  }
  const frames = f.frames.filter(fr => !/[\\/]node_modules[\\/]/.test(fr.file) || fr.file === path);
  if (frames.length > 0) {
    out.push('**Stack**\n');
    for (const fr of frames.slice(0, 12)) out.push(`- ${frameLink(fr)}`);
    if (frames.length > 12) out.push(`- … ${frames.length - 12} more frames`);
    out.push('');
  }
  return out.join('\n');
}

function escapeMd(text: string): string {
  return text.replace(/([*_`[\]<>])/g, '\\$1');
}

// ---------------------------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------------------------

export class HyperJestHoverProvider implements vscode.HoverProvider {
  constructor(private readonly store: ResultStore, private readonly viewFor: (path: string) => LineViewFile | undefined) {}

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Hover> {
    if (document.uri.scheme !== 'file') return undefined;
    const view = this.viewFor(document.uri.fsPath);
    if (!view) return undefined;
    const model = buildHoverModel(this.store, view, position.line);
    if (!model) return undefined;
    const md = new vscode.MarkdownString(renderHoverMarkdown(model), true);
    md.isTrusted = { enabledCommands: HOVER_COMMANDS };
    md.supportHtml = true;
    return new vscode.Hover(md, document.lineAt(position.line).range);
  }
}
