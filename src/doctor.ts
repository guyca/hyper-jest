import * as os from 'os';
import * as vscode from 'vscode';
import type { ProjectRegistry } from './discovery/projectRegistry';
import type { WorkerPool } from './workerPool';
import type { HyperJestSettings } from './core/settingsModel';
import type { DoctorPackage, DoctorReport } from './doctorView';
import { TESTED_JEST_DESCRIPTION } from './core/jestCompatibility';

/** Builds the Doctor report from discovery results, worker state and settings. */
export function buildDoctorReport(registry: ProjectRegistry, pool: WorkerPool, settings: HyperJestSettings, extensionVersion: string, extra?: DoctorReport['extraSections']): DoctorReport {
  const packages: DoctorPackage[] = [];
  const warnings: string[] = [];
  for (const e of registry.all()) {
    const spec = e.spec;
    const workers = pool.workersOf(spec.id);
    let workerState: string | undefined;
    switch (e.readiness.kind) {
      case 'ready': workerState = workers.length ? `ready (${workers.length} worker${workers.length > 1 ? 's' : ''})` : 'ready (idle, no live worker)'; break;
      case 'starting': workerState = 'starting'; break;
      case 'error': workerState = `error: ${e.readiness.error.kind}: ${e.readiness.error.message}`; break;
      default: workerState = workers.length ? `${workers.length} worker(s)` : 'cold';
    }
    const fixes: string[] = [];
    if (spec.status === 'unavailable') fixes.push(`Run \`yarn install\` (or npm install) in ${spec.repoRoot} so that \`jest\` resolves from ${spec.packageDir}.`);
    if (spec.status === 'unsupported') fixes.push(`HyperJest tests compatibility with Jest ${TESTED_JEST_DESCRIPTION} with jest-runner / jest-runner-groups.`);
    if (e.readiness.kind === 'error') fixes.push('Run the equivalent command shown by "HyperJest: Show Resolved Jest Config" in a terminal to see the full error, then "HyperJest: Restart".');
    for (const w of spec.warnings) if (/node/i.test(w)) fixes.push('Set `hyperjest.nodePath` or install the requested Node version with fnm/nvm.');
    packages.push({
      packageDir: spec.packageDir,
      displayName: spec.displayName,
      flavor: spec.flavor,
      status: spec.status,
      reason: spec.reason,
      configArg: spec.configArg,
      configFile: spec.configFile,
      selected: spec.selected !== false,
      jestVersion: spec.jestVersion,
      jestPkgDir: spec.jestPkgDir,
      nodePath: spec.nodePath,
      nodeVersion: spec.nodeVersion,
      workerState,
      bootstrapMs: e.readiness.kind === 'ready' ? e.readiness.ready.bootstrapMs : undefined,
      seams: e.readiness.kind === 'ready' ? e.readiness.ready.seams : undefined,
      warnings: [...spec.warnings, ...(e.readiness.kind === 'ready' ? e.readiness.ready.warnings : [])],
      fixes,
    });
  }
  for (const sk of registry.skippedPackages()) {
    if (sk.reason === 'noTests' || sk.reason === 'workspaceRoot') continue;
    packages.push({ packageDir: sk.packageDir, displayName: sk.packageDir.split('/').slice(-2).join('/'), flavor: 'unknown', status: 'notTest', reason: `${sk.reason}${sk.detail ? `: ${sk.detail}` : ''}`, warnings: [], fixes: [] });
  }
  const stats = pool.stats();
  if (!packages.some(p => p.status === 'ok')) warnings.push('No runnable Jest project was found in the workspace.');
  const s = settings as unknown as Record<string, unknown>;
  return {
    generatedAt: new Date().toISOString(),
    extensionVersion,
    vscodeVersion: vscode.version,
    hostNodeVersion: process.versions.node,
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
    settings: { runMode: s.runMode, engine: s.engine, maxWorkers: s.maxWorkers, nodePath: s.nodePath, smartStart: s.smartStart, coverage: s.coverage, liveComments: s.liveComments },
    packages,
    workers: {
      total: stats.live, busy: stats.busy, maxWorkers: stats.capacity,
      memoryBudgetMB: settings.memoryBudgetMB || Math.floor(os.totalmem() / 2 / 1048576),
      rssMB: Math.round(stats.rssBytes / 1048576),
    },
    warnings,
    extraSections: extra,
  };
}
