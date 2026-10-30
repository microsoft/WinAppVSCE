#nullable enable

using System;
using System.Globalization;
using System.Threading;
using WinUIXamlPreview.Editor;

namespace WinUIXamlPreview.UnitTests;

// PreviewSettingsParser: the rules PreviewOptions applies to values read from (and written to) the VS
// settings store. A hand-edited or corrupted store must never produce an unusable pane or canvas size.
internal static partial class Program
{
    private static void PreviewSettingsTests()
    {
        const double lo = PreviewSettingsParser.MinWidth, hi = PreviewSettingsParser.MaxWidth, dflt = PreviewSettingsParser.DefaultWidth;

        // Pane sizes: in range kept, out of range clamped, garbage -> default.
        Eq("size: in range kept", 600.0, PreviewSettingsParser.ParseSize("600", dflt, lo, hi));
        Eq("size: fractional kept", 612.5, PreviewSettingsParser.ParseSize("612.5", dflt, lo, hi));
        Eq("size: below min clamps", lo, PreviewSettingsParser.ParseSize("10", dflt, lo, hi));
        Eq("size: negative clamps", lo, PreviewSettingsParser.ParseSize("-500", dflt, lo, hi));
        Eq("size: above max clamps", hi, PreviewSettingsParser.ParseSize("99999", dflt, lo, hi));
        Eq("size: Infinity clamps to max", hi, PreviewSettingsParser.ParseSize("Infinity", dflt, lo, hi));
        Eq("size: -Infinity clamps to min", lo, PreviewSettingsParser.ParseSize("-Infinity", dflt, lo, hi));
        Eq("size: NaN -> default (was passed through to layout)", dflt, PreviewSettingsParser.ParseSize("NaN", dflt, lo, hi));
        foreach (var bad in new[] { null, "", "   ", "wide", "12px", "1e999" })
            Eq($"size: '{bad ?? "<null>"}' -> default", dflt, PreviewSettingsParser.ParseSize(bad, dflt, lo, hi));
        Eq("size: surrounding whitespace tolerated", 700.0, PreviewSettingsParser.ParseSize(" 700 ", dflt, lo, hi));

        // Clamp (also used by the drag handler and the setters).
        Eq("clamp: NaN -> lo", lo, PreviewSettingsParser.Clamp(double.NaN, lo, hi));
        Eq("clamp: edges inclusive", lo, PreviewSettingsParser.Clamp(lo, lo, hi));
        Eq("clamp: edges inclusive (hi)", hi, PreviewSettingsParser.Clamp(hi, lo, hi));

        // Persisted values are invariant-culture, so a comma-decimal UI culture must not change them.
        var saved = Thread.CurrentThread.CurrentCulture;
        try
        {
            Thread.CurrentThread.CurrentCulture = new CultureInfo("de-DE");
            var text = PreviewSettingsParser.FormatDouble(612.5);
            Eq("format: invariant under de-DE", "612.5", text);
            Eq("round-trip under de-DE", 612.5, PreviewSettingsParser.ParseSize(text, dflt, lo, hi));
        }
        finally { Thread.CurrentThread.CurrentCulture = saved; }

        // Canvas override: 0 = auto, anything non-positive/NaN/garbage is auto, capped at MaxCanvas.
        Eq("canvas: preset kept", 1920.0, PreviewSettingsParser.ParseCanvas("1920"));
        Eq("canvas: 0 is auto", 0.0, PreviewSettingsParser.ParseCanvas("0"));
        Eq("canvas: negative -> auto", 0.0, PreviewSettingsParser.ParseCanvas("-1"));
        Eq("canvas: NaN -> auto", 0.0, PreviewSettingsParser.ParseCanvas("NaN"));
        Eq("canvas: garbage -> auto", 0.0, PreviewSettingsParser.ParseCanvas("big"));
        Eq("canvas: null -> auto", 0.0, PreviewSettingsParser.ParseCanvas(null));
        Eq("canvas: huge capped", PreviewSettingsParser.MaxCanvas, PreviewSettingsParser.ParseCanvas("100000"));
        Eq("canvas: Infinity capped", PreviewSettingsParser.MaxCanvas, PreviewSettingsParser.ParseCanvas("Infinity"));
        Eq("canvas setter: NaN -> auto", 0.0, PreviewSettingsParser.NormalizeCanvas(double.NaN));
        Eq("canvas setter: huge capped (matches load)", PreviewSettingsParser.MaxCanvas, PreviewSettingsParser.NormalizeCanvas(1e9));

        // Location: only "Bottom" (any case) docks bottom.
        Eq("location: Bottom", PreviewLocation.Bottom, PreviewSettingsParser.ParseLocation("Bottom"));
        Eq("location: case-insensitive", PreviewLocation.Bottom, PreviewSettingsParser.ParseLocation("bOTTOM"));
        Eq("location: Right", PreviewLocation.Right, PreviewSettingsParser.ParseLocation("Right"));
        Eq("location: garbage -> Right", PreviewLocation.Right, PreviewSettingsParser.ParseLocation("Left"));
        Eq("location: null -> Right", PreviewLocation.Right, PreviewSettingsParser.ParseLocation(null));
        foreach (PreviewLocation l in Enum.GetValues(typeof(PreviewLocation)))
            Eq($"location round-trip {l}", l, PreviewSettingsParser.ParseLocation(PreviewSettingsParser.FormatLocation(l)));

        // Theme: exactly Light | Dark | Default; anything else (including wrong case) is Light.
        Eq("theme: Dark", "Dark", PreviewSettingsParser.NormalizeTheme("Dark"));
        Eq("theme: Default", "Default", PreviewSettingsParser.NormalizeTheme("Default"));
        Eq("theme: Light", "Light", PreviewSettingsParser.NormalizeTheme("Light"));
        Eq("theme: wrong case -> Light", "Light", PreviewSettingsParser.NormalizeTheme("dark"));
        Eq("theme: garbage -> Light", "Light", PreviewSettingsParser.NormalizeTheme("HighContrast"));
        Eq("theme: null -> Light", "Light", PreviewSettingsParser.NormalizeTheme(null));

        // Flags: default-off needs an explicit "1"; default-on needs an explicit "0" to turn off.
        Eq("flag: 1 on", true, PreviewSettingsParser.ParseFlag("1"));
        Eq("flag: 0 off", false, PreviewSettingsParser.ParseFlag("0"));
        foreach (var bad in new[] { null, "", "true", "yes", " 1" })
        {
            Eq($"flag: '{bad ?? "<null>"}' off", false, PreviewSettingsParser.ParseFlag(bad));
            Eq($"flag(default on): '{bad ?? "<null>"}' on", true, PreviewSettingsParser.ParseFlagDefaultOn(bad));
        }
        Eq("flag(default on): 0 off", false, PreviewSettingsParser.ParseFlagDefaultOn("0"));
        foreach (var b in new[] { true, false })
        {
            Eq($"flag round-trip {b}", b, PreviewSettingsParser.ParseFlag(PreviewSettingsParser.FormatFlag(b)));
            Eq($"flag(default on) round-trip {b}", b, PreviewSettingsParser.ParseFlagDefaultOn(PreviewSettingsParser.FormatFlag(b)));
        }
    }
}
