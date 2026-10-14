import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  compareVersions, eligibleCandidate, GitHubApi, inspectVsix, parseMarker,
  planRelease, publishRelease, releaseNotes, reserveRelease, stageArtifact,
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
    release: async () => release, tagTarget: async () => tag,
    createTag: async (name, sha) => { calls.push('createTag'); tag = sha; },
    createRelease: async data => { calls.push('createRelease'); release = { ...data, id: 1, assets: [], html_url: 'https://example.test/release' }; return release; },
    updateRelease: async (id, data) => { calls.push(data.draft === false ? 'finalize' : 'updateRelease'); Object.assign(release, data); return release; },
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

test('queue orders all merged repairs and waits for exact-source CI', async () => {
  const api = fakeApi();
  const newer = { ...pr, number: 31, merged_at: '2026-10-14T11:00:00Z' };
  api.closedPulls = async () => [newer, pr];
  api.pull = async number => number === 30 ? pr : newer;
  api.comments = async number => [repairComment({ ...state, prNumber: number })];
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

test('Marketplace validation timeout never finalizes a release', async () => {
  let waits = 0;
  const marketplace = new Marketplace({ directory: '/unused', wait: async () => { waits++; }, fetcher: async () => new Response(JSON.stringify({ results: [] })) });
  await assert.rejects(marketplace.verify(candidate, { payloadHash: 'unused' }), /not finished validating/);
  assert.equal(waits, 17);
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

test('VSIX identity and unpacked contents are checked without running extension code', async t => {
  const { source, manifest } = await fixture(t);
  assert.equal((await inspectVsix(source, candidate)).sha256, manifest.sha256);
  await assert.rejects(inspectVsix(source, { ...candidate, version: '0.1.2' }), /manifest does not match/);
});
