/** In-memory FsView for discovery tests. Paths are POSIX; directories are implied by file paths (or `dir/` keys). */
import * as path from 'path';
import type { FsView } from '../../../src/core/paths';

export interface MemFsOptions {
  /** Symlinked directories: link -> target (both absolute). Lookups and realpath follow them. */
  symlinks?: Record<string, string>;
  /** Files that are executable (besides any file named `node` / `node.exe`). */
  executables?: string[];
}

export interface MemFs extends FsView {
  files: Map<string, string>;
  dirs: Set<string>;
  /** Add or replace a file (directories are implied). */
  write(p: string, content: string): void;
}

export function createMemFs(entries: Record<string, string>, opts: MemFsOptions = {}): MemFs {
  const files = new Map<string, string>();
  const dirs = new Set<string>(['/']);
  const links = Object.entries(opts.symlinks ?? {}).map(([k, v]) => [path.resolve(k), path.resolve(v)] as const).sort((a, b) => b[0].length - a[0].length);
  const executables = new Set((opts.executables ?? []).map(p => path.resolve(p)));
  const addDirs = (p: string) => {
    let d = path.dirname(p);
    while (!dirs.has(d)) {
      dirs.add(d);
      d = path.dirname(d);
    }
  };
  const write = (p: string, content: string) => {
    const abs = path.resolve(p);
    if (p.endsWith('/')) {
      dirs.add(abs);
      addDirs(abs);
      return;
    }
    files.set(abs, content);
    addDirs(abs);
  };
  for (const [p, c] of Object.entries(entries)) write(p, c);
  for (const [link] of links) addDirs(link);
  const canon = (p: string): string => {
    let abs = path.resolve(p);
    for (const [link, target] of links) {
      if (abs === link || abs.startsWith(link + '/')) {
        abs = target + abs.slice(link.length);
        break;
      }
    }
    return abs;
  };
  return {
    files,
    dirs,
    write,
    readFile: p => files.get(canon(p)),
    isFile: p => files.has(canon(p)),
    isDirectory: p => dirs.has(canon(p)),
    readdir: p => {
      const dir = canon(p);
      if (!dirs.has(dir)) return [];
      const out = new Set<string>();
      const prefix = dir === '/' ? '/' : dir + '/';
      for (const f of [...files.keys(), ...dirs]) {
        if (f !== dir && f.startsWith(prefix)) out.add(f.slice(prefix.length).split('/')[0]);
      }
      for (const [link] of links) if (path.dirname(link) === dir) out.add(path.basename(link));
      return [...out].sort();
    },
    realpath: p => {
      const c = canon(p);
      return files.has(c) || dirs.has(c) ? c : path.resolve(p);
    },
    isExecutable: p => {
      const c = canon(p);
      if (!files.has(c)) return false;
      const base = path.basename(c);
      return executables.has(c) || executables.has(path.resolve(p)) || base === 'node' || base === 'node.exe';
    },
  };
}

/** `node -p process.version` fake: derives the version from a `/vX.Y.Z/` path segment or a lookup table. */
export function createFakeExec(versions: Record<string, string> = {}, calls: Array<{ file: string; args: string[]; env?: Record<string, string> }> = []) {
  const exec = (file: string, args: string[], env?: Record<string, string>) => {
    calls.push({ file, args, env });
    const fixed = versions[file];
    if (fixed === 'BROKEN') return undefined;
    if (fixed) return { status: 0, stdout: fixed + '\n' };
    const m = /\/v(\d+\.\d+\.\d+)\//.exec(file);
    if (m) return { status: 0, stdout: `v${m[1]}\n` };
    return undefined;
  };
  return Object.assign(exec, { calls });
}

export const pkgJson = (o: Record<string, unknown>): string => JSON.stringify(o, null, 2);
