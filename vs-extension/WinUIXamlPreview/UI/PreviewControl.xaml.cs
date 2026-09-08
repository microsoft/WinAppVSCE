#nullable enable

using System;
using System.Collections.Generic;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using EnvDTE;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using WinUIXamlPreview.Editor;
using WinUIXamlPreview.Logging;
using WinUIXamlPreview.Protocol;

namespace WinUIXamlPreview.UI
{
    /// <summary>
    /// The WPF surface hosted inside the tool window. Owns a <see cref="SurfaceClient"/>, follows
    /// the active <c>.xaml</c> document, streams PNG frames from the surface, and paints them into
    /// an <see cref="Image"/> at the design's logical (DIP) size for crisp output. VS's UI thread is
    /// the WPF dispatcher thread; surface events arrive on socket threads and are marshaled back.
    /// </summary>
    public partial class PreviewControl : UserControl, IDisposable
    {
        private readonly DispatcherTimer _resizeDebounce;
        private SurfaceClient? _client;
        private EditorTracker? _tracker;
        private string? _currentPath;
        private bool _hasFrame;
        private bool _disposed;
        private double _lastScale = 1.5;

        // When set, this control previews ONE fixed document (an in-editor margin pins itself to its
        // own .xaml tab) instead of following the globally-active document. Active-document changes are
        // ignored while pinned; saves of the pinned document still refresh it.
        private string? _pinnedPath;

        // Native-HWND ("real designer") path: reparent the live surface window instead of streaming
        // a PNG. Preferred when the surface advertises the native-hwnd capability; image is fallback.
        private const bool PreferNative = true;
        private SurfaceHwndHost? _nativeHost;
        private bool _nativeSupported;
        private bool _hasNative;

        // Self-healing: a render can fail-fast the surface process on certain content (re-realizing a
        // complex compiled control tree — see plan §36). When the surface dies unexpectedly we auto-
        // restart and re-render the current document; the first render in a fresh process succeeds, so
        // the crash becomes a brief reload instead of a dead preview. Bounded so a document that dies on
        // its very first render (or a broken surface exe) can't loop forever; the counter resets on any
        // successful render, so ordinary edit-triggered crashes recover indefinitely.
        private int _restartAttempts;
        private const int MaxAutoRestarts = 3;

        // Set while we intentionally tear down a client (dispose / document switch) so a racing Closed
        // event from that client cannot trigger an auto-restart.
        private bool _suppressAutoRestart;

        // Process recycling (plan §36): a pre-warmed idle spare surface lets us render a "risky" document
        // (one that fail-fasts on its 2nd render in a warm process) in a fresh, unarmed process without a
        // visible cold-restart blip. A document is learned to be risky the first time it crashes the
        // surface, then recycled proactively on every subsequent edit.
        private SurfaceClient? _spareClient;
        private bool _spareReady;
        private bool _spareWarming;
        private int _spareGeneration;
        private SurfaceClient? _retiringClient;
        private readonly System.Collections.Generic.HashSet<string> _riskyDocs =
            new System.Collections.Generic.HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private string? _activeSurfaceExe;
        private string? _activeUserDll;
        private string? _activeUserAppXaml;
        private string? _activeTheme;
        // The design-time (merged core+toolkit) pri staged for a version-MATCHED host via --user-pri. Null on
        // the bundled 2.2.0 leg (which launches byte-clean, no --user-pri). Kept in sync with _activeSurfaceExe
        // so a crash-recycle spare of a matched host also stages the pri and preserves toolkit chrome.
        private string? _activeUserPri;

        // ---- version-matched fidelity upgrade (nov-vsix-wire) --------------
        // The instant launch is ALWAYS the bundled 2.2.0 host. When the target project references a different
        // WASDK version, a version-matched self-contained host is produced in the BACKGROUND (a run-copy of a
        // verified cached host, or a provisioner --build) and hot-swapped in, so version-new controls (e.g.
        // GridSplitter) upgrade from placeholder to real. Kept deliberately separate from the crash-recycle
        // spare so neither path regresses the other. Every doc-switch/dispose bumps _upgradeGeneration to
        // cancel any in-flight upgrade before it can promote into a document that has moved on.
        private int _upgradeGeneration;
        private bool _upgradeInProgress;
        private bool _fullFidelityCancelled;   // user cancelled the upgrade for the current document
        private MatchedHostBuild? _upgradeBuild; // shared per-version build we hold interest in (release on cancel/dispose/promote)
        private string? _upgradeRunRoot;        // transient per-session run-copy dir of the matched host (deleted on teardown)
        private DispatcherTimer? _fidelityHideTimer;
        // Versions whose background build already FAILED this VS session — don't auto-retry (no retry loop).
        private static readonly System.Collections.Generic.HashSet<string> FailedVersions =
            new System.Collections.Generic.HashSet<string>(StringComparer.OrdinalIgnoreCase);

        // Live mode (plan §39): opt-in real-type activation for {x:Bind}/code-behind fidelity. It rides the
        // same process-isolation infra as the crash recycler. Two rules keep it safe:
        //  1. Per-render isolation — in live mode every re-render lands on a FRESH (never-rendered) spare, so
        //     one render's leftover animations/timers/backdrops can't fail-fast the next (the cross-
        //     contamination measured across the Gallery: 22% of pages crashed in a shared warm process, only
        //     ~3% in isolation).
        //  2. Auto-fallback — a document that crashes a FRESH live process before producing any frame is an
        //     inherent crasher (composition backdrop / animated-visual / App-window coupling). It is demoted
        //     to the robust parse path for the session, so the preview degrades to a static render instead of
        //     a dead pane. Toggling live mode re-arms all demotions.
        private readonly System.Collections.Generic.HashSet<string> _liveFallbackDocs =
            new System.Collections.Generic.HashSet<string>(StringComparer.OrdinalIgnoreCase);

        // Whether the CURRENT active surface process has produced at least one frame/native host. Distinguishes
        // an inherent first-render crash in a fresh process (=> demote to parse) from a 2nd-render fail-fast in
        // a warm process that already rendered (=> recycle to a fresh process). Reset whenever a new active
        // surface is wired; set on the first successful render.
        private bool _activeProcessRendered;

        public PreviewControl()
        {
            InitializeComponent();

            _resizeDebounce = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(180) };
            _resizeDebounce.Tick += OnResizeDebounceTick;

            Loaded += OnLoaded;
            Unloaded += OnUnloaded;
            SizeChanged += (_, __) => { _resizeDebounce.Stop(); _resizeDebounce.Start(); };
        }

        private void OnLoaded(object sender, RoutedEventArgs e)
        {
            _tracker = PreviewPackageState.EditorTracker;
            if (_tracker != null)
            {
                _tracker.ActiveDocumentChanged += OnActiveDocumentChanged;
                _tracker.ActiveDocumentSaved += OnActiveDocumentSaved;
            }

            ShowDocument(_pinnedPath ?? PreviewPackageState.GetActiveXamlPath());
        }

        /// <summary>
        /// Pin this preview to a single document (used by the in-editor margin, which belongs to one
        /// .xaml tab). After pinning, the control ignores active-document changes and always previews
        /// <paramref name="path"/>. Safe to call before or after the control is loaded.
        /// </summary>
        public void PinToDocument(string path)
        {
            _pinnedPath = path;
            if (IsLoaded)
            {
                ShowDocument(path);
            }
        }

        private void OnUnloaded(object sender, RoutedEventArgs e)
        {
            if (_tracker != null)
            {
                _tracker.ActiveDocumentChanged -= OnActiveDocumentChanged;
                _tracker.ActiveDocumentSaved -= OnActiveDocumentSaved;
            }

            DisposeClient();
        }

        private void OnActiveDocumentChanged(object? sender, string? path)
        {
            if (_pinnedPath != null)
            {
                return; // pinned to one document (in-editor margin) — don't follow the active tab
            }

            ShowDocument(path);
        }

        private void OnActiveDocumentSaved(object? sender, string? path)
        {
            if (IsCurrent(path))
            {
                ReloadCurrent();
            }
        }

        // ---- preview lifecycle ---------------------------------------------

        private void ShowDocument(string? path)
        {
            if (_disposed)
            {
                return;
            }

            Log.Write($"ShowDocument: path='{path ?? "(null)"}'");

            if (string.IsNullOrEmpty(path) || !path!.EndsWith(".xaml", StringComparison.OrdinalIgnoreCase))
            {
                DisposeClient();
                _currentPath = null;
                _hasFrame = false;
                FrameImage.Source = null;
                SetStatus("Open a .xaml file to preview it.", spinner: false);
                return;
            }

            if (IsCurrent(path) && _client != null)
            {
                return;
            }

            _currentPath = path;
            _hasFrame = false;
            FrameImage.Source = null;
            SetStatus("Starting preview…", spinner: true, detail: Path.GetFileName(path));

            _ = StartPreviewAsync(path).ContinueWith(
                t => Log.Write("StartPreviewAsync faulted: " + t.Exception),
                System.Threading.CancellationToken.None,
                System.Threading.Tasks.TaskContinuationOptions.OnlyOnFaulted,
                System.Threading.Tasks.TaskScheduler.Default);
        }

        private async System.Threading.Tasks.Task StartPreviewAsync(string path)
        {
            DisposeClient();

            string xaml;
            string? userDll;
            string? userAppXaml;
            string? surfaceExe;
            HostSelection? plan;

            try
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                xaml = ReadDocumentText(path);
                userDll = ProjectDllLocator.FindUserDll(path, Log.Write);
                userAppXaml = ProjectDllLocator.FindAppXaml(path, Log.Write);
                // Resolve the host PLAN: which host to launch now (always the bundled 2.2.0 host for the instant
                // preview) and whether/how to upgrade to a version-matched host in the background.
                plan = MatchedHostResolver.Resolve(path, Log.Write);
                surfaceExe = plan.ExePath;
            }
            catch (Exception ex)
            {
                SetStatus("Failed to read document.", spinner: false, detail: ex.Message);
                return;
            }

            if (surfaceExe == null)
            {
                SetStatus(
                    "Surface.exe not found.",
                    spinner: false,
                    detail: "Set the WINUI_SURFACE_EXE environment variable to the built Surface.exe, then reopen the preview.");
                return;
            }

            _activeSurfaceExe = surfaceExe;
            _activeUserDll = userDll;
            _activeUserAppXaml = userAppXaml;
            _activeTheme = PreviewOptions.Theme;
            // The instant launch is the bundled 2.2.0 host — always byte-clean (no --user-pri). A version-
            // matched host (with its merged pri) is swapped in later by the background upgrade, which updates
            // _activeUserPri at promote time.
            _activeUserPri = null;
            _fullFidelityCancelled = false;

            // Packaged (MSIX) user builds require the surface to run with package identity (plan §38). When the
            // chosen assembly is a packaged build and this surface ships the sparse-identity payload, register
            // the sparse package (external location = the surface folder) before launching. Off the UI thread
            // (spawns PowerShell); non-fatal on failure — we still launch and render framework types.
            if (userDll != null && ProjectDllLocator.IsPackagedBuild(userDll) && SurfaceIdentity.HasIdentityPayload(surfaceExe))
            {
                SetStatus("Preparing packaged preview…", spinner: true, detail: Path.GetFileName(path));
                var exeForReg = surfaceExe;
                var registered = await System.Threading.Tasks.Task.Run(() => SurfaceIdentity.EnsureRegistered(exeForReg, Log.Write));
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                if (_disposed)
                {
                    return;
                }

                Log.Write(registered
                    ? "Packaged preview: surface identity is active."
                    : "Packaged preview: surface identity NOT active; custom controls from this packaged build may not resolve.");
            }

            Log.Write($"Constructing surface client (surfaceExe='{surfaceExe}', userDll='{userDll ?? "(none)"}', appXaml='{userAppXaml ?? "(none)"}', xaml={xaml.Length} chars)…");
            var live = EffectiveLiveMode(path);
            Log.Write($"Live mode for '{Path.GetFileName(path)}': {(live ? "ON — real-type activation" : "off — parse path")}.");
            // §51 M3 reflection accelerator only runs after real-type activation, so it is armed only when this
            // document is actually going live (keeps the parse/default path byte-clean — no SURFACE_DTD_REFLECT).
            var reflect = live && PreviewOptions.DesignTimeData;
            var client = new SurfaceClient(surfaceExe, userDll, Log.Write, userAppXaml, live, PreviewOptions.Theme, reflectionFallback: reflect);
            client.Frame += OnFrame;
            client.Error += OnError;
            client.Hwnd += OnHwnd;
            client.NativeExited += OnNativeExited;
            client.Selected += OnSelected;
            client.ElementProps += OnElementProps;
            client.ContentProps += OnContentProps;
            client.Closed += OnClosed;
            _client = client;
            _activeProcessRendered = false; // a fresh process; it hasn't rendered yet
            // A fresh client is wired up; allow its (unexpected) death to trigger an auto-restart.
            _suppressAutoRestart = false;

            try
            {
                Log.Write($"Starting surface client (userDll='{userDll ?? "(none)"}')…");
                var ready = await client.StartAsync(TimeSpan.FromSeconds(25));
                if (_disposed || !ReferenceEquals(_client, client))
                {
                    return;
                }

                _nativeSupported = ready.Caps != null && ready.Caps.Contains("native-hwnd");
                var (w, h, scale) = await GetViewportAsync();

                // Push the design/interact mode BEFORE the first render: the surface reads it when it builds
                // the design surface artboard in HostLiveAsync, and the single ordered TCP stream guarantees
                // SetMode is processed before EnterNative/LoadXaml (plan §41).
                client.SetMode(PreviewOptions.DesignMode);

                if (PreferNative && _nativeSupported)
                {
                    // Real-designer path: host the live surface window in the tool window (no image).
                    Log.Write("Surface supports native-hwnd; entering native reparent mode.");
                    SetStatus("Hosting native surface…", spinner: true, detail: Path.GetFileName(path));
                    client.EnterNative(xaml, 0, 0, 1.0);
                }
                else
                {
                    Log.Write($"Using image mode; sending LoadXaml ({w}x{h} @ {scale}x, {xaml.Length} chars)…");
                    client.LoadXaml(xaml, w, h, scale);
                }

                // Instant bundled preview is now on its way. If this project needs a version-matched host, kick
                // the background upgrade (run-copy a cached host, or provisioner --build) → hot-swap when ready.
                KickFidelityUpgrade(plan);
            }
            catch (Exception ex)
            {
                Log.Write("StartPreviewAsync failed: " + ex);
                if (ReferenceEquals(_client, client))
                {
                    SetStatus("Could not start the surface.", spinner: false, detail: ex.Message);
                }
            }
        }

        /// <summary>
        /// Toolbar reload: re-render the pinned/current document. Pushes an UpdateXaml when a surface is
        /// live (in place, no flicker); otherwise restarts the preview from scratch (e.g. after the surface
        /// died). Safe to call from the UI thread.
        /// </summary>
        public void Reload()
        {
            if (_disposed)
            {
                return;
            }

            var path = _pinnedPath ?? _currentPath;
            if (string.IsNullOrEmpty(path))
            {
                path = PreviewPackageState.GetActiveXamlPath();
            }

            if (string.IsNullOrEmpty(path))
            {
                return;
            }

            if (_client != null && IsCurrent(path))
            {
                ReloadCurrent();
            }
            else
            {
                _currentPath = null; // force a fresh start; the surface may have exited
                ShowDocument(path);
            }
        }

        /// <summary>
        /// Apply a live-mode toggle at runtime. Persists the new preference, re-arms any per-document parse
        /// fallbacks (so the user can retry live on a page that previously couldn't activate), and restarts the
        /// current preview so the surface relaunches with the new <c>SURFACE_LIVE_MODE</c> env. UI thread only.
        /// </summary>
        public void SetLiveMode(bool on)
        {
            if (_disposed)
            {
                return;
            }

            PreviewOptions.LiveMode = on;
            _liveFallbackDocs.Clear();
            Log.Write($"Live mode toggled {(on ? "ON (real-type activation)" : "off (parse)")} — restarting preview.");

            var path = _pinnedPath ?? _currentPath;
            if (string.IsNullOrEmpty(path))
            {
                path = PreviewPackageState.GetActiveXamlPath();
            }

            _currentPath = null; // force a full restart so the surface relaunches with the new env
            if (!string.IsNullOrEmpty(path))
            {
                ShowDocument(path);
            }
        }

        /// <summary>
        /// Apply a design-time-data (sample data) toggle at runtime. Persists the preference and restarts the
        /// current preview so the surface relaunches with the new <c>SURFACE_DTD_REFLECT</c> env. Only has an
        /// effect together with live mode (the §51 M3 reflection fallback runs after real-type activation). UI
        /// thread only.
        /// </summary>
        public void SetDesignTimeData(bool on)
        {
            if (_disposed)
            {
                return;
            }

            PreviewOptions.DesignTimeData = on;
            Log.Write($"Design-time sample data toggled {(on ? "ON (reflection fallback)" : "off")} — restarting preview.");

            var path = _pinnedPath ?? _currentPath;
            if (string.IsNullOrEmpty(path))
            {
                path = PreviewPackageState.GetActiveXamlPath();
            }

            _currentPath = null; // force a full restart so the surface relaunches with the new env
            if (!string.IsNullOrEmpty(path))
            {
                ShowDocument(path);
            }
        }

        /// <summary>
        /// Whether the surface for <paramref name="path"/> should launch in live mode: the user's global
        /// opt-in is on AND this document hasn't been demoted to the parse path after failing to activate live.
        /// </summary>
        private bool EffectiveLiveMode(string? path) =>
            PreviewOptions.LiveMode &&
            !string.IsNullOrEmpty(path) &&
            !_liveFallbackDocs.Contains(path!);

        /// <summary>
        /// Apply a design/interact-mode toggle at runtime (plan §41). Persists the preference and sends
        /// <c>SetMode</c> to the active surface, which flips its input overlay live — no re-render. Switching
        /// to interact mode clears any current selection. UI thread only.
        /// </summary>
        public void SetDesignMode(bool design)
        {
            if (_disposed)
            {
                return;
            }

            PreviewOptions.DesignMode = design;
            Log.Write($"Design mode toggled {(design ? "ON (select)" : "off (interact)")}.");
            try { _client?.SetMode(design); }
            catch (Exception ex) { Log.Write("SetMode send failed: " + ex.Message); }

            if (!design)
            {
                _lastSelected = null;
                DesignerSelection.Set(null);
            }
        }

        /// <summary>
        /// Preview the mounted page under a different theme (<c>Light</c>/<c>Dark</c>/<c>Default</c>). Because
        /// the surface is a code-only WinUI <c>Application</c> (no App.xaml — required to own the metadata-
        /// provider chain), a runtime <c>RequestedTheme</c> flip does NOT re-resolve <c>{ThemeResource}</c>
        /// brushes (plan §47). The only reliable mechanism is the app-global <c>Application.RequestedTheme</c>,
        /// which is immutable after the first window content — so a theme change is a per-process decision baked
        /// at launch via the <c>SURFACE_THEME</c> env. We therefore persist the preference and RELAUNCH the
        /// surface (mirroring the live-mode toggle), rather than sending a live message. UI thread only.
        /// </summary>
        public void SetTheme(string theme)
        {
            if (_disposed)
            {
                return;
            }

            if (string.Equals(PreviewOptions.Theme, theme, StringComparison.Ordinal))
            {
                return; // no change — avoid a needless relaunch
            }

            PreviewOptions.Theme = theme;
            Log.Write($"Preview theme set to {theme} — restarting preview (per-process app theme).");

            var path = _pinnedPath ?? _currentPath;
            if (string.IsNullOrEmpty(path))
            {
                path = PreviewPackageState.GetActiveXamlPath();
            }

            _currentPath = null; // force a full restart so the surface relaunches with the new SURFACE_THEME env
            if (!string.IsNullOrEmpty(path))
            {
                ShowDocument(path);
            }
        }

        /// <summary>
        /// Pin the design canvas to a device-size preset (DIP), or pass <c>0,0</c> to restore auto (the page's
        /// own size / default canvas). Persists the preference and sends <c>SetCanvasSize</c> to the active
        /// surface, which re-hosts at the new artboard size and re-fits it into the pane. UI thread only.
        /// </summary>
        public void SetCanvasSize(double width, double height)
        {
            if (_disposed)
            {
                return;
            }

            bool auto = !(width > 0 && height > 0);
            PreviewOptions.CanvasWidth = auto ? 0 : width;
            PreviewOptions.CanvasHeight = auto ? 0 : height;
            Log.Write($"Preview canvas size set to {(auto ? "auto" : $"{width:0}x{height:0}")}.");
            try { _client?.SetCanvasSize(auto ? 0 : width, auto ? 0 : height); }
            catch (Exception ex) { Log.Write("SetCanvasSize send failed: " + ex.Message); }
        }

        /// <summary>
        /// Re-assert the sticky size preference on a freshly-hosted warm window (a new surface HWND), so it
        /// survives file switches / surface restarts. Theme is NOT re-applied here — it is baked at launch via
        /// the <c>SURFACE_THEME</c> env (a code-only host can't re-theme live; plan §47), so a fresh host is
        /// already in the right theme. Loop-safe: a <c>SetCanvasSize</c> re-host returns the SAME warm HWND,
        /// which <see cref="OnHwnd"/> routes to <c>ResizeChild</c> (not this fresh-host path) — so it never
        /// re-fires. UI thread only.
        /// </summary>
        private void ReapplyStickyPreviewSettings()
        {
            if (_disposed)
            {
                return;
            }

            try
            {
                double w = PreviewOptions.CanvasWidth, h = PreviewOptions.CanvasHeight;
                if (w > 0 && h > 0)
                {
                    _client?.SetCanvasSize(w, h);
                }
            }
            catch (Exception ex)
            {
                Log.Write("ReapplyStickyPreviewSettings failed: " + ex.Message);
            }
        }

        /// <summary>
        /// Raised (on the UI thread) when the surface reports an element selection, carrying the full
        /// <see cref="SelectedMsg"/> including its authored-tree <c>Path</c>. The in-editor margin uses this to
        /// move the caret to the element's source span (designer -> editor, plan §41 #1).
        /// </summary>
        internal event Action<SelectedMsg>? ElementSelected;

        // The latest custom content-property map from the surface (bug D1): simple type name -> content-prop
        // name (e.g. "ControlExample" -> "Example"). The margin reads it via ContentPropMap to build a source
        // map that recurses into explicit property elements. Null until the first ContentProps arrives.
        private IReadOnlyDictionary<string, string>? _contentPropMap;

        /// <summary>
        /// The most recent custom content-property map reported by the surface (bug D1), or null if none yet.
        /// Keyed by simple runtime type name -> its non-standard XAML content-property name.
        /// </summary>
        internal IReadOnlyDictionary<string, string>? ContentPropMap => _contentPropMap;

        /// <summary>Raised (on the UI thread) when a fresh <see cref="ContentPropsMsg"/> updates the map.</summary>
        internal event Action? ContentPropMapChanged;

        /// <summary>
        /// Select the element at an authored-tree index path in the design surface (editor caret -> designer,
        /// plan §41 #2). No-op if no surface is live or not in design mode. UI thread only.
        /// </summary>
        public void SelectByPath(string path)
        {
            if (_disposed || string.IsNullOrEmpty(path) || !PreviewOptions.DesignMode)
            {
                return;
            }

            try { _client?.SelectByPath(path); }
            catch (Exception ex) { Log.Write("SelectByPath send failed: " + ex.Message); }
        }

        /// <summary>
        /// Apply a live property edit from the panel to the surface behind this preview (plan §41 Phase C).
        /// Registered as the write-back setter via <see cref="DesignerSelection.Set"/> on each selection, so the
        /// edit reaches the same surface that produced the current selection. No-op if the surface is gone.
        /// </summary>
        public void SetProperty(int id, string name, string value)
        {
            if (_disposed || string.IsNullOrEmpty(name) || !PreviewOptions.DesignMode)
            {
                return;
            }

            try { _client?.SetProperty(id, name, value); }
            catch (Exception ex) { Log.Write("SetProperty send failed: " + ex.Message); }
        }

        // The most recent Selected message, held until its ElementProps arrives so the panel updates once with
        // a complete snapshot (header + properties). Correlated by element id.
        private SelectedMsg? _lastSelected;

        private void OnSelected(SelectedMsg sel)
        {
            if (!Dispatcher.CheckAccess())
            {
                _ = Dispatcher.BeginInvoke(new Action(() => OnSelected(sel)));
                return;
            }

            _lastSelected = sel;

            // Show the header immediately; the properties follow in ElementProps (usually same tick). Register
            // this control as the write-back target so panel edits reach the surface that raised the selection.
            DesignerSelection.Set(new SelectionSnapshot
            {
                Id = sel.Id,
                ElementType = sel.ElementType ?? "",
                Name = sel.Name,
            }, SetProperty);

            // Notify the in-editor margin so it can move the caret to this element's source span (#1).
            try { ElementSelected?.Invoke(sel); }
            catch (Exception ex) { Log.Write("ElementSelected handler failed: " + ex.Message); }

            // Note: we intentionally do NOT auto-open the VS "Properties" tool window here anymore. The
            // in-designer Properties flyout (surface-side, feature #4) is now the primary property view, so a
            // selection shouldn't surprise-pop a VS pane. DesignerSelection.Set above still keeps an
            // already-open tool window in sync, and the margin "Properties" button reopens it on demand.
        }

        // Bug D1: the surface reported the authored subtree's custom content-property map. Store it and notify
        // the margin so it rebuilds its XAML source map to recurse into explicit property elements. No UI
        // marshalling needed — this only swaps a reference and the margin handler just flips a dirty flag.
        private void OnContentProps(ContentPropsMsg msg)
        {
            _contentPropMap = msg?.Map;
            try { ContentPropMapChanged?.Invoke(); }
            catch (Exception ex) { Log.Write("ContentPropMapChanged handler failed: " + ex.Message); }
        }

        private void OnElementProps(ElementPropsMsg msg)
        {
            if (!Dispatcher.CheckAccess())
            {
                _ = Dispatcher.BeginInvoke(new Action(() => OnElementProps(msg)));
                return;
            }

            var sel = _lastSelected;
            if (sel == null || sel.Id != msg.Id)
            {
                return; // stale (selection changed before its props arrived)
            }

            var rows = new System.Collections.Generic.List<PropRow>();
            if (msg.Props != null)
            {
                foreach (var p in msg.Props)
                {
                    rows.Add(new PropRow
                    {
                        Name = p.Name ?? "",
                        Category = string.IsNullOrEmpty(p.Category) ? "Misc" : p.Category!,
                        TypeName = p.Type ?? "",
                        Value = p.Value ?? "",
                        ReadOnly = p.ReadOnly,
                        Options = p.Options != null && p.Options.Count > 0 ? p.Options : null,
                    });
                }
            }

            DesignerSelection.Set(new SelectionSnapshot
            {
                Id = sel.Id,
                ElementType = sel.ElementType ?? "",
                Name = sel.Name,
                Props = rows,
            }, SetProperty);
        }

        private void ReloadCurrent()
        {
            if (_disposed || _client == null || _currentPath == null)
            {
                return;
            }

            _ = ThreadHelper.JoinableTaskFactory.RunAsync(async () =>
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                if (_disposed || _currentPath == null)
                {
                    return;
                }

                var xaml = ReadDocumentText(_currentPath);

                // Proactive recycle: a document known to fail-fast the surface on its 2nd render (plan
                // §36), OR any document in live mode (plan §39), must render in a process that has not
                // rendered it yet — so leftover animations/timers/backdrops from the previous render can't
                // fail-fast this one. Promote the pre-warmed spare instead of re-hosting in place (which
                // would risk a crash). The spare is already up, so the swap costs about one render, not a
                // cold process start — no visible restart blip.
                if ((_riskyDocs.Contains(_currentPath) || EffectiveLiveMode(_currentPath)) && TryPromoteSpare(xaml))
                {
                    Log.Write(EffectiveLiveMode(_currentPath)
                        ? "Live-mode edit: rendered on a fresh spare process (per-render isolation)."
                        : "Risky doc edit: recycled onto the warm spare (skipped in-place re-render).");
                    return;
                }

                _client?.UpdateXaml(xaml);
            });
        }

        // ---- process recycling (warm spare) --------------------------------
        //
        // Some content fail-fasts the WinUI surface on its SECOND render in a warm process (plan §36: the
        // arming is process-global and survives unrelated renders in between). To keep editing such a page
        // seamless, we keep a pre-warmed idle "spare" surface — started, Ready, but never rendered, so it
        // is still "unarmed" — and, before a risky 2nd render (or immediately after a crash), promote it:
        // render on the fresh spare (its 1st render always succeeds), swap the view, retire the old
        // process, and warm a new spare. The expensive process start is paid in the background, so the
        // recycle is invisible.

        /// <summary>Start (in the background) an idle spare surface matching the active launch config.</summary>
        private void WarmSpare()
        {
            if (_disposed || _spareClient != null || _spareWarming || string.IsNullOrEmpty(_activeSurfaceExe))
            {
                return;
            }

            _spareWarming = true;
            var gen = _spareGeneration;
            var exe = _activeSurfaceExe!;
            var dll = _activeUserDll;
            var appx = _activeUserAppXaml;
            var live = EffectiveLiveMode(_currentPath); // spare must match the active launch mode
            var theme = _activeTheme; // …and the active theme (baked at launch, per-process)
            var userPri = _activeUserPri; // …and the matched-host merged pri, if a matched host is active

            _ = System.Threading.Tasks.Task.Run(async () =>
            {
                SurfaceClient? spare = null;
                try
                {
                    spare = new SurfaceClient(exe, dll, Log.Write, appx, live, theme, userPri: userPri);
                    await spare.StartAsync(TimeSpan.FromSeconds(25));
                }
                catch (Exception ex)
                {
                    Log.Write("Warm spare failed to start: " + ex.Message);
                    var dead = spare;
                    _ = Dispatcher.InvokeAsync(() =>
                    {
                        _spareWarming = false;
                        try { dead?.Dispose(); } catch { }
                    });
                    return;
                }

                var ready = spare;
                _ = Dispatcher.InvokeAsync(() =>
                {
                    _spareWarming = false;

                    // A doc switch (or dispose) happened while warming — this spare is for a stale config.
                    if (_disposed || gen != _spareGeneration)
                    {
                        try { ready!.Dispose(); } catch { }
                        return;
                    }

                    _spareClient = ready;
                    _spareReady = true;
                    ready!.Closed += OnSpareClosed;
                    Log.Write("Warm spare ready.");
                });
            });
        }

        private void OnSpareClosed(string reason)
        {
            _ = Dispatcher.InvokeAsync(() =>
            {
                var spare = _spareClient;
                if (spare != null)
                {
                    spare.Closed -= OnSpareClosed;
                }

                _spareClient = null;
                _spareReady = false;
                Log.Write("Warm spare died while idle: " + reason);
                WarmSpare();
            });
        }

        /// <summary>
        /// Promote the pre-warmed spare to active and render <paramref name="xaml"/> on it (the spare's
        /// first render — always safe). The old active is silenced and queued for retirement once the new
        /// render lands. Returns false if no spare is ready (caller falls back to a cold restart). Must be
        /// called on the UI thread.
        /// </summary>
        private bool TryPromoteSpare(string xaml)
        {
            if (_disposed || _spareClient == null || !_spareReady)
            {
                return false;
            }

            var spare = _spareClient;
            _spareClient = null;
            _spareReady = false;
            spare.Closed -= OnSpareClosed;

            // Silence the old active so its imminent (intentional) death can't drive the UI or trigger an
            // auto-restart. Keep its native window on screen until the new render swaps it in; pre-mark the
            // host dead so the swap's teardown won't reparent the old child to the desktop (no flash).
            var old = _client;
            if (old != null)
            {
                old.Frame -= OnFrame;
                old.Error -= OnError;
                old.Hwnd -= OnHwnd;
                old.NativeExited -= OnNativeExited;
                old.Selected -= OnSelected;
                old.ElementProps -= OnElementProps;
                old.ContentProps -= OnContentProps;
                old.Closed -= OnClosed;
            }

            _nativeHost?.MarkSurfaceDead();
            _retiringClient = old;

            // Wire the spare as the new active.
            spare.Frame += OnFrame;
            spare.Error += OnError;
            spare.Hwnd += OnHwnd;
            spare.NativeExited += OnNativeExited;
            spare.Selected += OnSelected;
            spare.ElementProps += OnElementProps;
            spare.ContentProps += OnContentProps;
            spare.Closed += OnClosed;
            _client = spare;
            _activeProcessRendered = false; // the promoted spare hasn't rendered yet
            _suppressAutoRestart = false;

            try
            {
                // Match the design/interact mode before the spare's first (and only) render.
                spare.SetMode(PreviewOptions.DesignMode);
                if (PreferNative && _nativeSupported)
                {
                    spare.EnterNative(xaml, 0, 0, 1.0);
                }
                else
                {
                    var (w, h, sc) = GetViewportSync();
                    spare.LoadXaml(xaml, w, h, sc);
                }
            }
            catch (Exception ex)
            {
                // The spare is already the active client; let its Closed/Error path handle the failure.
                Log.Write("TryPromoteSpare render send failed: " + ex.Message);
            }

            return true;
        }

        /// <summary>After a successful render: retire any client we swapped away from and ensure a spare.</summary>
        private void OnRenderSucceeded()
        {
            _restartAttempts = 0;
            _activeProcessRendered = true; // this process produced a frame — a later crash is a 2nd-render case

            var retiring = _retiringClient;
            if (retiring != null)
            {
                _retiringClient = null;
                try { retiring.Dispose(); } catch { }
                Log.Write("Recycle complete: retired the previous surface process.");
            }

            WarmSpare();
        }

        // ---- version-matched fidelity upgrade (nov-vsix-wire) --------------
        //
        // The instant preview always launches the bundled 2.2.0 host. When the target project references a
        // different WASDK version, this produces a version-matched self-contained host in the background —
        // either by run-copying a verified cached host (fast) or by kicking the provisioner --build (slow,
        // once per version) — then hot-swaps it in for full fidelity (version-new controls upgrade from
        // placeholder to real). Cancellation is generation-guarded at BOTH the build-wait and the promote, so
        // a document that moves on (switch/close/dispose) never gets a stale host swapped into it. Build
        // failures degrade gracefully: stay on the already-rendered bundled preview, no crash, no retry loop.

        private void KickFidelityUpgrade(HostSelection? plan)
        {
            if (_disposed || plan == null)
            {
                return;
            }

            // No upgrade needed (bundled version, or undiscoverable): surface only the gentle no-toolchain note.
            if (!plan.NeedsUpgrade)
            {
                if (!string.IsNullOrEmpty(plan.Note))
                {
                    ShowFidelityNote(plan.Note!);
                }
                return;
            }

            if (!PreviewOptions.FullFidelityAutoBuild)
            {
                Log.Write("Fidelity upgrade: auto-build disabled by setting; staying on bundled 2.2.0.");
                return;
            }

            if (_fullFidelityCancelled || _upgradeInProgress)
            {
                return;
            }

            var version = plan.TargetVersion;
            if (string.IsNullOrEmpty(version))
            {
                return;
            }

            if (FailedVersions.Contains(version!))
            {
                Log.Write($"Fidelity upgrade for {version}: a build already failed this session — not retrying.");
                return;
            }

            var kind = plan.Upgrade;
            var project = plan.TargetProject;
            if (kind == HostUpgradeKind.Build && string.IsNullOrEmpty(project))
            {
                Log.Write("Fidelity upgrade: no owning project to build from; staying on bundled 2.2.0.");
                return;
            }

            _upgradeInProgress = true;
            var gen = _upgradeGeneration;
            var userDll = _activeUserDll;
            var userAppXaml = _activeUserAppXaml;
            var theme = _activeTheme;
            var live = EffectiveLiveMode(_currentPath);
            var reflect = live && PreviewOptions.DesignTimeData;

            // Acquire (start or join) the shared per-version build on the UI thread so _upgradeBuild is owned
            // here (de-dupe: two docs of the same version share ONE build).
            MatchedHostBuild? build = null;
            if (kind == HostUpgradeKind.Build)
            {
                build = HostProvisionerRunner.Acquire(version!, project!, Log.Write);
                if (build == null)
                {
                    _upgradeInProgress = false;
                    ShowFidelityNote($"Install the .NET SDK for a full-fidelity WinAppSDK {version} preview.");
                    return;
                }

                _upgradeBuild = build;
                ShowFidelityBuilding(version!, building: true);
            }
            else
            {
                ShowFidelityBuilding(version!, building: false); // verified cache present — just a quick run-copy
            }

            _ = System.Threading.Tasks.Task.Run(async () =>
            {
                string? completedHost = null;
                // 1. Wait for the shared build (if any).
                if (build != null)
                {
                    HostBuildOutcome outcome;
                    try { outcome = await build.Completion; }
                    catch (Exception ex) { outcome = new HostBuildOutcome { Success = false, Error = ex.Message }; }
                    if (!outcome.Success)
                    {
                        await MarshalAsync(() =>
                        {
                            if (gen != _upgradeGeneration)
                            {
                                return;
                            }

                            FailedVersions.Add(version!);
                            Log.Write($"Fidelity upgrade for {version}: build did not yield a matched host ({outcome.Error}); staying on bundled 2.2.0.");
                            EndUpgrade(gen, note: null);
                        });
                        return;
                    }
                    completedHost = outcome.HostDir;
                }

                // 2. Run-copy the verified cached host into a transient per-session dir (never mutate the cache).
                var runRoot = Path.Combine(Path.GetTempPath(), "WinUIXamlPreview", "run", Guid.NewGuid().ToString("N"));
                var prepared = completedHost == null ? null : MatchedHostResolver.PrepareMatchedRunCopy(completedHost, runRoot, Log.Write);
                if (prepared == null)
                {
                    TryDeleteDir(runRoot);
                    await MarshalAsync(() => { if (gen == _upgradeGeneration) EndUpgrade(gen, note: null); });
                    return;
                }

                var matchedExe = prepared.Value.exe;
                var matchedPri = prepared.Value.pri;

                // Cancellation/supersession guard BEFORE we spawn the matched host (the WarmSpare-on-matched
                // checkpoint): if the user cancelled or switched documents during the build/run-copy, don't spend
                // a Surface.exe on it. The promote guard below is the second, authoritative checkpoint.
                bool superseded = false;
                await MarshalAsync(() => superseded = _disposed || gen != _upgradeGeneration || _fullFidelityCancelled);
                if (superseded)
                {
                    TryDeleteDir(runRoot);
                    return;
                }

                // 3. Start the matched client and await Ready — off the UI thread.
                SurfaceClient? matched = null;
                try
                {
                    matched = new SurfaceClient(matchedExe, userDll, Log.Write, userAppXaml, live, theme, reflectionFallback: reflect, userPri: matchedPri);
                    await matched.StartAsync(TimeSpan.FromSeconds(25));
                }
                catch (Exception ex)
                {
                    Log.Write("Fidelity upgrade: matched host failed to start: " + ex.Message);
                    try { matched?.Dispose(); } catch { }
                    TryDeleteDir(runRoot);
                    await MarshalAsync(() => { if (gen == _upgradeGeneration) EndUpgrade(gen, note: null); });
                    return;
                }

                // 4. Promote on the UI thread (generation-checked: never swap into a document that moved on).
                var readyMatched = matched;
                await MarshalAsync(() =>
                {
                    if (_disposed || gen != _upgradeGeneration)
                    {
                        try { readyMatched!.Dispose(); } catch { }
                        TryDeleteDir(runRoot);
                        return;
                    }

                    PromoteMatched(readyMatched!, matchedExe, matchedPri, runRoot, version!);
                });
            });
        }

        /// <summary>
        /// Swap the ready version-matched client in as the active surface (mirrors <see cref="TryPromoteSpare"/>
        /// but for the matched host + its merged pri). The old bundled client is silenced and retired once the
        /// matched render lands; future crash-recycle spares now match the matched host. UI thread only.
        /// </summary>
        private void PromoteMatched(SurfaceClient matched, string matchedExe, string matchedPri, string runRoot, string version)
        {
            string xaml;
            try
            {
                ThreadHelper.ThrowIfNotOnUIThread();
                xaml = ReadDocumentText(_currentPath ?? _pinnedPath ?? string.Empty);
            }
            catch (Exception ex)
            {
                Log.Write("PromoteMatched: could not read current document (" + ex.Message + "); staying on bundled.");
                try { matched.Dispose(); } catch { }
                TryDeleteDir(runRoot);
                EndUpgrade(_upgradeGeneration, note: null);
                return;
            }

            // Silence the old (bundled) active so its imminent retirement can't drive the UI or auto-restart.
            var old = _client;
            if (old != null)
            {
                old.Frame -= OnFrame;
                old.Error -= OnError;
                old.Hwnd -= OnHwnd;
                old.NativeExited -= OnNativeExited;
                old.Selected -= OnSelected;
                old.ElementProps -= OnElementProps;
                old.ContentProps -= OnContentProps;
                old.Closed -= OnClosed;
            }

            _nativeHost?.MarkSurfaceDead();
            _retiringClient = old;

            // Any in-flight/ready BUNDLED crash-spare is now stale — invalidate + drop it; a matched spare is
            // warmed after the matched render succeeds (OnRenderSucceeded).
            _spareGeneration++;
            _spareWarming = false;
            if (_spareClient != null)
            {
                _spareClient.Closed -= OnSpareClosed;
                try { _spareClient.Dispose(); } catch { }
                _spareClient = null;
                _spareReady = false;
            }

            // Wire the matched client as the new active + retarget the active launch config so crash recycling
            // reproduces the matched host (exe + merged pri).
            matched.Frame += OnFrame;
            matched.Error += OnError;
            matched.Hwnd += OnHwnd;
            matched.NativeExited += OnNativeExited;
            matched.Selected += OnSelected;
            matched.ElementProps += OnElementProps;
            matched.ContentProps += OnContentProps;
            matched.Closed += OnClosed;
            _client = matched;
            _activeProcessRendered = false;
            _suppressAutoRestart = false;
            _activeSurfaceExe = matchedExe;
            _activeUserPri = matchedPri;
            _upgradeRunRoot = runRoot;

            try
            {
                matched.SetMode(PreviewOptions.DesignMode);
                if (PreferNative && _nativeSupported)
                {
                    matched.EnterNative(xaml, 0, 0, 1.0);
                }
                else
                {
                    var (w, h, sc) = GetViewportSync();
                    matched.LoadXaml(xaml, w, h, sc);
                }
            }
            catch (Exception ex)
            {
                Log.Write("PromoteMatched render send failed: " + ex.Message);
            }

            Log.Write($"Fidelity upgrade: hot-swapped to the version-matched WinAppSDK {version} host.");
            EndUpgrade(_upgradeGeneration, note: null);
            ShowFidelityReady(version);
        }

        /// <summary>Finish an upgrade attempt for generation <paramref name="gen"/>: release build interest, clear the in-progress flag, and show the note (or hide the banner). UI thread.</summary>
        private void EndUpgrade(int gen, string? note)
        {
            if (gen != _upgradeGeneration)
            {
                return;
            }

            _upgradeInProgress = false;
            if (_upgradeBuild != null)
            {
                try { _upgradeBuild.Release(cancelIfLast: false); } catch { }
                _upgradeBuild = null;
            }

            if (!string.IsNullOrEmpty(note))
            {
                ShowFidelityNote(note!);
            }
            else
            {
                HideFidelityBanner();
            }
        }

        private System.Threading.Tasks.Task MarshalAsync(Action action) => Dispatcher.InvokeAsync(action).Task;

        private static void TryDeleteDir(string dir)
        {
            try { if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true); } catch { }
        }

        // ---- fidelity banner (subtle, bottom-docked, non-blocking) ---------

        private void ShowFidelityBuilding(string version, bool building)
        {
            _fidelityHideTimer?.Stop();
            FidelityBanner.Visibility = Visibility.Visible;
            FidelityProgress.Visibility = Visibility.Visible;
            FidelityProgress.IsIndeterminate = true;
            FidelityIcon.Visibility = Visibility.Collapsed;
            FidelityCancel.Visibility = Visibility.Visible;
            FidelityText.Text = building
                ? $"Preparing full-fidelity WinAppSDK {version} preview — checking shared inputs and cache…"
                : $"Preparing full-fidelity WinAppSDK {version} preview…";
        }

        private void ShowFidelityReady(string version)
        {
            FidelityBanner.Visibility = Visibility.Visible;
            FidelityProgress.Visibility = Visibility.Collapsed;
            FidelityProgress.IsIndeterminate = false;
            FidelityIcon.Visibility = Visibility.Visible;
            FidelityCancel.Visibility = Visibility.Collapsed;
            FidelityText.Text = $"Full-fidelity preview ready (WinAppSDK {version}).";
            ScheduleFidelityAutoHide(TimeSpan.FromSeconds(4));
        }

        private void ShowFidelityNote(string note)
        {
            FidelityBanner.Visibility = Visibility.Visible;
            FidelityProgress.Visibility = Visibility.Collapsed;
            FidelityProgress.IsIndeterminate = false;
            FidelityIcon.Visibility = Visibility.Collapsed;
            FidelityCancel.Visibility = Visibility.Collapsed;
            FidelityText.Text = note;
            ScheduleFidelityAutoHide(TimeSpan.FromSeconds(7));
        }

        private void HideFidelityBanner()
        {
            _fidelityHideTimer?.Stop();
            FidelityBanner.Visibility = Visibility.Collapsed;
        }

        private void ScheduleFidelityAutoHide(TimeSpan after)
        {
            if (_fidelityHideTimer == null)
            {
                _fidelityHideTimer = new DispatcherTimer();
                _fidelityHideTimer.Tick += (_, __) => { _fidelityHideTimer!.Stop(); HideFidelityBanner(); };
            }

            _fidelityHideTimer.Stop();
            _fidelityHideTimer.Interval = after;
            _fidelityHideTimer.Start();
        }

        private void OnFidelityCancelClick(object sender, RoutedEventArgs e)
        {
            // Supersede any in-flight upgrade (the background task's generation check will make it abandon the
            // promote) and release our build interest — cancelling the shared build if no other preview wants it.
            _fullFidelityCancelled = true;
            _upgradeGeneration++;
            _upgradeInProgress = false;
            if (_upgradeBuild != null)
            {
                try { _upgradeBuild.Release(cancelIfLast: true); } catch { }
                _upgradeBuild = null;
            }

            Log.Write("Fidelity upgrade cancelled by user.");
            HideFidelityBanner();
        }

        private (int w, int h, double scale) GetViewportSync()
        {
            int w = (int)Math.Max(1, Math.Round(ActualWidth > 0 ? ActualWidth : 800));
            int h = (int)Math.Max(1, Math.Round(ActualHeight > 0 ? ActualHeight : 600));
            double scale = Math.Max(1.0, Math.Min(2.0, _lastScale));
            return (w, h, scale);
        }

        // ---- surface events (socket thread -> dispatcher) ------------------

        private void OnFrame(FrameMsg frame)
        {
            _ = Dispatcher.InvokeAsync(() =>
            {
                if (_disposed || string.IsNullOrEmpty(frame.Data))
                {
                    return;
                }

                try
                {
                    var bytes = Convert.FromBase64String(frame.Data);
                    using var ms = new MemoryStream(bytes);
                    var bmp = new BitmapImage();
                    bmp.BeginInit();
                    bmp.CacheOption = BitmapCacheOption.OnLoad;
                    bmp.StreamSource = ms;
                    bmp.EndInit();
                    bmp.Freeze();

                    FrameImage.Source = bmp;

                    // Ensure the image path is visible (native mode collapses it).
                    if (NativeHostHolder.Visibility == Visibility.Visible)
                    {
                        TeardownNativeHost(surfaceDead: true);
                    }
                    FrameImage.Visibility = Visibility.Visible;

                    // Display at logical (DIP) size so the supersampled pixels map ~1:1 to device
                    // pixels — mirrors the VS Code webview's logical sizing.
                    if (frame.DipWidth > 0 && frame.DipHeight > 0)
                    {
                        FrameImage.Width = frame.DipWidth;
                        FrameImage.Height = frame.DipHeight;
                    }

                    _hasFrame = true;
                    OnRenderSucceeded(); // clear death streak; retire any swapped-away surface; warm a spare
                    HideStatus();
                    MaybeShowLiveFallbackBanner();
                    Log.Write($"Frame rendered: {frame.Width}x{frame.Height}px ({frame.DipWidth}x{frame.DipHeight} dip).");
                }
                catch (Exception ex)
                {
                    SetStatus("Failed to decode frame.", spinner: false, detail: ex.Message);
                }
            });
        }

        private void OnHwnd(HwndMsg msg)
        {
            _ = Dispatcher.InvokeAsync(() =>
            {
                if (_disposed || msg.Hwnd == 0)
                {
                    return;
                }

                var hwnd = new IntPtr(msg.Hwnd);
                int pxW = Math.Max(1, msg.PixelWidth);
                int pxH = Math.Max(1, msg.PixelHeight);
                double dipW = msg.DipWidth > 0 ? msg.DipWidth : pxW;
                double dipH = msg.DipHeight > 0 ? msg.DipHeight : pxH;

                try
                {
                    if (_nativeHost != null && _nativeHost.SurfaceHwnd == hwnd)
                    {
                        // Same warm window re-hosted after an edit: resize the child in place.
                        _nativeHost.ResizeChild(pxW, pxH);
                    }
                    else
                    {
                        // First/new HWND: build a fresh host and insert it into the holder.
                        TeardownNativeHost();
                        var host = new SurfaceHwndHost(hwnd, pxW, pxH);
                        NativeHostHolder.Child = host;
                        _nativeHost = host;

                        // A fresh warm window starts at the surface's default theme (Light) + auto size;
                        // re-assert any sticky user preference so it survives file switches / restarts.
                        // Loop-safe: SetTheme is live (no re-host); a SetCanvasSize re-host returns THIS
                        // same hwnd, so the next OnHwnd takes the ResizeChild branch above, not this one.
                        ReapplyStickyPreviewSettings();
                    }

                    // The holder fills the tool window (see PreviewControl.xaml); HwndHost sizes the
                    // reparented child to the holder's arranged rect — i.e. to the pane, never to the
                    // (possibly larger) design canvas — so it can't overflow into neighboring VS panes.
                    // The surface's fixed-size canvas is anchored top-left, so this is a 1:1 viewport.

                    // Swap to the native view (hide the image path).
                    FrameImage.Visibility = Visibility.Collapsed;
                    FrameImage.Source = null;
                    NativeHostHolder.Visibility = Visibility.Visible;

                    _hasNative = true;
                    OnRenderSucceeded(); // clear death streak; retire any swapped-away surface; warm a spare
                    HideStatus();
                    MaybeShowLiveFallbackBanner();
                    Log.Write($"Native surface hosted: hwnd=0x{msg.Hwnd:X} px={pxW}x{pxH} dip={dipW:0}x{dipH:0} scale={msg.Scale}.");
                }
                catch (Exception ex)
                {
                    Log.Write("OnHwnd failed: " + ex);
                    SetStatus("Failed to host native surface.", spinner: false, detail: ex.Message);
                }
            });
        }

        private void OnNativeExited()
        {
            Log.Write("Surface acknowledged ExitNative (window re-cloaked off-screen).");
        }

        private void OnError(ErrorMsg err)
        {
            _ = Dispatcher.InvokeAsync(() =>
            {
                if (_disposed)
                {
                    return;
                }

                // P1 (VE1): a structurally non-designable root — a ResourceDictionary (styles/themes/
                // control-template dictionary), a Window/WindowEx, or a $safeprojectname$ project-template
                // placeholder — is not a broken preview. The surface classifies it distinctly (NotDesignable
                // + a human reason) instead of a parse failure. Present it as a calm, informational state
                // rather than a scary red error or a blank surface, so the user understands the preview is
                // intentionally empty for this file.
                if (err.NotDesignable)
                {
                    var reason = string.IsNullOrWhiteSpace(err.Message)
                        ? "This file has no designable page root."
                        : err.Message!;
                    Log.Write("Surface reported a non-designable root — " + reason);
                    SetNotDesignable(reason);
                    return;
                }

                var where = err.Line.HasValue ? $" (line {err.Line}, col {err.Column})" : "";
                var text = $"{err.Phase}: {err.Message}{where}";
                Log.Write("Surface error — " + text);

                if (_hasFrame || _hasNative)
                {
                    // Keep the last good frame / native view; surface a compact banner.
                    SetDetailBanner(text);
                }
                else
                {
                    SetStatus("XAML error", spinner: false, detail: text);
                }
            });
        }

        private void OnClosed(string reason)
        {
            Log.Write("Surface closed: " + reason);
            _ = Dispatcher.InvokeAsync(() =>
            {
                // The surface process died: its child window is gone. Drop the native host without
                // reparenting the dead handle.
                if (_nativeHost != null)
                {
                    TeardownNativeHost(surfaceDead: true);
                }

                // Don't self-heal a death we caused (dispose / document switch), or after control teardown.
                if (_disposed || _suppressAutoRestart)
                {
                    return;
                }

                // The active surface died unexpectedly — nearly always the §36 2nd-render fail-fast. Learn
                // that this document is risky so future edits recycle it proactively (no repeat crash).
                var path = _currentPath;
                if (!string.IsNullOrEmpty(path))
                {
                    _riskyDocs.Add(path!);
                }

                // Live-mode auto-fallback (plan §39): a FRESH live process died before producing any frame —
                // an inherent crasher (Acrylic backdrop / animated-visual realization / App-window coupling)
                // that a fresh live process can't render either. Retrying live is futile, so demote THIS
                // document to the robust parse path for the session and relaunch. The preview degrades to a
                // static (no-x:Bind) render instead of a dead pane; toggling live mode re-arms it.
                if (!string.IsNullOrEmpty(path) && EffectiveLiveMode(path) && !_activeProcessRendered)
                {
                    _liveFallbackDocs.Add(path!);
                    _restartAttempts = 0; // a mode change, not a retry — give the parse relaunch a fresh budget
                    _hasFrame = false;
                    _hasNative = false;
                    Log.Write($"Live preview could not activate '{Path.GetFileName(path)}' (crashed with no frame); falling back to a static parse-mode preview.");
                    SetStatus("Live preview unavailable — showing static preview…", spinner: true, detail: Path.GetFileName(path!));
                    _currentPath = null; // force a full re-init in parse mode
                    ShowDocument(path);
                    return;
                }

                // Self-heal, bounded (the counter resets on any successful render, so ordinary edit-crashes
                // recover indefinitely; only a doc that dies on its very FIRST render, or a broken surface
                // exe, can exhaust the budget).
                if (!string.IsNullOrEmpty(path) && _restartAttempts < MaxAutoRestarts)
                {
                    _restartAttempts++;
                    _hasFrame = false;
                    _hasNative = false;

                    // Fast path: promote the pre-warmed spare and render there (its 1st render always
                    // succeeds) — turns the crash into a sub-second swap instead of a cold process start.
                    string? xaml = null;
                    try { xaml = ReadDocumentText(path!); }
                    catch (Exception ex) { Log.Write("Re-read for recycle failed: " + ex.Message); }

                    if (xaml != null && TryPromoteSpare(xaml))
                    {
                        Log.Write($"Surface died; recovered via warm spare (attempt {_restartAttempts}/{MaxAutoRestarts}).");
                        SetStatus("Recycling surface…", spinner: true, detail: Path.GetFileName(path!));
                        return;
                    }

                    // No spare available — fall back to a full cold restart.
                    Log.Write($"Surface died; cold-restarting preview (attempt {_restartAttempts}/{MaxAutoRestarts}).");
                    SetStatus("Surface restarted; reloading…", spinner: true, detail: Path.GetFileName(path!));
                    _currentPath = null; // force ShowDocument to fully re-init rather than short-circuit
                    ShowDocument(path);
                    return;
                }

                if (_hasFrame || _hasNative)
                {
                    return;
                }

                SetStatus(
                    "Surface closed.",
                    spinner: false,
                    detail: _restartAttempts >= MaxAutoRestarts
                        ? $"Auto-restart gave up after {MaxAutoRestarts} attempts. {reason}"
                        : reason);
            });
        }

        // ---- viewport / sizing ---------------------------------------------

        private async System.Threading.Tasks.Task<(int w, int h, double scale)> GetViewportAsync()
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            double scale = 1.5;
            try
            {
                var dpi = VisualTreeHelper.GetDpi(this);
                if (dpi.DpiScaleX > 0)
                {
                    scale = dpi.DpiScaleX;
                }
            }
            catch
            {
                // fall back to a sensible default density
            }

            scale = Math.Max(1.0, Math.Min(2.0, scale));
            _lastScale = scale;

            int w = (int)Math.Max(1, Math.Round(ActualWidth > 0 ? ActualWidth : 800));
            int h = (int)Math.Max(1, Math.Round(ActualHeight > 0 ? ActualHeight : 600));
            return (w, h, scale);
        }

        private void OnResizeDebounceTick(object? sender, EventArgs e)
        {
            _resizeDebounce.Stop();
            if (_disposed || _client == null)
            {
                return;
            }

            // Native mode: the child is a fixed-size design canvas; a pane resize is handled locally by
            // the ScrollViewer, so no surface round-trip is needed.
            if (_nativeHost != null)
            {
                return;
            }

            if (!_hasFrame)
            {
                return;
            }

            int w = (int)Math.Max(1, Math.Round(ActualWidth));
            int h = (int)Math.Max(1, Math.Round(ActualHeight));
            _client.Resize(w, h, _lastScale);
        }

        // ---- helpers --------------------------------------------------------

        private bool IsCurrent(string? path) =>
            !string.IsNullOrEmpty(path) &&
            string.Equals(_currentPath, path, StringComparison.OrdinalIgnoreCase);

        private static string ReadDocumentText(string path)
        {
            ThreadHelper.ThrowIfNotOnUIThread();

            // Prefer the in-memory buffer so unsaved edits are previewed.
            try
            {
                if (Microsoft.VisualStudio.Shell.Package.GetGlobalService(typeof(SDTE)) is DTE dte)
                {
                    foreach (Document doc in dte.Documents)
                    {
                        if (string.Equals(doc.FullName, path, StringComparison.OrdinalIgnoreCase) &&
                            doc.Object("TextDocument") is TextDocument td)
                        {
                            var start = td.StartPoint.CreateEditPoint();
                            return start.GetText(td.EndPoint);
                        }
                    }
                }
            }
            catch
            {
                // fall back to disk
            }

            return File.ReadAllText(path);
        }

        private void SetStatus(string text, bool spinner, string? detail = null)
        {
            StatusOverlay.Visibility = Visibility.Visible;
            StatusIcon.Visibility = Visibility.Collapsed;
            Spinner.Visibility = spinner ? Visibility.Visible : Visibility.Collapsed;
            Spinner.IsIndeterminate = spinner;
            StatusText.Text = text;
            if (string.IsNullOrEmpty(detail))
            {
                StatusDetail.Visibility = Visibility.Collapsed;
            }
            else
            {
                StatusDetail.Text = detail;
                StatusDetail.Visibility = Visibility.Visible;
            }
        }

        private void SetDetailBanner(string text)
        {
            // Non-blocking: overlay stays hidden (frame visible), detail shown briefly at bottom.
            StatusOverlay.Visibility = Visibility.Visible;
            StatusOverlay.VerticalAlignment = VerticalAlignment.Bottom;
            StatusIcon.Visibility = Visibility.Collapsed;
            Spinner.Visibility = Visibility.Collapsed;
            StatusText.Text = "XAML error (showing last good frame)";
            StatusDetail.Text = text;
            StatusDetail.Visibility = Visibility.Visible;
        }

        /// <summary>
        /// P1 (VE1): render the friendly "not a designable page" state for a structurally non-designable
        /// root (ResourceDictionary / Window / project-template placeholder). Calm and informational — an
        /// info icon, a plain title, and the surface's human-readable reason — instead of a red parse error
        /// or a blank pane. Clears any stale frame/native view so the message is the only thing shown.
        /// </summary>
        private void SetNotDesignable(string reason)
        {
            // Drop any leftover surface view from a previously previewed page so it can't sit behind the
            // message (a non-page never produces a frame or native window of its own).
            if (_nativeHost != null)
            {
                TeardownNativeHost(surfaceDead: true);
            }
            FrameImage.Visibility = Visibility.Collapsed;
            FrameImage.Source = null;
            _hasFrame = false;
            _hasNative = false;

            StatusOverlay.Visibility = Visibility.Visible;
            StatusOverlay.VerticalAlignment = VerticalAlignment.Center;
            StatusIcon.Visibility = Visibility.Visible;
            Spinner.Visibility = Visibility.Collapsed;
            Spinner.IsIndeterminate = false;
            StatusText.Text = "Not a designable page";
            StatusDetail.Text = reason;
            StatusDetail.Visibility = Visibility.Visible;
        }

        private void HideStatus()
        {
            StatusOverlay.Visibility = Visibility.Collapsed;
            StatusOverlay.VerticalAlignment = VerticalAlignment.Center;
        }

        private void MaybeShowLiveFallbackBanner()
        {
            // A document demoted from live to parse (plan §39): keep a quiet, non-blocking note pinned to the
            // bottom so the user knows x:Bind/state won't render for this page, without hiding the (successful)
            // static frame. Only appears when live mode is globally on but this page couldn't activate.
            if (_currentPath == null || !_liveFallbackDocs.Contains(_currentPath))
            {
                return;
            }

            StatusOverlay.Visibility = Visibility.Visible;
            StatusOverlay.VerticalAlignment = VerticalAlignment.Bottom;
            StatusIcon.Visibility = Visibility.Collapsed;
            Spinner.Visibility = Visibility.Collapsed;
            StatusText.Text = "Static preview";
            StatusDetail.Text = "Live preview isn't available for this page; x:Bind and code-behind state won't render.";
            StatusDetail.Visibility = Visibility.Visible;
        }

        private void TeardownNativeHost(bool surfaceDead = false)
        {
            var host = _nativeHost;
            _nativeHost = null;
            _hasNative = false;
            if (host != null)
            {
                // When the surface process is (about to be) killed, mark the handle dead so the host's
                // DestroyWindowCore does NOT reparent it back to the desktop (which would flash on screen).
                if (surfaceDead)
                {
                    host.MarkSurfaceDead();
                }

                try { NativeHostHolder.Child = null; } catch { }
                try { host.Dispose(); } catch { }
            }

            NativeHostHolder.Visibility = Visibility.Collapsed;
            NativeHostHolder.Width = double.NaN;
            NativeHostHolder.Height = double.NaN;
        }

        private void DisposeClient()
        {
            // We're intentionally tearing this client down; a Closed event it raises during teardown
            // must not trigger an auto-restart.
            _suppressAutoRestart = true;

            // Cancel any in-flight version-matched upgrade so it can't promote into a document that has moved
            // on (generation bump), release our interest in the shared build (cancels it if we were the last
            // interested preview), and hide the banner.
            _upgradeGeneration++;
            _upgradeInProgress = false;
            if (_upgradeBuild != null)
            {
                try { _upgradeBuild.Release(cancelIfLast: true); } catch { }
                _upgradeBuild = null;
            }
            HideFidelityBanner();

            // Invalidate any in-flight spare warm (its launch config is about to be stale) and tear down
            // the spare + any surface we were mid-swap retiring.
            _spareGeneration++;
            _spareWarming = false;
            if (_spareClient != null)
            {
                _spareClient.Closed -= OnSpareClosed;
                try { _spareClient.Dispose(); } catch { }
                _spareClient = null;
                _spareReady = false;
            }

            if (_retiringClient != null)
            {
                try { _retiringClient.Dispose(); } catch { }
                _retiringClient = null;
            }

            // Native host is bound to this surface process; tear it down first (marking the handle dead
            // so we don't flash the window to the desktop) before killing the process.
            TeardownNativeHost(surfaceDead: true);

            var client = _client;
            _client = null;
            if (client != null)
            {
                client.Frame -= OnFrame;
                client.Error -= OnError;
                client.Hwnd -= OnHwnd;
                client.NativeExited -= OnNativeExited;
                client.Selected -= OnSelected;
                client.ElementProps -= OnElementProps;
                client.ContentProps -= OnContentProps;
                client.Closed -= OnClosed;
                client.Dispose();
            }

            // Now that every client rooted in the matched run-copy is gone, delete the transient run-copy dir.
            var runRoot = _upgradeRunRoot;
            _upgradeRunRoot = null;
            _activeUserPri = null;
            if (runRoot != null)
            {
                TryDeleteDir(runRoot);
            }
        }

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            _resizeDebounce.Stop();
            DisposeClient();
        }
    }
}
