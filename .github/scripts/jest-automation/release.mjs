import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseRequest } from './release-http.mjs';

export const REPAIR_LABEL = 'jest-repair-ready';
export const RELEASE_MARKER = 'hyperjest-release';
export const EXTENSION_ID = 'GuyCarmeli.hyperjest';
const BOT = 'github-actions[bot]';
const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const HASH = /^[a-f0-9]{64}$/;
const IDENTITY_FIELDS = ['schemaVersion', 'prNumber', 'headSha', 'mergeSha', 'version', 'extensionId', 'artifactName', 'releaseKind'];

export function compareVersions(a, b) {
  if (!VERSION.test(a) || !VERSION.test(b)) throw new Error('Release versions must be stable major.minor.patch values.');
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}

export function parseMarker(body, marker) {
  const prefix = `<!-- ${marker}:`;
  const start = body?.indexOf(prefix) ?? -1;
  if (start < 0) return null;
  const end = body.indexOf('-->', start);
  if (end < 0) return null;
  try { return JSON.parse(body.slice(start + prefix.length, end).trim()); } catch { return null; }
}

export function releaseNotes(changelog, version) {
  if (!VERSION.test(version)) throw new Error('Invalid changelog release version.');
  const escaped = version.replaceAll('.', '\\.');
  const heading = new RegExp(`^##[ \\t]+\\[?${escaped}\\]?(?:[ \\t]+.*)?\\r?$`, 'm');
  const match = heading.exec(changelog);
  if (!match) throw new Error(`CHANGELOG.md has no release notes for ${version}.`);
  const rest = changelog.slice(match.index + match[0].length);
  const nextHeading = /^##[ \t]+/m.exec(rest);
  const notes = rest.slice(0, nextHeading?.index ?? rest.length).trim();
  if (!notes) throw new Error(`CHANGELOG.md has empty release notes for ${version}.`);
  return notes;
}

function identity(candidate) {
  return Object.fromEntries(IDENTITY_FIELDS.map(key => [key, candidate[key]]));
}

export function assertIdentity(actual, expected, description = 'Release') {
  if (!actual || IDENTITY_FIELDS.some(key => actual[key] !== expected[key])) {
    throw new Error(`${description} conflicts with PR #${expected.prNumber}, version ${expected.version}, source ${expected.mergeSha}. Refusing to replace it.`);
  }
}

function reservedHashes(record) {
  if (record.sha256 === undefined && record.payloadHash === undefined) return null;
  if (!HASH.test(record.sha256) || !HASH.test(record.payloadHash)) throw new Error('Invalid reserved artifact checksums.');
  return { sha256: record.sha256, payloadHash: record.payloadHash };
}

function assertArtifactHashes(actual, reserved) {
  if (reserved && (reserved.sha256 !== actual.sha256 || reserved.payloadHash !== actual.payloadHash)) {
    throw new Error('Retained VSIX fails its reserved checksum.');
  }
}

export async function eligibleCandidate(api, pr) {
  if (!pr.merged_at || pr.user?.login !== 'dependabot[bot]' || pr.base?.ref !== 'master' ||
      pr.head?.repo?.full_name !== api.repo || !pr.labels?.some(label => label.name === REPAIR_LABEL)) return null;
  const comments = await api.comments(pr.number);
  const states = comments.filter(comment => comment.user?.login === BOT)
    .map(comment => parseMarker(comment.body, 'hyperjest-jest-repair')).filter(Boolean);
  const state = states.findLast(item => item.schemaVersion === 1 && item.status === 'ready' && item.prNumber === pr.number);
  // A human or Dependabot may have changed the PR after the repair was validated.
  if (!state || state.headSha !== pr.head.sha) return null;
  if (!SHA.test(state.headSha) || !SHA.test(state.baseSha) || !SHA.test(pr.merge_commit_sha) || !VERSION.test(state.version)) {
    throw new Error(`Invalid release identity on PR #${pr.number}.`);
  }
  const [base, merged] = await Promise.all([api.manifest(state.baseSha), api.manifest(pr.merge_commit_sha)]);
  const previousJest = base.devDependencies?.jest;
  const nextJest = merged.devDependencies?.jest;
  if (!VERSION.test(previousJest) || !VERSION.test(nextJest) || compareVersions(nextJest, previousJest) <= 0) {
    throw new Error(`PR #${pr.number} is marked ready but does not increase the root Jest dependency.`);
  }
  if (merged.version !== state.version || `${merged.publisher}.${merged.name}` !== EXTENSION_ID) {
    throw new Error(`PR #${pr.number}'s merged extension identity differs from its validated repair.`);
  }
  return {
    schemaVersion: 1, prNumber: pr.number, headSha: state.headSha, mergeSha: pr.merge_commit_sha,
    version: merged.version, extensionId: EXTENSION_ID, artifactName: `hyperjest-${merged.version}.vsix`,
    mergedAt: pr.merged_at, baseSha: state.baseSha, tag: `v${merged.version}`,
  };
}

export async function manualCandidate(api, pr) {
  if (!pr.merged_at || pr.base?.ref !== 'master' || pr.head?.repo?.full_name !== api.repo ||
      !SHA.test(pr.head?.sha) || !SHA.test(pr.merge_commit_sha)) {
    throw new Error('Manual releases require a merged PR from this repository targeting master.');
  }
  const baseSha = await api.firstParent(pr.merge_commit_sha);
  const [base, merged] = await Promise.all([api.manifest(baseSha), api.manifest(pr.merge_commit_sha)]);
  if (`${merged.publisher}.${merged.name}` !== EXTENSION_ID || compareVersions(merged.version, base.version) <= 0) {
    throw new Error('Manual release PR must increase the HyperJest version over its merge parent.');
  }
  return {
    schemaVersion: 1, releaseKind: 'manual', prNumber: pr.number, headSha: pr.head.sha,
    mergeSha: pr.merge_commit_sha, baseSha, version: merged.version, extensionId: EXTENSION_ID,
    artifactName: `hyperjest-${merged.version}.vsix`, mergedAt: pr.merged_at, tag: `v${merged.version}`,
  };
}

async function restoreReservation(api, candidate) {
  const release = await api.release(candidate.tag);
  if (!release) return true;
  const record = parseMarker(release.body, RELEASE_MARKER);
  assertIdentity(record, candidate);
  await assertTag(api, candidate);
  if (!release.draft) return false;
  candidate.reservedHashes = reservedHashes(record);
  const packageAsset = release.assets?.find(asset => asset.name === candidate.artifactName && asset.state === 'uploaded');
  const manifestAsset = release.assets?.find(asset => asset.name === 'release-manifest.json' && asset.state === 'uploaded');
  if ((manifestAsset || candidate.reservedHashes) && !packageAsset) throw new Error(`${candidate.tag} lost its reserved VSIX. Restore it; rebuilding would change the reserved artifact.`);
  candidate.existingAssetId = packageAsset?.id ?? null;
  candidate.existingManifestId = manifestAsset?.id ?? null;
  return true;
}

export async function planManualRelease(api, requestedPr) {
  const candidate = await manualCandidate(api, await api.pull(requestedPr));
  if (!(await restoreReservation(api, candidate))) return { candidate: null, reason: `${candidate.tag} has already been released.` };
  const ci = await api.successfulCi(candidate.mergeSha);
  if (!ci || !(await api.isOnMaster(candidate.mergeSha))) {
    throw new Error('Manual release requires successful push CI on the exact merged commit and master ancestry. Retry after CI passes.');
  }
  candidate.ciRunId = ci.id;
  candidate.ciUrl = ci.html_url;
  candidate.releaseNotes = releaseNotes(await api.changelog(candidate.mergeSha), candidate.version);
  return { candidate, remaining: 0 };
}

export async function planRelease(api, requestedPr = null) {
  const candidates = [];
  for (const listed of await api.closedPulls()) {
    if (!listed.merged_at || listed.user?.login !== 'dependabot[bot]' || !listed.labels?.some(label => label.name === REPAIR_LABEL)) continue;
    const candidate = await eligibleCandidate(api, await api.pull(listed.number));
    if (candidate) candidates.push(candidate);
  }
  candidates.sort((a, b) => a.mergedAt.localeCompare(b.mergedAt) || a.prNumber - b.prNumber);
  if (requestedPr && !candidates.some(candidate => candidate.prNumber === requestedPr)) {
    throw new Error(`PR #${requestedPr} is not a merged, validated Jest repair eligible for automatic release.`);
  }
  const pending = [];
  for (const candidate of candidates) {
    if (!(await restoreReservation(api, candidate))) continue;
    pending.push(candidate);
  }
  if (!pending.length) return { candidate: null, reason: 'All eligible merged Jest repairs have already been released.' };
  const candidate = pending[0];
  const ci = await api.successfulCi(candidate.mergeSha);
  if (!ci) return {
    candidate: null,
    reason: `Release queue is waiting for successful CI (push to master) on PR #${candidate.prNumber}'s exact merged commit ${candidate.mergeSha}. Rerun that commit's CI if it failed or was cancelled.`,
  };
  if (!(await api.isOnMaster(candidate.mergeSha))) throw new Error(`Release source ${candidate.mergeSha} is no longer on master.`);
  candidate.ciRunId = ci.id;
  candidate.ciUrl = ci.html_url;
  candidate.releaseNotes = releaseNotes(await api.changelog(candidate.mergeSha), candidate.version);
  return { candidate, remaining: pending.length - 1 };
}

async function assertTag(api, candidate, allowMissing = false) {
  const target = await api.tagTarget(candidate.tag);
  if (target && target !== candidate.mergeSha) throw new Error(`Tag ${candidate.tag} points to another commit; tags are never moved by this workflow.`);
  if (!target && !allowMissing) throw new Error(`Reserved tag ${candidate.tag} is missing.`);
  return target;
}

export function sha256(buffer) { return createHash('sha256').update(buffer).digest('hex'); }

// Python's standard library avoids executing package code while inspecting a VSIX.
// Marketplace signing may change ZIP metadata; payloadHash covers every extension file.
const INSPECT_ZIP = String.raw`
import hashlib,json,pathlib,sys,zipfile
p=sys.argv[1]
with zipfile.ZipFile(p) as z:
    items=z.infolist()
    names=[i.filename for i in items]
    if len(names)!=len(set(names)) or len(names)>10000 or sum(i.file_size for i in items)>536870912:
        raise ValueError('Duplicate entries or oversized VSIX')
    for name in names:
        if '\\' in name or name.startswith('/') or '..' in pathlib.PurePosixPath(name).parts:
            raise ValueError('Unsafe VSIX path')
    files=sorted(n for n in names if n.startswith('extension/') and not n.endswith('/'))
    required=['package.json','dist/extension.js','dist/discoveryWorker.js','dist/worker/hyperjestWorker.cjs','dist/worker/reporter.cjs','dist/worker/overlayPreload.cjs']
    if any('extension/'+n not in files for n in required): raise ValueError('Missing production bundle')
    if any(n.startswith(('extension/node_modules/','extension/src/','extension/tests/','extension/scripts/','extension/coverage/','extension/.github/scripts/','extension/.github/workflows/')) for n in files):
        raise ValueError('Development files found in VSIX')
    manifest=json.loads(z.read('extension/package.json'))
    digest=hashlib.sha256()
    for name in files:
        digest.update(name.encode()+b'\0'+hashlib.sha256(z.read(name)).digest())
    print(json.dumps({'name':manifest['name'],'publisher':manifest['publisher'],'version':manifest['version'],'payloadHash':digest.hexdigest(),'files':files}))
`;

export async function inspectVsix(filename, candidate) {
  const output = execFileSync('python3', ['-c', INSPECT_ZIP, filename], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const info = JSON.parse(output);
  if (`${info.publisher}.${info.name}` !== candidate.extensionId || info.version !== candidate.version) {
    throw new Error('The VSIX manifest does not match the reserved extension version.');
  }
  const bytes = await readFile(filename);
  return { ...identity(candidate), sha256: sha256(bytes), payloadHash: info.payloadHash, bytes: bytes.length };
}

export async function stageArtifact(api, candidate, directory, builtFile) {
  await mkdir(directory, { recursive: true });
  const filename = path.join(directory, candidate.artifactName);
  if (candidate.existingAssetId) await writeFile(filename, await api.asset(candidate.existingAssetId));
  else await writeFile(filename, await readFile(builtFile));
  const manifest = await inspectVsix(filename, candidate);
  assertArtifactHashes(manifest, candidate.reservedHashes);
  if (candidate.existingManifestId) {
    const previous = JSON.parse((await api.asset(candidate.existingManifestId)).toString());
    assertIdentity(previous, candidate, 'Retained release artifact');
    assertArtifactHashes(manifest, previous);
  }
  await writeFile(path.join(directory, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(directory, 'SHA256SUMS'), `${manifest.sha256}  ${candidate.artifactName}\n`);
  return manifest;
}

function releaseBody(candidate, manifest = null) {
  return `<!-- ${RELEASE_MARKER}:${JSON.stringify({ ...identity(candidate), ...(manifest ? { sha256: manifest.sha256, payloadHash: manifest.payloadHash } : {}) })} -->\n\n` +
    `${candidate.releaseNotes}\n\n` +
    `${candidate.releaseKind === 'manual' ? 'Release' : 'Jest compatibility repair'} from #${candidate.prNumber}.\n\n` +
    `Built from commit \`${candidate.mergeSha}\` after [CI passed](${candidate.ciUrl}).\n\n` +
    `Install the attached \`${candidate.artifactName}\` or update **HyperJest** from the VS Code Marketplace.`;
}

export async function reserveRelease(api, candidate, directory) {
  // Re-read mutable eligibility before reserving or resuming an immutable artifact.
  const pr = await api.pull(candidate.prNumber);
  const fresh = candidate.releaseKind === 'manual' ? await manualCandidate(api, pr) : await eligibleCandidate(api, pr);
  assertIdentity(fresh, candidate, 'Current PR eligibility');
  if (!(await api.successfulCi(candidate.mergeSha)) || !(await api.isOnMaster(candidate.mergeSha))) {
    throw new Error('Release source no longer has the required successful master CI or ancestry.');
  }
  const notes = releaseNotes(await api.changelog(candidate.mergeSha), candidate.version);
  if (notes !== candidate.releaseNotes) throw new Error('Release notes do not match the exact merged source.');
  const filename = path.join(directory, candidate.artifactName);
  const manifest = await inspectVsix(filename, candidate);
  const stagedManifest = JSON.parse(await readFile(path.join(directory, 'release-manifest.json'), 'utf8'));
  assertIdentity(stagedManifest, candidate, 'Staged artifact');
  if (manifest.sha256 !== stagedManifest.sha256 || manifest.payloadHash !== stagedManifest.payloadHash) throw new Error('Staged artifact checksum mismatch.');
  const existingTarget = await assertTag(api, candidate, true);
  let release = await api.release(candidate.tag);
  if (release) {
    const record = parseMarker(release.body, RELEASE_MARKER);
    assertIdentity(record, candidate);
    const reserved = reservedHashes(record);
    assertArtifactHashes(manifest, reserved);
    if (reserved && !release.assets?.some(asset => asset.name === candidate.artifactName && asset.state === 'uploaded')) {
      throw new Error(`${candidate.tag} lost its reserved VSIX. Restore the retained artifact before retrying.`);
    }
  }
  if (!existingTarget) {
    await api.createTag(candidate.tag, candidate.mergeSha);
    await assertTag(api, candidate);
  }
  if (!release) release = await api.createRelease({
    tag_name: candidate.tag, target_commitish: candidate.mergeSha, name: `HyperJest ${candidate.version}`,
    draft: true, prerelease: false, body: releaseBody(candidate),
  });
  for (const name of [candidate.artifactName, 'release-manifest.json', 'SHA256SUMS']) {
    const bytes = await readFile(path.join(directory, name));
    const asset = release.assets?.find(item => item.name === name);
    if (asset?.state === 'uploaded') {
      if (sha256(await api.asset(asset.id)) !== sha256(bytes)) throw new Error(`Existing ${candidate.tag}/${name} differs from the reserved artifact.`);
    } else {
      // GitHub leaves a zero-byte starter asset after interrupted uploads.
      if (asset) {
        if (asset.state !== 'starter') throw new Error(`Unexpected asset state for ${name}.`);
        await api.deleteAsset(asset.id);
      }
      await api.uploadAsset(release.id, name, bytes);
    }
  }
  if (release.draft) release = await api.updateRelease(release.id, { tag_name: candidate.tag, body: releaseBody(candidate, manifest) });
  return { release, filename, manifest };
}

export async function publishRelease(api, marketplace, candidate, directory) {
  // Revalidate the reservation immediately before Marketplace side effects, even
  // when a preceding workflow step already retained it before authentication.
  let { release, filename, manifest } = await reserveRelease(api, candidate, directory);
  if (!release.draft) return { url: release.html_url, alreadyReleased: true };
  let version = await marketplace.version(candidate.version);
  const latest = await marketplace.latestVersion();
  if (latest && compareVersions(latest, candidate.version) > 0) throw new Error(`Marketplace already has ${latest}; refusing to finalize older version ${candidate.version} as the latest release.`);
  if (!version) {
    if (latest && compareVersions(latest, candidate.version) >= 0) throw new Error(`Marketplace already has ${latest}; refusing to publish older version ${candidate.version}.`);
    try { await marketplace.publish(filename); }
    catch (error) {
      // A previous request may have succeeded even when its response was lost.
      version = await marketplace.version(candidate.version);
      if (!version) throw error;
    }
  }
  await marketplace.verify(candidate, manifest);
  await assertTag(api, candidate);
  release = await api.updateRelease(release.id, { tag_name: candidate.tag, draft: false, make_latest: 'true', body: releaseBody(candidate, manifest) });
  return { url: release.html_url, alreadyReleased: false };
}

export class GitHubApi {
  constructor(repo, token, fetcher = fetch, wait = undefined) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('Invalid GITHUB_REPOSITORY.');
    if (!token) throw new Error('GH_TOKEN is required.');
    this.repo = repo; this.token = token; this.fetcher = fetcher; this.wait = wait;
  }
  async request(resource, { method = 'GET', data, binary = false, missing = false, upload = false } = {}) {
    const host = upload ? 'https://uploads.github.com' : 'https://api.github.com';
    return releaseRequest(`${host}/repos/${this.repo}/${resource}`, {
      method, headers: {
        Authorization: `Bearer ${this.token}`, Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(data ? { 'Content-Type': Buffer.isBuffer(data) ? 'application/octet-stream' : 'application/json' } : {}),
      }, body: data ? (Buffer.isBuffer(data) ? data : JSON.stringify(data)) : undefined,
    }, {
      label: `GitHub ${method} ${resource.split('?')[0]}`, fetcher: this.fetcher, wait: this.wait,
      retry: method === 'GET', missing,
      decode: async response => binary ? Buffer.from(await response.arrayBuffer()) : response.json(),
    });
  }
  async pages(resource, field = null) {
    const items = [];
    for (let page = 1; ; page++) {
      const result = await this.request(`${resource}${resource.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const batch = field ? result[field] : result;
      items.push(...batch);
      if (batch.length < 100) return items;
    }
  }
  closedPulls() { return this.pages('pulls?state=closed&sort=updated&direction=desc'); }
  pull(number) { return this.request(`pulls/${number}`); }
  async firstParent(sha) {
    const commit = await this.request(`git/commits/${sha}`);
    const parent = commit.parents?.[0]?.sha;
    if (!SHA.test(parent)) throw new Error('Release source must have a merge parent.');
    return parent;
  }
  comments(number) { return this.pages(`issues/${number}/comments`); }
  async manifest(ref) {
    const file = await this.request(`contents/package.json?ref=${encodeURIComponent(ref)}`);
    return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  }
  async changelog(ref) {
    const file = await this.request(`contents/CHANGELOG.md?ref=${encodeURIComponent(ref)}`);
    return Buffer.from(file.content, 'base64').toString('utf8');
  }
  async release(tag) {
    const published = await this.request(`releases/tags/${encodeURIComponent(tag)}`, { missing: true });
    // The tag endpoint is documented for published releases. Authenticated lists
    // also include drafts, including a reservation made by an interrupted run.
    if (published) return published;
    const releases = await this.pages('releases');
    const tagged = releases.find(release => release.tag_name === tag);
    if (tagged) return tagged;
    // Earlier body-only draft updates lost tag_name on GitHub. Recover the
    // oldest reservation by its machine marker; callers still validate its
    // complete source identity, tag target, and artifact checksums.
    const drafts = releases.filter(release => {
      const record = parseMarker(release.body, RELEASE_MARKER);
      return release.draft && release.tag_name?.startsWith('untagged-') &&
        record?.schemaVersion === 1 && record.extensionId === EXTENSION_ID && `v${record.version}` === tag;
    }).sort((a, b) => a.id - b.id);
    return drafts[0] ?? null;
  }
  async tagTarget(tag) {
    let object = (await this.request(`git/ref/tags/${encodeURIComponent(tag)}`, { missing: true }))?.object;
    for (let depth = 0; object?.type === 'tag' && depth < 5; depth++) object = (await this.request(`git/tags/${object.sha}`)).object;
    if (object && object.type !== 'commit') throw new Error(`Unsupported tag object for ${tag}.`);
    return object?.sha ?? null;
  }
  createTag(tag, sha) { return this.request('git/refs', { method: 'POST', data: { ref: `refs/tags/${tag}`, sha } }); }
  async successfulCi(sha) {
    const runs = await this.pages(`actions/workflows/ci.yml/runs?event=push&head_sha=${sha}`, 'workflow_runs');
    return runs.find(run => run.head_sha === sha && run.head_branch === 'master' && run.event === 'push' && run.conclusion === 'success');
  }
  async isOnMaster(sha) {
    const comparison = await this.request(`compare/${sha}...master`);
    return comparison.status === 'ahead' || comparison.status === 'identical';
  }
  createRelease(data) { return this.request('releases', { method: 'POST', data }); }
  updateRelease(id, data) { return this.request(`releases/${id}`, { method: 'PATCH', data }); }
  asset(id) { return this.request(`releases/assets/${id}`, { binary: true }); }
  deleteAsset(id) { return this.request(`releases/assets/${id}`, { method: 'DELETE' }); }
  uploadAsset(id, name, bytes) { return this.request(`releases/${id}/assets?name=${encodeURIComponent(name)}`, { method: 'POST', data: bytes, upload: true }); }
  dispatch() { return this.request('actions/workflows/release.yml/dispatches', { method: 'POST', data: { ref: 'master' } }); }
  async report(number, body) {
    const marker = '<!-- hyperjest-release-status -->';
    const previous = (await this.comments(number)).find(comment => comment.user?.login === BOT && comment.body?.includes(marker));
    return this.request(previous ? `issues/comments/${previous.id}` : `issues/${number}/comments`, {
      method: previous ? 'PATCH' : 'POST', data: { body: `${marker}\n${body}` },
    });
  }
}

async function appendOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, { flag: 'a' });
}
async function summary(text) {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, `${text}\n`, { flag: 'a' });
}

async function main() {
  const [command, candidateFile, directory, builtFile] = process.argv.slice(2);
  const api = new GitHubApi(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN);
  if (command === 'plan') {
    const input = process.env.REQUESTED_PR;
    const manualInput = process.env.REQUESTED_RELEASE_PR;
    if (input && !/^[1-9]\d*$/.test(input)) throw new Error('pr_number must be a positive integer.');
    if (manualInput && !/^[1-9]\d*$/.test(manualInput)) throw new Error('release_pr must be a positive integer.');
    if (manualInput && (input || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || process.env.GITHUB_REF !== 'refs/heads/master')) {
      throw new Error('release_pr requires an explicit workflow_dispatch on master without pr_number.');
    }
    const result = manualInput ? await planManualRelease(api, Number(manualInput)) : await planRelease(api, input ? Number(input) : null);
    await appendOutput('ready', Boolean(result.candidate));
    if (!result.candidate) return summary(result.reason);
    const candidate = result.candidate;
    await writeFile(candidateFile, `${JSON.stringify(candidate, null, 2)}\n`);
    for (const [key, value] of Object.entries({ pr: candidate.prNumber, sha: candidate.mergeSha, version: candidate.version, reuse: Boolean(candidate.existingAssetId) })) await appendOutput(key, value);
    return summary(`Queued PR #${candidate.prNumber}: ${candidate.tag}, source ${candidate.mergeSha}. ${result.remaining} subsequent release(s) remain; every run rescans the durable queue.`);
  }
  const candidate = JSON.parse(await readFile(candidateFile, 'utf8'));
  if (command === 'stage') return stageArtifact(api, candidate, directory, builtFile);
  if (command === 'reserve') {
    const { release } = await reserveRelease(api, candidate, directory);
    return summary(`Retained ${candidate.tag} and its exact VSIX in ${release.html_url}. Marketplace publication has not been attempted by this step.`);
  }
  if (command === 'publish') {
    const { Marketplace } = await import('./release-marketplace.mjs');
    const result = await publishRelease(api, new Marketplace({ directory }), candidate, directory);
    return summary(`Published ${candidate.tag}: ${result.url}`);
  }
  if (command === 'report') {
    const runUrl = `https://github.com/${api.repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;
    const success = process.env.RELEASE_RESULT === 'success';
    if (candidate.releaseKind === 'manual') return summary(success
      ? `Released ${candidate.tag}. [Workflow](${runUrl}).`
      : `Manual release of ${candidate.tag} did not complete. Retry release_pr=${candidate.prNumber} after resolving the failure; the reserved VSIX is retained. [Workflow](${runUrl}).`);
    try {
      await api.report(candidate.prNumber, success
        ? `Released **${candidate.tag}** to [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=${EXTENSION_ID}) and [GitHub Releases](https://github.com/${api.repo}/releases/tag/${candidate.tag}). [Workflow](${runUrl}).`
        : `Automatic release of **${candidate.tag}** did not complete. [Inspect this workflow](${runUrl}) and retry it after resolving the failure. Any reserved tag, draft release, and VSIX are retained for an idempotent retry.`);
    } finally {
      // A transient comment failure must not strand later queued releases.
      if (success) await api.dispatch();
    }
    return;
  }
  throw new Error(`Unknown release command: ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async error => { await summary(`Release stopped: ${error.message}`); process.exitCode = 1; });
}
