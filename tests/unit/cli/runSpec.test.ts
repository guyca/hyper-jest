import * as path from 'path';
import {
  AGENT_REPORTER_ENV_VARS,
  buildChildEnv,
  buildDebugConfig,
  buildFindRelatedSpec,
  buildRunSpec,
  escapeRegExp,
  namesForSelection,
  testNamePattern,
  type RunSpecProject,
} from '../../../src/core/runSpec';

const ASSETS = '/ext/dist/worker';
const NODE = '/Users/me/.local/share/fnm/node-versions/v24.19.0/installation/bin/node';

/** jest 29.7 + ts-jest (workspace shape): implicit config, script-level ignore pattern. */
const v29: RunSpecProject = {
  packageDir: '/ws/workspace/packages/agent',
  jestPkgDir: '/ws/workspace/node_modules/jest',
  cliFilters: { testPathIgnorePatterns: ['tests/integration'] },
  env: {},
  nodePath: NODE,
  nodeArgs: [],
};

/** jest 30.5.2 + babel-jest (ESM package): explicit .cjs config, project env, node args. */
const v30: RunSpecProject = {
  packageDir: '/ws/esm/packages/domain',
  jestPkgDir: '/ws/esm/node_modules/jest',
  jestBinPath: '/ws/esm/node_modules/jest/bin/jest.js',
  configArg: '/ws/esm/packages/domain/jest.config.cjs',
  cliFilters: { testPathIgnorePatterns: [] },
  env: { NODE_ENV: 'test', CUSTOM_TEST_MODE: 'true' },
  nodePath: NODE,
  nodeArgs: ['--max-old-space-size=4096'],
};

const hostEnv = { PATH: '/usr/bin:/bin', HOME: '/Users/me', ELECTRON_RUN_AS_NODE: '1', VSCODE_INSPECTOR_OPTIONS: '{}', CLAUDECODE: '1', CURSOR_AGENT: '1', HYPERJEST_OVERLAY: '/stale.json', TERM: 'xterm' };

describe('regexp helpers', () => {
  it('escapes special characters so Jest -t matches the exact names', () => {
    expect(escapeRegExp('a.b (c) [d] $e ^f|g? h-i')).toBe('a\\.b \\(c\\) \\[d\\] \\$e \\^f\\|g\\? h\\x2di');
    expect(new RegExp(testNamePattern(['add adds 1+1', 'x (y)'])).test('add adds 1+1')).toBe(true);
    expect(new RegExp(testNamePattern(['add adds 1+1'])).test('add adds 1+11')).toBe(false);
  });

  it('unions names and refuses to narrow when a whole file is selected', () => {
    expect(namesForSelection([{ path: '/a', names: ['x', 'y'] }, { path: '/b', names: ['y', 'z'] }])).toEqual(['x', 'y', 'z']);
    expect(namesForSelection([{ path: '/a', names: ['x'] }, { path: '/b' }])).toBeUndefined();
    expect(namesForSelection([{ path: '/a', names: [] }])).toBeUndefined();
  });
});

describe('buildChildEnv', () => {
  it('drops host-only and agent-reporter vars, sets test env, colors and PATH', () => {
    const env = buildChildEnv({ hostEnv, nodePath: NODE, runId: 'r1', projectEnv: { NODE_PATH: '/x' }, extraEnv: { NODE_ENV: 'development' } });
    for (const k of ['ELECTRON_RUN_AS_NODE', 'VSCODE_INSPECTOR_OPTIONS', ...AGENT_REPORTER_ENV_VARS]) expect(env).not.toHaveProperty(k);
    expect(env).toMatchObject({ HOME: '/Users/me', TERM: 'xterm', BABEL_ENV: 'test', FORCE_COLOR: '0', NO_COLOR: '1', HYPERJEST_RUN_ID: 'r1', NODE_PATH: '/x' });
    expect(env.NODE_ENV).toBe('development'); // hyperjest.env wins last
    expect(env.PATH).toBe(`${path.dirname(NODE)}${path.delimiter}/usr/bin:/bin`);
    expect(env).not.toHaveProperty('HYPERJEST_OVERLAY'); // stale inherited manifest removed
  });

  it('keeps NODE_ENV when set, keeps colors for debug and does not touch PATH for a bare command', () => {
    const env = buildChildEnv({ hostEnv: { ...hostEnv, NODE_ENV: 'production' }, nodePath: 'node', overlayManifestPath: '/run/m.json', disableColors: false });
    expect(env.NODE_ENV).toBe('production');
    expect(env.BABEL_ENV).toBe('test');
    expect(env).not.toHaveProperty('FORCE_COLOR');
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HYPERJEST_OVERLAY).toBe('/run/m.json');
  });

  it('does not duplicate the node dir in PATH', () => {
    const env = buildChildEnv({ hostEnv: { PATH: `${path.dirname(NODE)}:/usr/bin` }, nodePath: NODE });
    expect(env.PATH).toBe(`${path.dirname(NODE)}:/usr/bin`);
  });
});

describe('buildRunSpec', () => {
  it('jest 29 file run with coverage (snapshot)', () => {
    const spec = buildRunSpec({ project: v29, workerAssetsDir: ASSETS, runId: 'r29', tests: [{ path: '/ws/workspace/packages/agent/tests/unit/a.test.ts' }], updateSnapshot: 'new', coverage: { directory: '/tmp/hj/r29' }, hostEnv });
    expect(spec).toMatchSnapshot();
    expect(spec.args.join(' ')).not.toMatch(/testPathPattern/);
    expect(spec.args.indexOf('--')).toBe(spec.args.length - 2);
  });

  it('jest 30 single-test run with overlay, snapshot update and project env (snapshot)', () => {
    const spec = buildRunSpec({
      project: v30, workerAssetsDir: ASSETS, runId: 'r30', overlayManifestPath: '/tmp/hj/r30/overlay.json', updateSnapshot: 'all',
      tests: [{ path: '/ws/esm/packages/domain/src/tests/a.test.ts', names: ['Team exposes city', 'Team equals (x)'] }], hostEnv,
    });
    expect(spec).toMatchSnapshot();
    expect(spec.args.slice(0, 3)).toEqual(['--max-old-space-size=4096', '--require', `${ASSETS}/overlayPreload.cjs`]);
    expect(spec.env.HYPERJEST_OVERLAY).toBe('/tmp/hj/r30/overlay.json');
    expect(spec.env.CUSTOM_TEST_MODE).toBe('true');
    expect(spec.preloadPath).toBe(`${ASSETS}/overlayPreload.cjs`);
  });

  it('expresses updateSnapshot none as --ci=true and runs whole files when any selection has no names', () => {
    const spec = buildRunSpec({ project: v29, workerAssetsDir: ASSETS, runId: 'r', updateSnapshot: 'none', tests: [{ path: '/a.test.ts', names: ['x'] }, { path: '/b.test.ts' }], hostEnv });
    expect(spec.args.lastIndexOf('--ci=true')).toBeGreaterThan(spec.args.indexOf('--ci=false'));
    expect(spec.args).not.toContain('-t');
    expect(spec.args.slice(-3)).toEqual(['--', '/a.test.ts', '/b.test.ts']);
    expect(spec.command).toBe(NODE);
    expect(spec.cwd).toBe(v29.packageDir);
  });

  it('falls back to "node" and appends extra jest args before --', () => {
    const spec = buildRunSpec({ project: { ...v29, nodePath: undefined }, workerAssetsDir: ASSETS, runId: 'r', tests: [{ path: '/a.test.ts' }], hostEnv, extraJestArgs: ['--detectOpenHandles'] });
    expect(spec.command).toBe('node');
    expect(spec.args.slice(-3)).toEqual(['--detectOpenHandles', '--', '/a.test.ts']);
  });
});

describe('buildDebugConfig', () => {
  it('jest 29 debug of one test (snapshot)', () => {
    const cfg = buildDebugConfig({ project: v29, workerAssetsDir: ASSETS, runId: 'd29', title: 'add adds', tests: [{ path: '/ws/workspace/packages/agent/tests/unit/a.test.ts', names: ['add adds'] }], hostEnv });
    expect(cfg).toMatchSnapshot();
    expect(cfg.type).toBe('node');
    expect(cfg.args).toContain('--runInBand');
    expect(cfg.args.filter(a => a.startsWith('--reporters='))).toEqual(['--reporters=default', `--reporters=${ASSETS}/reporter.cjs`]);
    expect(cfg.env).not.toHaveProperty('FORCE_COLOR');
  });

  it('jest 30 debug of a file with overlay (snapshot)', () => {
    const cfg = buildDebugConfig({ project: v30, workerAssetsDir: ASSETS, runId: 'd30', title: 'a.test.ts', overlayManifestPath: '/tmp/hj/d30/overlay.json', console: 'internalConsole', tests: [{ path: '/ws/esm/packages/domain/src/tests/a.test.ts' }], hostEnv });
    expect(cfg).toMatchSnapshot();
    expect(cfg.runtimeArgs).toEqual(['--max-old-space-size=4096', '--require', `${ASSETS}/overlayPreload.cjs`]);
    expect(cfg.args).not.toContain('-t');
  });
});

describe('buildFindRelatedSpec', () => {
  it('lists related tests as JSON (snapshot)', () => {
    const spec = buildFindRelatedSpec({ project: v30, runId: 'f', sources: ['/ws/esm/packages/domain/src/entities/team.ts'], hostEnv });
    expect(spec).toMatchSnapshot();
    expect(spec.args).toEqual(expect.arrayContaining(['--listTests', '--findRelatedTests', '--json']));
    expect(spec.args.slice(-2)).toEqual(['--', '/ws/esm/packages/domain/src/entities/team.ts']);
  });
});
