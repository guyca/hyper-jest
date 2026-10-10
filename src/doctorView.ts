/**
 * Doctor report as a virtual markdown document (`hyperjest-doctor:report.md`). The report data
 * object is produced by doctor.ts (another module); this file renders it and serves it through a
 * TextDocumentContentProvider so it opens read-only with markdown highlighting.
 */
import * as vscode from 'vscode';
import type { ProjectSpec } from './core/protocol';

export const DOCTOR_SCHEME = 'hyperjest-doctor';
export const DOCTOR_REPORT_PATH = 'report.md';

export interface DoctorPackage {
  packageDir: string;
  displayName: string;
  flavor: ProjectSpec['flavor'] | 'unknown';
  status: ProjectSpec['status'] | 'e2e' | 'notTest';
  reason?: string;
  configArg?: string;
  jestVersion?: string;
  jestPkgDir?: string;
  nodePath?: string;
  nodeVersion?: string;
  nodeSource?: string;
  testFileCount?: number;
  /** Worker state (`ready`, `starting`, `error: …`, `idle`). */
  workerState?: string;
  bootstrapMs?: number;
  seams?: { envWrapper: boolean; probeTransformer: boolean; cachePrune: boolean };
  warnings: string[];
  fixes: string[];
}

export interface DoctorReport {
  generatedAt: string;
  extensionVersion: string;
  vscodeVersion: string;
  hostNodeVersion: string;
  workspaceFolders: string[];
  settings: Record<string, unknown>;
  packages: DoctorPackage[];
  workers: { total: number; busy: number; maxWorkers: number; memoryBudgetMB: number; rssMB: number };
  warnings: string[];
  /** Free-form sections appended at the end (e.g. "Compare with plain Jest"). */
  extraSections?: Array<{ title: string; body: string }>;
}

function code(text: string | undefined): string {
  return text ? `\`${text}\`` : '—';
}

/** Pure: markdown rendering of the report. */
export function renderDoctorReport(r: DoctorReport): string {
  const out: string[] = [];
  out.push('# HyperJest Doctor', '');
  out.push(`Generated ${r.generatedAt} · HyperJest ${r.extensionVersion} · VS Code ${r.vscodeVersion} · extension host node ${r.hostNodeVersion}`, '');
  out.push('## Workspace', '');
  for (const f of r.workspaceFolders) out.push(`- ${code(f)}`);
  if (r.workspaceFolders.length === 0) out.push('- (no workspace folder open)');
  out.push('');
  out.push('## Workers', '');
  out.push(`- ${r.workers.total} worker(s), ${r.workers.busy} busy, max ${r.workers.maxWorkers}; RSS ${r.workers.rssMB} MB of a ${r.workers.memoryBudgetMB} MB budget`, '');
  if (r.warnings.length) {
    out.push('## Warnings', '');
    for (const w of r.warnings) out.push(`- ⚠ ${w}`);
    out.push('');
  }
  out.push('## Packages', '');
  const byStatus = new Map<string, DoctorPackage[]>();
  for (const p of r.packages) {
    const list = byStatus.get(p.status) ?? [];
    list.push(p);
    byStatus.set(p.status, list);
  }
  out.push('| Status | Count |', '|---|---|');
  for (const [status, list] of byStatus) out.push(`| ${status} | ${list.length} |`);
  out.push('');
  for (const p of [...r.packages].sort((a, b) => a.packageDir.localeCompare(b.packageDir))) {
    out.push(`### ${p.displayName} — ${p.status}`, '');
    out.push(`- Package: ${code(p.packageDir)}`);
    out.push(`- Flavor: ${p.flavor}${p.configArg ? ` (config ${code(p.configArg)})` : ''}`);
    if (p.reason) out.push(`- Reason: ${p.reason}`);
    out.push(`- Jest: ${p.jestVersion ? `${p.jestVersion} at ${code(p.jestPkgDir)}` : 'not resolved'}`);
    out.push(`- Node: ${p.nodeVersion ? `${p.nodeVersion} (${code(p.nodePath)}${p.nodeSource ? `, from ${p.nodeSource}` : ''})` : 'not resolved'}`);
    if (p.testFileCount !== undefined) out.push(`- Test files: ${p.testFileCount}`);
    if (p.workerState) out.push(`- Worker: ${p.workerState}${p.bootstrapMs !== undefined ? ` (bootstrap ${p.bootstrapMs} ms)` : ''}`);
    if (p.seams) {
      const degraded = Object.entries(p.seams).filter(([, ok]) => !ok).map(([k]) => k);
      out.push(`- Warm-engine seams: ${degraded.length === 0 ? 'all installed' : `degraded (${degraded.join(', ')} unavailable)`}`);
    }
    for (const w of p.warnings) out.push(`- ⚠ ${w}`);
    for (const f of p.fixes) out.push(`- 💡 ${f}`);
    out.push('');
  }
  out.push('## Settings', '');
  out.push('```json', JSON.stringify(r.settings, null, 2), '```', '');
  for (const s of r.extraSections ?? []) out.push(`## ${s.title}`, '', s.body, '');
  return out.join('\n');
}

export class DoctorContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly docs = new Map<string, string>();

  /** Stores a report under `name` (default `report.md`) and refreshes an open document. */
  setReport(report: DoctorReport, name = DOCTOR_REPORT_PATH): vscode.Uri {
    return this.setContent(renderDoctorReport(report), name);
  }

  /** Serves arbitrary markdown (e.g. the "compare with plain Jest" result). */
  setContent(markdown: string, name: string): vscode.Uri {
    this.docs.set(name, markdown);
    const uri = uriFor(name);
    this.emitter.fire(uri);
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.path.replace(/^\//, '')) ?? '# HyperJest Doctor\n\nNo report yet. Run "HyperJest: Doctor".\n';
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

export function uriFor(name = DOCTOR_REPORT_PATH): vscode.Uri {
  return vscode.Uri.parse(`${DOCTOR_SCHEME}:${name}`);
}

/** Registers the provider and opens the report beside the active editor. */
export async function showDoctorReport(provider: DoctorContentProvider, report: DoctorReport): Promise<void> {
  const uri = provider.setReport(report);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.languages.setTextDocumentLanguage(doc, 'markdown');
  await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
}
