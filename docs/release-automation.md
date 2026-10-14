# Jest repair and release automation

HyperJest guarantees the latest three stable Jest majors. The source of truth is
`scripts/jest-compatibility.json`; the corresponding isolated installations have
committed npm locks under `scripts/jest-compatibility/`. The runtime policy,
Doctor, and CI use this manifest. The extension's own Jest harness stays separate
from the project Jest installations being tested.

## Required checks

`PR checks` aggregates the production build, unit tests, automation tests, VSIX
validation, network check, and all compatibility jobs. Each supported major runs
warm-worker and CLI integration tests. A proposed root Jest patch not already in
the manifest gets its own additional matrix row. A proposed major outside the
window fails the policy check until the window and its fixtures are updated.

```sh
yarn install --immutable
yarn build
yarn test --ci --runInBand --coverage
yarn test:compatibility
yarn test:automation
yarn check:no-network
yarn package
yarn check:package
```

For one compatibility version, use `yarn test:compatibility --version 28.1.3`.
Fixture installation uses `npm ci --ignore-scripts`. Keep checked-in lockfile URLs
on the public npm registry, including when generating locks behind a local mirror.

## Repair lifecycle

Dependabot groups Jest, its types, and its transformers separately from unrelated
updates. The repair controller listens for completed CI runs and checks the
actual root Jest dependency increase. Only open, non-draft Dependabot PRs from
this repository targeting `master` qualify. The initial PR must contain only
`package.json` and `yarn.lock` changes.

The controller comes from `master`. It records attempts in a single Actions-bot
comment, merges the inspected master revision, and runs Cursor in an isolated
checkout. The agent has no GitHub write token or Marketplace credentials. A fresh
job checks the proposed patch and reruns validation. Automation and workflow
changes, agent instructions, symlinks, test deletion, dependency downgrades, and
package script changes are rejected. Root TypeScript and Jest configuration
changes are permitted when needed to repair compatibility.

A separate job pushes with a GitHub App token only if both PR and master are still
at the inspected revisions. It uses a normal fast-forward push and does not
force-push or merge. The controller assigns `guyca` and marks the exact repaired
commit `jest-repair-ready` after ordinary PR CI passes.

There are at most two repair attempts per PR, each with a 20-minute agent timeout.
Duplicate events do not spend another attempt. Failed or stale work is reported
on the PR. A manual retry still counts toward the same limit:

```sh
gh workflow run jest-repair.yml --ref master -f pr_number=30
```

Repair commits include the extension version and changelog. Compatible fixes get
a patch bump. New Jest-major support gets a minor bump. Removing a guaranteed
major is breaking: minor while the extension is 0.x, major after 1.0. Master's
strict up-to-date PR requirement prevents merging competing stale version bumps.

## GitHub App setup

Create a private app owned by `guyca`, with webhooks disabled, repository Contents
read/write and mandatory Metadata read. Install it only on `guyca/hyper-jest`.
Store its numeric app ID as the repository variable `REPAIR_APP_ID`, and its
private key as the Actions secret `REPAIR_APP_PRIVATE_KEY`. `CURSOR_API_KEY` is
also required. Optionally set `JEST_REPAIR_MODEL`; the default is Cursor `auto`.

Only the push job receives the installation token. The normal workflow token
handles state comments and assignment. An App token is needed so pushing a fix
starts ordinary PR checks without a manual workflow approval.

## Marketplace identity setup

The extension identity is `GuyCarmeli.hyperjest`. Confirm that the Microsoft account
used for setup owns publisher `GuyCarmeli` before granting publishing access.

Use a dedicated Microsoft Entra application/service principal with a federated
credential for GitHub Actions:

| Setting | Value |
| --- | --- |
| Issuer | `https://token.actions.githubusercontent.com` |
| Subject | `repo:guyca/hyper-jest:environment:marketplace` |
| Audience | `api://AzureADTokenExchange` |

Authorize that identity as a Contributor on Marketplace publisher `GuyCarmeli`, using
its Azure DevOps identity identifier, not its application/client ID. Store
`AZURE_CLIENT_ID` and `AZURE_TENANT_ID` as variables on the GitHub environment
`marketplace`. No client secret or publishing PAT is required. The environment
must allow only the `master` branch and have no required reviewers or wait timer.
The workflow uses `azure/login` with no Azure subscription requirement, followed
by the pinned local VSCE CLI with `--azure-credential`.

See Microsoft's [extension publishing instructions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
and [Azure Login OIDC guidance](https://github.com/Azure/login#login-with-openid-connect-oidc-recommended).

## Release lifecycle and recovery

After you merge a repaired PR, successful CI on its exact merge commit makes it
eligible for the release queue. Every master commit gets its own CI run. The
serialized release workflow scans all marked merged PRs in merge order, so
replaced pending workflow events do not lose releases. It verifies the Actions-bot
repair record; a label alone cannot authorize publication.

The build job has no publishing credentials. It builds the exact tested merge
commit and retains `hyperjest-<version>.vsix`, checksums, and source metadata. The
publish job reserves `v<version>` and a draft GitHub release, publishes that exact
VSIX to Marketplace, then publishes the GitHub release with the same attachment.

Retries reuse an already retained artifact instead of rebuilding it. Tags,
versions, source metadata, and artifact hashes must agree. An existing Marketplace
version is checked against the retained package before it is accepted as a
successful retry. Conflicting artifacts stop the workflow instead of being
overwritten. Failed runs report the failure on the PR; review the Actions logs,
fix the underlying setup or service problem, then retry:

```sh
gh workflow run release.yml --ref master -f pr_number=30
```

An older queued release is processed first. Nothing is automatically merged, and
unrepaired Jest PRs and unrelated PRs do not enter this release queue.

## Initial rollout

Merge the setup PR only after all required checks pass. Complete both identities
above, then dispatch `jest-repair.yml` for PR #30. Its six proposed dependency
upgrades must be retained; TypeScript 7 currently causes its first build failure.
Review and merge the repaired PR to approve the first Marketplace publication.
