import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertAgentPaths, assertCompatibility, assertEligiblePr, assertFresh, assertJestUpgrade,
  assertPackagePreserved, decideAttempt, formatState, nextReleaseVersion, parseState, releaseMetadata,
} from './repair-policy.mjs';

const manifest = { versions: ['28.1.3', '29.7.0', '30.2.0'] };
const packageJson = { version: '0.1.0', scripts: { test: 'jest' }, devDependencies: { jest: '29.7.0', typescript: '7.0.0' } };
const pr = { state: 'open', draft: false, user: { login: 'dependabot[bot]' }, head: { sha: 'a'.repeat(40), repo: { full_name: 'guyca/hyper-jest' } }, base: { ref: 'master', repo: { full_name: 'guyca/hyper-jest' } } };

test('only a same-repository Dependabot PR targeting master qualifies', () => {
  assert.doesNotThrow(() => assertEligiblePr(pr, 'guyca/hyper-jest'));
  for (const mutation of [
    { state: 'closed' }, { draft: true }, { user: { login: 'someone' } },
    { head: { ...pr.head, repo: { full_name: 'someone/fork' } } },
    { base: { ...pr.base, ref: 'other' } },
  ]) assert.throws(() => assertEligiblePr({ ...pr, ...mutation }, 'guyca/hyper-jest'));
});

test('a root dependency increase, not a title mentioning Jest, is required', () => {
  assert.throws(() => assertJestUpgrade(packageJson, packageJson));
  assert.throws(() => assertJestUpgrade(packageJson, { ...packageJson, devDependencies: { jest: '28.1.3' } }));
  assert.doesNotThrow(() => assertJestUpgrade(packageJson, { ...packageJson, devDependencies: { jest: '30.2.0' } }));
});

test('state must be written by the Actions bot; malformed state is ignored', () => {
  const state = { schemaVersion: 1, status: 'pushed', attempts: [{ headSha: 'abc' }] };
  const comment = { user: { login: 'github-actions[bot]' }, body: formatState(state, 'Waiting for CI') };
  assert.deepEqual(parseState(comment), state);
  assert.equal(parseState({ ...comment, user: { login: 'dependabot[bot]' } }), null);
  assert.equal(parseState({ ...comment, body: '<!-- hyperjest-jest-repair:{broken} -->' }), null);
});

test('duplicate events and manual retries cannot exceed two attempts', () => {
  const state = { attempts: [{ headSha: 'one' }] };
  assert.equal(decideAttempt({ state, headSha: 'one' }), 'duplicate');
  assert.equal(decideAttempt({ state, headSha: 'two' }), 'repair');
  assert.equal(decideAttempt({ state, headSha: 'one', manual: true }), 'repair');
  assert.equal(decideAttempt({ state: { attempts: [{}, {}] }, headSha: 'three', manual: true }), 'exhausted');
});

test('both PR and master revisions must remain unchanged', () => {
  assert.doesNotThrow(() => assertFresh(pr, 'master', pr.head.sha, 'master'));
  assert.throws(() => assertFresh(pr, 'new-master', pr.head.sha, 'master'));
  assert.throws(() => assertFresh(pr, 'master', 'other-head', 'master'));
});

test('repair policy permits runtime fixes and forbids automation, policies, symlinks, test removal', () => {
  for (const path of ['src/core/run.ts', 'tests/unit/run.test.ts', 'tsconfig.worker.json', 'jest.config.js', 'package.json', 'yarn.lock', 'scripts/jest-compatibility/31.0.0/package-lock.json']) {
    assert.doesNotThrow(() => assertAgentPaths([{ path, status: 'M', mode: '100644' }]));
  }
  for (const path of ['.github/workflows/ci.yml', 'scripts/test-compatibility.mjs', 'src/AGENTS.md', 'tests/.cursor/hooks.json', '../outside', 'CHANGELOG.md']) {
    assert.throws(() => assertAgentPaths([{ path, status: 'M', mode: '100644' }]));
  }
  assert.throws(() => assertAgentPaths([{ path: 'tests/unit/test.ts', status: 'D' }]));
  assert.throws(() => assertAgentPaths([{ path: 'src/link', status: 'A', mode: '120000' }]));
});

test('proposed upgrades survive; package scripts and metadata cannot be weakened', () => {
  assert.doesNotThrow(() => assertPackagePreserved(packageJson, { ...packageJson, devDependencies: { ...packageJson.devDependencies, jest: '30.2.0', esbuild: '0.28.2' } }));
  for (const update of [
    { devDependencies: { jest: '29.7.0' } },
    { devDependencies: { ...packageJson.devDependencies, typescript: '5.9.3' } },
    { scripts: { test: 'true' } }, { version: '0.9.0' },
  ]) assert.throws(() => assertPackagePreserved(packageJson, { ...packageJson, ...update }));
  assert.doesNotThrow(() => assertPackagePreserved(packageJson, { ...packageJson, version: '0.2.0' }, { allowReleaseVersion: true }));
});

test('the support window rolls without skipping a major or downgrading retained pins', () => {
  assert.doesNotThrow(() => assertCompatibility(manifest, manifest, '30.2.0'));
  assert.doesNotThrow(() => assertCompatibility(manifest, { versions: ['29.7.0', '30.2.0', '31.0.0'] }, '31.0.0'));
  for (const versions of [['29.7.0', '30.2.0'], ['29.7.0', '30.2.0', '30.3.0'], ['28.1.3', '29.6.0', '30.2.0'], ['28.1.3', '30.2.0', '31.0.0']]) {
    assert.throws(() => assertCompatibility(manifest, { versions }, '30.2.0'));
  }
});

test('release bump is patch for fixes, minor for new majors, breaking for lost support', () => {
  assert.equal(nextReleaseVersion('0.1.4'), '0.1.5');
  assert.equal(nextReleaseVersion('0.1.4', { addsSupport: true }), '0.2.0');
  assert.equal(nextReleaseVersion('0.1.4', { dropsSupport: true }), '0.2.0');
  assert.equal(nextReleaseVersion('1.2.3', { dropsSupport: true }), '2.0.0');
  assert.equal(releaseMetadata(packageJson, manifest, manifest, '30.2.0', 30).version, '0.2.0');
  const moved = releaseMetadata(packageJson, manifest, { versions: ['29.7.0', '30.2.0', '31.0.0'] }, '31.0.0', 30);
  assert.match(moved.entry, /minimum guaranteed Jest major is now 29/);
});
