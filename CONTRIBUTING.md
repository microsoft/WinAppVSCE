# Contributing to WinApp VS Code Extension

Thanks for your interest in contributing to the WinApp VS Code Extension.

## Prerequisites

- Node.js 24
- Visual Studio Code
- PowerShell 7 or Windows PowerShell for the build scripts
- [WinApp CLI](https://github.com/microsoft/WinAppCli) (for syncing manifest schemas)

## Setup

After cloning the repository, restore the Windows SDK packages and sync the
AppxManifest XSD schema files:

```powershell
winapp restore
npm run sync-schemas
```

This downloads `Microsoft.Windows.SDK.BuildTools` and `Microsoft.Windows.SDK.CPP`
to the NuGet package cache and copies the required XSD files into `schemas/`.
The schema files are not checked into the repository — they are derived from
the SDK versions pinned in `winapp.yaml`.

## Build

From the repository root, run:

```powershell
.\scripts\build-vsce.ps1
```

This installs dependencies, compiles the extension, runs linting, and runs unit tests.

## Test

Run the existing test suites from the repository root:

```powershell
npm run test:unit
npm run test:e2e
```

### Keeping up with the WinApp CLI

`npm run download-cli:latest` bundles the latest stable `winapp` release into `bin/`.
The extension's `winapp run` surface is checked against that binary's own
`--cli-schema` output by `src/test/run-cli-contract.test.ts`, using the generated
fixture `src/test/fixtures/run-cli-schema.json`.

Never hand-edit that fixture. When the CLI adds, removes, or renames a `run`
option, regenerate it:

```powershell
npm run download-cli:latest
npm run sync-run-schema     # rewrites the fixture from the bundled CLI
npm run verify-run-schema   # -Check mode: fails if the two have drifted
```

Then surface any new option in `src/run-options.ts`, `src/run-utils.ts`, and the
`launch.json` contribution in `package.json` — the contract test enumerates all
three and will fail until they agree. The contract tests skip themselves when
`bin/` holds no CLI, so a local run without one stays green; CI downloads the
CLI before `npm run test:unit`, so drift is caught there.

## Package

To produce a VSIX package locally:

```powershell
.\scripts\build-vsce.ps1 -Package
```

## Install locally

After packaging, install the VSIX into VS Code:

```powershell
code --install-extension artifacts\winapp-*.vsix
```

## Pull requests

- Follow the checklist in [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md).
- Include tests and documentation updates when your change affects behavior or contributor workflows.
- Prefer focused PRs that are easy to review.

## Code of Conduct

This project follows the Microsoft Open Source Code of Conduct. For more information, see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
