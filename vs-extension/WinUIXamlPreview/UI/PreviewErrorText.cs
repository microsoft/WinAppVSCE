#nullable enable

using System.Text.RegularExpressions;

namespace WinUIXamlPreview.UI
{
    /// <summary>How the preview pane presents a surface <c>Error</c> reply.</summary>
    internal enum ErrorDisplay
    {
        /// <summary>Calm "Not a designable page" card (ResourceDictionary / Window / template placeholder root).</summary>
        NotDesignable,

        /// <summary>A render is on screen: keep it and show a compact error banner above it.</summary>
        BannerOverLastRender,

        /// <summary>Nothing rendered yet: the blocking status card shows the error.</summary>
        StatusCard,
    }

    /// <summary>User-facing text and presentation rules for preview errors. Pure, so it is unit-tested.</summary>
    internal static class PreviewErrorText
    {
        private const string WinUIPlaceholder = "The text associated with this error code could not be found.";

        public static ErrorDisplay Classify(bool notDesignable, bool hasRender) =>
            notDesignable ? ErrorDisplay.NotDesignable
            : hasRender ? ErrorDisplay.BannerOverLastRender
            : ErrorDisplay.StatusCard;

        public static string NotDesignableReason(string? message) =>
            string.IsNullOrWhiteSpace(message) ? "This file has no designable page root." : message!;

        /// <summary>
        /// "Line 3, col 5 — message", whitespace collapsed to one line, without WinUI's placeholder text or the
        /// parser's duplicate "[Line: n Position: m]" suffix. The log keeps the raw form.
        /// </summary>
        public static string FormatXamlError(string? message, int? line, int? column)
        {
            var msg = (message ?? "").Replace(WinUIPlaceholder, "");
            msg = Regex.Replace(msg, @"\s*\[Line:\s*\d+\s+Position:\s*\d+\]", "");
            msg = Regex.Replace(msg, @"\s+", " ").Trim();
            if (msg.Length == 0)
            {
                msg = "The XAML could not be loaded.";
            }

            return line.HasValue ? $"Line {line}, col {column} — {msg}" : msg;
        }

        /// <summary>Detail line for the "Preview disconnected" card.</summary>
        public static string DisconnectedDetail(string reason, bool restartsExhausted, int maxRestarts) =>
            restartsExhausted ? $"Auto-restart gave up after {maxRestarts} attempts. {reason}" : reason;
    }
}
