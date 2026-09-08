using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Runtime.ExceptionServices;
using System.Runtime.Loader;
using System.Threading;
using System.Threading.Tasks;
using System.Xml.Linq;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Markup;

namespace Surface;

/// <summary>
/// Custom entry point. There is no App.xaml in this project — the host is a pure
/// code Application so that <see cref="App"/> can own the
/// <see cref="IXamlMetadataProvider"/> implementation itself (the XAML compiler
/// would otherwise generate that implementation on the App partial and we could
/// not chain to the user assembly's provider).
/// </summary>
public static class Program
{
    internal static void Boot(string message)
    {
        try
        {
            File.AppendAllText(
                Path.Combine(Paths.SurfaceRoot, "boot.log"),
                DateTime.Now.ToString("HH:mm:ss.fff") + " " + message + Environment.NewLine);
        }
        catch { }
    }

    /// <summary>Path to the user assembly from <c>--user-dll &lt;path&gt;</c>, or null to use the default.</summary>
    internal static string? UserDllPath { get; private set; }

    /// <summary>
    /// Path to the user app's already-built merged <c>resources.pri</c> from <c>--user-pri &lt;path&gt;</c>,
    /// or null. When supplied it is staged as this host's primary resource map (see
    /// <see cref="StageUserPri"/>) so <c>ms-appx:///</c> lookups for third-party component templates
    /// and the user's own compiled XAML resolve with no build-time makepri bake.
    /// </summary>
    internal static string? UserPriPath { get; private set; }

    /// <summary>
    /// Path to the user app's <c>App.xaml</c> source from <c>--user-appxaml &lt;path&gt;</c>, or null. When
    /// supplied, the app's <c>&lt;Application.Resources&gt;</c> (merged dictionaries + theme dictionaries +
    /// inline resources) is reconstructed and merged into the host's <see cref="Application.Resources"/> so a
    /// real app page resolves app-defined <c>{StaticResource}</c> keys (e.g. <c>GalleryTileGridStyle</c>) and
    /// implicit styles — the app resource scope a page normally inherits from its running <c>App</c>.
    /// </summary>
    internal static string? UserAppXamlPath { get; private set; }

    /// <summary>True when launched with <c>--benchmark</c>: run the offline latency benchmark (S5 Part 1) instead of the TCP server.</summary>
    internal static bool BenchmarkMode { get; private set; }

    /// <summary>True when launched with <c>--wgc</c>: run the WGC-vs-RTB capture probe (S5 Part 2) instead of the TCP server.</summary>
    internal static bool WgcMode { get; private set; }

    [STAThread]
    private static void Main(string[] args)
    {
        Boot("Main: enter");
        RegisterVersionAgnosticAssemblyResolver();
        UserDllPath = ParseUserDll(args);
        Boot("Main: user-dll = " + (UserDllPath ?? "<default>"));
        UserPriPath = ParseFlag(args, "--user-pri");
        Boot("Main: user-pri = " + (UserPriPath ?? "<none>"));
        UserAppXamlPath = ParseFlag(args, "--user-appxaml");
        Boot("Main: user-appxaml = " + (UserAppXamlPath ?? "<none>"));
        StageUserPri();
        BenchmarkMode = args.Any(a => string.Equals(a, "--benchmark", StringComparison.OrdinalIgnoreCase));
        Boot("Main: benchmark = " + BenchmarkMode);
        WgcMode = args.Any(a => string.Equals(a, "--wgc", StringComparison.OrdinalIgnoreCase));
        Boot("Main: wgc = " + WgcMode);
        try
        {
            WinRT.ComWrappersSupport.InitializeComWrappers();
            Boot("Main: InitializeComWrappers done");
            DesignModeSignal.Establish();
            Application.Start(p =>
            {
                Boot("Application.Start callback: enter");
                var context = new DispatcherQueueSynchronizationContext(DispatcherQueue.GetForCurrentThread());
                SynchronizationContext.SetSynchronizationContext(context);
                Boot("Application.Start callback: creating App");
                new App();
                Boot("Application.Start callback: App created");
            });
            Boot("Main: Application.Start returned");
        }
        catch (Exception ex)
        {
            Boot("Main: EXCEPTION " + ex);
            throw;
        }
    }

    /// <summary>
    /// Registers a version-agnostic fallback assembly resolver on the default load context.
    /// <para>
    /// This host is a single prebuilt base built against one Windows App SDK (the "latest we
    /// ship"). A user's <b>prebuilt</b> control DLL, however, was compiled against whatever
    /// WASDK/C#-WinRT their app used, so it may hard-reference a projection assembly
    /// (<c>WinRT.Runtime</c>, <c>Microsoft.WinUI</c>, <c>Microsoft.*.Projection</c>) at a
    /// <i>different</i> version than the one this base loaded.
    /// </para>
    /// <para>
    /// The .NET default context already unifies <b>downward</b> (a reference to an older version
    /// binds to the newer loaded copy automatically), so the common case — user built against an
    /// older WASDK than this base — needs nothing. This handler covers the <b>upward</b> edge
    /// (user built against a <i>newer</i> WASDK than this base): normal resolution fails, this
    /// event fires, and we redirect to the already-loaded assembly of the same simple name,
    /// ignoring version. Managed WinRT/WinUI projection ABI is stable for released types, so the
    /// redirect is safe within a major line. Because <see cref="AssemblyLoadContext.Resolving"/>
    /// only fires <i>after</i> normal resolution fails, this is purely additive: it can turn a
    /// previously-failing load into a success and never changes an already-working one.
    /// </para>
    /// </summary>
    private static void RegisterVersionAgnosticAssemblyResolver()
    {
        AssemblyLoadContext.Default.Resolving += static (context, requested) =>
        {
            var loaded = context.Assemblies.FirstOrDefault(a =>
                string.Equals(a.GetName().Name, requested.Name, StringComparison.OrdinalIgnoreCase));
            if (loaded != null)
            {
                Boot($"AssemblyResolver: redirect '{requested}' -> already-loaded '{loaded.GetName()}'");
                return loaded;
            }

            // SPIKE (app-closure-preferring loader): nothing of this simple name is loaded yet. If the user
            // app ships its OWN copy of the requested assembly in its bin directory, prefer THAT file. This
            // covers app-level SDKs the surface ALSO bundles at an OLDER version (e.g. the Windows AI
            // projections: gallery needs 2.2.5 but the surface bin's 2.2.2 file is probed first). Normal
            // resolution only reaches this Resolving event once the surface's colliding file is absent (or
            // for a name the surface never bundled), so the app's closure becomes authoritative for its own
            // non-core assemblies. Core runtime/WinUI/WinRT assemblies are already loaded by the surface, so
            // they are caught by the already-loaded redirect above and never reach here — preserving
            // Microsoft.WinUI / WinRT.Runtime type identity and the metadata-provider chain.
            var userDll = UserDllPath;
            if (!string.IsNullOrEmpty(requested.Name) && !string.IsNullOrEmpty(userDll))
            {
                var appDir = Path.GetDirectoryName(userDll);
                if (!string.IsNullOrEmpty(appDir))
                {
                    var candidate = Path.Combine(appDir!, requested.Name + ".dll");
                    if (File.Exists(candidate))
                    {
                        try
                        {
                            var fromApp = context.LoadFromAssemblyPath(candidate);
                            Boot($"AssemblyResolver: app-closure load '{requested}' -> '{candidate}' ({fromApp.GetName()})");
                            return fromApp;
                        }
                        catch (Exception ex)
                        {
                            Boot($"AssemblyResolver: app-closure load FAILED '{requested}' from '{candidate}': {ex.Message}");
                        }
                    }
                }
            }

            return null;
        };
    }

    private static string? ParseUserDll(string[] args) => ParseFlag(args, "--user-dll");

    /// <summary>Parses <c>&lt;flag&gt; &lt;value&gt;</c> or <c>&lt;flag&gt;=&lt;value&gt;</c> from the command line.</summary>
    private static string? ParseFlag(string[] args, string flag)
    {
        for (int i = 0; i < args.Length; i++)
        {
            if (string.Equals(args[i], flag, StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
            {
                return args[i + 1];
            }
            if (args[i].StartsWith(flag + "=", StringComparison.OrdinalIgnoreCase))
            {
                return args[i][(flag.Length + 1)..];
            }
        }
        return null;
    }

    /// <summary>
    /// Stages the user app's already-built merged <c>resources.pri</c> (<see cref="UserPriPath"/>) as this
    /// host's primary resource map.
    /// <para>
    /// An unpackaged WinUI host loads <c>&lt;ExeName&gt;.pri</c> and resolves <c>ms-appx:///</c> lookups from
    /// its <b>primary</b> resource map. A user's app build already produces a MERGED pri that embeds their
    /// entire resource closure as <c>EmbeddedData</c> — third-party component templates (e.g. a NuGet
    /// toolkit's <c>Themes/Generic.xbf</c>, which ships only inside a component <c>.pri</c> with no loose
    /// <c>.xbf</c>) AND the user's own compiled XAML. Staging that pri here lets those <c>ms-appx</c> lookups
    /// resolve with full fidelity and <b>no build-time makepri bake</b>. WinUI keys off the pri's primary map
    /// regardless of its internal (user-app) name, so no rename is required. This must run before the first
    /// <c>ms-appx</c> resolution (before <see cref="Application.Start"/>), which <c>Main</c> guarantees.
    /// </para>
    /// <para>
    /// This overwrites the host's own <c>.pri</c>, which is correct for the per-session <b>provisioned-host</b>
    /// model (the host is a throwaway copy). The host's own pri carries no render-critical resources.
    /// </para>
    /// </summary>
    private static void StageUserPri()
    {
        if (string.IsNullOrEmpty(UserPriPath))
        {
            return;
        }
        if (!File.Exists(UserPriPath))
        {
            Boot($"StageUserPri: user pri not found '{UserPriPath}' — skipping.");
            return;
        }
        try
        {
            var hostName = Assembly.GetEntryAssembly()?.GetName().Name ?? "Surface";
            var hostPri = Path.Combine(AppContext.BaseDirectory, hostName + ".pri");
            File.Copy(UserPriPath, hostPri, overwrite: true);
            Boot($"StageUserPri: staged '{UserPriPath}' -> '{hostPri}'");
        }
        catch (Exception ex)
        {
            Boot("StageUserPri: EXCEPTION " + ex);
        }
    }
}

/// <summary>
/// The unpackaged headless render host. Implements <see cref="IXamlMetadataProvider"/>
/// so that <c>XamlReader.Load</c> (which consults <c>Application.Current</c>) can
/// resolve custom xmlns types declared with <c>using:</c> — the crux of scenario S2.
/// </summary>
public partial class App : Application, IXamlMetadataProvider
{
    // Ordered metadata provider chain.
    //   [0] Surface's own baseline metadata (the WinUI controls provider).
    //   [1] (added at runtime) the user app's compiler-generated provider.
    private readonly List<IXamlMetadataProvider> _providers = new();
    private IXamlMetadataProvider? _userProvider;
    private Assembly? _userAssembly;
    private RenderHost? _renderHost;
    private FrameServer? _server;

    // Layer 2 (resource scope). The user app's resource dictionaries we merged into
    // Application.Current.Resources, tracked so a re-establish can remove them without leaking.
    private readonly List<ResourceDictionary> _userDictionaries = new();

    // Snapshot of every string key reachable from the surface's application resource scope
    // (framework + user), captured after the scope is established. Handed to the design-time
    // cleaner so it can tell a resolvable {StaticResource} from a genuinely-undefined one.
    private HashSet<string>? _knownResourceKeys;

    /// <summary>
    /// String resource keys reachable in the application scope (Layer 2), or null before the scope
    /// is established. Consumed by <see cref="XamlCleaner"/> Rule 6 via <see cref="RenderHost.CleanXaml"/>.
    /// </summary>
    internal static ISet<string>? KnownResourceKeys => (Current as App)?._knownResourceKeys;

    public App()
    {
        Program.Boot("App.ctor: enter");
        // Per-process preview theme (user-requested theme preview). Because our host is a code-only
        // Application (no App.xaml — required so we can own the IXamlMetadataProvider chain), a runtime
        // RequestedTheme flip on the content root does NOT re-resolve {ThemeResource} brushes (WinUI only
        // propagates theme-change notifications for XamlControlsResources when merged via App.xaml markup).
        // The reliable path in a code-only host is the app-global Application.RequestedTheme, set ONCE here
        // before any window content exists. Theme switching is therefore a per-process concern: the client
        // relaunches the surface with a new SURFACE_THEME to change themes.
        var startupTheme = Environment.GetEnvironmentVariable("SURFACE_THEME");
        if (string.Equals(startupTheme, "Dark", StringComparison.OrdinalIgnoreCase))
        {
            RequestedTheme = ApplicationTheme.Dark;
            Program.Boot("App.ctor: RequestedTheme = Dark");
        }
        else if (string.Equals(startupTheme, "Light", StringComparison.OrdinalIgnoreCase))
        {
            RequestedTheme = ApplicationTheme.Light;
            Program.Boot("App.ctor: RequestedTheme = Light");
        }
        // Only pure-managed work here — the native Application.Resources dictionary is
        // not yet available in a code-only App's constructor.
        //
        // Step 1 of the chain: the surface's own metadata. This host defines no XAML
        // types of its own, so its baseline metadata is simply the WinUI controls
        // provider (this is what a compiler-generated app provider chains to anyway).
        _providers.Add(new Microsoft.UI.Xaml.XamlTypeInfo.XamlControlsXamlMetaDataProvider());
        Program.Boot("App.ctor: XamlControls provider added");
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        Program.Boot("OnLaunched: enter");
        try
        {
            // Supply WinUI control theme resources so framework controls parsed from
            // runtime markup (e.g. a TextBlock's default foreground brush) resolve.
            // Must run after activation, when Application.Resources is initialized.
            Resources.MergedDictionaries.Add(new XamlControlsResources());
            Program.Boot("OnLaunched: XamlControlsResources added");
        }
        catch (Exception ex)
        {
            Program.Boot("OnLaunched: XamlControlsResources FAILED (continuing) " + ex.Message);
        }

        // Start the warm frame server; the app stays alive serving renders until the client
        // disconnects (or stdin closes / it is killed) — it does NOT exit after one render.
        StartServer();
    }

    /// <summary>
    /// Stands up the warm render host, chains the user assembly's metadata provider (preserving
    /// the S2 provider-chain + loose-<c>.xbf</c> staging so custom controls resolve), and starts
    /// the TCP frame server which prints <c>SURFACE_PORT=&lt;port&gt;</c> to stdout.
    /// </summary>
    private void StartServer()
    {
        try
        {
            // 1) Warm, reusable off-screen render host on the UI thread.
            _renderHost = new RenderHost();
            _renderHost.Initialize();

            // 2) Resolve the user assembly (if any) and chain its provider BEFORE any custom-control
            //    markup is parsed, so <local:FancyBadge> (using:TestUserApp) resolves and the loose
            //    compiled XAML (.xbf) is staged next to Surface.exe.
            //
            //    Semantics: an ABSENT --user-dll means "no user assembly" — load NO user types and NO
            //    user resource dictionaries (framework defaults only). This stops a user previewing
            //    their own plain page from inheriting a bundled test app's implicit styles/types (e.g.
            //    the teal Button style). Only an EXPLICIT --user-dll loads that assembly's provider AND
            //    resources. The offline self-test paths (--benchmark / --wgc) exercise TestUserApp's
            //    custom control + resources, so they opt in EXPLICITLY here instead of relying on a
            //    silent default.
            var userDll = Program.UserDllPath;
            if (string.IsNullOrWhiteSpace(userDll) && (Program.BenchmarkMode || Program.WgcMode))
            {
                userDll = Paths.TestUserAppDll;
                Log($"No --user-dll supplied; benchmark/self-test path explicitly loads TestUserApp: {userDll}");
            }

            if (!string.IsNullOrWhiteSpace(userDll))
            {
                // LAYER 1: chain the user metadata provider (type resolution for using: xmlns).
                try
                {
                    var providerType = EnsureUserProviderLoaded(userDll);
                    Log($"User provider chained: {providerType}");
                }
                catch (Exception ex)
                {
                    Log($"WARNING: failed to load user provider from '{userDll}': {DescribeExceptionChain(ex)}. " +
                        "Custom controls will not resolve; built-in XAML still renders.");
                }

                // LAYER 2: establish the user app's resource scope (implicit styles + {StaticResource}
                //          targets) in Application.Current.Resources BEFORE any page is parsed, so real
                //          pages resolve their resources. Framework defaults (XamlControlsResources) were
                //          merged in OnLaunched; the user dictionaries are merged AFTER them so user
                //          implicit styles win.
                try
                {
                    EstablishUserResourceScope(userDll);
                }
                catch (Exception ex)
                {
                    Log($"WARNING: failed to establish user resource scope: {ex.Message}. " +
                        "{StaticResource}/implicit styles from the user app may not resolve.");
                }
            }
            else
            {
                // No user assembly: framework defaults ONLY (no user types, no user resource
                // dictionaries). Still snapshot the framework resource keys (XamlControlsResources)
                // so the cleaner's Rule 6 can resolve framework {StaticResource} references.
                Log("No --user-dll supplied; loading framework defaults only (no user types or resource dictionaries).");
                EstablishFrameworkOnlyResourceScope();
            }

            // 3) Either run an offline benchmark (S5 Part 1 latency, or Part 2 WGC probe), or serve frames.
            if (Program.WgcMode)
            {
                Log("WGC mode: running the S5 Part 2 WGC-vs-RTB capture probe (no TCP server).");
                _ = RunWgcAsync();
                Program.Boot("StartServer: wgc started");
                return;
            }

            if (Program.BenchmarkMode)
            {
                Log("Benchmark mode: running the S5 render-latency benchmark (no TCP server).");
                _ = RunBenchmarkAsync();
                Program.Boot("StartServer: benchmark started");
                return;
            }

            _server = new FrameServer(_renderHost);
            _server.Start();
            Program.Boot("StartServer: server started");
        }
        catch (Exception ex)
        {
            Program.Boot("StartServer: FATAL " + ex);
            Log("FATAL during startup: " + ex);
            Environment.Exit(1);
        }
    }

    /// <summary>
    /// Runs the offline S5 latency benchmark on the UI thread, then exits. Fire-and-forget from
    /// <see cref="StartServer"/>: <see cref="OnLaunched"/> returns, the WinUI message loop keeps
    /// pumping, and the awaited dispatcher/compositor work inside <see cref="Benchmark.RunAsync"/>
    /// progresses to completion.
    /// </summary>
    private async Task RunBenchmarkAsync()
    {
        try
        {
            await Benchmark.RunAsync(_renderHost!);
        }
        catch (Exception ex)
        {
            Log("Benchmark FATAL: " + ex);
        }
        finally
        {
            Environment.Exit(0);
        }
    }

    /// <summary>
    /// Runs the S5 Part 2 WGC-vs-RTB capture probe on the UI thread, then exits. Same fire-and-forget
    /// pattern as <see cref="RunBenchmarkAsync"/> — the WinUI message loop keeps pumping so the awaited
    /// dispatcher/compositor work inside <see cref="WgcBenchmark.RunAsync"/> progresses to completion.
    /// </summary>
    private async Task RunWgcAsync()
    {
        try
        {
            await WgcBenchmark.RunAsync(_renderHost!);
        }
        catch (Exception ex)
        {
            Log("WGC benchmark FATAL: " + ex);
        }
        finally
        {
            Environment.Exit(0);
        }
    }

    /// <summary>
    /// Flattens an exception and its <see cref="Exception.InnerException"/> chain into
    /// "TypeA: msgA -&gt; TypeB: msgB" so a <see cref="TargetInvocationException"/> /
    /// <see cref="TypeInitializationException"/> never hides the real root cause (a failed module
    /// initializer, a missing dependency, a version-bind failure) behind a generic outer message.
    /// </summary>
    internal static string DescribeExceptionChain(Exception ex)
    {
        var parts = new List<string>();
        for (Exception? e = ex; e != null && parts.Count < 8; e = e.InnerException)
        {
            var msg = e.Message;
            if (e is ReflectionTypeLoadException rtle && rtle.LoaderExceptions is { Length: > 0 } loaders)
            {
                var detail = string.Join("; ", loaders.Where(x => x != null).Select(x => x!.Message).Distinct().Take(3));
                msg += $" [loader: {detail}]";
            }

            parts.Add($"{e.GetType().Name}: {msg}");
        }

        return string.Join(" -> ", parts);
    }

    /// <summary>
    /// Loads the user app assembly at runtime, reflects to find the exported type
    /// implementing <see cref="IXamlMetadataProvider"/> (the compiler-generated
    /// <c>*_XamlTypeInfo.XamlMetaDataProvider</c>), instantiates it, and appends it
    /// to the provider chain. Returns the resolved provider type's full name.
    /// </summary>
    public string EnsureUserProviderLoaded(string userAssemblyPath)
    {
        if (_userProvider != null)
        {
            return _userProvider.GetType().FullName!;
        }

        Log($"Loading user assembly: {userAssemblyPath}");
        var assembly = Assembly.LoadFrom(userAssemblyPath);
        _userAssembly = assembly;

        // Enumerate types defensively: a real app references many packages (Win2D, toolkit, …) and
        // GetExportedTypes() throws ReflectionTypeLoadException if any referenced type can't load.
        // Fall back to the successfully-loaded subset so one bad reference doesn't blind us.
        Type[] candidates;
        try
        {
            candidates = assembly.GetExportedTypes();
        }
        catch (ReflectionTypeLoadException rtle)
        {
            candidates = rtle.Types.Where(t => t != null).Cast<Type>().ToArray();
            Log($"GetExportedTypes partial ({candidates.Length} loaded; {rtle.LoaderExceptions?.Length ?? 0} loader errors, first: {rtle.LoaderExceptions?.FirstOrDefault()?.Message}).");
        }

        // A code-behind app exports BOTH its generated `<Root>_XamlTypeInfo.XamlMetaDataProvider`
        // (what we want) AND its own `App : Application, IXamlMetadataProvider` (uncreatable at design
        // time — its ctor runs InitializeComponent/app startup and throws). Never instantiate the app
        // type: exclude Application subclasses and prefer the generated provider by name convention.
        bool IsProvider(Type t) =>
            typeof(IXamlMetadataProvider).IsAssignableFrom(t) &&
            t is { IsInterface: false, IsAbstract: false } &&
            !typeof(Microsoft.UI.Xaml.Application).IsAssignableFrom(t);

        var providerType =
            candidates.FirstOrDefault(t => IsProvider(t) &&
                (t.Name == "XamlMetaDataProvider" || t.FullName!.EndsWith("_XamlTypeInfo.XamlMetaDataProvider", StringComparison.Ordinal)))
            ?? candidates.FirstOrDefault(IsProvider);

        if (providerType == null)
        {
            throw new InvalidOperationException(
                $"No usable IXamlMetadataProvider (non-Application) found in '{userAssemblyPath}'.");
        }

        try
        {
            _userProvider = (IXamlMetadataProvider)Activator.CreateInstance(providerType)!;
        }
        catch (Exception ex)
        {
            // Surface the real cause: TargetInvocationException / TypeInitializationException bury the
            // actual failure (e.g. a failed module initializer or a missing dependency) in InnerException.
            throw new InvalidOperationException(
                $"Instantiating provider '{providerType.FullName}' failed: {DescribeExceptionChain(ex)}", ex);
        }
        _providers.Add(_userProvider);

        // LAYER 1 (T2): the main provider only resolves types the XAML compiler baked into the user
        // assembly's OWN generated XamlTypeInfo. Controls from REFERENCED libraries
        // (CommunityToolkit.WinUI.Controls.* etc.) ship their own provider in SEPARATE assemblies that the
        // main provider does not chain, so <tkcontrols:SettingsCard> in runtime markup is otherwise
        // type-not-found and the whole page fails to parse. Discover + chain the provider-bearing
        // assemblies in the user's bin closure so those controls resolve and REAL-render (what a compiled
        // app and a design surface such as VS both do for referenced assemblies).
        try
        {
            ChainClosureMetadataProviders(Path.GetDirectoryName(userAssemblyPath)!);
        }
        catch (Exception ex)
        {
            Log($"WARNING: closure provider chaining failed: {DescribeExceptionChain(ex)}. " +
                "Referenced-assembly controls may fall back to placeholders.");
        }

        // The custom control's generated InitializeComponent() loads its compiled XAML
        // via ms-appx:///TestUserApp/FancyBadge.xaml. For an unpackaged host that URI is
        // resolved from loose .xbf files under the process base directory. The user
        // assembly was loaded from a different folder, so stage its loose XAML tree next
        // to Surface.exe before any custom type is activated from runtime markup.
        StageLooseXamlResources(userAssemblyPath);

        return providerType.FullName!;
    }

    /// <summary>
    /// LAYER 1 (T2): chains the <see cref="IXamlMetadataProvider"/> of every provider-bearing assembly in
    /// the user's bin closure (the directory next to the main user DLL). The user's main provider only
    /// resolves types the XAML compiler baked into ITS generated <c>*_XamlTypeInfo</c>; referenced control
    /// libraries (e.g. the <c>CommunityToolkit.WinUI.Controls.*</c> packages) each ship their OWN generated
    /// <c>XamlMetaDataProvider</c> in a separate assembly. Chaining them lets a runtime-parsed page resolve
    /// and construct those controls for real instead of failing type-resolution.
    ///
    /// TARGETED, not a blanket load: each candidate DLL is first metadata-scanned (no code runs, no
    /// dependency resolution) for a defined <c>XamlMetaDataProvider</c> type; only the few that have one are
    /// fully loaded + instantiated. Provider-less libraries (converters / behaviors / animations) are
    /// skipped — their types remain unresolved and are handled by the cleaner's element-substitution pass.
    /// </summary>
    private void ChainClosureMetadataProviders(string dllDir)
    {
        if (!Directory.Exists(dllDir))
        {
            return;
        }

        var mainName = _userAssembly?.GetName().Name;
        int chained = 0;
        foreach (var dll in Directory.EnumerateFiles(dllDir, "*.dll", SearchOption.TopDirectoryOnly))
        {
            // The main user assembly's provider is already chained; skip it.
            if (mainName != null &&
                string.Equals(Path.GetFileNameWithoutExtension(dll), mainName, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            // Cheap metadata-only pre-filter so we do not Assembly.LoadFrom the hundreds of provider-less
            // DLLs in a real app's closure (native deps, load failures, cost).
            if (!DefinesXamlMetadataProvider(dll))
            {
                continue;
            }

            try
            {
                var asm = Assembly.LoadFrom(dll);
                Type[] types;
                try
                {
                    types = asm.GetExportedTypes();
                }
                catch (ReflectionTypeLoadException rtle)
                {
                    types = rtle.Types.Where(t => t != null).Cast<Type>().ToArray();
                }

                var providerType = types.FirstOrDefault(t =>
                    typeof(IXamlMetadataProvider).IsAssignableFrom(t) &&
                    t is { IsInterface: false, IsAbstract: false } &&
                    !typeof(Microsoft.UI.Xaml.Application).IsAssignableFrom(t) &&
                    (t.Name == "XamlMetaDataProvider" ||
                     t.FullName!.EndsWith("_XamlTypeInfo.XamlMetaDataProvider", StringComparison.Ordinal)));

                if (providerType == null)
                {
                    continue;
                }

                var provider = (IXamlMetadataProvider)Activator.CreateInstance(providerType)!;
                _providers.Add(provider);
                chained++;
                Log($"LAYER 1: chained closure provider {providerType.FullName} ({Path.GetFileName(dll)}).");
            }
            catch (Exception ex)
            {
                Log($"LAYER 1: skipped provider in {Path.GetFileName(dll)}: {DescribeExceptionChain(ex)}");
            }
        }

        Log($"LAYER 1: chained {chained} referenced-assembly metadata provider(s) from {dllDir}.");
    }

    /// <summary>
    /// Metadata-only test (no assembly load, no code execution) for whether the assembly at
    /// <paramref name="dllPath"/> defines a type named <c>XamlMetaDataProvider</c> — the compiler-generated
    /// provider a XAML-bearing library ships. Lets <see cref="ChainClosureMetadataProviders"/> skip the
    /// hundreds of provider-less DLLs in a real bin closure without loading them.
    /// </summary>
    private static bool DefinesXamlMetadataProvider(string dllPath)
    {
        try
        {
            using var fs = File.OpenRead(dllPath);
            using var pe = new System.Reflection.PortableExecutable.PEReader(fs);
            if (!pe.HasMetadata)
            {
                return false;
            }

            var md = pe.GetMetadataReader();
            foreach (var handle in md.TypeDefinitions)
            {
                var td = md.GetTypeDefinition(handle);
                if (md.GetString(td.Name) == "XamlMetaDataProvider")
                {
                    return true;
                }
            }
        }
        catch
        {
            // Unreadable / native / locked DLL — treat as "no provider" and move on.
        }

        return false;
    }

    /// <summary>
    /// LIVE MODE (spike; enabled via env <c>SURFACE_LIVE_MODE=1</c>). When true, the render path first
    /// tries to instantiate the user's REAL page/control type (its <c>x:Class</c>) instead of runtime-
    /// parsing cleaned markup. The real type runs the genuine compiled <c>InitializeComponent()</c> /
    /// <c>Connect()</c>, so <c>{x:Bind}</c> bindings, control code-behind state and {Binding} against a
    /// code-populated source all come alive — none of which survive the <see cref="XamlReader.Load"/>
    /// path (which strips x:Bind). The trade-off is that the user's constructor runs arbitrary code, so
    /// this is opt-in and always falls back to the parse path on any failure.
    /// </summary>
    internal static bool LiveModeEnabled { get; } =
        string.Equals(Environment.GetEnvironmentVariable("SURFACE_LIVE_MODE"), "1", StringComparison.Ordinal);

    /// <summary>
    /// §51 M3: opt-in for the OPPORTUNISTIC REFLECTION FALLBACK (env <c>SURFACE_DTD_REFLECT=1</c>). When set
    /// AND live mode successfully activated the real control, <see cref="DesignDataInjector"/> reflects the
    /// page's empty x:Bind-backed collections and fills them with a bounded sample dataset. Best-effort and
    /// live-only: it is never reached on the certified default parse path. Off unless explicitly requested.
    /// </summary>
    internal static bool ReflectionFallbackEnabled { get; } =
        string.Equals(Environment.GetEnvironmentVariable("SURFACE_DTD_REFLECT"), "1", StringComparison.Ordinal);

    /// <summary>
    /// Coverage-hardening P3: opt-in for the design-time RENDER-SETTLE sweep (env <c>SURFACE_RENDER_SETTLE=1</c>).
    /// When set, <see cref="RenderSettle.Quiesce"/> runs after a page mounts to stop self-perpetuating UI-thread
    /// churn (auto-advance <c>DispatcherTimer</c>s, forever-storyboards) so an animation/nav page can settle to a
    /// representative frame. It is OFF by default because the sweep walks the live visual tree, and that extra
    /// UI-thread work can perturb the frame-capture timing of pages that already render fine (it shifted the
    /// async-load race on a model page during coverage measurement). Keeping it opt-in guarantees the certified
    /// default (leg A) render path is byte-for-byte unchanged; the mechanism stays proven via the smoke test,
    /// which sets this flag. Never reached on the certified default path.
    /// </summary>
    internal static bool RenderSettleEnabled { get; } =
        string.Equals(Environment.GetEnvironmentVariable("SURFACE_RENDER_SETTLE"), "1", StringComparison.Ordinal);

    /// <summary>
    /// Static entry for <see cref="RenderHost"/>: activate the live element for <paramref name="xClass"/>
    /// on the current <see cref="App"/> instance. Returns null (with <paramref name="reason"/>) when live
    /// activation isn't possible, so the caller can fall back to the parse path.
    /// </summary>
    internal static FrameworkElement? ActivatePage(string xClass, out string reason)
    {
        if (Application.Current is App app)
        {
            return app.TryActivatePage(xClass, out reason);
        }

        reason = "no App instance";
        return null;
    }

    /// <summary>
    /// Resolve <paramref name="xClass"/> from the loaded user assembly and instantiate it via its public
    /// parameterless constructor (which runs the real <c>InitializeComponent()</c>). MUST be called on the
    /// UI thread. Returns the live <see cref="FrameworkElement"/>, or null with a human-readable
    /// <paramref name="reason"/> describing why live activation was skipped/failed (used for the
    /// LIVE-FALLBACK log and the spike's survival measurement).
    /// </summary>
    internal FrameworkElement? TryActivatePage(string xClass, out string reason)
    {
        reason = "";
        if (string.IsNullOrWhiteSpace(xClass))
        {
            reason = "no x:Class";
            return null;
        }

        Type? t = _userAssembly?.GetType(xClass, throwOnError: false, ignoreCase: false);
        if (t == null)
        {
            // The x:Class may live in a sibling assembly (multi-assembly app); scan loaded assemblies.
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                t = asm.GetType(xClass, throwOnError: false, ignoreCase: false);
                if (t != null) break;
            }
        }

        if (t == null)
        {
            reason = $"type '{xClass}' not found in loaded assemblies";
            return null;
        }

        if (!typeof(FrameworkElement).IsAssignableFrom(t))
        {
            reason = $"'{xClass}' is not a FrameworkElement ({t.BaseType?.Name})";
            return null;
        }

        if (t.GetConstructor(Type.EmptyTypes) == null)
        {
            reason = $"'{xClass}' has no public parameterless constructor";
            return null;
        }

        try
        {
            if (Activator.CreateInstance(t) is FrameworkElement fe)
            {
                return fe;
            }

            reason = $"activation of '{xClass}' returned a non-FrameworkElement";
            return null;
        }
        catch (Exception ex)
        {
            // P2 (coverage hardening): the construction gate. Several real gallery controls throw in their
            // ctor because they deref a static app singleton (e.g. App.ModelDownloadQueue.ModelsChanged += …)
            // that the app only creates during startup (App.OnLaunched), which never runs in our code-only
            // host. We cannot run the app's startup (constructing its Application subclass fail-fasts, and
            // OnLaunched builds the main window), but we CAN reflectively seed the cleanly-constructible null
            // static singletons — once per process, bounded — and retry activation. Reached ONLY here, on the
            // live ctor-throw path; the certified default path and every already-activating page never touch it.
            if (TrySeedAppSingletons(t) > 0)
            {
                try
                {
                    if (Activator.CreateInstance(t) is FrameworkElement fe2)
                    {
                        Log($"APP-INIT-RECOVER: re-activated '{xClass}' after seeding app singletons");
                        return fe2;
                    }
                }
                catch (Exception exRetry)
                {
                    // Recovery didn't cross the gate (e.g. the null singleton was ModelCache, which has no
                    // clean ctor) — honestly report the original failure and fall back to the parse path.
                    reason = DescribeExceptionChain(exRetry);
                    return null;
                }
            }

            reason = DescribeExceptionChain(ex);
            return null;
        }
    }

    // P2: one-shot-per-process guard so the App-init recovery never re-runs (and never touches the happy path).
    private static bool _appInitRecoveryAttempted;

    /// <summary>
    /// P2 (coverage hardening): reflectively seed the user app's cleanly-constructible null static singletons
    /// when a control ctor throws dereferencing one. Finds the user's <see cref="Application"/>-derived
    /// type(s) and, for each null static field/property whose declared type is cleanly constructible (public
    /// or non-public parameterless ctor; not abstract/interface/value type; NOT a Window/Application/UIElement/
    /// DependencyObject; no C# <c>required</c> members), constructs a fresh instance and assigns it. This is
    /// the honest, generic mitigation for the construction gate — it never runs the app's startup, never
    /// creates a window, is bounded and one-shot, and every step is individually try/caught. Returns the
    /// number of members seeded (0 ⇒ nothing recoverable ⇒ the caller keeps the honest fallback).
    /// </summary>
    /// <param name="throwingType">The control type whose ctor threw — its defining assembly is scanned first.</param>
    private int TrySeedAppSingletons(Type throwingType)
    {
        if (_appInitRecoveryAttempted)
        {
            return 0;
        }
        _appInitRecoveryAttempted = true;

        int seeded = 0;
        const int MaxSeed = 16;
        try
        {
            var appTypes = new List<Type>();
            void Collect(Assembly? asm)
            {
                if (asm == null) return;
                try
                {
                    foreach (var ty in asm.GetTypes())
                    {
                        // The user's own Application subclass — never the host's code-only App, never the
                        // framework base — is where these startup-created singletons are declared.
                        if (typeof(Application).IsAssignableFrom(ty) && ty != typeof(Application) && ty != typeof(App))
                        {
                            appTypes.Add(ty);
                        }
                    }
                }
                catch
                {
                    // A ReflectionTypeLoadException on one assembly must not abort the scan.
                }
            }

            Collect(throwingType.Assembly);
            Collect(_userAssembly);
            if (appTypes.Count == 0)
            {
                foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
                {
                    Collect(asm);
                }
            }

            const BindingFlags SF = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.FlattenHierarchy;
            foreach (var appType in appTypes.Distinct())
            {
                // Properties first (get/private-set auto-props like the gallery's), then any remaining fields.
                // Seeding a property invokes only its trivial compiler-generated setter; whichever seeds the
                // backing store first wins, and the other member sees non-null and is skipped.
                foreach (var p in appType.GetProperties(SF))
                {
                    if (seeded >= MaxSeed) break;
                    if (!p.CanRead || !p.CanWrite || p.GetIndexParameters().Length != 0) continue;
                    if (TrySeedMember(() => p.GetValue(null), v => p.SetValue(null, v), p.PropertyType, appType, p.Name))
                    {
                        seeded++;
                    }
                }

                foreach (var f in appType.GetFields(SF))
                {
                    if (seeded >= MaxSeed) break;
                    if (f.IsLiteral || f.IsInitOnly) continue; // const / readonly can't be assigned
                    if (TrySeedMember(() => f.GetValue(null), v => f.SetValue(null, v), f.FieldType, appType, f.Name))
                    {
                        seeded++;
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Log($"APP-INIT-RECOVER: enumeration failed ({ex.GetType().Name})");
        }

        return seeded;
    }

    /// <summary>P2: seed a single static member if it is currently null and its type is a cleanly
    /// constructible seedable singleton. Fully defensive — a throwing ctor/setter only skips this member.</summary>
    private bool TrySeedMember(Func<object?> get, Action<object?> set, Type memberType, Type ownerType, string memberName)
    {
        try
        {
            if (get() != null)
            {
                return false; // already set (or seeded via the other member view) — never overwrite
            }
            if (!IsSeedableSingletonType(memberType))
            {
                return false;
            }

            var instance = Activator.CreateInstance(memberType, nonPublic: true);
            if (instance == null)
            {
                return false;
            }

            set(instance);
            Log($"APP-INIT-RECOVER: seeded {ownerType.Name}.{memberName} = new {memberType.Name}()");
            return true;
        }
        catch (Exception ex)
        {
            Log($"APP-INIT-RECOVER: skipped {ownerType.Name}.{memberName} ({memberType.Name}: {ex.GetType().Name})");
            return false;
        }
    }

    /// <summary>
    /// P2: a type is a seedable app singleton only if it is a reference type with a public OR non-public
    /// parameterless constructor and no <c>required</c> members, and is NOT a visual/window/application object
    /// (constructing those is out of scope and unsafe in a headless host). This is what keeps recovery generic
    /// (no denylist) yet bounded: the gallery's <c>ModelDownloadQueue</c> (parameterless primary ctor) seeds
    /// and rescues its dependent pages; <c>ModelCache</c> (no parameterless ctor) and <c>MainWindow</c> (a
    /// Window) are correctly skipped, so their pages stay an honest fallback rather than a forced hack.
    /// </summary>
    private static bool IsSeedableSingletonType(Type t)
    {
        if (t.IsAbstract || t.IsInterface || t.IsEnum || t.IsPrimitive || t.IsValueType || t.IsGenericTypeDefinition)
        {
            return false;
        }
        if (t == typeof(string) || t == typeof(object))
        {
            return false;
        }
        if (typeof(Application).IsAssignableFrom(t) ||
            typeof(Window).IsAssignableFrom(t) ||
            typeof(UIElement).IsAssignableFrom(t) ||
            typeof(DependencyObject).IsAssignableFrom(t))
        {
            return false;
        }
        if (HasRequiredMembers(t))
        {
            return false;
        }
        var ctor = t.GetConstructor(
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic,
            binder: null, Type.EmptyTypes, modifiers: null);
        return ctor != null;
    }

    /// <summary>P2: true if <paramref name="t"/> (or a base type) carries C# <c>required</c> members, which
    /// reflection-construction would leave unset — such types are skipped rather than half-built.</summary>
    private static bool HasRequiredMembers(Type t)
    {
        for (Type? cur = t; cur != null && cur != typeof(object); cur = cur.BaseType)
        {
            foreach (var a in cur.GetCustomAttributesData())
            {
                if (a.AttributeType.FullName == "System.Runtime.CompilerServices.RequiredMemberAttribute")
                {
                    return true;
                }
            }
        }
        return false;
    }

    /// <summary>
    /// Copies the user assembly's loose compiled-XAML tree next to this host's executable so that
    /// <c>ms-appx:///…/*.xaml</c> resolves (via the unpackaged file-system fallback) when a custom control
    /// calls <c>InitializeComponent()</c> AND when Layer 2 merges the user's resource dictionaries.
    ///
    /// Two project layouts are handled:
    /// <list type="bullet">
    /// <item><b>Class library</b> (e.g. TestUserApp): loose XAML lives under <c>&lt;dllDir&gt;\&lt;AssemblyName&gt;\</c>
    /// and resolves as <c>ms-appx:///&lt;AssemblyName&gt;/…</c>. Staged to <c>&lt;base&gt;\&lt;AssemblyName&gt;\</c>.</item>
    /// <item><b>Application</b> (e.g. WinUIGallery): loose <c>.xbf</c> live at the <b>bin root</b>
    /// (<c>&lt;dllDir&gt;\Controls\ControlExample.xbf</c>, <c>&lt;dllDir&gt;\App.xbf</c>, …) because an app's
    /// <c>ms-appx:///</c> paths are app-relative with no assembly prefix. Every <c>.xbf</c> under the bin
    /// root is staged into <c>&lt;base&gt;\</c> preserving its relative path, so
    /// <c>ms-appx:///Controls/ControlExample.xaml</c> → <c>&lt;base&gt;\Controls\ControlExample.xbf</c>.</item>
    /// </list>
    /// The app layout uses loose <c>.xbf</c> only (the app's own compiled XAML). Third-party NuGet component
    /// resources (e.g. a toolkit's <c>Themes\Generic.xbf</c>) ship only inside a component <c>.pri</c> and are
    /// NOT present as loose files — those degrade gracefully (unstyled control) unless a <c>--user-pri</c> is
    /// supplied. This avoids staging the full app <c>.pri</c>, which crashes WinUI's MRT at startup on large
    /// real-app PRIs.
    /// </summary>
    private static void StageLooseXamlResources(string userAssemblyPath)
    {
        var dllDir = Path.GetDirectoryName(userAssemblyPath)!;
        var asmName = Path.GetFileNameWithoutExtension(userAssemblyPath);

        // --- Layout 1: class-library loose tree under <dllDir>\<AssemblyName>\ (verbatim, incl. .xaml) ---
        var srcTree = Path.Combine(dllDir, asmName);
        int libCount = 0;
        if (Directory.Exists(srcTree))
        {
            var destTree = Path.Combine(AppContext.BaseDirectory, asmName);
            Directory.CreateDirectory(destTree);
            foreach (var src in Directory.EnumerateFiles(srcTree, "*", SearchOption.AllDirectories))
            {
                var rel = Path.GetRelativePath(srcTree, src);
                var dest = Path.Combine(destTree, rel);
                Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                File.Copy(src, dest, overwrite: true);
                libCount++;
            }
            Log($"Staged {libCount} loose class-lib resource file(s): {srcTree} -> {destTree}");
        }

        // --- Layout 2: application loose .xbf at the bin root (app-relative ms-appx paths) ---
        // Stage every *.xbf under the dll dir into <base>, preserving the relative path, EXCEPT the
        // <AssemblyName>\ subtree already handled above. This makes an app's own compiled XAML resolvable.
        int appCount = 0;
        foreach (var src in Directory.EnumerateFiles(dllDir, "*.xbf", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(dllDir, src);
            // Skip the class-lib subtree (already staged verbatim above under its own folder).
            if (libCount > 0 && rel.StartsWith(asmName + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            // CRITICAL: never stage the app's own App.xbf at the base root. Unpackaged WinUI auto-probes
            // ms-appx:///App.xaml during Application.Start and would try to instantiate the USER's Application
            // subclass (with its full merged-dictionary/toolkit closure) inside our code-only host, which
            // fails-fast (0xC000027B) before OnLaunched. Our host supplies its own code-only App; we want the
            // user app's pages/controls/dictionaries, never its App definition.
            if (string.Equals(rel, "App.xbf", StringComparison.OrdinalIgnoreCase))
            {
                Log("Skipped staging user App.xbf (would fail-fast Application.Start in the host).");
                continue;
            }
            var dest = Path.Combine(AppContext.BaseDirectory, rel);
            // Do not overwrite the host's own resources (defensive; the surface ships no .xbf of its own).
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
            File.Copy(src, dest, overwrite: true);
            appCount++;
        }
        if (appCount > 0)
        {
            Log($"Staged {appCount} loose app .xbf file(s) at bin root -> {AppContext.BaseDirectory}");
        }

        if (libCount == 0 && appCount == 0)
        {
            Log($"No loose XAML resource tree at '{srcTree}' and no loose .xbf under '{dllDir}' — nothing to stage.");
        }
    }

    // ---------------------------------------------------------------------------
    // LAYER 2 — application resource scope.
    // ---------------------------------------------------------------------------

    /// <summary>
    /// Establishes (or re-establishes) the user app's resource scope inside
    /// <see cref="Application.Resources"/> so that runtime-parsed pages resolve their
    /// <c>{StaticResource}</c> keys and implicit/default styles.
    ///
    /// Discovery for this spike walks the staged loose XAML tree and merges every file whose root is
    /// a <c>ResourceDictionary</c> (which finds <c>Themes\Styles.xaml</c> and skips UserControls like
    /// <c>FancyBadge.xaml</c>). The framework defaults (<c>XamlControlsResources</c>) were merged in
    /// <see cref="OnLaunched"/> FIRST; these user dictionaries are appended AFTER, so a user implicit
    /// style overrides the framework default. Previously-added user dictionaries are removed first so
    /// repeated calls never leak dictionaries across renders.
    ///
    /// Production note: instead of scanning the whole tree, a shipping visualizer should walk the
    /// user <c>App.xaml</c> merged-dictionary graph — parse <c>&lt;Application.Resources&gt;</c>, follow
    /// each <c>&lt;ResourceDictionary Source="..."/&gt;</c> (and nested <c>MergedDictionaries</c>/
    /// <c>ThemeDictionaries</c>) in declared order, resolving ms-appx and relative URIs and de-duping —
    /// so ordering and theme selection exactly match how the real app composes its resources.
    /// </summary>
    public void EstablishUserResourceScope(string userAssemblyPath)
    {
        var asmName = Path.GetFileNameWithoutExtension(userAssemblyPath);
        var stagedRoot = Path.Combine(AppContext.BaseDirectory, asmName);

        // Remove any user dictionaries added by a previous call (idempotent; no cross-render leak).
        foreach (var d in _userDictionaries)
        {
            Resources.MergedDictionaries.Remove(d);
        }
        _userDictionaries.Clear();

        // App case: merge the app's App.xaml resource graph (merged dictionaries + theme dictionaries +
        // inline resources), reconstructed from the App.xaml source, so a real app page resolves app-defined
        // {StaticResource} keys and implicit styles. This is the "walk the App.xaml graph" production path.
        bool appXamlMerged = false;
        if (!string.IsNullOrWhiteSpace(Program.UserAppXamlPath) && File.Exists(Program.UserAppXamlPath))
        {
            appXamlMerged = MergeUserAppXamlResources(Program.UserAppXamlPath!);
        }

        // Class-library case: discover ResourceDictionary-rooted .xaml under the staged <asmName> tree
        // (finds Themes\Styles.xaml, skips UserControls). App projects stage at the bin root instead, so
        // this tree is absent for them — the App.xaml merge above supplies their scope.
        if (Directory.Exists(stagedRoot))
        {
            foreach (var uri in DiscoverUserResourceDictionaries(stagedRoot, asmName))
            {
                try
                {
                    var dict = new ResourceDictionary { Source = uri };
                    Resources.MergedDictionaries.Add(dict);
                    _userDictionaries.Add(dict);
                    Log($"Merged user resource dictionary: {uri}");
                }
                catch (Exception ex)
                {
                    Log($"WARNING: could not merge user resource dictionary '{uri}': {ex.Message}");
                }
            }
        }
        else if (!appXamlMerged)
        {
            Log($"No staged resource tree at '{stagedRoot}' and no App.xaml merged — no user resource scope to establish.");
        }

        // Cache the full set of reachable string keys for the cleaner's Rule 6.
        _knownResourceKeys = CollectResourceKeys(Resources);
        Log($"Resource scope established: {_userDictionaries.Count} user dictionary(ies), " +
            $"{_knownResourceKeys.Count} known key(s).");
    }

    private static readonly XNamespace PresentationNs = "http://schemas.microsoft.com/winfx/2006/xaml/presentation";

    /// <summary>
    /// Normalizes a ResourceDictionary <c>Source</c> to an absolute <c>ms-appx:///</c> URI when it is the
    /// XAML compiler's app-relative shorthand. The design-time <see cref="XamlReader.Load(string)"/> never
    /// normalizes the leading-slash form (<c>Source="/Styles/Button.xaml"</c>) or a bare relative path
    /// (<c>Foo/Bar.xaml</c>) the way the compiled app loader does, so <see cref="ResourceDictionary.Source"/>
    /// rejects it ("not a valid absolute URI" / "The parameter is incorrect"). Mapping it to
    /// <c>ms-appx:///Styles/Button.xaml</c> resolves it against the user app's staged loose <c>.xbf</c>
    /// (see <see cref="StageLooseXamlResources"/>). Values already absolute (<c>ms-appx:///…</c>,
    /// <c>pack://…</c>, http, …) are returned unchanged.
    /// </summary>
    private static string NormalizeAppResourceSource(string src)
    {
        if (string.IsNullOrWhiteSpace(src) || Uri.TryCreate(src, UriKind.Absolute, out _))
        {
            return src;
        }
        return "ms-appx:///" + src.TrimStart('/');
    }

    /// <summary>
    /// Rewrites — in place — every <c>&lt;ResourceDictionary Source="/Foo.xaml"&gt;</c> app-relative
    /// shorthand under <paramref name="dictElem"/> (itself and all descendants) to a resolvable
    /// <c>ms-appx:///</c> URI via <see cref="NormalizeAppResourceSource"/>. Returns how many were rewritten.
    /// </summary>
    private static int RewriteAppRelativeDictionarySources(XElement dictElem)
    {
        int rewritten = 0;
        foreach (var rd in dictElem.DescendantsAndSelf(PresentationNs + "ResourceDictionary"))
        {
            var attr = rd.Attribute("Source");
            if (attr is null)
            {
                continue;
            }
            var normalized = NormalizeAppResourceSource(attr.Value);
            if (!string.Equals(normalized, attr.Value, StringComparison.Ordinal))
            {
                attr.Value = normalized;
                rewritten++;
            }
        }
        return rewritten;
    }

    /// <summary>
    /// Reconstructs the user app's <c>&lt;Application.Resources&gt;</c> from its <c>App.xaml</c> source and
    /// merges it into the host's <see cref="Application.Resources"/>. The app's resource dictionary — its
    /// <c>MergedDictionaries</c> (<c>Source="ms-appx:///…"</c>, resolved from the staged loose <c>.xbf</c>),
    /// <c>ThemeDictionaries</c>, and inline keyed resources — is serialized to a standalone
    /// <c>&lt;ResourceDictionary&gt;</c> (carrying the app root's xmlns declarations so <c>local:</c>/custom
    /// prefixes resolve via the chained provider) and loaded with <see cref="XamlReader.Load(string)"/>.
    /// On failure falls back to merging just the <c>Source</c> URIs. Returns true if anything was merged.
    /// </summary>
    private bool MergeUserAppXamlResources(string appXamlPath)
    {
        XDocument doc;
        try
        {
            doc = XDocument.Load(appXamlPath);
        }
        catch (Exception ex)
        {
            Log($"WARNING: could not read App.xaml '{appXamlPath}': {ex.Message}");
            return false;
        }

        var root = doc.Root;
        var resProp = root?.Element(PresentationNs + "Application.Resources");
        if (root == null || resProp == null)
        {
            Log("App.xaml has no <Application.Resources> — nothing to merge.");
            return false;
        }

        // The resources are either a single <ResourceDictionary> child or inline resource elements.
        var rdSource = resProp.Element(PresentationNs + "ResourceDictionary");
        var dictElem = rdSource != null
            ? new XElement(rdSource)
            : new XElement(PresentationNs + "ResourceDictionary", resProp.Elements().Select(e => new XElement(e)));

        // Copy the app root's namespace declarations so local:/toolkit:/x: prefixes resolve when re-parsed.
        foreach (var nsAttr in root.Attributes().Where(a => a.IsNamespaceDeclaration))
        {
            if (dictElem.Attribute(nsAttr.Name) == null)
            {
                dictElem.Add(new XAttribute(nsAttr.Name, nsAttr.Value));
            }
        }

        // The XAML compiler's app-relative dictionary Source shorthand ("/Styles/Button.xaml") is not
        // normalized by the design-time XamlReader.Load the way the compiled app loader is, so rewrite every
        // <ResourceDictionary Source="/…"> to an ms-appx:/// URI that resolves against the staged loose .xbf
        // BEFORE the full load. Without this the whole load throws on the first relative Source and the app's
        // implicit styles + shared templates never merge (the dominant gallery render blocker).
        int rewritten = RewriteAppRelativeDictionarySources(dictElem);
        if (rewritten > 0)
        {
            Log($"Normalized {rewritten} app-relative dictionary Source URI(s) to ms-appx:///.");
        }

        var xaml = dictElem.ToString();
        try
        {
            if (XamlReader.Load(xaml) is ResourceDictionary dict)
            {
                Resources.MergedDictionaries.Add(dict);
                _userDictionaries.Add(dict);
                Log($"Merged app resource scope from App.xaml: {dict.MergedDictionaries.Count} merged dict(s), " +
                    $"{dict.ThemeDictionaries.Count} theme dict(s).");
                return true;
            }
            Log("WARNING: App.xaml resources did not load as a ResourceDictionary.");
        }
        catch (Exception ex)
        {
            Log($"WARNING: full App.xaml resource load failed: {ex.Message}. Falling back to per-Source merge.");
            return MergeAppMergedDictionarySources(resProp);
        }
        return false;
    }

    /// <summary>
    /// Fallback for <see cref="MergeUserAppXamlResources"/>: merges every <c>&lt;ResourceDictionary
    /// Source="ms-appx:///…"/&gt;</c> URI found under <c>&lt;Application.Resources&gt;</c> independently, so
    /// one unloadable dictionary doesn't sink the rest. Loses inline/theme resources but recovers most
    /// keyed styles.
    /// </summary>
    private bool MergeAppMergedDictionarySources(XElement resProp)
    {
        int merged = 0;
        foreach (var rd in resProp.Descendants(PresentationNs + "ResourceDictionary"))
        {
            var src = rd.Attribute("Source")?.Value;
            if (string.IsNullOrWhiteSpace(src))
            {
                continue;
            }
            // Same app-relative → ms-appx:/// normalization as the primary path, so the per-source fallback
            // recovers keyed styles even when the full-blob load failed for an unrelated reason.
            var normalized = NormalizeAppResourceSource(src!);
            try
            {
                var dict = new ResourceDictionary { Source = new Uri(normalized, UriKind.RelativeOrAbsolute) };
                Resources.MergedDictionaries.Add(dict);
                _userDictionaries.Add(dict);
                merged++;
                Log($"Merged app dictionary (fallback): {normalized}");
            }
            catch (Exception ex)
            {
                Log($"WARNING: could not merge app dictionary '{normalized}': {ex.Message}");
            }
        }
        return merged > 0;
    }

    /// <summary>
    /// Snapshots ONLY the framework resource scope (the <c>XamlControlsResources</c> merged in
    /// <see cref="OnLaunched"/>) for the cleaner's Rule 6 — WITHOUT loading any user assembly's
    /// dictionaries. Used when no <c>--user-dll</c> is supplied so a user previewing a plain page
    /// sees framework defaults only (no bundled test-app implicit styles/types leaking in). Any user
    /// dictionaries from a previous scope are removed first so the scope is genuinely framework-only.
    /// </summary>
    public void EstablishFrameworkOnlyResourceScope()
    {
        foreach (var d in _userDictionaries)
        {
            Resources.MergedDictionaries.Remove(d);
        }
        _userDictionaries.Clear();

        _knownResourceKeys = CollectResourceKeys(Resources);
        Log($"Framework-only resource scope established: {_knownResourceKeys.Count} known key(s).");
    }

    /// <summary>
    /// Enumerates the staged loose XAML tree and returns an <c>ms-appx:///</c> URI for every file whose
    /// root element is a <c>ResourceDictionary</c>. The <c>.xaml</c> URI is used (the resource loader
    /// maps it to the sibling compiled <c>.xbf</c>).
    /// </summary>
    private static IEnumerable<Uri> DiscoverUserResourceDictionaries(string stagedRoot, string asmName)
    {
        var uris = new List<Uri>();
        foreach (var xamlFile in Directory.EnumerateFiles(stagedRoot, "*.xaml", SearchOption.AllDirectories))
        {
            if (!IsResourceDictionaryRoot(xamlFile))
            {
                continue;
            }
            var rel = Path.GetRelativePath(stagedRoot, xamlFile).Replace('\\', '/');
            uris.Add(new Uri($"ms-appx:///{asmName}/{rel}"));
        }
        // Deterministic order so 'Themes/…' etc. merge the same way every run.
        uris.Sort((a, b) => string.CompareOrdinal(a.AbsoluteUri, b.AbsoluteUri));
        return uris;
    }

    /// <summary>Cheaply checks whether a XAML file's root element is <c>ResourceDictionary</c>.</summary>
    private static bool IsResourceDictionaryRoot(string xamlPath)
    {
        try
        {
            using var reader = System.Xml.XmlReader.Create(xamlPath,
                new System.Xml.XmlReaderSettings { IgnoreComments = true, IgnoreWhitespace = true });
            while (reader.Read())
            {
                if (reader.NodeType == System.Xml.XmlNodeType.Element)
                {
                    return string.Equals(reader.LocalName, "ResourceDictionary", StringComparison.Ordinal);
                }
            }
        }
        catch
        {
            // Unreadable/odd file — treat as "not a resource dictionary".
        }
        return false;
    }

    /// <summary>
    /// Collects every <see cref="string"/> key reachable from <paramref name="root"/>, recursing its
    /// <c>MergedDictionaries</c> and <c>ThemeDictionaries</c>. Non-string keys (the <see cref="Type"/>
    /// keys of implicit styles) are ignored. Best-effort and defensive.
    /// </summary>
    private static HashSet<string> CollectResourceKeys(ResourceDictionary root)
    {
        var keys = new HashSet<string>(StringComparer.Ordinal);
        var seen = new HashSet<ResourceDictionary>();
        var stack = new Stack<ResourceDictionary>();
        stack.Push(root);

        while (stack.Count > 0)
        {
            var rd = stack.Pop();
            if (rd is null || !seen.Add(rd))
            {
                continue;
            }

            try
            {
                foreach (var k in rd.Keys)
                {
                    if (k is string s)
                    {
                        keys.Add(s);
                    }
                }
            }
            catch { /* some native dictionaries throw on Keys enumeration */ }

            try
            {
                foreach (var merged in rd.MergedDictionaries)
                {
                    if (merged is not null)
                    {
                        stack.Push(merged);
                    }
                }
            }
            catch { /* ignore */ }

            try
            {
                foreach (var value in rd.ThemeDictionaries.Values)
                {
                    if (value is ResourceDictionary themed)
                    {
                        stack.Push(themed);
                    }
                }
            }
            catch { /* ignore */ }
        }

        return keys;
    }

    // ---------------------------------------------------------------------------
    // IXamlMetadataProvider — consulted by XamlReader.Load through Application.Current.
    // Each call first consults the surface's own metadata, then the user provider.
    // ---------------------------------------------------------------------------

    public IXamlType GetXamlType(Type type)
    {
        ExceptionDispatchInfo? firstThrow = null;
        foreach (var provider in _providers)
        {
            IXamlType? xamlType = null;
            try
            {
                xamlType = provider.GetXamlType(type);
            }
            catch (Exception ex)
            {
                // Fail-safe (Layer 1): a chained closure provider that throws on lookup must not PREVENT a
                // later provider in the chain from resolving the type — so capture the throw and keep going.
                Log($"LAYER 1: provider {provider.GetType().FullName} threw on GetXamlType(Type '{type?.FullName}'): {ex.GetType().Name}; skipping.");
                firstThrow ??= ExceptionDispatchInfo.Capture(ex);
            }
            if (xamlType != null)
            {
                return xamlType;
            }
        }
        // If a provider threw AND no provider could resolve the type, re-throw the original (managed,
        // catchable) exception rather than returning null. Swallowing it is unsafe: when the caller is
        // WinRT resource enumeration (CollectResourceKeys → IMap.First marshaling a KeyValuePair), a
        // null-typed value drives native code into an UNCATCHABLE access violation (0xC0000005) that
        // fast-fails the whole process before it can emit SURFACE_PORT. Callers already guard the throw.
        firstThrow?.Throw();
        return null!;
    }

    public IXamlType GetXamlType(string fullName)
    {
        ExceptionDispatchInfo? firstThrow = null;
        foreach (var provider in _providers)
        {
            IXamlType? xamlType = null;
            try
            {
                xamlType = provider.GetXamlType(fullName);
            }
            catch (Exception ex)
            {
                // Fail-safe (Layer 1): see GetXamlType(Type) — an additive closure provider must never be
                // able to throw a *resolvable-by-a-later-provider* type off the rails, so keep chaining.
                Log($"LAYER 1: provider {provider.GetType().FullName} threw on GetXamlType('{fullName}'): {ex.GetType().Name}; skipping.");
                firstThrow ??= ExceptionDispatchInfo.Capture(ex);
            }
            if (xamlType != null)
            {
                return xamlType;
            }
        }
        // No provider resolved it but one threw: re-throw (managed/catchable) instead of returning null.
        // A swallowed resolution-throw becomes an uncatchable native AV in WinRT resource-key enumeration
        // (CollectResourceKeys' managed catch relies on GetXamlType surfacing the throw). See GetXamlType(Type).
        firstThrow?.Throw();
        return null!;
    }

    public XmlnsDefinition[] GetXmlnsDefinitions()
    {
        // Fail-safe (Layer 1): aggregate defensively so one throwing closure provider cannot break the
        // xmlns table the whole document relies on; a failed provider simply contributes nothing.
        var defs = new List<XmlnsDefinition>();
        foreach (var provider in _providers)
        {
            try
            {
                defs.AddRange(provider.GetXmlnsDefinitions());
            }
            catch (Exception ex)
            {
                Log($"LAYER 1: provider {provider.GetType().FullName} threw on GetXmlnsDefinitions: {ex.GetType().Name}; skipping.");
            }
        }
        return defs.ToArray();
    }

    internal static void Log(string message)
    {
        var line = $"[Surface] {message}";
        // Diagnostics go to STDERR so STDOUT stays reserved for the single clean
        // SURFACE_PORT=<port> handshake line the extension parses.
        try { Console.Error.WriteLine(line); } catch { }
        try
        {
            File.AppendAllText(
                Path.Combine(Paths.SurfaceRoot, "surface-run.log"),
                DateTime.Now.ToString("HH:mm:ss.fff") + " " + line + Environment.NewLine);
        }
        catch
        {
            // best-effort logging only
        }
    }
}
