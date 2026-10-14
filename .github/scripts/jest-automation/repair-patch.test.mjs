import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const controller = fileURLToPath(new URL('./repair.mjs', import.meta.url));

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'hyperjest-repair-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const candidate = join(directory, 'candidate');
  mkdirSync(join(candidate, 'src'), { recursive: true });
  mkdirSync(join(candidate, 'scripts'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', candidate, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path, value) => writeFileSync(join(candidate, path), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  const pkg = { name: 'example', version: '0.1.0', private: true, scripts: { test: 'jest' }, devDependencies: { jest: '29.7.0' } };
  write('package.json', pkg);
  write('scripts/jest-compatibility.json', { versions: ['28.1.3', '29.7.0', '30.2.0'] });
  write('CHANGELOG.md', '# Changelog\n\n## 0.1.0\n\n- Existing history.\n');
  write('yarn.lock', '# lockfile\n');
  write('src/fix.ts', 'export const fixed = false;\n');
  git('init', '-b', 'master');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('add', '.');
  git('commit', '-m', 'baseline');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-b', 'dependabot/jest');
  write('package.json', { ...pkg, devDependencies: { jest: '30.2.0' } });
  git('commit', '-am', 'bump jest');
  const head = git('rev-parse', 'HEAD');
  const patch = join(directory, 'repair.patch');
  const env = { ...process.env, CANDIDATE_DIR: candidate, PR_NUMBER: '30', PR_HEAD_SHA: head, MASTER_SHA: base, PATCH_PATH: patch };
  delete env.GITHUB_OUTPUT;
  const run = command => execFileSync(process.execPath, [controller, command], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const patchFrom = changes => {
    changes();
    git('add', '--all');
    writeFileSync(patch, `${git('diff', '--cached', '--binary', 'HEAD')}\n`);
    git('reset', '--hard', 'HEAD');
  };
  return { git, write, run, candidate, env, patch, patchFrom };
}

test('a repair survives independent reconstruction with deterministic version and changelog', t => {
  const f = fixture(t);
  f.run('prepare');
  f.patchFrom(() => f.write('src/fix.ts', 'export const fixed = true;\n'));
  f.run('apply');
  assert.equal(JSON.parse(readFileSync(join(f.candidate, 'package.json'))).version, '0.2.0');
  assert.match(readFileSync(join(f.candidate, 'CHANGELOG.md'), 'utf8'), /## 0\.2\.0[\s\S]*Jest 30\.2\.0[\s\S]*Existing history/);
  const expectedTree = f.git('write-tree');
  f.run('export');
  f.git('reset', '--hard', 'HEAD');
  f.run('verify');
  assert.equal(f.git('write-tree'), expectedTree);
});

test('second attempt replaces deterministic notes instead of duplicating the release', t => {
  const f = fixture(t);
  f.patchFrom(() => f.write('src/fix.ts', 'export const fixed = true;\n'));
  f.run('apply');
  f.git('commit', '-m', 'first attempt');
  f.patchFrom(() => f.write('src/fix.ts', 'export const fixed = "verified";\n'));
  f.run('apply');
  const notes = readFileSync(join(f.candidate, 'CHANGELOG.md'), 'utf8');
  assert.equal((notes.match(/## 0\.2\.0/g) ?? []).length, 1);
});

test('tampered package commands in an artifact are rejected before execution', t => {
  const f = fixture(t);
  f.patchFrom(() => {
    const pkg = JSON.parse(readFileSync(join(f.candidate, 'package.json')));
    pkg.scripts.test = 'true';
    f.write('package.json', pkg);
  });
  assert.throws(() => f.run('apply'), /package scripts/);
});

test('publisher rejects forged release metadata despite an otherwise valid agent fix', t => {
  const f = fixture(t);
  f.patchFrom(() => f.write('src/fix.ts', 'export const fixed = true;\n'));
  f.run('apply');
  const pkg = JSON.parse(readFileSync(join(f.candidate, 'package.json')));
  f.write('package.json', { ...pkg, version: '9.9.9' });
  f.run('export');
  f.git('reset', '--hard', 'HEAD');
  assert.throws(() => f.run('verify'), /Unexpected release version/);
});
