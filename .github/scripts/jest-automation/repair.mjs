import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ASSIGNEE, READY_LABEL, assertCompatibility, assertEligiblePr, assertFresh, assertJestUpgrade,
  assertAgentPaths, assertPackagePreserved, decideAttempt, formatState, parseState, releaseMetadata, rootJest,
} from './repair-policy.mjs';

const repository = process.env.GITHUB_REPOSITORY;
const apiRoot = process.env.GITHUB_API_URL ?? 'https://api.github.com';
const candidate = resolve(process.env.CANDIDATE_DIR ?? 'candidate');
const prNumber = Number(process.env.PR_NUMBER);
const headSha = process.env.PR_HEAD_SHA;
const baseSha = process.env.MASTER_SHA;
const output = (name, value) => {
  assert(!String(value).includes('\n'), 'Invalid workflow output');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
};
const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', candidate, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const file = (ref, path) => git('show', `${ref}:${path}`);
const jsonFile = (ref, path) => JSON.parse(file(ref, path));
const readJson = path => JSON.parse(readFileSync(resolve(candidate, path), 'utf8'));

async function api(path, method = 'GET', data) {
  const response = await fetch(`${apiRoot}/repos/${repository}/${path}`, {
    method,
    headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${path}: ${response.status}`);
  return response.status === 204 ? undefined : response.json();
}

async function pages(path) {
  const all = [];
  for (let page = 1; ; page++) {
    const batch = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

async function remoteJson(ref, path) {
  const blob = await api(`contents/${path}?ref=${encodeURIComponent(ref)}`);
  return JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'));
}

async function stateFor(number) {
  const comments = await pages(`issues/${number}/comments`);
  const matches = comments.map(comment => ({ comment, state: parseState(comment) })).filter(entry => entry.state);
  assert(matches.length <= 1, 'Multiple repair state comments; refusing ambiguous automation state');
  return matches[0] ?? { state: { schemaVersion: 1, prNumber: number, attempts: [] } };
}

async function saveState(number, current, state, message) {
  const body = formatState(state, message);
  if (current.comment) await api(`issues/comments/${current.comment.id}`, 'PATCH', { body });
  else await api(`issues/${number}/comments`, 'POST', { body });
}

async function removeReady(number) {
  const labels = await pages(`issues/${number}/labels`);
  if (labels.some(label => label.name === READY_LABEL)) await api(`issues/${number}/labels/${READY_LABEL}`, 'DELETE');
}

async function assign(number) {
  await api(`issues/${number}/assignees`, 'POST', { assignees: [ASSIGNEE] });
}

async function inspect() {
  output('repair', 'false');
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const manual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  let run;
  let number = Number(event.inputs?.pr_number);
  if (!manual) {
    run = event.workflow_run;
    if (run?.name !== 'CI' || run.event !== 'pull_request' || run.head_repository?.full_name !== repository) return;
    const workflow = await api(`actions/workflows/${run.workflow_id}`);
    if (workflow.path !== '.github/workflows/ci.yml') return;
    const prs = await pages(`commits/${run.head_sha}/pulls`);
    const eligible = prs.filter(pr => pr.state === 'open' && pr.user.login === 'dependabot[bot]' && pr.head.sha === run.head_sha && pr.base.ref === 'master' && pr.head.repo?.full_name === repository);
    if (eligible.length !== 1) return;
    number = eligible[0].number;
  }
  assert(Number.isSafeInteger(number) && number > 0, 'A positive PR number is required');
  const pr = await api(`pulls/${number}`);
  assertEligiblePr(pr, repository);
  const master = (await api('git/ref/heads/master')).object.sha;
  const before = await remoteJson(master, 'package.json');
  const proposed = await remoteJson(pr.head.sha, 'package.json');
  assertJestUpgrade(before, proposed);
  const current = await stateFor(number);
  output('pr_number', number);
  output('head_sha', pr.head.sha);
  output('base_sha', master);
  output('branch', pr.head.ref);
  if (!manual && pr.head.sha !== run.head_sha) return;

  // Check the latest CI run, not an obsolete completion notification for this SHA.
  const runs = await api(`actions/workflows/ci.yml/runs?event=pull_request&head_sha=${pr.head.sha}&per_page=100`);
  const latest = runs.workflow_runs.filter(item => item.head_sha === pr.head.sha).sort((a, b) => b.id - a.id)[0];
  if (!latest || latest.status !== 'completed') return;
  if (!manual && latest.id !== run.id) return;
  const pendingRefresh = current.state.operation?.kind === 'metadata' && current.state.operation.status !== 'pushed';
  const refresh = manual && current.state.attempts.length > 0 && latest.conclusion === 'success' &&
    (current.state.headSha !== pr.head.sha || current.state.baseSha !== master || current.state.status === 'stale' || pendingRefresh);
  if (latest.conclusion === 'success' && !refresh) {
    if (!['pushed', 'ready'].includes(current.state.status)) return;
    if (current.state.headSha !== pr.head.sha || current.state.baseSha !== master) {
      await removeReady(number);
      await saveState(number, current, { ...current.state, status: 'stale' }, 'CI passed, but the PR head or master changed since the repair. Rerun the repair workflow manually to refresh release metadata and validate before release.');
      await assign(number);
      return;
    }
    assert.equal(proposed.version, current.state.version);
    await saveState(number, current, { ...current.state, status: 'ready', ciRunId: latest.id }, `Repair passed CI at ${pr.head.sha}. Ready for @${ASSIGNEE} to review and merge; version ${proposed.version} will be released after merge.`);
    const labels = await pages('labels');
    if (!labels.some(label => label.name === READY_LABEL)) await api('labels', 'POST', { name: READY_LABEL, color: '0e8a16', description: 'Jest repair passed CI and is eligible for automatic release' });
    await api(`issues/${number}/labels`, 'POST', { labels: [READY_LABEL] });
    await assign(number);
    return;
  }
  if (!refresh && !['failure', 'timed_out'].includes(latest.conclusion)) return;
  // Refreshes only regenerate trusted release metadata and rerun validation;
  // no agent runs, so they neither consume nor require an agent attempt.
  const decision = refresh ? 'repair' : decideAttempt({ state: current.state, headSha: pr.head.sha, manual });
  if (decision !== 'repair') {
    if (decision === 'exhausted') {
      await removeReady(number);
      await saveState(number, current, { ...current.state, status: 'exhausted' }, 'The two automatic repair attempts are exhausted. Manual investigation is required.');
      await assign(number);
    }
    return;
  }
  if (process.env.REPAIR_CONFIGURED !== 'true') {
    await saveState(number, current, { ...current.state, status: 'setup_required' }, 'Automatic repair is waiting for CURSOR_API_KEY, REPAIR_APP_ID, and REPAIR_APP_PRIVATE_KEY to be configured. No repair attempt has been consumed.');
    await assign(number);
    return;
  }
  // First-time automatic repairs must originate from a dependency-only PR.
  if (!current.state.attempts.length) {
    const files = await pages(`pulls/${number}/files`);
    assert(files.every(entry => ['package.json', 'yarn.lock'].includes(entry.filename)), 'Initial Dependabot PR includes non-dependency changes');
    const comparison = await api(`compare/${master}...${pr.head.sha}`);
    const original = await remoteJson(comparison.merge_base_commit.sha, 'package.json');
    assertJestUpgrade(original, proposed);
    assertPackagePreserved(original, proposed);
  }
  const jobs = await api(`actions/runs/${latest.id}/jobs?per_page=100`);
  const failures = jobs.jobs.filter(job => ['failure', 'timed_out'].includes(job.conclusion)).map(job => `${job.name}: ${job.conclusion}; ${job.html_url}; failing steps: ${job.steps.filter(step => step.conclusion === 'failure').map(step => step.name).join(', ')}`);
  writeFileSync(process.env.CONTEXT_PATH, JSON.stringify({ prNumber: number, headSha: pr.head.sha, baseSha: master, jest: rootJest(proposed), failures }, null, 2));
  await removeReady(number);
  const operation = { kind: refresh ? 'metadata' : 'repair', headSha: pr.head.sha, runId: process.env.GITHUB_RUN_ID, status: 'running' };
  const attempts = refresh ? current.state.attempts : [...current.state.attempts, { headSha: pr.head.sha, runId: operation.runId, status: 'running' }];
  const state = { ...current.state, status: 'repairing', originalHeadSha: current.state.originalHeadSha ?? pr.head.sha, operation, attempts };
  await saveState(number, current, state, refresh
    ? `Release metadata refresh is running for ${pr.head.sha}; no agent attempt is consumed.`
    : `Repair attempt ${state.attempts.length}/2 is running for ${pr.head.sha}.`);
  await assign(number);
  output('repair', 'true');
  output('metadata_only', refresh ? 'true' : 'false');
}

function prepare() {
  assert.match(headSha, /^[a-f0-9]{40}$/);
  assert.match(baseSha, /^[a-f0-9]{40}$/);
  assert.equal(git('rev-parse', 'HEAD').trim(), headSha);
  git('config', 'user.name', 'github-actions[bot]');
  git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
  git('merge', '--no-ff', '--no-edit', baseSha);
  output('merged_sha', git('rev-parse', 'HEAD').trim());
}

function changes(ref = 'HEAD') {
  const fields = git('diff', '--cached', '--name-status', '--no-renames', '-z', ref).split('\0').filter(Boolean);
  const result = [];
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index];
    const path = fields[index + 1];
    const mode = status === 'D' ? undefined : git('ls-files', '--stage', '--', path).split(' ')[0];
    result.push({ status, path, mode });
  }
  return result;
}

function applyPatch({ finalized = false } = {}) {
  const patch = resolve(process.env.PATCH_PATH);
  const patchSize = readFileSync(patch).length;
  assert(patchSize < 5 * 1024 * 1024, 'Repair patch exceeds 5 MiB');
  if (patchSize || process.env.ALLOW_EMPTY_REPAIR !== 'true') {
    git('apply', '--check', '--index', patch);
    git('apply', '--index', patch);
  }
  const touched = changes();
  const agentChanges = finalized ? touched.filter(change => change.path !== 'CHANGELOG.md') : touched;
  if (agentChanges.length || process.env.ALLOW_EMPTY_REPAIR !== 'true') assertAgentPaths(agentChanges);
  for (const change of agentChanges) {
    const match = change.path.match(/^scripts\/jest-compatibility\/(\d+\.\d+\.\d+)\/(package(?:-lock)?\.json)$/);
    if (!match) continue;
    assert.notEqual(change.status, 'D', 'Pinned compatibility installations cannot be deleted');
    const fixture = readJson(change.path);
    if (match[2] === 'package.json') {
      assert.equal(fixture.private, true);
      assert.equal(fixture.scripts, undefined, 'Fixture scripts are forbidden');
      assert.deepEqual(fixture.dependencies, { jest: match[1] });
      assert(Object.keys(fixture).every(key => ['name', 'version', 'private', 'dependencies'].includes(key)), 'Unexpected compatibility fixture package field');
    } else {
      assert.equal(fixture.packages?.['node_modules/jest']?.version, match[1]);
      for (const pkg of Object.values(fixture.packages ?? {})) {
        if (pkg.resolved) assert(new URL(pkg.resolved).origin === 'https://registry.npmjs.org', 'Fixture lockfiles must use the public npm registry');
      }
    }
  }
  assert(!readFileSync(resolve(candidate, 'yarn.lock'), 'utf8').includes('__archiveUrl='), 'Nonportable registry archive URLs are forbidden');
  const proposed = jsonFile('HEAD', 'package.json');
  const repaired = readJson('package.json');
  assertPackagePreserved(proposed, repaired, { allowReleaseVersion: finalized });
  const before = jsonFile(baseSha, 'scripts/jest-compatibility.json');
  const after = readJson('scripts/jest-compatibility.json');
  assertCompatibility(before, after, rootJest(repaired));
  const metadata = releaseMetadata(jsonFile(baseSha, 'package.json'), before, after, rootJest(repaired), prNumber);
  // Always derive release notes from master so a second repair does not duplicate the entry.
  const oldChangelog = file(baseSha, 'CHANGELOG.md');
  const changelog = oldChangelog.replace(/^# Changelog\s*\n/, `# Changelog\n\n${metadata.entry}`);
  assert(changelog !== oldChangelog, 'Missing changelog heading');
  if (finalized) {
    assert.equal(repaired.version, metadata.version, 'Unexpected release version');
    assert.equal(readFileSync(resolve(candidate, 'CHANGELOG.md'), 'utf8'), changelog, 'Unexpected release notes');
  } else {
    const packagePath = resolve(candidate, 'package.json');
    const packageText = readFileSync(packagePath, 'utf8');
    const replacement = packageText.replace(/("version"\s*:\s*")[^"]+(")/, `$1${metadata.version}$2`);
    assert(replacement !== packageText || repaired.version === metadata.version);
    writeFileSync(packagePath, replacement);
    writeFileSync(resolve(candidate, 'CHANGELOG.md'), changelog);
    git('add', '--', 'package.json', 'CHANGELOG.md');
  }
  output('version', metadata.version);
  output('tree', git('write-tree').trim());
}

function exportPatch() {
  git('add', '--all');
  writeFileSync(process.env.PATCH_PATH, git('diff', '--cached', '--binary', 'HEAD'));
}

function verifyInstalled() {
  // Immutable installs preserve the supplied lockfile; they do not ensure a
  // descriptor's resolution agrees with its exact package.json version.
  const pkg = readJson('package.json');
  for (const field of ['dependencies', 'devDependencies']) {
    for (const [name, version] of Object.entries(pkg[field] ?? {})) {
      const installed = readJson(`node_modules/${name}/package.json`);
      assert.equal(installed.name, name, `Unexpected installed package for ${name}`);
      assert.equal(installed.version, version, `Installed ${name} must match the preserved exact dependency pin`);
    }
  }
}

async function push() {
  const pr = await api(`pulls/${prNumber}`);
  assertEligiblePr(pr, repository);
  assertFresh(pr, (await api('git/ref/heads/master')).object.sha, headSha, baseSha);
  applyPatch({ finalized: true });
  assert.match(process.env.VALIDATED_TREE, /^[a-f0-9]{40}$/);
  assert.equal(git('write-tree').trim(), process.env.VALIDATED_TREE, 'Artifact differs from the tree submitted to validation');
  // A metadata refresh can leave the tree unchanged; it still needs a fresh
  // App-authored push so normal CI runs against the recorded revision.
  git('commit', '--allow-empty', '-m', `fix: restore Jest compatibility (#${prNumber})`);
  // Re-check immediately before push; a normal fast-forward push also rejects a moved branch.
  assertFresh(await api(`pulls/${prNumber}`), (await api('git/ref/heads/master')).object.sha, headSha, baseSha);
  assert(process.env.REPAIR_PUSH_TOKEN, 'GitHub App push token is required');
  const auth = Buffer.from(`x-access-token:${process.env.REPAIR_PUSH_TOKEN}`).toString('base64');
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-C', candidate, 'push', `https://github.com/${repository}.git`, `HEAD:refs/heads/${pr.head.ref}`], {
    stdio: 'pipe', env: { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}`, GIT_TERMINAL_PROMPT: '0' },
  });
  output('pushed_sha', git('rev-parse', 'HEAD').trim());
  output('version', readJson('package.json').version);
}

async function record() {
  const current = await stateFor(prNumber);
  const operation = current.state.operation;
  assert.equal(operation?.runId, process.env.GITHUB_RUN_ID, 'Another repair owns the state');
  assert(['repair', 'metadata'].includes(operation.kind), 'Unknown repair operation');
  const attempts = current.state.attempts;
  const succeeded = process.env.PUSH_RESULT === 'success' && /^[a-f0-9]{40}$/.test(process.env.PUSHED_SHA ?? '');
  const status = succeeded ? 'pushed' : 'failed';
  if (operation.kind === 'repair') {
    const attempt = attempts.at(-1);
    assert.equal(attempt?.runId, process.env.GITHUB_RUN_ID, 'Another repair owns the state');
    attempt.status = status;
  }
  const state = { ...current.state, status, operation: { ...operation, status }, attempts, ...(succeeded ? { headSha: process.env.PUSHED_SHA, baseSha, version: process.env.RELEASE_VERSION } : {}) };
  const description = operation.kind === 'metadata' ? 'Release metadata refresh' : 'Repair attempt';
  await saveState(prNumber, current, state, succeeded
    ? `Repair pushed at ${state.headSha}; waiting for normal CI before release eligibility. @${ASSIGNEE}, please review once checks pass.`
    : `${description} failed or became stale. See [workflow run](https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}). The PR remains assigned to @${ASSIGNEE}.`);
  await assign(prNumber);
}

const command = process.argv[2];
if (command === 'inspect') await inspect();
else if (command === 'prepare') prepare();
else if (command === 'apply') applyPatch();
else if (command === 'verify') applyPatch({ finalized: true });
else if (command === 'export') exportPatch();
else if (command === 'verify-installed') verifyInstalled();
else if (command === 'push') await push();
else if (command === 'record') await record();
else throw new Error(`Unknown command: ${command}`);
