import { createFsResolveFn, resolveJest } from '../../../src/core/jestResolver';
import { SHONO_ENV, SHONO_NODE_ARGS, describeShonoChain, isOneAppModule, resolveShonoChain, shonoUnitTestsFolders, versionAtLeast } from '../../../src/core/shono';
import { createMemFs, pkgJson } from './memFs';

/** mobile-modules-like layout: CLI chain uses the NESTED shono-testjs 9.136 while wallaby's root copy is 9.134. */
export const mobileModulesFs = () =>
  createMemFs({
    '/mm/package.json': pkgJson({ name: 'mobile-modules', workspaces: ['packages/modules/*', 'packages/libraries/*'], scripts: { testjs: 'yarn workspaces foreach --all run testjs' } }),
    '/mm/.nvmrc': '22.17.0\n',
    '/mm/node_modules/@wix/shono/package.json': pkgJson({ name: '@wix/shono', version: '9.1568.0', bin: 'index.js' }),
    '/mm/node_modules/@wix/shono/index.js': '',
    '/mm/node_modules/@wix/shono/node_modules/@wix/shono-lib/package.json': pkgJson({ name: '@wix/shono-lib', version: '9.258.0' }),
    '/mm/node_modules/@wix/shono/node_modules/@wix/shono-testjs/package.json': pkgJson({ name: '@wix/shono-testjs', version: '9.136.0' }),
    '/mm/node_modules/@wix/shono/node_modules/@wix/shono-testjs/dist/src/jestConfig.js': 'module.exports = {}',
    '/mm/node_modules/@wix/shono-lib/package.json': pkgJson({ name: '@wix/shono-lib', version: '9.256.0' }),
    '/mm/node_modules/@wix/shono-testjs/package.json': pkgJson({ name: '@wix/shono-testjs', version: '9.134.0' }),
    '/mm/node_modules/@wix/shono-testjs/dist/src/jestConfig.js': 'module.exports = {}',
    '/mm/node_modules/jest/package.json': pkgJson({ name: 'jest', version: '29.7.0' }),
    '/mm/node_modules/jest/bin/jest.js': '',
    '/mm/node_modules/jest-cli/package.json': pkgJson({ name: 'jest-cli', version: '30.2.0' }),
    '/mm/node_modules/.bin/jest': '',
    '/mm/node_modules/@wix/wix-one-app-engine/package.json': pkgJson({ name: '@wix/wix-one-app-engine', main: './main.js' }),
    '/mm/node_modules/@wix/wix-one-app-engine/main.js': '',
    '/mm/packages/modules/mv/package.json': pkgJson({ name: '@wix/mv', wix: { isOneAppModule: true }, scripts: { testjs: 'shono testjs', test: 'shono testjs' }, dependencies: { '@wix/shono': '^9' }, jest: { testMatch: ['<rootDir>/src/**/__tests__/*.test.js'] } }),
    '/mm/packages/modules/mv/jest.config.js': 'module.exports = {}',
    '/mm/packages/modules/mv/src/a.spec.ts': '',
    '/mm/packages/libraries/lib/package.json': pkgJson({ name: '@wix/lib', scripts: { test: 'shono testjs' }, dependencies: { '@wix/shono': '^9' } }),
  });

/** engine-like layout: no @wix/shono; shono-lib at the root brings shono-testjs with a NESTED jest 29.7 while the root jest is 30.4.2. */
export const engineFs = () =>
  createMemFs({
    '/eng/package.json': pkgJson({ workspaces: ['packages/*', 'packages/pb/*'] }),
    '/eng/.nvmrc': '24.15.0',
    '/eng/node_modules/jest/package.json': pkgJson({ name: 'jest', version: '30.4.2' }),
    '/eng/node_modules/jest/bin/jest.js': '',
    '/eng/node_modules/@wix/shono-lib/package.json': pkgJson({ name: '@wix/shono-lib', version: '9.258.0' }),
    '/eng/node_modules/@wix/shono-testjs/package.json': pkgJson({ name: '@wix/shono-testjs', version: '9.136.0' }),
    '/eng/node_modules/@wix/shono-testjs/dist/src/jestConfig.js': '',
    '/eng/node_modules/@wix/shono-testjs/node_modules/jest/package.json': pkgJson({ name: 'jest', version: '29.7.0' }),
    '/eng/node_modules/@wix/shono-testjs/node_modules/jest/bin/jest.js': '',
    '/eng/packages/pb/package-bundler/package.json': pkgJson({ name: '@wix/package-bundler', scripts: { test: 'shono testjs' }, devDependencies: { '@wix/shono-lib': '^9' } }),
  });

describe('shono chain', () => {
  it('resolves shono -> shono-lib -> shono-testjs like the CLI and builds env for one-app modules', () => {
    const fs = mobileModulesFs();
    const resolve = createFsResolveFn(fs);
    const pkg = JSON.parse(fs.readFile('/mm/packages/modules/mv/package.json')!);
    const r = resolveShonoChain({ packageDir: '/mm/packages/modules/mv', pkg, resolve, fs });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.chain;
    expect(c.shono?.version).toBe('9.1568.0');
    expect(c.shonoLib?.pkgDir).toBe('/mm/node_modules/@wix/shono/node_modules/@wix/shono-lib');
    expect(c.testjs.version).toBe('9.136.0');
    expect(c.configArg).toBe('/mm/node_modules/@wix/shono/node_modules/@wix/shono-testjs/dist/src/jestConfig.js');
    expect(c.jestStartDirs).toEqual(['/mm/node_modules/@wix/shono/node_modules/@wix/shono-testjs', '/mm/packages/modules/mv']);
    expect(c.isOneAppModule).toBe(true);
    expect(c.engineDir).toBe('/mm/node_modules/@wix/wix-one-app-engine');
    expect(c.env).toEqual({ ...SHONO_ENV, NODE_PATH: '/mm/node_modules/@wix/wix-one-app-engine/node_modules:/mm/packages/modules/mv/node_modules' });
    expect(c.nodeArgs).toEqual([...SHONO_NODE_ARGS]);
    expect(c.unitTestsFolders).toEqual(['unitTests', 'tests']);
    expect(c.warnings).toEqual([]);
    expect(resolveJest(c.jestStartDirs, resolve, fs)).toMatchObject({ pkgDir: '/mm/node_modules/jest', version: '29.7.0' });
    expect(describeShonoChain(c)).toBe('shono@9.1568.0 -> shono-lib@9.258.0 -> shono-testjs@9.136.0 (/mm/node_modules/@wix/shono/node_modules/@wix/shono-testjs)');
    const withPath = resolveShonoChain({ packageDir: '/mm/packages/modules/mv', pkg, resolve, fs, existingNodePath: '/x/node_modules' });
    expect(withPath.ok && withPath.chain.env.NODE_PATH).toBe('/x/node_modules:/mm/node_modules/@wix/wix-one-app-engine/node_modules:/mm/packages/modules/mv/node_modules');
  });

  it('omits NODE_PATH for non one-app packages', () => {
    const fs = mobileModulesFs();
    const resolve = createFsResolveFn(fs);
    const pkg = JSON.parse(fs.readFile('/mm/packages/libraries/lib/package.json')!);
    const r = resolveShonoChain({ packageDir: '/mm/packages/libraries/lib', pkg, resolve, fs });
    expect(r.ok && r.chain.env).toEqual(SHONO_ENV);
    expect(r.ok && r.chain.isOneAppModule).toBe(false);
    expect(isOneAppModule(pkg)).toBe(false);
    expect(isOneAppModule({ wix: { isOneAppModule: true } })).toBe(true);
  });

  it('works through shono-lib directly and resolves jest from the shono-testjs dir first', () => {
    const fs = engineFs();
    const resolve = createFsResolveFn(fs);
    const r = resolveShonoChain({ packageDir: '/eng/packages/pb/package-bundler', pkg: {}, resolve, fs });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chain.shono).toBeUndefined();
    expect(r.chain.shonoLib?.pkgDir).toBe('/eng/node_modules/@wix/shono-lib');
    expect(r.chain.testjs.pkgDir).toBe('/eng/node_modules/@wix/shono-testjs');
    expect(resolveJest(r.chain.jestStartDirs, resolve, fs)).toMatchObject({ pkgDir: '/eng/node_modules/@wix/shono-testjs/node_modules/jest', version: '29.7.0' });
    expect(resolveJest(['/eng/packages/pb/package-bundler'], resolve, fs)!.version).toBe('30.4.2');
  });

  it('reports a missing chain with an install hint', () => {
    const fs = createMemFs({ '/r/packages/a/package.json': pkgJson({ name: 'a', scripts: { test: 'shono testjs' } }) });
    const r = resolveShonoChain({ packageDir: '/r/packages/a', pkg: {}, resolve: createFsResolveFn(fs), fs });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/@wix\/shono-testjs is not resolvable.*yarn install/);
    expect(r.tried).toHaveLength(3);
  });

  it('knows the unit-test folders per shono-testjs version', () => {
    expect(versionAtLeast('9.136.0', '9.136.0')).toBe(true);
    expect(versionAtLeast('9.134.0', '9.136.0')).toBe(false);
    expect(versionAtLeast('10.0.0', '9.136.0')).toBe(true);
    expect(shonoUnitTestsFolders('9.131.0')).toEqual(['unitTests']);
    expect(shonoUnitTestsFolders('9.136.0')).toEqual(['unitTests', 'tests']);
  });
});
