import { createFsResolveFn } from '../../../src/core/jestResolver';
import { buildProjectSpecs, computeSpecId, discoverProjects, discoverProjectsAsync, expandShellVars, findNestedConfigs, implicitConfigCandidates, resolveImplicitConfig } from '../../../src/core/projectSpec';
import type { ProjectSpec } from '../../../src/core/protocol';
import { DEFAULT_SETTINGS, HyperJestSettings } from '../../../src/core/settingsModel';
import { createFakeExec, createMemFs, pkgJson, type MemFs } from './memFs';
import { engineFs, mobileModulesFs } from './shono.test';

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

const relopsFs = () =>
  createMemFs({
    '/w/relops/package.json': pkgJson({ name: 'relops', workspaces: ['packages/*', 'plugins/*'], scripts: { test: 'yarn workspaces foreach --all run test' } }),
    '/w/relops/.nvmrc': '24.19.0',
    '/w/relops/node_modules/jest/package.json': pkgJson({ name: 'jest', version: '29.7.0' }),
    '/w/relops/node_modules/jest/bin/jest.js': '',
    '/w/relops/packages/agent/package.json': pkgJson({ name: 'agent', scripts: { test: 'jest --testPathIgnorePatterns=tests/integration', 'test:integration': 'jest --config jest.integration.config.js', 'test:coverage': 'jest --coverage --testPathIgnorePatterns=tests/integration' }, devDependencies: { jest: '^29.7.0' } }),
    '/w/relops/packages/agent/jest.config.js': 'module.exports = {}',
    '/w/relops/packages/agent/jest.integration.config.js': 'module.exports = {}',
    '/w/relops/packages/agent/tests/unit/a.test.ts': '',
    '/w/relops/plugins/shots/package.json': pkgJson({ name: 'shots', scripts: { test: 'node --test' } }),
    '/w/relops/packages/empty/package.json': pkgJson({ name: 'empty', scripts: { build: 'tsc' } }),
    '/w/relops/packages/legacy/pkg/package.json': pkgJson({ name: 'legacy', scripts: { test: 'jest' } }),
    '/w/relops/.claude/worktrees/wt1/package.json': pkgJson({ name: 'relops', workspaces: ['packages/*'] }),
    '/w/relops/.claude/worktrees/wt1/.nvmrc': '24.19.0',
    '/w/relops/.claude/worktrees/wt1/node_modules/jest/package.json': pkgJson({ name: 'jest', version: '29.7.0' }),
    '/w/relops/.claude/worktrees/wt1/node_modules/jest/bin/jest.js': '',
    '/w/relops/.claude/worktrees/wt1/packages/agent/package.json': pkgJson({ name: 'agent', scripts: { test: 'jest' }, devDependencies: { jest: '^29.7.0' } }),
  });

describe('discoverProjects: relops-like repo', () => {
  it('yields an implicit spec with CLI filters plus a script-config spec, skips worktrees and non-jest packages', () => {
    const fs = relopsFs();
    const { specs, skipped } = run(fs, allPkgJsons(fs), {}, { workspaceFolders: ['/w/relops'] });
    const agent = '/w/relops/packages/agent';
    const impl = by(specs, agent, s => s.flavor === 'implicit')!;
    expect(impl).toMatchObject({
      displayName: 'agent', repoRoot: '/w/relops', status: 'ok', jestPkgDir: '/w/relops/node_modules/jest', jestVersion: '29.7.0',
      jestBinPath: '/w/relops/node_modules/jest/bin/jest.js', nodePath: fnm('24.19.0'), nodeVersion: 'v24.19.0', nodeArgs: [], env: {},
      cliFilters: { testPathIgnorePatterns: ['tests/integration'] }, e2ePatterns: DEFAULT_SETTINGS.discovery.e2ePatterns, warnings: [],
    });
    expect(impl.configArg).toBeUndefined();
    expect(impl.id).toBe(computeSpecId(agent, undefined));
    const integ = by(specs, agent, s => s.flavor === 'script-config')!;
    expect(integ).toMatchObject({ displayName: 'agent · jest.integration.config.js', status: 'ok', configArg: `${agent}/jest.integration.config.js`, cliFilters: { testPathIgnorePatterns: [] } });
    expect(integ.id).not.toBe(impl.id);
    expect(by(specs, '/w/relops/plugins/shots')).toMatchObject({ status: 'notJest', reason: expect.stringMatching(/node-test/) });
    expect(by(specs, '/w/relops/packages/legacy/pkg')).toMatchObject({ status: 'ok', flavor: 'implicit' });
    expect(specs.filter(s => s.packageDir.includes('/.claude/worktrees/'))).toEqual([]);
    expect(skipped.map(s => `${s.reason}:${s.packageDir}`).sort()).toEqual([
      'noTests:/w/relops', 'noTests:/w/relops/packages/empty', 'worktree:/w/relops/.claude/worktrees/wt1', 'worktree:/w/relops/.claude/worktrees/wt1/packages/agent',
    ]);
    expect(buildProjectSpecs({ packageJsonPaths: allPkgJsons(fs), settings: DEFAULT_SETTINGS, homeDir: HOME, platform: 'darwin', fs: withMachine(fs), resolve: createFsResolveFn(withMachine(fs)), exec: createFakeExec(), env: { PATH: `${MULTISHELL}` } })).toHaveLength(specs.length);
  });

  it('keeps a worktree package when a workspace folder is opened inside the worktree, and applies exclude globs', () => {
    const fs = relopsFs();
    const wt = '/w/relops/.claude/worktrees/wt1';
    const r = run(fs, allPkgJsons(fs), { discovery: { ...DEFAULT_SETTINGS.discovery, exclude: ['**/legacy/**'] } }, { workspaceFolders: [wt] });
    expect(by(r.specs, `${wt}/packages/agent`)).toMatchObject({ status: 'ok', repoRoot: wt, nodeVersion: 'v24.19.0' });
    expect(r.skipped.find(s => s.packageDir === '/w/relops/packages/legacy/pkg')?.reason).toBe('excluded');
  });

  it('is deterministic', () => {
    const fs = relopsFs();
    const a = run(fs, allPkgJsons(fs));
    const b = run(fs, [...allPkgJsons(fs)].reverse());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

const engineLikeFs = () => {
  const fs = engineFs();
  const add = (p: string, c: string) => fs.write(p, c);
  add('/eng/packages/engine/package.json', pkgJson({ name: '@wix/engine', scripts: { test: ':', 'test:js': 'jest -c jest.unit.config.js && jest -c jest.integration.config.js ./integration', 'test:e2e:ios': 'node scripts/e2e.js' }, devDependencies: { jest: '^30.4.2' } }));
  add('/eng/packages/engine/jest.config.js', '// Runs both unit and integration tests. Used when running simply "jest", for example by wallaby');
  add('/eng/packages/engine/jest.unit.config.js', 'module.exports = {...require("./jest.config")}');
  add('/eng/packages/engine/jest.integration.config.js', 'module.exports = {...require("./jest.config")}');
  add('/eng/packages/engine/e2e/jest.config.js', "const baseConfig = require('@wix/detox-wix-preset/dev/jest.config');\nmodule.exports = {...baseConfig};");
  add('/eng/packages/engine/src/a.test.js', '');
  add('/eng/packages/engine/node_modules/jest-circus/package.json', pkgJson({ name: 'jest-circus', version: '30.4.2' }));
  add('/eng/packages/storage/package.json', pkgJson({ name: '@wix/storage', scripts: { test: 'jest' }, devDependencies: { jest: '^30' } }));
  add('/eng/packages/storage/jest.config.json', '{"roots":["src"]}');
  add('/eng/packages/ci/package.json', pkgJson({ name: '@wix/ci', scripts: { test: 'jest --runInBand' }, devDependencies: { jest: '^30' } }));
  add('/eng/packages/ci/jest.config.ts', 'export default {}');
  add('/eng/packages/sl/package.json', pkgJson({ name: '@wix/sl', scripts: { test: 'jest --runInBand --forceExit' }, devDependencies: { jest: '^29.7.0' } }));
  add('/eng/packages/sl/jest.config.js', "module.exports = require('@wix/serverless-jest-config')");
  add('/eng/packages/sl/node_modules/jest/package.json', pkgJson({ name: 'jest', version: '29.7.0' }));
  add('/eng/packages/sl/node_modules/jest/bin/jest.js', '');
  add('/eng/packages/gen/package.json', pkgJson({ name: '@wix/gen', jest: {}, scripts: { test: 'node tests/a.test.js && node tests/b.test.js' }, devDependencies: { jest: '*' } }));
  add('/eng/packages/multi/package.json', pkgJson({ name: '@wix/multi', jest: { testMatch: ['x'] }, scripts: { test: 'jest --passWithNoTests' }, devDependencies: { jest: '^30' } }));
  add('/eng/packages/multi/jest.config.js', '');
  add('/eng/packages/e2eonly/package.json', pkgJson({ name: '@wix/e2eonly', scripts: { 'test:e2e': 'jest -c detox/jest.config.js' }, devDependencies: { jest: '^30' } }));
  add('/eng/packages/e2eonly/detox/jest.config.js', '');
  add('/eng/packages/sub/package.json', pkgJson({ name: '@wix/sub', scripts: { test: 'jest' }, devDependencies: { jest: '^30' } }));
  add('/eng/packages/sub/tools/jest.config.js', '');
  add('/eng/packages/sub/example/package.json', pkgJson({ name: 'example', scripts: { test: 'jest' }, devDependencies: { jest: '^30' } }));
  add('/eng/packages/sub/example/jest.config.js', '');
  return fs;
};

describe('discoverProjects: engine-like repo', () => {
  const fs = engineLikeFs();
  const { specs, skipped } = run(fs, allPkgJsons(fs));
  const eng = '/eng/packages/engine';

  it('creates one spec per script config, flags the nested detox config and ignores the default jest.config.js', () => {
    const mine = specs.filter(s => s.packageDir === eng);
    expect(mine.map(s => `${s.flavor}/${s.status}/${s.configArg?.replace(eng + '/', '')}`).sort()).toEqual([
      'implicit/notJest/e2e/jest.config.js', 'script-config/ok/jest.integration.config.js', 'script-config/ok/jest.unit.config.js',
    ]);
    const unit = by(specs, eng, s => s.configArg?.endsWith('jest.unit.config.js') ?? false)!;
    expect(unit).toMatchObject({ displayName: '@wix/engine · jest.unit.config.js', jestVersion: '30.4.2', jestPkgDir: '/eng/node_modules/jest', nodeVersion: 'v24.15.0', cliFilters: { testPathIgnorePatterns: [] } });
    expect(unit.warnings).toEqual([expect.stringMatching(/Implicit Jest config jest\.config\.js is not used by any test script/)]);
    const integ = by(specs, eng, s => s.configArg?.endsWith('jest.integration.config.js') ?? false)!;
    expect(integ.cliFilters).toEqual({ testPathIgnorePatterns: [], testPathPatterns: ['./integration'] });
    const e2e = by(specs, eng, s => s.status === 'notJest')!;
    expect(e2e).toMatchObject({ displayName: '@wix/engine · e2e', reason: expect.stringMatching(/e2e config/) });
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
    expect(by(specs, '/eng/packages/e2eonly')).toMatchObject({ flavor: 'script-config', status: 'notJest', configArg: '/eng/packages/e2eonly/detox/jest.config.js' });
    expect(specs.filter(s => s.packageDir === '/eng/packages/sub').map(s => s.configArg)).toEqual([undefined, '/eng/packages/sub/tools/jest.config.js']);
    expect(by(specs, '/eng/packages/sub/example')).toMatchObject({ status: 'ok', repoRoot: '/eng/packages/sub/example' }); // not a workspace member -> standalone
    expect(by(specs, '/eng/packages/pb/package-bundler')).toMatchObject({ flavor: 'shono', status: 'ok', jestVersion: '29.7.0', jestPkgDir: '/eng/node_modules/@wix/shono-testjs/node_modules/jest' });
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

describe('discoverProjects: shono packages', () => {
  it('lets shono win over implicit configs and carries env, node args and the chain-resolved jest', () => {
    const fs = mobileModulesFs();
    const { specs, skipped } = run(fs, allPkgJsons(fs), {}, { env: { PATH: `${MULTISHELL}`, NODE_PATH: '/host/np' } });
    const mv = by(specs, '/mm/packages/modules/mv')!;
    expect(mv).toMatchObject({
      flavor: 'shono', status: 'ok', displayName: '@wix/mv · shono', repoRoot: '/mm',
      configArg: '/mm/node_modules/@wix/shono/node_modules/@wix/shono-testjs/dist/src/jestConfig.js',
      jestPkgDir: '/mm/node_modules/jest', jestVersion: '29.7.0', nodeVersion: 'v22.17.0', nodePath: fnm('22.17.0'),
      nodeArgs: ['--max-old-space-size=4096'],
      env: { RNTL_SKIP_AUTO_DETECT_FAKE_TIMERS: 'true', USE_HEADLESS_PB: 'true', NODE_PATH: '/host/np:/mm/node_modules/@wix/wix-one-app-engine/node_modules:/mm/packages/modules/mv/node_modules' },
      cliFilters: { testPathIgnorePatterns: [] },
    });
    expect(mv.warnings).toEqual([expect.stringMatching(/Implicit Jest config ignored \(jest\.config\.js, package\.json\): scripts run `shono testjs`/)]);
    expect(mv.id).toBe(computeSpecId('/mm/packages/modules/mv', mv.configArg));
    expect(by(specs, '/mm/packages/libraries/lib')).toMatchObject({ flavor: 'shono', status: 'ok', env: { RNTL_SKIP_AUTO_DETECT_FAKE_TIMERS: 'true', USE_HEADLESS_PB: 'true' } });
    expect(skipped).toEqual([expect.objectContaining({ packageDir: '/mm', reason: 'noTests' })]);
  });

  it('falls back to implicit resolution when shono is disabled or preferScriptConfigs is off', () => {
    const fs = mobileModulesFs();
    const disabled = run(fs, ['/mm/packages/modules/mv/package.json'], { shono: { enabled: false } });
    const mv = disabled.specs[0];
    expect(mv).toMatchObject({ flavor: 'implicit', status: 'ok', configArg: '/mm/packages/modules/mv/jest.config.js' });
    expect(mv.warnings).toEqual([expect.stringMatching(/hyperjest.shono.enabled is false/), expect.stringMatching(/multipleConfigs/)]);
    const noPrefer = run(fs, ['/mm/packages/modules/mv/package.json'], { discovery: { ...DEFAULT_SETTINGS.discovery, preferScriptConfigs: false } });
    expect(noPrefer.specs[0]).toMatchObject({ flavor: 'implicit', warnings: [expect.stringMatching(/preferScriptConfigs is false/), expect.stringMatching(/multipleConfigs/)] });
  });

  it('marks a package unavailable when the shono chain is missing', () => {
    const fs = createMemFs({ '/r/package.json': pkgJson({ workspaces: ['p/*'] }), '/r/p/a/package.json': pkgJson({ name: 'a', scripts: { test: 'shono testjs' } }) });
    const { specs } = run(fs, ['/r/p/a/package.json']);
    expect(specs[0]).toMatchObject({ flavor: 'shono', status: 'unavailable', reason: expect.stringMatching(/@wix\/shono-testjs is not resolvable/) });
  });
});

describe('discoverProjects: degraded and overridden packages', () => {
  const baFs = () =>
    createMemFs({
      '/w/ba/package.json': pkgJson({ workspaces: { packages: ['packages/server/*'] } }),
      '/w/ba/.nvmrc': '20.19.4',
      '/w/ba/packages/server/jest.config.js': 'module.exports = { preset: "ts-jest" }',
      '/w/ba/packages/server/srv/package.json': pkgJson({ name: 'srv', scripts: { test: 'jest' }, devDependencies: { jest: '29.5.0' } }),
      '/w/ba/packages/server/srv/jest.config.js': "module.exports = require('../jest.config')",
      '/w/ba/serverless/rpc/package.json': pkgJson({ name: 'rpc', scripts: { test: 'jest' }, devDependencies: { jest: '^27.4.7' } }),
      '/w/ba/serverless/rpc/jest.config.js': '',
      '/w/ba/serverless/rpc/package-lock.json': '{}',
      '/w/ap/package.json': pkgJson({ workspaces: ['packages/*'] }),
      '/w/ap/packages/appium/package.json': pkgJson({ name: 'appium-tests', scripts: { test: ':' }, devDependencies: { jest: '^29.7.0', 'ts-jest': '^29', '@wix-pilot/webdriverio-appium': '^1', '@wix/applot': '^1' } }),
      '/w/ap/node_modules/jest/package.json': pkgJson({ name: 'jest', version: '29.7.0' }),
    });

  it('reports unavailable / unsupported / notJest with actionable reasons and node fallback warnings', () => {
    const fs = baFs();
    const { specs } = run(fs, allPkgJsons(fs));
    const srv = by(specs, '/w/ba/packages/server/srv')!;
    expect(srv).toMatchObject({ status: 'unavailable', reason: 'node_modules is not installed under /w/ba — run `yarn install` there', nodeVersion: 'v24.19.0' });
    expect(srv.jestVersion).toBeUndefined();
    expect(srv.warnings).toEqual([expect.stringMatching(/Node 20\.19\.4 requested by \/w\/ba\/\.nvmrc is not installed/)]);
    expect(by(specs, '/w/ba/serverless/rpc')).toMatchObject({ status: 'unsupported', repoRoot: '/w/ba/serverless/rpc', reason: expect.stringMatching(/declares jest \^27\.4\.7 \(< 29\)/) });
    expect(by(specs, '/w/ap/packages/appium')).toMatchObject({ status: 'notJest', reason: expect.stringMatching(/jest is only a dependency; test tooling is @wix-pilot\/webdriverio-appium, @wix\/applot/) });
    expect(specs.find(s => s.packageDir === '/w/ba')).toBeUndefined();
  });

  it('applies hyperjest.projects overrides and env/nodeArgs merge order', () => {
    const fs = relopsFs();
    const agent = '/w/relops/packages/agent';
    const disabled = run(fs, [`${agent}/package.json`], { projects: [{ packageDir: agent, disabled: true }] }).specs;
    expect(disabled).toEqual([expect.objectContaining({ flavor: 'override', status: 'disabled', reason: 'disabled by hyperjest.projects', displayName: 'agent' })]);
    fs.write(`${agent}/custom.config.js`, '');
    const over = run(fs, [`${agent}/package.json`], {
      projects: [{ packageDir: 'packages/agent', configArg: 'custom.config.js', env: { A: '1' }, nodePath: fnm('22.17.0') }],
      env: { A: '0', B: '2' },
      nodeArgs: ['--no-warnings'],
    }, { workspaceFolders: ['/w/relops'] }).specs;
    expect(over).toHaveLength(1);
    expect(over[0]).toMatchObject({ flavor: 'override', status: 'ok', configArg: `${agent}/custom.config.js`, displayName: 'agent · custom.config.js', env: { A: '1', B: '2' }, nodeArgs: ['--no-warnings'], nodePath: fnm('22.17.0'), nodeVersion: 'v22.17.0' });
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
    const fs = relopsFs();
    const paths = allPkgJsons(fs);
    const machine = withMachine(fs);
    const base = {
      packageJsonPaths: paths, settings: DEFAULT_SETTINGS, homeDir: HOME, platform: 'darwin' as const, env: { PATH: `${MULTISHELL}:/usr/bin` },
      fs: machine, resolve: createFsResolveFn(machine), electronExecPath: '/Applications/Code.app/Electron', workspaceFolders: ['/w/relops'],
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
