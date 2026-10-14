# HyperJest

![Test line coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fguyca%2Fhyper-jest%2Fcoverage-badge%2Fcoverage.json)

HyperJest is a VS Code extension that runs your project's own Jest and shows test feedback as you code.

- **Run the tests that matter.** HyperJest uses per-test coverage to rerun affected tests as you type or save.
- **Spot coverage and failures.** Gutter marks show coverage, and failures appear inline.
- **Inspect live values.** `console.log` output and `//?` values appear beside your code.

## See it in action

See which lines your tests cover and inspect runtime values without leaving the editor. Gutter marks show coverage, `//?` comments reveal expression values, and `console.log` output appears beside the code that produced it. Test Explorer keeps test results in view.

![Coverage marks, live values, and inline console output alongside passing tests in Test Explorer](.github/media/coverage-and-live-values.jpg)

Find failures where they happen. HyperJest highlights failing assertions and the code paths they execute. Use **HyperJest: Show Line Details** to compare expected and actual values, rerun or debug the test, or open the diff.

![Highlighted failure path and assertion details with expected and actual values and actions to run, debug, or show the diff](.github/media/failure-details.jpg)

## Install from source

You need Node.js 22 or later, Yarn 4.18.0, VS Code 1.134 or later, and the VS Code `code` command on your PATH. From the repository root:

```bash
yarn install --immutable
yarn install-extension
```

The last command builds HyperJest and installs the VSIX. In VS Code, run **Developer: Reload Window**. Open a project with Jest installed in its package; HyperJest discovers its Jest configuration and starts eligible tests automatically. Use **HyperJest: Select Configurations** if you have multiple packages or configurations.

For configuration options, see [Configuration](docs/configuration.md). For build and troubleshooting commands, see the [maintainer guide](CLAUDE.md).

## Jest compatibility

HyperJest guarantees the latest three stable Jest majors, currently **28, 29, and 30**. CI exercises pinned versions of each major and every proposed Jest dependency update through both the warm worker and CLI engines. Older versions may continue to work but are outside the tested guarantee. Prereleases are not included.

The versions used by CI are recorded in [the compatibility policy](scripts/jest-compatibility.json). For the automatic Dependabot repair and release process, see [release automation](docs/release-automation.md).

HyperJest is released under the [MIT license](LICENSE.md).
