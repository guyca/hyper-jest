# Changelog

## 0.1.0

- Initial release: offline, multi-core Jest runner with Wallaby-style gutter coverage, inline errors/values, Test Explorer integration, on-type/on-save runs, debugging and snapshot commands.
- Hardening from an adversarial review: run groups always settle on cancel/merge/supersede, warm runs have a watchdog (`runTimeoutMs`), Stop really stops (no implicit worker boots), run completion closes every pending file, hover/code-lens/Test Explorer menu targets are honoured, single `Esc` clears line values, colour changes recreate gutter icons, code lenses refresh, Clear Caches also resets learned matchers.
- Discovery: a non-Jest sibling no longer claims test files, script path filters are honoured, cached matchers are invalidated by config edits (mtime + size), config-learning boots start no hot spare.
- CLI engine: stderr is drained, runs settle on `close` (2 s grace after `exit`), ts-jest coverage is source-mapped, overlay manifests live in a private 0700 session directory and are removed after each run.
- Editor: decorations follow unsaved line insertions/deletions until the next run lands; the last good parse is kept while a file has a syntax error.
