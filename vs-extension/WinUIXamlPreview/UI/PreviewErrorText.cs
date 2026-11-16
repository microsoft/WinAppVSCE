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

        /// <summary>
        /// BB-062: detail line for the "Preview disconnected" card, in plain words. The transport reason
        /// ("Surface socket read failed…") only goes to preview.log, where the surface's own error output is too.
        /// </summary>
        public static string DisconnectedDetail(bool restartsExhausted, int maxRestarts) =>
            restartsExhausted
                ? $"The preview stopped {maxRestarts} times in a row while rendering this file, so it was not restarted again. " +
                  "Something on the page (often a control or its code) is probably crashing it. Fix or remove it, then choose Reload preview. " +
                  "Details are in preview.log."
                : "The preview stopped unexpectedly. Choose Reload preview to start it again. Details are in preview.log.";

        /// <summary>BB-060/061: title of the card shown when the page's own code ended the preview.</summary>
        public const string AppFatalTitle = "The page's code stopped the preview";

        /// <summary>BB-060/061: why the page's code ended the preview, and what to do. Not auto-restarted.</summary>
        public static string AppFatalDetail(Protocol.AppFatalCause cause)
        {
            var what = cause switch
            {
                Protocol.AppFatalCause.LayoutCycle =>
                    "Its layout never settled: a control keeps changing its size on every layout pass (a layout cycle), " +
                    "for example a custom panel's MeasureOverride/ArrangeOverride or a SizeChanged handler that resizes it.",
                Protocol.AppFatalCause.LayoutCodeThrew =>
                    "A control's MeasureOverride or ArrangeOverride threw an exception, and WinUI closes the app when that happens.",
                Protocol.AppFatalCause.Unresponsive =>
                    "It stopped responding before it finished loading, probably a long-running loop in a constructor or Loaded handler.",
                _ => "It crashed while rendering.",
            };
            return what + " Restarting would hit the same problem, so the preview was not restarted. " +
                   "Fix the code, rebuild, then choose Reload preview. Details are in preview.log.";
        }
    }
}
