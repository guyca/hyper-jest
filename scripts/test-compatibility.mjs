#!/usr/bin/env node
/** Exercise built HyperJest workers against isolated Jest installations, never changing the root lockfile. */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const exactVersion = /^\d+\.\d+\.\d+$/;
const majorOf = version => Number(version.split('.')[0]);

export function compatibilityVersions(manifest, candidate) {
  const versions = manifest?.versions;
  if (!Array.isArray(versions) || versions.length !== 3 || versions.some(v => typeof v !== 'string' || !exactVersion.test(v))) {
    throw new Error('jest-compatibility.json must pin exactly three stable Jest versions.');
  }
  const majors = versions.map(majorOf);
  if (majors.some((major, index) => index > 0 && major !== majors[index - 1] + 1)) {
    throw new Error('Compatibility versions must list three consecutive majors in ascending order.');
  }
  if (typeof candidate !== 'string' || !exactVersion.test(candidate)) {
    throw new Error('The root Jest dependency must be an exact stable version so its proposed upgrade is tested.');
  }
  if (!majors.includes(majorOf(candidate))) {
    throw new Error(`Jest ${candidate} is outside the compatibility window. Update jest-compatibility.json and its fixture locks to the latest three stable majors before adopting it.`);
  }
  return [...new Set([...versions, candidate])];
}

export function selectVersions(versions, args) {
  if (args.length === 0 || (args.length === 1 && args[0] === '--matrix')) return versions;
  if (args.length === 2 && args[0] === '--version' && exactVersion.test(args[1])) return [args[1]];
  if (args.length === 2 && args[0] === '--major' && /^\d+$/.test(args[1])) {
    const matches = versions.filter(version => majorOf(version) === Number(args[1]));
    if (matches.length) return matches;
  }
  throw new Error('Usage: node scripts/test-compatibility.mjs [--matrix | --major N | --version X.Y.Z]');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: process.env, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.signal ?? result.status}`);
}

function integrationTests(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? integrationTests(file) : entry.name.endsWith('.test.ts') ? [file] : [];
  });
}

export function main(args = process.argv.slice(2)) {
  const manifest = readJson(path.join(root, 'scripts/jest-compatibility.json'));
  const candidate = readJson(path.join(root, 'package.json')).devDependencies.jest;
  const versions = selectVersions(compatibilityVersions(manifest, candidate), args);
  if (args[0] === '--matrix') {
    console.log(JSON.stringify({ include: versions.map(version => ({ major: majorOf(version), version })) }));
    return;
  }
  for (const asset of ['hyperjestWorker', 'reporter', 'overlayPreload']) {
    if (!existsSync(path.join(root, `dist/worker/${asset}.cjs`))) throw new Error('Build the extension before running compatibility tests: yarn build');
  }
  const harness = path.join(root, 'node_modules/jest/bin/jest.js');
  if (!existsSync(harness)) throw new Error('Install root dependencies first: yarn install --immutable');
  const tests = [...integrationTests(path.join(root, 'tests/integration')), path.join(root, 'tests/unit/cli/fixture.e2e.test.ts')];
  for (const version of versions) {
    const dir = mkdtempSync(path.join(tmpdir(), `hyperjest-jest-${version}-`));
    try {
      console.log(`\nTesting HyperJest with Jest ${version}`);
      const fixtureLock = path.join(root, 'scripts/jest-compatibility', version);
      if (existsSync(path.join(fixtureLock, 'package-lock.json'))) {
        cpSync(path.join(fixtureLock, 'package.json'), path.join(dir, 'package.json'));
        cpSync(path.join(fixtureLock, 'package-lock.json'), path.join(dir, 'package-lock.json'));
        run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir });
      } else {
        writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'hyperjest-compatibility', private: true, version: '1.0.0', dependencies: { jest: version } }, null, 2)}\n`);
        run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir });
      }
      const jestPackage = path.join(dir, 'node_modules/jest');
      const actual = readJson(path.join(jestPackage, 'package.json')).version;
      if (actual !== version) throw new Error(`Expected Jest ${version}, installed ${actual}`);
      run(process.execPath, [harness, '--ci', '--runInBand', '--runTestsByPath', ...tests], {
        env: { ...process.env, HYPERJEST_IT: '1', HYPERJEST_JEST_PACKAGE: jestPackage },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
