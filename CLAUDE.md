# HyperJest — maintainer guide

HyperJest is a VS Code extension that runs a project's **own** Jest in a pool of warm worker
processes and paints results in the editor: gutter coverage squares, inline failure messages,
inline `console.log` / `//?` live values, Problems entries, a status bar item and a native
Test Explorer.

## Hard rules

- **Never load Jest in the extension host.** Jest, Babel, ts-jest and project configs are loaded only inside
  worker processes (`src/worker/*`) or spawned CLI processes. Loading a config in the host would run
  side effects and block the UI.
- **Resolve Jest by chain from the project's `jest` package** (`jest -> jest-cli -> @jest/core -> jest-config /
  jest-runtime / jest-runner / ...`). Never use `node_modules/.bin/jest` and never resolve Jest packages from
  the repo root: hoisting can mix incompatible versions of Jest and its internal packages.
- **No `vscode` import under `src/core/` or `src/worker/`.** Those directories are pure Node and unit-tested
  with Jest (`tests/unit`). Only `src/*.ts` and `src/discovery/*`, `src/results/*` UI files may import `vscode`.
- **Never bundle Jest/Babel into the worker bundles.** `esbuild.mjs` bundles only HyperJest code (plus
  `@babel/parser` for static test discovery); every Jest module is `require`d at runtime by absolute path.
- Never run `npx` (it may reach the network). Use the local `node_modules/.bin` via Yarn scripts.
- Only `@types/vscode` ≤ `engines.vscode` (major.minor) is accepted by vsce. Bump both together.

## Toolchain

- Node ≥ 22, Yarn 4.18.0 pinned in `package.json` via Corepack.
  Dependencies are exact-pinned in `package.json`; commit `yarn.lock` for reproducible installs.
- `.yarnrc.yml`: `nodeLinker: node-modules`, `npmRegistryServer: https://registry.npmjs.org`,
  `defaultSemverRangePrefix: ""`, `enableScripts: false`,
  `enableTelemetry: false`. esbuild's binary comes from the optional `@esbuild/darwin-arm64` package;
  keytar's network postinstall never runs.
- Fresh dependency installs use the public npm registry.

## Commands

```bash
corepack enable             # one-time: enable the Yarn shim
corepack install            # download the pinned Yarn version
yarn install --immutable    # install exactly yarn.lock; also sets up Husky's pre-commit hook
yarn sanitize:lockfile      # strip registry-specific tarball URLs (also runs on staged lockfile commits)
yarn build                  # type-check (host, worker and test tsconfigs) + production bundles into dist/
yarn build:dev              # fast dev bundles with source maps
yarn watch                  # rebuild on change (used by .vscode/launch.json "Run HyperJest (dev host)")
yarn test                   # HyperJest's own unit tests (jest 29.7 + ts-jest, ~420 tests, no vscode)
yarn test:it                # gated integration tests: real jest 29.7 driven through the worker/reporter
yarn package                # build + vsce package -> hyperjest.vsix
yarn install-extension      # package + code --install-extension hyperjest.vsix --force
```

Install into VS Code: `code --install-extension hyperjest.vsix --force`, then **Developer: Reload Window**.

## Repository map

```
src/extension.ts            activate(): composes everything below (no logic)
src/settings.ts, log.ts     hyperjest.* settings -> core/settingsModel; LogOutputChannel "HyperJest"
src/workerPool.ts           N = max(1, cpus-1) warm workers; per-project caps, memory budget, hot spare, recycle, overlay replay
src/runner.ts               RunCoordinator: queue/priorities/generations, warm or CLI dispatch, on-type/on-save affected runs,
                            Smart Start, continuous runs, snapshots, debug, cancel; implements src/runnerApi.ts
src/discovery/              packageScanner (findFiles), projectRegistry (file->project, readiness, toolchain invalidation), configCache
src/core/                   PURE: protocol.ts (host<->worker messages), projectSpec/scriptSniffer/jestResolver/nodeResolver
                            (discovery), testFileMatcher (Jest's isTestFilePath replica), testParser (@babel/parser) + testIds
                            (reconciliation), changeAnalyzer/textDiff/affected (what to re-run), runSpec (CLI argv), cliEvents
                            (reporter NDJSON), childEnv (sanitised env), settingsModel, resultModel, testModel
src/results/                resultStore (all results, coverage, inline entries), lineView (gutter/inline per line)
src/decorations.ts, iconAssets.ts, contextKeys.ts, diagnostics.ts, hover.ts, statusBar.ts, testTree.ts, codeLens.ts,
src/doctor*.ts, diffView.ts UI surfaces
src/cliEngine.ts, debug.ts  fresh `jest/bin/jest.js` runs with dist/worker/reporter.cjs on fd 3; js-debug launch config
src/overlay.ts, documents.ts, overlayManifest.ts   unsaved buffers -> workers / CLI manifest; parse cache
src/worker/                 hyperjestWorker (IPC entry), jestChain (chain resolution), warmEngine (readConfigs once,
                            TestRunner in-band per run), transformHooks (prototype seams), envWrapper (per-test coverage,
                            console/value capture, cancel/narrowing), coverageDiff, depGraph, overlayFs, stacks,
                            reporter (CLI), overlayPreload (CLI/debug --require), probeTransformer (//? live comments)
scripts/worker-driver.mjs   drive a worker from a terminal (NDJSON) — the main troubleshooting tool
scripts/discovery-report.mjs classify every package.json of one or more repos (what the Explorer will show)
scripts/check-no-network.sh
tests/unit, tests/integration, tests/fixtures/sample-project
```

### Protocol in one paragraph (`src/core/protocol.ts`, `PROTOCOL_VERSION`)

Host forks `dist/worker/hyperjestWorker.cjs` with the project's node, `cwd = packageDir`, JSON IPC, then sends
`init {spec, flags, slot}` and waits for `ready {jestVersion, configs, seams}` or `initError`. Per run:
`run {runId, tests:[{path, names?}], updateSnapshot}` → `fileStart` → (`coverageMeta` once per file hash) →
`fileLoad` → [`testStart` → `console`/`value`* → `testCoverage` → `testResult`]* → `fileCoverage` → `fileResult`
→ `runComplete {wasInterrupted}`. Other messages: `cancel`, `overlay` (unsaved buffers), `invalidate`, `graph`,
`showConfig`, `listTests`, `ping`/`pong`, `shutdown`. `testKey = path\0fullName\0dupIndex`. Bump
`PROTOCOL_VERSION` whenever a message shape changes incompatibly (old workers are recycled).

## Adding or updating a dependency

1. Online: `yarn add --dev <pkg>@<exact>` (new versions are saved without a range prefix).
2. Run `yarn build && yarn test`. 3. Commit `package.json` + `yarn.lock`.
The pre-commit hook sanitizes staged lockfile changes; run `yarn sanitize:lockfile` manually before
verifying an immutable install. CI rejects lockfiles containing registry-specific `__archiveUrl` entries.
If editing dependency entries by hand, run `yarn install` to update the lockfile before verifying
with `yarn install --immutable`. For `@types/vscode`, bump `engines.vscode` to the same major.minor.
Worker bundles must stay Jest-free: check with `grep -c "node_modules/jest" dist/worker/*.cjs` (expect 0).

## Coverage badge

Run `yarn test:coverage` to measure line coverage across `src/` and refresh `media/coverage.svg` locally.
The detailed report is in `coverage/index.html`. On a push to `master` (or a manual workflow run),
GitHub Actions runs the tests and commits the badge only if it changed. Branch rules must allow the
Actions bot to push the badge update to `master`.

## Troubleshooting

- **Output channel**: View → Output → "HyperJest". Set `hyperjest.trace: true` for worker-level detail; the
  channel's log level can be raised with "Developer: Set Log Level…".
- **HyperJest: Doctor** — per-package classification (flavor, status, reason + fix), Jest/Node resolution, worker
  state and bootstrap time, `ready.seams` (false = degraded feature), memory. **HyperJest: Copy Diagnostics
  Report** puts the same text on the clipboard.
- **HyperJest: Show Resolved Jest Config** — the ProjectSpec, Jest's `--showConfig` output and the exact shell
  command HyperJest runs. Paste that command in a terminal to compare with plain Jest.
- **From a terminal, without VS Code** (after `yarn build:dev`):
  ```bash
  node scripts/worker-driver.mjs init --pkg <packageDir> [-c <config>] [--node <node>] [--env K=V]
  node scripts/worker-driver.mjs run <test file> --pkg <packageDir> --repeat 2
  node scripts/worker-driver.mjs show-config --pkg <packageDir>
  node scripts/discovery-report.mjs --repo <repoDir> --show-warnings
  HYPERJEST_CORPUS_ROOTS='["/path/to/project"]' yarn test tests/unit/parser/corpus.test.ts
  ```
- **Nothing runs for a package** → Doctor: `unavailable` means `jest` does not resolve from the package (run the
  repo's `yarn install`); `notJest` means the test script is not Jest (node --test, mocha); `unsupported`
  means Jest < 29. Force a spec with `hyperjest.projects: [{ "packageDir": "...", "configArg": "..." }]`.
- **Wrong tests / wrong config picked** → the registry prefers configs named by `package.json` test scripts
  (`jest -c x`) over implicit `jest.config.*`; `hyperjest.discovery.preferScriptConfigs: false`
  flips that. Custom tooling supplies its setup through `hyperjest.config.js` or workspace settings;
  Jest must resolve from the package through normal dependency resolution.
- **"Multiple configurations found"** → a package has both `jest.config.*` and a `package.json` `jest` key. Jest
  itself refuses this; HyperJest reports it unless a script-selected config wins.
- **Node version** → `.nvmrc` / `.node-version` / `engines.node` are matched against fnm, nvm, volta, asdf, n and
  Homebrew installs, then PATH `node`, then VS Code's own Node. A missing version produces a warning and a
  fallback; set `hyperjest.nodePath` to pin one. Jest 30 needs Node ≥ 18.14.
- **Stale results / strange coverage** → "HyperJest: Clear Caches" (drops results and recycles workers) or
  "HyperJest: Restart". Editing `jest.config*`, `package.json`, `babel.config*`, `tsconfig*`, lockfiles or setup
  files recycles the project's workers automatically.
- **Memory** → workers are recycled above `hyperjest.workerMemoryLimitMB` (2048), after
  `workerRecycleAfterRuns` (200) runs or `workerIdleTimeoutMs` idle; total RSS is bounded by `memoryBudgetMB`
  (default 50% of RAM). Lower `maxWorkers` / `maxWorkersPerProject` on small machines.
- **On-type runs feel slow or noisy** → `hyperjest.runMode: onSave`, raise `onTypeDebounceMs`, lower
  `liveRun.maxTestFilesPerEdit`. Unsaved files must exist on disk (untitled buffers run on save only).
- **Debug** → launches a fresh `jest --runInBand` under js-debug; breakpoints in TS need the project's source
  maps (babel-jest/ts-jest default). `hyperjest.debug.saveBeforeDebug` (default true) saves dirty files first.
- **Warm engine degraded** (`ready.seams` has `false`) → a private Jest seam (`requireAndTranspileModule`,
  `_getTransformer`, `_cache.transformedFiles`) is missing in that Jest version; HyperJest still works with
  file-level coverage. `hyperjest.engine: cli` forces the public-CLI path for everything.
- **"No tests found" / files never match a project** → Jest compares paths against the *real* path of `rootDir`.
  Open the workspace through its real path (not a symlink such as `/tmp` → `/private/tmp`); `Show Resolved Jest
  Config` shows the `rootDir` Jest resolved.
- **Gutter icons missing** → VS Code's own test gutter (`testing.gutterEnabled`) owns declaration lines when
  `hyperjest.gutter.testDeclarations` is `auto`; coverage squares need `hyperjest.coverage.enabled`.

Local projects are optional validation inputs only. Supply their paths at invocation time; keep their
names, paths, source, and reports out of this repository. The discovery report defaults to the current
directory; repeat `--repo` to inspect multiple directories. The parser corpus test skips when
`HYPERJEST_CORPUS_ROOTS` is unset and reports invalid or missing configured directories as errors.

## Verification checklist (before a release)

1. `yarn build && yarn test && yarn test:it` green.
2. `yarn package`; `code --install-extension hyperjest.vsix --force`; reload.
3. Open a test in a project with installed dependencies → green squares in the
   test and source files; break an `expect` → red line + Problems entry; `console.log` inline;
   Debug Line Test hits a breakpoint; Update Test Snapshots writes `__snapshots__`.
4. Repeat with Jest 29 and 30, `@jest-environment` docblocks, a React Native project and a project with a
   script-selected config. A project without installed Jest shows `unavailable` with an install hint;
   non-Jest test scripts are ignored.

## Release steps

`yarn version patch` (updates `package.json` and `yarn.lock`), update `CHANGELOG.md`, `yarn package`, test the `.vsix` on one
repo, commit `package.json`, `yarn.lock`, `CHANGELOG.md`, docs; distribute `hyperjest.vsix`.
