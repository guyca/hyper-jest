import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { formatState, parseState } from './repair-policy.mjs';

const controller = fileURLToPath(new URL('./repair.mjs', import.meta.url));
const sha = char => char.repeat(40);

async function inspect(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'repair-inspect-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const head = sha('a');
  const master = sha('b');
  const originalBase = sha('c');
  const repository = 'guyca/hyper-jest';
  const originalPackage = { version: '0.1.0', scripts: { test: 'jest' }, devDependencies: { jest: '29.7.0' } };
  const currentPackage = { ...originalPackage, scripts: { ...originalPackage.scripts, 'test:automation': 'node --test' } };
  const proposedPackage = { ...originalPackage, version: options.state ? '0.2.0' : '0.1.0', devDependencies: { jest: '30.2.0' } };
  const pr = { number: 30, state: 'open', draft: false, user: { login: 'dependabot[bot]' }, head: { sha: head, ref: 'dependabot/npm_and_yarn/jest', repo: { full_name: repository } }, base: { ref: 'master', repo: { full_name: repository } } };
  const conclusion = options.conclusion ?? 'failure';
  const run = { id: 10, name: 'CI', workflow_id: 1, status: 'completed', conclusion, head_sha: options.staleRun ? sha('d') : head, event: 'pull_request', head_repository: { full_name: repository } };
  const event = options.manual ? { inputs: { pr_number: 30 } } : { workflow_run: run };
  const comments = options.state ? [{ id: 1, user: { login: 'github-actions[bot]' }, body: formatState(options.state, 'Previous state') }] : [];
  const requests = [];
  const labels = [...(options.labels ?? [])];
  let saved;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(`/repos/${repository}/`, '');
    requests.push({ path, method: req.method });
    let response;
    if (req.method === 'POST' && path === 'issues/30/comments' || req.method === 'PATCH' && path === 'issues/comments/1') {
      saved = parseState({ user: { login: 'github-actions[bot]' }, ...JSON.parse(body) });
      response = { id: 1 };
    } else if (req.method === 'DELETE' && path === 'issues/30/labels/jest-repair-ready') {
      labels.splice(labels.findIndex(label => label.name === 'jest-repair-ready'), 1);
      res.writeHead(204); res.end(); return;
    } else if (req.method === 'POST' && path === 'issues/30/labels') {
      labels.push(...JSON.parse(body).labels.map(name => ({ name })));
      response = {};
    } else if (req.method === 'POST' && ['issues/30/assignees', 'labels'].includes(path)) response = {};
    else if (path === 'actions/workflows/1') response = { path: '.github/workflows/ci.yml' };
    else if (path.startsWith('commits/') && path.endsWith('/pulls')) response = [pr];
    else if (path === 'pulls/30') response = pr;
    else if (path === 'git/ref/heads/master') response = { object: { sha: master } };
    else if (path === 'contents/package.json') {
      const ref = url.searchParams.get('ref');
      const pkg = ref === master ? currentPackage : ref === head ? proposedPackage : ref === originalBase ? originalPackage : null;
      response = { content: Buffer.from(JSON.stringify(pkg)).toString('base64') };
    } else if (path === 'issues/30/comments') response = comments;
    else if (path === 'actions/workflows/ci.yml/runs') response = { workflow_runs: [{ ...run, head_sha: head }] };
    else if (path === 'pulls/30/files') response = [{ filename: 'package.json' }, { filename: 'yarn.lock' }];
    else if (path === `compare/${master}...${head}`) response = { merge_base_commit: { sha: originalBase } };
    else if (path === 'actions/runs/10/jobs') response = { jobs: [{ name: 'tests', conclusion, html_url: 'https://example.test/run', steps: [{ name: 'Unit tests', conclusion }] }] };
    else if (path === 'issues/30/labels') response = labels;
    else if (path === 'labels') response = [];
    else { res.writeHead(404); res.end(path); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const eventPath = join(directory, 'event.json');
  const outputPath = join(directory, 'output');
  writeFileSync(eventPath, JSON.stringify(event));
  writeFileSync(outputPath, '');
  const child = spawn(process.execPath, [controller, options.command ?? 'inspect'], {
    env: {
      ...process.env,
      GITHUB_REPOSITORY: repository,
      GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: options.manual ? 'workflow_dispatch' : 'workflow_run',
      GITHUB_OUTPUT: outputPath,
      GITHUB_RUN_ID: '1234',
      CONTEXT_PATH: join(directory, 'context.json'),
      GH_TOKEN: 'test-placeholder',
      REPAIR_CONFIGURED: options.configured === false ? 'false' : 'true',
      PR_NUMBER: '30',
      MASTER_SHA: master,
      ...options.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, options.exitCode ?? 0, stderr);
  const outputs = Object.fromEntries(readFileSync(outputPath, 'utf8').trim().split('\n').map(line => line.split('=')));
  return { outputs, requests, saved, labels, stderr };
}

test('initial dependency-only PR uses its merge base when master scripts have advanced', async t => {
  const result = await inspect(t);
  assert.equal(result.outputs.repair, 'true');
  assert.equal(result.saved.attempts.length, 1);
  assert(result.requests.some(request => request.path.startsWith('compare/')));
});

test('missing credentials never reserve or consume a repair attempt', async t => {
  const result = await inspect(t, { configured: false });
  assert.equal(result.outputs.repair, 'false');
  assert.equal(result.saved.status, 'setup_required');
  assert.deepEqual(result.saved.attempts, []);
});

test('an obsolete failure event cannot repair a newer PR head', async t => {
  const result = await inspect(t, { staleRun: true });
  assert.equal(result.outputs.repair, 'false');
  assert.equal(result.saved, undefined);
});

test('CI success at the repaired SHA marks only the matching master snapshot ready', async t => {
  const state = { schemaVersion: 1, status: 'pushed', headSha: sha('a'), baseSha: sha('b'), version: '0.2.0', attempts: [{ headSha: sha('c'), status: 'pushed' }] };
  const result = await inspect(t, { state, conclusion: 'success' });
  assert.equal(result.saved.status, 'ready');
  assert.equal(result.outputs.repair, 'false');
  const stale = await inspect(t, { state: { ...state, baseSha: sha('c') }, conclusion: 'success' });
  assert.equal(stale.saved.status, 'stale');
});

test('manual retry of a stale successful repair refreshes metadata without spending on an agent', async t => {
  const state = { schemaVersion: 1, status: 'stale', headSha: sha('a'), baseSha: sha('c'), version: '0.2.0', attempts: [{ headSha: sha('c'), status: 'pushed' }] };
  const result = await inspect(t, { state, conclusion: 'success', manual: true });
  assert.equal(result.outputs.repair, 'true');
  assert.equal(result.outputs.metadata_only, 'true');
  assert.deepEqual(result.saved.attempts, state.attempts);
});

test('successful CI after a rebase removes release readiness until metadata is refreshed', async t => {
  const state = { schemaVersion: 1, status: 'ready', headSha: sha('c'), baseSha: sha('b'), version: '0.2.0', attempts: [{ headSha: sha('d'), status: 'pushed' }] };
  const result = await inspect(t, { state, conclusion: 'success', labels: [{ name: 'jest-repair-ready' }, { name: 'dependencies' }] });
  assert.equal(result.saved?.status, 'stale');
  assert.equal(result.saved.headSha, state.headSha);
  assert.equal(result.outputs.repair, 'false');
  assert.deepEqual(result.labels, [{ name: 'dependencies' }]);
  assert(result.requests.some(request => request.method === 'POST' && request.path === 'issues/30/assignees'));
});

test('successful CI without a prior repair never creates release readiness', async t => {
  const result = await inspect(t, { conclusion: 'success' });
  assert.equal(result.saved, undefined);
  assert.equal(result.outputs.repair, 'false');
  assert.deepEqual(result.labels, []);
});

const exhaustedState = () => ({
  schemaVersion: 1, status: 'stale', headSha: sha('a'), baseSha: sha('c'), version: '0.2.0',
  attempts: [{ headSha: sha('c'), runId: '1000', status: 'failed' }, { headSha: sha('d'), runId: '1001', status: 'pushed' }],
});

test('metadata refresh after two repairs records its own outcome and waits for new CI', async t => {
  const state = exhaustedState();
  const started = await inspect(t, { state, conclusion: 'success', manual: true });
  assert.equal(started.outputs.repair, 'true');
  assert.equal(started.outputs.metadata_only, 'true');
  assert.deepEqual(started.saved.attempts, state.attempts);
  const recorded = await inspect(t, {
    command: 'record', state: started.saved,
    env: { PUSH_RESULT: 'success', PUSHED_SHA: sha('a'), RELEASE_VERSION: '0.2.0' },
  });
  assert.deepEqual(recorded.saved.attempts, state.attempts);
  assert.equal(recorded.saved.status, 'pushed');
  assert.equal(recorded.saved.headSha, sha('a'));
  assert.equal(recorded.saved.baseSha, sha('b'));
  assert.deepEqual(recorded.labels, []);
  const green = await inspect(t, { state: recorded.saved, conclusion: 'success' });
  assert.equal(green.saved.status, 'ready');
  assert.deepEqual(green.labels, [{ name: 'jest-repair-ready' }]);
});

test('a failed metadata refresh can be retried without consuming an agent attempt', async t => {
  const state = { ...exhaustedState(), baseSha: sha('b') };
  const started = await inspect(t, { state, conclusion: 'success', manual: true });
  assert.equal(started.outputs.metadata_only, 'true');
  const failed = await inspect(t, { command: 'record', state: started.saved, env: { PUSH_RESULT: 'failure' } });
  assert.equal(failed.saved.status, 'failed');
  assert.deepEqual(failed.saved.attempts, state.attempts);
  const retry = await inspect(t, { state: failed.saved, conclusion: 'success', manual: true });
  assert.equal(retry.outputs.metadata_only, 'true');
  assert.deepEqual(retry.saved.attempts, state.attempts);
});

test('failed CI still cannot start a third agent after metadata refreshes', async t => {
  const result = await inspect(t, { state: exhaustedState(), manual: true });
  assert.equal(result.outputs.repair, 'false');
  assert.equal(result.saved.status, 'exhausted');
  assert.equal(result.saved.attempts.length, 2);
});

test('recording an agent repair updates its reserved attempt', async t => {
  const started = await inspect(t);
  const recorded = await inspect(t, {
    command: 'record', state: started.saved,
    env: { PUSH_RESULT: 'success', PUSHED_SHA: sha('a'), RELEASE_VERSION: '0.2.0' },
  });
  assert.equal(recorded.saved.status, 'pushed');
  assert.equal(recorded.saved.attempts.length, 1);
  assert.equal(recorded.saved.attempts[0].status, 'pushed');
});

test('an older workflow cannot record the outcome of a newer metadata refresh', async t => {
  const started = await inspect(t, { state: exhaustedState(), conclusion: 'success', manual: true });
  assert.equal(started.outputs.metadata_only, 'true');
  const stale = await inspect(t, {
    command: 'record', state: started.saved, exitCode: 1,
    env: { GITHUB_RUN_ID: '1001', PUSH_RESULT: 'success', PUSHED_SHA: sha('a'), RELEASE_VERSION: '0.2.0' },
  });
  assert.equal(stale.saved, undefined);
  assert.match(stale.stderr, /Another repair owns the state/);
});
