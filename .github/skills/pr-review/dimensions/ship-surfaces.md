# Ship surfaces (docs, contributions, packaging)

You own one question for the `microsoft/WinAppVSCE` repo: **which shipped
surfaces does this observable change affect, and were those surfaces updated?**

Apply `_shared-contract.md`. Set `Domain: ship-surfaces`.

This is checklist work against a diff, not judgment work. If the change is
internal and user-invisible, none of it applies — say so and return clean.

## What ships

One VSIX (`publisher: Microsoft-WinAppCLI`, `name: winapp`) containing:

| Content | Source | Note |
|---------|--------|------|
| Extension bundle | `src/` → `dist/extension.js` | esbuild single bundle, only `vscode` external |
| Contribution manifest | `package.json` `contributes` + `activationEvents` | Commands, settings, menus, `winapp` debugger, `winapp.manifestEditor` custom editor |
| Bundled WinApp CLI | `bin/win-x64/winapp.exe`, `bin/win-arm64/winapp.exe` | Fetched by `scripts/download-cli.ps1` from `microsoft/WinAppCli` releases; not in git |
| Manifest XSDs | `schemas/*.xsd` | Synced by `npm run sync-schemas` from the SDK versions pinned in `winapp.yaml`; not in git, required by `vscode:prepublish` |
| Marketplace page | `README.md` | `package-vsc.ps1` stamps version info into it at package time |

`.vscodeignore` decides what is excluded; anything not listed there ships.

## Match the change to affected surfaces

- **New or renamed command** → `contributes.commands` (ID, title, `category`),
  any `menus` entry, and the
  README *Command Palette* list / *Scenarios* section.
- **New setting** → `contributes.configuration` with description and default,
  and README where users would look for it.
- **New or changed `launch.json` field** → `debuggers[0].configurationAttributes`,
  `initialConfigurations` / `configurationSnippets`, and README *Integrated
  Debugging*. The PR template's *Usage Example* expects a `launch.json` snippet.
- **Manifest editor or IntelliSense behavior** → README *AppxManifest Visual
  Editor* / *AppxManifest IntelliSense*, and the editor `selector` / title-bar
  `when` clause if manifest file patterns change.
- **New runtime dependency** → `dependencies` (bundled by esbuild) with a
  matching `package-lock.json`; dev-only tools go in `devDependencies`.
- **Changed contributor workflow** (prereqs, build, test commands) →
  `CONTRIBUTING.md`; release steps → `docs/RELEASE.md`.
- **New Microsoft Learn link in source** must be locale-neutral (no `en-us`
  segment). `src/test/docs-links.test.ts` checks this but is not in
  `test:unit`, so CI never runs it — run
  `npx tsx --test src/test/docs-links.test.ts` or check by hand.

Internal refactors need none of these. User documentation explains what to
click or type, what happens, and how to recover from failure; it never narrates
implementation details, review history, or review-round identifiers. Keep each
fact on one canonical surface and link to it elsewhere.

## Packaging specifics

- **Versioning.** `package.json` `version` is the base version.
  `scripts/package-vsc.ps1` appends `-prerelease.<build>` (from
  `get-build-number.ps1`) unless `-Stable`. Releases are cut by
  `scripts/start-vsc-release.ps1`, which pushes `vsc-rel/v<version>` and opens
  the follow-up patch-bump PR — a hand bump in a feature PR is usually wrong.
- **Breaking changes** — apply the shared compatibility gate first. A command
  ID, setting key, debugger `type`/field, or custom-editor `viewType` in a
  published Marketplace release may be `high`; surface introduced only on this
  branch should be replaced cleanly.
- **Bundled CLI.** Changes to `download-cli.ps1`, the `bin/` layout, or
  `getWinappCliPath` must stay consistent with each other, with
  `.vscodeignore` (`bin/**` excluded except `!bin/**/*.exe`), and with the
  release pipeline's `CliReleaseTag` / `-DestinationPath` usage.
- **Release pipeline.** `.pipelines/release-vsc.yml` runs on `vsc-rel/v*` with
  ESRP signing and Marketplace publishing (`DoEsrp`, `SkipPublish`). Changes to
  artifact names, output paths (`artifacts/`), signing, or the CLI tag need
  pipeline review. `.github/workflows/build.yml` must keep working with the
  same scripts.
- **CI expectations.** `build.yml` runs `npm ci`, compile, `download-cli.ps1`,
  `sync-schemas`, lint, `test:unit`, E2E, and VSIX packaging on
  `windows-latest` with a pinned VS Code. A new build step that only works locally (e.g. needs `winapp` on
  `PATH`, a user profile, or network beyond `gh`) breaks CI.
- **VSIX hygiene.** New top-level files or folders (reports, fixtures, scratch
  docs) ship unless `.vscodeignore` excludes them. `build.yml` reports VSIX
  size; an unexplained jump is worth a finding.
- **`engines.vscode`.** A new API that needs a newer VS Code than
  `engines.vscode` allows is a broken install for users on the floor version.
