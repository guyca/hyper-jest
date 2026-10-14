import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { compatibilityVersions, selectVersions } from './test-compatibility.mjs';

const manifest = { versions: ['28.1.3', '29.7.0', '30.5.2'] };

test('every supported major and an unpinned proposed upgrade are exercised', () => {
  assert.deepEqual(compatibilityVersions(manifest, '29.7.0'), manifest.versions);
  const versions = compatibilityVersions(manifest, '30.6.0');
  assert.deepEqual(versions, [...manifest.versions, '30.6.0']);
  assert.deepEqual(selectVersions(versions, ['--major', '30']), ['30.5.2', '30.6.0']);
  assert.deepEqual(selectVersions(versions, ['--version', '30.6.0']), ['30.6.0']);
  assert.throws(() => compatibilityVersions(manifest, '31.0.0'), /outside the compatibility window/);
  assert.throws(() => compatibilityVersions(manifest, '27.5.1'), /outside the compatibility window/);
});

test('rejects incomplete windows, duplicated majors and dependency ranges', () => {
  for (const versions of [[], ['29.7.0', '30.5.2'], ['28.1.3', '30.5.2', '31.0.0'], ['29.6.0', '29.7.0', '30.5.2'], ['^28', '29.7.0', '30.5.2']]) {
    assert.throws(() => compatibilityVersions({ versions }, '29.7.0'));
  }
  assert.throws(() => compatibilityVersions(manifest, '^30.5.2'));
  assert.throws(() => selectVersions(manifest.versions, ['--major', '27']));
  assert.throws(() => selectVersions(manifest.versions, ['--version', '30.6.0-next.1']));
});

test('each supported runtime has a consistent public-registry lockfile', () => {
  const actualManifest = JSON.parse(readFileSync(new URL('./jest-compatibility.json', import.meta.url), 'utf8'));
  for (const version of actualManifest.versions) {
    const fixture = new URL(`./jest-compatibility/${version}/`, import.meta.url);
    const pkg = JSON.parse(readFileSync(new URL('package.json', fixture), 'utf8'));
    const lock = JSON.parse(readFileSync(new URL('package-lock.json', fixture), 'utf8'));
    assert.equal(pkg.dependencies.jest, version);
    assert.equal(lock.packages[''].dependencies.jest, version);
    assert.equal(lock.packages['node_modules/jest'].version, version);
    for (const pkg of Object.values(lock.packages)) {
      if (!pkg.resolved) continue;
      assert.ok(pkg.resolved.startsWith('https://registry.npmjs.org/'));
      assert.ok(pkg.integrity);
    }
  }
});
