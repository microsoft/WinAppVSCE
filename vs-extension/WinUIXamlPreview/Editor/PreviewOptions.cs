#nullable enable

using System;
using System.Globalization;
using Microsoft.VisualStudio.Settings;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Settings;

namespace WinUIXamlPreview.Editor
{
    /// <summary>Where the in-editor preview margin docks relative to the XAML text.</summary>
    internal enum PreviewLocation
    {
        Right,
        Bottom,
    }

    /// <summary>
    /// Tiny persisted settings for the in-editor preview margin — the dock location plus the last
    /// user-dragged size for each orientation — stored in the VS user settings store. Every access is
    /// defensive: any store failure falls back to the in-memory cache/defaults, so a settings hiccup can
    /// never throw into the editor. Values are cached after the first read.
    /// </summary>
    internal static class PreviewOptions
    {
        private const string Collection = "WinUIXamlPreview";
        private const string LocationKey = "PreviewLocation";
        private const string RightWidthKey = "RightWidth";
        private const string BottomHeightKey = "BottomHeight";
        private const string LiveModeKey = "LiveMode";
        private const string DesignTimeDataKey = "DesignTimeData";
        private const string DesignModeKey = "DesignMode";
        private const string CollapsedKey = "Collapsed";
        private const string ThemeKey = "PreviewTheme";
        private const string CanvasWidthKey = "CanvasWidth";
        private const string CanvasHeightKey = "CanvasHeight";
        private const string FullFidelityAutoBuildKey = "FullFidelityAutoBuild";

        public const double MinWidth = 240;
        public const double MaxWidth = 1400;
        public const double MinHeight = 160;
        public const double MaxHeight = 1000;
        public const double DefaultWidth = 480;
        public const double DefaultHeight = 340;

        private static readonly object Gate = new object();

        // In-memory cache — also the fallback when the settings store is unavailable.
        private static PreviewLocation _location = PreviewLocation.Right;
        private static double _rightWidth = DefaultWidth;
        private static double _bottomHeight = DefaultHeight;
        private static bool _liveMode; // default OFF — parse mode is the robust, no-crash floor (plan §39)
        private static bool _designTimeData; // default OFF — §51 M3 reflection sample-data accelerator, opt-in
        private static bool _designMode = true; // default ON — the designer selects, it doesn't interact (plan §41)
        private static bool _collapsed; // default expanded — the preview shows when a WinUI xaml opens
        private static string _theme = "Light"; // preview theme: Light (default, historical) | Dark | Default
        private static double _canvasWidth;  // 0 = auto (page's own size / default canvas)
        private static double _canvasHeight; // 0 = auto
        private static bool _fullFidelityAutoBuild = true; // default ON — auto-build a version-matched host on cache-miss
        private static bool _loaded;

        public static PreviewLocation Location
        {
            get { EnsureLoaded(); return _location; }
            set
            {
                EnsureLoaded();
                if (_location == value)
                {
                    return;
                }

                _location = value;
                Save();
            }
        }

        public static double RightWidth
        {
            get { EnsureLoaded(); return _rightWidth; }
            set
            {
                EnsureLoaded();
                value = Clamp(value, MinWidth, MaxWidth);
                if (Math.Abs(_rightWidth - value) < 0.5)
                {
                    return;
                }

                _rightWidth = value;
                Save();
            }
        }

        public static double BottomHeight
        {
            get { EnsureLoaded(); return _bottomHeight; }
            set
            {
                EnsureLoaded();
                value = Clamp(value, MinHeight, MaxHeight);
                if (Math.Abs(_bottomHeight - value) < 0.5)
                {
                    return;
                }

                _bottomHeight = value;
                Save();
            }
        }

        /// <summary>
        /// When true, the surface instantiates the real compiled page type (running the genuine
        /// <c>InitializeComponent</c>/<c>Connect</c>) so <c>{x:Bind}</c> and code-behind-populated state render
        /// with full fidelity (plan §39). Opt-in: default OFF, because the default parse path never runs user
        /// code and never crashes. The preview auto-falls back to parse mode per-document when a page can't be
        /// activated live, so turning this on can only add fidelity, never leave a dead preview.
        /// </summary>
        public static bool LiveMode
        {
            get { EnsureLoaded(); return _liveMode; }
            set
            {
                EnsureLoaded();
                if (_liveMode == value)
                {
                    return;
                }

                _liveMode = value;
                Save();
            }
        }

        /// <summary>
        /// When true, the surface's opportunistic reflection fallback (§51 M3) fills empty <c>{x:Bind}</c>-backed
        /// collections with reflected sample data so otherwise-blank live pages show representative content. Sets
        /// <c>SURFACE_DTD_REFLECT</c>. Opt-in, default OFF; only has an effect together with <see cref="LiveMode"/>
        /// (it runs after real-type activation). The M1 (<c>d:DesignData</c>) and M2 (DesignMode contract) sample-
        /// data paths are automatic host behavior and need no flag — this toggle only arms the M3 accelerator.
        /// </summary>
        public static bool DesignTimeData
        {
            get { EnsureLoaded(); return _designTimeData; }
            set
            {
                EnsureLoaded();
                if (_designTimeData == value)
                {
                    return;
                }

                _designTimeData = value;
                Save();
            }
        }

        /// <summary>
        /// When true (default), the preview is a <b>design surface</b>: clicking an element selects it (drawing
        /// a selection adorner and populating the property panel) instead of interacting with the live app —
        /// the WPF/Blend designer behavior (plan §41). When false, the preview is fully interactive (clicks
        /// reach the running content). A runtime toggle; the surface applies it live with no re-render.
        /// </summary>
        public static bool DesignMode
        {
            get { EnsureLoaded(); return _designMode; }
            set
            {
                EnsureLoaded();
                if (_designMode == value)
                {
                    return;
                }

                _designMode = value;
                Save();
            }
        }

        /// <summary>
        /// When true, the in-editor preview margin is collapsed to a thin strip along its docked edge,
        /// reclaiming the editor space; a single click on the strip restores it. Persisted so the choice
        /// sticks across tabs and sessions. The strip stays visible so the designer is always one click away.
        /// </summary>
        public static bool Collapsed
        {
            get { EnsureLoaded(); return _collapsed; }
            set
            {
                EnsureLoaded();
                if (_collapsed == value)
                {
                    return;
                }

                _collapsed = value;
                Save();
            }
        }

        /// <summary>
        /// The theme the mounted page is previewed under: <c>Light</c> (default, the historical hard-coded
        /// theme), <c>Dark</c>, or <c>Default</c> (follow the host/OS theme). The surface applies it live to
        /// the design canvas; only the page sheet re-themes (the neutral artboard chrome stays constant).
        /// </summary>
        public static string Theme
        {
            get { EnsureLoaded(); return _theme; }
            set
            {
                EnsureLoaded();
                var v = value == "Dark" || value == "Default" ? value : "Light";
                if (_theme == v)
                {
                    return;
                }

                _theme = v;
                Save();
            }
        }

        /// <summary>Design-canvas width override in DIP (0 = auto — the page's own size / default canvas).</summary>
        public static double CanvasWidth
        {
            get { EnsureLoaded(); return _canvasWidth; }
            set
            {
                EnsureLoaded();
                var v = value > 0 ? value : 0;
                if (_canvasWidth == v)
                {
                    return;
                }

                _canvasWidth = v;
                Save();
            }
        }

        /// <summary>Design-canvas height override in DIP (0 = auto — the page's own size / default canvas).</summary>
        public static double CanvasHeight
        {
            get { EnsureLoaded(); return _canvasHeight; }
            set
            {
                EnsureLoaded();
                var v = value > 0 ? value : 0;
                if (_canvasHeight == v)
                {
                    return;
                }

                _canvasHeight = v;
                Save();
            }
        }

        /// <summary>
        /// When true (default), on a preview whose project targets a Windows App SDK version other than the
        /// bundled 2.2.0 host, the extension automatically builds a version-matched self-contained host in the
        /// background (once per version) and hot-swaps to it for full fidelity (version-new controls upgrade
        /// from placeholder to real). Opt-out: when false, the preview stays on the instant bundled host. The
        /// build is always non-blocking and cancelable — this toggle only governs whether it is auto-started.
        /// </summary>
        public static bool FullFidelityAutoBuild
        {
            get { EnsureLoaded(); return _fullFidelityAutoBuild; }
            set
            {
                EnsureLoaded();
                if (_fullFidelityAutoBuild == value)
                {
                    return;
                }

                _fullFidelityAutoBuild = value;
                Save();
            }
        }

        internal static double Clamp(double v, double lo, double hi) => v < lo ? lo : (v > hi ? hi : v);

        private static WritableSettingsStore? Store()
        {
            try
            {
                ThreadHelper.ThrowIfNotOnUIThread();
                var manager = new ShellSettingsManager(ServiceProvider.GlobalProvider);
                return manager.GetWritableSettingsStore(SettingsScope.UserSettings);
            }
            catch
            {
                return null;
            }
        }

        private static void EnsureLoaded()
        {
            lock (Gate)
            {
                if (_loaded)
                {
                    return;
                }

                _loaded = true;
                try
                {
                    var store = Store();
                    if (store == null || !store.CollectionExists(Collection))
                    {
                        return;
                    }

                    if (store.PropertyExists(Collection, LocationKey))
                    {
                        _location = string.Equals(store.GetString(Collection, LocationKey), "Bottom", StringComparison.OrdinalIgnoreCase)
                            ? PreviewLocation.Bottom
                            : PreviewLocation.Right;
                    }

                    if (store.PropertyExists(Collection, RightWidthKey))
                    {
                        _rightWidth = Clamp(ParseD(store.GetString(Collection, RightWidthKey), DefaultWidth), MinWidth, MaxWidth);
                    }

                    if (store.PropertyExists(Collection, BottomHeightKey))
                    {
                        _bottomHeight = Clamp(ParseD(store.GetString(Collection, BottomHeightKey), DefaultHeight), MinHeight, MaxHeight);
                    }

                    if (store.PropertyExists(Collection, LiveModeKey))
                    {
                        _liveMode = string.Equals(store.GetString(Collection, LiveModeKey), "1", StringComparison.Ordinal);
                    }

                    if (store.PropertyExists(Collection, DesignTimeDataKey))
                    {
                        _designTimeData = string.Equals(store.GetString(Collection, DesignTimeDataKey), "1", StringComparison.Ordinal);
                    }

                    if (store.PropertyExists(Collection, DesignModeKey))
                    {
                        _designMode = string.Equals(store.GetString(Collection, DesignModeKey), "1", StringComparison.Ordinal);
                    }

                    if (store.PropertyExists(Collection, CollapsedKey))
                    {
                        _collapsed = string.Equals(store.GetString(Collection, CollapsedKey), "1", StringComparison.Ordinal);
                    }

                    if (store.PropertyExists(Collection, ThemeKey))
                    {
                        var t = store.GetString(Collection, ThemeKey);
                        _theme = (t == "Dark" || t == "Default") ? t : "Light";
                    }

                    if (store.PropertyExists(Collection, CanvasWidthKey))
                    {
                        _canvasWidth = Clamp(ParseD(store.GetString(Collection, CanvasWidthKey), 0), 0, 8192);
                    }

                    if (store.PropertyExists(Collection, CanvasHeightKey))
                    {
                        _canvasHeight = Clamp(ParseD(store.GetString(Collection, CanvasHeightKey), 0), 0, 8192);
                    }

                    if (store.PropertyExists(Collection, FullFidelityAutoBuildKey))
                    {
                        // default ON: anything but an explicit "0" is treated as enabled.
                        _fullFidelityAutoBuild = !string.Equals(store.GetString(Collection, FullFidelityAutoBuildKey), "0", StringComparison.Ordinal);
                    }
                }
                catch
                {
                    // keep in-memory defaults
                }
            }
        }

        private static double ParseD(string s, double dflt) =>
            double.TryParse(s, NumberStyles.Any, CultureInfo.InvariantCulture, out var v) ? v : dflt;

        private static void Save()
        {
            try
            {
                var store = Store();
                if (store == null)
                {
                    return;
                }

                if (!store.CollectionExists(Collection))
                {
                    store.CreateCollection(Collection);
                }

                store.SetString(Collection, LocationKey, _location == PreviewLocation.Bottom ? "Bottom" : "Right");
                store.SetString(Collection, RightWidthKey, _rightWidth.ToString(CultureInfo.InvariantCulture));
                store.SetString(Collection, BottomHeightKey, _bottomHeight.ToString(CultureInfo.InvariantCulture));
                store.SetString(Collection, LiveModeKey, _liveMode ? "1" : "0");
                store.SetString(Collection, DesignTimeDataKey, _designTimeData ? "1" : "0");
                store.SetString(Collection, DesignModeKey, _designMode ? "1" : "0");
                store.SetString(Collection, CollapsedKey, _collapsed ? "1" : "0");
                store.SetString(Collection, ThemeKey, _theme);
                store.SetString(Collection, CanvasWidthKey, _canvasWidth.ToString(CultureInfo.InvariantCulture));
                store.SetString(Collection, CanvasHeightKey, _canvasHeight.ToString(CultureInfo.InvariantCulture));
                store.SetString(Collection, FullFidelityAutoBuildKey, _fullFidelityAutoBuild ? "1" : "0");
            }
            catch
            {
                // persistence is best-effort; the in-memory cache still holds for this session
            }
        }
    }
}
