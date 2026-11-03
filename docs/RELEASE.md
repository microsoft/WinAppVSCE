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

Pipeline runs may select a specific `CliReleaseTag`; leaving it empty uses the release pinned in
`cli-version.json`. Production publishing requires `DoEsrp=true`, while `SkipPublish=true`
produces artifacts without publishing.

## WinApp CLI bundle

The release pipeline calls `scripts/download-cli.ps1` with its artifact staging directory as
`-DestinationPath`. For local development, omitting `-DestinationPath` keeps the existing behavior
of installing the x64 and arm64 binaries under `bin`.

An explicit `-Tag` takes precedence over `WINAPP_CLI_RELEASE_TAG`; when neither is set, the script
downloads the release in `cli-version.json`. Use `-Tag latest` only for deliberate compatibility
testing, then update the pinned tag in a reviewed change before shipping it.

## Release checks

- [ ] Run `npm run test:unit` and `npm test`.
- [ ] Confirm `cli-version.json` names the WinApp CLI release intended for this extension release.
- [ ] Run `.\scripts\download-cli.ps1` and confirm both `bin/win-x64/winapp.exe` and
      `bin/win-arm64/winapp.exe` are present.
- [ ] Run `.\scripts\package-vsc.ps1 -Stable` and confirm the VSIX is created in `artifacts`.
- [ ] Leave `CliReleaseTag` empty to use `cli-version.json`, or set it only for an intentional
      release-candidate validation override.
- [ ] Use `SkipPublish=true` when validating release artifacts without publishing them.
