# HyperJest

![Test line coverage](media/coverage.svg)

Offline, license-free, multi-core Jest test runner for VS Code with Wallaby-style real-time feedback:
gutter coverage indicators, inline failure messages, inline `console.log` / `//?` live values, native Test
Explorer integration, on-type / on-save incremental runs, debugging and snapshot commands.

HyperJest never opens a network connection. It runs your project's own Jest, transformers and
`node_modules` in a pool of worker processes sized to your CPU cores.

Source-function body edits rerun only the tests that executed those functions when reliable per-test
coverage is available. Skipped tests retain their coverage history across edits. Changes to module
initialization or shared setup, structural edits, and incomplete coverage use broader selection.

### Configurations

HyperJest discovers `hyperjest.config.js`, `hyperjest.<name>.config.js`, and Jest configs within each
package. The default `hyperjest.config.js` is selected automatically. Use **HyperJest: Select
Configurations** from the command palette or HyperJest menu to choose a package and check the configs
to run. The picker shows package-relative paths, active/default state, and configuration errors.
Additional configs are opt-in, so an integration config stays inactive until selected.

A native HyperJest config adds scope and runtime settings to Jest:

```js
module.exports = {
  jestConfig: './jest.config.js',
  tests: ['tests/unit/**/*.test.ts'],
  files: ['src/**/*'],
  env: { NODE_ENV: 'test' },
  nodeArgs: ['--max_old_space_size=4096'],
};
```

All fields are optional. `jestConfig` and glob patterns resolve relative to this file. Without
`jestConfig`, Jest uses its normal package configuration. `tests` is an additional filter on Jest's
resolved test scope; it cannot include files Jest excludes. Omitting it keeps Jest's scope, while
`tests: []` runs nothing. `files` limits source monitoring and coverage reporting, while modules outside
that list can still be imported. Omitting `files` keeps the existing scope. Negated patterns such as
`!tests/integration/**` always exclude matches, regardless of pattern order. Globs do not match hidden
files unless the pattern explicitly names them. CommonJS objects/factories and ESM `export default`
objects/factories are supported; factories receive no runtime API argument. Configs load in a separate
process using the project's Node runtime, with a 10-second timeout.

HyperJest also discovers `wallaby.js` and `wallaby.<name>.js` and creates the corresponding sibling
`hyperjest.config.js` or `hyperjest.<name>.config.js` once. Imports support Jest config references, string
patterns, `{ pattern, ignore }` entries, literal environment assignments and Node arguments. Exclusions
follow [Wallaby's pattern rules](https://www.wallabyjs.com/docs/config/files/). Unsupported options,
hooks, runtime APIs, or unreadable scope produce a configuration error without creating a partial
config or falling back to a broader default. Full Wallaby runtime compatibility is outside this version.

Generated files are independent: edit them normally. HyperJest never overwrites an existing native
config, and later Wallaby edits do not update it. Discovery respects package boundaries and
`hyperjest.discovery.exclude`.

Selections are saved in workspace settings:

```json
{
  "hyperjest.projects": [{
    "packageDir": "packages/my-agent",
    "configFiles": ["hyperjest.config.js", "jest.integration.config.js"]
  }]
}
```

An omitted `configFiles` list selects automatically; an empty list disables execution for that package.
Use `"<implicit>"` for a package without a physical Jest config. Selection precedence is: package
`disabled`, explicit `configFiles`, legacy `configArg`, `hyperjest.config.js`, then the primary test
script/config. Script priorities are `test`, `test:js`, `test:unit`, then other test scripts, with command
order breaking ties. `discovery.preferScriptConfigs: false` preserves the preference for the package's
implicit Jest config when no native default or explicit selection exists. Missing explicitly selected
configs remain errors with no fallback. Saving the picker replaces a legacy `configArg` pin and keeps
its environment and Node overrides. The old **Select Jest Project for Current File** command opens this picker.

Each selected config has its own Test Explorer branch, test results, coverage contributions, and
affected-test tracking. Run All, editor runs, and live runs execute matching tests under every selected
config; Explorer actions target their branch. Editor feedback retains failures from any config and
labels config-specific failures and values. Debugging an ambiguous editor test asks which config to
use. Snapshot-writing runs for the same test file are serialized. Config edits and selection changes
cancel obsolete work, recycle affected workers, and refresh results without reloading VS Code.

### Custom project setup

Jest must be installed where it resolves from the package being tested. HyperJest follows that Jest
installation's dependency chain so hoisted packages from another Jest version are not mixed in.
Custom test tools are not automatically interpreted. Supply their required Jest config, environment,
Node arguments, and file patterns in `hyperjest.config.js` or the existing workspace settings.

End-to-end exclusions default to `**/e2e/**` and `**/*.e2e.*`. Set
`hyperjest.discovery.e2ePatterns` for additional directory conventions; configuration contents and
third-party preset names do not determine these exclusions.

### Startup

`hyperjest.smartStart` now defaults to `"always"`: after import and config selection, all eligible tests
under active configs run automatically. Explicit `"open"` (opened test files) and `"never"` settings
remain supported. Manual run mode and stopped state prevent automatic runs.

To build from source, use Node ≥ 22 and the Yarn version pinned in `package.json`:

```bash
corepack enable
corepack install
yarn install --immutable
yarn build
yarn test
```

Fresh installs use the public npm registry.

`yarn install` sets up a pre-commit hook that strips registry-specific tarball URLs from staged
`yarn.lock` changes. Run `yarn sanitize:lockfile` to sanitize it manually; CI checks that these URLs
are absent before installing dependencies.

The coverage badge refreshes automatically after each merge or push to `master`, once the unit tests
pass. GitHub Actions commits the updated badge only when its value changes. Repository branch rules
must allow the Actions bot to push this update to `master`.

Run `yarn test:coverage` to measure line coverage across `src/` and refresh the badge locally. The
detailed report is in `coverage/index.html`.

See `CLAUDE.md` for build, update and troubleshooting commands and `WALLABY_FEATURE_ANALYSIS.md` for the
feature research and parity mapping.
