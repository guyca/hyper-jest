/**
 * Path helpers and the injectable file-system view used by project discovery.
 *
 * Pure: no 'vscode', no process-global state. Every function that touches the disk takes an
 * `FsView`, so unit tests run against in-memory fakes and the host passes `nodeFs`.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Minimal synchronous file-system view. Implementations must never throw; they return "absent" values. */
export interface FsView {
  /** File text (utf8) or undefined when the file is missing or unreadable. */
  readFile(p: string): string | undefined;
  isFile(p: string): boolean;
  isDirectory(p: string): boolean;
  /** Directory entries (names only); [] when missing. */
  readdir(p: string): string[];
  /** Canonical path (symlinks resolved); the normalized input when it cannot be resolved. */
  realpath(p: string): string;
  /** True for an existing regular file the current user may execute. */
  isExecutable(p: string): boolean;
}

/** Real file system. */
export const nodeFs: FsView = {
  readFile: p => {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return undefined;
    }
  },
  isFile: p => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
  isDirectory: p => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  readdir: p => {
    try {
      return fs.readdirSync(p);
    } catch {
      return [];
    }
  },
  realpath: p => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return normalizePath(p);
    }
  },
  isExecutable: p => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
};

/** `path.resolve` plus trailing-separator removal (the root keeps its separator). */
export function normalizePath(p: string): string {
  const resolved = path.resolve(p);
  if (resolved.length > 1 && resolved.endsWith(path.sep) && path.dirname(resolved) !== resolved) {
    return resolved.slice(0, -1);
  }
  return resolved;
}

/** Forward-slash form of a path (for globs). No-op on POSIX. */
export function toPosix(p: string): string {
  return path.sep === '\\' ? p.replace(/\\/g, '/') : p;
}

/** True when `child` equals `parent` or lives below it (separator aware, no realpath). */
export function isUnder(child: string, parent: string): boolean {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  if (c === p) return true;
  const prefix = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(prefix);
}

/** `dir` and all its ancestors up to and including the file-system root. */
export function ancestors(dir: string): string[] {
  const out: string[] = [];
  let cur = normalizePath(dir);
  for (;;) {
    out.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return out;
}

/** Ancestors of `dir` (inclusive) that are at or below `stopAt` (inclusive). Without `stopAt`, all of them. */
export function ancestorsUpTo(dir: string, stopAt?: string): string[] {
  const all = ancestors(dir);
  if (!stopAt) return all;
  const stop = normalizePath(stopAt);
  const idx = all.indexOf(stop);
  return idx === -1 ? all : all.slice(0, idx + 1);
}

/** Parse a JSON file; undefined when missing or invalid. */
export function readJson<T = unknown>(p: string, fsv: FsView): T | undefined {
  const text = fsv.readFile(p);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** The subset of package.json that discovery reads. */
export interface PackageJsonLike {
  name?: string;
  version?: string;
  type?: string;
  main?: string;
  bin?: string | Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  workspaces?: string[] | { packages?: string[]; nohoist?: string[] };
  jest?: unknown;
  wix?: { isOneAppModule?: boolean; [k: string]: unknown };
  shono?: { testjs?: Record<string, unknown>; [k: string]: unknown };
  [k: string]: unknown;
}

/** Workspace globs declared by a root package.json (`workspaces: []` or `workspaces: {packages: []}`). */
export function workspaceGlobs(pkg: PackageJsonLike | undefined): string[] | undefined {
  if (!pkg) return undefined;
  const ws = pkg.workspaces;
  if (Array.isArray(ws)) return ws.filter((x): x is string => typeof x === 'string');
  if (ws && typeof ws === 'object' && Array.isArray(ws.packages)) {
    return ws.packages.filter((x): x is string => typeof x === 'string');
  }
  return undefined;
}

export function hasWorkspaces(pkg: PackageJsonLike | undefined): boolean {
  return workspaceGlobs(pkg) !== undefined;
}

/** Nearest directory at or above `startDir` (bounded by `stopAt`, inclusive) that holds a package.json. */
export function findNearestPackageJsonDir(startDir: string, fsv: FsView, stopAt?: string): string | undefined {
  for (const dir of ancestorsUpTo(startDir, stopAt)) {
    if (fsv.isFile(path.join(dir, 'package.json'))) return dir;
  }
  return undefined;
}

/**
 * Repo root for a package: the nearest directory at or above `packageDir` whose package.json declares
 * `workspaces` (array or `{packages}`). Nested roots (e.g. `.claude/worktrees/<x>`) win over outer ones.
 * Falls back to `packageDir` itself (standalone project).
 */
export function findRepoRoot(packageDir: string, fsv: FsView): string {
  for (const dir of ancestors(packageDir)) {
    const pkg = readJson<PackageJsonLike>(path.join(dir, 'package.json'), fsv);
    if (pkg && hasWorkspaces(pkg)) return dir;
  }
  return normalizePath(packageDir);
}

/** Path segments that mark a Claude Code worktree checkout. */
export const WORKTREE_MARKER = ['.claude', 'worktrees'] as const;

/**
 * The worktree checkout directory (`<repo>/.claude/worktrees/<name>`) containing `p`, if any.
 * Uses the innermost marker so worktrees nested inside worktrees still resolve to the nearest one.
 */
export function worktreeRootOf(p: string): string | undefined {
  const segs = normalizePath(p).split(path.sep);
  for (let i = segs.length - 1; i >= 1; i--) {
    if (segs[i - 1] === WORKTREE_MARKER[0] && segs[i] === WORKTREE_MARKER[1] && i + 1 < segs.length) {
      return segs.slice(0, i + 2).join(path.sep) || path.sep;
    }
  }
  return undefined;
}

/**
 * Worktree exclusion rule: a path inside `.claude/worktrees/<x>` is excluded unless one of the open
 * workspace folders lives inside that same worktree (the user opened the worktree on purpose).
 */
export function isExcludedWorktreePath(p: string, workspaceFolders: readonly string[] = []): boolean {
  const wt = worktreeRootOf(p);
  if (!wt) return false;
  return !workspaceFolders.some(f => isUnder(f, wt));
}

export function isUnderNodeModules(p: string): boolean {
  return normalizePath(p).split(path.sep).includes('node_modules');
}

/** The workspace folder that contains `p` (longest match), if any. */
export function containingWorkspaceFolder(p: string, workspaceFolders: readonly string[] = []): string | undefined {
  let best: string | undefined;
  for (const f of workspaceFolders) {
    if (isUnder(p, f) && (!best || normalizePath(f).length > normalizePath(best).length)) best = f;
  }
  return best;
}

/** Posix-style path relative to the containing workspace folder, or the absolute posix path. */
export function workspaceRelativePosix(p: string, workspaceFolders: readonly string[] = []): string {
  const folder = containingWorkspaceFolder(p, workspaceFolders);
  return toPosix(folder ? path.relative(folder, p) : normalizePath(p));
}
