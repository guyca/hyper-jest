import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEntries, validateManifest } from './check-package.mjs';

const valid = ['extension/package.json', 'extension/readme.md', 'extension/LICENSE.md',
  'extension/dist/extension.js', 'extension/dist/discoveryWorker.js',
  'extension/dist/worker/hyperjestWorker.cjs', 'extension/dist/worker/reporter.cjs',
  'extension/dist/worker/overlayPreload.cjs', 'extension/.github/media/icon.png'];
const manifest = { name: 'hyperjest', publisher: 'GuyCarmeli', version: '0.2.0', repository: { url: 'https://github.com/guyca/hyper-jest.git' } };
test('package requires all runtime entry points', () => {
  validateEntries(valid);
  assert.throws(() => validateEntries(valid.filter(x => !x.includes('reporter.cjs'))), /missing/);
});
test('package excludes automation, dependencies, secrets, and source maps', () => {
  for (const file of ['.github/scripts/repair.mjs', '.github/workflows/release.yml', 'node_modules/a/index.js',
    'dist/extension.js.map', '.env.production', 'credentials.pem', '../escaped', 'AGENTS.md']) {
    assert.throws(() => validateEntries([...valid, `extension/${file}`]));
  }
});
test('package identity and version must equal source', () => {
  validateManifest(manifest, manifest);
  assert.throws(() => validateManifest({ ...manifest, version: '0.3.0' }, manifest), /version/);
  assert.throws(() => validateManifest({ ...manifest, publisher: 'other' }, manifest), /publisher/);
});
