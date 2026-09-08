# Shared WinUI Surface foundation

Source ownership:

| Path | Responsibility |
| --- | --- |
| `Surface/` | Existing net10 renderer; frame-stream and optional native-HWND hosting. |
| `DesignHost/` | Resource template, never launched. Fixed CommunityToolkit closure, not arbitrary project resources. |
| `SurfaceProvisioner/` | BCL-only net8 executable; resolved host build, cache identity, publication and CLI. |
| `Shared/HostPayload.cs` | Small internal linked net8/net472 payload manifest validator/run-copy helper; no public runtime library. |
| `protocol/` | Complete descriptive v1 wire specification, TS shapes and linked-production compatibility fixtures. |
| `Build-Payload.ps1` | Fresh x64 renderer/provisioner build and HostSDK distribution inputs. |
| `SurfaceProvisioner.Tests/`, `TestUserApp/` | Non-shipping fixtures. |
| `LICENSE.winui-vsc.txt` | Original MIT notice for the shared imported sources. |

No LSP, WPF, VSSDK or VS Code API dependency belongs here. The net472 adapter,
editor/undo/UI concerns, sparse identity and desktop-MSBuild VSIX packaging remain
in `vs-extension`. The shipping VS Code build is unchanged.

## Build definition versus installed layout

From the repository root:

```powershell
.\surface\Build-Payload.ps1 -Configuration Debug
# Or build/package the VS adapter as well, NEVER deploy:
.\vs-extension\WinUIXamlPreview\Build-Vsix.ps1 -Configuration Debug -NoDeploy
```

Both accept `-WinUISurfaceWasdkVersion`; default **2.2.0**. Renderer and template
retain their original TFM and package pins. The adapter reads the packaged
`Surface/Surface.wasdk.version` rather than treating the wire Ready.wasdk field
(still hardcoded in FrameServer) as authoritative.

Fresh staging/output is under `surface/obj/PayloadBuild` and `surface/obj/HostSDK`.
Shared building holds an exclusive `surface/obj/payload.lock`; a concurrent
shared build fails instead of deleting active build staging. Package generation
is a single-caller operation: do not start another shared payload build while a
package adapter is consuming that staging. This packaging limitation is separate
from the supported cross-process **runtime provisioning** below.

The **installed** backward-compatible HostSDK layout is:

```text
HostSDK/
  surface/Surface/           # renderer sources, not binaries
  DesignHost/                # resource template sources/assets
  SurfaceProvisioner/        # compiled net8 executable + runtime/deps files
  engine.stamp               # SHA256 of shared source/template/assets/helper/provisioner inputs
  LICENSE.winui-vsc.txt
```

The provisioner does not build or clean these sources in place. Installed SDK
directories can be read-only. `vs-extension/obj/IdentityPayload` is the VS-owned
shipping copy; only that copy gets the PE sparse identity, AppxManifest and logos.
No build script discovers prototype/cache output or deploys/registers anything.

## Provisioner CLI contract (v1)

Stdout is **exactly one JSON object followed by a newline**; diagnostics, including
full failed tool output, go to stderr. Callers must concurrently drain both.
Argument errors also produce a structured failure. Existing option names remain;
the previous human-readable stdout presentation is intentionally replaced.

```powershell
$sdk = "$PWD\surface\obj\HostSDK"
& "$sdk\SurfaceProvisioner\SurfaceProvisioner.exe" --build `
  --project "$PWD\surface\TestUserApp\TestUserApp.csproj" `
  --surface-project "$sdk\surface\Surface\Surface.csproj" `
  --designhostpri-project "$sdk\DesignHost\DesignHost.csproj" `
  --cache "$PWD\surface\obj\my-disposable-cache" `
  --engine-stamp (Get-Content "$sdk\engine.stamp" -Raw)
```

Relevant options: `--platform x64`, `--rid win-x64`, `--nuget-cache <path>`,
`--staging-root <short-path>`, `--engine-stamp <stamp>`, `--force-rebuild`,
`--bundled-host <explicit-directory>`, `--cancel-on-stdin`. Only x64/win-x64 is
accepted in this milestone; other architectures fail explicitly.

| `status` | Exit | `success` | Meaning |
| --- | --- | --- | --- |
| `built` | 0 | true | Matched managed/native host + merged PRI verified and atomically published. |
| `cached` | 0 | true | Exact input identity found, all payload hashes and managed/native matches revalidated. |
| `degraded` | 3 | false | Explicit bundled fallback available, or native-only overlay completed. **Not matched success.** |
| `failed` | 1 | false | Invalid/missing inputs, tooling/build/verification failure; preserves originating `error`. |
| `failed`, `cancelled: true` | 130 | false | Cooperative cancellation; never silently falls back. |

Build result fields are camelCase: `contractVersion: 1`, `status`, `success`,
`error: string|null`, `cancelled`, `discoveredVersion`, `versionSource` (0 assets,
1 central props, 2 csproj, 3 not found), `versionSourcePath`, `winUiComponent`,
`hostDir`, `hostExePath`, `mergedPriPath`, `cacheKey`, `engineStamp`, `cacheHit`,
`usedFallback`, `managedHash`, `nativeHash`, `expectedManagedHash`,
`expectedNativeHash`, `managedMatched`, `nativeMatched`, `matchedHost`,
`surfaceBuildSeconds`, `priBuildSeconds`, `totalSeconds`. Nullable path/hash
fields are not usable on failure. `error` is diagnostic text, not a stable code.
Consumers tolerate unknown fields/status extensions but only promote v1
`built`/`cached` with exit 0, success true and a validated returned manifest.
They must not locate a host by version or scrape diagnostic text.

`--prepare-run --host <completed-host-directory> --run-root <NEW-directory>`
creates and validates a disposable copy with `.surface-run` ownership marker.
The destination and its staging sibling must be outside the pristine host.
Canonical Windows component comparisons are case-insensitive and tolerate trailing
separators; `H2` is a valid sibling of `H`, but `H\run` and `H` itself are rejected
before any directory creation. Ambiguous trailing-dot/space components and reparse
ancestors are rejected instead of following aliases into the source.
It returns the same envelope with `status: cached` and new launch paths; this
is a run-copy operation, not another build/hash-match against NuGet.
Both Ctrl+C and `--cancel-on-stdin` cancellation are observed during hashing,
between copy chunks/files, during validation, and before reporting success.
Cancellation returns `status: failed`, `cancelled: true`, `success: false`,
no launch paths and exit **130**. Copying uses a unique sibling
`<run-root>.preparing-<guid>` and publishes by a non-overwriting directory rename.
Cancellation/failure removes only that invocation's partial directory, never an
existing destination or shared generation. Cleanup errors are reported rather
than hidden; a locked/inaccessible directory can require explicit later cleanup.
Invocation-owned directory cleanup does not traverse reparse-point directories.

Legacy native-only overlay arguments (`--project`, `--base-host`, `--out`,
optional `--rid`, `--nuget-cache`, `--allow-download`) remain. Their envelope
contains `contractVersion`, `status`, `success: false`, `cancelled`, `error`
and a nested `overlay` diagnostic record (native source/files/hashes).
Existing output directories are rejected rather than deleted. No overlay is
served as a shared completed matched cache entry. The legacy optional download
path is not validated here; cancellation during its synchronous discovery or
HTTP download is observed at the next copy boundary, not immediate network abort.

`Ctrl+C` cancels builds cooperatively. `--cancel-on-stdin` lets an IDE hold stdin
open and close it to cancel. The provisioner kills/waits for its own active
dotnet process tree on cancellation. VS prefers this path, with a 15-second
PID-tree fallback if unresponsive. Hard termination cannot guarantee staging
cleanup; no broad sweep or root-directory deletion is attempted.

## Input identity, staging, immutability and run copies

Builds use owned short staging at **`%TEMP%\wsp-v2\<16-hex-invocation>`**,
with sibling exclusive `*.lease`. The deterministic root is shared by clients;
random per-invocation names are collision-checked. Only that invocation's child
and lease are removed in `finally`, never source/HostSDK/bin/user caches or the
root. `--staging-root` overrides the root, which must be at most 80 characters.
Long/deep source and cache paths are not passed to MakePRI as project paths.
This avoids the historical deep-worktree MakePRI failure without global installs,
drive mapping, symlinks, registry changes or touching another checkout.

Both projects restore in staging at the resolved WASDK version before cache
lookup. Identity includes:

- Full renderer/template source and assets (not bin/obj or developer settings).
- Shipped engine stamp, exact WASDK + WinUI component, x64/RID and SDK version.
- Resolved engine/template/target TFM/RID target graphs.
- Target project content plus package identities and **actual hashes of every
  file listed by the resolved package closure**, including PRI/resource assets.
- Cache-format version. Inputs are rechecked before publication; changes fail
  rather than publishing a host under a stale key.

This is deliberately conservative and can over-invalidate. A hit still needs
restore tooling and package files and can take tens of seconds; there is no
offline “version-only cache” shortcut. Different target projects are not joined
solely by version. VS resolves the exact entry via structured provisioner output.
The default VS cache root is `%LOCALAPPDATA%\WinUISurface\host-cache`;
tests always use explicit new ignored output caches.

Under `<cache>/v2`, `locks/<key>` is an OS-held, cross-process exclusive file
lock with cancellable waits. Completed entries are immutable generations at
`entries/<key>-<guid>/host`. Publication copies/verifies to a unique sibling
pending directory, atomically renames it, then atomically replaces `keys/<key>`.
Readers see old or new complete generations, never partial output.
`.payload.json` covers **every** file; missing, changed or extra payload files
fail closed. Corrupt entries are not silently overwritten; explicit force-rebuild
publishes a new generation. Legacy caches are never read/migrated/deleted.
Garbage collection of retained generations and hard-kill orphan staging is deferred.

Cache validation, source/package/payload hashing, sealing, copying and publication
observe the build cancellation token. Checks immediately precede cached success,
generation commit, index replacement and success delivery. The atomic generation
rename is the ownership boundary: after it succeeds, cancellation **never deletes
that immutable generation**. A complete generation may remain unindexed, or its
index may already have been replaced, but the cancelled request still returns
exit 130, `failed`, `cancelled: true`, `success: false` and no runnable paths.
Cleanup failures remain visible rather than being masked by a later cancellation.

`--user-pri` still mutates `Surface.pri` in the renderer, intentionally unchanged.
The shared run-copy helper validates a pristine source. **Each SurfaceClient
process**, including warmed spares, copies again to a distinct
`%TEMP%\wsr-v2\<guid>` before passing `--user-pri`; only this private path is
launched and it is disposed after the owned process exits. A mutated run cannot
validate as pristine input. Multiple clients cannot overwrite each other's PRI.
These are ownership/integrity boundaries, not a sandbox or protection against
a malicious process running as the same user.

## Validation and remaining gates

```powershell
.\vs-extension\Test-BuildGuards.ps1
.\vs-extension\Test-Migration.ps1 -IncludeRenderer
.\surface\Test-Foundation.ps1                       # PS7, no native render/build
.\surface\Test-Foundation.ps1 -IncludeBuild -IncludeRenderer
```

The last command runs concurrent real provisioning into a fresh ignored cache,
checks built/cached outcomes, CLI build/run-preparation cancellation, shared run copies and the real
matched smoke with actual `--user-pri`, including two simultaneous process copies.
The dependency-free fixtures invoke the production `--prepare-run` command
dispatch with cancellation injected synchronously before copying, after the
first copied file, and before validation. They assert exit/JSON, absent partial
outputs and unchanged hashes of the entire pristine host, plus preservation of
an existing destination and a destination created concurrently. These are
deterministic command-path regressions, not timer-dependent process tests;
the real-process suite separately exercises stdin EOF cancellation.
The **107** focused fixtures also exercise contained/equal destinations, canonical
case/trailing separators and harmless similarly-prefixed siblings. Deterministic
`--build` tests cancel during cache validation, before cached success, during
publication copying/validation, before/after generation commit and after pointer
replacement. Only external dotnet execution is replaced with fixture outputs;
production dispatch, building orchestration, hashing, validation, publication and
JSON/exit mapping execute. Tests assert immutable predecessor hashes, no partial
entry/index, cancellation without fallback/runnable paths, and retention and
validation of any already-committed generation.
It preserves `surface/obj/Foundation-*/results.json` as test evidence and leaves
no owned child processes. It never uses the default user cache. See
[`docs/designer-migration.md`](../docs/designer-migration.md) for current results.

The full wire contract/test boundary is in [`protocol/README.md`](protocol/README.md).
Protocol v1 has no request IDs/stale-result guarantees or version enforcement;
SetTheme is a compatibility no-op. No renderer rewrite or SURFACE_GUARDS change.
DesignHost's fixed Toolkit closure is still a release limitation, not arbitrary
application resource merging. Real IDE hot-swap, consent/trust, clean-machine
install, broader runtime/architecture matrix, signing, dependency-license audit,
publishing and CI ownership remain explicit later gates.
