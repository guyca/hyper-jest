#!/usr/bin/env node
/**
 * HyperJest worker driver: forks dist/worker/hyperjestWorker.cjs for a package directory and prints
 * every worker message as NDJSON on stdout (worker stderr is forwarded prefixed with `[stderr]`).
 * This is the troubleshooting tool for the warm engine; no VS Code involved.
 *
 *   node scripts/worker-driver.mjs <command> [options] [args]
 *
 * Commands
 *   init                         bootstrap only (prints ready/initError)
 *   run <file...>                run test files   [--names "a,b"] [--update none|new|all] [--repeat N] [--cancel-after MS]
 *   overlay <file> <contentFile> [testFile...]
 *                                set an overlay for <file> from <contentFile>, then run the test files
 *                                (default: <file> itself; --no-run skips the run)
 *   show-config                  resolved globalConfig + project configs (JSON)
 *   list-tests                   every test file Jest would match
 *   graph                        forward dependency graph
 *
 * Options
 *   --pkg <dir>          package dir (cwd for the worker); default: process.cwd()
 *   -c, --config <file>  config passed as `-c`
 *   --node <path>        node binary for the worker; default: current node
 *   --env K=V            extra env (repeatable). NODE_ENV/BABEL_ENV default to "test".
 *   --ignore <pattern>   testPathIgnorePatterns entry (repeatable)
 *   --slot <n>           worker slot (JEST_WORKER_ID = slot + 1); default 0
 *   --no-coverage | --no-per-test | --no-live | --instrument-tests | --skip-global-setup | --trace
 *   --timeout <ms>       give up waiting for the terminal message; default 180000
 *   --quiet              do not print fileStart/testStart/console/value/coverage messages (summary only)
 */
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.resolve(here, '..', 'dist', 'worker', 'hyperjestWorker.cjs');
const V = 1;

function parseArgs(argv) {
  const opts = { env: {}, ignore: [], names: undefined, update: 'new', repeat: 1, cancelAfter: 0, timeout: 180000, slot: 0,
    coverage: true, perTest: true, live: true, instrumentTests: false, globalSetup: 'once', trace: false, quiet: false, run: true };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { i += 1; if (i >= argv.length) throw new Error(`missing value for ${a}`); return argv[i]; };
    switch (a) {
      case '--pkg': opts.pkg = path.resolve(next()); break;
      case '-c': case '--config': opts.config = path.resolve(next()); break;
      case '--node': opts.node = next(); break;
      case '--env': { const kv = next(); const eq = kv.indexOf('='); if (eq < 0) throw new Error(`--env expects K=V, got ${kv}`); opts.env[kv.slice(0, eq)] = kv.slice(eq + 1); break; }
      case '--ignore': opts.ignore.push(next()); break;
      case '--names': opts.names = next().split(',').map(s => s.trim()).filter(Boolean); break;
      case '--update': opts.update = next(); break;
      case '--repeat': opts.repeat = Number(next()); break;
      case '--cancel-after': opts.cancelAfter = Number(next()); break;
      case '--timeout': opts.timeout = Number(next()); break;
      case '--slot': opts.slot = Number(next()); break;
      case '--no-coverage': opts.coverage = false; break;
      case '--no-per-test': opts.perTest = false; break;
      case '--no-live': opts.live = false; break;
      case '--instrument-tests': opts.instrumentTests = true; break;
      case '--skip-global-setup': opts.globalSetup = 'skip'; break;
      case '--trace': opts.trace = true; break;
      case '--quiet': opts.quiet = true; break;
      case '--no-run': opts.run = false; break;
      case '-h': case '--help': usage(0); break;
      default:
        if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
        positional.push(a);
    }
  }
  opts.pkg ??= process.cwd();
  return { opts, positional };
}

function usage(code) {
  process.stderr.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 30).map(l => l.replace(/^ \*\s?/, '')).join('\n') + '\n');
  process.exit(code);
}

function resolveJest(pkgDir) {
  const req = createRequire(path.join(pkgDir, 'package.json'));
  const pkgJson = req.resolve('jest/package.json');
  return { jestPkgDir: path.dirname(pkgJson), jestVersion: JSON.parse(readFileSync(pkgJson, 'utf8')).version };
}

const QUIET_TYPES = new Set(['fileStart', 'testStart', 'console', 'value', 'coverageMeta', 'testCoverage', 'fileLoad', 'fileCoverage']);

async function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2));
  const command = positional.shift();
  if (!command) usage(1);
  const { jestPkgDir, jestVersion } = resolveJest(opts.pkg);
  const env = { ...process.env, NODE_ENV: process.env.NODE_ENV ?? 'test', BABEL_ENV: process.env.BABEL_ENV ?? 'test', FORCE_COLOR: '0', NO_COLOR: '1', HYPERJEST_WORKER: '1', ...opts.env };
  for (const k of ['ELECTRON_RUN_AS_NODE', 'CLAUDECODE', 'CLAUDE_CODE', 'CURSOR_AGENT', 'AI_AGENT']) delete env[k];

  const child = fork(WORKER, [], { cwd: opts.pkg, execPath: opts.node ?? process.execPath, env, serialization: 'json', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout.on('data', d => process.stderr.write(`[stdout] ${d}`));
  child.stderr.on('data', d => process.stderr.write(`[stderr] ${d}`));
  child.on('exit', (code, signal) => { if (!done) { process.stderr.write(`worker exited early (code ${code}, signal ${signal})\n`); process.exit(code ?? 1); } });

  let done = false;
  const sendMsg = m => child.send({ v: V, ...m });
  const waitFor = (pred, timeoutMs = opts.timeout) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${timeoutMs} ms waiting for ${pred.name || 'message'}`)), timeoutMs);
    const onMsg = m => { if (pred(m)) { clearTimeout(t); child.off('message', onMsg); resolve(m); } };
    child.on('message', onMsg);
  });
  const counts = {};
  child.on('message', m => {
    counts[m.type] = (counts[m.type] ?? 0) + 1;
    if (opts.quiet && QUIET_TYPES.has(m.type)) return;
    process.stdout.write(JSON.stringify(m) + '\n');
  });

  const spec = {
    id: 'driver', displayName: path.basename(opts.pkg), repoRoot: opts.pkg, packageDir: opts.pkg,
    flavor: opts.config ? 'script-config' : 'implicit', status: 'ok', configArg: opts.config, jestPkgDir, jestVersion,
    jestBinPath: path.join(jestPkgDir, 'bin', 'jest.js'), nodePath: opts.node ?? process.execPath, nodeArgs: [], env: {},
    cliFilters: { testPathIgnorePatterns: opts.ignore }, e2ePatterns: [], warnings: [],
  };
  const flags = { coverage: opts.coverage, perTestCoverage: opts.perTest, liveComments: opts.live, instrumentTestFiles: opts.instrumentTests, globalSetup: opts.globalSetup, tsJestDiagnostics: 'keep', trace: opts.trace };

  const t0 = Date.now();
  sendMsg({ type: 'init', spec, flags, slot: opts.slot, workerAssetsDir: path.dirname(WORKER) });
  const first = await waitFor(function readyOrInitError(m) { return m.type === 'ready' || m.type === 'initError'; });
  const bootstrapMs = Date.now() - t0;
  if (first.type === 'initError') { process.stderr.write(`initError ${first.kind}: ${first.message}\n`); done = true; sendMsg({ type: 'shutdown' }); process.exitCode = 1; return; }
  process.stderr.write(`ready: jest ${first.jestVersion} node ${first.nodeVersion} seams=${JSON.stringify(first.seams)} bootstrap=${first.bootstrapMs}ms (driver ${bootstrapMs}ms) warnings=${first.warnings.length}\n`);

  let runCounter = 0;
  const runFiles = async (files, names) => {
    const runId = `run-${++runCounter}`;
    const start = Date.now();
    sendMsg({ type: 'run', runId, tests: files.map(f => ({ path: path.resolve(opts.pkg, f), names })), updateSnapshot: opts.update, priority: 0, reason: 'explicit' });
    if (opts.cancelAfter > 0) setTimeout(() => sendMsg({ type: 'cancel', runId }), opts.cancelAfter);
    const rc = await waitFor(function runComplete(m) { return m.type === 'runComplete' && m.runId === runId; });
    process.stderr.write(`${runId}: ${Date.now() - start} ms (worker ${rc.durationMs} ms) interrupted=${rc.wasInterrupted} rss=${(rc.memory.rss / 1048576).toFixed(0)}MB heap=${(rc.memory.heapUsed / 1048576).toFixed(0)}MB${rc.error ? ` error=${rc.error.split('\n')[0]}` : ''}\n`);
    return rc;
  };

  try {
    switch (command) {
      case 'init':
        break;
      case 'run': {
        if (!positional.length) throw new Error('run needs at least one test file');
        for (let i = 0; i < opts.repeat; i++) await runFiles(positional, opts.names);
        break;
      }
      case 'overlay': {
        const [file, contentFile, ...testFiles] = positional;
        if (!file || !contentFile) throw new Error('overlay <file> <contentFile> [testFile...]');
        const abs = path.resolve(opts.pkg, file);
        sendMsg({ type: 'overlay', changes: [{ path: abs, text: readFileSync(contentFile, 'utf8'), version: Date.now() % 1e9 }] });
        if (opts.run) await runFiles(testFiles.length ? testFiles : [abs], opts.names);
        break;
      }
      case 'show-config':
        sendMsg({ type: 'showConfig' });
        await waitFor(function showConfigResult(m) { return m.type === 'showConfigResult'; });
        break;
      case 'list-tests':
        sendMsg({ type: 'listTests' });
        await waitFor(function listTestsResult(m) { return m.type === 'listTestsResult'; });
        break;
      case 'graph': {
        const start = Date.now();
        sendMsg({ type: 'graph' });
        const g = await waitFor(function graphResult(m) { return m.type === 'graphResult'; });
        process.stderr.write(`graph: ${Object.keys(g.forward).length} files, ${g.testFiles.length} test files, ${g.unresolved} unresolved in ${Date.now() - start} ms\n`);
        break;
      }
      default:
        throw new Error(`unknown command ${command}`);
    }
  } finally {
    done = true;
    process.stderr.write(`messages: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}\n`);
    sendMsg({ type: 'shutdown' });
    setTimeout(() => child.kill('SIGKILL'), 2000).unref();
  }
}

main().catch(e => { process.stderr.write(`${e.stack ?? e}\n`); process.exit(1); });
