#!/usr/bin/env node
/**
 * Discovery report: runs HyperJest's pure project discovery (src/core/projectSpec.ts) over real repos
 * and prints a per-package table plus generic consistency checks. Read-only: it never loads a Jest config,
 * never runs Jest and only spawns `node -p process.version` on candidate Node binaries.
 *
 * Usage:
 *   node scripts/discovery-report.mjs                       # current directory
 *   node scripts/discovery-report.mjs --repo <repoDir> --repo <otherRepoDir>
 *   node scripts/discovery-report.mjs --json > report.json  # full specs + skipped packages
 *   node scripts/discovery-report.mjs --include-worktrees    # also walk .claude/worktrees
 *   node scripts/discovery-report.mjs --show-warnings        # print every warning per spec
 */
import { build } from 'esbuild';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.resolve(here, '..');

// Synchronous stdout: `console.log` + `process.exit` truncates piped output beyond 64 KB (`--json` over all repos is ~300 KB).
const out = (...parts) => fs.writeSync(1, parts.join(' ') + '\n');

const argv = process.argv.slice(2);
const repoArgs = [];
let includeWorktrees = false;
let asJson = false;
let showWarnings = false;
for (let i = 0; i < argv.length; i++) {
  switch (argv[i]) {
    case '--repo':
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('--repo requires a directory path');
      repoArgs.push(path.resolve(argv[++i]));
      break;
    case '--include-worktrees': includeWorktrees = true; break;
    case '--json': asJson = true; break;
    case '--show-warnings': showWarnings = true; break;
    default: throw new Error(`Unknown option: ${argv[i]}`);
  }
}
const repos = [...new Set(repoArgs.length ? repoArgs : [process.cwd()])];

// --- bundle the TypeScript sources (never bundled into dist/ by esbuild.mjs) --------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperjest-discovery-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });
await build({
  entryPoints: {
    projectSpec: path.join(extRoot, 'src/core/projectSpec.ts'),
    settingsModel: path.join(extRoot, 'src/core/settingsModel.ts'),
  },
  bundle: true, platform: 'node', format: 'cjs', target: 'node18', outdir: tmp, logLevel: 'silent', sourcemap: 'inline',
});
const req = createRequire(import.meta.url);
const { discoverProjects } = req(path.join(tmp, 'projectSpec.js'));
const { DEFAULT_SETTINGS } = req(path.join(tmp, 'settingsModel.js'));

// --- collect package.json files (what workspace.findFiles would hand the host) ------------------
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', 'ios', 'android', 'Pods', '.yarn', 'out']);
function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (!includeWorktrees && e.name === 'worktrees' && path.basename(dir) === '.claude') continue;
      walk(p, out);
    } else if (e.isFile() && e.name === 'package.json') {
      out.push(p);
    }
  }
}

const started = Date.now();
const nodeVersionCache = new Map();
const perRepo = [];
for (const repo of repos) {
  if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) { perRepo.push({ repo, missing: true }); continue; }
  const packageJsonPaths = [];
  walk(repo, packageJsonPaths);
  const t0 = Date.now();
  const result = discoverProjects({
    packageJsonPaths, settings: DEFAULT_SETTINGS, homeDir: os.homedir(), platform: process.platform, env: process.env,
    workspaceFolders: [repo], nodeVersionCache,
  });
  perRepo.push({ repo, packageJsonPaths, result, ms: Date.now() - t0 });
}

if (asJson) {
  out(JSON.stringify(perRepo.map(r => ({ repo: r.repo, missing: r.missing ?? false, packages: r.packageJsonPaths?.length, ms: r.ms, specs: r.result?.specs, skipped: r.result?.skipped })), null, 2));
  process.exit(perRepo.some(r => r.missing) ? 1 : 0);
}

// --- table -------------------------------------------------------------------------------------
const home = os.homedir();
const short = p => (p ? p.replace(home, '~') : '');
const relTo = (base, p) => (p ? path.relative(base, p) || '.' : '');
const describeConfig = spec => {
  if (!spec.configArg) return spec.flavor === 'implicit' ? '(implicit)' : '';
  return relTo(spec.packageDir, spec.configArg);
};
function table(rows, headers) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i] ?? '').length)));
  const line = cells => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
  out(line(headers));
  out(widths.map(w => '-'.repeat(w)).join('  '));
  for (const r of rows) out(line(r));
}

for (const r of perRepo) {
  out(`\n=== ${short(r.repo)} ${r.missing ? '(MISSING)' : `— ${r.packageJsonPaths.length} package.json, ${r.result.specs.length} specs, ${r.result.skipped.length} skipped, ${r.ms} ms`}`);
  if (r.missing) continue;
  const rows = r.result.specs.map(s => [
    relTo(r.repo, s.packageDir), s.flavor, s.status, describeConfig(s), s.jestVersion ?? '-', s.nodeVersion ?? '-',
    s.cliFilters.testPathIgnorePatterns.length ? `ignore=${s.cliFilters.testPathIgnorePatterns.join(',')}` : (s.cliFilters.testPathPatterns?.length ? `paths=${s.cliFilters.testPathPatterns.join(',')}` : ''),
    s.warnings.length ? `${s.warnings.length}w` : '',
  ]);
  table(rows, ['package', 'flavor', 'status', 'configArg', 'jest', 'node', 'cliFilters', 'warn']);
  const skippedByReason = {};
  for (const s of r.result.skipped) (skippedByReason[s.reason] ??= []).push(relTo(r.repo, s.packageDir));
  for (const [reason, list] of Object.entries(skippedByReason)) out(`  skipped[${reason}] (${list.length}): ${list.slice(0, 8).join(', ')}${list.length > 8 ? ', …' : ''}`);
  const nonOk = r.result.specs.filter(s => s.status !== 'ok');
  for (const s of nonOk) out(`  ${s.status.padEnd(11)} ${relTo(r.repo, s.packageDir)}${s.configArg ? ' [' + describeConfig(s) + ']' : ''}: ${s.reason ?? ''}`);
  if (showWarnings) for (const s of r.result.specs) for (const w of s.warnings) out(`  warn ${s.displayName}: ${w}`);
}

// --- consistency checks -----------------------------------------------------------------------
out('\n=== consistency checks');
const all = perRepo.filter(r => !r.missing).flatMap(r => r.result.specs);
const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
for (const r of perRepo) check('repository directory exists', !r.missing, short(r.repo));
{
  const ids = all.map(s => s.id);
  check('all spec ids are unique', new Set(ids).size === ids.length, `${ids.length} specs`);
  check('no spec resolves jest through node_modules/.bin', !all.some(s => (s.jestBinPath ?? '').includes('/.bin/') || (s.jestPkgDir ?? '').includes('/.bin/')));
}

let fails = 0;
for (const c of checks) {
  if (!c.ok) fails++;
  out(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  — ${c.detail}` : ''}`);
}
out(`\n${checks.length - fails}/${checks.length} checks passed in ${Date.now() - started} ms (node validations spawned: ${nodeVersionCache.size})`);
process.exit(fails ? 1 : 0);
