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
Pipeline runs may select a specific `CliReleaseTag`; production publishing requires `DoEsrp=true`,
while `SkipPublish=true` produces artifacts without publishing.

## WinUI XAML language server

The release pipeline (`.pipelines/release-vsc.yml`) tests and publishes self-contained `win-x64`
and `win-arm64` servers in the `Build_Server` stage, signs them when `DoEsrp=true`, and uploads the
`winui-xaml-server` pipeline artifact directory. The VSIX `Build` stage downloads that artifact and installs
it into `dist/server` with `scripts/download-server.ps1`; it does not rebuild the signed files.

### 1. Package feed (NuGet restore)

- [ ] The server restore uses the feed pinned in [`server/nuget.config`](../server/nuget.config)
      (currently the public `nuget.org` feed). This keeps `dotnet publish` deterministic on the
      release pool and on developer machines.
- [ ] If the release pool blocks public NuGet egress, update `server/nuget.config` to the approved
      internal mirror **before** the run — do not rely on the pool's ambient/default feed.

### 2. DLL code signing (ESRP)

The language-server assemblies are Authenticode-signed via ESRP using KeyCode **`CP-230012`**
(`SigntoolSign` / `SigntoolVerify`), which is the standard Microsoft Authenticode keycode. This is
distinct from the VSIX/publisher signing keycode (`CP-401405`, OPC + VSCodePublisher operations)
used for the packaged extension.

- [ ] **Accepted:** the self-contained `WinUiXaml.LanguageServer.exe` apphosts and first-party
      assemblies (`WinUiXaml.LanguageServer.dll`, `WinUiXaml.Workspace.dll`,
      `WinUiXaml.Xaml.dll`) plus the bundled `dotnet.exe`/`dotnet.dll` BuildHost shim are signed
      with `CP-230012`. Confirm this keycode still matches the winapp signing identity for this release.
- [ ] Only first-party assemblies are signed. The bundled Roslyn/MSBuild/`System.*` DLLs are already
      Microsoft-signed and strong-named; re-signing them is unnecessary and can break validation.
- [ ] **Fresh-vs-signed server bundle:** `scripts/ensure-server-bundle.mjs` publishes fresh
      self-contained servers by default, so a plain `vsce package` never ships stale output.
      `package-vsc.ps1 -SkipServerBuild` selects artifact mode for an already-produced bundle. In
      release builds, `scripts/download-server.ps1` first validates both signed runtime layouts;
      CI uses the same path with its locally published unsigned test bundle.
      Artifact mode fails closed if either architecture is incomplete and never falls back to an
      unsigned local publish.

## General

- [ ] `npm run test:unit`, `npm run test:server`, `npm run test:xaml-smoke`,
      `npm run test:xaml-self-contained`, and `npm test` are green
      (the XAML suites require the .NET 10 SDK — see [CONTRIBUTING.md](../CONTRIBUTING.md)).
- [ ] The packaged VSIX contains both
      `extension/dist/server/win-x64/WinUiXaml.LanguageServer.exe` and
      `extension/dist/server/win-arm64/WinUiXaml.LanguageServer.exe`.
