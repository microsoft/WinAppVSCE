# Contributing to WinApp VS Code Extension

Thanks for your interest in contributing to the WinApp VS Code Extension.

## Prerequisites

- Node.js 24
- Visual Studio Code
- PowerShell 7 or Windows PowerShell for the build scripts
- The [.NET 10 SDK](https://dotnet.microsoft.com/download) — required to build, test, and locally publish the WinUI XAML language server (`server/`). The unit tests (`npm run test:unit`) do not need the SDK, but the server tests, the XAML integration/smoke suites, and local packaging do.
- **Visual Studio C++ build tools (MSVC / `link.exe`)** — required to publish the Native AOT server locally. `dotnet publish` invokes the ILC native linker, which fails with `MSB3073` (`link.exe exited with code 123`) when the C++ toolchain is missing or `vswhere.exe` is not resolvable. Install the "Desktop development with C++" workload in Visual Studio or the standalone Build Tools. If the toolchain is installed and the failure text still reports `'vswhere.exe' is not recognized`, add `C:\Program Files (x86)\Microsoft Visual Studio\Installer` to `PATH` and publish from a developer command prompt matching the target architecture (`vcvarsarm64.bat` for `win-arm64`).
- [WinApp CLI](https://github.com/microsoft/WinAppCli) (for syncing manifest schemas)

> Native AOT removes the runtime dependency for the server executable only — it launches as a native binary. Users of the packaged extension still need an installed .NET 10 runtime, because the source-generator host (`WinUiXaml.GeneratorHost.dll`) runs out of process on `dotnet` and project evaluation goes through the `dotnet` CLI. The extension never installs or bundles a runtime.

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
npm run test:xaml-bundled # smoke the published Native AOT server binary end-to-end
npm test                 # VS Code integration tests (drives the real extension + server)
```

`npm test` runs a `pretest` step that compiles, lints, builds the language server, and restores the test fixture — so it needs the .NET SDK. `test:xaml-bundled` runs the already-published Native AOT server executable end-to-end; the .NET 10 runtime is still required so the server can spawn the out-of-process source-generator host. On a machine without the SDK, run `npm run test:unit` instead; build-dependent suites fail fast with a clear "dotnet not found" error rather than silently skipping.

## Package

To produce a VSIX package locally:

```powershell
.\scripts\build-vsce.ps1 -Package
```

Local packaging publishes a Native AOT server binary for each requested RID (defaults to the host
architecture; set `WINUI_XAML_SERVER_RIDS=win-x64,win-arm64` to build both) plus the shared
framework-dependent generator host under `dist/server/generator-host/`. The
official release pipeline instead downloads the separately built and ESRP-signed server artifact,
which must contain binaries for every shipping architecture.

## Install locally

After packaging, install the VSIX into VS Code:

```powershell
$vsix = Get-ChildItem artifacts\winapp-*.vsix | Sort-Object LastWriteTime -Descending | Select-Object -First 1
code --install-extension $vsix.FullName
```

## Language server dependencies

The server hand-rolls its JSON-RPC transport (`Lsp/JsonRpcConnection.cs`) and its LSP type
definitions (`Lsp/LspTypes.cs`). Only the second of those is forced by Native AOT.

**`StreamJsonRpc` is Native AOT capable** and could replace the transport. This was verified by
publishing a `win-arm64` Native AOT binary against `StreamJsonRpc` 2.25.29 that completes a typed
request/response round trip with zero `IL2xxx`/`IL3xxx` warnings. It requires the recipe in the
library's [Native AOT guidance](https://github.com/microsoft/vs-streamjsonrpc/blob/main/docfx/docs/nativeAOT.md):

- Set `EnableStreamJsonRpcInterceptors` to `true` so proxies are source generated.
- Mark contracts `[JsonRpcContract]` and `[GenerateShape]`, and register targets with the
  `AddLocalRpcTarget(RpcTargetMetadata, object, JsonRpcTargetOptions)` overload. The
  `AddLocalRpcTarget(object)` overload is reflection based and is not AOT safe.
- Use `SystemTextJsonFormatter` with `JsonSerializerOptions.TypeInfoResolver` pointed at a
  `JsonSerializerContext`. Its constructor carries a blanket `[RequiresDynamicCode]`, which the
  official sample suppresses once the source-generated resolver is supplied.
- Supply `JsonTypeInfo` for `StreamJsonRpc.RequestId` as well. The documented recipe does not
  mention it, and without it `$/cancelRequest` fails to serialize, so cancelled LSP requests hang
  until the client gives up. A converter plus a small `IJsonTypeInfoResolver` returning
  `JsonMetadataServices.CreateValueInfo<RequestId>` fixes it.

Verified against the server's real `LspTypes.cs` and `LspJsonContext.cs`: a `win-arm64` Native AOT
binary built from them publishes with zero warnings and passes `initialize`, `textDocument/hover`,
a client notification, a server-to-client `textDocument/publishDiagnostics`, and request
cancellation.

**The LSP type packages are the real blocker.** `Microsoft.VisualStudio.LanguageServer.Protocol`
tops out at 17.2.8 on our feed, and an explicit reference to a newer version fails `NU1102` rather
than pulling from upstream. That version predates the package's move to System.Text.Json: it
targets `netstandard2.0` and its only non-BCL assembly reference is `Newtonsoft.Json`.
`Microsoft.CommonLanguageServerProtocol.Framework` inherits the same problem through
`StreamJsonRpc` 2.21.10 and `Newtonsoft.Json` 13.0.3.

Adopting 17.2.8 under Native AOT therefore means owning a Newtonsoft-to-System.Text.Json shim.
Measured scope, should this be revisited:

- Wire names are recoverable cheaply. Of 393 `[DataMember]` properties, 383 are the camelCase of
  the property name, so a naming policy plus 10 hardcoded overrides covers all of them.
- `SumType` unions are not. 27 properties span 24 distinct union shapes, each needing an explicitly
  registered converter, because a `JsonConverterFactory` would rely on `MakeGenericType`.
- Several enums serialize as LSP strings rather than numbers, and `DocumentUri`,
  `ParameterInformation`, `StrictPrimitive`, and `TextDocumentSync` all have Newtonsoft converters
  to reimplement.

A probe confirmed the cheap half works and the rest does not: source-generated types emitted
correct `"label"` and `"sortText"` names, but `MarkupKind` came out as `"kind":1` instead of
`"markdown"`. That is the shape of the risk. Wire-format mistakes fail silently rather than
throwing, so the shim would need to be right across all 184 public types, not just the ones the
server uses today.

So adopting `StreamJsonRpc` would replace 365 lines of transport but leave the larger 666-line
`LspTypes.cs` hand-maintained. Native AOT trims unused assemblies, so the cost is not the package
count but the linked output: an equivalent probe measured 5.4 MB against 2.29 MB for the same
round trip written directly on System.Text.Json, and 7.0 MB once the server's real LSP types were
linked in. Revisit if a System.Text.Json build of the LSP
protocol types reaches the feed, which would make replacing both halves worthwhile in one change.

## Pull requests

- Follow the checklist in [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md).
- Include tests and documentation updates when your change affects behavior or contributor workflows.
- Prefer focused PRs that are easy to review.

## Code of Conduct

This project follows the Microsoft Open Source Code of Conduct. For more information, see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
