# Release checklist — WinApp VS Code extension

This checklist tracks decisions and prerequisites for cutting a release, so recurring release-time
concerns are documented and accepted rather than left as inline TODOs in the pipeline.

## Starting a release

From an authenticated, clean `main` checkout, preview the release automation first:

```powershell
.\scripts\start-vsc-release.ps1 -DryRun
```

Then run `.\scripts\start-vsc-release.ps1` (optionally with `-Version Major.Minor.Patch`).
The script creates and pushes `vsc-rel/v<version>`, which triggers the release pipeline, then
opens the follow-up patch-version PR. Git push access is required; an authenticated GitHub CLI
creates the follow-up PR automatically; when `gh` is not installed, the script prints a browser URL
for creating it manually.

Pipeline runs may select a specific `CliReleaseTag`; leaving it empty uses the build pinned in
`cli-version.json`. Production publishing requires `DoEsrp=true`, while `SkipPublish=true`
produces artifacts without publishing.

## Azure Artifacts feeds

Both release build jobs use `.pipelines/templates/nuget-feed.yml` before restoring packages.
References use a repository-rooted path with `@self` so the external 1ES template resolves
them from this repository rather than its own.
Following the WinApp CLI Azure pipelines, it installs `.pipelines/release-nuget.config` at
repository and agent-user scope, clears inherited sources, and authenticates with
`NuGetAuthenticate@1`. Only the `pde-oss_Internal` Azure Artifacts feed is enabled.
User scope also covers temporary test projects outside the checkout. This setup runs only
on release agents; local builds keep using the machine's configured feeds.

Server tests pin xUnit to `2.3.1`, the highest currently approved version. Keep the exact
version constraint until a newer version is approved and available through the release feed.
Workspace test collections run serially to avoid integration-suite hangs with this runner;
individual tests still exercise concurrent operations where required.

## Server signing

The ESRP task uses newline-separated minimatch patterns to sign the native server executables
and managed generator host. Comma-separated patterns match neither file type. Keep the
independent signature verification step enabled so unmatched or unsigned binaries block release;
third-party DLLs retain their publisher signatures and are verified too.

## WinApp CLI bundle

The release pipeline calls `scripts/download-cli.ps1` with its artifact staging directory as
`-DestinationPath`. For local development, omitting `-DestinationPath` keeps the existing behavior
of installing the x64 and arm64 binaries under `bin`.

An explicit `-Tag` takes precedence over `WINAPP_CLI_RELEASE_TAG`; when neither is set, the script
downloads the source pinned in `cli-version.json`. This preview pins a successful upstream `main`
CI artifact by run, commit, artifact ID, and archive SHA256. Downloading requires PowerShell 7.4+
and an authenticated GitHub account or token with access to that upstream Actions artifact.

CI artifacts expire. Replace this pin with a supported release containing external-inspector
routing before production publication. An expired or inaccessible artifact fails explicitly;
the downloader never substitutes a different build. Use `-Tag latest` only for deliberate testing.

Schema sync reports success only after every required XSD is copied. If `winapp restore`
returns nonzero, its diagnostics are logged as warnings; sync can still succeed when all
required schemas are available. Missing packages or XSDs remain fatal.

## Packaged extension E2E tests

Install the VSIX using the downloaded VS Code's `bin\code.cmd`, not its GUI executable.
The CLI reports installation diagnostics and an exit code. Keep `VSCODE_PATH` pointing
to `Code.exe` and use the same isolated extensions directory for installation and E2E tests.

## Release checks

- [ ] Run `npm run test:unit` and `npm test`.
- [ ] Confirm `cli-version.json` names the intended CLI build and use a release pin for production.
- [ ] Run `.\scripts\download-cli.ps1` and confirm both `bin/win-x64/winapp.exe` and
      `bin/win-arm64/winapp.exe` are present.
- [ ] Run `.\scripts\package-vsc.ps1 -Stable` and confirm the VSIX is created in `artifacts`.
- [ ] Leave `CliReleaseTag` empty to use `cli-version.json`, or set it only for an intentional
      release-candidate validation override.
- [ ] Use `SkipPublish=true` when validating release artifacts without publishing them.
