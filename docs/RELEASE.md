# Release checklist — WinApp VS Code extension

This checklist tracks decisions and prerequisites for cutting a release, so recurring release-time
concerns are documented and accepted rather than left as inline TODOs in the pipeline.

## WinUI XAML language server

The release pipeline (`.pipelines/release-vsc.yml`) publishes the .NET language server into
`dist/server` and bundles it in the VSIX. Confirm the following before releasing:

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

- [ ] **Accepted:** loose `.NET` DLLs (`WinUiXaml.LanguageServer.dll`, `WinUiXaml.Workspace.dll`,
      `WinUiXaml.Xaml.dll`) are signed with `CP-230012`. Confirm this keycode still matches the
      winapp signing identity for this release.
- [ ] Only first-party assemblies are signed. The bundled Roslyn/MSBuild/`System.*` DLLs are already
      Microsoft-signed and strong-named; re-signing them is unnecessary and can break validation.

## General

- [ ] `npm run test:unit`, `npm run test:server`, `npm run test:xaml-smoke`, and `npm test` are green
      (the XAML suites require the .NET 10 SDK — see [CONTRIBUTING.md](../CONTRIBUTING.md)).
- [ ] The packaged VSIX contains `extension/dist/server/WinUiXaml.LanguageServer.dll`.
