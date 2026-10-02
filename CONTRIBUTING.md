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
