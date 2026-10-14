import { createFsResolveFn } from '../../../src/core/jestResolver';
import { buildProjectSpecs, computeSpecId, discoverProjects, discoverProjectsAsync, expandShellVars, findNestedConfigs, implicitConfigCandidates, resolveImplicitConfig } from '../../../src/core/projectSpec';
import type { ProjectSpec } from '../../../src/core/protocol';
import { DEFAULT_SETTINGS, HyperJestSettings } from '../../../src/core/settingsModel';
import { createFakeExec, createMemFs, pkgJson, type MemFs } from './memFs';

const HOME = '/home/u';
const fnm = (v: string) => `${HOME}/.local/share/fnm/node-versions/v${v}/installation/bin/node`;
const MULTISHELL = `${HOME}/.local/state/fnm_multishells/1/bin`;

function withMachine(fs: MemFs): MemFs {
  for (const v of ['16.20.0', '22.17.0', '24.15.0', '24.19.0']) fs.write(fnm(v), '');
  return createMemFs(Object.fromEntries(fs.files), { symlinks: { [MULTISHELL]: `${HOME}/.local/share/fnm/node-versions/v24.19.0/installation/bin` } });
}

function run(fs: MemFs, packageJsonPaths: string[], settings: Partial<HyperJestSettings> = {}, extra: Record<string, unknown> = {}) {
  const machine = withMachine(fs);
  return discoverProjects({
    packageJsonPaths,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    homeDir: HOME,
    platform: 'darwin',
    env: { PATH: `${MULTISHELL}:/usr/bin` },
    fs: machine,
    resolve: createFsResolveFn(machine),
    exec: createFakeExec(),
    electronExecPath: '/Applications/Code.app/Electron',
    ...extra,
  });
}

const allPkgJsons = (fs: MemFs) => [...fs.files.keys()].filter(p => p.endsWith('/package.json') && !p.includes('/node_modules/'));
const by = (specs: ProjectSpec[], dir: string, pred: (s: ProjectSpec) => boolean = () => true) => specs.find(s => s.packageDir === dir && pred(s));

const workspaceFs = () =>
  createMemFs({
    '/w/workspace/package.json': pkgJson({ name: 'workspace', workspaces: ['packages/*', 'plugins/*'], scripts: { test: 'yarn workspaces foreach --all run test' } }),
    '/w/workspace/.nvmrc': '24.19.0',
    '/w/workspace/node_modules/jest/package.json': pkgJson({ name: 'jest', version: '29.7.0' }),
    '/w/workspace/node_modules/jest/bin/jest.js': '',
    '/w/workspace/packages/agent/package.json': pkgJson({ name: 'agent', scripts: { test: 'jest --testPathIgnorePatterns=tests/integration', 'test:integration': 'jest --config jest.integration.config.js', 'test:coverage': 'jest --coverage --testPathIgnorePatterns=tests/integration' }, devDependencies: { jest: '^29.7.0' } }),
    '/w/workspace/packages/agent/jest.config.js': 'module.exports = {}',
    '/w/workspace/packages/agent/jest.integration.config.js': 'module.exports = {}',
    '/w/workspace/packages/agent/tests/unit/a.test.ts': '',
    '/w/workspace/plugins/shots/package.json': pkgJson({ name: 'shots', scripts: { test: 'node --test' } }),
    '/w/workspace/packages/empty/package.json': pkgJson({ name: 'empty', scripts: { build: 'tsc' } }),
    '/w/workspace/packages/legacy/pkg/package.json': pkgJson({ name: 'legacy', scripts: { test: 'jest' } }),
    '/w/workspace/.claude/worktrees/wt1/package.json': pkgJson({ name: 'workspace', workspaces: ['packages/*'] }),
    '/w/workspace/.claude/worktrees/wt1/.nvmrc': '24.19.0',
    '/w/workspace/.claude/worktrees/wt1/node_modules/jest/package.json': pkgJson({ name: 'jest', version: '29.7.0' }),
    '/w/workspace/.claude/worktrees/wt1/node_modules/jest/bin/jest.js': '',
    '/w/workspace/.claude/worktrees/wt1/packages/agent/package.json': pkgJson({ name: 'agent', scripts: { test: 'jest' }, devDependencies: { jest: '^29.7.0' } }),
  });

describe('discoverProjects: workspace with multiple test scripts', () => {
  it('yields an implicit spec with CLI filters plus a script-config spec, skips worktrees and non-jest packages', () => {
    const fs = workspaceFs();
    const { specs, skipped } = run(fs, allPkgJsons(fs), {}, { workspaceFolders: ['/w/workspace'] });
    const agent = '/w/workspace/packages/agent';
    const impl = by(specs, agent, s => s.flavor === 'implicit')!;
    expect(impl).toMatchObject({
      displayName: 'agent', repoRoot: '/w/workspace', status: 'ok', jestPkgDir: '/w/workspace/node_modules/jest', jestVersion: '29.7.0',
      jestBinPath: '/w/workspace/node_modules/jest/bin/jest.js', nodePath: fnm('24.19.0'), nodeVersion: 'v24.19.0', nodeArgs: [], env: {},
      cliFilters: { testPathIgnorePatterns: ['tests/integration'] }, e2ePatterns: DEFAULT_SETTINGS.discovery.e2ePatterns, warnings: [],
    });
    expect(impl.configArg).toBeUndefined();
    expect(impl.id).toBe(computeSpecId(agent, undefined));
    const integ = by(specs, agent, s => s.flavor === 'script-config')!;
    expect(integ).toMatchObject({ displayName: 'agent · jest.integration.config.js', status: 'ok', configArg: `${agent}/jest.integration.config.js`, cliFilters: { testPathIgnorePatterns: [] } });
    expect(integ.id).not.toBe(impl.id);
    expect(by(specs, '/w/workspace/plugins/shots')).toMatchObject({ status: 'notJest', reason: expect.stringMatching(/node-test/) });
    expect(by(specs, '/w/workspace/packages/legacy/pkg')).toMatchObject({ status: 'ok', flavor: 'implicit' });
    expect(specs.filter(s => s.packageDir.includes('/.claude/worktrees/'))).toEqual([]);
    expect(skipped.map(s => `${s.reason}:${s.packageDir}`).sort()).toEqual([
      'noTests:/w/workspace', 'noTests:/w/workspace/packages/empty', 'worktree:/w/workspace/.claude/worktrees/wt1', 'worktree:/w/workspace/.claude/worktrees/wt1/packages/agent',
    ]);
    expect(buildProjectSpecs({ packageJsonPaths: allPkgJsons(fs), settings: DEFAULT_SETTINGS, homeDir: HOME, platform: 'darwin', fs: withMachine(fs), resolve: createFsResolveFn(withMachine(fs)), exec: createFakeExec(), env: { PATH: `${MULTISHELL}` } })).toHaveLength(specs.length);
  });

  it('keeps a worktree package when a workspace folder is opened inside the worktree, and applies exclude globs', () => {
    const fs = workspaceFs();
    const wt = '/w/workspace/.claude/worktrees/wt1';
    const r = run(fs, allPkgJsons(fs), { discovery: { ...DEFAULT_SETTINGS.discovery, exclude: ['**/legacy/**'] } }, { workspaceFolders: [wt] });
    expect(by(r.specs, `${wt}/packages/agent`)).toMatchObject({ status: 'ok', repoRoot: wt, nodeVersion: 'v24.19.0' });
    expect(r.skipped.find(s => s.packageDir === '/w/workspace/packages/legacy/pkg')?.reason).toBe('excluded');
  });

  it('is deterministic', () => {
    const fs = workspaceFs();
    const a = run(fs, allPkgJsons(fs));
    const b = run(fs, [...allPkgJsons(fs)].reverse());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

const multiVersionFs = () => {
  const fs = createMemFs({
    '/eng/package.json': pkgJson({ workspaces: ['packages/*'] }),
    '/eng/.nvmrc': '24.15.0',
    '/eng/node_modules/jest/package.json': pkgJson({ name: 'jest', version: '30.4.2' }),
    '/eng/node_modules/jest/bin/jest.js': '',
  });
  const add = (p: string, c: string) => fs.write(p, c);
  add('/eng/packages/engine/package.json', pkgJson({ name: '@example/engine', scripts: { test: ':', 'test:js': 'jest -c jest.unit.config.js && jest -c jest.integration.config.js ./integration', 'test:e2e:ios': 'node scripts/e2e.js' }, devDependencies: { jest: '^30.4.2' } }));
  add('/eng/packages/engine/jest.config.js', '// Runs both unit and integration tests. Used when running simply "jest", for example by wallaby');
  add('/eng/packages/engine/jest.unit.config.js', 'module.exports = {...require("./jest.config")}');
  add('/eng/packages/engine/jest.integration.config.js', 'module.exports = {...require("./jest.config")}');
  add('/eng/packages/engine/e2e/jest.config.js', "const baseConfig = require('@example/browser-preset/jest.config');\nmodule.exports = {...baseConfig};");
  add('/eng/packages/engine/src/a.test.js', '');
  add('/eng/packages/engine/node_modules/jest-circus/package.json', pkgJson({ name: 'jest-circus', version: '30.4.2' }));
  add('/eng/packages/storage/package.json', pkgJson({ name: '@example/storage', scripts: { test: 'jest' }, devDependencies: { jest: '^30' } }));
  add('/eng/packages/storage/jest.config.json', '{"roots":["src"]}');
  add('/eng/packages/ci/package.json', pkgJson({ name: '@example/ci', scripts: { test: 'jest --runInBand' }, devDependencies: { jest: '^30' } }));
  add('/eng/packages/ci/jest.config.ts', 'export default {}');
  add('/eng/packages/sl/package.json', pkgJson({ name: '@example/sl', scripts: { test: 'jest --runInBand --forceExit' }, devDependencies: { jest: '^29.7.0' } }));
  add('/eng/packages/sl/jest.config.js', "module.exports = require('@example/serverless-jest-config')");
  add('/eng/packages/sl/node_modules/jest/package.json', pkgJson({ name: 'jest', version: '29.7.0' }));
  add('/eng/packages/sl/node_modules/jest/bin/jest.js', '');
  add('/eng/packages/gen/package.json', pkgJson({ name: '@example/gen', jest: {}, scripts: { test: 'node tests/a.test.js && node tests/b.test.js' }, devDependencies: { jest: '*' } }));
  add('/eng/packages/multi/package.json', pkgJson({ name: '@example/multi', jest: { testMatch: ['x'] }, scripts: { test: 'jest --passWithNoTests' }, devDependencies: { jest: '^30' } }));
  add('/eng/packages/multi/jest.config.js', '');
  add('/eng/packages/e2eonly/package.json', pkgJson({ name: '@example/e2eonly', scripts: { 'test:e2e': 'jest -c e2e/jest.config.js' }, devDependencies: { jest: '^30' } }));
  add('/eng/packages/e2eonly/e2e/jest.config.js', '');
  add('/eng/packages/sub/package.json', pkgJson({ name: '@example/sub', scripts: { test: 'jest' }, devDependencies: { jest: '^30' } }));
  add('/eng/packages/sub/tools/jest.config.js', '');
  add('/eng/packages/sub/example/package.json', pkgJson({ name: 'example', scripts: { test: 'jest' }, devDependencies: { jest: '^30' } }));
  add('/eng/packages/sub/example/jest.config.js', '');
  return fs;
};

describe('discoverProjects: workspace with multiple Jest versions', () => {
  const fs = multiVersionFs();
  const { specs, skipped } = run(fs, allPkgJsons(fs));
  const eng = '/eng/packages/engine';

  it('creates one spec per script config, flags the nested e2e config and ignores the default jest.config.js', () => {
    const mine = specs.filter(s => s.packageDir === eng);
    expect(mine.map(s => `${s.flavor}/${s.status}/${s.configArg?.replace(eng + '/', '')}`).sort()).toEqual([
      'implicit/notJest/e2e/jest.config.js', 'implicit/ok/jest.config.js', 'script-config/ok/jest.integration.config.js', 'script-config/ok/jest.unit.config.js',
    ]);
    const unit = by(specs, eng, s => s.configArg?.endsWith('jest.unit.config.js') ?? false)!;
    expect(unit).toMatchObject({ displayName: '@example/engine · jest.unit.config.js', jestVersion: '30.4.2', jestPkgDir: '/eng/node_modules/jest', nodeVersion: 'v24.15.0', cliFilters: { testPathIgnorePatterns: [] } });
    expect(unit.warnings).toEqual([expect.stringMatching(/Implicit Jest config jest\.config\.js is not used by any test script/)]);
    const integ = by(specs, eng, s => s.configArg?.endsWith('jest.integration.config.js') ?? false)!;
    expect(integ.cliFilters).toEqual({ testPathIgnorePatterns: [], testPathPatterns: ['./integration'] });
    const e2e = by(specs, eng, s => s.status === 'notJest')!;
    expect(e2e).toMatchObject({ displayName: '@example/engine · e2e', reason: expect.stringMatching(/e2e config/) });
    expect(e2e.jestVersion).toBeUndefined();
  });

  it('handles json/ts implicit configs, nested jest copies, vestigial jest keys and multiple configs', () => {
    expect(by(specs, '/eng/packages/storage')).toMatchObject({ flavor: 'implicit', status: 'ok', jestVersion: '30.4.2' });
    expect(by(specs, '/eng/packages/storage')!.configArg).toBeUndefined();
    expect(by(specs, '/eng/packages/ci')).toMatchObject({ flavor: 'implicit', status: 'ok' });
    expect(by(specs, '/eng/packages/ci')!.configArg).toBeUndefined();
    expect(by(specs, '/eng/packages/sl')).toMatchObject({ status: 'ok', jestVersion: '29.7.0', jestPkgDir: '/eng/packages/sl/node_modules/jest' });
    expect(by(specs, '/eng/packages/gen')).toMatchObject({ status: 'notJest', reason: expect.stringMatching(/node-test.*unused Jest config: package\.json/) });
    const multi = by(specs, '/eng/packages/multi')!;
    expect(multi).toMatchObject({ flavor: 'implicit', status: 'ok', configArg: '/eng/packages/multi/jest.config.js' });
    expect(multi.warnings).toEqual([expect.stringMatching(/multipleConfigs: jest\.config\.js, package\.json/)]);
    expect(by(specs, '/eng/packages/e2eonly')).toMatchObject({ flavor: 'script-config', status: 'notJest', configArg: '/eng/packages/e2eonly/e2e/jest.config.js' });
    expect(specs.filter(s => s.packageDir === '/eng/packages/sub').map(s => s.configArg)).toEqual([undefined, '/eng/packages/sub/tools/jest.config.js']);
    expect(by(specs, '/eng/packages/sub/example')).toMatchObject({ status: 'ok', repoRoot: '/eng/packages/sub/example' }); // not a workspace member -> standalone
    expect(skipped.map(s => s.reason)).toEqual(['noTests']);
  });

  it('exposes Jest implicit resolution helpers', () => {
    expect(implicitConfigCandidates(eng, fs, 30).candidates).toEqual([`${eng}/jest.config.js`]);
    expect(resolveImplicitConfig(`${eng}/e2e`, eng, fs, 30)).toEqual({ dir: `${eng}/e2e`, candidates: [`${eng}/e2e/jest.config.js`] });
    expect(resolveImplicitConfig(`${eng}/src`, eng, fs, 30)).toEqual({ dir: eng, candidates: [`${eng}/jest.config.js`] });
    expect(resolveImplicitConfig('/eng/packages/sub/src', '/eng/packages/sub', fs, 30)).toEqual({ dir: '/eng/packages/sub', candidates: [] });
    expect(findNestedConfigs('/eng/packages/sub', 3, fs, 30)).toEqual(['/eng/packages/sub/tools/jest.config.js']);
    expect(implicitConfigCandidates('/eng/packages/multi', fs, 29).candidates).toEqual(['/eng/packages/multi/jest.config.js', '/eng/packages/multi/package.json']);
  });
});

describe('discoverProjects: custom wrappers', () => {
  const fixture = () => createMemFs({
    '/repo/package.json': pkgJson({ scripts: { test: 'custom-test-tool unit' }, devDependencies: { '@example/test-tools': '1.0.0' } }),
    '/repo/node_modules/@example/test-tools/node_modules/jest/package.json': pkgJson({ name: 'jest', version: '29.7.0' }),
    '/repo/node_modules/@example/test-tools/node_modules/jest/bin/jest.js': '',
  });

  it('does not infer Jest or wrapper setup from an unknown command', () => {
    const result = run(fixture(), ['/repo/package.json']);
    expect(result.specs).toEqual([]);
    expect(result.skipped).toEqual([expect.objectContaining({ reason: 'noTests' })]);
  });

  it('requires package-resolvable Jest even with an explicit config', () => {
    const fs = fixture();
    fs.write('/repo/custom.config.js', 'module.exports = {}');
    const result = run(fs, ['/repo/package.json'], { projects: [{ packageDir: '/repo', configArg: 'custom.config.js' }] });
    expect(result.specs.find(s => s.selected)).toMatchObject({ flavor: 'override', status: 'unavailable' });
  });

  it('uses explicit native configuration without injecting wrapper defaults', () => {
    const fs = fixture();
    fs.write('/repo/node_modules/jest/package.json', pkgJson({ name: 'jest', version: '30.4.2' }));
    fs.write('/repo/node_modules/jest/bin/jest.js', '');
    fs.write('/repo/hyperjest.config.js', '');
    fs.write('/repo/custom.config.js', 'module.exports = {}');
    const config = { jestConfig: './custom.config.js', env: { TEST_MODE: 'unit', NODE_PATH: '/custom/modules' }, nodeArgs: ['--max-old-space-size=2048'], tests: ['tests/unit/**/*.test.js'] };
    const result = run(fs, ['/repo/package.json'], {}, { hyperConfigs: { '/repo/hyperjest.config.js': { config } } });
    expect(result.specs.find(s => s.selected)).toMatchObject({
      flavor: 'hyperjest', status: 'ok', configArg: '/repo/custom.config.js',
      jestPkgDir: '/repo/node_modules/jest', jestVersion: '30.4.2', env: config.env, nodeArgs: config.nodeArgs,
      scope: { baseDir: '/repo', tests: config.tests },
    });
  });

  it('honors generic Jest evidence despite an unknown wrapper command', () => {
    const fs = fixture();
    fs.write('/repo/jest.config.js', 'module.exports = {}');
    fs.write('/repo/node_modules/jest/package.json', pkgJson({ name: 'jest', version: '29.7.0' }));
    fs.write('/repo/node_modules/jest/bin/jest.js', '');
    expect(run(fs, ['/repo/package.json']).specs.find(s => s.selected)).toMatchObject({ flavor: 'implicit', status: 'ok', env: {}, nodeArgs: [] });
  });
});

describe('discoverProjects: configurable E2E exclusions', () => {
  const fixture = () => createMemFs({
    '/repo/package.json': pkgJson({ scripts: { test: 'jest -c config/browser.config.js' } }),
    '/repo/node_modules/jest/package.json': pkgJson({ name: 'jest', version: '29.7.0' }),
    '/repo/node_modules/jest/bin/jest.js': '',
    '/repo/config/browser.config.js': "module.exports = { preset: '@example/browser-preset', testEnvironment: '@example/device-environment' };",
  });

  it('does not classify configs by their preset or environment contents', () => {
    expect(run(fixture(), ['/repo/package.json']).specs[0]).toMatchObject({ status: 'ok', flavor: 'script-config' });
  });

  it('lets users exclude additional paths or clear the default exclusions', () => {
    const fs = fixture();
    expect(run(fs, ['/repo/package.json'], { discovery: { ...DEFAULT_SETTINGS.discovery, e2ePatterns: ['**/config/**'] } }).specs[0]).toMatchObject({ status: 'notJest' });
    fs.write('/repo/package.json', pkgJson({ scripts: { test: 'jest -c e2e/jest.config.js' } }));
    fs.write('/repo/e2e/jest.config.js', 'module.exports = {}');
    expect(run(fs, ['/repo/package.json']).specs.find(s => s.configArg === '/repo/e2e/jest.config.js')).toMatchObject({ status: 'notJest' });
    expect(run(fs, ['/repo/package.json'], { discovery: { ...DEFAULT_SETTINGS.discovery, e2ePatterns: [] } }).specs.find(s => s.configArg === '/repo/e2e/jest.config.js')).toMatchObject({ status: 'ok' });
  });
});

describe('discoverProjects: degraded and overridden packages', () => {
  const uninstalledFs = () =>
    createMemFs({
      '/w/uninstalled/package.json': pkgJson({ workspaces: { packages: ['packages/server/*'] } }),
      '/w/uninstalled/.nvmrc': '20.19.4',
      '/w/uninstalled/packages/server/jest.config.js': 'module.exports = { preset: "ts-jest" }',
      '/w/uninstalled/packages/server/srv/package.json': pkgJson({ name: 'srv', scripts: { test: 'jest' }, devDependencies: { jest: '29.5.0' } }),
      '/w/uninstalled/packages/server/srv/jest.config.js': "module.exports = require('../jest.config')",
      '/w/uninstalled/serverless/rpc/package.json': pkgJson({ name: 'rpc', scripts: { test: 'jest' }, devDependencies: { jest: '^27.4.7' } }),
      '/w/uninstalled/serverless/rpc/jest.config.js': '',
      '/w/uninstalled/serverless/rpc/package-lock.json': '{}',
      '/w/browser/package.json': pkgJson({ workspaces: ['packages/*'] }),
      '/w/browser/packages/appium/package.json': pkgJson({ name: 'browser-tests', scripts: { test: ':' }, devDependencies: { jest: '^29.7.0', 'ts-jest': '^29', webdriverio: '^9', appium: '^2' } }),
      '/w/browser/node_modules/jest/package.json': pkgJson({ name: 'jest', version: '29.7.0' }),
    });

  it('reports unavailable / unsupported / notJest with actionable reasons and node fallback warnings', () => {
    const fs = uninstalledFs();
    const { specs } = run(fs, allPkgJsons(fs));
    const srv = by(specs, '/w/uninstalled/packages/server/srv')!;
    expect(srv).toMatchObject({ status: 'unavailable', reason: 'node_modules is not installed under /w/uninstalled — run `yarn install` there', nodeVersion: 'v24.19.0' });
    expect(srv.jestVersion).toBeUndefined();
    expect(srv.warnings).toEqual([expect.stringMatching(/Node 20\.19\.4 requested by \/w\/uninstalled\/\.nvmrc is not installed/)]);
    expect(by(specs, '/w/uninstalled/serverless/rpc')).toMatchObject({ status: 'unsupported', repoRoot: '/w/uninstalled/serverless/rpc', reason: expect.stringMatching(/declares jest \^27\.4\.7 \(< 28\)/) });
    expect(by(specs, '/w/browser/packages/appium')).toMatchObject({ status: 'notJest', reason: expect.stringMatching(/jest is only a dependency; test tooling is webdriverio, appium/) });
    expect(specs.find(s => s.packageDir === '/w/uninstalled')).toBeUndefined();
  });

  it('applies hyperjest.projects overrides and env/nodeArgs merge order', () => {
    const fs = workspaceFs();
    const agent = '/w/workspace/packages/agent';
    const disabled = run(fs, [`${agent}/package.json`], { projects: [{ packageDir: agent, disabled: true }] }).specs;
    expect(disabled).toEqual([expect.objectContaining({ flavor: 'override', status: 'disabled', reason: 'disabled by hyperjest.projects', displayName: 'agent' })]);
    fs.write(`${agent}/custom.config.js`, '');
    const over = run(fs, [`${agent}/package.json`], {
      projects: [{ packageDir: 'packages/agent', configArg: 'custom.config.js', env: { A: '1' }, nodePath: fnm('22.17.0') }],
      env: { A: '0', B: '2' },
      nodeArgs: ['--no-warnings'],
    }, { workspaceFolders: ['/w/workspace'] }).specs;
    expect(over.filter(s => s.selected)).toHaveLength(1);
    expect(over.find(s => s.selected)).toMatchObject({ flavor: 'override', status: 'ok', configArg: `${agent}/custom.config.js`, displayName: 'agent · custom.config.js', env: { A: '1', B: '2' }, nodeArgs: ['--no-warnings'], nodePath: fnm('22.17.0'), nodeVersion: 'v22.17.0' });
  });

  it('turns script env prefixes into env / nodeArgs with shell expansion', () => {
    const fs = createMemFs({
      '/r/package.json': pkgJson({ workspaces: ['p/*'] }),
      '/r/node_modules/jest/package.json': pkgJson({ name: 'jest', version: '30.5.2' }),
      '/r/node_modules/jest/bin/jest.js': '',
      '/r/p/a/package.json': pkgJson({ name: 'a', scripts: { test: 'cross-env NODE_ENV=test NODE_OPTIONS="--max_old_space_size=8192 --no-warnings" X=${HOME_X:-dflt} jest -c cfg.js' }, devDependencies: { jest: '^30' } }),
      '/r/p/a/cfg.js': '',
    });
    const { specs } = run(fs, ['/r/p/a/package.json']);
    expect(specs[0]).toMatchObject({ flavor: 'script-config', env: { NODE_ENV: 'test', X: 'dflt' }, nodeArgs: ['--max_old_space_size=8192', '--no-warnings'] });
    expect(expandShellVars('${A:-x}:$B:${C}', { B: 'b' })).toBe('x:b:');
    // Implicit flavour expands against the host env too (same rule as script-config).
    fs.write('/r/p/b/package.json', pkgJson({ name: 'b', scripts: { test: 'CACHE=$HOME_X/cache jest' }, devDependencies: { jest: '^30' } }));
    const implicit = run(fs, ['/r/p/b/package.json'], {}, { env: { HOME_X: '/home/u', PATH: `${MULTISHELL}:/usr/bin` } }).specs;
    expect(implicit[0]).toMatchObject({ flavor: 'implicit', env: { CACHE: '/home/u/cache' } });
  });
});

describe('discoverProjectsAsync', () => {
  it('validates node binaries asynchronously (never through the sync exec) and matches the sync result', async () => {
    const fs = workspaceFs();
    const paths = allPkgJsons(fs);
    const machine = withMachine(fs);
    const base = {
      packageJsonPaths: paths, settings: DEFAULT_SETTINGS, homeDir: HOME, platform: 'darwin' as const, env: { PATH: `${MULTISHELL}:/usr/bin` },
      fs: machine, resolve: createFsResolveFn(machine), electronExecPath: '/Applications/Code.app/Electron', workspaceFolders: ['/w/workspace'],
    };
    const expected = discoverProjects({ ...base, exec: createFakeExec(), nodeVersionCache: new Map() });
    const syncExec = createFakeExec();
    const asyncFake = createFakeExec();
    const execAsync = jest.fn(async (file: string, args: string[], env?: Record<string, string>) => asyncFake(file, args, env));
    const cache = new Map<string, string | null>();
    const result = await discoverProjectsAsync({ ...base, exec: syncExec, execAsync, nodeVersionCache: cache });
    expect(syncExec.calls).toHaveLength(0);
    expect(execAsync).toHaveBeenCalled();
    expect(cache.get(fnm('24.19.0'))).toBe('v24.19.0');
    expect(result).toEqual(expected);
    // A warm cache needs no spawn at all.
    execAsync.mockClear();
    await discoverProjectsAsync({ ...base, exec: syncExec, execAsync, nodeVersionCache: cache });
    expect(execAsync).not.toHaveBeenCalled();
    expect(syncExec.calls).toHaveLength(0);
  });
});


describe('HyperJest configuration selection', () => {
  const agent = '/w/workspace/packages/agent';
  const file = `${agent}/hyperjest.config.js`;
  const native = { config: { jestConfig: './jest.config.js', tests: ['tests/unit/**/*.test.ts'] } };
  it('selects the main script by default and keeps integration available but inactive', () => {
    const specs = run(workspaceFs(), [`${agent}/package.json`]).specs;
    expect(specs.filter(s => s.selected).map(s => s.configKey)).toEqual(['jest.config.js']);
    expect(specs.find(s => s.configKey === 'jest.integration.config.js')?.selected).toBe(false);
  });
  it('breaks script priority ties by command order, including implicit configs', () => {
    for (const first of [true, false]) {
      const fs = workspaceFs();
      fs.write(`${agent}/package.json`, pkgJson({ name: 'agent', scripts: { test: first ? 'jest && jest -c jest.integration.config.js' : 'jest -c jest.integration.config.js && jest' } }));
      const selected = run(fs, [`${agent}/package.json`]).specs.filter(s => s.selected);
      expect(selected.map(s => s.configKey)).toEqual([first ? 'jest.config.js' : 'jest.integration.config.js']);
    }
  });
  it('keeps a missing primary script config unavailable instead of selecting another config', () => {
    const fs = workspaceFs();
    fs.write(`${agent}/package.json`, pkgJson({ name: 'agent', scripts: { test: 'jest -c missing.js', 'test:integration': 'jest -c jest.integration.config.js' } }));
    expect(run(fs, [`${agent}/package.json`]).specs.filter(s => s.selected)).toEqual([expect.objectContaining({ configKey: 'missing.js', status: 'unavailable' })]);
  });
  it('lists a config only once when scripts reference it both implicitly and explicitly', () => {
    const fs = workspaceFs();
    fs.write(`${agent}/package.json`, pkgJson({ name: 'agent', scripts: { test: 'FIRST=yes jest && SECOND=yes jest -c jest.config.js' } }));
    const specs = run(fs, [`${agent}/package.json`], { projects: [{ packageDir: agent, configFiles: ['jest.config.js'] }] }).specs;
    expect(specs.filter(s => s.configKey === 'jest.config.js')).toHaveLength(1);
    expect(specs.find(s => s.selected)?.env).toMatchObject({ FIRST: 'yes' });
  });
  it('selects the native default and keeps its identity separate from the underlying Jest config', () => {
    const fs = workspaceFs(); fs.write(file, 'module.exports = {}');
    const specs = run(fs, [`${agent}/package.json`], {}, { hyperConfigs: { [file]: native } }).specs;
    const selected = specs.filter(s => s.selected);
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ configFile: file, configArg: `${agent}/jest.config.js`, scope: { baseDir: agent, tests: native.config.tests } });
    expect(selected[0].id).toBe(computeSpecId(agent, file));
  });
  it('honors explicit multiple/empty selections, disabled packages and legacy pins', () => {
    const fs = workspaceFs(); fs.write(file, 'module.exports = {}');
    for (const configFiles of [['hyperjest.config.js', 'jest.integration.config.js'], []]) {
      const specs = run(fs, [`${agent}/package.json`], { projects: [{ packageDir: agent, configFiles, configArg: 'jest.config.js' }] }, { hyperConfigs: { [file]: native } }).specs;
      expect(specs.filter(s => s.selected).map(s => s.configKey).sort()).toEqual([...configFiles].sort());
    }
    expect(run(fs, [`${agent}/package.json`], { projects: [{ packageDir: agent, disabled: true, configFiles: ['hyperjest.config.js'] }] }).specs.every(s => s.status === 'disabled')).toBe(true);
    expect(run(fs, [`${agent}/package.json`], { projects: [{ packageDir: agent, configArg: 'jest.integration.config.js' }] }).specs.filter(s => s.selected).map(s => s.configKey)).toEqual(['jest.integration.config.js']);
  });
  it('does not fall back from a malformed default or a missing selected config', () => {
    const fs = workspaceFs(); fs.write(file, 'broken');
    const invalid = run(fs, [`${agent}/package.json`], {}, { hyperConfigs: { [file]: { error: 'Invalid scope' } } }).specs.filter(s => s.selected);
    expect(invalid).toHaveLength(1); expect(invalid[0]).toMatchObject({ status: 'unavailable', reason: 'Invalid scope' });
    const missing = run(fs, [`${agent}/package.json`], { projects: [{ packageDir: agent, configFiles: ['missing.js'] }] }).specs.filter(s => s.selected);
    expect(missing).toHaveLength(1); expect(missing[0]).toMatchObject({ status: 'unavailable', configKey: 'missing.js' });
  });
});
