import {
  classifySpec, compareVersions, createDefaultAsyncExec, listInstalledNodes, nodeVersionCacheKey, nodeVersionCompatibleWithJest, parseVersion, pickNode, readNodeRequest, satisfiesRange, selectVersion, validateNodeBinaryAsync,
} from '../../../src/core/nodeResolver';
import { createFakeExec, createMemFs, pkgJson } from './memFs';

const HOME = '/home/u';
const fnm = (v: string) => `${HOME}/.local/share/fnm/node-versions/v${v}/installation/bin/node`;
const MULTISHELL = `${HOME}/.local/state/fnm_multishells/1/bin`;

function machine(extra: Record<string, string> = {}) {
  const fs = createMemFs(
    {
      [fnm('16.20.0')]: '', [fnm('22.17.0')]: '', [fnm('24.15.0')]: '', [fnm('24.19.0')]: '',
      '/opt/homebrew/bin/node': '',
      '/w/engine/package.json': pkgJson({ workspaces: ['packages/*'] }),
      '/w/engine/.nvmrc': '24.15.0\n',
      '/w/engine/packages/a/package.json': pkgJson({ name: 'a' }),
      '/w/mm/package.json': pkgJson({ workspaces: ['p/*'] }),
      '/w/mm/.nvmrc': '22.17.0',
      '/w/mm/p/a/package.json': pkgJson({ name: 'a' }),
      '/w/ba/package.json': pkgJson({ workspaces: ['p/*'] }),
      '/w/ba/.nvmrc': '20.19.4',
      '/w/ba/p/a/package.json': pkgJson({ name: 'a' }),
      '/w/dog/package.json': pkgJson({ workspaces: ['p/*'], engines: { node: '>=20' } }),
      '/w/dog/p/a/package.json': pkgJson({ name: 'a' }),
      '/w/pref/package.json': pkgJson({ workspaces: ['p/*'], engines: { node: '>=20' } }),
      '/w/pref/.node-version': '# pinned\nv24.15.0\n',
      '/w/pref/p/a/package.json': pkgJson({ name: 'a' }),
      '/w/pref/p/a/.nvmrc': 'lts/jod',
      '/w/pref/p/b/package.json': pkgJson({ name: 'b', engines: { node: '16' } }),
      ...extra,
    },
    { symlinks: { [MULTISHELL]: `${HOME}/.local/share/fnm/node-versions/v24.19.0/installation/bin` } },
  );
  const exec = createFakeExec({ '/opt/homebrew/bin/node': 'v26.9.0', '/Applications/Code.app/Electron': 'v24.21.0' });
  const deps = { fs, exec, versionCache: new Map<string, string | null>() };
  const env = { PATH: `${MULTISHELL}:/usr/bin` };
  const base = { env, homeDir: HOME, platform: 'darwin' as const, electronExecPath: '/Applications/Code.app/Electron' };
  return { fs, exec, deps, env, base };
}

describe('nodeResolver versions', () => {
  it('parses and compares', () => {
    expect(parseVersion('v24.19.0')).toEqual({ major: 24, minor: 19, patch: 0 });
    expect(parseVersion('24')).toEqual({ major: 24, minor: 0, patch: 0 });
    expect(parseVersion('lts/*')).toBeUndefined();
    expect(compareVersions(parseVersion('24.19.0')!, parseVersion('24.9.9')!)).toBeGreaterThan(0);
  });

  it('evaluates semver ranges', () => {
    const v = (s: string) => parseVersion(s)!;
    expect(satisfiesRange(v('24.19.0'), '>=20')).toBe(true);
    expect(satisfiesRange(v('18.13.0'), '^18.14.0 || ^20.0.0 || ^22.0.0 || >=24.0.0')).toBe(false);
    expect(satisfiesRange(v('18.14.0'), '^18.14.0 || ^20.0.0')).toBe(true);
    expect(satisfiesRange(v('21.0.0'), '^20.0.0')).toBe(false);
    expect(satisfiesRange(v('0.2.5'), '^0.2.3')).toBe(true);
    expect(satisfiesRange(v('0.3.0'), '^0.2.3')).toBe(false);
    expect(satisfiesRange(v('1.2.9'), '~1.2.3')).toBe(true);
    expect(satisfiesRange(v('1.3.0'), '~1.2.3')).toBe(false);
    expect(satisfiesRange(v('22.1.0'), '22.x')).toBe(true);
    expect(satisfiesRange(v('22.1.0'), '22')).toBe(true);
    expect(satisfiesRange(v('23.0.0'), '22')).toBe(false);
    expect(satisfiesRange(v('5.0.0'), '1.0.0 - 4.0.0')).toBe(false);
    expect(satisfiesRange(v('3.0.0'), '1.0.0 - 4.0.0')).toBe(true);
    expect(satisfiesRange(v('20.0.0'), '>= 18 < 21')).toBe(true);
    expect(satisfiesRange(v('20.0.0'), 'garbage')).toBeUndefined();
    expect(classifySpec('lts/jod')).toEqual({ kind: 'lts', major: 22 });
    expect(classifySpec('24.15')).toMatchObject({ kind: 'majorMinor' });
    expect(classifySpec('node')).toEqual({ kind: 'any' });
  });

  it('selects exact -> major.minor -> major -> range', () => {
    const inst = ['24.13.0', '24.15.0', '24.19.0', '22.17.0', '16.20.0'].map(s => ({ version: parseVersion(s)!, name: s }));
    expect(selectVersion('24.15.0', inst)!.name).toBe('24.15.0');
    expect(selectVersion('24.15.1', inst)!.name).toBe('24.15.0');
    expect(selectVersion('24.16.0', inst)!.name).toBe('24.19.0');
    expect(selectVersion('24', inst)!.name).toBe('24.19.0');
    expect(selectVersion('v22.17', inst)!.name).toBe('22.17.0');
    expect(selectVersion('20.19.4', inst)).toBeUndefined();
    expect(selectVersion('lts/jod', inst)!.name).toBe('22.17.0');
    expect(selectVersion('>=20', inst)!.name).toBe('24.19.0');
    expect(selectVersion('>=20', inst, inst[1])!.name).toBe('24.15.0');
    expect(selectVersion('>=25', inst)).toBeUndefined();
    expect(selectVersion('bogus/x', inst)).toBeUndefined();
  });

  it('checks Jest engines', () => {
    expect(nodeVersionCompatibleWithJest('v16.20.0', 30)).toBe(false);
    expect(nodeVersionCompatibleWithJest('v16.20.0', 29)).toBe(true);
    expect(nodeVersionCompatibleWithJest('v14.14.0', 29)).toBe(false);
    expect(nodeVersionCompatibleWithJest('v24.19.0', 30)).toBe(true);
    expect(nodeVersionCompatibleWithJest(undefined, 30)).toBeUndefined();
    expect(nodeVersionCompatibleWithJest('v20.0.0', undefined)).toBeUndefined();
  });
});

describe('nodeResolver requests and installs', () => {
  it('reads the nearest .nvmrc / .node-version / engines.node', () => {
    const { fs } = machine();
    expect(readNodeRequest('/w/engine/packages/a', '/w/engine', fs)).toEqual({ spec: '24.15.0', source: 'nvmrc', file: '/w/engine/.nvmrc' });
    expect(readNodeRequest('/w/dog/p/a', '/w/dog', fs)).toEqual({ spec: '>=20', source: 'engines', file: '/w/dog/package.json' });
    expect(readNodeRequest('/w/pref/p/a', '/w/pref', fs)).toMatchObject({ spec: 'lts/jod', source: 'nvmrc' });
    expect(readNodeRequest('/w/pref/p/b', '/w/pref', fs)).toMatchObject({ spec: '16', source: 'engines', file: '/w/pref/p/b/package.json' });
    expect(readNodeRequest('/w/pref', '/w/pref', fs)).toEqual({ spec: 'v24.15.0', source: 'node-version', file: '/w/pref/.node-version' });
    expect(readNodeRequest('/nowhere', '/nowhere', fs)).toBeUndefined();
  });

  it('lists fnm installs with versions and Homebrew without', () => {
    const { fs, base } = machine();
    const list = listInstalledNodes(base, fs);
    expect(list.map(n => `${n.manager}:${n.version ?? '?'}`).sort()).toEqual(['fnm:v16.20.0', 'fnm:v22.17.0', 'fnm:v24.15.0', 'fnm:v24.19.0', 'homebrew:?']);
  });
});

describe('pickNode', () => {
  it('maps .nvmrc to the fnm install (versions 24.15.0 and 22.17.0)', () => {
    const { deps, base } = machine();
    const eng = pickNode({ ...base, packageDir: '/w/engine/packages/a', repoRoot: '/w/engine', jestMajor: 30 }, deps);
    expect(eng).toMatchObject({ nodePath: fnm('24.15.0'), version: 'v24.15.0', source: 'nvmrc', requested: { spec: '24.15.0' }, env: {}, warnings: [] });
    const mm = pickNode({ ...base, packageDir: '/w/mm/p/a', repoRoot: '/w/mm', jestMajor: 29 }, deps);
    expect(mm).toMatchObject({ nodePath: fnm('22.17.0'), version: 'v22.17.0', source: 'nvmrc' });
  });

  it('warns and falls back to PATH when the requested version is missing (uninstalled workspace 20.19.4)', () => {
    const { deps, base } = machine();
    const r = pickNode({ ...base, packageDir: '/w/ba/p/a', repoRoot: '/w/ba', jestMajor: 29 }, deps);
    expect(r.source).toBe('path');
    expect(r.nodePath).toBe(fnm('24.19.0'));
    expect(r.version).toBe('v24.19.0');
    expect(r.requested).toMatchObject({ spec: '20.19.4', source: 'nvmrc' });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/Node 20\.19\.4 requested by \/w\/ba\/\.nvmrc is not installed .*v24\.19\.0.*falling back/);
  });

  it('prefers the PATH node for ranges it satisfies and honours lts/major specs', () => {
    const { deps, base } = machine();
    expect(pickNode({ ...base, packageDir: '/w/dog/p/a', repoRoot: '/w/dog' }, deps)).toMatchObject({ nodePath: fnm('24.19.0'), source: 'engines', warnings: [] });
    expect(pickNode({ ...base, packageDir: '/w/pref/p/a', repoRoot: '/w/pref' }, deps)).toMatchObject({ nodePath: fnm('22.17.0'), source: 'nvmrc' });
    expect(pickNode({ ...base, packageDir: '/w/pref', repoRoot: '/w/pref' }, deps)).toMatchObject({ nodePath: fnm('24.15.0'), source: 'node-version' });
  });

  it('flags Jest engines incompatibility as a warning without changing the pick', () => {
    const { deps, base } = machine();
    const r = pickNode({ ...base, packageDir: '/w/pref/p/b', repoRoot: '/w/pref', jestMajor: 30 }, deps);
    expect(r).toMatchObject({ nodePath: fnm('16.20.0'), version: 'v16.20.0', source: 'engines' });
    expect(r.warnings).toEqual([expect.stringMatching(/Node v16\.20\.0 \(engines\) is outside Jest 30's supported range \^18\.14\.0/)]);
    expect(pickNode({ ...base, packageDir: '/w/pref/p/b', repoRoot: '/w/pref', jestMajor: 29 }, deps).warnings).toEqual([]);
  });

  it('honours the setting, validates it and falls back when it is broken', () => {
    const { fs, base } = machine({ '/custom/bin/node': '' });
    const deps = { fs, exec: createFakeExec({ '/custom/bin/node': 'v20.0.0', '/opt/homebrew/bin/node': 'v26.9.0' }), versionCache: new Map<string, string | null>() };
    expect(pickNode({ ...base, settingNodePath: '/custom/bin/node', packageDir: '/w/mm/p/a', repoRoot: '/w/mm' }, deps)).toMatchObject({ nodePath: '/custom/bin/node', version: 'v20.0.0', source: 'setting' });
    const bogus = pickNode({ ...base, settingNodePath: '/nope/node', packageDir: '/w/mm/p/a', repoRoot: '/w/mm' }, deps);
    expect(bogus.source).toBe('nvmrc');
    expect(bogus.warnings[0]).toMatch(/hyperjest.nodePath "\/nope\/node" was not found/);
    const byName = pickNode({ ...base, settingNodePath: 'node', packageDir: '/w/mm/p/a', repoRoot: '/w/mm' }, deps);
    expect(byName).toMatchObject({ nodePath: fnm('24.19.0'), source: 'setting' });
  });

  it('uses Homebrew when PATH has no node, then the Electron host as the last resort', () => {
    const { deps, base } = machine();
    const brew = pickNode({ ...base, env: { PATH: '/usr/bin' }, packageDir: '/nowhere', repoRoot: '/nowhere', jestMajor: 30 }, deps);
    expect(brew).toMatchObject({ nodePath: '/opt/homebrew/bin/node', version: 'v26.9.0', source: 'homebrew' });
    const bare = createMemFs({ '/w/x/package.json': pkgJson({ name: 'x' }) });
    const exec = createFakeExec({ '/Applications/Code.app/Electron': 'v24.21.0' });
    const r = pickNode({ ...base, env: { PATH: '/usr/bin' }, platform: 'linux', packageDir: '/w/x', repoRoot: '/w/x', jestMajor: 30 }, { fs: bare, exec, versionCache: new Map() });
    expect(r).toMatchObject({ nodePath: '/Applications/Code.app/Electron', version: 'v24.21.0', source: 'electron', env: { ELECTRON_RUN_AS_NODE: '1' } });
    expect(r.warnings).toEqual([expect.stringMatching(/No standalone Node found/)]);
    expect(exec.calls[0].env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
  });

  it('spawns each binary once (version cache) and skips broken binaries', () => {
    const { deps, base, exec } = machine();
    pickNode({ ...base, packageDir: '/w/engine/packages/a', repoRoot: '/w/engine' }, deps);
    pickNode({ ...base, packageDir: '/w/engine/packages/a', repoRoot: '/w/engine' }, deps);
    expect(exec.calls.filter(c => c.file === fnm('24.15.0'))).toHaveLength(1);
    const broken = machine();
    const brokenExec = createFakeExec({ [fnm('24.15.0')]: 'BROKEN', '/opt/homebrew/bin/node': 'v26.9.0' });
    const r = pickNode({ ...broken.base, packageDir: '/w/engine/packages/a', repoRoot: '/w/engine' }, { fs: broken.fs, exec: brokenExec, versionCache: new Map() });
    expect(r).toMatchObject({ nodePath: fnm('24.19.0'), source: 'nvmrc' });
    expect(r.warnings).toEqual([expect.stringMatching(/could not be executed; skipping/)]);
  });

  it('terminates when every matching install is broken (no ping-pong between two broken picks)', () => {
    const { fs, base } = machine();
    const allBroken = createFakeExec({ [fnm('24.15.0')]: 'BROKEN', [fnm('24.19.0')]: 'BROKEN', '/opt/homebrew/bin/node': 'BROKEN', '/Applications/Code.app/Electron': 'v24.21.0' });
    const r = pickNode({ ...base, packageDir: '/w/engine/packages/a', repoRoot: '/w/engine' }, { fs, exec: allBroken, versionCache: new Map() });
    expect(r.warnings.filter(w => /could not be executed; skipping/.test(w)).length).toBeLessThanOrEqual(3);
    expect(r.nodePath).not.toBe(fnm('24.15.0'));
  });
});

describe('validateNodeBinaryAsync', () => {
  it('caches by path (electron apart) and maps unrunnable binaries to null', async () => {
    const fake = createFakeExec({ '/bin/good': 'v24.19.0', '/bin/bad': 'BROKEN', '/E': 'v22.1.0' });
    const exec = async (f: string, a: string[], e?: Record<string, string>) => fake(f, a, e);
    const cache = new Map<string, string | null>();
    await expect(validateNodeBinaryAsync('/bin/good', cache, exec)).resolves.toBe('v24.19.0');
    await expect(validateNodeBinaryAsync('/bin/good', cache, exec)).resolves.toBe('v24.19.0');
    await expect(validateNodeBinaryAsync('/bin/bad', cache, exec)).resolves.toBeNull();
    await expect(validateNodeBinaryAsync('/E', cache, exec, { ELECTRON_RUN_AS_NODE: '1' })).resolves.toBe('v22.1.0');
    expect(fake.calls.map(c => c.file)).toEqual(['/bin/good', '/bin/bad', '/E']);
    expect([...cache.keys()]).toEqual(['/bin/good', '/bin/bad', nodeVersionCacheKey('/E', { ELECTRON_RUN_AS_NODE: '1' })]);
  });

  it('the default async exec runs a real binary and reports a missing one as unrunnable', async () => {
    const exec = createDefaultAsyncExec();
    await expect(validateNodeBinaryAsync(process.execPath, new Map(), exec)).resolves.toBe(`v${process.versions.node}`);
    await expect(validateNodeBinaryAsync('/nonexistent/hyperjest/node', new Map(), exec)).resolves.toBeNull();
  });
});
