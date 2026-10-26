---
name: version-bump
description: Decide HyperJest's next version (patch, minor or major) from everything merged to master since the last version bump, explain the choice, then bump package.json + CHANGELOG.md and open a release PR. Patch and minor proceed automatically; major always asks first.
disable-model-invocation: true
argument-hint: "[patch|minor|major]  (optional override; still analysed and explained)"
---

# Version bump

Merging a PR that raises the root `package.json` version publishes HyperJest to the Marketplace
(see `docs/release-automation.md`). This skill picks the bump, explains it, and opens that PR.

Never touch the user's current checkout or branch: all edits happen in a fresh worktree from
`origin/master`.

## 1. Find the baseline

```bash
git fetch origin --tags --prune
CUR=$(git show origin/master:package.json | jq -r .version)
BASE=$(git log --first-parent -S"\"version\": \"$CUR\"" --format=%H origin/master -- package.json | tail -1)
git rev-parse --verify -q "v$CUR^{commit}"   # the published tag, if any
gh pr list --state open --base master --search 'in:title "Release HyperJest"' --json number,title,url
```

- `BASE` is the master commit that set the current version. If tag `v$CUR` is missing, `$CUR` was
  bumped but never published; mention it (the release workflow can retry it) and continue.
- If a release PR is already open, report it and stop: master requires up-to-date PRs, so two
  competing version bumps cannot both merge.

## 2. Collect what merged since the baseline

```bash
git log --first-parent --format='%h %s' "$BASE"..origin/master
git diff --stat "$BASE" origin/master
```

If the log is empty, say nothing merged since `$CUR` and stop.

For every `(#N)` in the subjects: `gh pr view N --json number,title,body,labels,files`. For commits
without a PR number, read `git show --stat <sha>`. Also read the `## Unreleased` section of
`CHANGELOG.md`.

Mechanical signals (left column = removed, indented column = added):

```bash
diffjq() { comm -3 <(git show "$BASE":package.json | jq -r "$1" | sort) <(git show origin/master:package.json | jq -r "$1" | sort); }
SETTINGS='.contributes.configuration | (if type=="array" then .[] else . end) | .properties'
diffjq "$SETTINGS | keys[]"                                         # settings added/removed
diffjq "$SETTINGS | to_entries[] | \"\(.key) = \(.value.default|tojson)\""   # defaults changed
diffjq "$SETTINGS | to_entries[] | select(.value.enum) | \"\(.key): \(.value.enum|tojson)\""  # enum values
diffjq '.contributes.commands[].command'                            # commands added/removed
git diff "$BASE" origin/master -- scripts/jest-compatibility.json   # guaranteed Jest majors
git show "$BASE":package.json | jq .engines; git show origin/master:package.json | jq .engines
```

## 3. Classify each change and pick the strategy

Classify every PR/commit by its effect on someone who already uses HyperJest. The strategy is the
highest level of any change.

| Level | Examples |
| --- | --- |
| **major** (breaking) | Removed or renamed `hyperjest.*` setting or command; narrowed accepted values; a guaranteed Jest major dropped from `scripts/jest-compatibility.json`; incompatible `hyperjest.projects` / `hyperjest.config.js` format; a removed feature or integration users relied on; a changed default that makes working setups stop running tests |
| **minor** | New feature, setting, command or view; new guaranteed Jest major; user-visible behaviour change with an opt-out setting; raised `engines.vscode` |
| **patch** | Bug fixes, performance, internal refactors, dependency bumps with no behaviour change, README/docs, CI, tests, release automation |

- A settings/commands removal from the mechanical diff is major unless the PR shows it was never
  released (added and removed within this range).
- Judge by what changed, not by PR titles or labels alone; read the diff when a title is vague.
- If every change is outside the VSIX (`.github/`, `tests/`, `scripts/` not used at runtime) and
  nothing user-facing changed, say a release would publish an identical extension and stop
  without bumping.

**0.x policy:** `docs/release-automation.md` says breaking changes bump minor while the extension
is `0.x`. A breaking change on `0.x` is still a major-level decision: ask (step 4) with
"`0.(y+1).0` (Recommended, 0.x policy)" and "`1.0.0`" as the options.

An argument (`patch|minor|major`) overrides the result, but still do the analysis and say whether
you agree. A `major` override still asks.

## 4. Explain, then act or ask

Tell the user, before acting:

- `CUR → NEXT` and the strategy.
- Reasoning: the change(s) that decided the level, and why nothing higher applies.
- A short table: PR, title, level, one-line reason.

Then:

- **patch / minor** → continue to step 5 without asking.
- **major** (including the 0.x breaking case and a `major` override) → always call
  `AskUserQuestion` before changing anything. Options: the major bump (Recommended, or the 0.x
  minor as above), a minor bump instead, and cancel. Name the breaking changes in the question's
  option descriptions. Proceed only with what the user picks; on cancel, stop.

## 5. Bump in a worktree

```bash
BR="release-$NEXT"
git ls-remote --exit-code --heads origin "$BR" && echo "branch exists"   # stop if it does
WT="$(mktemp -d)/hyper-jest"
git worktree add -b "$BR" "$WT" origin/master
cd "$WT"
yarn install --immutable
yarn version "$STRATEGY"        # patch|minor|major; edits package.json only
jq -r .version package.json      # must equal NEXT
```

`yarn.lock`'s root entry is `0.0.0-use.local`, so the lockfile does not change.

Edit `CHANGELOG.md`: add `## $NEXT` directly under `# Changelog`, with one concise bullet per
user-facing change, in the existing style ("Fix …", "Run …", "Add setting `hyperjest.x` …"). Merge
small internal changes into one bullet or leave them out; release notes on GitHub list every PR.
Move bullets from `## Unreleased` that describe PRs in this range into the new section; delete the
`## Unreleased` heading if it ends up empty. Leave other Unreleased bullets where they are and
mention them in the report.

Validate:

```bash
yarn package && yarn check:package && git diff --check
git status --short               # only package.json and CHANGELOG.md
```

## 6. Commit, push, open the PR

```bash
git commit -am "Release HyperJest $NEXT"   # plus the session's attribution trailer, if any
git push -u origin "$BR"
gh pr create --base master --head "$BR" --title "Release HyperJest $NEXT" --body-file <body.md>
cd - && git worktree remove "$WT"           # the branch stays on origin
```

PR body (write it to a temp file):

```markdown
Bump HyperJest from `CUR` to `NEXT` (<strategy>).

## Why <strategy>
<the deciding changes and why nothing higher applies>

| PR | Change | Level |
| --- | --- | --- |
| #N | title | patch/minor/major — reason |

After this PR merges into `master` and CI passes on the merged commit, the release workflow
publishes `NEXT` to the Marketplace with generated GitHub release notes.

Validation:
- `yarn package` and `yarn check:package` passed for `GuyCarmeli.hyperjest` `NEXT`.
- Only `package.json` (version) and `CHANGELOG.md` changed; `git diff --check` passed.
```

Finish with the version, the strategy, the reasoning in two or three sentences, and the PR link.
Do not merge the PR or enable auto-merge.
