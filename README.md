# HyperJest

![Test line coverage](.github/media/coverage.svg)

HyperJest is a VS Code extension that runs your project's own Jest and shows test feedback as you code.

- **Run the tests that matter.** HyperJest uses per-test coverage to rerun affected tests as you type or save.
- **Spot coverage and failures.** Gutter marks show coverage, and failures appear inline.
- **Inspect live values.** `console.log` output and `//?` values appear beside your code.

## Install from source

You need Node.js 22 or later, Yarn 4.18.0, VS Code 1.134 or later, and the VS Code `code` command on your PATH. From the repository root:

```bash
yarn install --immutable
yarn install-extension
```

The last command builds HyperJest and installs the VSIX. In VS Code, run **Developer: Reload Window**. Open a project with Jest installed in its package; HyperJest discovers its Jest configuration and starts eligible tests automatically. Use **HyperJest: Select Configurations** if you have multiple packages or configurations.

For configuration options, see [Configuration](docs/configuration.md). For build and troubleshooting commands, see the [maintainer guide](CLAUDE.md).

HyperJest is released under the [MIT license](LICENSE.md).
