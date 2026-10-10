/**
 * End-to-end check of the built bundles against the repo's own Jest 29.7 and the sample fixture.
 * Gated: HYPERJEST_IT=1 and `node esbuild.mjs` must have produced dist/worker/*.cjs.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseCliEvents, type CliEvent, type CliFileCoverageEvent, type CliFileResultEvent, type CliRunCompleteEvent, type CliTestResultEvent } from '../../../src/core/cliEvents';
import { buildRunSpec } from '../../../src/core/runSpec';

const ROOT = path.resolve(__dirname, '../../..');
const ASSETS = path.join(ROOT, 'dist/worker');
const FIXTURE = path.join(ROOT, 'tests/fixtures/sample-project');
const JEST_PKG = path.join(ROOT, 'node_modules/jest');
const enabled = process.env.HYPERJEST_IT === '1' && fs.existsSync(path.join(ASSETS, 'reporter.cjs')) && fs.existsSync(path.join(ASSETS, 'overlayPreload.cjs'));

function copyFixture(name: string): string {
  // realpath: macOS tmp dirs are symlinks (/var -> /private/var) and Jest only runs files under the realpath rootDir.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `hyperjest-${name}-`)));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function runSpec(spec: { command: string; args: string[]; cwd: string; env: Record<string, string> }): Promise<{ code: number | null; events: CliEvent[]; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    const fd3: Buffer[] = [];
    let stderr = '';
    child.stdio[3]!.on('data', (c: Buffer) => fd3.push(c));
    child.stderr!.on('data', c => { stderr += String(c); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, events: parseCliEvents(Buffer.concat(fd3).toString('utf8')), stderr }));
  });
}

(enabled ? describe : describe.skip)('CLI reporter + overlay end-to-end (jest 29.7, sample fixture)', () => {
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

  it('streams results, console, coverage and duplicates through buildRunSpec argv', async () => {
    const dir = copyFixture('run'); dirs.push(dir);
    const spec = buildRunSpec({
      project: { packageDir: dir, jestPkgDir: JEST_PKG, env: {}, nodeArgs: [] },
      workerAssetsDir: ASSETS, runId: 'e2e', nodePath: process.execPath, hostEnv: process.env,
      tests: [{ path: path.join(dir, 'src/__tests__/math.test.js') }, { path: path.join(dir, 'src/__tests__/greet.test.js') }],
      updateSnapshot: 'new', coverage: { directory: path.join(dir, '.hj-cov') },
    });
    const { code, events, stderr } = await runSpec(spec);
    expect(code).toBe(1); // the fixture has an intentionally failing test
    expect(stderr).not.toMatch(/reporterError|TypeError/);
    const types = events.map(e => e.type);
    expect(types[0]).toBe('runStart');
    expect(types[types.length - 1]).toBe('runComplete');
    expect(types.filter(t => t === 'fileResult')).toHaveLength(2);
    expect(types.filter(t => t === 'fileCoverage')).toHaveLength(2);

    const results = events.filter((e): e is CliTestResultEvent => e.type === 'testResult');
    const failing = results.find(r => r.status === 'failed')!;
    expect(failing.fullName).toBe('classify positive numbers (intentionally failing)');
    expect(failing.location).toEqual({ line: 31, column: 3 });
    expect(failing.failures[0]).toMatchObject({ matcherName: 'toBe', expected: 'positiv', actual: 'positive' });
    expect(failing.failures[0].frames[0]).toMatchObject({ file: path.join(dir, 'src/__tests__/math.test.js'), line: 32, column: 25 });
    expect(results.filter(r => r.fullName === 'greet duplicate name').map(r => r.dupIndex)).toEqual([0, 1]);
    expect(results.filter(r => r.fullName.startsWith('classify classify(')).map(r => r.location?.line)).toEqual([27, 27]);
    expect(results.find(r => r.title === 'todo test')?.status).toBe('todo');
    expect(results.find(r => r.title === 'skipped test')?.status).toBe('pending');

    const greet = events.find((e): e is CliFileResultEvent => e.type === 'fileResult' && e.path.endsWith('greet.test.js'))!;
    expect(greet.status).toBe('passed');
    expect(greet.snapshot.added).toBe(1);
    expect(greet.console?.map(c => [c.text, path.basename(c.file ?? ''), c.line, c.column])).toEqual([['greeting world', 'greet.js', 6, 11], ['greeting bob', 'greet.js', 6, 11], ['greeting snap', 'greet.js', 6, 11]]);

    const cov = events.find((e): e is CliFileCoverageEvent => e.type === 'fileCoverage' && e.path.endsWith('math.test.js'))!;
    const math = cov.files.find(f => f.path.endsWith('math.js'))!;
    expect(math.hasInputSourceMap).toBe(false);
    expect(math.stmtStartLine.length).toBeGreaterThan(5);
    expect(math.hitStmts).not.toContain(math.stmtStartLine.indexOf(19)); // neverCalled() body

    const done = events.find((e): e is CliRunCompleteEvent => e.type === 'runComplete')!;
    expect(done).toMatchObject({ success: false, wasInterrupted: false, numTotalTests: 14, numFailedTests: 1, numTodoTests: 1, numPendingTests: 1 });
    expect(fs.existsSync(path.join(dir, '.hj-cov/coverage-final.json'))).toBe(true);
  });

  it('serves the overlay manifest to Jest without touching the file on disk', async () => {
    const dir = copyFixture('overlay'); dirs.push(dir);
    const greetJs = path.join(dir, 'src/lib/greet.js');
    const original = fs.readFileSync(greetJs, 'utf8');
    const manifestPath = path.join(dir, 'overlay.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ version: 2, files: { [greetJs]: { text: original.replace('`hello ${name}`', '`hi ${name}`'), version: 5 } } }));
    const spec = buildRunSpec({
      project: { packageDir: dir, jestPkgDir: JEST_PKG, env: {}, nodeArgs: [] },
      workerAssetsDir: ASSETS, runId: 'e2e-overlay', nodePath: process.execPath, hostEnv: process.env, overlayManifestPath: manifestPath,
      tests: [{ path: path.join(dir, 'src/__tests__/greet.test.js'), names: ['greet greets once', 'greet duplicate name'] }],
    });
    expect(spec.args).toContain('--require');
    const { events } = await runSpec(spec);
    expect(events[0]).toMatchObject({ type: 'overlayApplied', version: 2, files: 1 });
    const results = events.filter((e): e is CliTestResultEvent => e.type === 'testResult');
    // jest-circus 29.7 reports tests skipped by -t only in the final TestResult, so their events trail the live ones.
    expect(results.map(r => [r.fullName, r.status]).sort()).toEqual([['greet duplicate name', 'passed'], ['greet duplicate name', 'passed'], ['greet greets once', 'failed'], ['greet greets twice', 'pending'], ['greet matches snapshot', 'pending']]);
    expect(results.find(r => r.fullName === 'greet greets once')!.failures[0]).toMatchObject({ expected: 'hello world', actual: 'hi world' });
    expect(fs.readFileSync(greetJs, 'utf8')).toBe(original);
  });
});
