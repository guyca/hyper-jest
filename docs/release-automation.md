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

If a later CI rerun fails on that same PR head and master revision, release
readiness pauses as `ci_failed` and the ready label is removed. This does not
start another agent or consume an attempt. A passing rerun restores readiness;
an explicit manual repair can still use a remaining attempt. Changes to the PR
head or master follow the normal repair and metadata-refresh rules.

There are at most two agent repair attempts per PR, each with a 20-minute agent timeout.
Duplicate events do not spend another attempt. Failed or stale work is reported
on the PR. A manual retry of failing CI still counts toward the same limit:

```sh
gh workflow run jest-repair.yml --ref master -f pr_number=30
```

If the PR head or master changes after a repair, successful CI clears the ready
label and marks the repair stale. Run the same command to refresh its version and
changelog against master. With passing CI, this refresh skips the agent, does not
consume an agent attempt, and remains available after both attempts are used.
It still requires full validation, a fresh push, and successful CI on that new
commit before restoring release readiness. A failed refresh can be retried.

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

1. Sign into the [Azure portal](https://portal.azure.com/) and check whether the
   account already has a Microsoft Entra workforce directory that you can manage.
   A personal Microsoft account alone is insufficient. If there is no directory
   and Entra reports an account/tenant error, use Microsoft's
   [Azure free-account signup](https://azure.microsoft.com/en-us/free/), selecting
   **Try Azure for free** with the same account. Complete the identity checks and
   agreement personally. Signup requires a phone number and non-prepaid credit or
   debit card; Microsoft may place a temporary verification hold. The free offer
   does not charge unless you choose to upgrade to pay-as-you-go. Use the initial
   directory created during signup: creating additional workforce tenants in the
   admin center is restricted to paid customers. See the official
   [tenant setup instructions](https://learn.microsoft.com/en-us/entra/fundamentals/create-new-tenant)
   and [signup requirements](https://azure.microsoft.com/en-us/pricing/purchase-options/azure-account).
2. Switch to that directory in the Entra admin center. Under **App registrations →
   New registration**, create a dedicated application, such as `HyperJest Marketplace`,
   with the single-tenant account type and no redirect URI. Record its **Application
   (client) ID** and **Directory (tenant) ID**. An app registration creates the
   service principal used by this automation. No client secret, compute resource,
   or Azure resource role assignment is needed. See
   [app registration](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app).
3. Under the app's **Certificates & secrets → Federated credentials**, add a
   **GitHub Actions** credential for organization `guyca`, repository `hyper-jest`,
   **Organization ID** `12352397`, **Repository ID** `1412723838`, entity type
   **Environment**, and environment `marketplace`. Read the repository's current
   OIDC configuration instead of assuming the older name-only format:

   ```sh
   gh api repos/guyca/hyper-jest/actions/oidc/customization/sub
   ```

   This repository uses immutable subjects (`use_immutable_subject: true`), with
   `sub_claim_prefix` equal to `repo:guyca@12352397/hyper-jest@1412723838`.
   Append `:environment:marketplace` for these publishing jobs. See
   [GitHub's immutable subject reference](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims)
   and [Microsoft's federation guidance](https://learn.microsoft.com/en-us/entra/workload-id/workload-identities-github-immutable-subjects).

| Setting | Value |
| --- | --- |
| Issuer | `https://token.actions.githubusercontent.com` |
| Subject | `repo:guyca@12352397/hyper-jest@1412723838:environment:marketplace` |
| Audience | `api://AzureADTokenExchange` |

4. Store the application and directory IDs as `AZURE_CLIENT_ID` and
   `AZURE_TENANT_ID` variables on the GitHub environment `marketplace`. Restrict
   that environment to `master`, with no required reviewers or wait timer.
5. After this workflow is on `master`, run the identity probe:

   ```sh
   gh workflow run marketplace-identity.yml --ref master
   ```

   Its summary contains the **Azure DevOps profile ID** of the authenticated
   service principal. The probe only authenticates and reads that profile; it
   does not check out code, build, publish, or print an access token.
6. In [Marketplace publisher management](https://marketplace.visualstudio.com/manage/publishers/GuyCarmeli),
   open `GuyCarmeli` → **Members**, add the profile ID from the probe, and choose
   **Contributor**. Use this profile ID, not the application/client ID or Entra
   object ID. The probe's success confirms OIDC authentication; membership must
   still be granted before the first release.

No publishing PAT is required. The release workflow uses `azure/login` with no
Azure subscription requirement, followed by the pinned local VSCE CLI with
`--azure-credential`. An Entra directory remains when an Azure subscription
expires, so this app registration does not require a running Azure workload or
an upgrade to use paid compute. See Microsoft's
[directory/subscription relationship](https://learn.microsoft.com/en-us/entra/fundamentals/how-subscriptions-associated-directory).

See Microsoft's [extension publishing instructions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
and [service-principal publisher authorization](https://learn.microsoft.com/en-us/azure/devops/extend/publish/command-line?view=azure-devops#publish-with-a-microsoft-entra-token),
plus [federated credential setup](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust)
and [Azure Login OIDC guidance](https://github.com/Azure/login#login-with-openid-connect-oidc-recommended).

## Release lifecycle and recovery

Merge a PR into `master` that increases the root `package.json` extension version
to a stable `major.minor.patch` value. Merging the version bump approves automatic
publication, including for PRs from forks. Merge commits, squash merges, and
multi-commit rebase merges are supported; the controller compares the version
before the landed PR range with its final commit, even if the bump occurred in
an earlier rebased commit. PRs without an increase do not publish, and the workflow
never chooses or commits a new version for you.
The automatic scan skips PRs whose starting or final version is missing or is not
a stable `major.minor.patch` value, so unsupported historical versions cannot
block later eligible releases. Explicit manual requests still validate their
selected version and fail if it is unsupported.

Successful push CI on the exact landed commit makes the PR eligible. The
serialized release workflow scans merged PRs in merge order, so replaced pending
workflow events do not lose releases. It verifies master ancestry and the
unchanged `GuyCarmeli.hyperjest` identity, skips historical published versions,
and rejects competing PRs requesting the same release version. A later queued
release waits when the oldest candidate's CI has not passed. Every master commit
gets its own CI run.

Ordinary automatic releases use GitHub-generated release notes, with changes and
contributors since the previous published stable version tag through the exact
release commit. Intervening fixes without version bumps are included. No
version-specific `CHANGELOG.md` section is required. Notes appear on the GitHub
release and are linked from a bot status comment on the PR; the source changelog
and the VSIX contents are not modified. GitHub's note-generation endpoint needs
Contents write permission, so only the publish job generates notes.

The draft release retains the generated notes, their checksum, and the previous
tag used as their comparison baseline. Retries reuse this snapshot even if PR
titles or descriptions have changed. If note generation fails, the original VSIX
and checksums are already retained in the draft and a retry can generate notes
without rebuilding the package.

To retry a specific merged version-bump PR, use:

```sh
gh workflow run release.yml --ref master -f release_pr=<merged-version-bump-pr>
```

This dispatch resumes an automatic reservation with its original identity, notes,
and VSIX. Existing manual and Jest-repair reservations also retain their original
identities and changelog-based notes. For a PR without an automatic reservation,
the explicit `release_pr` dispatch preserves the legacy manual path: a
same-repository version bump and its version-specific changelog section are
required. Use a dispatch without inputs to rescan the automatic queue instead.

Validated Jest repairs remain part of the same queue, with no duplicate release
for the ordinary version bump. The controller still verifies the Actions-bot
repair record before publishing a repair candidate; a label alone cannot authorize
the repair path. A merged PR can independently qualify through its stable
extension version increase.

The build job has no publishing credentials. It builds the exact tested merge
commit and retains `hyperjest-<version>.vsix`, checksums, and source metadata. The
publish job reserves `v<version>` and a draft GitHub release with the exact VSIX
before checking or authenticating the Marketplace identity. Authentication or
publication-tool installation failures therefore retain the original package.
The job then publishes that VSIX to Marketplace and publishes the GitHub release
with the same attachment.

The Actions build artifact is retained for 90 days. Before any Marketplace publish
attempt, the VSIX and checksums are attached to the draft GitHub release, where
they remain available independently of Actions artifact expiration. Retries reuse
that retained artifact instead of rebuilding it. If a reserved VSIX is deleted,
restore the exact original attachment before retrying; removing its metadata
cannot authorize a rebuild. Tags,
versions, source metadata, and artifact hashes must agree. An existing Marketplace
version is checked against the retained package before it is accepted as a
successful retry. Conflicting artifacts stop the workflow instead of being
overwritten. Read requests retry transient network and service errors up to three
times; failures identify the operation and error code without printing credentials
or signed download URLs. Publishing and other write requests are not automatically
repeated. Marketplace verification has an eight-minute elapsed-time deadline,
including requests, retries, downloads, and polling sleeps, before leaving the
draft for a later retry. The publish job allows 25 minutes for setup, publication,
verification, and finalization. Draft updates preserve the version tag; recovery also
recognizes older `untagged-*` drafts by their release metadata and reuses the oldest
reservation after validating its source and checksums.

Failed runs report the failure on the PR; review the Actions logs,
fix the underlying setup or service problem, then retry:

```sh
gh workflow run release.yml --ref master -f pr_number=30
```

The `pr_number` input processes an older queued release first and also accepts
ordinary version-bump PRs. Nothing is automatically merged. A plain dispatch
rescans the queue; failed runs leave their reserved artifacts for recovery.

## Automatic version-bump rollout

The existing `marketplace` environment and Azure identity are reused; no new
credentials or AI service are needed. Merge this automation after CI passes,
then merge the next stable version bump to exercise the automatic flow. The
current published version is `0.2.1`; scheduling fix PR #43 retained that version
and therefore does not trigger a release. A subsequent `0.2.2` bump will include
that fix in the generated notes.

## Initial rollout

Merge the setup PR only after all required checks pass. Complete both identities
above, then dispatch `jest-repair.yml` for PR #30. Its six proposed dependency
upgrades must be retained; TypeScript 7 currently causes its first build failure.
Review and merge the repaired PR to approve the first Marketplace publication.
