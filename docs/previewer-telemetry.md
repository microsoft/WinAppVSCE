# WinApp XAML Previewer telemetry

The Visual Studio previewer (`vs-extension\WinUIXamlPreview`) sends usage and reliability events through the same
ETW provider and privacy product as the WinApp CLI (`Microsoft.Windows.WinAppDevCLI`, privacy product 9). Every
event has `Caller = "vs-xaml-previewer"`, which is how the previewer's data is told apart from the CLI's.

Code: `vs-extension\WinUIXamlPreview\Telemetry\` (events, classifier, writer) and
`UI\PreviewControl.Telemetry.cs` (hooks).

## Opting out

Events stay on the machine (local ETW only) when either of these is true:

- the Visual Studio Customer Experience Improvement Program is off (**Help > Privacy > Privacy Settings**), or
- `WINAPP_CLI_TELEMETRY_OPTOUT=1` is set (the same variable as the WinApp CLI).

Dev and CI builds compile a stub `TelemetryEventSource`, so nothing uploads from them regardless. Release builds run
`vs-extension\Unstub-Telemetry.ps1 -TelemetryProviderGuid <guid> -TelemetryPackageVersion <version>`, which swaps the
stub for the internal `Microsoft.Telemetry.Inbox.Managed` package and joins the provider group.

## What is never sent

File paths, document or project names, XAML text, error messages, or user and machine names. Exception messages and
stack traces are scrubbed of paths and user/machine names first. Other strings are fixed tokens, versions, or coarse
categories. The only type names sent are public WinUI framework types in `NewerTypesLeftOut`.

## Common fields

`AppVersion`, `Caller`, `VsVersion`, `OsArch`, `ProcessArch`, `CI`, `SenderOrigin`, plus the privacy tags.

## Events

| Event | When | Fields |
|---|---|---|
| `PreviewOpened` | A preview session starts for a document | `Trigger` (open, rebuild, dpi, theme, fidelity, recover.cold), `SampleData`, `DesignMode`, `Theme`, `FullFidelityAutoBuild`, `PreferNative`, `HasProjectOutput`, `IsPackagedBuild`, `IdentityFallback`, `Fidelity`, `NeedsUpgrade`, `TargetWasdk`, `BundledWasdk` |
| `SurfaceRegistration` | A sparse-identity registration attempt for a packaged project | `Outcome` (no-payload, already-fast, already, registered, failed, timeout, no-powershell, error), `DurationMs`, `ErrorCode` (HRESULT only), `Experimental` |
| `FirstFrame` | First paint (or error) after a launch | `Trigger` (open, rebuild, dpi, theme, fidelity, upgrade.swap), `Outcome`, `DurationMs`, `Native`, `Host` (bundled, matched) |
| `RenderFailed` | The surface couldn't render; once per phase and category per document | `Phase`, `Category`, `NotDesignable`, `OverLastRender`, `HeldForFullFidelity`, `Host` |
| `SurfaceCrashed` | The active surface process died unexpectedly | `Reason` (hung, exited, start-timeout, …), `ExitCode`, `Action` (recover-spare, recover-cold, protocol-mismatch, exhausted, give-up), `Attempt`, `MaxAttempts`, `HadRender`, `Host` |
| `SurfaceReconnected` | A crashed surface was replaced and painted again | `Via` (spare, cold), `Outcome`, `DurationMs` |
| `FullFidelityBuild` | Building or launching a version-matched host | `Kind` (build, cached), `Outcome` (swapped, build-failed, start-failed, superseded, no-sdk, previously-failed), `TargetWasdk`, `DurationMs`, `WasdkMismatch` |
| `NewerTypesLeftOut` | The "newer controls left out" note is shown, or its Turn on action is used | `Action` (shown, turn-on), `Types`, `TypeCount`, `TargetWasdk`, `BundledWasdk`, `OfferedFullFidelity` |
| `AppCodeFaultContained` | The previewed app's code threw on the surface UI thread; once per kind per document | `Kind` (contained, layout-fatal), `Host` |
| `SampleDataToggled` | The user toggles sample data from the toolbar | `On` |
| `ExceptionThrown` | The previewer caught an unexpected exception | `Action`, `Name`, `Message`, `StackTrace`, `InnerName`, `InnerMessage`, `InnerStackTrace` (all scrubbed) |

Don't rename or retype a shipped field; that breaks processing of existing data.

## Watching events locally

Events are written to ETW even when they don't upload. The previewer log (`preview.log`) records a
`Telemetry: <EventName>` line for each one, with `(local only)` when uploads are off.
