import {
  ancestors, ancestorsUpTo, findNearestPackageJsonDir, findRepoRoot, isExcludedWorktreePath, isUnder, isUnderNodeModules, normalizePath,
  workspaceGlobs, workspaceRelativePosix, worktreeRootOf,
} from '../../../src/core/paths';
import { createMemFs, pkgJson } from './memFs';

describe('paths', () => {
  it('normalizes and compares paths', () => {
    expect(normalizePath('/a/b/')).toBe('/a/b');
    expect(normalizePath('/')).toBe('/');
    expect(isUnder('/a/b/c', '/a/b')).toBe(true);
    expect(isUnder('/a/b', '/a/b')).toBe(true);
    expect(isUnder('/a/bc', '/a/b')).toBe(false);
    expect(ancestors('/a/b/c')).toEqual(['/a/b/c', '/a/b', '/a', '/']);
    expect(ancestorsUpTo('/a/b/c', '/a')).toEqual(['/a/b/c', '/a/b', '/a']);
    expect(isUnderNodeModules('/r/node_modules/x/package.json')).toBe(true);
    expect(isUnderNodeModules('/r/packages/x/package.json')).toBe(false);
  });

  it('finds the nearest package.json dir and the repo root (nearest workspaces ancestor wins)', () => {
    const fs = createMemFs({
      '/r/package.json': pkgJson({ workspaces: ['packages/*'] }),
      '/r/packages/a/package.json': pkgJson({ name: 'a' }),
      '/r/packages/a/src/deep/x.ts': '',
      '/r/.claude/worktrees/wt/package.json': pkgJson({ workspaces: { packages: ['packages/*'] } }),
      '/r/.claude/worktrees/wt/packages/a/package.json': pkgJson({ name: 'a' }),
      '/solo/package.json': pkgJson({ name: 'solo' }),
    });
    expect(findNearestPackageJsonDir('/r/packages/a/src/deep', fs)).toBe('/r/packages/a');
    expect(findNearestPackageJsonDir('/r/packages/a/src/deep', fs, '/r/packages/a/src')).toBeUndefined();
    expect(findRepoRoot('/r/packages/a', fs)).toBe('/r');
    expect(findRepoRoot('/r/.claude/worktrees/wt/packages/a', fs)).toBe('/r/.claude/worktrees/wt');
    expect(findRepoRoot('/r', fs)).toBe('/r');
    expect(findRepoRoot('/solo', fs)).toBe('/solo');
    expect(workspaceGlobs({ workspaces: { packages: ['x/*'] } })).toEqual(['x/*']);
    expect(workspaceGlobs({ workspaces: ['y'] })).toEqual(['y']);
    expect(workspaceGlobs({})).toBeUndefined();
  });

  it('applies the .claude/worktrees exclusion rule', () => {
    const p = '/r/.claude/worktrees/wt/packages/a/package.json';
    expect(worktreeRootOf(p)).toBe('/r/.claude/worktrees/wt');
    expect(worktreeRootOf('/r/packages/a/package.json')).toBeUndefined();
    expect(isExcludedWorktreePath(p, ['/r'])).toBe(true);
    expect(isExcludedWorktreePath(p, ['/r/.claude/worktrees/wt'])).toBe(false);
    expect(isExcludedWorktreePath(p, ['/r/.claude/worktrees/wt/packages/a'])).toBe(false);
    expect(isExcludedWorktreePath(p, ['/r/.claude/worktrees/other'])).toBe(true);
    expect(isExcludedWorktreePath('/r/packages/a/package.json', [])).toBe(false);
    expect(workspaceRelativePosix(p, ['/r/.claude/worktrees/wt'])).toBe('packages/a/package.json');
    expect(workspaceRelativePosix(p, [])).toBe(p);
  });
});
