# Packaging & release-impact review

You are reviewing a PR diff for the `microsoft/WinAppVSCE` repo and asking:
**does this change affect packaging, release artifacts, or the shipped
extension surface?** Apply the shared output contract in
`_shared-contract.md`. Set `Domain: packaging` on every finding.

## Distribution surfaces

This repo ships a standalone VS Code extension and bundles external binaries that
must stay in sync:

| Artifact | Source | Notes |
|----------|--------|-------|
| Extension source | `src/` | Compiled and bundled into `dist/extension.js` |
| VSIX metadata | `package.json`, `.vscodeignore`, `README.md` | Controls contribution points and published package metadata |
| Bundled CLI binaries | `bin/`, `scripts/download-cli.ps1` | Extension packages WinApp CLI for x64/arm64 |
| Packaging scripts | `scripts/build-vsce.ps1`, `scripts/package-vsc.ps1` | Canonical local build/package entry points |
| CI / release automation | `.github/workflows/`, `.pipelines/release-vsc.yml` | Build, signing, and marketplace publication |

## What to look for

- **New command/debug/custom-editor surface** without matching updates to
  `package.json` contributions or activation events.
- **Dependency changes** in `package.json` without the corresponding
  `package-lock.json` update.
- **Bundled CLI flow drift.** Changes to CLI download, bundling, architecture
  layout, or executable naming that do not stay consistent across scripts,
  README guidance, and packaging steps.
- **Versioning inconsistencies.** Edits that change how the extension version,
  prerelease stamping, or bundled CLI version is surfaced without updating the
  related scripts.
- **Release pipeline impact.** Changes to artifact names, output paths,
  marketplace publishing, signing, or release-branch assumptions that should be
  reflected in `.github/` workflows or `.pipelines/release-vsc.yml`.
- **Breaking changes.** Renamed commands, removed activation events, changed
  debugger IDs, changed custom-editor view types, or moved bundled binaries that
  would break existing users or release automation.
- **Build entry points.** `scripts/build-vsce.ps1` and `scripts/package-vsc.ps1`
  are the canonical flows — flag new packaging steps that bypass them without
  integration.
- **Published artifact hygiene.** New large directories, reports, or dev-only
  files accidentally included in the package surface.

## What to drop

- Suggestions to bump the version number unless the diff is clearly a release.
- Asking for new packaging artifacts that are outside the current VSIX-based
  distribution model.

## Severity guide for this dimension

- Missing `package.json` contribution/activation update that breaks a shipped
  feature → high.
- Dependency manifest changed without lockfile update → medium.
- Release or packaging script drift that can break VSIX creation/publishing →
  high.
- Accidental package-surface bloat or hygiene issue → medium.
