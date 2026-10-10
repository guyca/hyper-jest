/**
 * CLI engine: runs the project's `jest/bin/jest.js` in a fresh process with HyperJest's
 * dependency-free reporter (NDJSON on fd 3). Used when the warm engine is unavailable
 * (`hyperjest.engine: cli`, or a warm seam failed), for Doctor's "compare with plain Jest", and for
 * the cold `--findRelatedTests` fallback. No Jest internals involved: public CLI only.
 */
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import { scopeMatches } from './core/hyperConfig';
import type { Logger } from './core/logger';
import { createNdjsonSplitter, toWorkerToHost } from './core/cliEvents';
import { buildFindRelatedSpec, buildRunSpec, type RunSpecProject } from './core/runSpec';
import { PROTOCOL_VERSION, type OverlayChange, type ProjectSpec, type RunTestSelection, type UpdateSnapshotMode, type WorkerToHost } from './core/protocol';
import { removeRunArtifacts, runArtifactsDir, writeOverlayManifest } from './overlayManifest';

export interface CliRunRequest {
  spec: ProjectSpec;
  tests: RunTestSelection[];
  runId: string;
  updateSnapshot: UpdateSnapshotMode;
  overlay: readonly OverlayChange[];
  coverage: boolean;
  workerAssetsDir: string;
  extraEnv: Record<string, string>;
  timeoutMs: number;
  keepArtifacts: boolean;
  onMessage: (msg: WorkerToHost) => void;
  log: Logger;
}

export interface CliRunHandle {
  done: Promise<{ wasInterrupted: boolean; exitCode: number | null; error?: string }>;
  cancel(): void;
  pid?: number;
}

export function toRunSpecProject(spec: ProjectSpec): RunSpecProject {
  return {
    packageDir: spec.packageDir,
    jestPkgDir: spec.jestPkgDir ?? spec.packageDir,
    jestBinPath: spec.jestBinPath,
    configArg: spec.configArg,
    cliFilters: spec.cliFilters,
    env: spec.env,
    nodePath: spec.nodePath,
    nodeArgs: spec.nodeArgs,
  };
}

/** How much of a child's stderr is kept for error messages (the tail is what matters). */
const STDERR_TAIL_CHARS = 20000;
/** How long after the Jest process exited its stdio may stay open before the run settles anyway. */
const EXIT_CLOSE_GRACE_MS = 2000;

/** Starts a CLI run; results stream through `onMessage` as protocol messages. */
export function runCli(req: CliRunRequest): CliRunHandle {
  const tests = req.tests.filter(t => !req.spec.scope || scopeMatches(t.path, req.spec.scope.baseDir, req.spec.scope.tests));
  if (!tests.length) return { cancel() {}, done: Promise.resolve({ wasInterrupted: false, exitCode: 0 }) };
  const overlayManifestPath = writeOverlayManifest(req.runId, req.overlay);
  const spec = buildRunSpec({
    project: toRunSpecProject(req.spec),
    workerAssetsDir: req.workerAssetsDir,
    tests,
    updateSnapshot: req.updateSnapshot,
    runId: req.runId,
    coverage: req.coverage ? { directory: path.join(runArtifactsDir(req.runId), 'coverage') } : undefined,
    overlayManifestPath,
    extraEnv: req.extraEnv,
  });
  req.log.debug(`cli run ${req.runId}: ${spec.command} ${spec.args.join(' ')} (cwd ${spec.cwd})`);
  const started = Date.now();
  let child: ChildProcess;
  let cancelled = false;
  let sawRunComplete = false;
  let settled = false;
  let stderr = '';
  // Nothing reaches the store after the run settled (late fd-3 data, a second close/error).
  const emit = (m: WorkerToHost) => { if (settled) return; if (m.type === 'runComplete') sawRunComplete = true; req.onMessage(m); };

  const done = new Promise<{ wasInterrupted: boolean; exitCode: number | null; error?: string }>(resolve => {
    try {
      child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      finish(null, (e as Error).message);
      return;
    }
    const splitter = createNdjsonSplitter((event) => { for (const m of toWorkerToHost(event, req.runId)) emit(m); });
    const fd3 = child.stdio[3] as NodeJS.ReadableStream | null;
    fd3?.on('data', (d: Buffer) => splitter.push(d));
    child.stdout?.on('data', (d: Buffer) => req.log.trace(`[cli ${req.runId}] ${d.toString().trimEnd()}`));
    child.stderr?.on('data', (d: Buffer) => { const t = d.toString(); stderr = (stderr + t).slice(-STDERR_TAIL_CHARS); req.log.trace(`[cli ${req.runId} stderr] ${t.trimEnd()}`); });
    const timer = setTimeout(() => { req.log.warn(`cli run ${req.runId}: timeout after ${req.timeoutMs} ms; killing`); cancelled = true; kill(); }, req.timeoutMs);
    child.on('error', err => { clearTimeout(timer); finish(null, err.message); });
    // 'close' (not 'exit'): fires once every stdio stream, fd 3 included, has been fully read.
    child.on('close', (code) => {
      clearTimeout(timer);
      splitter.end();
      finish(code, undefined);
    });
    // A process a test left behind (`spawn(..., { stdio: 'inherit' })`, `sh -c 'server &'`) keeps
    // Jest's stdout/stderr open, so 'close' may never come: settle shortly after 'exit' instead.
    child.on('exit', (code) => {
      clearTimeout(timer);
      setTimeout(() => {
        if (settled) return;
        req.log.debug(`cli run ${req.runId}: stdio still open ${EXIT_CLOSE_GRACE_MS} ms after exit (a child process of the run holds it); settling`);
        splitter.end();
        finish(code, undefined);
      }, EXIT_CLOSE_GRACE_MS).unref?.();
    });

    function finish(code: number | null, error: string | undefined): void {
      if (settled) return;
      const err = error ?? (code !== null && code !== 0 && code !== 1 && !sawRunComplete ? `jest exited with code ${code}${stderr ? `: ${stderr.trim().split('\n').slice(-5).join('\n')}` : ''}` : undefined);
      if (!sawRunComplete) {
        emit({ v: PROTOCOL_VERSION, type: 'runComplete', runId: req.runId, wasInterrupted: cancelled, durationMs: Date.now() - started, memory: { rss: 0, heapUsed: 0 }, error: err });
      }
      settled = true;
      if (!req.keepArtifacts) removeRunArtifacts(req.runId);
      resolve({ wasInterrupted: cancelled, exitCode: code, error: err });
    }
  });

  function kill(): void {
    try { child?.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => { try { child?.kill('SIGKILL'); } catch { /* ignore */ } }, 2000).unref?.();
  }

  return {
    done,
    cancel: () => { cancelled = true; kill(); },
    get pid() { return child?.pid; },
  };
}

/** Cold affected-test discovery: `jest --listTests --findRelatedTests --json -- <sources>`. */
export function findRelatedTests(spec: ProjectSpec, sources: string[], runId: string, extraEnv: Record<string, string>, log: Logger, timeoutMs = 120000): Promise<string[]> {
  const rs = buildFindRelatedSpec({ project: toRunSpecProject(spec), sources, runId, extraEnv });
  return new Promise(resolve => {
    const out: Buffer[] = [];
    let stderr = '';
    let settled = false;
    let child: ChildProcess;
    const settle = (files: string[]) => { if (!settled) { settled = true; resolve(files); } };
    try {
      child = spawn(rs.command, rs.args, { cwd: rs.cwd, env: rs.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      log.warn(`findRelatedTests spawn failed: ${(e as Error).message}`);
      settle([]);
      return;
    }
    const timer = setTimeout(() => {
      log.warn(`findRelatedTests ${runId}: timeout after ${timeoutMs} ms; killing`);
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { out.push(d); });
    // stderr must be drained: haste-map warnings can exceed the pipe buffer and block Jest.
    child.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-STDERR_TAIL_CHARS); });
    child.on('error', err => { clearTimeout(timer); log.warn(`findRelatedTests ${runId}: ${err.message}`); settle([]); });
    // 'close' (not 'exit'): every stdout chunk has been read by then.
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(out).toString('utf8');
      const line = text.split('\n').find(l => l.trim().startsWith('['));
      try {
        const arr = line ? (JSON.parse(line) as unknown) : [];
        if (!line && code !== 0) log.warn(`findRelatedTests ${runId}: jest exited with code ${code}${stderr ? `: ${stderr.trim().split('\n').slice(-5).join('\n')}` : ''}`);
        settle(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string' && (!spec.scope || scopeMatches(x, spec.scope.baseDir, spec.scope.tests))) : []);
      } catch {
        settle([]);
      }
    });
  });
}
