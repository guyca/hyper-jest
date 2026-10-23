import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  compareVersions, eligibleCandidate, GitHubApi, inspectVsix, parseMarker,
  manualCandidate, planManualRelease, planRelease, publishRelease, releaseNotes, reserveRelease, stageArtifact, versionBumpCandidate,
} from './release.mjs';
import { Marketplace } from './release-marketplace.mjs';

const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const mergeSha = 'c'.repeat(40);
const candidate = {
  schemaVersion: 1, prNumber: 30, headSha, mergeSha, baseSha, version: '0.1.1',
  extensionId: 'GuyCarmeli.hyperjest', artifactName: 'hyperjest-0.1.1.vsix',
  tag: 'v0.1.1', ciRunId: 123, ciUrl: 'https://example.test/ci', mergedAt: '2026-10-14T10:00:00Z',
  releaseNotes: '- Fix Jest compatibility.',
};
const pr = {
  number: 30, merged_at: candidate.mergedAt, merge_commit_sha: mergeSha,
  user: { login: 'dependabot[bot]' }, labels: [{ name: 'jest-repair-ready' }],
  head: { sha: headSha, repo: { full_name: 'guyca/hyper-jest' } }, base: { ref: 'master' },
};
const state = { schemaVersion: 1, status: 'ready', prNumber: 30, headSha, baseSha, version: '0.1.1' };
const repairComment = (value = state, login = 'github-actions[bot]') => ({
  user: { login }, body: `Repair status\n<!-- hyperjest-jest-repair:${JSON.stringify(value)} -->`,
});

function fakeApi() {
  let release = null;
  let tag = null;
  let nextAsset = 1;
  const assets = new Map();
  const calls = [];
  return {
    repo: 'guyca/hyper-jest', calls, assets,
    closedPulls: async () => [pr], pull: async () => structuredClone(pr), comments: async () => [repairComment()],
    manifest: async sha => ({ name: 'hyperjest', publisher: 'GuyCarmeli', version: '0.1.1', devDependencies: { jest: sha === baseSha ? '29.7.0' : '30.4.0' } }),
    changelog: async () => '# Changelog\n\n## 0.2.0\n\n- Raise the guaranteed Jest support window.\n\n## 0.1.1\n\n- Fix Jest compatibility.\n',
    successfulCi: async () => ({ id: 123, html_url: candidate.ciUrl }), isOnMaster: async () => true,
    landedBase: async () => baseSha,
    stableReleases: async () => release && !release.draft ? [release] : [],
    isAncestor: async () => true,
    generateNotes: async (tag, sha, previousTag) => {
      calls.push(`notes:${tag}:${sha}:${previousTag}`);
      return { body: '## What changed\n\n- Fix affected-test scheduling (#43).' };
    },
    release: async () => release, tagTarget: async () => tag,
    createTag: async (name, sha) => { calls.push('createTag'); tag = sha; },
    createRelease: async data => { calls.push('createRelease'); release = { ...data, id: 1, assets: [], html_url: 'https://example.test/release' }; return release; },
    updateRelease: async (id, data) => {
      let expectedTag = release.tag_name;
      if (release.draft && release.tag_name?.startsWith('untagged-')) {
        const record = parseMarker(release.body, 'hyperjest-release');
        assert.match(record?.version ?? '', /^\d+\.\d+\.\d+$/, 'An untagged reservation must record its release version');
        expectedTag = `v${record.version}`;
      }
      assert.equal(data.tag_name, expectedTag, 'Every release update must preserve its version tag');
      calls.push(data.draft === false ? 'finalize' : 'updateRelease'); Object.assign(release, data); return release;
    },
    uploadAsset: async (id, name, bytes) => {
      calls.push(`upload:${name}`); const asset = { id: nextAsset++, name, state: 'uploaded' };
      assets.set(asset.id, bytes); release.assets.push(asset); return asset;
    },
    asset: async id => { if (!assets.has(id)) throw new Error('Missing asset'); return assets.get(id); },
    deleteAsset: async id => { calls.push('deleteStarter'); release.assets = release.assets.filter(asset => asset.id !== id); assets.delete(id); },
    setRelease: value => { release = value; }, setTag: value => { tag = value; },
  };
}

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hyperjest-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'build.vsix');
  const packageJson = { name: 'hyperjest', publisher: 'GuyCarmeli', version: '0.1.1', ...overrides };
  execFileSync('python3', ['-c', String.raw`
import json,sys,zipfile
with zipfile.ZipFile(sys.argv[1],'w') as z:
    z.writestr('extension/package.json',sys.argv[2])
    for name in ['dist/extension.js','dist/discoveryWorker.js','dist/worker/hyperjestWorker.cjs','dist/worker/reporter.cjs','dist/worker/overlayPreload.cjs']:
        z.writestr('extension/'+name,'// production bundle\n')
`, source, JSON.stringify(packageJson)]);
  const output = path.join(directory, 'artifact');
  const api = fakeApi();
  const manifest = await stageArtifact(api, candidate, output, source);
  return { directory, source, output, api, manifest };
}

test('release versions and machine markers reject invalid input', () => {
  assert.equal(compareVersions('0.9.9', '0.10.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.throws(() => compareVersions('v1.0.0', '1.0.0'));
  assert.equal(parseMarker('<!-- hyperjest-release:broken -->', 'hyperjest-release'), null);
});

test('release notes come only from the requested version section', () => {
  assert.equal(releaseNotes('# Changelog\n\n## Unreleased\n- Future work\n\n## [0.1.1] - 2026-10-14\n\n- Jest fix\n\n## 0.1.0\n- Older change\n', '0.1.1'), '- Jest fix');
  assert.throws(() => releaseNotes('## Unreleased\n- Future work', '0.1.1'), /no release notes/);
});

test('eligibility binds trusted repair state to an unchanged merged Dependabot PR', async () => {
  const api = fakeApi();
  assert.equal((await eligibleCandidate(api, pr)).mergeSha, mergeSha);
  assert.equal(await eligibleCandidate(api, { ...pr, user: { login: 'someone' } }), null);
  assert.equal(await eligibleCandidate(api, { ...pr, head: { ...pr.head, sha: 'd'.repeat(40) } }), null);
  api.comments = async () => [repairComment(state, 'someone')];
  assert.equal(await eligibleCandidate(api, pr), null);
});

test('a ready label cannot release a non-Jest change or a mismatched manifest', async () => {
  const api = fakeApi();
  api.manifest = async () => ({ name: 'hyperjest', publisher: 'GuyCarmeli', version: '0.1.1', devDependencies: { jest: '29.7.0' } });
  await assert.rejects(eligibleCandidate(api, pr), /does not increase/);
  api.manifest = async sha => ({ name: 'hyperjest', publisher: 'GuyCarmeli', version: '0.1.2', devDependencies: { jest: sha === baseSha ? '29.7.0' : '30.4.0' } });
  await assert.rejects(eligibleCandidate(api, pr), /identity differs/);
});

function manualApi(api = fakeApi()) {
  api.pull = async () => ({ ...structuredClone(pr), user: { login: 'guyca' }, labels: [] });
  api.firstParent = async () => baseSha;
  api.manifest = async sha => ({ name: 'hyperjest', publisher: 'GuyCarmeli', version: sha === baseSha ? '0.1.0' : '0.1.1' });
  return api;
}

test('automatic releases accept stable version increases from merged PRs including forks', async () => {
  const api = manualApi();
  const source = await api.pull();
  api.changelog = async () => assert.fail('Automatic releases do not require a changelog section');
  for (const version of ['0.1.1', '0.2.0', '1.0.0']) {
    api.manifest = async sha => ({ name: 'hyperjest', publisher: 'GuyCarmeli', version: sha === baseSha ? '0.1.0' : version });
    const selected = await versionBumpCandidate(api, { ...source, head: { sha: headSha, repo: { full_name: 'contributor/fork' } } });
    assert.equal(selected.version, version);
    assert.equal(selected.releaseKind, 'automatic');
  }
  const planned = (await planRelease(api)).candidate;
  assert.equal(planned.releaseNotes, undefined);
  assert.equal(api.calls.some(call => call.startsWith('notes:')), false, 'Read-only queue never generates notes');
});

test('automatic eligibility skips unchanged, decreasing, unmerged and non-master PRs', async () => {
  const api = manualApi();
  const source = await api.pull();
  for (const patch of [{ merged_at: null }, { base: { ref: 'feature' } }, { merge_commit_sha: 'invalid' }]) {
    assert.equal(await versionBumpCandidate(api, { ...source, ...patch }), null);
  }
  for (const version of ['0.1.0', '0.0.9']) {
    api.manifest = async sha => ({ name: 'hyperjest', publisher: 'GuyCarmeli', version: sha === baseSha ? '0.1.0' : version });
    assert.equal(await versionBumpCandidate(api, source), null);
  }
  assert.equal((await planRelease(api)).candidate, null);
});

test('automatic eligibility rejects invalid versions and changes to either side of the extension identity', async () => {
  const api = manualApi();
  const source = await api.pull();
  for (const version of ['0.1.1-beta.1', 'v0.1.1', '0.01.1', 'garbage']) {
    api.manifest = async sha => ({ name: 'hyperjest', publisher: 'GuyCarmeli', version: sha === baseSha ? '0.1.0' : version });
    await assert.rejects(versionBumpCandidate(api, source), /invalid stable release version/);
  }
  for (const changed of [baseSha, mergeSha]) {
    api.manifest = async sha => ({ name: sha === changed ? 'other' : 'hyperjest', publisher: 'GuyCarmeli', version: sha === baseSha ? '0.1.0' : '0.1.1' });
    await assert.rejects(versionBumpCandidate(api, source), /extension identity/);
  }
});

test('automatic queue waits for exact landed CI and rejects sources outside master', async () => {
  const api = manualApi();
  api.successfulCi = async sha => { assert.equal(sha, mergeSha); return null; };
  const waiting = await planRelease(api);
  assert.equal(waiting.candidate, null);
  assert.match(waiting.reason, /exact merged commit/);
  api.successfulCi = async () => ({ id: 123, html_url: candidate.ciUrl });
  api.isOnMaster = async () => false;
  await assert.rejects(planRelease(api), /no longer on master/);
});

test('automatic queue orders bumps, rejects duplicate versions, and skips historical releases', async () => {
  const api = manualApi();
  const source = await api.pull();
  const laterSha = 'd'.repeat(40);
  const newer = { ...source, number: 31, merge_commit_sha: laterSha, merged_at: '2026-10-14T11:00:00Z' };
  api.closedPulls = async () => [newer, source];
  api.pull = async number => number === source.number ? source : newer;
  api.manifest = async sha => ({ name: 'hyperjest', publisher: 'GuyCarmeli', version: sha === baseSha ? '0.1.0' : sha === mergeSha ? '0.1.1' : '0.2.0' });
  const first = await planRelease(api);
  assert.equal(first.candidate.prNumber, source.number);
  assert.equal(first.remaining, 1);
  assert.equal((await planRelease(api)).candidate.mergeSha, first.candidate.mergeSha);
  api.manifest = async sha => ({ name: 'hyperjest', publisher: 'GuyCarmeli', version: sha === baseSha ? '0.1.0' : '0.1.1' });
  await assert.rejects(planRelease(api), /same version/);
  api.stableReleases = async () => [{ tag_name: 'v0.2.0', draft: false }];
  assert.equal((await planRelease(api)).candidate, null);
});

test('GitHub adapter identifies landed ranges for merge, squash and multi-commit rebase PRs', async () => {
  const earlySha = 'd'.repeat(40);
  for (const strategy of ['merge', 'squash', 'rebase']) {
    const api = new GitHubApi('guyca/hyper-jest', 'test-token', async url => {
      const resource = new URL(url).pathname;
      if (resource.endsWith(`/git/commits/${mergeSha}`)) return Response.json({ parents: strategy === 'merge'
        ? [{ sha: baseSha }, { sha: headSha }] : [{ sha: strategy === 'rebase' ? earlySha : baseSha }] });
      if (resource.endsWith(`/commits/${earlySha}/pulls`)) return Response.json([{ number: pr.number, merged_at: pr.merged_at }]);
      if (resource.endsWith(`/git/commits/${earlySha}`)) return Response.json({ parents: [{ sha: baseSha }] });
      if (resource.endsWith(`/commits/${baseSha}/pulls`)) return Response.json([{ number: 29, merged_at: pr.merged_at }]);
      assert.fail(`Unexpected GitHub request: ${resource}`);
    });
    assert.equal(await api.landedBase(pr), baseSha, strategy);
    api.manifest = async sha => ({ name: 'hyperjest', publisher: 'GuyCarmeli', version: sha === baseSha ? '0.1.0' : '0.1.1' });
    assert.equal((await versionBumpCandidate(api, pr)).baseSha, baseSha);
  }
  const api = new GitHubApi('guyca/hyper-jest', 'test-token', async () => Response.json({ parents: [] }));
  await assert.rejects(api.landedBase(pr), /landed PR parent/);
});

test('GitHub adapter selects published stable releases and sends explicit note boundaries', async () => {
  const requests = [];
  const api = new GitHubApi('guyca/hyper-jest', 'test-token', async (url, options) => {
    requests.push({ url, options });
    return Response.json(options.method === 'POST' ? { body: 'Generated notes' } : [
      { tag_name: 'v0.9.0' }, { tag_name: 'v0.10.0' }, { tag_name: 'v0.11.0', draft: true },
      { tag_name: 'v1.0.0', prerelease: true }, { tag_name: 'v2.0.0-beta.1' }, { tag_name: 'other' },
    ]);
  });
  assert.deepEqual((await api.stableReleases()).map(release => release.tag_name), ['v0.10.0', 'v0.9.0']);
  await api.generateNotes('v0.11.0', mergeSha, 'v0.10.0');
  assert.deepEqual(JSON.parse(requests.at(-1).options.body), { tag_name: 'v0.11.0', target_commitish: mergeSha, previous_tag_name: 'v0.10.0' });
  assert.equal(requests.at(-1).options.method, 'POST');
  await api.generateNotes('v0.1.0', mergeSha, null);
  assert.equal(Object.hasOwn(JSON.parse(requests.at(-1).options.body), 'previous_tag_name'), false);
});

async function automaticFixture(t) {
  const result = await fixture(t);
  const api = manualApi(result.api);
  const pull = api.pull;
  api.pull = async number => {
    const source = await pull(number);
    return { ...source, head: { ...source.head, repo: { full_name: 'contributor/fork' } } };
  };
  const selected = (await planRelease(api)).candidate;
  const manifest = await stageArtifact(api, selected, result.output, result.source);
  api.changelog = async () => assert.fail('Automatic releases do not read CHANGELOG.md');
  return { ...result, api, selected, manifest };
}

test('automatic publication retains generated notes and baseline before authentication, then reuses both on retry', async t => {
  const { api, selected, output, source, directory, manifest } = await automaticFixture(t);
  api.stableReleases = async () => [{ tag_name: 'v0.1.0', draft: false }];
  const originalTarget = api.tagTarget;
  api.tagTarget = async tag => tag === 'v0.1.0' ? baseSha : originalTarget(tag);
  api.isAncestor = async (base, head) => { assert.equal(base, baseSha); assert.equal(head, mergeSha); return true; };
  api.generateNotes = async (tag, sha, previousTag) => {
    assert.equal(tag, selected.tag);
    assert.equal(sha, mergeSha);
    assert.equal(previousTag, 'v0.1.0');
    assert.ok(api.calls.includes(`upload:${selected.artifactName}`));
    return { body: '## Changes\n\n- Earlier fix (#42).\n- Version bump (#43). <!-- user text -->' };
  };
  const { release } = await reserveRelease(api, selected, output);
  const record = parseMarker(release.body, 'hyperjest-release');
  assert.equal(record.generatedNotes.previousTag, 'v0.1.0');
  assert.match(release.body, /Earlier fix/);
  assert.equal(release.draft, true);
  await rm(source);
  await rm(output, { recursive: true });
  api.generateNotes = async () => assert.fail('Retries must not regenerate notes');
  const retry = (await planRelease(api)).candidate;
  const manualRetry = (await planManualRelease(api, pr.number)).candidate;
  assert.equal(manualRetry.releaseKind, 'automatic');
  assert.deepEqual(manualRetry.generatedNotes, retry.generatedNotes);
  const restored = path.join(directory, 'automatic-retry');
  await stageArtifact(api, retry, restored, '/missing-original-build');
  let publishes = 0;
  await publishRelease(api, {
    version: async () => null, latestVersion: async () => '0.1.0', publish: async () => { publishes++; },
    verify: async (_, actual) => assert.equal(actual.sha256, manifest.sha256),
  }, retry, restored);
  assert.equal(publishes, 1);
  const published = await api.release(selected.tag);
  assert.equal(published.draft, false);
  assert.deepEqual(parseMarker(published.body, 'hyperjest-release').generatedNotes, record.generatedNotes);
  assert.equal((await planRelease(api)).candidate, null);
});

test('note-generation failures retain the exact package and can resume through release_pr', async t => {
  const { api, selected, output, source, directory } = await automaticFixture(t);
  api.generateNotes = async () => { throw new Error('GitHub notes service unavailable'); };
  let publishes = 0;
  const marketplace = { version: async () => null, latestVersion: async () => null, publish: async () => { publishes++; }, verify: async () => {} };
  await assert.rejects(publishRelease(api, marketplace, selected, output), /notes service unavailable/);
  assert.equal(publishes, 0);
  const reserved = await api.release(selected.tag);
  assert.ok(parseMarker(reserved.body, 'hyperjest-release').sha256);
  assert.equal(reserved.assets.length, 3);
  await rm(source);
  const retry = (await planManualRelease(api, pr.number)).candidate;
  assert.equal(retry.releaseKind, 'automatic');
  const restored = path.join(directory, 'notes-retry');
  await stageArtifact(api, retry, restored, '/missing-original');
  api.generateNotes = async () => ({ body: 'Recovered notes' });
  await publishRelease(api, marketplace, retry, restored);
  assert.equal(publishes, 1);
  assert.equal((await api.release(selected.tag)).draft, false);
});

test('automatic publication failure reuses frozen notes and never republishes an existing Marketplace version', async t => {
  const { api, selected, output } = await automaticFixture(t);
  let publishes = 0;
  const marketplace = {
    version: async () => publishes ? { version: selected.version } : null,
    latestVersion: async () => publishes ? selected.version : null,
    publish: async () => { publishes++; }, verify: async () => { throw new Error('Verification pending'); },
  };
  await assert.rejects(publishRelease(api, marketplace, selected, output), /Verification pending/);
  api.generateNotes = async () => assert.fail('Notes are already reserved');
  const retry = (await planManualRelease(api, pr.number)).candidate;
  marketplace.verify = async () => {};
  await publishRelease(api, marketplace, retry, output);
  assert.equal(publishes, 1);
});

test('automatic reservations reject corrupt notes and unrelated previous release tags', async t => {
  const { api, selected, output } = await automaticFixture(t);
  api.stableReleases = async () => [{ tag_name: 'v0.1.0' }];
  const originalTarget = api.tagTarget;
  api.tagTarget = async tag => tag === 'v0.1.0' ? baseSha : originalTarget(tag);
  api.isAncestor = async () => false;
  await assert.rejects(reserveRelease(api, selected, output), /not an ancestor/);
  api.isAncestor = async () => true;
  await reserveRelease(api, selected, output);
  const release = await api.release(selected.tag);
  const record = parseMarker(release.body, 'hyperjest-release');
  record.generatedNotes.sha256 = '0'.repeat(64);
  release.body = `<!-- hyperjest-release:${JSON.stringify(record)} -->`;
  await assert.rejects(planRelease(api), /notes fail their reserved checksum/);
  await assert.rejects(reserveRelease(api, selected, output), /notes fail their reserved checksum/);
});

test('manual release accepts an explicitly selected merged version bump without repair metadata', async () => {
  const api = manualApi();
  const { candidate: selected } = await planManualRelease(api, pr.number);
  assert.equal(selected.releaseKind, 'manual');
  assert.equal(selected.mergeSha, mergeSha);
  assert.equal(selected.ciRunId, 123);
  assert.equal((await planRelease(api)).candidate.releaseKind, 'automatic');
});

test('manual release rejects unmerged, foreign, wrong-base and unchanged-version PRs', async () => {
  const api = manualApi();
  const source = await api.pull();
  for (const patch of [
    { merged_at: null }, { base: { ref: 'other' } },
    { head: { ...source.head, repo: { full_name: 'other/repo' } } },
  ]) await assert.rejects(manualCandidate(api, { ...source, ...patch }), /merged PR/);
  api.manifest = async () => ({ name: 'hyperjest', publisher: 'GuyCarmeli', version: '0.1.1' });
  await assert.rejects(planManualRelease(api, pr.number), /must increase/);
});

test('manual release requires successful exact-source master CI, ancestry and changelog', async () => {
  const api = manualApi();
  api.successfulCi = async () => null;
  await assert.rejects(planManualRelease(api, pr.number), /successful push CI/);
  api.successfulCi = async () => ({ id: 123, html_url: candidate.ciUrl });
  api.isOnMaster = async () => false;
  await assert.rejects(planManualRelease(api, pr.number), /master ancestry/);
  api.isOnMaster = async () => true;
  api.changelog = async () => '## Unreleased\n- Future work';
  await assert.rejects(planManualRelease(api, pr.number), /no release notes/);
});

test('manual release retains its original VSIX across authentication failure and retry', async t => {
  const { api: originalApi, output, directory, source, manifest } = await fixture(t);
  const api = manualApi(originalApi);
  const selected = (await planManualRelease(api, pr.number)).candidate;
  await stageArtifact(api, selected, output, source);
  await reserveRelease(api, selected, output);
  assert.match((await api.release(selected.tag)).body, /Release from #30/);
  const automaticRetry = (await planRelease(api)).candidate;
  assert.equal(automaticRetry.releaseKind, 'manual', 'The automatic queue preserves legacy manual reservations');
  assert.equal(automaticRetry.existingAssetId, (await api.release(selected.tag)).assets.find(asset => asset.name === selected.artifactName).id);
  await rm(source);
  const retry = (await planManualRelease(api, pr.number)).candidate;
  const restored = path.join(directory, 'manual-retry');
  await stageArtifact(api, retry, restored, '/missing-build');
  let publishes = 0;
  await publishRelease(api, {
    version: async () => null, latestVersion: async () => null,
    publish: async () => { publishes++; },
    verify: async (_, actual) => assert.equal(actual.sha256, manifest.sha256),
  }, retry, restored);
  assert.equal(publishes, 1);
  assert.equal((await api.release(selected.tag)).draft, false);
  assert.equal((await planManualRelease(api, pr.number)).candidate, null);
});

test('manual reservation cannot be resumed through automatic repair eligibility', async t => {
  const { api: originalApi, output, source } = await fixture(t);
  const api = manualApi(originalApi);
  const selected = (await planManualRelease(api, pr.number)).candidate;
  await stageArtifact(api, selected, output, source);
  await reserveRelease(api, selected, output);
  await assert.rejects(reserveRelease(api, candidate, output), /conflicts/);
});

test('manual CLI selection requires an explicit dispatch on master and rejects mixed inputs', () => {
  for (const environment of [
    { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REF: 'refs/heads/master' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/other' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/master', REQUESTED_PR: '30' },
  ]) {
    assert.throws(() => execFileSync(process.execPath, ['.github/scripts/jest-automation/release.mjs', 'plan', '/unused'], {
      env: { ...process.env, GH_TOKEN: 'test-token', GITHUB_REPOSITORY: 'guyca/hyper-jest', REQUESTED_PR: '', REQUESTED_RELEASE_PR: '30', ...environment },
      stdio: 'pipe',
    }), error => /explicit workflow_dispatch on master without pr_number/.test(error.stdout.toString()));
  }
});

test('GitHub adapter selects the merge parent and rejects a parentless source', async () => {
  const api = new GitHubApi('guyca/hyper-jest', 'test-token', async () => Response.json({ parents: [{ sha: baseSha }, { sha: headSha }] }));
  assert.equal(await api.firstParent(mergeSha), baseSha);
  api.fetcher = async () => Response.json({ parents: [] });
  await assert.rejects(api.firstParent(mergeSha), /merge parent/);
});

test('queue orders all merged repairs and waits for exact-source CI', async () => {
  const api = fakeApi();
  const laterSha = 'd'.repeat(40);
  const newer = { ...pr, number: 31, merge_commit_sha: laterSha, merged_at: '2026-10-14T11:00:00Z' };
  api.closedPulls = async () => [newer, pr];
  api.pull = async number => number === 30 ? pr : newer;
  api.comments = async number => [repairComment({ ...state, prNumber: number, version: number === 30 ? '0.1.1' : '0.2.0' })];
  api.manifest = async sha => ({ name: 'hyperjest', publisher: 'GuyCarmeli', version: sha === laterSha ? '0.2.0' : '0.1.1', devDependencies: { jest: sha === baseSha ? '29.7.0' : '30.4.0' } });
  const plan = await planRelease(api, 31);
  assert.equal(plan.candidate.prNumber, 30);
  assert.equal(plan.remaining, 1);
  api.successfulCi = async () => null;
  const waiting = await planRelease(api);
  assert.equal(waiting.candidate, null);
  assert.match(waiting.reason, /exact merged commit/);
  await assert.rejects(planRelease(api, 99), /not a merged/);
});

test('draft reservations must match source and immutable tag', async () => {
  const api = fakeApi();
  api.setRelease({ draft: true, assets: [], body: `<!-- hyperjest-release:${JSON.stringify({ ...candidate, mergeSha: 'd'.repeat(40) })} -->` });
  await assert.rejects(planRelease(api), /conflicts/);
  api.setRelease({ draft: true, assets: [], body: `<!-- hyperjest-release:${JSON.stringify(candidate)} -->` });
  api.setTag('d'.repeat(40));
  await assert.rejects(planRelease(api), /another commit/);
});

test('a completed release is removed from the queue without losing later work', async t => {
  const { api, output } = await fixture(t);
  await publishRelease(api, { version: async () => null, latestVersion: async () => null, publish: async () => {}, verify: async () => {} }, candidate, output);
  const plan = await planRelease(api);
  assert.equal(plan.candidate, null);
  assert.match(plan.reason, /already been released/);
});

test('later merged repair is selected after its predecessor was published', async t => {
  const { api, output } = await fixture(t);
  await publishRelease(api, { version: async () => null, latestVersion: async () => null, publish: async () => {}, verify: async () => {} }, candidate, output);
  const previousRelease = await api.release(candidate.tag);
  const laterSha = 'd'.repeat(40);
  const newer = { ...pr, number: 31, merge_commit_sha: laterSha, merged_at: '2026-10-14T11:00:00Z' };
  api.closedPulls = async () => [newer, pr];
  api.pull = async number => number === 30 ? pr : newer;
  api.comments = async number => [repairComment({ ...state, prNumber: number, version: number === 30 ? '0.1.1' : '0.2.0' })];
  api.manifest = async sha => ({ name: 'hyperjest', publisher: 'GuyCarmeli', version: sha === laterSha ? '0.2.0' : '0.1.1', devDependencies: { jest: sha === baseSha ? '29.7.0' : '30.4.0' } });
  api.release = async tag => tag === candidate.tag ? previousRelease : null;
  const plan = await planRelease(api);
  assert.equal(plan.candidate.prNumber, 31);
  assert.equal(plan.candidate.version, '0.2.0');
});

test('two repaired PRs reserving the same version cannot overwrite a published release', async t => {
  const { api, output } = await fixture(t);
  await publishRelease(api, { version: async () => null, latestVersion: async () => null, publish: async () => {}, verify: async () => {} }, candidate, output);
  const newer = { ...pr, number: 31, merge_commit_sha: 'd'.repeat(40), merged_at: '2026-10-14T11:00:00Z' };
  api.closedPulls = async () => [newer, pr];
  api.pull = async number => number === 30 ? pr : newer;
  api.comments = async number => [repairComment({ ...state, prNumber: number })];
  await assert.rejects(planRelease(api), /conflicts with PR #31/);
  assert.equal(api.calls.filter(call => call === 'finalize').length, 1);
});

test('publication reserves the original VSIX before Marketplace and finalizes last', async t => {
  const { api, output, manifest } = await fixture(t);
  let published = false;
  const marketplace = {
    version: async () => null, latestVersion: async () => null,
    publish: async file => { assert.ok(api.calls.includes('upload:release-manifest.json')); assert.equal(path.basename(file), candidate.artifactName); published = true; },
    verify: async (release, actual) => { assert.equal(published, true); assert.equal(actual.sha256, manifest.sha256); assert.equal(api.calls.includes('finalize'), false); },
  };
  const result = await publishRelease(api, marketplace, candidate, output);
  assert.equal(result.alreadyReleased, false);
  assert.equal(api.calls.at(-1), 'finalize');
  const publishedRelease = await api.release(candidate.tag);
  assert.equal(parseMarker(publishedRelease.body, 'hyperjest-release').sha256, manifest.sha256);
});

test('reservation before authentication retains bytes without publishing and a later run resumes them', async t => {
  const { api, output, directory, source, manifest } = await fixture(t);
  const original = await readFile(source);
  const reserved = await reserveRelease(api, candidate, output);
  assert.equal(reserved.release.draft, true);
  assert.equal(await api.tagTarget(candidate.tag), candidate.mergeSha);
  assert.equal(parseMarker(reserved.release.body, 'hyperjest-release').sha256, manifest.sha256);
  assert.equal(api.calls.includes('finalize'), false);

  // A failed login can end this runner after reservation. A new runner must use
  // the draft attachment even when the original build and Actions artifact are gone.
  await rm(source);
  await rm(output, { recursive: true });
  const planned = (await planRelease(api)).candidate;
  assert.ok(planned.existingAssetId);
  const restored = path.join(directory, 'after-authentication-retry');
  await stageArtifact(api, planned, restored, '/nonexistent-build.vsix');
  let publishCalls = 0;
  await publishRelease(api, {
    version: async () => null, latestVersion: async () => null,
    publish: async filename => { publishCalls++; assert.deepEqual(await readFile(filename), original); },
    verify: async (_, actual) => assert.equal(actual.sha256, manifest.sha256),
  }, planned, restored);
  assert.equal(publishCalls, 1);
  assert.equal(api.calls.filter(call => call === `upload:${candidate.artifactName}`).length, 1);
  assert.equal((await api.release(candidate.tag)).draft, false);
});

test('untagged draft recovery reuses the original release and VSIX through finalization', async t => {
  const { api, output, directory, source, manifest } = await fixture(t);
  const original = await readFile(source);
  const { release: reservation } = await reserveRelease(api, candidate, output);
  const originalAssetIds = reservation.assets.map(asset => asset.id);
  reservation.tag_name = 'untagged-original';
  await rm(source);
  await rm(output, { recursive: true });

  // Exercise the real adapter's untagged-draft lookup during planning and
  // reservation, with all writes still handled by the in-memory GitHub API.
  const storedRelease = api.release;
  const lookup = new GitHubApi(api.repo, 'test-token', async url => {
    const release = await storedRelease();
    if (String(url).includes('/releases/tags/')) return release.draft
      ? new Response('', { status: 404 }) : Response.json(release);
    return Response.json([release]);
  });
  api.release = tag => lookup.release(tag);
  const planned = (await planRelease(api)).candidate;
  assert.equal(planned.existingAssetId, reservation.assets.find(asset => asset.name === candidate.artifactName).id);
  const restored = path.join(directory, 'restored-untagged');
  await stageArtifact(api, planned, restored, '/nonexistent-build.vsix');
  let publishCalls = 0;
  await publishRelease(api, {
    version: async () => null, latestVersion: async () => null,
    publish: async filename => {
      publishCalls++;
      assert.deepEqual(await readFile(filename), original);
      const draft = await api.release(candidate.tag);
      assert.equal(draft.id, reservation.id);
      assert.equal(draft.tag_name, candidate.tag);
      assert.equal(draft.draft, true);
    },
    verify: async (_, actual) => assert.equal(actual.sha256, manifest.sha256),
  }, planned, restored);
  const published = await api.release(candidate.tag);
  assert.equal(published.id, reservation.id);
  assert.equal(published.tag_name, candidate.tag);
  assert.equal(published.draft, false);
  assert.deepEqual(published.assets.map(asset => asset.id), originalAssetIds);
  assert.equal(await api.tagTarget(candidate.tag), candidate.mergeSha);
  assert.equal(publishCalls, 1);
  assert.equal(api.calls.filter(call => call === 'createRelease').length, 1);
  assert.equal(api.calls.filter(call => call === `upload:${candidate.artifactName}`).length, 1);
});

test('release test API rejects omitted or conflicting version tags during recovery and after assignment', async t => {
  const { api, output } = await fixture(t);
  const { release } = await reserveRelease(api, candidate, output);
  for (const currentTag of ['untagged-original', candidate.tag]) {
    release.tag_name = currentTag;
    for (const data of [{ body: 'Omitted tag' }, { tag_name: 'v9.9.9' }]) {
      await assert.rejects(api.updateRelease(release.id, data), /preserve its version tag/);
      assert.equal(release.tag_name, currentTag);
    }
  }
});

test('retry after Marketplace success reuses draft bytes and never publishes twice', async t => {
  const { api, output, directory, manifest } = await fixture(t);
  let publishCalls = 0;
  const marketplace = {
    version: async () => publishCalls ? { version: candidate.version } : null,
    latestVersion: async () => publishCalls ? candidate.version : null,
    publish: async () => { publishCalls++; }, verify: async () => { throw new Error('Validation still pending'); },
  };
  await assert.rejects(publishRelease(api, marketplace, candidate, output), /Validation still pending/);
  const plan = await planRelease(api);
  assert.ok(plan.candidate.existingAssetId);
  const restored = path.join(directory, 'restored');
  const retained = await stageArtifact(api, plan.candidate, restored, '/nonexistent-build.vsix');
  assert.equal(retained.sha256, manifest.sha256);
  marketplace.verify = async () => {};
  await publishRelease(api, marketplace, plan.candidate, restored);
  assert.equal(publishCalls, 1);
  assert.equal((await api.release(candidate.tag)).draft, false);
});

test('deleting both retained VSIX and metadata cannot erase a draft artifact reservation', async t => {
  const { api, output } = await fixture(t);
  const market = {
    version: async () => null, latestVersion: async () => null, publish: async () => {},
    verify: async () => { throw new Error('Validation still pending'); },
  };
  await assert.rejects(publishRelease(api, market, candidate, output), /Validation still pending/);
  const release = await api.release(candidate.tag);
  release.assets = release.assets.filter(asset => asset.name === 'SHA256SUMS');
  const previousBody = release.body;
  await assert.rejects(planRelease(api), /lost its reserved VSIX/);
  await assert.rejects(publishRelease(api, market, candidate, output), /lost its reserved VSIX/);
  assert.equal(release.body, previousBody);
});

test('draft body checksums still bind retained and staged artifacts when metadata is missing', async t => {
  const { api, output, directory } = await fixture(t);
  const market = {
    version: async () => null, latestVersion: async () => null, publish: async () => {},
    verify: async () => { throw new Error('Validation still pending'); },
  };
  await assert.rejects(publishRelease(api, market, candidate, output), /Validation still pending/);
  const release = await api.release(candidate.tag);
  release.assets = release.assets.filter(asset => asset.name !== 'release-manifest.json');
  const changed = await fixture(t, { displayName: 'Changed after reservation' });
  const packageAsset = release.assets.find(asset => asset.name === candidate.artifactName);
  api.assets.set(packageAsset.id, await readFile(changed.source));
  const plan = await planRelease(api);
  await assert.rejects(stageArtifact(api, plan.candidate, path.join(directory, 'restored'), '/unused'), /reserved checksum/);
  await assert.rejects(publishRelease(api, market, candidate, changed.output), /reserved checksum/);
  assert.equal(release.draft, true);
});

test('interrupted metadata upload recovers existing VSIX and replaces only a starter asset', async t => {
  const { api, output } = await fixture(t);
  const realUpload = api.uploadAsset;
  let interrupt = true;
  api.uploadAsset = async (id, name, bytes) => {
    if (name === 'release-manifest.json' && interrupt) {
      (await api.release(candidate.tag)).assets.push({ id: 999, name, state: 'starter' });
      interrupt = false;
      throw new Error('Upload interrupted');
    }
    return realUpload(id, name, bytes);
  };
  const market = { version: async () => null, latestVersion: async () => null, publish: async () => {}, verify: async () => {} };
  await assert.rejects(publishRelease(api, market, candidate, output), /Upload interrupted/);
  const plan = await planRelease(api);
  assert.ok(plan.candidate.existingAssetId);
  assert.equal(plan.candidate.existingManifestId, null);
  await publishRelease(api, market, candidate, output);
  assert.ok(api.calls.includes('deleteStarter'));
});

test('collisions and checksums prevent publication and do not move tags', async t => {
  const { api, output } = await fixture(t);
  let publishCalls = 0;
  const market = { version: async () => null, latestVersion: async () => null, publish: async () => { publishCalls++; }, verify: async () => {} };
  api.setTag('d'.repeat(40));
  await assert.rejects(publishRelease(api, market, candidate, output), /another commit/);
  assert.equal(publishCalls, 0);
  api.setTag(null);
  const json = JSON.parse(await readFile(path.join(output, 'release-manifest.json'), 'utf8'));
  json.sha256 = '0'.repeat(64);
  await writeFile(path.join(output, 'release-manifest.json'), JSON.stringify(json));
  await assert.rejects(publishRelease(api, market, candidate, output), /checksum mismatch/);
  assert.equal(api.calls.includes('createTag'), false);
});

test('same Marketplace version with different content remains a draft and blocks the queue', async t => {
  const { api, output } = await fixture(t);
  let published = false;
  await assert.rejects(publishRelease(api, {
    version: async () => ({ version: candidate.version }), latestVersion: async () => candidate.version,
    publish: async () => { published = true; }, verify: async () => { throw new Error('Different content'); },
  }, candidate, output), /Different content/);
  assert.equal(published, false);
  assert.equal((await api.release(candidate.tag)).draft, true);
});

test('published VSIX payload is verified despite packaging metadata changes', async t => {
  const { source, directory, manifest } = await fixture(t);
  const signed = path.join(directory, 'marketplace-signed.vsix');
  execFileSync('python3', ['-c', String.raw`
import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as old, zipfile.ZipFile(sys.argv[2],'w',compression=zipfile.ZIP_DEFLATED) as new:
    for name in reversed(old.namelist()): new.writestr(name,old.read(name))
    new.writestr('extension.signature.p7s','marketplace signature')
`, source, signed]);
  const fetched = await readFile(signed);
  let waits = 0;
  const marketplace = new Marketplace({ directory, wait: async () => { waits++; }, fetcher: async url => {
    if (String(url).includes('extensionquery')) return new Response(JSON.stringify({ results: [{ extensions: [{ publisher: { publisherName: 'GuyCarmeli' }, extensionName: 'hyperjest', versions: [
      { version: candidate.version, files: [{ assetType: 'Microsoft.VisualStudio.Services.VSIXPackage', source: 'https://guyc.gallery.vsassets.io/package' }] },
    ] }] }] }), { status: 200 });
    return new Response(fetched, { status: 200 });
  } });
  await marketplace.verify(candidate, manifest);
  assert.equal(waits, 0);
  await assert.rejects(marketplace.verify(candidate, { ...manifest, payloadHash: 'invalid' }), /different extension files/);
});

test('publisher invokes the executable VSCE wrapper with Azure auth and the retained package', async () => {
  let invocation;
  const marketplace = new Marketplace({ directory: '/unused', runner: async (...args) => { invocation = args; return { stdout: '' }; } });
  await marketplace.publish('/retained/package.vsix');
  assert.equal(invocation[0], process.execPath);
  assert.equal(invocation[1][0], path.resolve('node_modules/@vscode/vsce/vsce'));
  assert.deepEqual(invocation[1].slice(1), ['publish', '--azure-credential', '--packagePath', '/retained/package.vsix']);
  assert.equal(invocation[2].env.GH_TOKEN, undefined);
  assert.equal(invocation[2].env.GITHUB_TOKEN, undefined);
});

test('installed pinned VSCE executable actually runs its CLI', async t => {
  const executable = path.resolve('node_modules/@vscode/vsce/vsce');
  try { await access(executable); } catch { return t.skip('Project dependencies are not installed.'); }
  const version = execFileSync(process.execPath, [executable, '--version'], { encoding: 'utf8' }).trim();
  const pkg = JSON.parse(await readFile(path.resolve('node_modules/@vscode/vsce/package.json'), 'utf8'));
  assert.equal(version, pkg.version);
});

test('slow Marketplace queries consume the deadline and leave the original release draft for retry', async t => {
  const { api, output, directory } = await fixture(t);
  let elapsed = 0;
  let queries = 0;
  const marketplace = new Marketplace({ directory, now: () => elapsed,
    wait: async milliseconds => { elapsed += milliseconds; },
    fetcher: async () => { queries++; elapsed += 10_000; return Response.json({ results: [] }); },
  });
  marketplace.version = async () => ({ version: candidate.version });
  marketplace.latestVersion = async () => candidate.version;
  await assert.rejects(publishRelease(api, marketplace, candidate, output), /verification.*eight minutes/);
  assert.equal(elapsed, 8 * 60_000);
  assert.equal(queries, 24);
  assert.equal((await api.release(candidate.tag)).draft, true);
  assert.equal(api.calls.includes('finalize'), false);
  assert.ok((await planRelease(api)).candidate.existingAssetId);
});

test('Marketplace polling sleeps only until the remaining deadline', async () => {
  let elapsed = 0;
  const waits = [];
  const marketplace = new Marketplace({ directory: '/unused', now: () => elapsed,
    wait: async milliseconds => { waits.push(milliseconds); elapsed += milliseconds; },
    fetcher: async () => { elapsed = 475_000; return Response.json({ results: [] }); },
  });
  await assert.rejects(marketplace.verify(candidate, {}), /verification.*eight minutes/);
  assert.equal(elapsed, 480_000);
  assert.deepEqual(waits, [5000]);
});

test('Marketplace downloads share the polling deadline and cannot succeed after expiry', async t => {
  let elapsed = 0;
  const timeouts = [];
  let downloads = 0;
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    timeouts.push(milliseconds);
    return new AbortController().signal;
  });
  const marketplace = new Marketplace({ directory: '/unused', now: () => elapsed,
    wait: async () => assert.fail('Expired downloads must not retry'),
    fetcher: async url => {
      if (String(url).includes('extensionquery')) {
        elapsed = 450_000;
        return Response.json({ results: [{ extensions: [{ publisher: { publisherName: 'GuyCarmeli' }, extensionName: 'hyperjest',
          versions: [{ version: candidate.version, assetUri: 'https://guyc.gallery.vsassets.io/package' }],
        }] }] });
      }
      downloads++;
      return { status: 200, ok: true, arrayBuffer: async () => { elapsed += 30_000; return new ArrayBuffer(0); } };
    },
  });
  await assert.rejects(marketplace.verify(candidate, {}), /verification.*eight minutes/);
  assert.equal(elapsed, 480_000);
  assert.equal(downloads, 1);
  assert.deepEqual(timeouts, [60_000, 30_000]);
});

test('Marketplace validation can complete after the original three-minute window', async t => {
  const { source, directory, manifest } = await fixture(t);
  const bytes = await readFile(source);
  let waits = 0;
  let elapsed = 0;
  const marketplace = new Marketplace({ directory, now: () => elapsed, wait: async milliseconds => { waits++; elapsed += milliseconds; }, fetcher: async url => {
    if (!String(url).includes('extensionquery')) return new Response(bytes);
    return Response.json({ results: [{ extensions: [{ publisher: { publisherName: 'GuyCarmeli' }, extensionName: 'hyperjest',
      versions: waits < 24 ? [] : [{ version: candidate.version, assetUri: 'https://guyc.gallery.vsassets.io/package' }],
    }] }] });
  } });
  await marketplace.verify(candidate, manifest);
  assert.equal(waits, 24);
  assert.equal(elapsed, 240_000);
});

test('GitHub adapter accepts only successful native CI on the exact master commit', async () => {
  const api = new GitHubApi('guyca/hyper-jest', 'test-token', async () => new Response(JSON.stringify({ workflow_runs: [
    { head_sha: mergeSha, head_branch: 'master', event: 'workflow_dispatch', conclusion: 'success' },
    { head_sha: 'd'.repeat(40), head_branch: 'master', event: 'push', conclusion: 'success' },
    { id: 123, head_sha: mergeSha, head_branch: 'master', event: 'push', conclusion: 'success' },
  ] })));
  assert.equal((await api.successfulCi(mergeSha)).id, 123);
});

test('GitHub release lookup recovers a draft omitted by the published tag endpoint', async () => {
  const draft = { tag_name: 'v0.1.1', draft: true };
  const api = new GitHubApi('guyca/hyper-jest', 'test-token', async url => String(url).includes('/releases/tags/')
    ? new Response('', { status: 404 }) : new Response(JSON.stringify([draft])));
  assert.deepEqual(await api.release('v0.1.1'), draft);
});

test('GitHub release lookup recovers the oldest untagged reservation by release identity', async () => {
  const draft = { id: 10, tag_name: 'untagged-original', draft: true, body: `<!-- hyperjest-release:${JSON.stringify(candidate)} -->` };
  const newer = { ...draft, id: 20, tag_name: 'untagged-duplicate' };
  const unrelated = { ...draft, id: 1, body: `<!-- hyperjest-release:${JSON.stringify({ ...candidate, extensionId: 'other.extension' })} -->` };
  const api = new GitHubApi('guyca/hyper-jest', 'test-token', async url => String(url).includes('/releases/tags/')
    ? new Response('', { status: 404 }) : Response.json([newer, unrelated, draft]));
  assert.deepEqual(await api.release(candidate.tag), draft);
  assert.equal(await api.release('v0.2.0'), null);
});

test('Marketplace version queries retry transient failures and keep validation flags', async () => {
  let calls = 0;
  const marketplace = new Marketplace({ directory: '/unused', wait: async () => {}, fetcher: async (url, options) => {
    calls++;
    assert.equal(options.method, 'POST');
    assert.ok(JSON.parse(options.body).flags & 32);
    if (calls === 1) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    if (calls === 2) return new Response('', { status: 503 });
    return Response.json({ results: [] });
  } });
  assert.deepEqual(await marketplace.versions(true), []);
  assert.equal(calls, 3);
});

test('VSIX identity and unpacked contents are checked without running extension code', async t => {
  const { source, manifest } = await fixture(t);
  assert.equal((await inspectVsix(source, candidate)).sha256, manifest.sha256);
  await assert.rejects(inspectVsix(source, { ...candidate, version: '0.1.2' }), /manifest does not match/);
});
