import { createFsResolveFn, declaredMajor, isSupportedJestVersion, jestMajor, resolveFromPackage, resolveJest, resolveJestChain, resolvePackage, splitRequest } from '../../../src/core/jestResolver';
import { createMemFs, pkgJson } from './memFs';

const fs = createMemFs(
  {
    '/repo/package.json': pkgJson({ workspaces: ['packages/*'] }),
    '/repo/node_modules/jest/package.json': pkgJson({ name: 'jest', version: '29.7.0' }),
    '/repo/node_modules/jest/bin/jest.js': '#!/usr/bin/env node',
    '/repo/node_modules/jest/node_modules/jest-cli/package.json': pkgJson({ name: 'jest-cli', version: '29.7.0' }),
    '/repo/node_modules/jest-cli/package.json': pkgJson({ name: 'jest-cli', version: '30.2.0' }),
    '/repo/node_modules/jest-cli/bin/jest.js': '',
    '/repo/node_modules/.bin/jest': '#!/bin/sh\nexec node ../jest-cli/bin/jest.js',
    '/repo/node_modules/@jest/core/package.json': pkgJson({ name: '@jest/core', version: '29.7.0' }),
    '/repo/node_modules/jest-config/package.json': pkgJson({ name: 'jest-config', version: '29.7.0' }),
    '/repo/node_modules/@example/test-tools/package.json': pkgJson({ name: '@example/test-tools', main: './main.js' }),
    '/repo/node_modules/@example/test-tools/main.js': '',
    '/repo/packages/a/package.json': pkgJson({ name: 'a' }),
    '/repo/packages/b/package.json': pkgJson({ name: 'b' }),
    '/repo/packages/b/node_modules/jest/package.json': pkgJson({ name: 'jest', version: '30.5.2' }),
    '/repo/packages/lib/package.json': pkgJson({ name: '@example/lib', version: '1.0.0' }),
  },
  { symlinks: { '/repo/node_modules/@example/lib': '/repo/packages/lib' } },
);
const resolve = createFsResolveFn(fs);

describe('jestResolver', () => {
  it('splits requests', () => {
    expect(splitRequest('@example/toolkit/package.json')).toEqual({ name: '@example/toolkit', sub: 'package.json' });
    expect(splitRequest('jest')).toEqual({ name: 'jest', sub: '' });
    expect(splitRequest('jest/bin/jest.js')).toEqual({ name: 'jest', sub: 'bin/jest.js' });
  });

  it('resolves jest from the nearest node_modules, never from .bin', () => {
    const r = resolveJest(['/repo/packages/a'], resolve, fs)!;
    expect(r).toMatchObject({ pkgDir: '/repo/node_modules/jest', version: '29.7.0', major: 29, binPath: '/repo/node_modules/jest/bin/jest.js', binExists: true, resolvedFrom: '/repo/packages/a' });
    expect(resolveJest(['/repo/packages/b'], resolve, fs)).toMatchObject({ pkgDir: '/repo/packages/b/node_modules/jest', version: '30.5.2', binExists: false });
    expect(resolveJest(['/elsewhere', '/repo/packages/a'], resolve, fs)!.resolvedFrom).toBe('/repo/packages/a');
    expect(resolveJest(['/elsewhere'], resolve, fs)).toBeUndefined();
    expect(r.binPath.includes('/.bin/')).toBe(false);
  });

  it('chains from the package that depends on the next one (nested copy wins over the hoisted sibling)', () => {
    const cli = resolveFromPackage('jest-cli', '/repo/node_modules/jest', resolve, fs)!;
    expect(cli).toMatchObject({ pkgDir: '/repo/node_modules/jest/node_modules/jest-cli', version: '29.7.0' });
    const chain = resolveJestChain('/repo/node_modules/jest', resolve, fs);
    expect(chain.packages['jest-cli'].version).toBe('29.7.0');
    expect(chain.packages['@jest/core'].version).toBe('29.7.0');
    expect(chain.packages['jest-config'].version).toBe('29.7.0');
    expect(chain.missing).toContain('jest-runtime');
  });

  it('resolves package mains and symlinked workspace packages', () => {
    expect(resolve('@example/test-tools', ['/repo/packages/a'])).toBe('/repo/node_modules/@example/test-tools/main.js');
    expect(resolvePackage('@example/lib', ['/repo/packages/a'], resolve, fs)).toMatchObject({ pkgDir: '/repo/packages/lib', version: '1.0.0' });
    expect(resolve('nope/package.json', ['/repo/packages/a'])).toBeUndefined();
  });

  it('parses versions and declared ranges', () => {
    expect(jestMajor('29.7.0')).toBe(29);
    expect(jestMajor('^30.4.2')).toBe(30);
    expect(isSupportedJestVersion('28.1.0')).toBe(false);
    expect(isSupportedJestVersion('29.0.0')).toBe(true);
    expect(declaredMajor('^27.4.7')).toBe(27);
    expect(declaredMajor('>=29 <31')).toBe(29);
    expect(declaredMajor('*')).toBeUndefined();
    expect(declaredMajor(undefined)).toBeUndefined();
  });
});
