// Copyright (c) Microsoft Corporation and Contributors. All rights reserved.
// Licensed under the MIT License.

#nullable enable

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Diagnostics.Tracing;
using System.Linq;
using System.Runtime.InteropServices;
using Microsoft.Diagnostics.Telemetry;
using Microsoft.Diagnostics.Telemetry.Internal;

// The public properties of each event are its payload. Don't rename or retype a shipped property: that breaks
// the processing of that event's data. Never add file paths, project/document names or XAML text.
namespace WinUIXamlPreview.Telemetry.Events
{
    internal static class PrivacyProduct
    {
        // Shared with the WinApp CLI (WIN_APP_DEV_CLI); the previewer is told apart by EventBase.Caller.
        public const ushort WinAppDevCli = 9;
    }

    /// <summary>Process-wide values stamped on every event.</summary>
    internal static class TelemetryContext
    {
        public const string Caller = "vs-xaml-previewer";

        public static readonly string AppVersion = SafeGet(() => typeof(TelemetryContext).Assembly.GetName().Version?.ToString()) ?? "Unknown";

        public static readonly string HostVersion = SafeGet(() =>
        {
            using var self = Process.GetCurrentProcess();
            return FileVersionInfo.GetVersionInfo(self.MainModule!.FileName!).ProductVersion;
        }) ?? "Unknown";

        public static readonly string OsArch = SafeGet(() => RuntimeInformation.OSArchitecture.ToString()) ?? "Unknown";

        public static readonly string ProcessArch = SafeGet(() => RuntimeInformation.ProcessArchitecture.ToString()) ?? "Unknown";

        public static readonly bool IsCI = DetectCI();

        private static bool DetectCI()
        {
            foreach (var name in new[] { "CI", "TF_BUILD", "GITHUB_ACTIONS", "BUILD_BUILDID", "JENKINS_URL", "TEAMCITY_VERSION", "GITLAB_CI", "APPVEYOR" })
            {
                var value = Environment.GetEnvironmentVariable(name);
                if (!string.IsNullOrEmpty(value) && !string.Equals(value, "false", StringComparison.OrdinalIgnoreCase) && value != "0")
                {
                    return true;
                }
            }

            return false;
        }

        private static string? SafeGet(Func<string?> get)
        {
            try { return get(); }
            catch { return null; }
        }
    }

    /// <summary>Base class for all previewer telemetry events so they're consistently tagged.</summary>
    [EventData]
    internal abstract class EventBase
    {
#pragma warning disable CA1707 // Identifiers should not contain underscores
        public abstract PartA_PrivTags PartA_PrivTags { get; }

        /// <summary>Must be set for the event to be logged when in the WinExt provider group.</summary>
        public ushort PartA_PrivacyProduct { get; } = PrivacyProduct.WinAppDevCli;
#pragma warning restore CA1707

        public string AppVersion { get; } = TelemetryContext.AppVersion;

        public string Caller { get; } = TelemetryContext.Caller;

        public string VsVersion { get; } = TelemetryContext.HostVersion;

        public string OsArch { get; } = TelemetryContext.OsArch;

        public string ProcessArch { get; } = TelemetryContext.ProcessArch;

        public bool CI { get; } = TelemetryContext.IsCI;

        /// <summary>"direct" or "ci" (matches the CLI's field; the previewer is never agent-invoked).</summary>
        public string SenderOrigin { get; } = TelemetryContext.IsCI ? "ci" : "direct";

        /// <summary>
        /// Replace every string that might carry PII. Called by <see cref="PreviewTelemetry"/> before logging;
        /// abstract so each event has to consider it.
        /// </summary>
        public abstract void ReplaceSensitiveStrings(Func<string, string> replaceSensitiveStrings);
    }

    /// <summary>A preview session started for a document (first open, project rebuild, theme/DPI relaunch, recovery).</summary>
    [EventData]
    internal sealed class PreviewOpenedEvent : EventBase
    {
        public string Trigger { get; set; } = "open";
        public bool SampleData { get; set; }
        public string DesignMode { get; set; } = string.Empty;
        public string Theme { get; set; } = string.Empty;
        public bool FullFidelityAutoBuild { get; set; }
        public bool PreferNative { get; set; }
        public bool HasProjectOutput { get; set; }
        public bool IsPackagedBuild { get; set; }
        public bool IdentityFallback { get; set; }
        public string Fidelity { get; set; } = string.Empty;
        public bool NeedsUpgrade { get; set; }
        public string? TargetWasdk { get; set; }
        public string? BundledWasdk { get; set; }

        public override PartA_PrivTags PartA_PrivTags => PrivTags.ProductAndServiceUsage;

        public override void ReplaceSensitiveStrings(Func<string, string> replaceSensitiveStrings)
        {
        }
    }

    /// <summary>Sparse-identity registration for packaged (MSIX) projects. Only real attempts are reported, not cache hits.</summary>
    [EventData]
    internal sealed class SurfaceRegistrationEvent : EventBase
    {
        public string Outcome { get; set; } = string.Empty;
        public long DurationMs { get; set; }
        public string? ErrorCode { get; set; }
        public bool Experimental { get; set; }

        public override PartA_PrivTags PartA_PrivTags => PrivTags.ProductAndServicePerformance;

        public override void ReplaceSensitiveStrings(Func<string, string> replaceSensitiveStrings)
        {
        }
    }

    /// <summary>Time from starting a surface (open, rebuild, theme/DPI relaunch, full-fidelity swap) to its first painted frame or error.</summary>
    [EventData]
    internal sealed class FirstFrameEvent : EventBase
    {
        public string Trigger { get; set; } = string.Empty;
        public string Outcome { get; set; } = string.Empty;
        public long DurationMs { get; set; }
        public bool Native { get; set; }
        public string Host { get; set; } = string.Empty;

        public override PartA_PrivTags PartA_PrivTags => PrivTags.ProductAndServicePerformance;

        public override void ReplaceSensitiveStrings(Func<string, string> replaceSensitiveStrings)
        {
        }
    }

    /// <summary>The surface couldn't render the document. Only a coarse category is sent, never the message.</summary>
    [EventData]
    internal sealed class RenderFailedEvent : EventBase
    {
        public string Phase { get; set; } = string.Empty;
        public string Category { get; set; } = string.Empty;
        public bool NotDesignable { get; set; }
        public bool OverLastRender { get; set; }
        public bool HeldForFullFidelity { get; set; }
        public string Host { get; set; } = string.Empty;

        public override PartA_PrivTags PartA_PrivTags => PrivTags.ProductAndServicePerformance;

        public override void ReplaceSensitiveStrings(Func<string, string> replaceSensitiveStrings)
        {
        }
    }

    /// <summary>The active surface process died unexpectedly, and what the previewer did about it.</summary>
    [EventData]
    internal sealed class SurfaceCrashedEvent : EventBase
    {
        public string Reason { get; set; } = string.Empty;
        public string? ExitCode { get; set; }
        public string Action { get; set; } = string.Empty;
        public int Attempt { get; set; }
        public int MaxAttempts { get; set; }
        public bool HadRender { get; set; }
        public string Host { get; set; } = string.Empty;

        public override PartA_PrivTags PartA_PrivTags => PrivTags.ProductAndServicePerformance;

        public override void ReplaceSensitiveStrings(Func<string, string> replaceSensitiveStrings)
        {
        }
    }

    /// <summary>A crashed surface was replaced and painted again.</summary>
    [EventData]
    internal sealed class SurfaceReconnectedEvent : EventBase
    {
        /// <summary>"spare" (pre-warmed process promoted) or "cold" (fresh relaunch).</summary>
        public string Via { get; set; } = string.Empty;
        public string Outcome { get; set; } = string.Empty;
        public long DurationMs { get; set; }

        public override PartA_PrivTags PartA_PrivTags => PrivTags.ProductAndServicePerformance;

        public override void ReplaceSensitiveStrings(Func<string, string> replaceSensitiveStrings)
        {
        }
    }

    /// <summary>Building or launching a version-matched (full-fidelity) host.</summary>
    [EventData]
    internal sealed class FullFidelityBuildEvent : EventBase
    {
        public string Kind { get; set; } = string.Empty;
        public string Outcome { get; set; } = string.Empty;
        public string? TargetWasdk { get; set; }
        public long DurationMs { get; set; }
        public bool WasdkMismatch { get; set; }

        public override PartA_PrivTags PartA_PrivTags => PrivTags.ProductAndServicePerformance;

        public override void ReplaceSensitiveStrings(Func<string, string> replaceSensitiveStrings)
        {
        }
    }

    /// <summary>
    /// WinUI controls left out of a bundled-host preview because they're newer than its WinAppSDK ("shown"), or the
    /// user turning on full fidelity from that note ("turn-on"). Type names are public WinUI framework types only.
    /// </summary>
    [EventData]
    internal sealed class NewerTypesLeftOutEvent : EventBase
    {
        public string Action { get; set; } = string.Empty;
        public string Types { get; set; } = string.Empty;
        public int TypeCount { get; set; }
        public string? TargetWasdk { get; set; }
        public string? BundledWasdk { get; set; }
        public bool OfferedFullFidelity { get; set; }

        public override PartA_PrivTags PartA_PrivTags => PrivTags.ProductAndServiceUsage;

        public override void ReplaceSensitiveStrings(Func<string, string> replaceSensitiveStrings)
        {
        }

        /// <summary>Keep only identifier-shaped names (the surface reports framework type names), capped.</summary>
        internal static (string Types, int Count) Format(IEnumerable<string>? names)
        {
            var list = (names ?? Enumerable.Empty<string>())
                .Where(TelemetryClassifier.IsTypeName)
                .Distinct(StringComparer.Ordinal)
                .ToList();
            return (string.Join(",", list.Take(20)), list.Count);
        }
    }

    /// <summary>The previewed app's own code threw on the surface's UI thread and the host contained it (or couldn't, for layout code).</summary>
    [EventData]
    internal sealed class AppCodeFaultContainedEvent : EventBase
    {
        public string Kind { get; set; } = string.Empty;
        public string Host { get; set; } = string.Empty;

        public override PartA_PrivTags PartA_PrivTags => PrivTags.ProductAndServicePerformance;

        public override void ReplaceSensitiveStrings(Func<string, string> replaceSensitiveStrings)
        {
        }
    }

    /// <summary>The user switched sample (design-time) data on or off from the toolbar.</summary>
    [EventData]
    internal sealed class SampleDataToggledEvent : EventBase
    {
        public bool On { get; set; }

        public override PartA_PrivTags PartA_PrivTags => PrivTags.ProductAndServiceUsage;

        public override void ReplaceSensitiveStrings(Func<string, string> replaceSensitiveStrings)
        {
        }
    }

    /// <summary>An exception the previewer caught. Message, inner message and stacks are scrubbed.</summary>
    [EventData]
    internal sealed class ExceptionThrownEvent : EventBase
    {
        internal ExceptionThrownEvent(string action, Exception e)
        {
            Action = action;
            Name = e.GetType().Name;
            StackTrace = e.StackTrace;
            InnerName = e.InnerException?.GetType().Name;
            Message = e.Message ?? string.Empty;
            InnerMessage = e.InnerException?.Message;

            var sb = new System.Text.StringBuilder();
            for (var inner = e.InnerException; inner != null; inner = inner.InnerException)
            {
                sb.Append(inner.StackTrace);
                sb.AppendLine();
                sb.AppendLine();
            }

            InnerStackTrace = sb.ToString();
        }

        public string Action { get; private set; }
        public string Name { get; private set; }
        public string? StackTrace { get; private set; }
        public string? InnerName { get; private set; }
        public string? InnerMessage { get; private set; }
        public string InnerStackTrace { get; private set; }
        public string Message { get; private set; }

        public override PartA_PrivTags PartA_PrivTags => PrivTags.ProductAndServicePerformance;

        public override void ReplaceSensitiveStrings(Func<string, string> replaceSensitiveStrings)
        {
            Action = replaceSensitiveStrings(Action);
            Message = replaceSensitiveStrings(Message);
            InnerMessage = InnerMessage != null ? replaceSensitiveStrings(InnerMessage) : null;
            StackTrace = StackTrace != null ? replaceSensitiveStrings(StackTrace) : null;
            InnerStackTrace = replaceSensitiveStrings(InnerStackTrace);
        }
    }
}
