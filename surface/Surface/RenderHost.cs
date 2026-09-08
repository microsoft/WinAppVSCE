using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Microsoft.UI;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Markup;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Windows.Foundation;
using Windows.Graphics;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;

namespace Surface;

/// <summary>
/// A warm, reusable off-screen render surface. Unlike the S1/S2 batch harness (which
/// opened a fresh window per document and then exited), this host is created ONCE on the
/// UI thread at server startup and then services many render requests over its lifetime:
/// <list type="bullet">
///   <item>a persistent, cloaked, off-screen <c>_anchor</c> window keeps the WinUI message
///     loop alive for the whole process (WinUI ends the loop when the last window closes);</item>
///   <item>a single reusable, cloaked, off-screen <c>_renderWindow</c> is kept activated and
///     simply has its <see cref="Window.Content"/> swapped per render — the "warm" reuse that
///     avoids the cost/flicker of standing up a window for every frame.</item>
/// </list>
/// All members must be invoked on the UI (dispatcher) thread; the TCP server marshals here
/// via <c>DispatcherQueue.TryEnqueue</c>.
/// </summary>
internal sealed class RenderHost
{
    private readonly DispatcherQueue _dispatcher = DispatcherQueue.GetForCurrentThread();

    private Window? _anchor;
    private Window? _renderWindow;
    // The render window's top-level HWND, cached at creation. SetParent (client reparent) does NOT
    // change the HWND, but once the window is a WS_CHILD, `Window.AppWindow` returns null — so any
    // path that needs the HWND after reparent (native re-host) must use this cached value, never
    // re-derive it from AppWindow.Id.
    private IntPtr _renderHwnd = IntPtr.Zero;
    private double _dpiScale = 1.0;

    // Design-time selection layer (plan §41). The designer defaults to "design" (select) mode: clicks pick
    // an element instead of interacting with the live app. _design is the layer mounted by the current
    // native host (null in frame mode); _designMode persists the mode across re-hosts so a toggle sticks.
    private bool _designMode = true;
    private DesignSurface? _design;

    // Size preview (user-requested) + the image-path theme baseline. _currentTheme is baked into the
    // IMAGE path's host Grid (RenderElementAsync) and stays Light so the streamed-image (VS Code) preview
    // renders Light regardless of the app-global theme. The NATIVE (VS) path ignores this and inherits the
    // per-process Application.RequestedTheme (set at startup from the SURFACE_THEME env — see App.ctor),
    // because a runtime RequestedTheme flip cannot re-resolve {ThemeResource} in a code-only Application.
    // _sizeOverride pins the design canvas to a device preset (null = auto: the page's own size / default
    // canvas). _designCanvasHost is the host Grid of the mounted surface.
    private ElementTheme _currentTheme = ElementTheme.Light;
    private (double w, double h)? _sizeOverride;
    private FrameworkElement? _designCanvasHost;

    /// <summary>Raised (UI thread) when the user picks an element in the mounted design surface.</summary>
    public event Action<DesignSelectionPayload>? SelectionChanged;

    /// <summary>Raised (UI thread) after a live property edit re-reads the selected element (Phase C).</summary>
    public event Action<DesignSelectionPayload>? PropsRefreshed;

    // Supersample bounds for the output frame. We render the tree at canvasDIP × outputScale so the
    // webview can display the frame at its logical DIP size and stay crisp on a HiDPI display. 1.0 =
    // never below logical size; 2.0 covers the common 125–200% display range without ballooning frame
    // size. The client requests a scale (its devicePixelRatio); we clamp it here.
    private const double MinOutputScale = 1.0;
    private const double MaxOutputScale = 2.0;

    /// <summary>DPI scale of the render window (physical px per DIP), e.g. 1.25 at 125%.</summary>
    public double DpiScale => _dpiScale;

    /// <summary>
    /// Stands up the persistent anchor + reusable render windows. Must run on the UI thread.
    /// </summary>
    public void Initialize()
    {
        // Anchor: sole purpose is to keep the Application message loop alive for the entire
        // server lifetime, independent of anything we do to the render window.
        _anchor = new Window();
        var anchorHwnd = Win32Interop.GetWindowFromWindowId(_anchor.AppWindow.Id);
        _anchor.AppWindow.IsShownInSwitchers = false;
        SetToolWindowStyle(anchorHwnd);
        SetCloaked(anchorHwnd, true);
        _anchor.AppWindow.Move(new PointInt32(-32000, -32000));
        _anchor.Activate();

        // Reusable render window: cloaked + parked off-screen, activated once, kept warm.
        _renderWindow = new Window();
        var renderHwnd = Win32Interop.GetWindowFromWindowId(_renderWindow.AppWindow.Id);
        _renderHwnd = renderHwnd;
        _renderWindow.AppWindow.IsShownInSwitchers = false;
        SetToolWindowStyle(renderHwnd);
        SetCloaked(renderHwnd, true);
        _dpiScale = GetDpiForWindow(renderHwnd) / 96.0;
        _renderWindow.AppWindow.Move(new PointInt32(-32000, -32000));
        _renderWindow.AppWindow.Resize(new SizeInt32(800, 600));
        _renderWindow.Activate();

        App.Log($"RenderHost ready (anchor + warm render window; dpiScale {_dpiScale:0.##}).");
    }

    /// <summary>
    /// The design-time XAML cleaning hook (S4 §10). Delegates to <see cref="XamlCleaner"/> to turn a
    /// real project document (with <c>x:Class</c>, <c>{x:Bind}</c>, event handlers, <c>d:</c>/<c>mc:</c>
    /// design attributes, …) into markup the runtime <c>XamlReader.Load</c> accepts. The application
    /// resource-scope keys (Layer 2) are passed through so the cleaner can distinguish a resolvable
    /// <c>{StaticResource}</c> from a genuinely-undefined one.
    /// </summary>
    internal static string CleanXaml(string xaml, ISet<string>? forcePlaceholderTypes = null) =>
        XamlCleaner.Clean(xaml, App.KnownResourceKeys, ProviderMapsFullName, forcePlaceholderTypes);

    /// <summary>
    /// Rule 7 (T2) predicate for <see cref="XamlCleaner"/>: true when the runtime provider chain that
    /// <see cref="XamlReader.Load"/> consults (<see cref="Application.Current"/>, which implements
    /// <see cref="IXamlMetadataProvider"/>) maps <paramref name="fullName"/>. Because this is the exact
    /// resolver <c>XamlReader.Load</c> uses, "not mapped" means "Load would fail with type-not-found",
    /// so the cleaner can safely substitute the unmappable element. A provider-mapped custom control
    /// (a user app's own control) returns true and is preserved so it renders for real.
    /// </summary>
    private static bool ProviderMapsFullName(string fullName)
    {
        try
        {
            return (Application.Current as IXamlMetadataProvider)?.GetXamlType(fullName) is not null;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Parses <paramref name="rawXaml"/> at runtime, hosts it in the warm off-screen window,
    /// and captures it to a JPEG at (contentDIP × <paramref name="scale"/>) pixels. Never
    /// throws for document problems — categorises them into a <see cref="RenderResult"/> with
    /// a <c>parse</c>/<c>activation</c>/<c>render</c> phase so the caller can report and keep
    /// serving. Must run on the UI thread.
    /// </summary>
    public async Task<RenderResult> RenderAsync(string rawXaml, double width, double height, double scale, RenderTimings? timings = null)
    {
        if (_renderWindow is null)
        {
            return RenderResult.Fail("render", "RenderHost not initialized.");
        }

        if (width <= 0) width = 800;
        if (height <= 0) height = 600;
        if (scale <= 0) scale = 1.0;

        long tTotal = Stopwatch.GetTimestamp();

        // ---------------- parse / activation phase ----------------
        var (root, phase, message, line, column) = TryParseRoot(rawXaml, timings);
        if (root is null)
        {
            // P1: a structurally non-designable root (ResourceDictionary, Window, VS template placeholder)
            // is reported as a DISTINCT NonPage status, not a generic failure, so the designer shows a
            // sensible message and an oracle need not count these non-pages as broken previews.
            return phase == NonPagePhase
                ? RenderResult.NonPage(message!)
                : RenderResult.Fail(phase!, message!, line, column);
        }

        // ---------------- render phase ----------------
        try
        {
            var result = await RenderElementAsync(root, width, height, scale, timings);
            if (timings is not null)
            {
                timings.TotalMs = ElapsedMs(tTotal);
                timings.FrameBytes = result.Image?.Length ?? 0;
            }
            return result;
        }
        catch (Exception ex)
        {
            App.Log($"Render error: {Flatten(ex)}");
            return RenderResult.Fail("render", Flatten(ex));
        }
        finally
        {
            // Release the user's tree from the warm window so it doesn't linger between frames.
            _renderWindow.Content = null;
        }
    }

    /// <summary>
    /// Extract the root <c>x:Class</c> (the CLR type name to activate in live mode) from raw project
    /// markup. Returns null when absent — e.g. a loose markup snippet with no code-behind — so the caller
    /// uses the parse path. Defensive: any failure yields null.
    /// </summary>
    private static string? TryGetXClass(string rawXaml)
    {
        if (string.IsNullOrEmpty(rawXaml)) return null;
        try
        {
            var m = Regex.Match(rawXaml, "x:Class\\s*=\\s*\"([^\"]+)\"");
            return m.Success ? m.Groups[1].Value.Trim() : null;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Shared design-time parse: clean the markup then <see cref="XamlReader.Load"/> it, categorising
    /// any failure into a <c>(phase, message, line, column)</c> exactly as the render path reports it.
    /// Returns a non-null <c>root</c> on success; otherwise the phase/message describe the failure.
    /// Used by both the image path (<see cref="RenderAsync"/>) and the native path
    /// (<see cref="HostLiveAsync"/>) so their error semantics stay identical.
    /// </summary>
    private (FrameworkElement? root, string? phase, string? message, int? line, int? column) TryParseRoot(
        string rawXaml, RenderTimings? timings = null)
    {
        try
        {
            // P1 (non-page classification): a structurally non-designable root — a ResourceDictionary
            // (styles/themes/control-template dictionary), a Window/WindowEx (a window is not a page), or a
            // Visual Studio project-template placeholder ($safeprojectname$, never a resolvable type) — is
            // not a broken preview, it is simply not a designable page. Detect it from the markup up front
            // and return a DISTINCT NonPage status so the designer shows a sensible message and an oracle
            // stops scoring these as failures. Cheap + defensive; fires ONLY on non-visual roots, so every
            // real Page/UserControl/Control is completely unaffected (certified default path untouched).
            var nonPageReason = ClassifyNonDesignableMarkup(rawXaml);
            if (nonPageReason is not null)
            {
                App.Log($"NONPAGE: {nonPageReason}");
                return (null, NonPagePhase, nonPageReason, null, null);
            }

            // LIVE MODE (spike, env SURFACE_LIVE_MODE=1): before the parse path, try to instantiate the
            // real x:Class type from the user assembly. That runs the genuine compiled
            // InitializeComponent()/Connect(), so {x:Bind} bindings and code-behind state come alive —
            // impossible via XamlReader.Load (which strips x:Bind). Any failure (no x:Class, missing type,
            // no parameterless ctor, ctor threw) logs LIVE-FALLBACK and drops through to the parse path, so
            // live mode can only ever ADD fidelity, never regress a page that already rendered.
            if (App.LiveModeEnabled)
            {
                var xClass = TryGetXClass(rawXaml);
                if (!string.IsNullOrEmpty(xClass))
                {
                    long tLive = Stopwatch.GetTimestamp();
                    var live = App.ActivatePage(xClass!, out var liveReason);
                    if (live is not null)
                    {
                        if (timings is not null) timings.ParseMs = ElapsedMs(tLive);
                        App.Log($"LIVE-OK: activated {xClass}");

                        // §51 M3: OPPORTUNISTIC REFLECTION FALLBACK (opt-in env SURFACE_DTD_REFLECT=1). For a
                        // page that opts into neither d:DesignData (M1) nor the DesignMode contract (M2), best-
                        // effort populate its empty x:Bind-backed collections with a bounded sample dataset so
                        // an otherwise-BLANK live page shows content. Live-only + explicit opt-in + never
                        // throws → it can never touch the certified default parse path or regress this render.
                        if (App.ReflectionFallbackEnabled)
                        {
                            try { DesignDataInjector.TryPopulate(live); }
                            catch (Exception dex) { App.Log($"DTD-INJECT threw {dex.GetType().Name}: {dex.Message}"); }
                        }

                        return (live, null, null, null, null);
                    }

                    App.Log($"LIVE-FALLBACK: {xClass} — {liveReason}");
                }
                else
                {
                    App.Log("LIVE-FALLBACK: (document has no x:Class) — using parse path");
                }
            }

            long tClean = Stopwatch.GetTimestamp();

            // Layer 2 (T2) instantiation-throw safety net. If a RESOLVED control throws in its
            // constructor at XamlReader.Load (hardware access, heavy DI, a bad .xbf, …), identify it,
            // force it to a placeholder, and re-clean + retry — so one throwing control does not fail the
            // whole page. Also recovers a "type 'X' was not found" that survived Rule 7 (the provider
            // claimed to map it but Load could not construct it) by placeholdering X. Bounded so a
            // pathological page cannot loop; hanging constructors are avoided earlier by the cleaner's
            // pre-swap list (a hang can never reach a catch).
            HashSet<string>? forced = null;
            const int maxSafetyNetRetries = 5;
            for (int attempt = 0; ; attempt++)
            {
                var xaml = CleanXaml(rawXaml, forced);
                if (attempt == 0 && timings is not null) timings.CleanMs = ElapsedMs(tClean);

                object? parsed;
                long tParse = Stopwatch.GetTimestamp();
                try
                {
                    parsed = XamlReader.Load(xaml);
                }
                catch (Exception ex)
                {
                    // Runs BEFORE the parse/activation split because WinUI sometimes wraps a constructor
                    // throw (or a late type-resolution failure) in a XamlParseException. Only a
                    // recoverable offender we have not already retired triggers a retry.
                    var offender = ExtractRecoverableOffender(ex);
                    if (attempt < maxSafetyNetRetries && offender is not null &&
                        (forced ??= new(StringComparer.Ordinal)).Add(offender))
                    {
                        App.Log($"SAFETY-NET: '{offender}' failed at Load — placeholdering and retrying.");
                        continue;
                    }

                    var (l, c) = ExtractLineColumn(ex);
                    if (IsParseException(ex))
                    {
                        App.Log($"Render parse error: {Flatten(ex)}");
                        return (null, "parse", Flatten(ex), l, c);
                    }

                    // A non-markup exception means a type resolved but failed to activate.
                    App.Log($"Render activation error: {Flatten(ex)}");
                    return (null, "activation", Flatten(ex), l, c);
                }

                if (timings is not null) timings.ParseMs = ElapsedMs(tParse);

                if (parsed is not FrameworkElement fe)
                {
                    // P1 backstop: a parsed non-FrameworkElement root (ResourceDictionary/Window/Application)
                    // is not a designable page. Classify it distinctly rather than as a generic render error.
                    string reason = parsed switch
                    {
                        ResourceDictionary rd =>
                            $"ResourceDictionary ({rd.Count} resource(s), {rd.MergedDictionaries.Count} merged) is not a designable page.",
                        Window => "Window root is not a designable page — the preview hosts Pages/UserControls/Controls.",
                        Application => "Application root is not a designable page.",
                        null => "Parsed root is null (empty markup).",
                        _ => $"Parsed root is '{parsed.GetType().FullName}', not a designable page.",
                    };
                    return (null, NonPagePhase, reason, null, null);
                }

                // §51 M1: honor the Blend design namespace's d:DataContext (d:DesignInstance / d:DesignData)
                // so a classic {Binding} page renders real sample data. Runs ONLY on the parse path (live mode
                // already gets the real runtime DataContext from the activated page's code-behind), and never
                // throws — a bad design hint can only fail to add data, never fail an otherwise-good render.
                ApplyDesignTimeData(fe, rawXaml);

                return (fe, null, null, null, null);
            }
        }
        catch (Exception ex)
        {
            return (null, "parse", Flatten(ex), null, null);
        }
    }

    /// <summary>
    /// P1: the phase string that marks a <see cref="RenderResult"/>/<see cref="LiveResult"/> as a
    /// structurally non-designable root (ResourceDictionary/Window/template placeholder) rather than a
    /// broken preview — distinct from the "parse"/"activation"/"render" failure phases.
    /// </summary>
    internal const string NonPagePhase = "nonpage";

    /// <summary>
    /// P1 (non-page classification): recognise a root that is not a designable page directly from the
    /// markup, before any activation or parse attempt. Returns a human-readable reason, or null when the
    /// root looks like a real page. Handles the three non-page families the gallery corpus surfaces:
    /// <list type="bullet">
    /// <item>Visual Studio project-template placeholders (<c>$safeprojectname$</c>): the token is never a
    /// resolvable CLR type, so the file is a template stub, not a page.</item>
    /// <item><c>Window</c>/<c>WindowEx</c> roots: a window is not a designable page (the host mounts
    /// pages/controls into its own window).</item>
    /// <item><c>ResourceDictionary</c> roots (styles, themes, control-template dictionaries): a resource
    /// dictionary has no visual root. Caught here (not just post-parse) so a dictionary whose templates
    /// reference unresolvable types is still classified as a non-page rather than a parse error.</item>
    /// </list>
    /// Cheap and fully defensive — any failure returns null (fall through to the normal parse path).
    /// </summary>
    private static string? ClassifyNonDesignableMarkup(string rawXaml)
    {
        if (string.IsNullOrWhiteSpace(rawXaml)) return null;
        try
        {
            if (rawXaml.Contains("$safeprojectname$", StringComparison.Ordinal) ||
                rawXaml.Contains("$ext_safeprojectname$", StringComparison.Ordinal))
            {
                return "type not found — Visual Studio project-template placeholder ($safeprojectname$), not a real page.";
            }

            var root = RootElementLocalName(rawXaml);
            return root switch
            {
                "ResourceDictionary" =>
                    "ResourceDictionary is not a designable page (a styles/themes/control-template dictionary has no visual root).",
                "Window" or "WindowEx" or "DesktopAcrylicWindow" =>
                    $"Window root ('{root}') is not a designable page — the preview hosts Pages/UserControls/Controls.",
                "Application" =>
                    "Application root is not a designable page.",
                _ => null,
            };
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Best-effort local name of the first real XAML element (skipping the XML declaration, comments and
    /// whitespace), stripped of any namespace prefix. Used only by <see cref="ClassifyNonDesignableMarkup"/>.
    /// </summary>
    private static string? RootElementLocalName(string rawXaml)
    {
        // Drop comments so a "<Foo>" inside a comment can't be mistaken for the root element.
        var stripped = Regex.Replace(rawXaml, "<!--.*?-->", " ", RegexOptions.Singleline);
        var m = Regex.Match(stripped, @"<\s*(?:[\w.]+:)?(?<name>[\w]+)[\s/>]");
        return m.Success ? m.Groups["name"].Value : null;
    }

    /// <summary>
    /// §51 M1: recover the design-time DataContext the cleaner strips (<c>d:DataContext</c> with
    /// <c>{d:DesignInstance}</c>/<c>{d:DesignData}</c>) and assign it to the freshly-parsed root so classic
    /// <c>{Binding}</c> resolves to sample data. Fully defensive — any failure leaves the DataContext unset.
    /// </summary>
    private static void ApplyDesignTimeData(FrameworkElement fe, string rawXaml)
    {
        try
        {
            var spec = DesignTimeData.ExtractRootSpec(rawXaml);
            if (spec is null)
            {
                return;
            }

            string? baseDir = null;
            try
            {
                if (!string.IsNullOrEmpty(Program.UserDllPath))
                {
                    baseDir = Path.GetDirectoryName(Program.UserDllPath);
                }
            }
            catch
            {
                // ignore — baseDir stays null, DesignData falls back to the process base directory
            }

            DesignTimeData.Apply(fe, spec, baseDir);
        }
        catch (Exception ex)
        {
            App.Log($"DTD: hook failed: {ex.GetType().Name}: {ex.Message}");
        }
    }

    // Fixed default design canvas (DIP) used when the parsed root declares no explicit/design size.
    // A Page/UserControl normally derives its size from the window/frame; headless we pick a sensible
    // design surface rather than stretching to the client's webview viewport.
    private const double DefaultCanvasWidthDip = 1024;
    private const double DefaultCanvasHeightDip = 720;

    /// <summary>One-time guard so the resolved design-canvas background brush is logged once, not per render.</summary>
    private static bool _canvasBrushLogged;

    private async Task<RenderResult> RenderElementAsync(FrameworkElement root, double width, double height, double scale, RenderTimings? timings)
    {
        var window = _renderWindow!;

        // ---------------- design-canvas sizing ----------------
        // The incoming width/height is the webview PANEL size, not a design size: it is only a
        // non-authoritative hint here (the webview rescales the JPEG to fit its panel), so we do NOT
        // stretch the canvas to it. Honor an explicit page size when present (Width/Height, which the
        // cleaner also derives from d:DesignWidth/d:DesignHeight); otherwise render on the fixed
        // default design canvas so content doesn't float or depend on panel size.
        var (canvasW, canvasH) = ResolveCanvasSize(root);

        // Wrap the parsed root in a themed host canvas: a Light-theme surface painted with a real,
        // opaque page background so a transparent Page/UserControl doesn't capture as black. The user
        // root is a child ON TOP of the canvas, so a page that sets its own Background still wins.
        var host = BuildDesignCanvas(root, canvasW, canvasH, _currentTheme);

        // ---------------- layout phase ----------------
        long tLayout = Stopwatch.GetTimestamp();

        // Size the window client area to the design canvas so the host lays out at full size.
        window.AppWindow.Resize(new SizeInt32(
            (int)Math.Ceiling(canvasW * _dpiScale) + 16,
            (int)Math.Ceiling(canvasH * _dpiScale) + 16));

        window.Content = host;

        // Let the tree load, then let layout + a few compositor frames settle.
        await WaitForLoadedAsync(host, timeoutMs: 4000);
        host.UpdateLayout();
        await PumpFramesAsync(4);

        // P3 (coverage hardening): stop self-perpetuating UI-thread churn (auto-advance DispatcherTimers,
        // forever-storyboards) so animation/nav pages settle to a representative frame instead of timing out.
        // OPT-IN ONLY (SURFACE_RENDER_SETTLE=1): the sweep walks the live tree, and that extra UI-thread work
        // can shift frame-capture timing on pages that already render fine, so it never runs on the certified
        // default (leg A) path. When enabled, one more short pump lets the now-quiet tree reach a stable frame.
        if (App.RenderSettleEnabled)
        {
            RenderSettle.Quiesce(root, App.Log);
            await PumpFramesAsync(2);
        }

        if (timings is not null) timings.LayoutMs = ElapsedMs(tLayout);

        // ---------------- capture phase ----------------
        // Supersample: render the tree at the requested output density (canvas DIP × outputScale) so
        // text and edges stay crisp when the webview displays the frame at its logical DIP size on a
        // HiDPI display. The sized RenderAsync overload re-rasterizes the visual at the target pixel
        // size (true supersample), independent of the render window's own monitor DPI.
        double outputScale = Math.Clamp(scale <= 0 ? 1.0 : scale, MinOutputScale, MaxOutputScale);
        int superW = Math.Max(1, (int)Math.Ceiling(canvasW * outputScale));
        int superH = Math.Max(1, (int)Math.Ceiling(canvasH * outputScale));

        // Capture the HOST (not the user root) so the themed background + Light theme are in-frame.
        long tCapture = Stopwatch.GetTimestamp();
        var (pixels, srcW, srcH) = await CaptureRtbAsync(host, superW, superH, timings);
        if (srcW <= 0 || srcH <= 0)
        {
            return RenderResult.Fail("render", $"RenderTargetBitmap produced an empty {srcW}x{srcH} bitmap.");
        }
        if (timings is not null) timings.CaptureMs = ElapsedMs(tCapture);

        // ---------------- encode phase ----------------
        // Encode losslessly (PNG) at the captured supersampled size — no chroma subsampling or lossy
        // ringing around text/edges, and no downscale here (the webview shows it at the logical DIP
        // size, mapping the dense pixels 1:1 to device pixels).
        int dipW = Math.Max(1, (int)Math.Round(canvasW));
        int dipH = Math.Max(1, (int)Math.Round(canvasH));
        long tEncode = Stopwatch.GetTimestamp();
        var png = await EncodePngAsync(pixels, srcW, srcH);
        if (timings is not null) timings.EncodeMs = ElapsedMs(tEncode);

        // Skip the per-render log on the benchmark path (timings != null) so its file I/O never
        // lands inside a timed region and the ≥40-iteration loop stays quiet.
        if (timings is null)
        {
            App.Log($"    rendered {srcW}x{srcH} px (canvas {dipW}x{dipH} dip, output scale {outputScale:0.##}), {png.Length} bytes PNG");
        }
        return RenderResult.Ok(png, srcW, srcH, dipW, dipH);
    }

    /// <summary>
    /// Chooses the design-canvas size (DIP). Honors an explicit root <see cref="FrameworkElement.Width"/>/
    /// <see cref="FrameworkElement.Height"/> (the cleaner maps <c>d:DesignWidth</c>/<c>d:DesignHeight</c>
    /// onto these) so a page renders at its own size; each dimension that is unset falls back to the
    /// fixed default canvas. The incoming client viewport is intentionally ignored.
    /// </summary>
    private (double width, double height) ResolveCanvasSize(FrameworkElement root)
    {
        // A device-size preset (SetCanvasSize) wins over the page's own size so adaptive layouts can be
        // previewed at a fixed artboard; null falls through to the page's Width/Height or the default canvas.
        if (_sizeOverride is { } o && o.w > 0 && o.h > 0)
        {
            return (o.w, o.h);
        }
        double w = (!double.IsNaN(root.Width) && root.Width > 0) ? root.Width : DefaultCanvasWidthDip;
        double h = (!double.IsNaN(root.Height) && root.Height > 0) ? root.Height : DefaultCanvasHeightDip;
        return (w, h);
    }

    /// <summary>
    /// Builds the themed host canvas: a <see cref="Grid"/> forced to <paramref name="theme"/> and filled
    /// with the app page background — <c>ApplicationPageBackgroundThemeBrush</c> resolved for that theme,
    /// with a modern WinUI opaque page brush and finally a neutral as fallbacks. The user root is added as a
    /// child (default Stretch alignment) so it lays out on top of the canvas, centered when it declares an
    /// intrinsic size; a root that sets its own Background paints over it.
    /// </summary>
    private static Grid BuildDesignCanvas(FrameworkElement root, double width, double height, ElementTheme theme)
    {
        // Build via markup so the {ThemeResource} background resolves against the host's OWN RequestedTheme
        // (rather than the app/OS theme) — Light by default, or the user-chosen preview theme. Try the
        // requested legacy brush first, then the modern WinUI 3 opaque page brush, then a literal neutral.
        string source = "ApplicationPageBackgroundThemeBrush";
        Grid? host = TryBuildThemedCanvas(source, theme);
        if (host is null) { source = "SolidBackgroundFillColorBaseBrush"; host = TryBuildThemedCanvas(source, theme); }
        if (host is null)
        {
            source = "neutral (literal fallback)";
            host = new Grid
            {
                RequestedTheme = theme,
                Background = new SolidColorBrush(theme == ElementTheme.Dark
                    ? Windows.UI.Color.FromArgb(0xFF, 0x20, 0x20, 0x20)
                    : Microsoft.UI.Colors.WhiteSmoke),
            };
        }

        if (!_canvasBrushLogged)
        {
            _canvasBrushLogged = true;
            App.Log($"Design-canvas background brush: {source} ({theme} theme).");
        }

        host.RequestedTheme = theme;
        host.Width = width;
        host.Height = height;
        // Anchor the fixed-size canvas top-left. In the image path the window is sized exactly to the
        // canvas so this is a no-op, but in the native path the client resizes the reparented window to
        // fill the tool-window pane; top-left anchoring then yields a natural 1:1 viewport onto the
        // canvas (page origin at the pane's top-left, overflow clipped) rather than a centered crop.
        host.HorizontalAlignment = HorizontalAlignment.Left;
        host.VerticalAlignment = VerticalAlignment.Top;
        host.Children.Add(root);
        return host;
    }

    /// <summary>
    /// Attempts to build a <paramref name="theme"/>-themed <see cref="Grid"/> whose Background is
    /// <c>{ThemeResource <paramref name="themeBrushKey"/>}</c>. Returns null if the key doesn't resolve
    /// (the caller then tries the next fallback).
    /// </summary>
    private static Grid? TryBuildThemedCanvas(string themeBrushKey, ElementTheme theme)
    {
        try
        {
            var host = (Grid)XamlReader.Load(
                "<Grid xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" " +
                $"RequestedTheme=\"{theme}\" " +
                $"Background=\"{{ThemeResource {themeBrushKey}}}\" />");
            return host.Background is null ? null : host;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// The default live-path capture: <see cref="RenderTargetBitmap"/> renders the element at the
    /// window's rasterization (DPI) scale, then <see cref="RenderTargetBitmap.GetPixelsAsync"/> reads
    /// the composed pixels back GPU→CPU. Rendered twice because the first pass on freshly-shown
    /// content can occasionally return empty.
    /// </summary>
    private async Task<(byte[] pixels, int width, int height)> CaptureRtbAsync(FrameworkElement root, int targetW, int targetH, RenderTimings? timings = null)
    {
        var rtb = new RenderTargetBitmap();

        long t = Stopwatch.GetTimestamp();
        await rtb.RenderAsync(root, targetW, targetH);
        if (timings is not null) timings.CaptureRender1Ms = ElapsedMs(t);

        t = Stopwatch.GetTimestamp();
        await PumpFramesAsync(1);
        if (timings is not null) timings.CaptureSettleMs = ElapsedMs(t);

        t = Stopwatch.GetTimestamp();
        await rtb.RenderAsync(root, targetW, targetH);
        if (timings is not null) timings.CaptureRender2Ms = ElapsedMs(t);

        int srcW = rtb.PixelWidth;
        int srcH = rtb.PixelHeight;
        if (srcW <= 0 || srcH <= 0)
        {
            return (Array.Empty<byte>(), srcW, srcH);
        }

        t = Stopwatch.GetTimestamp();
        var pixels = (await rtb.GetPixelsAsync()).ToArray();
        if (timings is not null) timings.CaptureReadbackMs = ElapsedMs(t);
        return (pixels, srcW, srcH);
    }

    /// <summary>High-resolution elapsed milliseconds since a <see cref="Stopwatch.GetTimestamp"/> tick.</summary>
    internal static double ElapsedMs(long startTicks) =>
        (Stopwatch.GetTimestamp() - startTicks) * 1000.0 / Stopwatch.Frequency;

    // ---- S5 Part 2: Windows.Graphics.Capture (WGC) probe support ---------------------------
    // These hooks let the --wgc benchmark attempt a DXGI/DWM screen-capture path against the SAME
    // warm render window the RTB path uses, and toggle the window state (cloak / on-screen) that
    // WGC composition may require. RTB stays the default live-path capture regardless.

    /// <summary>
    /// The warm render window's top-level HWND — what WGC's <c>CreateForWindow</c> needs, and what the
    /// native reparent path hands to the IDE client. Uses the value cached at creation so it stays valid
    /// even after the client turns the window into a <c>WS_CHILD</c> (which nulls <c>Window.AppWindow</c>).
    /// </summary>
    internal IntPtr RenderWindowHwnd =>
        _renderHwnd != IntPtr.Zero
            ? _renderHwnd
            : (_renderWindow is null ? IntPtr.Zero : Win32Interop.GetWindowFromWindowId(_renderWindow.AppWindow.Id));

    /// <summary>Toggle the render window's DWM cloak (Part 2 tests whether WGC can capture it cloaked).</summary>
    internal void SetRenderWindowCloaked(bool cloaked)
    {
        if (_renderWindow is not null) SetCloaked(RenderWindowHwnd, cloaked);
    }

    /// <summary>Move the render window (tests off-screen vs on-screen WGC composition).</summary>
    internal void MoveRenderWindow(int x, int y) =>
        _renderWindow?.AppWindow.Move(new PointInt32(x, y));

    /// <summary>
    /// Parse + host <paramref name="rawXaml"/> in the warm window and settle layout, but — unlike
    /// <see cref="RenderAsync"/> — LEAVE the content mounted so an external capturer (WGC) can compose
    /// and grab it. Returns the mounted root (or null on parse/type failure).
    /// </summary>
    internal async Task<FrameworkElement?> HostContentAsync(string rawXaml, double width, double height)
    {
        if (_renderWindow is null) return null;
        if (width <= 0) width = 800;
        if (height <= 0) height = 600;

        FrameworkElement root;
        try
        {
            var xaml = CleanXaml(rawXaml);
            if (XamlReader.Load(xaml) is not FrameworkElement fe) return null;
            root = fe;
        }
        catch { return null; }

        _renderWindow.AppWindow.Resize(new SizeInt32(
            (int)Math.Ceiling(width * _dpiScale) + 16,
            (int)Math.Ceiling(height * _dpiScale) + 16));
        _renderWindow.Content = root;
        await WaitForLoadedAsync(root, timeoutMs: 4000);
        root.UpdateLayout();
        await PumpFramesAsync(4);
        return root;
    }

    /// <summary>
    /// RTB-capture the currently-hosted <paramref name="root"/> (single settled pass + readback) for
    /// an apples-to-apples comparison against WGC while the SAME content stays mounted. Returns raw
    /// BGRA8 pixels plus the render-pass and GPU→CPU readback sub-timings.
    /// </summary>
    internal async Task<(byte[] pixels, int width, int height, double renderMs, double readbackMs)> CaptureHostedRtbAsync(FrameworkElement root)
    {
        var rtb = new RenderTargetBitmap();
        long t = Stopwatch.GetTimestamp();
        await rtb.RenderAsync(root);
        double renderMs = ElapsedMs(t);
        int w = rtb.PixelWidth, h = rtb.PixelHeight;
        if (w <= 0 || h <= 0) return (Array.Empty<byte>(), w, h, renderMs, 0);
        t = Stopwatch.GetTimestamp();
        var pixels = (await rtb.GetPixelsAsync()).ToArray();
        double readbackMs = ElapsedMs(t);
        return (pixels, w, h, renderMs, readbackMs);
    }

    /// <summary>Encode BGRA8 pixels to JPEG with the same encoder as the live path (WGC/RTB encode parity).</summary>
    internal static Task<byte[]> EncodeJpegPublicAsync(byte[] bgra, int width, int height) =>
        EncodeJpegAsync(bgra, width, height, width, height);

    /// <summary>Unmount whatever is hosted (restore the between-frames idle state).</summary>
    internal void ClearRenderContent()
    {
        _design = null;
        if (_renderWindow is not null) _renderWindow.Content = null;
    }

    /// <summary>
    /// Toggle design (select) vs interact mode for the mounted design surface (plan §41). Design mode
    /// intercepts pointer input so a click selects an element; interact mode passes input to the live
    /// content. Persisted on the host so the next re-host keeps the mode. UI thread only.
    /// </summary>
    internal void SetDesignMode(bool on)
    {
        _designMode = on;
        if (_design is not null)
        {
            _design.DesignMode = on;
        }
    }

    /// <summary>
    /// Pin the design canvas to a device-size preset (or <c>null</c> to restore auto — the page's own size /
    /// default canvas). Stored for the next (re)host; the caller re-hosts so the design surface re-fits the
    /// new board into the pane. UI thread only.
    /// </summary>
    internal void SetCanvasSizeOverride((double w, double h)? size)
    {
        _sizeOverride = size is { } s && s.w > 0 && s.h > 0 ? size : null;
    }

    /// <summary>
    /// Select the element at an authored-tree path in the mounted design surface (editor caret -> designer,
    /// plan §41 #2). No-op returning false when no design surface is mounted or the path doesn't resolve.
    /// UI thread only.
    /// </summary>
    internal bool SelectByPath(string? path) => _design?.SelectByPath(path) ?? false;

    /// <summary>
    /// TEST-ONLY headless pick (bug D3 regression): run the mounted design surface's pointer-pick logic at
    /// (<paramref name="x"/>, <paramref name="y"/>) in artboard/host DIP coordinates and report the usual
    /// selection. No-op returning false when no design surface is mounted. UI thread only.
    /// </summary>
    internal bool PickAt(double x, double y) => _design?.PickAt(x, y) ?? false;

    /// <summary>
    /// The custom (non-standard) content-property map for the mounted design surface's authored tree, keyed by
    /// simple type name (bug D1). Empty when no design surface is mounted. UI thread only.
    /// </summary>
    internal Dictionary<string, string> CollectContentProps() =>
        _design?.CollectContentProps() ?? new Dictionary<string, string>();

    /// <summary>Apply a live property edit to the element with the given id (Phase C). UI thread only.</summary>
    internal bool SetProperty(int id, string name, string value) => _design?.SetProperty(id, name, value) ?? false;

    private void OnDesignSelectionChanged(DesignSelectionPayload payload) => SelectionChanged?.Invoke(payload);

    private void OnDesignPropsRefreshed(DesignSelectionPayload payload) => PropsRefreshed?.Invoke(payload);

    // ---- Phase B: native HWND reparent (live design surface) ----------------
    // Instead of RTB→PNG→socket, host the parsed page LIVE in the warm window and hand its HWND to
    // the IDE client, which SetParent()s it into a tool window (zero-copy, real WinUI pixels + input).
    // devenv is .NET-Framework/WPF and cannot load WinUI 3 in-proc, so out-of-proc + reparent is the
    // only native path (mirrors Reactor's cross-process SetParent). The window is sized to the design
    // canvas (surface DPI); the client owns its on-screen placement as a WS_CHILD.

    /// <summary>
    /// Parse + host <paramref name="rawXaml"/> LIVE in the warm window (wrapped in the same themed
    /// Light-theme design canvas as the image path) and leave it mounted so a client can reparent
    /// <see cref="RenderWindowHwnd"/>. When <paramref name="prepareWindow"/> is true (first entry) the
    /// window is stripped of its border/title bar and un-cloaked; on subsequent live updates it is left
    /// as the client positioned it. No capture/encode — the pixels stay on the GPU-composed window.
    /// </summary>
    internal async Task<LiveResult> HostLiveAsync(string rawXaml, bool prepareWindow)
    {
        if (_renderWindow is null)
        {
            return LiveResult.Fail("render", "RenderHost not initialized.");
        }

        var (root, phase, message, line, column) = TryParseRoot(rawXaml);
        if (root is null)
        {
            // P1: surface a non-designable root (ResourceDictionary/Window/template placeholder) distinctly.
            return phase == NonPagePhase
                ? LiveResult.NonPage(message!)
                : LiveResult.Fail(phase!, message!, line, column);
        }

        try
        {
            var window = _renderWindow;
            var (canvasW, canvasH) = ResolveCanvasSize(root);
            // Build the native design canvas at the app-default (neutral) theme; the preview theme is applied
            // as a post-mount CHANGE on the artboard below (see the theme flip after PumpFramesAsync) so
            // {ThemeResource} brushes actually re-resolve. Baking a non-default theme here would leave the
            // content at the default anyway (RequestedTheme set before tree entry doesn't re-resolve).
            var host = BuildDesignCanvas(root, canvasW, canvasH, ElementTheme.Default);
            _designCanvasHost = host;

            // Size the window client area to the design canvas at surface DPI. The client sizes the
            // child to match (pixelWidth/pixelHeight below) so native pixels map 1:1.
            int pixelW = Math.Max(1, (int)Math.Ceiling(canvasW * _dpiScale));
            int pixelH = Math.Max(1, (int)Math.Ceiling(canvasH * _dpiScale));

            if (prepareWindow)
            {
                // First entry: the window is still a normal top-level, so AppWindow APIs apply.
                PrepareRenderWindowForReparent();
                window.AppWindow.Resize(new SizeInt32(pixelW, pixelH));
            }
            // else: live re-host of an already-reparented window. It is now a WS_CHILD whose geometry is
            // owned by the client/WPF parent — Window.AppWindow is null (Resize would NRE) and a
            // MoveWindow(0,0) here would yank the child to the parent's top-left, fighting WPF's layout.
            // So we touch no geometry: just re-mount content. The client resizes the child itself when the
            // canvas size changed, using the pixelWidth/pixelHeight in the Hwnd reply below.

            // Native path: mount the fixed-size canvas inside the design surface (plan §41) — a zoom-to-fit
            // Viewbox on a neutral-gray artboard, wrapped with the selection/hover adorner + input overlay.
            // The client resizes the reparented child to fill the tool-window pane (a native HWND can't
            // clip/scroll inside a WPF region — see PreviewControl.xaml), so the Viewbox scales the whole
            // fixed canvas to fit the pane: Uniform + DownOnly = zoom-to-fit that shrinks a too-big page to
            // fit but never upscales past 100%, re-fitting automatically on every pane resize. In design mode
            // the overlay intercepts input for selection; in interact mode it is collapsed so input reaches
            // the live content.
            var design = new DesignSurface(host, Windows.UI.Color.FromArgb(0xFF, 0x3C, 0x3C, 0x3C))
            {
                DesignMode = _designMode,
            };
            design.SelectionChanged += OnDesignSelectionChanged;
            design.PropsRefreshed += OnDesignPropsRefreshed;
            _design = design;
            window.Content = design.Root;
            host.UpdateLayout();
            await PumpFramesAsync(4);

            // P3 (coverage hardening): quiesce self-perpetuating churn on the live-hosted page too, so an
            // auto-advancing/animating page settles in the native design surface instead of hanging the host.
            // OPT-IN ONLY (SURFACE_RENDER_SETTLE=1) — the tree-walk is extra UI-thread work that can perturb
            // an already-OK live page's capture timing, so the certified live path for the OK pages must not
            // run it by default. The mechanism stays proven via the smoke test, which sets the flag.
            if (App.RenderSettleEnabled)
            {
                RenderSettle.Quiesce(root, App.Log);
            }

            int dipW = Math.Max(1, (int)Math.Round(canvasW));
            int dipH = Math.Max(1, (int)Math.Round(canvasH));
            IntPtr hwnd = RenderWindowHwnd;
            App.Log($"    hosting live {dipW}x{dipH} dip ({pixelW}x{pixelH} px) in hwnd 0x{hwnd.ToInt64():X} (dpiScale {_dpiScale:0.##})");
            return LiveResult.Ok(hwnd, dipW, dipH, pixelW, pixelH, _dpiScale);
        }
        catch (Exception ex)
        {
            App.Log($"HostLive error: {ex}");
            return LiveResult.Fail("render", Flatten(ex));
        }
    }

    /// <summary>
    /// Make the warm render window ready to be reparented into a foreign (IDE) HWND: strip the title
    /// bar + border (so only the design canvas shows) and un-cloak it so DWM composes its pixels. The
    /// client then <c>SetParent()</c>s <see cref="RenderWindowHwnd"/> and applies <c>WS_CHILD</c>.
    /// </summary>
    internal void PrepareRenderWindowForReparent()
    {
        if (_renderWindow is null) return;
        if (_renderWindow.AppWindow.Presenter is OverlappedPresenter p)
        {
            p.SetBorderAndTitleBar(false, false);
            p.IsResizable = false;
            p.IsMaximizable = false;
            p.IsMinimizable = false;
        }
        // Un-cloak so DWM composes the window's pixels once the client makes it a WS_CHILD — but do NOT
        // bring it on-screen here. It stays parked off-screen (-32000) as a borderless top-level; the
        // client's SetParent + MoveWindow(0,0) pulls it straight into the tool window. Moving it to the
        // desktop origin first (as we used to) made a borderless window flash at the top-left corner for
        // the cross-process round-trip before the reparent landed.
        SetCloaked(RenderWindowHwnd, false);
    }

    /// <summary>Re-cloak + park the render window off-screen and clear its content (leave native mode).</summary>
    internal void RestoreRenderWindowOffscreen()
    {
        if (_renderWindow is null) return;
        _renderWindow.Content = null;
        SetCloaked(RenderWindowHwnd, true);
        // Re-detach from any foreign parent and drop WS_CHILD so this is a valid top-level window again
        // (AppWindow only works on top-level windows). The client normally SetParent(null)s on teardown,
        // but ordering isn't guaranteed, so do it here defensively before touching AppWindow.
        DetachFromParent();
        try
        {
            _renderWindow.AppWindow.Move(new PointInt32(-32000, -32000));
        }
        catch (Exception ex)
        {
            App.Log($"RestoreRenderWindowOffscreen: AppWindow.Move skipped ({ex.GetType().Name}); parking via Win32.");
            MoveWindow(RenderWindowHwnd, -32000, -32000, 800, 600, false);
        }
    }

    /// <summary>Ensure the render window is a normal top-level again: detach from any parent and strip
    /// <c>WS_CHILD</c> so <c>Window.AppWindow</c> resolves. Safe/no-op if it was never reparented.</summary>
    private void DetachFromParent()
    {
        IntPtr hwnd = RenderWindowHwnd;
        if (hwnd == IntPtr.Zero) return;
        if (GetParent(hwnd) != IntPtr.Zero)
        {
            SetParent(hwnd, IntPtr.Zero);
        }
        long style = GetWindowLongPtr(hwnd, GWL_STYLE).ToInt64();
        if ((style & WS_CHILD) != 0)
        {
            style &= ~WS_CHILD;
            SetWindowLongPtr(hwnd, GWL_STYLE, new IntPtr(style));
        }
    }

    /// <summary>
    /// Encode BGRA8 pixels to PNG (lossless) — the live-path encoder. No chroma subsampling or lossy
    /// ringing, so text and control edges stay clean. Pixels are already at the target size, so there
    /// is no resample here.
    /// </summary>
    private static async Task<byte[]> EncodePngAsync(byte[] bgraPixels, int width, int height)
    {
        var stream = new InMemoryRandomAccessStream();
        var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, stream);
        encoder.SetPixelData(
            BitmapPixelFormat.Bgra8,
            BitmapAlphaMode.Ignore,
            (uint)width,
            (uint)height,
            96,
            96,
            bgraPixels);

        await encoder.FlushAsync();

        var size = (uint)stream.Size;
        var reader = new DataReader(stream.GetInputStreamAt(0));
        await reader.LoadAsync(size);
        var outBytes = new byte[size];
        reader.ReadBytes(outBytes);
        return outBytes;
    }

    private static async Task<byte[]> EncodeJpegAsync(byte[] bgraPixels, int srcW, int srcH, int outW, int outH)
    {
        var stream = new InMemoryRandomAccessStream();
        var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.JpegEncoderId, stream);
        encoder.SetPixelData(
            BitmapPixelFormat.Bgra8,
            BitmapAlphaMode.Ignore,
            (uint)srcW,
            (uint)srcH,
            96,
            96,
            bgraPixels);

        if (outW != srcW || outH != srcH)
        {
            encoder.BitmapTransform.ScaledWidth = (uint)outW;
            encoder.BitmapTransform.ScaledHeight = (uint)outH;
            encoder.BitmapTransform.InterpolationMode = BitmapInterpolationMode.Fant;
        }

        await encoder.FlushAsync();

        var size = (uint)stream.Size;
        var reader = new DataReader(stream.GetInputStreamAt(0));
        await reader.LoadAsync(size);
        var outBytes = new byte[size];
        reader.ReadBytes(outBytes);
        return outBytes;
    }

    private static async Task WaitForLoadedAsync(FrameworkElement element, int timeoutMs)
    {
        if (element.IsLoaded)
        {
            return;
        }

        var tcs = new TaskCompletionSource();
        RoutedEventHandler? handler = null;
        handler = (_, _) =>
        {
            element.Loaded -= handler;
            tcs.TrySetResult();
        };
        element.Loaded += handler;

        // Safety net: never let a missed Loaded event wedge the server on one request.
        var completed = await Task.WhenAny(tcs.Task, Task.Delay(timeoutMs));
        if (completed != tcs.Task)
        {
            element.Loaded -= handler;
            App.Log("    (Loaded event timed out; capturing anyway)");
        }
    }

    /// <summary>
    /// Yields through low-priority dispatcher callbacks (with a small real delay) so pending
    /// layout and compositor work completes before capture.
    /// </summary>
    private async Task PumpFramesAsync(int frames)
    {
        for (int i = 0; i < frames; i++)
        {
            var tcs = new TaskCompletionSource();
            if (!_dispatcher.TryEnqueue(DispatcherQueuePriority.Low, () => tcs.TrySetResult()))
            {
                tcs.TrySetResult();
            }
            await tcs.Task;
            await Task.Delay(16); // ~1 frame @ 60Hz
        }
    }

    // ---- exception categorisation --------------------------------------------

    private static bool IsParseException(Exception ex)
    {
        for (var e = ex; e != null; e = e.InnerException)
        {
            if (e is XamlParseException || e is System.Xml.XmlException)
            {
                return true;
            }
        }
        return false;
    }

    // A constructor stack frame ("at Namespace.Type..ctor(") pinpoints a control that threw during
    // activation; a "type 'X' was not found" message pinpoints a type that survived Rule 7 but Load
    // could still not resolve. Either is recoverable by placeholdering that type and retrying.
    private static readonly Regex CtorFrameRegex =
        new(@"\bat\s+(?<full>[\w.]+)\.\.ctor\b", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex TypeNotFoundRegex =
        new(@"type '(?<full>[^']+)' was not found",
            RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>
    /// Returns the SIMPLE name of a control the Layer 2 safety net can retire — a constructor that threw
    /// (identified by a <c>..ctor</c> stack frame) or a type Rule 7 missed (a "type 'X' was not found"
    /// message) — so the cleaner's force-placeholder set can neutralise it on retry. Returns null when
    /// the failure is not recoverable that way (a pure markup / property error), leaving the normal
    /// parse/activation error path to report it. Inspects the innermost exception first so the actual
    /// throw site wins over the outer <c>XamlReader.Load</c> frames.
    /// </summary>
    private static string? ExtractRecoverableOffender(Exception ex)
    {
        var chain = new List<Exception>();
        for (Exception? e = ex; e is not null; e = e.InnerException)
        {
            chain.Add(e);
        }

        for (int i = chain.Count - 1; i >= 0; i--)
        {
            if (chain[i].StackTrace is string st)
            {
                var m = CtorFrameRegex.Match(st);
                if (m.Success)
                {
                    return SimpleName(m.Groups["full"].Value);
                }
            }
        }

        var nf = TypeNotFoundRegex.Match(ex.Message ?? string.Empty);
        return nf.Success ? SimpleName(nf.Groups["full"].Value) : null;

        static string SimpleName(string full)
        {
            int dot = full.LastIndexOf('.');
            return dot >= 0 ? full[(dot + 1)..] : full;
        }
    }

    private static (int? line, int? column) ExtractLineColumn(Exception ex)
    {
        for (var e = ex; e != null; e = e.InnerException)
        {
            if (e is System.Xml.XmlException xe && xe.LineNumber > 0)
            {
                return (xe.LineNumber, xe.LinePosition);
            }

            // WinUI's XamlParseException has no line/position properties, but its message
            // frequently embeds them, e.g. "... [Line: 1 Position: 7]".
            var msg = e.Message ?? string.Empty;
            var m = Regex.Match(msg, @"[Ll]ine\s*[:#]?\s*(\d+).*?[Pp]osition\s*[:#]?\s*(\d+)");
            if (m.Success &&
                int.TryParse(m.Groups[1].Value, out var line) &&
                int.TryParse(m.Groups[2].Value, out var col))
            {
                return (line, col);
            }
        }
        return (null, null);
    }

    private static string Flatten(Exception ex)
    {
        var sb = new StringBuilder();
        for (var e = ex; e != null; e = e.InnerException)
        {
            if (sb.Length > 0)
            {
                sb.Append(" -> ");
            }
            sb.Append(e.GetType().Name).Append(": ").Append(e.Message);
        }
        return sb.ToString();
    }

    // ---- Win32 / DWM interop -------------------------------------------------

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hwnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool MoveWindow(IntPtr hWnd, int x, int y, int width, int height, bool repaint);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetParent(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
    private static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
    private static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

    private const int GWL_STYLE = -16;
    private const int GWL_EXSTYLE = -20;
    private const long WS_CHILD = 0x40000000L;
    private const long WS_EX_TOOLWINDOW = 0x00000080L;
    private const long WS_EX_APPWINDOW = 0x00040000L;

    /// <summary>
    /// Force a window off the taskbar and Alt-Tab for good: add <c>WS_EX_TOOLWINDOW</c> and strip
    /// <c>WS_EX_APPWINDOW</c>. Belt-and-suspenders alongside <c>AppWindow.IsShownInSwitchers = false</c> —
    /// a cloaked top-level (our always-alive anchor, and the render window before it's reparented) can
    /// otherwise still own a taskbar button. A tool window never appears there.
    /// </summary>
    private static void SetToolWindowStyle(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return;
        long ex = GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64();
        ex |= WS_EX_TOOLWINDOW;
        ex &= ~WS_EX_APPWINDOW;
        SetWindowLongPtr(hwnd, GWL_EXSTYLE, new IntPtr(ex));
    }

    [DllImport("dwmapi.dll", PreserveSig = true)]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

    private const int DWMWA_CLOAK = 13;

    private static void SetCloaked(IntPtr hwnd, bool cloaked)
    {
        int value = cloaked ? 1 : 0;
        DwmSetWindowAttribute(hwnd, DWMWA_CLOAK, ref value, sizeof(int));
    }
}

/// <summary>
/// Per-stage wall-clock timings (milliseconds) for one render, plus the encoded frame size in
/// bytes. Populated by <see cref="RenderHost.RenderAsync"/> only when a caller supplies an
/// instance (the <c>--benchmark</c> path); the live server path passes null and pays no
/// measurement overhead beyond a handful of <see cref="Stopwatch.GetTimestamp"/> reads.
/// </summary>
internal sealed class RenderTimings
{
    /// <summary><see cref="XamlCleaner.Clean"/> — design-time markup cleanup.</summary>
    public double CleanMs { get; set; }
    /// <summary><see cref="XamlReader.Load"/> — runtime XAML parse + object activation.</summary>
    public double ParseMs { get; set; }
    /// <summary>Hosting in the warm window + waiting for first render (Loaded / UpdateLayout / dispatcher pumps).</summary>
    public double LayoutMs { get; set; }
    /// <summary><see cref="RenderTargetBitmap.RenderAsync"/> + GPU→CPU pixel readback (<see cref="RenderTargetBitmap.GetPixelsAsync"/>).</summary>
    public double CaptureMs { get; set; }
    /// <summary>Capture sub-stage: first <see cref="RenderTargetBitmap.RenderAsync"/> pass (freshly-shown content).</summary>
    public double CaptureRender1Ms { get; set; }
    /// <summary>Capture sub-stage: one dispatcher/compositor settle pump between the two render passes.</summary>
    public double CaptureSettleMs { get; set; }
    /// <summary>Capture sub-stage: second <see cref="RenderTargetBitmap.RenderAsync"/> pass.</summary>
    public double CaptureRender2Ms { get; set; }
    /// <summary>Capture sub-stage: GPU→CPU pixel readback (<see cref="RenderTargetBitmap.GetPixelsAsync"/>).</summary>
    public double CaptureReadbackMs { get; set; }
    /// <summary>JPEG <see cref="BitmapEncoder"/> set-pixels + flush.</summary>
    public double EncodeMs { get; set; }
    /// <summary>End-to-end: clean → encoded bytes ready.</summary>
    public double TotalMs { get; set; }
    /// <summary>Size of the encoded JPEG frame in bytes.</summary>
    public int FrameBytes { get; set; }
}

/// <summary>
/// Outcome of a render request: either a JPEG frame or a categorised failure. Value type,
/// immutable, safe to hand back across the dispatcher boundary to the socket writer.
/// </summary>
internal readonly struct RenderResult
{
    public bool Success { get; private init; }
    public byte[]? Image { get; private init; }
    public int Width { get; private init; }
    public int Height { get; private init; }
    public int DipWidth { get; private init; }
    public int DipHeight { get; private init; }
    public string? Phase { get; private init; }
    public string? Message { get; private init; }
    public int? Line { get; private init; }
    public int? Column { get; private init; }

    /// <summary>
    /// P1: true when the failure is a structurally non-designable root (ResourceDictionary/Window/template
    /// placeholder) rather than a broken preview — the caller/oracle can present it as "not a page", not an
    /// error. Always paired with <c>Phase == RenderHost.NonPagePhase</c> and a human-readable Message.
    /// </summary>
    public bool NotDesignable { get; private init; }

    public static RenderResult Ok(byte[] image, int width, int height, int dipWidth, int dipHeight) => new()
    {
        Success = true,
        Image = image,
        Width = width,
        Height = height,
        DipWidth = dipWidth,
        DipHeight = dipHeight,
    };

    public static RenderResult Fail(string phase, string message, int? line = null, int? column = null) => new()
    {
        Success = false,
        Phase = phase,
        Message = message,
        Line = line,
        Column = column,
    };

    public static RenderResult NonPage(string reason) => new()
    {
        Success = false,
        Phase = RenderHost.NonPagePhase,
        Message = reason,
        NotDesignable = true,
    };
}

/// <summary>
/// Outcome of a native live-host request (<see cref="RenderHost.HostLiveAsync"/>): either the HWND of
/// the warm window now hosting the live design canvas (for the client to reparent) plus its logical
/// (DIP) and device-pixel size, or a categorised failure sharing the render path's phase vocabulary.
/// </summary>
internal readonly struct LiveResult
{
    public bool Success { get; private init; }
    public IntPtr Hwnd { get; private init; }
    public int DipWidth { get; private init; }
    public int DipHeight { get; private init; }
    public int PixelWidth { get; private init; }
    public int PixelHeight { get; private init; }
    public double DpiScale { get; private init; }
    public string? Phase { get; private init; }
    public string? Message { get; private init; }
    public int? Line { get; private init; }
    public int? Column { get; private init; }

    /// <summary>P1: true for a structurally non-designable root (see <see cref="RenderResult.NotDesignable"/>).</summary>
    public bool NotDesignable { get; private init; }

    public static LiveResult Ok(IntPtr hwnd, int dipWidth, int dipHeight, int pixelWidth, int pixelHeight, double dpiScale) => new()
    {
        Success = true,
        Hwnd = hwnd,
        DipWidth = dipWidth,
        DipHeight = dipHeight,
        PixelWidth = pixelWidth,
        PixelHeight = pixelHeight,
        DpiScale = dpiScale,
    };

    public static LiveResult Fail(string phase, string message, int? line = null, int? column = null) => new()
    {
        Success = false,
        Phase = phase,
        Message = message,
        Line = line,
        Column = column,
    };

    public static LiveResult NonPage(string reason) => new()
    {
        Success = false,
        Phase = RenderHost.NonPagePhase,
        Message = reason,
        NotDesignable = true,
    };
}
