# Changelog

## 0.3.0

- Run affected tests after 500 ms without typing, coalesce edits per project, and continue remaining affected files automatically in bounded batches.
- Fix missed reruns and stale results when coverage is incomplete or edits overlap active test runs.
- Publish merged version-bump PRs automatically after master CI passes, with generated GitHub release notes and retained artifacts for retries.

## 0.2.1

- Fix the Marketplace icon dimensions and add HyperJest branding to the README.
- Allow manually requested releases of merged version bumps through the validated Marketplace publishing workflow.

## 0.2.0

- Repair compatibility with Jest 30.5.2 (PR #30); guaranteed Jest majors: 28, 29, 30.

## Unreleased

- Run affected tests when files change on disk outside VS Code (AI agents, git, other editors), including reloaded open files in on-save mode. New setting `hyperjest.runOnExternalChanges` (default on).
- Project discovery now uses ordinary Jest resolution and explicit project configuration for custom tooling. Removed vendor-specific integrations and defaults.
- Development fixtures, documentation, and validation tools are portable. External parser validation requires explicitly supplied directory paths.

## 0.1.0

- Initial release: multi-core Jest runner with gutter coverage, inline errors/values, Test Explorer integration, on-type/on-save runs, debugging and snapshot commands.
- Hardening from an adversarial review: run groups always settle on cancel/merge/supersede, warm runs have a watchdog (`runTimeoutMs`), Stop really stops (no implicit worker boots), run completion closes every pending file, hover/code-lens/Test Explorer menu targets are honoured, single `Esc` clears line values, colour changes recreate gutter icons, code lenses refresh, Clear Caches also resets learned matchers.
- Discovery: a non-Jest sibling no longer claims test files, script path filters are honoured, cached matchers are invalidated by config edits (mtime + size), config-learning boots start no hot spare.
- CLI engine: stderr is drained, runs settle on `close` (2 s grace after `exit`), ts-jest coverage is source-mapped, overlay manifests live in a private 0700 session directory and are removed after each run.
- Editor: decorations follow unsaved line insertions/deletions until the next run lands; the last good parse is kept while a file has a syntax error.
