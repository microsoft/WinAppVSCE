#nullable enable

using System;
using System.Globalization;

namespace WinUIXamlPreview.Editor
{
    /// <summary>Where the in-editor preview margin docks relative to the XAML text.</summary>
    internal enum PreviewLocation
    {
        Right,
        Bottom,
    }

    /// <summary>
    /// Pure parse/normalize/format rules for the persisted preview settings. Kept free of any VS dependency so
    /// the rules can be unit-tested; <see cref="PreviewOptions"/> owns the settings store and caching. Every
    /// parser tolerates null, garbage, and out-of-range input by falling back to a safe value.
    /// </summary>
    internal static class PreviewSettingsParser
    {
        public const double MinWidth = 240;
        public const double MaxWidth = 1400;
        public const double MinHeight = 160;
        public const double MaxHeight = 1000;
        public const double DefaultWidth = 480;
        public const double DefaultHeight = 340;
        public const double MaxCanvas = 8192;

        /// <summary>Clamps to [lo, hi]; NaN maps to <paramref name="lo"/> so it can never reach layout.</summary>
        public static double Clamp(double v, double lo, double hi) =>
            double.IsNaN(v) ? lo : (v < lo ? lo : (v > hi ? hi : v));

        /// <summary>Parses a persisted pane size; unparseable or NaN yields <paramref name="dflt"/>, otherwise clamped.</summary>
        public static double ParseSize(string? s, double dflt, double lo, double hi) =>
            TryParseDouble(s, out var v) ? Clamp(v, lo, hi) : dflt;

        /// <summary>Canvas override in DIP: 0 = auto; anything not positive (or NaN) is auto; capped at <see cref="MaxCanvas"/>.</summary>
        public static double NormalizeCanvas(double v) => v > 0 ? Math.Min(v, MaxCanvas) : 0;

        public static double ParseCanvas(string? s) => TryParseDouble(s, out var v) ? NormalizeCanvas(v) : 0;

        public static PreviewLocation ParseLocation(string? s) =>
            string.Equals(s, "Bottom", StringComparison.OrdinalIgnoreCase) ? PreviewLocation.Bottom : PreviewLocation.Right;

        public static string FormatLocation(PreviewLocation l) => l == PreviewLocation.Bottom ? "Bottom" : "Right";

        /// <summary>Light (default, historical) | Dark | Default (follow host). Case-sensitive, as persisted.</summary>
        public static string NormalizeTheme(string? s) => s == "Dark" || s == "Default" ? s : "Light";

        /// <summary>Default-off flag: only an explicit "1" is on.</summary>
        public static bool ParseFlag(string? s) => string.Equals(s, "1", StringComparison.Ordinal);

        /// <summary>Default-on flag: anything but an explicit "0" is on.</summary>
        public static bool ParseFlagDefaultOn(string? s) => !string.Equals(s, "0", StringComparison.Ordinal);

        public static string FormatFlag(bool b) => b ? "1" : "0";

        public static string FormatDouble(double v) => v.ToString(CultureInfo.InvariantCulture);

        private static bool TryParseDouble(string? s, out double v) =>
            double.TryParse(s, NumberStyles.Any, CultureInfo.InvariantCulture, out v) && !double.IsNaN(v);
    }
}
