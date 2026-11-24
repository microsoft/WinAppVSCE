#nullable enable

using System;
using System.Collections.Generic;
using WinUIXamlPreview.Editor;
using WinUIXamlPreview.Protocol;
using WinUIXamlPreview.Telemetry;
using WinUIXamlPreview.Telemetry.Events;

namespace WinUIXamlPreview.UI
{
    /// <summary>
    /// Telemetry hooks for the preview control. Kept in one file so call sites in the main control stay one-liners.
    /// Payloads are coarse tokens and counts only: never paths, document/project names, XAML or error messages.
    /// </summary>
    public partial class PreviewControl
    {
        private string TelemetryHost => string.IsNullOrEmpty(_activeUserPri) ? "bundled" : "matched";

        /// <summary>True the first time <paramref name="key"/> is seen for the current document.</summary>
        private bool TelemetryOncePerDocument(string key) => _telemetrySent.Add(key);

        private void TelemetryPreviewOpened(HostSelection? plan, string? userDll, bool identityFallback)
        {
            try
            {
                _telemetrySent.Clear();
                PreviewTelemetry.Log("PreviewOpened", new PreviewOpenedEvent
                {
                    Trigger = TelemetryClassifier.Token(_telemetryOpenTrigger) ?? "other",
                    SampleData = PreviewOptions.DesignTimeData,
                    DesignMode = PreviewOptions.DesignMode ? "design" : "interact",
                    Theme = TelemetryClassifier.Token(PreviewOptions.Theme) ?? "other",
                    FullFidelityAutoBuild = PreviewOptions.FullFidelityAutoBuild,
                    PreferNative = PreferNative,
                    HasProjectOutput = userDll != null,
                    IsPackagedBuild = userDll != null && ProjectDllLocator.IsPackagedBuild(userDll),
                    IdentityFallback = identityFallback,
                    Fidelity = plan != null ? plan.Fidelity.ToString() : "none",
                    NeedsUpgrade = plan?.NeedsUpgrade ?? false,
                    TargetWasdk = TelemetryClassifier.Token(plan?.TargetVersion),
                    BundledWasdk = TelemetryClassifier.Token(MatchedHostResolver.BundledVersion),
                });
            }
            catch (Exception ex)
            {
                Logging.Log.Write("Telemetry (PreviewOpened) failed: " + ex.Message);
            }
            finally
            {
                _telemetryOpenTrigger = "open";
            }
        }

        /// <summary>Called when a PERF span closes: first paint after a launch, or the paint that ends a crash recovery.</summary>
        private void TelemetryPaintSpan(string? label, long ms, string outcome)
        {
            if (label == null)
            {
                return;
            }

            if (label == "recover.spare" || label == "recover.cold")
            {
                PreviewTelemetry.Log("SurfaceReconnected", new SurfaceReconnectedEvent
                {
                    Via = label == "recover.spare" ? "spare" : "cold",
                    Outcome = TelemetryClassifier.Token(outcome) ?? "other",
                    DurationMs = ms,
                });
                return;
            }

            switch (label)
            {
                case "open":
                case "rebuild":
                case "dpi":
                case "theme":
                case "fidelity":
                case "upgrade.swap":
                    PreviewTelemetry.Log("FirstFrame", new FirstFrameEvent
                    {
                        Trigger = label,
                        Outcome = TelemetryClassifier.Token(outcome) ?? "other",
                        DurationMs = ms,
                        Native = PreferNative && _nativeSupported,
                        Host = TelemetryHost,
                    });
                    break;
            }
        }

        private void TelemetryRenderFailed(ErrorMsg err, ErrorDisplay kind, bool held)
        {
            var phase = TelemetryClassifier.Token(err.Phase) ?? "none";
            var category = err.NotDesignable ? "not-designable" : TelemetryClassifier.RenderErrorCategory(err.Message);
            if (!TelemetryOncePerDocument("render:" + phase + ":" + category))
            {
                return;
            }

            PreviewTelemetry.Log("RenderFailed", new RenderFailedEvent
            {
                Phase = phase,
                Category = category,
                NotDesignable = err.NotDesignable,
                OverLastRender = kind == ErrorDisplay.BannerOverLastRender,
                HeldForFullFidelity = held,
                Host = TelemetryHost,
            });
        }

        private void TelemetrySurfaceCrashed(string reason, ActiveDeathAction action, bool usedSpare, bool hadRender)
        {
            var restarts = _session.Restarts;
            string actionToken;
            switch (action)
            {
                case ActiveDeathAction.ProtocolMismatch: actionToken = "protocol-mismatch"; break;
                case ActiveDeathAction.Recover: actionToken = usedSpare ? "recover-spare" : "recover-cold"; break;
                default: actionToken = restarts.Exhausted ? "exhausted" : "give-up"; break;
            }

            PreviewTelemetry.LogError("SurfaceCrashed", new SurfaceCrashedEvent
            {
                Reason = TelemetryClassifier.CloseReason(reason),
                ExitCode = TelemetryClassifier.ExitCode(reason),
                Action = actionToken,
                Attempt = restarts.Attempts,
                MaxAttempts = restarts.MaxAttempts,
                HadRender = hadRender,
                Host = TelemetryHost,
            });
        }

        private static void TelemetryFullFidelityBuild(string kind, string outcome, string? targetVersion, System.Diagnostics.Stopwatch? sw, bool wasdkMismatch = false)
        {
            PreviewTelemetry.Log("FullFidelityBuild", new FullFidelityBuildEvent
            {
                Kind = kind,
                Outcome = outcome,
                TargetWasdk = TelemetryClassifier.Token(targetVersion),
                DurationMs = sw?.ElapsedMilliseconds ?? 0,
                WasdkMismatch = wasdkMismatch,
            });
        }

        private void TelemetryNewerTypes(string action, IEnumerable<string>? types, string? targetVersion, bool offeredFullFidelity)
        {
            if (action == "shown" && !TelemetryOncePerDocument("newer:shown"))
            {
                return;
            }

            var (names, count) = NewerTypesLeftOutEvent.Format(types);
            PreviewTelemetry.Log("NewerTypesLeftOut", new NewerTypesLeftOutEvent
            {
                Action = action,
                Types = names,
                TypeCount = count,
                TargetWasdk = TelemetryClassifier.Token(targetVersion),
                BundledWasdk = TelemetryClassifier.Token(MatchedHostResolver.BundledVersion),
                OfferedFullFidelity = offeredFullFidelity,
            });
        }

        private void OnAppCodeFault(SurfaceClient source, bool layoutFatal)
        {
            _ = Dispatcher.InvokeAsync(() =>
            {
                if (_disposed || IsStale(source, "AppCodeFault"))
                {
                    return;
                }

                var kind = layoutFatal ? "layout-fatal" : "contained";
                if (TelemetryOncePerDocument("appfault:" + kind))
                {
                    PreviewTelemetry.Log("AppCodeFaultContained", new AppCodeFaultContainedEvent { Kind = kind, Host = TelemetryHost });
                }
            });
        }
    }
}
