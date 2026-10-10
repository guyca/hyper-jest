# HyperJest

Offline, license-free, multi-core Jest test runner for VS Code with Wallaby-style real-time feedback:
gutter coverage indicators, inline failure messages, inline `console.log` / `//?` live values, native Test
Explorer integration, on-type / on-save incremental runs, debugging and snapshot commands.

HyperJest never opens a network connection. It runs your project's own Jest, transformers and
`node_modules` in a pool of worker processes sized to your CPU cores.

Source-function body edits rerun only the tests that executed those functions when reliable per-test
coverage is available. Skipped tests retain their coverage history across edits. Changes to module
initialization or shared setup, structural edits, and incomplete coverage use broader selection.

See `CLAUDE.md` for build, update and troubleshooting commands and `WALLABY_FEATURE_ANALYSIS.md` for the
feature research and parity mapping.
