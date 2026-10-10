#!/usr/bin/env node
/**
 * Discovery report: runs HyperJest's pure project discovery (src/core/projectSpec.ts) over real repos
 * and prints a per-package table plus a verification matrix. Read-only: it never loads a Jest config,
 * never runs Jest and only spawns `node -p process.version` on candidate Node binaries.
 *
 * Usage:
 *   node scripts/discovery-report.mjs                       # the 8 workspace1 repos next to hyper-jest
 *   node scripts/discovery-report.mjs --repo ../delay-of-game --repo ../mobile-modules
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
const workspace = path.resolve(extRoot, '..');
const DEFAULT_REPOS = ['mobile-apps-relops-automations', 'mobile-apps-engine', 'mobile-modules', 'mobile-apps-hybrid', 'branded-lite-platform', 'delay-of-game', 'branded-apps', 'appium-tests'];

// Synchronous stdout: `console.log` + `process.exit` truncates piped output beyond 64 KB (`--json` over all repos is ~300 KB).
const out = (...parts) => fs.writeSync(1, parts.join(' ') + '\n');

const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const repoArgs = argv.flatMap((a, i) => (a === '--repo' && argv[i + 1] ? [path.resolve(argv[i + 1])] : []));
const repos = repoArgs.length ? repoArgs : DEFAULT_REPOS.map(r => path.join(workspace, r));
const includeWorktrees = flag('--include-worktrees');
const asJson = flag('--json');
const showWarnings = flag('--show-warnings');

// --- bundle the TypeScript sources (never bundled into dist/ by esbuild.mjs) --------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperjest-discovery-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });
await build({
  entryPoints: {
    projectSpec: path.join(extRoot, 'src/core/projectSpec.ts'),
    shono: path.join(extRoot, 'src/core/shono.ts'),
    jestResolver: path.join(extRoot, 'src/core/jestResolver.ts'),
    settingsModel: path.join(extRoot, 'src/core/settingsModel.ts'),
    paths: path.join(extRoot, 'src/core/paths.ts'),
  },
  bundle: true, platform: 'node', format: 'cjs', target: 'node18', outdir: tmp, logLevel: 'silent', sourcemap: 'inline',
});
const req = createRequire(import.meta.url);
const { discoverProjects } = req(path.join(tmp, 'projectSpec.js'));
const { resolveShonoChain, describeShonoChain } = req(path.join(tmp, 'shono.js'));
const { createNodeResolveFn } = req(path.join(tmp, 'jestResolver.js'));
const { DEFAULT_SETTINGS } = req(path.join(tmp, 'settingsModel.js'));
const { nodeFs } = req(path.join(tmp, 'paths.js'));

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
  if (!fs.existsSync(repo)) { perRepo.push({ repo, missing: true }); continue; }
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
  out(JSON.stringify(perRepo.map(r => ({ repo: r.repo, packages: r.packageJsonPaths?.length, ms: r.ms, specs: r.result?.specs, skipped: r.result?.skipped })), null, 2));
  process.exit(0);
}

// --- table -------------------------------------------------------------------------------------
const home = os.homedir();
const short = p => (p ? p.replace(home, '~') : '');
const relTo = (base, p) => (p ? path.relative(base, p) || '.' : '');
const describeConfig = spec => {
  if (!spec.configArg) return spec.flavor === 'implicit' ? '(implicit)' : '';
  const m = /node_modules\/(@wix\/shono\/node_modules\/)?@wix\/shono-testjs\/dist\/src\/jestConfig\.js$/.exec(spec.configArg);
  if (m) return `${m[1] ? 'shono/…/' : ''}shono-testjs/dist/src/jestConfig.js`;
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

// --- shono chains (read-only, from the first shono spec of each repo) ---------------------------
out('\n=== shono chains (CLI-equivalent resolution; jestConfig.js is never loaded)');
const resolve = createNodeResolveFn(nodeFs);
for (const r of perRepo) {
  if (r.missing) continue;
  const shonoSpecs = r.result.specs.filter(s => s.flavor === 'shono' && s.status === 'ok');
  if (!shonoSpecs.length) continue;
  const sample = shonoSpecs.find(s => /member-view|hybrid-core|branded-lite-platform$|package-bundler$/.test(s.packageDir)) ?? shonoSpecs[0];
  const pkg = JSON.parse(fs.readFileSync(path.join(sample.packageDir, 'package.json'), 'utf8'));
  const chain = resolveShonoChain({ packageDir: sample.packageDir, pkg, existingNodePath: process.env.NODE_PATH, resolve, fs: nodeFs });
  out(`${short(r.repo)} (${shonoSpecs.length} shono packages) e.g. ${relTo(r.repo, sample.packageDir)}:`);
  if (chain.ok) {
    out(`  ${describeShonoChain(chain.chain)}`);
    out(`  configArg: ${short(chain.chain.configArg)}`);
    out(`  jest: ${sample.jestVersion} at ${short(sample.jestPkgDir)}  node: ${sample.nodeVersion} ${short(sample.nodePath)}`);
    out(`  env: ${Object.entries(sample.env).map(([k, v]) => `${k}=${short(v)}`).join(' ')}`);
    out(`  nodeArgs: ${sample.nodeArgs.join(' ')}`);
  } else {
    out(`  ERROR ${chain.error}`);
  }
}

// --- verification matrix (plan: "Verification" table) --------------------------------------------
out('\n=== verification matrix');
const all = perRepo.filter(r => !r.missing).flatMap(r => r.result.specs.map(s => ({ ...s, repo: r.repo })));
const allSkipped = perRepo.filter(r => !r.missing).flatMap(r => r.result.skipped.map(s => ({ ...s, repo: r.repo })));
const find = (repoName, pkgRel, pred = () => true) => all.find(s => path.basename(s.repo) === repoName && relTo(s.repo, s.packageDir) === pkgRel && pred(s));
const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });

{
  const repo = 'mobile-apps-relops-automations';
  const impl = find(repo, 'packages/mobile-apps-relops-automation-agent', s => s.flavor === 'implicit');
  const integ = find(repo, 'packages/mobile-apps-relops-automation-agent', s => s.flavor === 'script-config');
  check('relops agent: implicit spec carries --testPathIgnorePatterns=tests/integration', impl && impl.status === 'ok' && impl.cliFilters.testPathIgnorePatterns.join() === 'tests/integration', impl && JSON.stringify(impl.cliFilters));
  check('relops agent: tests/integration -> jest.integration.config.js (script-config)', integ && integ.status === 'ok' && integ.configArg?.endsWith('jest.integration.config.js'), integ && describeConfig(integ));
  check('relops: jest 29.7.0, node v24.19.0 from .nvmrc', impl && impl.jestVersion === '29.7.0' && impl.nodeVersion === 'v24.19.0', impl && `${impl.jestVersion} ${impl.nodeVersion}`);
  check('relops: .claude/worktrees/* excluded', !all.some(s => s.repo.endsWith(repo) && s.packageDir.includes('/.claude/worktrees/')));
  const ss = find(repo, 'plugins/store-screenshots');
  check('relops store-screenshots: node --test -> notJest', !ss || ss.status === 'notJest', ss && ss.reason);
}
{
  const repo = 'mobile-apps-engine';
  const unit = find(repo, 'packages/wix-one-app-engine', s => s.configArg?.endsWith('jest.unit.config.js'));
  const integ = find(repo, 'packages/wix-one-app-engine', s => s.configArg?.endsWith('jest.integration.config.js'));
  const e2e = find(repo, 'packages/wix-one-app-engine', s => s.configArg?.endsWith('e2e/jest.config.js'));
  const base = find(repo, 'packages/wix-one-app-engine', s => s.configArg?.endsWith('/jest.config.js') && !s.configArg.includes('/e2e/'));
  check('engine: src/** -> jest.unit.config.js (script-config, ok)', unit && unit.flavor === 'script-config' && unit.status === 'ok');
  check('engine: integration/** -> jest.integration.config.js (script-config, ok)', integ && integ.flavor === 'script-config' && integ.status === 'ok' && integ.cliFilters.testPathPatterns?.includes('./integration'), integ && JSON.stringify(integ.cliFilters));
  check('engine: e2e/jest.config.js listed as notJest/e2e', e2e && e2e.status === 'notJest', e2e && e2e.reason);
  check('engine: default jest.config.js not used as a project', !base);
  check('engine: jest 30.4.2, node v24.15.0 from .nvmrc', unit && unit.jestVersion === '30.4.2' && unit.nodeVersion === 'v24.15.0', unit && `${unit.jestVersion} ${unit.nodeVersion}`);
  const ci = find(repo, 'packages/wix-one-app-engine-ci-scripts');
  check('engine ci-scripts: implicit jest.config.ts', ci && ci.flavor === 'implicit' && ci.status === 'ok' && !ci.configArg, ci && describeConfig(ci));
  const storage = find(repo, 'packages/wix-one-app-storage');
  check('engine wix-one-app-storage: implicit jest.config.json, ok', storage && storage.status === 'ok' && storage.flavor === 'implicit');
  const sl = find(repo, 'packages/serverless/mobile-binary-metrics');
  check('engine serverless: nested jest 29.7.0 used (not root 30.4.2)', sl && sl.jestVersion === '29.7.0' && sl.jestPkgDir.includes('/serverless/'), sl && `${sl.jestVersion} ${short(sl.jestPkgDir)}`);
  const pb = find(repo, 'packages/package-bundler-packages/package-bundler');
  check('engine package-bundler: shono via shono-lib, jest 29.7.0 from shono-testjs dir', pb && pb.flavor === 'shono' && pb.status === 'ok' && pb.jestVersion === '29.7.0' && pb.jestPkgDir.includes('shono-testjs/node_modules/jest'), pb && `${pb.flavor} ${pb.jestVersion} ${short(pb.jestPkgDir)}`);
  const ai = find(repo, 'packages/ai-pr-review');
  check('engine ai-pr-review: node --test -> notJest', ai && ai.status === 'notJest', ai && ai.reason);
  const gen = find(repo, 'packages/cli/mobile-apps-generate-module-manifest');
  check('engine generate-module-manifest: plain node tests -> notJest (jest key is vestigial)', gen && gen.status === 'notJest', gen && `${gen.status} ${gen.reason ?? ''}`);
}
{
  const repo = 'mobile-modules';
  const mv = find(repo, 'packages/modules/wix-one-app-member-view');
  check('mobile-modules member-view: shono chain -> shono-testjs 9.136 (nested under @wix/shono)', mv && mv.flavor === 'shono' && mv.status === 'ok' && mv.configArg.includes('@wix/shono/node_modules/@wix/shono-testjs'), mv && describeConfig(mv));
  check('mobile-modules member-view: env RNTL_SKIP_AUTO_DETECT_FAKE_TIMERS, USE_HEADLESS_PB, NODE_PATH(engine)', mv && mv.env.RNTL_SKIP_AUTO_DETECT_FAKE_TIMERS === 'true' && mv.env.USE_HEADLESS_PB === 'true' && /wix-one-app-engine\/node_modules/.test(mv.env.NODE_PATH ?? ''), mv && JSON.stringify(mv.env));
  check('mobile-modules member-view: jest 29.7.0 (never root .bin 30.2), node v22.17.0, --max-old-space-size', mv && mv.jestVersion === '29.7.0' && mv.nodeVersion === 'v22.17.0' && mv.nodeArgs.includes('--max-old-space-size=4096'), mv && `${mv.jestVersion} ${mv.nodeVersion} ${mv.nodeArgs}`);
  const mk = find(repo, 'packages/modules/wix-one-app-marketing');
  check('mobile-modules marketing: shono wins over jest.config.js + jest key (no multipleConfigs failure)', mk && mk.flavor === 'shono' && mk.status === 'ok' && mk.warnings.some(w => /Implicit Jest config ignored/.test(w)), mk && `${mk.flavor} ${mk.status} ${mk.warnings.length}w`);
  const owner = find(repo, 'packages/modules/wix-one-app-branded-app-owner');
  check('mobile-modules branded-app-owner: inlined shono command recognised as shono', owner && owner.flavor === 'shono' && owner.status === 'ok');
  const mmRoot = find(repo, '.');
  check('mobile-modules root: not a Jest project (node scripts/*.test.js -> notJest, or skipped)', (mmRoot && mmRoot.status === 'notJest') || allSkipped.some(s => path.basename(s.repo) === repo && s.packageDir === s.repo), mmRoot && `${mmRoot.status}: ${mmRoot.reason}`);
  const shonoCount = all.filter(s => path.basename(s.repo) === repo && s.flavor === 'shono').length;
  check(`mobile-modules: ~45 shono packages (${shonoCount})`, shonoCount >= 40);
}
{
  const repo = 'mobile-apps-hybrid';
  const hs = all.filter(s => path.basename(s.repo) === repo);
  check('hybrid: 4 shono packages, shono-testjs 9.131 at root, jest 29.7.0, node v24.19.0', hs.length === 4 && hs.every(s => s.flavor === 'shono' && s.status === 'ok' && s.jestVersion === '29.7.0' && s.nodeVersion === 'v24.19.0' && /node_modules\/@wix\/shono-testjs\//.test(s.configArg)), `${hs.length} specs: ${hs.map(s => `${s.flavor}/${s.status}`).join(',')}`);
}
{
  const repo = 'branded-lite-platform';
  const bl = find(repo, 'packages/branded-lite-platform');
  check('branded-lite: shono (9.136), ok', bl && bl.flavor === 'shono' && bl.status === 'ok');
  check('branded-lite: detox/ and production-e2e/ package.json skipped (noTests)', allSkipped.filter(s => path.basename(s.repo) === repo && /(detox|production-e2e)$/.test(s.packageDir) && s.reason === 'noTests').length === 2);
}
{
  const repo = 'delay-of-game';
  const ds = all.filter(s => path.basename(s.repo) === repo);
  check('delay-of-game: 5 packages implicit (jest.config.cjs), jest 30.5.2', ds.length === 5 && ds.every(s => s.flavor === 'implicit' && s.status === 'ok' && s.jestVersion === '30.5.2' && !s.configArg), `${ds.length}: ${ds.map(s => `${s.flavor}/${s.status}/${s.jestVersion}`).join(',')}`);
  check('delay-of-game: engines >=20 satisfied by PATH node (v24.x)', ds[0] && /^v2[4-9]\./.test(ds[0].nodeVersion ?? ''), ds[0] && ds[0].nodeVersion);
}
{
  const repo = 'branded-apps';
  const leaf = find(repo, 'packages/server/branded-apps-server');
  check('branded-apps leaf: unavailable with yarn install hint', leaf && leaf.status === 'unavailable' && /yarn install/.test(leaf.reason ?? ''), leaf && `${leaf.status}: ${leaf.reason}`);
  check('branded-apps: .nvmrc 20.19.4 missing -> warning + fallback', leaf && leaf.warnings.some(w => /20\.19\.4 .*not installed/.test(w)) && !!leaf.nodeVersion, leaf && leaf.warnings.filter(w => /20\.19\.4/.test(w)).join(' | '));
  const rpc = find(repo, 'serverless/branded-rpc-forwarder');
  check('branded-apps branded-rpc-forwarder: jest ^27 -> unsupported, standalone repoRoot', rpc && rpc.status === 'unsupported' && rpc.repoRoot === rpc.packageDir, rpc && `${rpc.status} root=${relTo(rpc.repo, rpc.repoRoot)}`);
  check('branded-apps: nothing is ok (node_modules not installed)', !all.some(s => path.basename(s.repo) === repo && s.status === 'ok'));
}
{
  const repo = 'appium-tests';
  const ap = all.filter(s => path.basename(s.repo) === repo);
  check('appium-tests: not-jest (wdio/mocha), no ok specs', ap.every(s => s.status === 'notJest') && ap.length >= 1, ap.map(s => `${relTo(s.repo, s.packageDir)} ${s.status}: ${s.reason}`).join('; '));
}
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
