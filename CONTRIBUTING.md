# Contributing to WinApp VS Code Extension

Thanks for your interest in contributing to the WinApp VS Code Extension.

## Prerequisites

- Node.js 24
- Visual Studio Code
- PowerShell 7 or Windows PowerShell for the build scripts
- The [.NET 10 SDK](https://dotnet.microsoft.com/download) — required to build, test, and locally bundle the WinUI XAML language server (`server/`). Packaged extension users receive a self-contained server and do not need this SDK. The unit tests (`npm run test:unit`) do not need it, but the server tests, the XAML integration/smoke suites, and local packaging do.
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

`npm run test:unit` and `npm run test:e2e` do not require the .NET SDK.

The WinUI XAML language service has its own suites, which **require the .NET 10 SDK** (see [Prerequisites](#prerequisites)):

```powershell
npm run test:server      # .NET xUnit tests for the language server
npm run test:xaml-smoke  # stdio LSP smoke test
npm run bundle:server
npm run test:xaml-self-contained # smoke the published native apphost
npm test                 # VS Code integration tests (drives the real extension + server)
```

`npm test` runs a `pretest` step that compiles, lints, builds the language server, and restores the test fixture — so it needs the .NET SDK. `test:xaml-self-contained` runs the already-published apphost and does not use a machine runtime to launch the server. On a machine without the SDK, run `npm run test:unit` instead; build-dependent suites fail fast with a clear "dotnet not found" error rather than silently skipping.

## Package

To produce a VSIX package locally:

```powershell
.\scripts\build-vsce.ps1 -Package
```

Local packaging publishes fresh self-contained `win-x64` and `win-arm64` servers from source. The
official release pipeline instead downloads the separately built and ESRP-signed server artifact.

## Install locally

After packaging, install the VSIX into VS Code:

```powershell
$vsix = Get-ChildItem artifacts\winapp-*.vsix | Sort-Object LastWriteTime -Descending | Select-Object -First 1
code --install-extension $vsix.FullName
```

## Pull requests

- Follow the checklist in [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md).
- Include tests and documentation updates when your change affects behavior or contributor workflows.
- Prefer focused PRs that are easy to review.

## Code of Conduct

This project follows the Microsoft Open Source Code of Conduct. For more information, see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
