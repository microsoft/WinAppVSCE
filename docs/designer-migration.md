# Visual Studio designer migration

## Current boundary: shared foundation (approved milestone 2)

The parent-approved shared-foundation implementation checkpoints the intentional
import in the **same** `nmetulev-migrate-winui-designer` branch/worktree,
based on `b023f007d85064fdc62bf99ad9c28d2f076680e4`. The approved local checkpoint
includes the two precommit integrity/cancellation fixes and source/docs only.
No push, PR, amend, VS launch/deployment/registration, machine-wide install,
other checkout/source rebuild or LSP/#50 change is part of this checkpoint.
Renderer processes below are disposable test-harness runs, not an IDE deployment.

**Everything under “Historical milestone 1” below records the old import layout,
commands and measurements. It is provenance, not the current layout or current
validation. Its old stop/next-boundary statements are superseded by this section.**

### Intentional deltas and current ownership

- Moved `vs-extension/tools/SurfaceProvisioner` → `surface/SurfaceProvisioner`
  and `vs-extension/tools/DesignHost` → `surface/DesignHost`. Renderer stays in
  `surface/Surface`; only its provisioner-path comment changed. No renderer source
  behavior, protocol dispatcher, WASDK/BuildTools/Toolkit pins or guards changed.
- `surface/Build-Payload.ps1` now owns pristine payload/source SDK compilation;
  VS script owns only prerequisites, identity copy/logos and net472/WPF/VSSDK
  packaging. Default WASDK is 2.2.0; `WinUISurfaceWasdkVersion` override remains.
  Packaged `Surface.wasdk.version` makes bundled-version selection explicit.
- Shared build outputs: `surface/obj/PayloadBuild`, `surface/obj/HostSDK`.
  VS shipping identity copy: `vs-extension/WinUIXamlPreview/obj/IdentityPayload`.
  Installed HostSDK paths remain backward-compatible (`surface/Surface`,
  `DesignHost`, compiled `SurfaceProvisioner`). Distribution layout is **not**
  source ownership. Shared notice is `surface/LICENSE.winui-vsc.txt`; separate
  VS notice remains. Both shipped notices are compared to owning source notices.
- Full descriptive canonical v1 contract, typed TS shapes, 40 shared fixtures and
  actual linked C# DTO/client/FrameServer serialization/dispatch tests are under
  `surface/protocol`. Rendering boundaries are test doubles in those tests;
  real renderer smoke is separate. No new npm dependencies or VS Code UI.
- Provisioner stdout is one versioned JSON result (`built`, `cached`, `degraded`,
  `failed`); stderr preserves diagnostics. Only verified matched output is success.
  VS parses/validates the returned exact host instead of resolving a version-only
  cache. Missing/invalid JSON preserves process diagnostics rather than hiding them.
- Source builds use `%TEMP%\wsp-v2\<owned-invocation>`; no building/cleaning in
  installed source SDK directories. Staging root is deterministic and bounded;
  names/lease ownership are collision-safe and cleanup is scoped. This replaces
  the baseline manual short-HostSDK workaround for MakePRI.
- Content identities cover source/template/assets, resolved WASDK/component,
  SDK, architecture/RID/TFMs and real resolved package-file closure. Cross-process
  file locks, hash-complete manifests and atomic immutable generation publication
  live in the provisioner. Legacy user cache is untouched. Cache hits conservatively
  restore and hash inputs; they are not instantaneous/offline version-only lookups.
- `surface/Shared/HostPayload.cs` is a small linked internal helper in net8/net472,
  not a new public runtime library. Per-process disposable PRI run copies include
  warmed spares; `--user-pri` never launches against a pristine cache through the
  updated client. The renderer’s in-place PRI behavior itself is unchanged.
- Updated package validation, compile links, smoke launch paths, focused
  provisioning/cache tests and documentation. Flat obj, handcrafted pkgdef,
  runtime-DLL fixes and original extension identity are retained.

Detailed CLI/cache semantics, supported defaults and limitations:
[`surface/README.md`](../surface/README.md).
Full wire/default/optional/error/native/stale behavior:
[`surface/protocol/README.md`](../surface/protocol/README.md).

### Current exact build/test commands

From this worktree root, with the already-installed toolchain described in the
historical prerequisites:

```powershell
.\vs-extension\WinUIXamlPreview\Build-Vsix.ps1 -Configuration Debug -NoDeploy
.\vs-extension\Test-BuildGuards.ps1
.\vs-extension\Test-Migration.ps1 -IncludeRenderer
.\surface\Test-Foundation.ps1 -IncludeBuild -IncludeRenderer
```

The foundation wrapper requires PowerShell 7 and runs the dependency-free
provisioner fixtures, strict `tsc`, linked-production C#/TS compatibility,
two simultaneous real CLI requests against a new ignored cache, cancellation,
failed/degraded result checks, shared run-copy and actual-user-PRI smoke.
It records machine-readable test outcomes in
`surface/obj/Foundation-<unique>/results.json`; these are ignored, not packaged.
All launched Surface/provisioner processes are owned and disposed by the harness.

Independent no-native-tool compatibility commands:

```powershell
dotnet run --project .\surface\SurfaceProvisioner.Tests\SurfaceProvisioner.Tests.csproj
node .\node_modules\typescript\bin\tsc -p .\surface\protocol\tsconfig.json
dotnet restore .\surface\protocol\Compatibility.csproj --nologo -v:q
node .\node_modules\tsx\dist\cli.mjs --test .\surface\protocol\compatibility.test.ts
```

### Current validation results

Final replay on **2026-09-08**:

| Check | Actual current result |
| --- | --- |
| Full no-deploy VSIX source build | Passed (renderer CA1416 and existing-style VSTHRD/VSSDK warnings remain). |
| Actual archive/PE identity | 112 entries; 29 required files; correct sparse identity/pkgdef; both source notices match owning files; full engine stamp; no Gallery/test/build contamination. |
| Negative build/package guards | **6 passed**, including new missing notice and bundled-version checks. |
| D2 / D2Residual | **10 / 5 passed**. |
| Bundled renderer smoke | **66 passed**. |
| Matched renderer, actual `--user-pri` | **73 passed**: existing 66 plus seven simultaneous run-copy/isolation/hash/cleanup assertions. |
| No-tool provisioner/cache fixtures | **107 passed**, including actual `--prepare-run` containment/case/separator/sibling regressions and deterministic `--build` cancellation during cache validation, before cached success, publication copying/validation, and before/after generation commit and pointer publication. No partial outputs, no runnable cancellation paths, unchanged pristine-host hashes and retained committed generations. |
| Protocol strict TS typecheck | Passed with no added npm dependencies. |
| Cross-language protocol suite | **3 TS tests passed; 320 C# assertions; 38 DTO and 7 real FrameServer-serialized payloads** consumed by TS, using 40 shared fixtures. |
| Two real simultaneous provisioner processes | **One `built`, one `cached`**, same key and host; no fallback. |
| CLI cancellation / failed / degraded | Exit **130 / 1 / 3** respectively; structured JSON retains cause, none reports success. |
| Actual `--prepare-run --cancel-on-stdin` | Exit **130**, `failed`, `cancelled: true`, `success: false`; no owned partial run; subsequent pristine-host validation and matched rendering pass. |
| Source/staging/run ownership | Builds succeeded from owned short temp copies; installed HostSDK source not built in place; pristine cache PRI unchanged; no owned Surface/provisioner processes or wsp-v2/wsr-v2 child directories remained. |
| VS Code shipping enumeration | `npx --no-install vsce ls --no-dependencies`: **zero migrated paths**. Not a rebuilt shipping VS Code artifact or unit-suite claim. |
| Worktree scope | Same branch/worktree; 133 approved source/docs/asset candidates including `.vscodeignore`; content/artifact/secret scan and staged whitespace check; local checkpoint only, no push/deployment. |

Artifact (unsigned development VSIX):

```text
C:\Users\nikolame\.copilot\repos\copilot-worktrees\WinAppVSCE\nmetulev-congenial-dollop\vs-extension\WinUIXamlPreview\bin\Debug\WinUIXamlPreview.vsix
Bytes: 43302249
SHA256: 58C10D7B072500C1F4C17F210A7673120D2C446A9B7AB489862F3BC14A845992
```

Persisted final machine-readable provisioning/runtime evidence:
`surface/obj/Foundation-3e2986f07101/results.json`, including the real-process
`prepareCancellation` result. The prior `Foundation-dd8c52129c81`, `Foundation-88ccead9af81`,
`Foundation-008e9705d8fd`, `Foundation-ba69751eb823`,
`Foundation-7b8a5fdaa500` and `Foundation-f0adabf70fce` reports are earlier successful
replays, not the final artifact's evidence.

Final engine stamp:
`060b680fd2c2081b2387a3eb31d19b5aa5aef758108473ca485df3b073571604`.
Final matched cache key:
`535da29c34486d950a7a8f3cda37aa2be54057b0e301d4fc9a79c90c43ee6fe5`.
Resolved WASDK **2.2.0**, WinUI component **2.2.1**; managed hash prefix
**8D2B7EF7**, native prefix **2B22EB61**, both equal their resolved package files.

Review follow-through corrected failure paths so stage-cleanup exceptions cannot
retain a success result, missing/invalid CLI JSON preserves stderr, real CLI
degradation cannot masquerade as success, and expected negative build tests no
longer leak a failing `$LASTEXITCODE`. Private Surface launch diagnostics identify
the actual run-copy executable; cleanup I/O/access failures are logged rather
than silently swallowed. Checkpoint housekeeping removes five imported
trailing-whitespace lines in `DesignHost/App.xaml.cs` and the DesignHost/Surface
`app.manifest` files so the staged whitespace check passes. No manifest semantics
or renderer behavior changed; the final replay/hash includes that normalization.

The run-preparation cancellation review fix threads an optional cancellation
token through shared copying/hashing/validation without breaking linked net472
callers. Program delegates to a testable internal command dispatcher, which maps
`OperationCanceledException` to cancelled JSON/exit 130. Unique sibling staging
and non-overwriting publication prevent cleanup from deleting an existing
destination or published generation. Progress diagnostics remain on stderr,
not in the machine-readable result.

The final integrity fix canonicalizes Windows paths and rejects an equal/nested
run destination or staging path before creating directories; similarly-prefixed
siblings remain valid. Ambiguous trailing-dot/space components and reparse
ancestors are rejected; invocation-owned cleanup never traverses directory links.
The final cancellation fix propagates tokens through completed-cache validation,
package/payload hashes, sealing, source/PRI/run copying and publication. Checks
precede cached success, immutable-generation commit, pointer publication and result
delivery. Cancellation after commit may retain a complete immutable generation
(and, if already replaced, its index) but returns failed/cancelled, exit 130 and
no runnable paths. Cleanup failures keep their diagnostic/degraded semantics.
Deterministic fixtures replace only external dotnet execution; the production
dispatcher, builder, cache, copying, hashing and JSON/exit mapping all run.

Final review applies WinUI guidance to the shared code without rewriting the
net472 **WPF** adapter to WinUI `x:Bind`. The two blockers are fixed; existing
renderer/platform and VSTHRD/VSSDK warnings are retained, not expanded into an
unapproved UI/engine migration.

### Remaining limitations / release gates

- No real VS installation, docking, upgrade/uninstall or IDE bundled-to-matched
  hot-swap was performed. The new net472 glue builds; its real-process client is
  exercised outside VS. Runtime/UI consent/trust policy remains a later milestone.
- Parent owns live-VS preflight and the shared-identity gate: the imported
  `SurfaceIdentity` replaces a user-scoped shared registration, so this checkpoint
  does not authorize launching/deploying it. The imported warmed-spare reflection
  fallback omission in `PreviewControl` remains a known baseline warning.
- Only existing x64 toolchain/runtime and WASDK 2.2.0 / WinUI 2.2.1 validated.
  DesignHost still has its fixed Toolkit 8.2.250402 closure; no arbitrary Gallery,
  user-project resource generation, recovered-page or broader runtime claims.
- Wire v1 has no request/document version correlation or stale-result guarantee,
  does not reject mismatched Hello/Ready versions, and still reports fixed Ready.wasdk.
  SetTheme is a compatibility no-op. These are documented/tested limitations, not
  silently “fixed” in a renderer rewrite.
- Cache hits currently require restore tooling/package closure and can take tens
  of seconds. Retained immutable generations and hard-kill orphan staging have
  no automatic GC. Normal/cancelled scoped cleanup is tested; abrupt IDE/process
  termination can leave owned temporary directories. Packaging's shared staging
  remains single-caller while consumed by an adapter, separate from validated
  concurrent runtime provisioning.
- No new CI/release lane, signing/publishing, clean-machine install, dependency
  license audit or supported VS/architecture matrix claim.
- Existing VS Code generated-schema prerequisites remain unresolved as recorded
  historically. No product/schema/test changes were made to silence them.

## Historical milestone 1 — mechanical import (superseded layout/results)

## Provenance and pre-import dependency inventory

Imported from `https://github.com/nmetulev/winui-vsc` at the frozen tree
`727dd22d02d95097525e0f0fc0cf5dfd533dd153`, not from its working files or last diff.
Target base: `b023f007d85064fdc62bf99ad9c28d2f076680e4`.
Original MIT copyright and permission notice are retained in
`vs-extension/LICENSE.winui-vsc.txt` and included in the VS payload.
The target repository license is not replaced.

Inventory established **before import**:

| Original path (retained layout) | Dependency closure / reason |
| --- | --- |
| `surface/Surface` | Complete renderer source/assets/project, excluding user launch settings. net10.0-windows10.0.26100.0; Windows SDK BuildTools 10.0.28000.2270; default WASDK 2.2.0 with `WinUISurfaceWasdkVersion` override. No project references or IDE/LSP dependencies. |
| `vs-extension/WinUIXamlPreview` | Complete net472 WPF/VSSDK adapter, protocol, handcrafted pkgdef, VSCT, manifests and build script. VS SDK 17.14.40265, VSSDK BuildTools 18.6.38345, threading analyzers 18.7.23, SDK analyzers 17.7.113, System.Text.Json 10.0.9, MessagePack 2.5.301. Packages supply transitive assembly closure. |
| `vs-extension/tools/SurfaceProvisioner` | Complete BCL-only net8.0 executable: native-overlay and matched-source-build paths. Builds Surface and DesignHost via dotnet; no TypeScript host builder. |
| `vs-extension/tools/DesignHost` | Complete resource template/assets, never launched. Same renderer TFM/WASDK override and SDK BuildTools pin; BuildTools.WinApp 0.4.0; eleven CommunityToolkit 8.2.250402 package references and their transitive resource closure. |
| `vs-extension/SurfaceClient.Smoke` | Complete console harness. Links five production protocol/client files; System.Text.Json 10.0.9; optional custom-control coverage requires TestUserApp. |
| `vs-extension/SurfaceClient.UITest/{Program.cs,SurfaceClient.UITest.csproj}` | Existing native selection/property and source-map regression harness; links production protocol plus XamlSourceMap. D2/D2Residual are independent of external Gallery; other modes may require explicit external Gallery inputs. |
| `surface/TestUserApp` | Complete minimal fixture library, design-time samples and controls used by Smoke and renderer benchmarks. WASDK 2.2.0. Never shipped. |

No architectural extraction, protocol simplification, SDK upgrades or renderer
behavior changes are part of this milestone. Surface and vs-extension remain
top-level siblings. The original C# frame-stream and native-hwnd capabilities,
namespaces and extension identity are retained.

### Exclusions

Generated bin/obj (including bin-new/bin-old), VSIXs, logs, screenshots,
TestResults, caches, `.bak`, launchSettings, user settings, agent/research notes,
Gallery binaries and sources, unrelated `client`/`server`, blanket spike trees,
ToolkitUserApp, RefRewriter, window-capture/reparent experiments and historical
Gallery/IDE orchestration scripts are not imported. The latter have developer
absolute paths/external dependencies; the reusable harness logic remains in
UITest/Program.cs. No dependency from the selected production projects requires
these exclusions. Existing target VS Code code and release workflows stay separate.

After import, 102 of the 107 selected files were unchanged after line-ending
normalization. The five deliberately edited original files are Build-Vsix.ps1,
WinUIXamlPreview.csproj, Smoke/Program.cs (repo discovery and capability assertions),
UITest/Program.cs (remove developer-machine defaults; require explicit external
inputs), and UITest/SurfaceClient.UITest.csproj (exclude disposable test output
from default compile items). Renderer, provisioner and DesignHost source/project contents are unchanged.
New files provide migration docs, source license, ignores and validation scripts.

## Build prerequisites and command

Use Windows x64 with:

- Desktop Visual Studio/MSBuild discovered with `vswhere -latest -prerelease`,
  .NET Framework 4.7.2 targeting/reference assemblies, WPF and VS extension build
  support. Validated with VS2026 Enterprise, desktop MSBuild
  `C:\Program Files\Microsoft Visual Studio\18\Enterprise\MSBuild\Current\Bin\MSBuild.exe`.
- .NET SDK 10 (validated 10.0.303), plus .NET 8 runtime for the provisioner.
  A .NET 10 SDK installation does **not** imply the .NET 8 runtime is installed.
- Windows SDK including x64 `mt.exe`, XAML/PRI tooling, and access to the pinned
  NuGet dependency closure. Build restores packages, but never installs a
  machine-wide toolchain/runtime or changes Developer Mode.
- Running the bundled framework-dependent renderer additionally needs .NET 10
  and a compatible Windows App Runtime 2. The tested machine had .NET 8.0.30,
  .NET 10.0.11 and Windows App Runtime 2 package 2.4.0.0 (x64).

From the repository root:

```powershell
.\vs-extension\WinUIXamlPreview\Build-Vsix.ps1 -Configuration Debug -NoDeploy
```

`-NoDeploy` is mandatory: omission fails before building. The adapter's legacy
`AnyCPU` configuration is retained; the **payload is x64**, not AnyCPU/ARM64.
Do not use `dotnet build` alone to package this classic VSSDK extension.

The script deletes/recreates only its ignored `obj/PayloadBuild` and `obj/HostSDK`
staging directories. It copies migrated source, builds the renderer at the
unchanged WASDK 2.2.0 pin and the net8 provisioner, and packages:

- `Surface/`: fresh framework-dependent renderer closure; sparse identity embedded
  into a **shipping copy** with mt.exe; AppxManifest and its three logo files.
- `HostSDK/`: pristine renderer source, DesignHost source/assets, compiled provisioner,
  original source license and the baseline engine fingerprint.
- Adapter DLL, handcrafted pkgdef, forced runtime DLLs and original source license.

It never discovers the prototype repo, consumes prebuilt renderer outputs, reuses
the user's host cache, registers an identity, launches an installer or deploys to VS.
Source staging excludes build outputs and developer settings. Missing renderer,
HostSDK, identity, logo or required runtime inputs fail. A separate restore then
desktop-MSBuild evaluation handles an initially absent VSSDK NuGet package. The
proven flat obj, handcrafted CodeBase pkgdef and runtime-DLL packaging fixes remain.

Output:
`vs-extension/WinUIXamlPreview/bin/Debug/WinUIXamlPreview.vsix`.
The command gives a reproducible source-to-payload recipe, not a claim of
byte-for-byte reproducibility across SDKs or build timestamps.

VS Code's `.vscodeignore` excludes both imported top-level trees and this record.
Its source, package.json, lockfile, build scripts and shipping workflows are unchanged.
No new CI workflow is added: a runner with the declared desktop VS2026/SDK toolchain
has not been established here. Do not silently attach this build to the existing
VS Code release job. A dedicated runner/build-only lane is a follow-up integration
dependency; no signing, publishing or credentials have been introduced.

## Focused validation

```powershell
# Re-open the actual archive and verify payload plus embedded PE sparse identity.
.\vs-extension\WinUIXamlPreview\Test-VsixPayload.ps1 `
  -VsixPath .\vs-extension\WinUIXamlPreview\bin\Debug\WinUIXamlPreview.vsix

# Negative tests: reject missing renderer, identity and provisioner, and no -NoDeploy.
.\vs-extension\Test-BuildGuards.ps1

# Builds both net472 harnesses; runs D2 and D2Residual without renderer/IDE.
.\vs-extension\Test-Migration.ps1

# Also builds TestUserApp and runs real frame + native/property smoke.
# Requires existing compatible runtimes. Never launches Visual Studio.
.\vs-extension\Test-Migration.ps1 -IncludeRenderer
```

Renderer tests copy the pristine unpackaged output to a unique ignored
`vs-extension/SurfaceClient.UITest/TestResults/Migration/Renderer-*` directory.
The production client owns and disposes its child processes; there are no
name-based process kills. The wrapper clears inherited external-Gallery and
behavior opt-ins for the baseline and restores the caller's environment afterward.
Some **existing smoke cases explicitly opt in** to design-time reflection/settling;
that does not change the default renderer or enable SURFACE_GUARDS.

The following additionally exercised the shipped HostSDK C# build path at the
fixture's **resolved** WASDK version, without user cache reuse or bundled fallback:

```powershell
$sdk = Join-Path $PWD 'vs-extension\obj\sdk'
New-Item -ItemType Directory -Path $sdk -Force | Out-Null
Copy-Item .\vs-extension\WinUIXamlPreview\obj\HostSDK\* $sdk -Recurse -Force
$stamp = Get-Content "$sdk\engine.stamp" -Raw
& "$sdk\SurfaceProvisioner\SurfaceProvisioner.exe" --build `
  --project "$PWD\surface\TestUserApp\TestUserApp.csproj" `
  --surface-project "$sdk\surface\Surface\Surface.csproj" `
  --designhostpri-project "$sdk\DesignHost\DesignHost.csproj" `
  --cache "$PWD\vs-extension\obj\matched" --platform x64 --rid win-x64 `
  --engine-stamp $stamp --force-rebuild
```

Use an empty disposable `sdk` directory for a fresh replay. These paths are
deliberately short. An initial attempt under
`vs-extension/SurfaceClient.UITest/TestResults/Migration/MatchedSDK` failed in
MakePRI (`PRI175`, `PRI222`, `APPX0002`, path not found). The same source/packages
built successfully at `vs-extension/obj/sdk`; long output paths remain a tooling
limitation, not a repaired renderer behavior.

Matched-host runtime check (after building the smoke harness):

```powershell
$cache = "$PWD\vs-extension\obj\matched\2.2.0\host"
$before = (Get-FileHash "$cache\Surface.pri").Hash
$run = "$PWD\vs-extension\obj\matched-run"
New-Item -ItemType Directory -Path $run -Force | Out-Null
Copy-Item "$cache\*" $run -Recurse -Force
Copy-Item "$run\Surface.designtime.pri" "$run\Surface.pri" -Force
$env:WINUI_SURFACE_EXE = "$run\Surface.exe"
Remove-Item Env:WINUI_GALLERY_PAGE,Env:SURFACE_GUARDS,Env:SURFACE_LIVE_MODE,`
  Env:SURFACE_DTD_REFLECT,Env:SURFACE_RENDER_SETTLE -ErrorAction SilentlyContinue
& .\vs-extension\SurfaceClient.Smoke\bin\x64\Debug\net472\SurfaceClient.Smoke.exe
if ((Get-FileHash "$cache\Surface.pri").Hash -ne $before) { throw 'Cached PRI changed' }
```

Run that snippet in a disposable PowerShell process; it changes process-local
environment variables. It stages the merged PRI explicitly in the disposable run
copy. **`--user-pri` itself overwrites Surface.pri**: never point it at source,
pristine build output or a cached host. No actual `--user-pri` flag or packaged
identity activation is claimed by this manual-copy runtime check.

### Results on 2026-09-08

- Full no-deploy build: success, using only imported source and restored packages.
  Renderer retains one CA1416 warning; the adapter retains VSTHRD/VSSDK analyzer
  warnings. No behavior cleanup was folded into this import.
- Final VSIX: **43,286,371 bytes**; SHA256
  `9D34C69323E4AD9860694E7104269ACD64F4E088044AE34113805BE63E24D2A4`.
  Absolute artifact path on the validation machine:
  `C:\Users\nikolame\.copilot\repos\copilot-worktrees\WinAppVSCE\nmetulev-congenial-dollop\vs-extension\WinUIXamlPreview\bin\Debug\WinUIXamlPreview.vsix`.
- Actual archive: 111 entries, 28 required files, original license present twice,
  correct handcrafted pkgdef CodeBase, matched embedded/Appx sparse identity,
  no Gallery/test/build-output contamination.
- All four negative packaging/deployment guards passed.
- D2: **10 passed**, D2Residual: **5 passed**.
- Final bundled and matched smoke runs: **66 passed each**, including two
  explicit Ready capability assertions. These exercise PNG frames, malformed-XAML
  recovery, native HWNDs, selection/property editing, non-page classification,
  TestUserApp and existing opt-in design-time behaviors. They are not Gallery tests.
- A validation replay exposed SDK default compile globs including the disposable
  source copies under UITest/TestResults. UITest now explicitly excludes generated
  TestResults/qa-results; the full replay passed without deleting the evidence.
- HostSDK: resolved WASDK **2.2.0**, WinUI component **2.2.1**, complete matched
  self-contained native payload and merged PRI, `CacheHit=False`, no fallback.
  Managed hash prefix **8D2B7EF7** and native prefix **2B22EB61** both matched the
  resolved NuGet component. Cached Surface.pri was unchanged after runtime testing.
- `npm ci --ignore-scripts --no-audit --no-fund`, `npm run compile`: success.
  `npm run lint`: success with 12 existing warnings, zero errors.
  `npx --no-install vsce ls --no-dependencies`: zero migrated paths in package
  enumeration (not a full shipping VS Code artifact test).
- `npm run test:unit`: project-detection Mocha **32 passed**; remaining Node suite
  **484 passed, 5 failed, 313 cancelled** because the existing generated `schemas/`
  inputs were absent. `npm run sync-schemas` could not restore them using the
  PATH-resolved winapp alias (restore exit 1). This pre-existing VS Code prerequisite
  remains unresolved; no unrelated schema/CLI/cache implementation was modified.
- `git diff --check`: success. No Surface child processes remained after tests.

## Explicit user launch action (not performed)

This is an unsigned development VSIX, not a release. On a disposable VS2026 x64
test installation, the **user** may close VS, open the generated VSIX in VSIXInstaller,
choose that installation and approve installation. This changes the chosen VS
installation and must not be confused with the no-deploy build above.
Then open a trusted, built WinUI project/XAML page in that VS instance and use
**View > Other Windows > WinUI XAML Preview**. Opening preview may build/load user
code, create matched-host cache entries, and register the sparse identity.
Developer Mode/registration policy and runtime prerequisites must already be
satisfied by the user. Do not disable policies or silently install runtimes.

No actual IDE open/bundled-to-matched hot-swap, docking, undo, high-contrast,
keyboard, multi-instance, upgrade/uninstall or clean-machine install validation
was performed. The retained manifest advertises a broader VS/architecture range
than the x64 VS2026 development build validated here; this is not a supported
release matrix.

## Known limitations and next boundary

- Baseline matched host remains **unguarded**; no SURFACE_GUARDS changes. Known
  unrecovered pages remain unrecovered. Old 64/64 **Gallery** evidence is historical
  only, unrelated to the local smoke count above.
- Native-only overlays can boot **degraded**; they are neither guaranteed crashes
  nor proof of a truly matched managed/native host. C# provisioning remains the
  future shared implementation; the TypeScript hostBuilder is not imported.
- The renderer still negotiates both `frame-stream` and `native-hwnd`. Protocol
  integer equality alone is not compatibility proof; full C#/TypeScript contract
  extraction/fixtures remain the next milestone.
- DesignHost retains its particular CommunityToolkit 8.2.250402 closure. Arbitrary
  project/resource compatibility, other WASDK versions and external Gallery
  scenarios were not validated.
- In-process build locks, cache keys/fingerprints, immutable publication,
  cross-process concurrency, mutable resource staging, trust/consent and
  structured provisioning outcomes still require the planned shared-foundation
  work. No architecture extraction or speculative fixes were made.
- Release signing, third-party dependency-license audit, publishing ownership,
  supported matrix, dedicated CI runner, lifecycle/UI polish and clean-machine
  certification are later milestones. Existing source notices are preserved,
  not a substitute for that dependency distribution audit.

Implementation stops here: no commits, pushes, PR, deployment, #50 reconciliation,
shared extraction, UI polish or release work.
