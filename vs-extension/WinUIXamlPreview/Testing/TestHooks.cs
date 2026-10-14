#nullable enable

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using WinUIXamlPreview.Editor;
using WinUIXamlPreview.UI;

namespace WinUIXamlPreview.Testing
{
    /// <summary>
    /// State probe for the in-VS integration tests. The test-only agent VSIX
    /// (vs-extension\WinUIXamlPreview.TestAgent) calls these by reflection, so nothing here is reachable from
    /// product UI and the shipped extension carries no test transport. Every member is UI-thread only and
    /// exchanges plain values so the agent needs no compile-time reference to this assembly.
    /// </summary>
    internal static class TestHooks
    {
        private static readonly List<WeakReference<XamlPreviewMargin>> Margins = new List<WeakReference<XamlPreviewMargin>>();

        internal static void RegisterMargin(XamlPreviewMargin margin)
        {
            lock (Margins)
            {
                Margins.Add(new WeakReference<XamlPreviewMargin>(margin));
            }
        }

        internal static void UnregisterMargin(XamlPreviewMargin margin)
        {
            lock (Margins)
            {
                Margins.RemoveAll(w => !w.TryGetTarget(out var m) || ReferenceEquals(m, margin));
            }
        }

        private static List<XamlPreviewMargin> LiveMargins()
        {
            lock (Margins)
            {
                var live = new List<XamlPreviewMargin>();
                foreach (var w in Margins)
                {
                    if (w.TryGetTarget(out var m))
                    {
                        live.Add(m);
                    }
                }
                return live;
            }
        }

        private static XamlPreviewMargin? FindMargin(string path) =>
            LiveMargins().FirstOrDefault(m => string.Equals(m.TestPath, path, StringComparison.OrdinalIgnoreCase));

        /// <summary>JSON: persisted options, every live margin, and every registered preview session.</summary>
        public static string Snapshot()
        {
            var sessions = PreviewPackageState.SessionsSnapshot()
                .OfType<PreviewControl>()
                .Select(p => p.TestSnapshot())
                .ToList();

            var result = new Dictionary<string, object?>
            {
                ["options"] = new Dictionary<string, object?>
                {
                    ["location"] = PreviewOptions.Location.ToString(),
                    ["rightWidth"] = PreviewOptions.RightWidth,
                    ["bottomHeight"] = PreviewOptions.BottomHeight,
                    ["designTimeData"] = PreviewOptions.DesignTimeData,
                    ["designMode"] = PreviewOptions.DesignMode,
                    ["collapsed"] = PreviewOptions.Collapsed,
                    ["theme"] = PreviewOptions.Theme,
                    ["canvasWidth"] = PreviewOptions.CanvasWidth,
                    ["canvasHeight"] = PreviewOptions.CanvasHeight,
                    ["fullFidelityAutoBuild"] = PreviewOptions.FullFidelityAutoBuild,
                },
                ["margins"] = LiveMargins().Select(m => m.TestSnapshot()).ToList(),
                ["sessions"] = sessions,
                ["logFile"] = Logging.Log.LogFilePath,
            };
            return JsonSerializer.Serialize(result);
        }

        /// <summary>The WPF root of the margin pinned to <paramref name="path"/>, or null.</summary>
        public static object? MarginRoot(string path) => FindMargin(path)?.TestRoot;

        public static bool SimulateDesignerSelection(string path, string elementPath)
        {
            var margin = FindMargin(path);
            if (margin == null)
            {
                return false;
            }

            margin.TestSimulateDesignerSelection(elementPath);
            return true;
        }

        /// <summary>Resets persisted options to the product defaults, with background full-fidelity builds off.</summary>
        public static void ResetOptions()
        {
            PreviewOptions.Location = PreviewLocation.Right;
            PreviewOptions.RightWidth = PreviewOptions.DefaultWidth;
            PreviewOptions.BottomHeight = PreviewOptions.DefaultHeight;
            PreviewOptions.DesignTimeData = true;
            PreviewOptions.DesignMode = true;
            PreviewOptions.Collapsed = false;
            PreviewOptions.Theme = "Light";
            PreviewOptions.CanvasWidth = 0;
            PreviewOptions.CanvasHeight = 0;
            PreviewOptions.FullFidelityAutoBuild = false;
        }
    }
}
