# Results layer and UI surfaces

Everything between the worker protocol (`src/core/protocol.ts`) and what the user sees. Two pure
modules hold the state and its projections; the rest are thin VS Code adapters that read from them.

| File | Role | `vscode`? |
|---|---|---|
| `src/results/resultStore.ts` | `ResultStore`: tests, files, coverage, loadedBy/execBy, inline console/value entries, stale marks, run generations; coalesced change event | no |
| `src/results/lineView.ts` | `computeLineView` / `LineViewCache` (per-line gutter state + inline text), `inlineTextFor`, `matchRecordsToNodes` (runtime results ↔ parsed tree, over `core/testIds`), `wordDiff` / `compactDiff` | no |
| `src/iconAssets.ts` | `IconAssets`: writes the gutter SVGs for the current `hyperjest.colors.*` into a directory | no |
| `src/runnerApi.ts` | `RunnerApi`: the contract the surfaces call to run/debug/cancel (implemented by `runner.ts`) | no |
| `src/decorations.ts` | `DecorationManager`: gutter + inline decoration types, `apply(editor, view)` | yes |
| `src/contextKeys.ts` | `ContextKeys`: `setContext` arrays/flags for menus and the Esc keybindings | yes |
| `src/diagnostics.ts` | `DiagnosticsPublisher`: Problems entries per test file | yes |
| `src/hover.ts` | `HyperJestHoverProvider`: trusted Markdown hover with command links | yes |
| `src/statusBar.ts` | `StatusBar`: `hyperjest.status` item | yes |
| `src/testTree.ts` | `TestExplorer` (controller `hyperjest`, 4 profiles, lazy tree) + `LiveRunPublisher` | yes |
| `src/codeLens.ts` | `TestCodeLensProvider` (off by default) | yes |
| `src/diffView.ts` | `DiffContentProvider` for `hyperjest-diff:` virtual docs (`vscode.diff`) | yes |
| `src/doctorView.ts` | `DoctorContentProvider` + `renderDoctorReport` for `hyperjest-doctor:report.md` | yes |

Unit tests: `tests/unit/results/*.test.ts` (pure modules directly; UI modules through
`tests/unit/results/fakeVscode.ts`, installed per file with `jest.mock('vscode', () => require('./fakeVscode'))`).

## ResultStore

`new ResultStore(opts?)` — `opts.coalesceMs` (default 16), `setTimer`/`clearTimer`/`now` (injectable
for tests), `maxEntriesPerLine` (inline entries kept per file/line/generation, default 50).

### Intake

`apply(msg: WorkerToHost, projectId: string)` — call for **every** message a project's worker
sends (after the host dropped messages whose `runId` is not the current generation, if it does its
own filtering; the store also drops data of superseded in-flight runs of the same file). Message
semantics:

| Message | Effect |
|---|---|
| `fileStart` | file → `running`; opens the run generation `(runId, path)` |
| `testStart` | remembered in `started(path)` (Explorer shows the spinner on that item) |
| `testResult` | commits the `TestRecord` immediately (live UI) plus any per-test coverage / tagged console / value entries that arrived earlier. In a **narrowed** run (`names`), de-selected tests arrive as `pending`; their previous result is kept |
| `testCoverage` | per-test statement/function hits bound to their source revision; stashed until the test's result, merged if it arrives later |
| `fileLoad` | loaded sources plus initialization/shared-hook function hits and tracking completeness; committed at `fileResult` |
| `coverageMeta` | immutable statement/branch/function shape plus compiled source text and revision identity; arrival never wipes skipped tests' hits |
| `fileCoverage` | file-level union hits; committed at `fileResult` into `stmtHitByFile` / `branchArmHitByFile` |
| `console` / `value` | inline entries keyed by `(file, line-1)`; tagged ones wait for their test, untagged ones for `fileResult`. Entries without a `line` are dropped |
| `fileResult` | commits file-level data, replaces this test file's previous contributions (merged instead for narrowed runs), removes tests that an **unfiltered** run no longer reported, drops inline entries of older generations, clears stale marks set before the run started, records `lastRun(path)` |
| `runComplete` | files of the run that never got a `fileResult`: discarded if `wasInterrupted`, otherwise turned into an `errored` file with a `testExecError` (`error` text) |
| everything else (`ready`, `initError`, `log`, `pong`, `graphResult`, …) | ignored |

### Run bookkeeping (RunCoordinator)

- `registerRun(runId, tests: RunTestSelection[])` — **before** sending `run`: tells the store which
  files are narrowed (`names`). Unregistered runs count as unfiltered (deleted tests are pruned).
- `markQueued(path, projectId?)` — when the file enters the queue (status `queued`).
- `markRunning(path, { runId, names?, projectId? })` — optional; `fileStart` does the same.
- `abortRun(runId)` — a worker died: pending data of the run is discarded and file statuses restored.
- `markStale(path, changedLines?)` — on every edit of a test or source file (0-based lines; omit for
  the whole file). Results stay but render hollow until a run started after the mark commits.
  `clearStale(path)` after an undo / revert.
- `setParsed(path, parsed: ParsedFile)` — whenever the file is (re)parsed; declaration and snapshot
  lines come from here. `TestExplorer.setFileParsed` calls it for you.
- `clearFile(path)` / `clearProject(projectId)` — file deleted / project removed or invalidated.
- `clearInlineEntries(path, line?)` — the `hyperjest.clearValues` (Esc) / `clearFileValues` (Esc Esc) commands.

### Getters

`fileRecord(path)`, `test(testKey)`, `testsInFile(path)` (declaration order), `failingTests()`,
`summary()` (`{passed, failed, pending, running, queued, staleFiles}`), `execBy()` (source →
testKeys), `loadedBy()` (source → test files), `coverageFor(source)`, `coveredSourcesOf(testFile)`,
`sourceSelection(path, text)` (function-level selection against each test's recorded revision),
`entriesFor(path)`, `parsed(path)`, `staleInfo(path)`, `lastRun(path)`, `started(path)`,
`allFiles()`, `allTests()`, `generation` (bumps on every mutation).

Keys: `testKey = path\0fullName\0dupIndex` (`makeTestKey` / `parseTestKey` in protocol.ts).
Runtime locations are 1-based (Jest); views and parsed ranges are 0-based (VS Code).

### Source revisions and affected selection

`CoverageHistory` retains the latest statement/function hits of each test against the exact source
returned by Jest's transform cache. Revision identity includes both source content and coverage
shape. New metadata is cached; only committed run data advances the display revision. Concurrent
workers cannot reinterpret one revision's IDs against another's maps.

For source edits, `sourceSelection(path, text)` compares each retained baseline with the new text.
Only edits inside corresponding function bodies with reliable original coordinates narrow tests.
Ordinary imports do not widen these selections when a complete run proves that initialization and
shared hooks did not call the edited function. `beforeEach`/`afterEach` remain attributed to their
tests; `beforeAll`/`afterAll` and execution between tests contribute whole-file dependencies.
Missing tracking, signatures/exports/structure changes, syntax errors and uncertain maps retain
conservative file selection, including the static graph and CLI fallback.

Skipped tests keep their original revisions. Unchanged statement ranges and branch arms are
projected into the displayed revision only when their matches are unique; ambiguous contributions
remain stale. Aggregate contributions are carried forward when possible, and unreferenced source
revisions are released once active runs finish. Failed loads and interruptions preserve prior
dependencies; successful unfiltered runs remove tests that disappeared.

### Change notification

`onDidChange(listener: (changedPaths: string[]) => void)` fires at most once per 16 ms with every
touched path (test files **and** source files whose coverage/entries changed). `flush()` delivers
synchronously (use before publishing coverage or in tests); `dispose()` drops listeners and the timer.

## Line view

`computeLineView(store, path, options?)` → `LineViewFile { lines: Map<line0, LineView>, declarations }`.
Per line: `state` = strongest of `errorSource` (a failing test's frame or `testExecError` points
here) > `errorPath` (executed by ≥1 failing test; spec body fallback when the spec is not instrumented)
> `partiallyCovered` (a statement or branch arm on the line never ran) > `covered` > `notCovered`;
`stale` (hollow icons), `snapshot` (camera), `entries` (error > value > log, first line, truncated
to `inline.maxLength`, full text kept in `longText`), `tests` / `failingTests` (per-test mode only).
`declarations` maps a declaration line to the aggregated status of the tests matched to that node.

`inlineTextFor(lineView, options)` gives the one after-text: an error beats a value beats a log;
values/logs joined with `, ` up to `inline.maxLogsPerLine` (`, … +N` for the rest), capped at
`inline.maxLength`. Options come straight from `settings.inline`.

`new LineViewCache(store, () => settings.inline)` memoises views per path; call
`cache.invalidate(changedPaths)` first thing in the store's change handler.

`matchRecordsToNodes(parsed, records, ids?)` is the node-keyed view of `core/testIds.reconcile`
(`byNode`, `byKey`, `unmatched`, `staticWithoutResult`, plus the raw `reconciled` entries).

## Wiring (what the integrator does)

### Order of initialisation

1. `settings = new Settings()`; `log = new OutputLogger()`.
2. `store = new ResultStore()`.
3. `icons = new IconAssets(path.join(context.globalStorageUri.fsPath, 'icons'), settings.get().colors)`;
   `await icons.ensure()` **before** creating the `DecorationManager` (the decoration types capture
   the icon paths; the files must exist when VS Code first paints them).
4. `views = new LineViewCache(store, () => settings.get().inline)`.
5. Surfaces: `decorations = new DecorationManager(icons, () => settings.get())`,
   `contextKeys = new ContextKeys()`, `diagnostics = new DiagnosticsPublisher(store, () => settings.get().reportFailuresAsProblems)`,
   `statusBar = new StatusBar(() => settings.get())`, `diff = new DiffContentProvider(store)`,
   `doctor = new DoctorContentProvider()`, `lenses = new TestCodeLensProvider(store, () => settings.get())`,
   `hover = new HyperJestHoverProvider(store, p => views.get(p))`.
6. Registrations: `workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diff)`, `…(DOCTOR_SCHEME, doctor)`,
   `languages.registerHoverProvider(HOVER_SELECTOR, hover)`, `languages.registerCodeLensProvider(HOVER_SELECTOR, lenses)`.
7. `runner` (RunCoordinator implementing `RunnerApi`), then, if `settings.testExplorer.enabled`,
   `explorer = new TestExplorer({ store, runner, settings: () => settings.get(), log, resolveChildren })`.
   `resolveChildren` is the lazy loader: `root` → `buildProjectItem(spec)` per discovered project,
   `project` → `setProjectFiles(projectId, paths)`, `file` → parse and `setFileParsed(projectId, path, parsed)`.
   Mark files a project's matcher rejects with `setFileNotMatched(path, true)`.
8. Push every object above (all are `Disposable`) into `context.subscriptions` — see disposal order.

### Store events → surfaces

One `store.onDidChange(paths => …)` handler, in this order:

```ts
views.invalidate(paths);
const open = vscode.window.visibleTextEditors.filter(e => e.document.uri.scheme === 'file' && paths.includes(e.document.uri.fsPath));
decorations.refreshAll(open, p => views.get(p));          // gutter + inline text
diagnostics.update(paths);                                 // Problems (test files only produce entries)
diff.onStoreChange(paths);                                 // open hyperjest-diff documents
lenses.refresh();                                          // if codeLens.enabled
statusBar.update({ summary: store.summary(), state: runner.getState() });
const active = vscode.window.activeTextEditor;
if (active && paths.includes(active.document.uri.fsPath)) {
  contextKeys.updateEditor(views.get(active.document.uri.fsPath), { isTestFile, isSourceFile }, active.selection.active.line);
}
```

`TestExplorer` subscribes to the store itself (reconciles items and feeds `LiveRunPublisher`); do
not publish Explorer results from the handler above.

Other triggers:

| Event | Call |
|---|---|
| `window.onDidChangeVisibleTextEditors` | `decorations.refreshAll(editors, p => views.get(p))` |
| `window.onDidChangeActiveTextEditor` | `contextKeys.updateEditor(view, flags, cursorLine)` (`undefined` view clears) |
| `window.onDidChangeTextEditorSelection` | `contextKeys.updateCursor(view, line)` |
| `workspace.onDidChangeTextDocument` | `store.markStale(path, changedLines)` (then the overlay/runner logic) |
| `workspace.onDidOpenTextDocument` / parse | `store.setParsed(path, parsed)` or `explorer.setFileParsed(...)` |
| `runner.onDidChangeState` | `statusBar.update({ summary: store.summary(), state })`, `contextKeys.updateRunState({ running, paused, runMode, started })` |
| `settings.onDidChange` | `decorations.onColorsChanged()` (await; recreates types when `colors.*` changed, then refresh editors), `diagnostics.refreshAll()` (gate toggled), `lenses.refresh()`, `views.invalidate()` + refresh editors (`inline.*`, `gutter.*`), `statusBar.update(...)` |
| `settings.testExplorer.enabled` toggled | dispose / create the `TestExplorer` |

Decorations read `testing.gutterEnabled` on every `apply` to decide whether HyperJest draws its own
declaration icons (`gutter.testDeclarations: auto`).

### Commands the surfaces invoke (register in commands.ts)

| Command | Argument | From |
|---|---|---|
| `hyperjest.runLineTests` | `{ path, line /*1-based*/, testKey? }` (`LineTarget`) | hover, code lens, gutter menu |
| `hyperjest.debugLineTest` | `LineTarget` | hover, code lens |
| `hyperjest.showLineDetails` | `LineTarget` | status code lens |
| `hyperjest.showDiff` | `{ testKey }` → `diff.showDiff(testKey)` | hover, Explorer message menu |
| `hyperjest.copyValue` | `{ path, line /*1-based*/ }` → copy the full `longText`s of that line's entries | hover |
| `hyperjest.openFrame` | `{ file, line, column }` (1-based) | hover stack links |
| `hyperjest.updateTestSnapshots` | `LineTarget` | hover (whitelisted) |
| `hyperjest.showMenu` | — | status bar click |
| `hyperjest.clearValues` / `clearFileValues` | — → `store.clearInlineEntries(path, line?)` | Esc / Esc Esc keybindings |

The hover's `MarkdownString.isTrusted = { enabledCommands: HOVER_COMMANDS }`, so only those
commands may be linked.

### Context keys set

`hyperjest.linesWithTestDeclaration`, `linesWithSnapshot`, `linesWithError`, `linesWithValues`,
`coveredLines` (1-based arrays for `editorLineNumber in …`), `hyperjest.isTestFile`,
`hyperjest.isSourceFile`, `hyperjest.lineHasInlineValues`, `hyperjest.fileHasInlineValues`,
`hyperjest.running`, `hyperjest.paused`, `hyperjest.runMode`, `hyperjest.started`. Unchanged values
are not re-sent.

### Test Explorer

- Tree: project (`label = displayName`, `description = flavor · jest x · node y`, `error` for non-ok
  projects) → file (`id = projectId\0relPath`, `canResolveChildren`) → describe/test items with ids
  from `core/testModel.parsedNodeId`.
- Reconciliation (`core/testIds.reconcile`): direct matches on the static item; `.each`/loop rows as
  children (`row:<label>`), runtime-only tests under the deepest matched describe with intermediate
  `describe:` items (description `runtime only`); after an unfiltered run, static tests without a
  result read `not registered`. Files without a parse get a runtime tree from `ancestorTitles`.
- Profiles: `Run` (default, `supportsContinuousRun` → `runner.watch(selections, token)`), `Debug`
  (`runner.debug(selection)` per file), `Run with Coverage` (`runner.runFiles` then
  `run.addCoverage(FileCoverage{includesTests})` for every source the files touched;
  `loadDetailedCoverage(ForTest)` served from `store.coverageFor`), `Update Snapshots`
  (`runner.updateSnapshots({ kind: 'selection', selections })`). Explicit runs use
  `settings.snapshots.updateMode` and `priority 0`; cancellation forwards to `runner.cancel(runId)`.
- `selectionsFor(items, exclude?)` / `testKeysFor(item)` are public for commands
  (`testing/item/context` menu entries).
- `LiveRunPublisher`: results for files covered by an active explicit run go to that run; everything
  else to a non-persisted `HyperJest live` run that ends ~500 ms after the store reports no running or
  queued files. Stale files trigger `invalidateTestResults(fileItem)` once.

### Disposal order

Dispose in reverse creation order: `explorer` (ends live/explicit runs, disposes the controller) →
`statusBar`, `lenses`, `hover` registrations, `diff`, `doctor`, `diagnostics` (clears the
collection), `contextKeys`, `decorations` (disposes every decoration type) → `views` (nothing to
dispose) → `store.dispose()` (drops listeners and the coalescing timer). Everything implements
`vscode.Disposable`, so pushing them into `context.subscriptions` in creation order is enough.
