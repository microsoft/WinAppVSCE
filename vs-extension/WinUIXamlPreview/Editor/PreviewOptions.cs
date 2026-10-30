#nullable enable

using System;
using Microsoft.VisualStudio.Settings;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Settings;

namespace WinUIXamlPreview.Editor
{
    /// <summary>
    /// Tiny persisted settings for the in-editor preview margin — the dock location plus the last
    /// user-dragged size for each orientation — stored in the VS user settings store. Every access is
    /// defensive: any store failure falls back to the in-memory cache/defaults, so a settings hiccup can
    /// never throw into the editor. Values are cached after the first read.
    /// </summary>
    internal static class PreviewOptions
    {
        /// <summary>Raised after a preview setting shared by every preview (theme, size, sample data, select/interact) changes.</summary>
        public static event Action? PreviewSettingsChanged;

        private const string Collection = "WinUIXamlPreview";
        private const string LocationKey = "PreviewLocation";
        private const string RightWidthKey = "RightWidth";
        private const string BottomHeightKey = "BottomHeight";
        // "DesignTimeData" held the old default-on value, and Save() wrote it whenever any option changed, so it
        // can't tell a user's choice from the old default. The new key restarts everyone on the default-off setting.
        private const string DesignTimeDataKey = "SampleData";
        private const string DesignModeKey = "DesignMode";
        private const string CollapsedKey = "Collapsed";
        private const string ThemeKey = "PreviewTheme";
        private const string CanvasWidthKey = "CanvasWidth";
        private const string CanvasHeightKey = "CanvasHeight";
        private const string FullFidelityAutoBuildKey = "FullFidelityAutoBuild";

        public const double MinWidth = PreviewSettingsParser.MinWidth;
        public const double MaxWidth = PreviewSettingsParser.MaxWidth;
        public const double MinHeight = PreviewSettingsParser.MinHeight;
        public const double MaxHeight = PreviewSettingsParser.MaxHeight;
        public const double DefaultWidth = PreviewSettingsParser.DefaultWidth;
        public const double DefaultHeight = PreviewSettingsParser.DefaultHeight;

        private static readonly object Gate = new object();

        // In-memory cache — also the fallback when the settings store is unavailable.
        private static PreviewLocation _location = PreviewLocation.Right;
        private static double _rightWidth = DefaultWidth;
        private static double _bottomHeight = DefaultHeight;
        private static bool _designTimeData; // default OFF — placeholder sample data for {x:Bind} pages (WS2-F6) is opt-in
        private static bool _designMode = true; // default ON — the previewer selects, it doesn't interact (plan §41)
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
        /// The "Sample data" toggle (default off; it adds a one-time project type-model build and memory). When on, <c>{x:Bind}</c> text properties render a placeholder
        /// (the binding's FallbackValue/TargetNullValue, else <c>{PathName}</c>) and bound lists show a few
        /// dummy rows (WS2-F6). When off, <c>{x:Bind}</c> attributes are simply dropped. The M1
        /// (<c>d:DesignData</c>) and M2 (DesignMode signal) sample-data paths are automatic and need no flag.
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
                PreviewSettingsChanged?.Invoke();
            }
        }

        /// <summary>
        /// When true (default), the preview is a <b>preview surface</b>: clicking an element selects it (drawing
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
                PreviewSettingsChanged?.Invoke();
            }
        }

        /// <summary>
        /// When true, the in-editor preview margin is collapsed to a thin strip along its docked edge,
        /// reclaiming the editor space; a single click on the strip restores it. Persisted so the choice
        /// sticks across tabs and sessions. The strip stays visible so the previewer is always one click away.
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
        /// the preview canvas; only the page sheet re-themes (the neutral artboard chrome stays constant).
        /// </summary>
        public static string Theme
        {
            get { EnsureLoaded(); return _theme; }
            set
            {
                EnsureLoaded();
                var v = PreviewSettingsParser.NormalizeTheme(value);
                if (_theme == v)
                {
                    return;
                }

                _theme = v;
                Save();
                PreviewSettingsChanged?.Invoke();
            }
        }

        /// <summary>Preview-canvas width override in DIP (0 = auto — the page's own size / default canvas).</summary>
        public static double CanvasWidth
        {
            get { EnsureLoaded(); return _canvasWidth; }
            set
            {
                EnsureLoaded();
                var v = PreviewSettingsParser.NormalizeCanvas(value);
                if (_canvasWidth == v)
                {
                    return;
                }

                _canvasWidth = v;
                Save();
                PreviewSettingsChanged?.Invoke();
            }
        }

        /// <summary>Preview-canvas height override in DIP (0 = auto — the page's own size / default canvas).</summary>
        public static double CanvasHeight
        {
            get { EnsureLoaded(); return _canvasHeight; }
            set
            {
                EnsureLoaded();
                var v = PreviewSettingsParser.NormalizeCanvas(value);
                if (_canvasHeight == v)
                {
                    return;
                }

                _canvasHeight = v;
                Save();
                PreviewSettingsChanged?.Invoke();
            }
        }

        /// <summary>
        /// When true (default), on a preview whose project targets a Windows App SDK version other than the
        /// bundled 2.2.0 host, the extension automatically builds a version-matched self-contained host in the
        /// background (once per version) and hot-swaps to it for full fidelity (version-new controls upgrade
        /// from placeholder to real). Opt-out: when false, the preview stays on the instant bundled host. The
        /// build is always non-blocking and cancelable. Toggled from the preview toolbar ("Full fidelity").
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
                PreviewSettingsChanged?.Invoke();
            }
        }

        internal static double Clamp(double v, double lo, double hi) => PreviewSettingsParser.Clamp(v, lo, hi);

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
                        _location = PreviewSettingsParser.ParseLocation(store.GetString(Collection, LocationKey));
                    }

                    if (store.PropertyExists(Collection, RightWidthKey))
                    {
                        _rightWidth = PreviewSettingsParser.ParseSize(store.GetString(Collection, RightWidthKey), DefaultWidth, MinWidth, MaxWidth);
                    }

                    if (store.PropertyExists(Collection, BottomHeightKey))
                    {
                        _bottomHeight = PreviewSettingsParser.ParseSize(store.GetString(Collection, BottomHeightKey), DefaultHeight, MinHeight, MaxHeight);
                    }

                    if (store.PropertyExists(Collection, DesignTimeDataKey))
                    {
                        _designTimeData = PreviewSettingsParser.ParseFlag(store.GetString(Collection, DesignTimeDataKey));
                    }

                    if (store.PropertyExists(Collection, DesignModeKey))
                    {
                        _designMode = PreviewSettingsParser.ParseFlag(store.GetString(Collection, DesignModeKey));
                    }

                    if (store.PropertyExists(Collection, CollapsedKey))
                    {
                        _collapsed = PreviewSettingsParser.ParseFlag(store.GetString(Collection, CollapsedKey));
                    }

                    if (store.PropertyExists(Collection, ThemeKey))
                    {
                        _theme = PreviewSettingsParser.NormalizeTheme(store.GetString(Collection, ThemeKey));
                    }

                    if (store.PropertyExists(Collection, CanvasWidthKey))
                    {
                        _canvasWidth = PreviewSettingsParser.ParseCanvas(store.GetString(Collection, CanvasWidthKey));
                    }

                    if (store.PropertyExists(Collection, CanvasHeightKey))
                    {
                        _canvasHeight = PreviewSettingsParser.ParseCanvas(store.GetString(Collection, CanvasHeightKey));
                    }

                    if (store.PropertyExists(Collection, FullFidelityAutoBuildKey))
                    {
                        // default ON: anything but an explicit "0" is treated as enabled.
                        _fullFidelityAutoBuild = PreviewSettingsParser.ParseFlagDefaultOn(store.GetString(Collection, FullFidelityAutoBuildKey));
                    }
                }
                catch
                {
                    // keep in-memory defaults
                }
            }
        }

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

                store.SetString(Collection, LocationKey, PreviewSettingsParser.FormatLocation(_location));
                store.SetString(Collection, RightWidthKey, PreviewSettingsParser.FormatDouble(_rightWidth));
                store.SetString(Collection, BottomHeightKey, PreviewSettingsParser.FormatDouble(_bottomHeight));
                store.SetString(Collection, DesignTimeDataKey, PreviewSettingsParser.FormatFlag(_designTimeData));
                store.SetString(Collection, DesignModeKey, PreviewSettingsParser.FormatFlag(_designMode));
                store.SetString(Collection, CollapsedKey, PreviewSettingsParser.FormatFlag(_collapsed));
                store.SetString(Collection, ThemeKey, _theme);
                store.SetString(Collection, CanvasWidthKey, PreviewSettingsParser.FormatDouble(_canvasWidth));
                store.SetString(Collection, CanvasHeightKey, PreviewSettingsParser.FormatDouble(_canvasHeight));
                store.SetString(Collection, FullFidelityAutoBuildKey, PreviewSettingsParser.FormatFlag(_fullFidelityAutoBuild));
            }
            catch
            {
                // persistence is best-effort; the in-memory cache still holds for this session
            }
        }
    }
}
