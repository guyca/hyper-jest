/** Optional read-only parser validation against directories explicitly supplied by the caller. */
import * as fs from 'fs';
import * as path from 'path';
import { parseTestFile } from '../../../src/core/testParser';

function corpusRoots(): string[] {
  const raw = process.env.HYPERJEST_CORPUS_ROOTS;
  if (raw === undefined) return [];
  let roots: unknown;
  try { roots = JSON.parse(raw); } catch {
    throw new Error('HYPERJEST_CORPUS_ROOTS must be a JSON array of directory paths');
  }
  if (!Array.isArray(roots) || !roots.every(root => typeof root === 'string' && root.trim().length > 0)) {
    throw new Error('HYPERJEST_CORPUS_ROOTS must be a JSON array of non-empty directory paths');
  }
  return [...new Set((roots as string[]).map(root => {
    const dir = path.resolve(root);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new Error(`HYPERJEST_CORPUS_ROOTS directory does not exist: ${dir}`);
    }
    return dir;
  }))];
}

const SPEC_RE = /\.(spec|test)(\.legacy)?\.[jt]sx?$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage']);

function collect(dir: string, out: string[], budget: { left: number }): void {
  if (budget.left <= 0) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (budget.left <= 0) return;
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p, out, budget);
    else if (SPEC_RE.test(e.name)) { out.push(p); budget.left--; }
  }
}

const available = corpusRoots();
const maybe = available.length > 0 ? describe : describe.skip;

maybe('parser corpus (explicitly supplied spec files, read-only)', () => {
  it('parses every spec file without errors at a usable throughput', () => {
    const files: string[] = [];
    const budget = { left: Number(process.env.HYPERJEST_CORPUS_MAX ?? 5000) };
    for (const root of available) collect(root, files, budget);
    expect(files.length).toBeGreaterThan(0);

    let bytes = 0;
    let tests = 0;
    const errors: string[] = [];
    const t0 = process.hrtime.bigint();
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      bytes += src.length;
      const parsed = parseTestFile(src, file);
      if (parsed.parseError) errors.push(`${file}: ${parsed.parseError.message} (${parsed.parseError.line}:${parsed.parseError.column})`);
      const count = (nodes: typeof parsed.nodes): number => nodes.reduce((n, x) => n + (x.kind === 'test' ? 1 : 0) + count(x.children), 0);
      tests += count(parsed.nodes);
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const mbPerSec = bytes / 1048576 / (ms / 1000);
    // eslint-disable-next-line no-console
    console.info(`[corpus] ${files.length} files, ${(bytes / 1048576).toFixed(1)} MB, ${tests} tests, ${ms.toFixed(0)} ms (${mbPerSec.toFixed(1)} MB/s), ${errors.length} parse errors`);
    expect(errors).toEqual([]);
    expect(tests).toBeGreaterThan(0);
    // Generous bound (ts-jest-transpiled code, cold caches): the plan budgets "a few seconds" for ~6 MB.
    expect(mbPerSec).toBeGreaterThan(2);
  });
});
