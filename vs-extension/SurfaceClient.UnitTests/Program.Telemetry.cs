#nullable enable

using System;
using System.Collections.Generic;
using System.Diagnostics.Tracing;
using System.Linq;
using WinUIXamlPreview.Telemetry;
using WinUIXamlPreview.Telemetry.Events;

namespace WinUIXamlPreview.UnitTests;

internal static partial class Program
{
    private static void TelemetryTests()
    {
        // Tokens: short identifiers pass; anything that could carry user text collapses.
        Eq("token: version passes", "1.8.250916003", TelemetryClassifier.Token("1.8.250916003"));
        Eq("token: path collapses", "other", TelemetryClassifier.Token(@"C:\Users\me\App"));
        Eq("token: spaces collapse", "other", TelemetryClassifier.Token("my project"));
        Eq("token: null stays null", null, TelemetryClassifier.Token(null));

        // Render error categories (the message itself is never sent).
        Eq("render: unknown type", "unknown-type", TelemetryClassifier.RenderErrorCategory("Preview couldn't create <local:Foo> — the type wasn't found."));
        Eq("render: parse", "parse", TelemetryClassifier.RenderErrorCategory("XamlParseException [Line: 3 Position: 5]"));
        Eq("render: missing resource", "missing-resource", TelemetryClassifier.RenderErrorCategory("Cannot find a Resource with the Name/Key AccentBrush"));
        Eq("render: assembly", "assembly-load", TelemetryClassifier.RenderErrorCategory("Could not load file or assembly 'Contoso.Controls'"));
        Eq("render: empty", "none", TelemetryClassifier.RenderErrorCategory(""));

        // Close reasons and exit codes.
        Eq("close: hung", "hung", TelemetryClassifier.CloseReason("Surface stopped responding (no reply for 10s)."));
        Eq("close: exited", "exited", TelemetryClassifier.CloseReason("Surface process exited (code=0xC0000409)."));
        Eq("close: exit code", "0xC0000409", TelemetryClassifier.ExitCode("Surface process exited (code=0xC0000409)."));
        Eq("close: no code", null, TelemetryClassifier.ExitCode("Surface stopped responding."));
        Eq("hresult: found", "0x80073CFF", TelemetryClassifier.HResult("Add-AppxPackage failed: 0x80073cff, Developer Mode is off"));
        Eq("hresult: none", null, TelemetryClassifier.HResult("Access denied"));

        // Scrub: paths (with spaces, UNC, file URIs) and the user name never survive.
        var user = Environment.UserName;
        var scrubbed = PreviewTelemetry.Scrub(
            $@"Failed at C:\Users\{user}\source\My App\MainPage.xaml and \\server\share\x.dll and file:///D:/repo/a.xaml; user {user}");
        Check("scrub: no drive path", !scrubbed.Contains(@"C:\"), scrubbed);
        Check("scrub: no project folder", !scrubbed.Contains("My App") && !scrubbed.Contains("MainPage"), scrubbed);
        Check("scrub: no UNC", !scrubbed.Contains("server"), scrubbed);
        Check("scrub: no file uri", !scrubbed.Contains("repo"), scrubbed);
        Check("scrub: no user name", user.Length <= 3 || scrubbed.IndexOf(user, StringComparison.OrdinalIgnoreCase) < 0, scrubbed);
        Check("scrub: keeps text", scrubbed.StartsWith("Failed at <Path>", StringComparison.Ordinal), scrubbed);

        // NewerTypes: only identifier-shaped names, de-duplicated, capped at 20.
        var (types, count) = NewerTypesLeftOutEvent.Format(new[] { "TitleBar", "TitleBar", @"C:\x", "local:Foo", "SelectorBar" });
        Eq("newer: names", "TitleBar,SelectorBar", types);
        Eq("newer: count", 2, count);
        var (capped, all) = NewerTypesLeftOutEvent.Format(Enumerable.Range(0, 30).Select(i => "Type" + i));
        Eq("newer: capped", 20, capped.Split(',').Length);
        Eq("newer: full count", 30, all);

        // End to end through the stub EventSource: the payload carries the shared tags and no paths.
        using var listener = new CapturingListener();
        PreviewTelemetry.Log("PreviewOpened", new PreviewOpenedEvent { Trigger = "open", Fidelity = "Baseline", TargetWasdk = "1.8.250916003" });
        PreviewTelemetry.LogException("UnitTest", new InvalidOperationException($@"boom in C:\Users\{user}\source\App\Page.xaml"));

        var opened = listener.Events.FirstOrDefault(e => e.EventName == "PreviewOpened");
        Check("event: PreviewOpened written", opened != null);
        if (opened != null)
        {
            var payload = ToDictionary(opened);
            Eq("event: caller", "vs-xaml-previewer", payload.TryGetValue("Caller", out var c) ? c as string : null);
            Eq("event: privacy product", "9", payload.TryGetValue("PartA_PrivacyProduct", out var p) ? Convert.ToString(p) : null);
            Eq("event: trigger", "open", payload.TryGetValue("Trigger", out var t) ? t as string : null);
            Check("event: has VsVersion", payload.ContainsKey("VsVersion"));
        }

        var thrown = listener.Events.FirstOrDefault(e => e.EventName == PreviewTelemetry.ExceptionThrownEventName);
        Check("event: ExceptionThrown written", thrown != null);
        if (thrown != null)
        {
            var payload = ToDictionary(thrown);
            var message = payload.TryGetValue("Message", out var m) ? m as string ?? string.Empty : string.Empty;
            Check("event: exception message scrubbed", message.Contains("<Path>") && !message.Contains("Page.xaml"), message);
            Eq("event: exception name", "InvalidOperationException", payload.TryGetValue("Name", out var n) ? n as string : null);
        }
    }

    private static Dictionary<string, object?> ToDictionary(EventWrittenEventArgs e)
    {
        var map = new Dictionary<string, object?>(StringComparer.Ordinal);
        for (var i = 0; i < (e.PayloadNames?.Count ?? 0); i++)
        {
            map[e.PayloadNames![i]] = e.Payload![i];
        }

        return map;
    }

    private sealed class CapturingListener : EventListener
    {
        public List<EventWrittenEventArgs> Events { get; } = new();

        protected override void OnEventSourceCreated(EventSource eventSource)
        {
            if (eventSource.Name == PreviewTelemetry.ProviderName)
            {
                EnableEvents(eventSource, EventLevel.Verbose, EventKeywords.All);
            }
        }

        protected override void OnEventWritten(EventWrittenEventArgs eventData)
        {
            lock (Events)
            {
                Events.Add(eventData);
            }
        }
    }
}
