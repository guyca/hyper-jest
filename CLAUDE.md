# HyperJest — maintainer guide (works fully offline)

HyperJest is a VS Code extension that runs a project's **own** Jest in a pool of warm worker
processes and paints Wallaby-style results in the editor: gutter coverage squares, inline failure
messages, inline `console.log` / `//?` live values, Problems entries, a status bar item and a native
Test Explorer. It never opens a network connection. See `WALLABY_FEATURE_ANALYSIS.md` for the
feature research and parity mapping.

## Hard rules

- **Zero network at runtime.** No telemetry, update checks, license checks, `fetch`, `http(s)`, `net`,
  `dns`, `tls`, `WebSocket`. `npm run check:no-network` greps `dist/` for these and can `lsof` a running
  extension host.
- **Never load Jest in the extension host.** Jest, Babel, ts-jest and project configs are loaded only inside
  worker processes (`src/worker/*`) or spawned CLI processes. Loading a config in the host would run
  side effects (shono's `jestConfig.js` patches `node_modules`) and block the UI.
- **Resolve Jest by chain from the project's `jest` package** (`jest -> jest-cli -> @jest/core -> jest-config /
  jest-runtime / jest-runner / ...`). Never use `node_modules/.bin/jest` and never resolve Jest packages from
  the repo root: hoisting mixes versions (mobile-modules root `.bin/jest` is 30.2 while the effective chain
  is 29.7; mobile-apps-engine hoists `jest-config` 29.7 while `jest` is 30.4.2).
- **No `vscode` import under `src/core/` or `src/worker/`.** Those directories are pure Node and unit-tested
  with Jest (`tests/unit`). Only `src/*.ts` and `src/discovery/*`, `src/results/*` UI files may import `vscode`.
- **Never bundle Jest/Babel into the worker bundles.** `esbuild.mjs` bundles only HyperJest code (plus
  `@babel/parser` for static test discovery); every Jest module is `require`d at runtime by absolute path.
- Never run `npx` (it may reach the network). Use the local `node_modules/.bin` via npm scripts.
- Only `@types/vscode` ≤ `engines.vscode` (major.minor) is accepted by vsce. Bump both together.

## Toolchain

- Node ≥ 22 (this machine: `fnm use 24.19.0`), npm 11. Dependencies are exact-pinned in `package.json`.
- `.npmrc`: `registry=https://npm.dev.wixpress.com/` (the public registry is blocked here), `save-exact`,
  `ignore-scripts` (esbuild's binary comes from the optional `@esbuild/darwin-arm64` package, keytar's network
  postinstall never runs), no audit/fund/update-notifier.
- Installing/building **may** use the Wix registry. Using the installed `.vsix` never does.

## Commands

```bash
npm install                 # one-time (or after changing package.json) — needs the Wix registry
npm run build               # type-check (host, worker and test tsconfigs) + production bundles into dist/
npm run build:dev           # fast dev bundles with source maps
npm run watch               # rebuild on change (used by .vscode/launch.json "Run HyperJest (dev host)")
npm test                    # HyperJest's own unit tests (jest 29.7 + ts-jest, ~420 tests, no vscode)
npm run test:it             # gated integration tests: real jest 29.7 driven through the worker/reporter
npm run package             # build + vsce package -> hyperjest.vsix (no network needed by vsce flags)
npm run install-extension   # package + code --install-extension hyperjest.vsix --force
npm run check:no-network    # static scan of dist/ (+ lsof of a running extension host when given a pid)
```

Rebuilding offline later: `npm ci --offline` works while `~/.npm/_cacache` still has the tarballs; otherwise
symlink the dependency closure from `/Users/guyc/workspace1/mobile-apps-relops-automations/node_modules`
(same versions of vsce, esbuild, typescript, @types/vscode, jest, ts-jest).

Install into VS Code: `code --install-extension hyperjest.vsix --force`, then **Developer: Reload Window**.

## Repository map

```
src/extension.ts            activate(): composes everything below (no logic)
src/settings.ts, log.ts     hyperjest.* settings -> core/settingsModel; LogOutputChannel "HyperJest"
src/workerPool.ts           N = max(1, cpus-1) warm workers; per-project caps, memory budget, hot spare, recycle, overlay replay
src/runner.ts               RunCoordinator: queue/priorities/generations, warm or CLI dispatch, on-type/on-save affected runs,
                            Smart Start, continuous runs, snapshots, debug, cancel; implements src/runnerApi.ts
src/discovery/              packageScanner (findFiles), projectRegistry (file->project, readiness, toolchain invalidation), configCache
src/core/                   PURE: protocol.ts (host<->worker messages), projectSpec/scriptSniffer/shono/jestResolver/nodeResolver
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

1. Online: `npm install <pkg>@<exact>` (save-exact is on). 2. Run `npm run build && npm test`. 3. Commit
`package.json` + `package-lock.json`. For `@types/vscode`, bump `engines.vscode` to the same major.minor.
Worker bundles must stay Jest-free: check with `grep -c "node_modules/jest" dist/worker/*.cjs` (expect 0).

## Troubleshooting (all offline)

- **Output channel**: View → Output → "HyperJest". Set `hyperjest.trace: true` for worker-level detail; the
  channel's log level can be raised with "Developer: Set Log Level…".
- **HyperJest: Doctor** — per-package classification (flavor, status, reason + fix), Jest/Node resolution, worker
  state and bootstrap time, `ready.seams` (false = degraded feature), memory. **HyperJest: Copy Diagnostics
  Report** puts the same text on the clipboard.
- **HyperJest: Show Resolved Jest Config** — the ProjectSpec, Jest's `--showConfig` output and the exact shell
  command HyperJest runs. Paste that command in a terminal to compare with plain Jest.
- **From a terminal, without VS Code** (after `npm run build:dev`):
  ```bash
  node scripts/worker-driver.mjs init --pkg <packageDir> [-c <config>] [--node <node>] [--env K=V]
  node scripts/worker-driver.mjs run <test file> --pkg <packageDir> --repeat 2
  node scripts/worker-driver.mjs show-config --pkg <packageDir>
  node scripts/discovery-report.mjs --repo /Users/guyc/workspace1/<repo> --show-warnings
  ```
- **Nothing runs for a package** → Doctor: `unavailable` means `jest` does not resolve from the package (run the
  repo's `yarn install`); `notJest` means the test script is not Jest (node --test, mocha, detox); `unsupported`
  means Jest < 29. Force a spec with `hyperjest.projects: [{ "packageDir": "...", "configArg": "..." }]`.
- **Wrong tests / wrong config picked** → the registry prefers configs named by `package.json` test scripts
  (`jest -c x`, `shono testjs`) over implicit `jest.config.*`; `hyperjest.discovery.preferScriptConfigs: false`
  flips that. Shono packages run `<shono-testjs>/dist/src/jestConfig.js` with shono's env and `NODE_PATH`; the
  first load runs shono's idempotent `patchFiles()` into that repo's `node_modules`, exactly like `shono testjs`.
- **"Multiple configurations found"** → a package has both `jest.config.*` and a `package.json` `jest` key. Jest
  itself refuses this; HyperJest reports it unless a script/shono config wins.
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

## Verification checklist (before a release)

1. `npm run build && npm test && npm run test:it` green.
2. `npm run package`; `code --install-extension hyperjest.vsix --force`; reload.
3. With Wi-Fi off: open `mobile-apps-relops-automations/.../tests/unit/jsonlWriter.test.ts` → green squares in the
   spec and in `src/**/jsonlWriter.ts`; break an `expect` → red line + Problems entry; `console.log` inline;
   Debug Line Test hits a breakpoint; Update Test Snapshots writes `__snapshots__`.
4. Same on `delay-of-game` (jest 30.5.2, `@jest-environment` docblocks), `mobile-apps-engine` (30.4.2, RN) and a
   `mobile-modules` shono package. `branded-apps` shows `unavailable` with the yarn hint; `appium-tests` is ignored.
5. `npm run check:no-network <extension host pid>` → no sockets from HyperJest or its workers.

## Release steps

`npm version patch` (updates `package.json`), update `CHANGELOG.md`, `npm run package`, test the `.vsix` on one
repo, commit `package.json`, `package-lock.json`, `CHANGELOG.md`, docs; distribute `hyperjest.vsix`.
