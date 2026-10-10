import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { OverlayChange } from './core/protocol';

/**
 * Per-run artifacts (overlay manifests with unsaved buffer text, CLI coverage dirs) live in ONE
 * private directory per extension-host session: `mkdtemp` gives an unpredictable name created with
 * mode 0700, so on a shared /tmp no other user can read the buffers or pre-create the tree (the
 * preload serves the manifest's text as module source). Name: `hyperjest-<pid>-XXXXXX`; directories
 * of extension hosts that are no longer alive are swept when a session directory is created, and the
 * own one is removed on process exit (and by `disposeRunArtifacts`).
 */
const SESSION_PREFIX = 'hyperjest-';
let sessionDir: string | undefined;
let exitHookInstalled = false;

/** Overridable base directory (tests). */
let baseDir: () => string = () => os.tmpdir();

/** Test seam: changes the base directory and forgets the current session directory. */
export function setRunArtifactsBaseForTests(dir: (() => string) | undefined): void {
  baseDir = dir ?? (() => os.tmpdir());
  sessionDir = undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Removes session directories of dead extension hosts (best effort; only directories we own). */
export function sweepStaleRunArtifacts(base = baseDir()): void {
  let names: string[];
  try { names = fs.readdirSync(base); } catch { return; }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  for (const name of names) {
    const m = /^hyperjest-(\d+)-[A-Za-z0-9]+$/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid || isAlive(pid)) continue;
    const dir = path.join(base, name);
    try {
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) continue;
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
}

function ensureSessionDir(): string {
  if (sessionDir && fs.existsSync(sessionDir)) return sessionDir;
  const base = baseDir();
  sweepStaleRunArtifacts(base);
  sessionDir = fs.mkdtempSync(path.join(base, `${SESSION_PREFIX}${process.pid}-`));
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => disposeRunArtifacts());
  }
  return sessionDir;
}

function runDirName(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Directory for per-run artifacts (overlay manifests, coverage dirs), private to this user. */
export function runArtifactsDir(runId: string): string {
  const dir = path.join(ensureSessionDir(), runDirName(runId));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Writes the overlay manifest consumed by dist/worker/overlayPreload.cjs (`HYPERJEST_OVERLAY`):
 * `{version, files: {<absPath>: {text, version}}}`. Returns undefined when there is nothing to overlay.
 */
export function writeOverlayManifest(runId: string, changes: readonly OverlayChange[]): string | undefined {
  const live = changes.filter(c => c.text !== null);
  if (!live.length) return undefined;
  const files: Record<string, { text: string; version: number }> = {};
  for (const c of live) files[c.path] = { text: c.text as string, version: c.version };
  const file = path.join(runArtifactsDir(runId), 'overlay.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, files }), { mode: 0o600 });
  return file;
}

export function removeRunArtifacts(runId: string): void {
  if (!sessionDir) return;
  try {
    fs.rmSync(path.join(sessionDir, runDirName(runId)), { recursive: true, force: true });
  } catch { /* best effort */ }
}

/** Removes this session's artifact directory (extension deactivation / process exit). */
export function disposeRunArtifacts(): void {
  const dir = sessionDir;
  sessionDir = undefined;
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}
