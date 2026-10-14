import assert from 'node:assert/strict';

export const MARKER = 'hyperjest-jest-repair';
export const READY_LABEL = 'jest-repair-ready';
export const MAX_ATTEMPTS = 2;
export const ASSIGNEE = 'guyca';

export function semver(value) {
  assert.match(value, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Expected an exact stable version');
  return value.split('.').map(Number);
}

export function compareVersions(a, b) {
  const left = semver(a);
  const right = semver(b);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

export function rootJest(pkg) {
  const value = pkg.devDependencies?.jest ?? pkg.dependencies?.jest;
  semver(value);
  return value;
}

export function assertJestUpgrade(before, after) {
  assert(compareVersions(rootJest(after), rootJest(before)) > 0, 'PR must increase the actual root Jest dependency');
}

export function parseState(comment) {
  if (comment?.user?.login !== 'github-actions[bot]') return null;
  const match = comment.body?.match(/<!-- hyperjest-jest-repair:(\{[^\n]*\}) -->/);
  if (!match) return null;
  try {
    const state = JSON.parse(match[1]);
    if (state.schemaVersion !== 1 || !Array.isArray(state.attempts)) return null;
    return state;
  } catch { return null; }
}

export function formatState(state, message) {
  return `<!-- ${MARKER}:${JSON.stringify(state)} -->\n${message}\n\nAutomatic Jest compatibility repair (maximum ${MAX_ATTEMPTS} attempts per PR).`;
}

export function decideAttempt({ state, headSha, manual = false }) {
  const attempts = state?.attempts ?? [];
  if (attempts.length >= MAX_ATTEMPTS) return 'exhausted';
  if (!manual && attempts.some(attempt => attempt.headSha === headSha)) return 'duplicate';
  return 'repair';
}

export function assertEligiblePr(pr, repository) {
  assert.equal(pr.state, 'open', 'PR is no longer open');
  assert.equal(pr.draft, false, 'Draft PRs are excluded');
  assert.equal(pr.user.login, 'dependabot[bot]', 'Only Dependabot PRs qualify');
  assert.equal(pr.head.repo?.full_name, repository, 'Fork PRs are excluded');
  assert.equal(pr.base.repo?.full_name, repository);
  assert.equal(pr.base.ref, 'master', 'PR must target master');
  assert.match(pr.head.sha, /^[a-f0-9]{40}$/);
}

export function assertFresh(pr, masterSha, expectedHead, expectedMaster) {
  assert.equal(pr.head.sha, expectedHead, 'PR changed during repair; discard this result');
  assert.equal(masterSha, expectedMaster, 'master changed during repair; discard this result');
}

export function assertAgentPaths(changes) {
  assert(changes.length > 0, 'Agent produced no repair');
  for (const { path, status, mode } of changes) {
    assert(!path.split('/').some(part => part.startsWith('.')), `Hidden/policy path forbidden: ${path}`);
    assert(!/(^|\/)(AGENTS|CLAUDE|GEMINI)\.md$/i.test(path), `Agent policy path forbidden: ${path}`);
    assert(['100644', '100755', undefined].includes(mode), `Symlinks and submodules are forbidden: ${path}`);
    assert(/^(src\/|tests\/|docs\/)/.test(path) || /^tsconfig(?:\.[\w-]+)?\.json$/.test(path) || /^scripts\/jest-compatibility\/\d+\.\d+\.\d+\/package(?:-lock)?\.json$/.test(path) || ['README.md', 'scripts/jest-compatibility.json', 'package.json', 'yarn.lock', 'jest.config.js'].includes(path), `Agent path forbidden: ${path}`);
    assert(!(path.startsWith('tests/') && status === 'D'), `Existing tests cannot be removed: ${path}`);
  }
}

export function assertPackagePreserved(proposed, repaired, { allowReleaseVersion = false } = {}) {
  const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
  const fixed = structuredClone(proposed);
  const candidate = structuredClone(repaired);
  for (const field of fields) {
    for (const [name, version] of Object.entries(proposed[field] ?? {})) {
      assert(candidate[field]?.[name], `Proposed dependency removed: ${name}`);
      assert(compareVersions(candidate[field][name], version) >= 0, `Proposed dependency downgraded: ${name}`);
    }
    for (const version of Object.values(candidate[field] ?? {})) semver(version);
    delete fixed[field];
    delete candidate[field];
  }
  if (allowReleaseVersion) { delete fixed.version; delete candidate.version; }
  assert.deepEqual(candidate, fixed, 'Agent cannot alter package scripts, engines, metadata, or extension contributions');
}

export function assertCompatibility(before, after, proposedJest) {
  const versions = after.versions;
  assert(Array.isArray(versions) && versions.length === 3, 'Exactly three Jest majors must be guaranteed');
  const majors = versions.map(v => semver(v)[0]).sort((a, b) => a - b);
  const latest = Math.max(semver(proposedJest)[0], ...before.versions.map(v => semver(v)[0]));
  assert.deepEqual(majors, [latest - 2, latest - 1, latest], 'Compatibility window must contain the last three majors');
  for (const oldVersion of before.versions) {
    const replacement = versions.find(v => semver(v)[0] === semver(oldVersion)[0]);
    if (replacement) assert(compareVersions(replacement, oldVersion) >= 0, 'Compatibility pins cannot be downgraded');
  }
  const rootPin = versions.find(v => semver(v)[0] === semver(proposedJest)[0]);
  if (rootPin) assert(compareVersions(rootPin, proposedJest) >= 0, 'The proposed Jest version must be exercised');
}

export function nextReleaseVersion(baseVersion, { dropsSupport = false, addsSupport = false } = {}) {
  let [major, minor, patch] = semver(baseVersion);
  if (dropsSupport) {
    if (major === 0) minor += 1;
    else { major += 1; minor = 0; }
    patch = 0;
  } else if (addsSupport) { minor += 1; patch = 0; }
  else patch += 1;
  return `${major}.${minor}.${patch}`;
}

export function releaseMetadata(basePackage, beforeCompatibility, afterCompatibility, proposedJest, prNumber) {
  const beforeMinimum = Math.min(...beforeCompatibility.versions.map(v => semver(v)[0]));
  const afterMinimum = Math.min(...afterCompatibility.versions.map(v => semver(v)[0]));
  const dropsSupport = afterMinimum > beforeMinimum;
  const addsSupport = semver(proposedJest)[0] > semver(rootJest(basePackage))[0] || Math.max(...afterCompatibility.versions.map(v => semver(v)[0])) > Math.max(...beforeCompatibility.versions.map(v => semver(v)[0]));
  const version = nextReleaseVersion(basePackage.version, { dropsSupport, addsSupport });
  const support = afterCompatibility.versions.map(v => semver(v)[0]).sort((a, b) => a - b).join(', ');
  const breaking = dropsSupport ? `\n- Breaking compatibility change: minimum guaranteed Jest major is now ${afterMinimum}.` : '';
  return { version, entry: `## ${version}\n\n- Repair compatibility with Jest ${proposedJest} (PR #${prNumber}); guaranteed Jest majors: ${support}.${breaking}\n\n` };
}
