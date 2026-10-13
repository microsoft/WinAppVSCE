#nullable enable

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using WinUIXamlPreview.Protocol;

namespace WinUIXamlPreview.UnitTests;

/// <summary>
/// Pure-logic unit tests for the extension's discovery code. Each test builds a throwaway project tree under
/// %TEMP% and asserts the decision the production code makes. Prints one PASS/FAIL line per check and a
/// "===== UNIT: N passed, M failed =====" summary; exit code 0 only when every check passes.
/// </summary>
internal static partial class Program
{
    private static int s_pass;
    private static int s_fail;
    private static readonly List<string> s_failures = new();
    private static string s_root = string.Empty;

    private static int Main()
    {
        s_root = Path.Combine(Path.GetTempPath(), "wxp-unit-" + Guid.NewGuid().ToString("N").Substring(0, 8));
        Directory.CreateDirectory(s_root);
        try
        {
            Run("HostArch", HostArchTests);
            Run("WasdkVersionDiscovery", WasdkVersionDiscoveryTests);
            Run("ProjectDllLocator", ProjectDllLocatorTests);
            Run("IsWinUiXaml", IsWinUiXamlTests);
            Run("SurfaceResolver", SurfaceResolverTests);
            Run("MatchedHostResolver", MatchedHostResolverTests);
            Run("LineDecoder", LineDecoderTests);
            Run("XamlSourceMap", XamlSourceMapTests);
            Run("DesignerSelection", DesignerSelectionTests);
        }
        finally
        {
            TryDelete(s_root);
            CleanBinStaging();
        }

        foreach (var f in s_failures)
        {
            Console.WriteLine("  FAILED: " + f);
        }
        Console.WriteLine($"===== UNIT: {s_pass} passed, {s_fail} failed =====");
        return s_fail == 0 ? 0 : 1;
    }

    private static void Run(string group, Action body)
    {
        Console.WriteLine($"--- {group}");
        try
        {
            body();
        }
        catch (Exception ex)
        {
            Check($"{group}: no unexpected exception", false, ex.ToString());
        }
    }

    private static void Check(string name, bool ok, string? detail = null)
    {
        if (ok)
        {
            s_pass++;
            Console.WriteLine("PASS " + name);
        }
        else
        {
            s_fail++;
            var line = detail is null ? name : $"{name} ({detail})";
            s_failures.Add(line);
            Console.WriteLine("FAIL " + line);
        }
    }

    private static void Eq<T>(string name, T expected, T actual) =>
        Check(name, EqualityComparer<T>.Default.Equals(expected, actual), $"expected '{expected}', got '{actual}'");

    // ---------------------------------------------------------------- fixtures

    private static string NewDir(string name)
    {
        var d = Path.Combine(s_root, name + "-" + Guid.NewGuid().ToString("N").Substring(0, 6));
        Directory.CreateDirectory(d);
        return d;
    }

    private static string Write(string path, string content)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content);
        return path;
    }

    private static string Csproj(string dir, string name, string body = "") =>
        Write(Path.Combine(dir, name + ".csproj"), $"<Project Sdk=\"Microsoft.NET.Sdk\">{body}</Project>");

    private static string PkgRef(string version) =>
        $"<ItemGroup><PackageReference Include=\"Microsoft.WindowsAppSDK\" Version=\"{version}\" /></ItemGroup>";

    private static string Page(string dir, string name = "MainPage.xaml", string markup =
        "<Page xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" />") =>
        Write(Path.Combine(dir, name), markup);

    /// <summary>Minimal PE image: MZ + e_lfanew → "PE\0\0" + IMAGE_FILE_HEADER.Machine.</summary>
    private static byte[] Pe(ushort machine, int peOffset = 0x80)
    {
        var b = new byte[Math.Max(peOffset + 64, 0x100)];
        b[0] = (byte)'M';
        b[1] = (byte)'Z';
        BitConverter.GetBytes(peOffset).CopyTo(b, 0x3C);
        b[peOffset] = (byte)'P';
        b[peOffset + 1] = (byte)'E';
        BitConverter.GetBytes(machine).CopyTo(b, peOffset + 4);
        return b;
    }

    private static string WriteBytes(string path, byte[] bytes)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllBytes(path, bytes);
        return path;
    }

    private static void SetTime(string path, int minutesAgo) =>
        File.SetLastWriteTimeUtc(path, DateTime.UtcNow.AddMinutes(-minutesAgo));

    private static void TryDelete(string dir)
    {
        try
        {
            if (Directory.Exists(dir))
            {
                Directory.Delete(dir, recursive: true);
            }
        }
        catch
        {
            // best effort
        }
    }

    private static ushort ForeignMachine => HostArch.Machine == HostArch.MachineArm64 ? HostArch.MachineAmd64 : HostArch.MachineArm64;

    // ---------------------------------------------------------------- HostArch

    private static void HostArchTests()
    {
        var d = NewDir("arch");
        Eq("ReadMachine: AMD64 header", (ushort?)HostArch.MachineAmd64, HostArch.ReadMachine(WriteBytes(Path.Combine(d, "a.dll"), Pe(HostArch.MachineAmd64))));
        Eq("ReadMachine: ARM64 header", (ushort?)HostArch.MachineArm64, HostArch.ReadMachine(WriteBytes(Path.Combine(d, "b.dll"), Pe(HostArch.MachineArm64))));
        Eq("ReadMachine: I386 header (non-default e_lfanew)", (ushort?)HostArch.MachineI386, HostArch.ReadMachine(WriteBytes(Path.Combine(d, "c.dll"), Pe(HostArch.MachineI386, 0xC0))));
        Eq("ReadMachine: missing file -> null", (ushort?)null, HostArch.ReadMachine(Path.Combine(d, "nope.dll")));
        Eq("ReadMachine: too short -> null", (ushort?)null, HostArch.ReadMachine(WriteBytes(Path.Combine(d, "short.dll"), new byte[] { (byte)'M', (byte)'Z', 0, 0 })));

        var noMz = Pe(HostArch.MachineAmd64);
        noMz[0] = (byte)'X';
        Eq("ReadMachine: no MZ -> null", (ushort?)null, HostArch.ReadMachine(WriteBytes(Path.Combine(d, "nomz.dll"), noMz)));

        var badPe = Pe(HostArch.MachineAmd64);
        badPe[0x81] = (byte)'X';
        Eq("ReadMachine: bad PE signature -> null", (ushort?)null, HostArch.ReadMachine(WriteBytes(Path.Combine(d, "badpe.dll"), badPe)));

        var negOffset = Pe(HostArch.MachineAmd64);
        BitConverter.GetBytes(-4).CopyTo(negOffset, 0x3C);
        Eq("ReadMachine: negative e_lfanew -> null", (ushort?)null, HostArch.ReadMachine(WriteBytes(Path.Combine(d, "neg.dll"), negOffset)));

        var pastEnd = Pe(HostArch.MachineAmd64);
        BitConverter.GetBytes(pastEnd.Length - 2).CopyTo(pastEnd, 0x3C);
        Eq("ReadMachine: e_lfanew past end -> null", (ushort?)null, HostArch.ReadMachine(WriteBytes(Path.Combine(d, "past.dll"), pastEnd)));

        Check("CanHostLoad: native machine", HostArch.CanHostLoad(WriteBytes(Path.Combine(d, "native.dll"), Pe(HostArch.Machine))));
        Check("CanHostLoad: I386 (AnyCPU IL) loads anywhere", HostArch.CanHostLoad(Path.Combine(d, "c.dll")));
        Check("CanHostLoad: foreign machine refused", !HostArch.CanHostLoad(WriteBytes(Path.Combine(d, "foreign.dll"), Pe(ForeignMachine))));
        Check("CanHostLoad: unreadable header -> permissive", HostArch.CanHostLoad(Path.Combine(d, "short.dll")));

        Eq("Platform/Rid/SurfaceDirName agree",
            HostArch.IsArm64 ? "ARM64|win-arm64|Surface-arm64" : "x64|win-x64|Surface",
            $"{HostArch.Platform}|{HostArch.Rid}|{HostArch.SurfaceDirName}");

        var ext = NewDir("ext");
        Eq("BundledSurfaceDir: nothing -> null", (string?)null, HostArch.BundledSurfaceDir(ext));
        Directory.CreateDirectory(Path.Combine(ext, HostArch.SurfaceDirName));
        Eq("BundledSurfaceDir: native dir without Surface.exe -> null", (string?)null, HostArch.BundledSurfaceDir(ext));
        if (HostArch.SurfaceDirName != "Surface")
        {
            Write(Path.Combine(ext, "Surface", "Surface.exe"), "x");
            Eq("BundledSurfaceDir: falls back to Surface\\", Path.Combine(ext, "Surface"), HostArch.BundledSurfaceDir(ext));
        }
        Write(Path.Combine(ext, HostArch.SurfaceDirName, "Surface.exe"), "x");
        Eq("BundledSurfaceDir: prefers native dir", Path.Combine(ext, HostArch.SurfaceDirName), HostArch.BundledSurfaceDir(ext));
    }

    // ---------------------------------------------------------------- WasdkVersionDiscovery

    private static void WasdkVersionDiscoveryTests()
    {
        Eq("null path -> NotFound", WasdkVersionSource.NotFound, WasdkVersionDiscovery.Discover(null).Source);
        Eq("whitespace path -> NotFound", WasdkVersionSource.NotFound, WasdkVersionDiscovery.Discover("   ").Source);
        Eq("nonexistent path -> NotFound", WasdkVersionSource.NotFound, WasdkVersionDiscovery.Discover(Path.Combine(s_root, "no", "where", "x.xaml")).Source);

        // No project at all (isolated volume-root-free tree: s_root itself has no csproj).
        var bare = NewDir("bare");
        var r = WasdkVersionDiscovery.Discover(Page(bare));
        Check("no csproj -> NotFound", !r.Found && r.Source == WasdkVersionSource.NotFound, $"{r.Source} {r.Version}");

        // csproj PackageReference only.
        var p1 = NewDir("csproj-only");
        Csproj(p1, "App1", PkgRef("1.6.250108002"));
        r = WasdkVersionDiscovery.Discover(Page(p1));
        Eq("csproj PackageReference version", "1.6.250108002", r.Version);
        Eq("csproj PackageReference source", WasdkVersionSource.CsprojPackageReference, r.Source);

        // Page in a sub-folder still finds the owning csproj.
        var sub = Page(Path.Combine(p1, "Views", "Deep"), "Sub.xaml");
        Eq("nested page walks up to csproj", "1.6.250108002", WasdkVersionDiscovery.Discover(sub).Version);
        Eq("FindOwningCsproj from nested page", Path.Combine(p1, "App1.csproj"), WasdkVersionDiscovery.FindOwningCsproj(sub));

        // Central package management (Include and Update forms, attribute and child <Version>).
        var cpm = NewDir("cpm");
        Write(Path.Combine(cpm, "Directory.Packages.props"),
            "<Project><ItemGroup><PackageVersion Include=\"Microsoft.WindowsAppSDK\" Version=\" 2.2.5 \" /></ItemGroup></Project>");
        var cpmProj = Path.Combine(cpm, "src", "App");
        Csproj(cpmProj, "App", "<ItemGroup><PackageReference Include=\"Microsoft.WindowsAppSDK\" /></ItemGroup>");
        r = WasdkVersionDiscovery.Discover(Page(cpmProj));
        Eq("Directory.Packages.props (walked up, trimmed)", "2.2.5", r.Version);
        Eq("Directory.Packages.props source", WasdkVersionSource.DirectoryPackagesProps, r.Source);

        var cpm2 = NewDir("cpm-update");
        Write(Path.Combine(cpm2, "Directory.Packages.props"),
            "<Project><ItemGroup><PackageVersion Update=\"Microsoft.WindowsAppSDK\"><Version>2.0.1</Version></PackageVersion></ItemGroup></Project>");
        Csproj(cpm2, "App");
        Eq("Directory.Packages.props Update= + child <Version>", "2.0.1", WasdkVersionDiscovery.Discover(Page(cpm2)).Version);

        // project.assets.json wins over everything; Foundation sub-package must not be mistaken for the metapackage.
        var assets = NewDir("assets");
        Write(Path.Combine(assets, "Directory.Packages.props"),
            "<Project><ItemGroup><PackageVersion Include=\"Microsoft.WindowsAppSDK\" Version=\"2.0.0\" /></ItemGroup></Project>");
        Csproj(assets, "App", PkgRef("1.0.0"));
        Write(Path.Combine(assets, "obj", "project.assets.json"),
            "{ \"version\": 3, \"libraries\": { " +
            "\"Microsoft.WindowsAppSDK.Foundation/9.9.9\": { \"type\": \"package\" }, " +
            "\"microsoft.windowsappsdk/2.2.7\": { \"type\": \"package\" } } }");
        r = WasdkVersionDiscovery.Discover(Page(assets));
        Eq("project.assets.json resolved version wins", "2.2.7", r.Version);
        Eq("project.assets.json source", WasdkVersionSource.ProjectAssetsJson, r.Source);

        // Assets file without the metapackage (only Foundation) falls through to the next source.
        var foundationOnly = NewDir("assets-foundation-only");
        Csproj(foundationOnly, "App", PkgRef("1.7.0"));
        Write(Path.Combine(foundationOnly, "obj", "project.assets.json"),
            "{ \"libraries\": { \"Microsoft.WindowsAppSDK.Foundation/9.9.9\": {} } }");
        r = WasdkVersionDiscovery.Discover(Page(foundationOnly));
        Check("assets with only Foundation falls through to csproj", r.Version == "1.7.0" && r.Source == WasdkVersionSource.CsprojPackageReference, $"{r.Source} {r.Version}");

        // Malformed sources fall through instead of throwing.
        var bad = NewDir("malformed");
        Write(Path.Combine(bad, "Directory.Packages.props"), "<Project><ItemGroup>");
        Csproj(bad, "App", PkgRef("1.5.0"));
        Write(Path.Combine(bad, "obj", "project.assets.json"), "{ not json");
        r = WasdkVersionDiscovery.Discover(Page(bad));
        Check("malformed assets + props fall through to csproj", r.Version == "1.5.0" && r.Source == WasdkVersionSource.CsprojPackageReference, $"{r.Source} {r.Version}");

        var badProj = NewDir("malformed-csproj");
        Write(Path.Combine(badProj, "App.csproj"), "<Project <<<");
        r = WasdkVersionDiscovery.Discover(Page(badProj));
        Check("malformed csproj -> NotFound (no throw)", !r.Found, $"{r.Source} {r.Version}");

        // Non-WinUI project.
        var wpf = NewDir("wpf");
        Csproj(wpf, "Wpf", "<PropertyGroup><UseWPF>true</UseWPF></PropertyGroup>");
        Check("project without WASDK -> NotFound", !WasdkVersionDiscovery.Discover(Page(wpf)).Found);
    }

    // ---------------------------------------------------------------- ProjectDllLocator

    private static void ProjectDllLocatorTests()
    {
        Eq("FindUserDll: null -> null", (string?)null, ProjectDllLocator.FindUserDll(null));

        var noBin = NewDir("nobin");
        Csproj(noBin, "MyApp");
        Eq("FindUserDll: no bin -> null", (string?)null, ProjectDllLocator.FindUserDll(Page(noBin)));

        var empty = NewDir("emptybin");
        Csproj(empty, "MyApp");
        Directory.CreateDirectory(Path.Combine(empty, "bin", "Debug"));
        WriteBytes(Path.Combine(empty, "bin", "Debug", "Other.dll"), Pe(HostArch.Machine));
        Eq("FindUserDll: only other assemblies -> null", (string?)null, ProjectDllLocator.FindUserDll(Page(empty)));

        // Name comes from the csproj file name; newest wins.
        var p = NewDir("newest");
        Csproj(p, "MyApp");
        var older = WriteBytes(Path.Combine(p, "bin", "x64", "Debug", "net8.0-windows10.0.19041.0", "MyApp.dll"), Pe(HostArch.Machine));
        var newer = WriteBytes(Path.Combine(p, "bin", "x64", "Release", "net8.0-windows10.0.19041.0", "MyApp.dll"), Pe(HostArch.Machine));
        SetTime(older, 30);
        SetTime(newer, 5);
        var page = Page(p);
        Eq("FindUserDll: newest build", newer, ProjectDllLocator.FindUserDll(page));
        Check("NeedsPackagedIdentity: unpackaged builds -> false", !ProjectDllLocator.NeedsPackagedIdentity(Path.Combine(p, "MyApp.csproj")));

        // Prefers the build the host can load even if a foreign-arch build is newer.
        var a = NewDir("arch-pref");
        Csproj(a, "MyApp");
        var native = WriteBytes(Path.Combine(a, "bin", "native", "MyApp.dll"), Pe(HostArch.Machine));
        var foreign = WriteBytes(Path.Combine(a, "bin", "foreign", "MyApp.dll"), Pe(ForeignMachine));
        SetTime(native, 30);
        SetTime(foreign, 1);
        Eq("FindUserDll: prefers host-loadable arch over newer foreign arch", native, ProjectDllLocator.FindUserDll(Page(a)));

        var onlyForeign = NewDir("arch-only-foreign");
        Csproj(onlyForeign, "MyApp");
        var f1 = WriteBytes(Path.Combine(onlyForeign, "bin", "f", "MyApp.dll"), Pe(ForeignMachine));
        Eq("FindUserDll: only foreign arch -> still returns newest", f1, ProjectDllLocator.FindUserDll(Page(onlyForeign)));

        // Prefers an unpackaged build over a newer packaged (AppxManifest.xml) one.
        var pk = NewDir("packaged-pref");
        Csproj(pk, "MyApp");
        var unpackaged = WriteBytes(Path.Combine(pk, "bin", "unpkg", "MyApp.dll"), Pe(HostArch.Machine));
        var packaged = WriteBytes(Path.Combine(pk, "bin", "pkg", "MyApp.dll"), Pe(HostArch.Machine));
        Write(Path.Combine(pk, "bin", "pkg", "AppxManifest.xml"), "<Package/>");
        SetTime(unpackaged, 30);
        SetTime(packaged, 1);
        Eq("FindUserDll: prefers unpackaged over newer packaged", unpackaged, ProjectDllLocator.FindUserDll(Page(pk)));
        Check("IsPackagedBuild: AppxManifest.xml next to dll", ProjectDllLocator.IsPackagedBuild(packaged));
        Check("IsPackagedBuild: no manifest", !ProjectDllLocator.IsPackagedBuild(unpackaged));
        Check("NeedsPackagedIdentity: mixed -> false", !ProjectDllLocator.NeedsPackagedIdentity(Path.Combine(pk, "MyApp.csproj")));

        var onlyPk = NewDir("packaged-only");
        Csproj(onlyPk, "MyApp");
        var pkOnly = WriteBytes(Path.Combine(onlyPk, "bin", "pkg", "MyApp.dll"), Pe(HostArch.Machine));
        Write(Path.Combine(onlyPk, "bin", "pkg", "AppxManifest.xml"), "<Package/>");
        Eq("FindUserDll: only packaged -> returns it", pkOnly, ProjectDllLocator.FindUserDll(Page(onlyPk)));
        Check("NeedsPackagedIdentity: all packaged -> true", ProjectDllLocator.NeedsPackagedIdentity(Path.Combine(onlyPk, "MyApp.csproj")));
        Check("NeedsPackagedIdentity: no bin -> false", !ProjectDllLocator.NeedsPackagedIdentity(Path.Combine(noBin, "MyApp.csproj")));

        // App.xaml lookup.
        var app = NewDir("appxaml");
        Csproj(app, "MyApp");
        var nested = Page(Path.Combine(app, "Views"));
        Eq("FindAppXaml: none -> null", (string?)null, ProjectDllLocator.FindAppXaml(nested));
        var appXaml = Write(Path.Combine(app, "App.xaml"), "<Application/>");
        Eq("FindAppXaml: next to csproj", appXaml, ProjectDllLocator.FindAppXaml(nested));
        Eq("FindAppXaml: null -> null", (string?)null, ProjectDllLocator.FindAppXaml(null));
    }

    // ---------------------------------------------------------------- IsWinUiXaml / IsWinUiProject

    private static void IsWinUiXamlTests()
    {
        Check("null path -> true (never suppress)", ProjectDllLocator.IsWinUiXaml(null));

        (string label, string body, bool expected)[] csprojCases =
        {
            ("WindowsAppSDK PackageReference", PkgRef("2.2.0"), true),
            ("UseWinUI true (spaced/cased)", "<PropertyGroup><UseWinUI> TRUE </UseWinUI></PropertyGroup>", true),
            ("Microsoft.WinUI reference", "<ItemGroup><PackageReference Include=\"Microsoft.WinUI\" Version=\"3.0.0\" /></ItemGroup>", true),
            ("UseWPF true", "<PropertyGroup><UseWPF>true</UseWPF></PropertyGroup>", false),
            ("PresentationFramework reference", "<ItemGroup><Reference Include=\"PresentationFramework\" /></ItemGroup>", false),
            ("UWP uap10.0 TFM", "<PropertyGroup><TargetFramework>uap10.0.19041</TargetFramework></PropertyGroup>", false),
            ("UWP UniversalWindowsPlatform", "<ItemGroup><PackageReference Include=\"Microsoft.NETCore.UniversalWindowsPlatform\" /></ItemGroup>", false),
            ("UWP TargetPlatformIdentifier", "<PropertyGroup><TargetPlatformIdentifier>UAP</TargetPlatformIdentifier></PropertyGroup>", false),
            ("UseWinUI false is not WinUI (and falls to markup -> true)", "<PropertyGroup><UseWinUI>false</UseWinUI></PropertyGroup>", true),
            ("WinUI wins over WPF markers", PkgRef("2.2.0") + "<PropertyGroup><UseWPF>true</UseWPF></PropertyGroup>", true),
        };
        foreach (var (label, body, expected) in csprojCases)
        {
            var d = NewDir("kind");
            Csproj(d, "App", body);
            Eq("IsWinUiXaml csproj: " + label, expected, ProjectDllLocator.IsWinUiXaml(Page(d)));
        }

        // Inconclusive csproj, markers in a parent Directory.Build.props.
        var parent = NewDir("props-winui");
        Write(Path.Combine(parent, "Directory.Build.props"), "<Project><PropertyGroup><UseWinUI>true</UseWinUI></PropertyGroup></Project>");
        var child = Path.Combine(parent, "src", "App");
        Csproj(child, "App");
        // Markup that would otherwise look WPF: the props verdict must win first.
        Check("Directory.Build.props UseWinUI -> true",
            ProjectDllLocator.IsWinUiXaml(Page(child, markup: "<Page xmlns:l=\"clr-namespace:Foo\" />")));
        Check("IsWinUiProject via Directory.Build.props", ProjectDllLocator.IsWinUiProject(Path.Combine(child, "App.csproj")));

        var wpfParent = NewDir("props-wpf");
        Write(Path.Combine(wpfParent, "Directory.Build.props"), "<Project><PropertyGroup><UseWPF>true</UseWPF></PropertyGroup></Project>");
        Csproj(Path.Combine(wpfParent, "App"), "App");
        Check("Directory.Build.props UseWPF -> false", !ProjectDllLocator.IsWinUiXaml(Page(Path.Combine(wpfParent, "App"))));
        Check("IsWinUiProject: WPF props -> false", !ProjectDllLocator.IsWinUiProject(Path.Combine(wpfParent, "App", "App.csproj")));

        var cpm = NewDir("props-cpm");
        Write(Path.Combine(cpm, "Directory.Packages.props"),
            "<Project><ItemGroup><PackageVersion Include=\"Microsoft.WindowsAppSDK\" Version=\"2.2.0\" /></ItemGroup></Project>");
        Csproj(Path.Combine(cpm, "App"), "App");
        Check("Directory.Packages.props WindowsAppSDK -> WinUI", ProjectDllLocator.IsWinUiXaml(Page(Path.Combine(cpm, "App"), markup: "<Page xmlns:l=\"clr-namespace:X\"/>")));

        // No project verdict -> markup heuristic.
        var none = NewDir("markup-only");
        Check("no csproj + clr-namespace markup -> false (WPF)", !ProjectDllLocator.IsWinUiXaml(Page(none, "Wpf.xaml", "<Window xmlns:l=\"clr-namespace:Foo;assembly=Bar\" />")));
        Check("no csproj + using: markup -> true", ProjectDllLocator.IsWinUiXaml(Page(none, "WinUi.xaml", "<Page xmlns:l=\"using:Foo\" />")));
        Check("missing file -> true", ProjectDllLocator.IsWinUiXaml(Path.Combine(none, "missing.xaml")));

        var plain = NewDir("plain");
        Csproj(plain, "Lib");
        Check("IsWinUiProject: plain csproj -> false", !ProjectDllLocator.IsWinUiProject(Path.Combine(plain, "Lib.csproj")));
        Check("IsWinUiProject: missing csproj -> false", !ProjectDllLocator.IsWinUiProject(Path.Combine(plain, "Missing.csproj")));
    }

    // ---------------------------------------------------------------- SurfaceResolver

    private static string BinDir => Path.GetDirectoryName(typeof(Program).Assembly.Location)!;
    private static readonly string[] s_binStaging = { "Surface", "Surface-arm64", "HostSDK" };

    private static void CleanBinStaging()
    {
        foreach (var d in s_binStaging)
        {
            TryDelete(Path.Combine(BinDir, d));
        }
    }

    private static void SurfaceResolverTests()
    {
        CleanBinStaging();
        var saved = Environment.GetEnvironmentVariable("WINUI_SURFACE_EXE");
        try
        {
            var d = NewDir("resolver");
            var preferred = Write(Path.Combine(d, "pref", "Surface.exe"), "x");
            var fromEnv = Write(Path.Combine(d, "env", "Surface.exe"), "x");
            Environment.SetEnvironmentVariable("WINUI_SURFACE_EXE", fromEnv);

            Eq("preferred path wins", preferred, SurfaceResolver.Resolve(preferred, null));
            Eq("missing preferred -> env var", fromEnv, SurfaceResolver.Resolve(Path.Combine(d, "nope.exe"), null));

            // Bundled (next to the assembly) beats the upward search but loses to env.
            var bundled = Write(Path.Combine(BinDir, HostArch.SurfaceDirName, "Surface.exe"), "x");
            Eq("env var beats bundled", fromEnv, SurfaceResolver.Resolve(null, null));
            Environment.SetEnvironmentVariable("WINUI_SURFACE_EXE", Path.Combine(d, "gone.exe"));
            Eq("missing env -> bundled next to assembly", bundled, SurfaceResolver.Resolve(null, null));
            CleanBinStaging();

            // Upward search from the document: surface\Surface\bin\**\Surface.exe, newest wins.
            var repo = NewDir("repo");
            var oldExe = Write(Path.Combine(repo, "surface", "Surface", "bin", "x64", "Debug", "Surface.exe"), "x");
            var newExe = Write(Path.Combine(repo, "surface", "Surface", "bin", "x64", "Release", "Surface.exe"), "x");
            SetTime(oldExe, 30);
            SetTime(newExe, 2);
            var doc = Page(Path.Combine(repo, "samples", "App"));
            Eq("upward search from document, newest wins", newExe, SurfaceResolver.Resolve(null, doc));
            Eq("upward search from a directory path", newExe, SurfaceResolver.Resolve(null, Path.Combine(repo, "samples")));
        }
        finally
        {
            Environment.SetEnvironmentVariable("WINUI_SURFACE_EXE", saved);
            CleanBinStaging();
        }
    }

    // ---------------------------------------------------------------- MatchedHostResolver

    private static void StageBundled(string version)
    {
        var dir = Path.Combine(BinDir, HostArch.SurfaceDirName);
        Write(Path.Combine(dir, "Surface.exe"), "x");
        Write(Path.Combine(dir, "Surface.wasdk.version"), version + "\r\n");
    }

    private static void StageHostSdk(bool complete)
    {
        var sdk = Path.Combine(BinDir, "HostSDK");
        Write(Path.Combine(sdk, "SurfaceProvisioner", "SurfaceProvisioner.dll"), "x");
        Write(Path.Combine(sdk, "surface", "Surface", "Surface.csproj"), "<Project/>");
        if (complete)
        {
            Write(Path.Combine(sdk, "DesignHost", "DesignHost.csproj"), "<Project/>");
        }
    }

    private static void MatchedHostResolverTests()
    {
        var saved = Environment.GetEnvironmentVariable("WINUI_SURFACE_EXE");
        Environment.SetEnvironmentVariable("WINUI_SURFACE_EXE", null);
        CleanBinStaging();
        try
        {
            StageBundled("2.2.0");
            Eq("BundledVersion read + trimmed", "2.2.0", MatchedHostResolver.BundledVersion);
            Check("IsBundledCompatible: case-insensitive", MatchedHostResolver.IsBundledCompatible("2.2.0") && !MatchedHostResolver.IsBundledCompatible("2.2.5"));
            Check("IsBundledCompatible: prerelease tag case-insensitive", Stage("2.3.0-Preview1", () => MatchedHostResolver.IsBundledCompatible("2.3.0-preview1")));
            StageBundled("2.2.0");
            var bundledExe = Path.Combine(BinDir, HostArch.SurfaceDirName, "Surface.exe");

            // Same version: baseline, nothing to do.
            var same = NewDir("mh-same");
            Csproj(same, "App", PkgRef("2.2.0"));
            var s = MatchedHostResolver.Resolve(Page(same));
            Check("same version: bundled exe, no upgrade, no note",
                s.ExePath == bundledExe && !s.NeedsUpgrade && s.Upgrade == HostUpgradeKind.None && s.Note is null && s.Fidelity == HostFidelity.Baseline,
                Describe(s));
            Eq("same version: label", "2.2.0", s.VersionLabel);
            Eq("same version: target project", Path.Combine(same, "App.csproj"), s.TargetProject);

            // No WASDK version: label falls back to the bundled version, no note.
            var unknown = NewDir("mh-unknown");
            Csproj(unknown, "App");
            s = MatchedHostResolver.Resolve(Page(unknown));
            Check("unknown version: label = bundled, no upgrade, no note",
                s.VersionLabel == "2.2.0" && s.TargetVersion is null && !s.NeedsUpgrade && s.Note is null, Describe(s));

            // Different version, build inputs missing: note, no upgrade.
            var diff = NewDir("mh-diff");
            Csproj(diff, "App", PkgRef("2.2.5"));
            s = MatchedHostResolver.Resolve(Page(diff));
            Check("mismatch + no HostSDK: note set, no upgrade",
                !s.NeedsUpgrade && s.Upgrade == HostUpgradeKind.None && s.Note is not null && s.Note.Contains("2.2.5") && s.VersionLabel == "2.2.5",
                Describe(s));

            StageHostSdk(complete: false);
            s = MatchedHostResolver.Resolve(Page(diff));
            Check("mismatch + incomplete HostSDK: still no upgrade", !s.NeedsUpgrade && s.Note is not null, Describe(s));

            StageHostSdk(complete: true);
            var probe = HostBuildEnvironment.Probe();
            if (probe.DotnetPath is null)
            {
                Check("mismatch + HostSDK + no dotnet: no upgrade", !MatchedHostResolver.Resolve(Page(diff)).NeedsUpgrade);
            }
            else
            {
                Check("Probe: complete HostSDK + dotnet -> CanBuild", probe.CanBuild, probe.Reason);
                s = MatchedHostResolver.Resolve(Page(diff));
                Check("mismatch + buildable: NeedsUpgrade=Build, no note",
                    s.NeedsUpgrade && s.Upgrade == HostUpgradeKind.Build && s.Note is null && s.TargetVersion == "2.2.5" &&
                    s.TargetProject == Path.Combine(diff, "App.csproj") && s.ExePath == bundledExe,
                    Describe(s));

                // Same version never builds even when it could.
                Check("same version + buildable: no upgrade", !MatchedHostResolver.Resolve(Page(same)).NeedsUpgrade);
            }

            // No project: a version can't be discovered, so nothing to match.
            var orphan = NewDir("mh-orphan");
            s = MatchedHostResolver.Resolve(Page(orphan));
            Check("no project: no upgrade, no note, null target", !s.NeedsUpgrade && s.Note is null && s.TargetProject is null, Describe(s));

            // Probe reasons.
            CleanBinStaging();
            var p = HostBuildEnvironment.Probe();
            Check("Probe: empty HostSDK -> cannot build", !p.CanBuild && !string.IsNullOrEmpty(p.Reason), p.Reason);

            // No bundled host at all: degrade (null exe/version), never throw.
            Check("no bundled host: BundledVersion is null", MatchedHostResolver.BundledVersion is null);
            Check("no bundled host: IsBundledCompatible false", !MatchedHostResolver.IsBundledCompatible("2.2.0"));
            HostSelection? missing = null;
            var threw = Throws<Exception>(() => missing = MatchedHostResolver.Resolve(Page(diff)));
            Check("no bundled host + known version: Resolve does not throw", !threw);
            Check("no bundled host: null exe, no upgrade, version label kept",
                missing is not null && missing.ExePath is null && !missing.NeedsUpgrade && missing.VersionLabel == "2.2.5",
                missing is null ? "null" : Describe(missing));
            threw = Throws<Exception>(() => missing = MatchedHostResolver.Resolve(Page(unknown)));
            Check("no bundled host + unknown version: no throw, null label", !threw && missing!.VersionLabel is null);

            // engine.stamp: 64 chars accepted (trimmed), anything else rejected.
            var stamp = new string('a', 64);
            Write(Path.Combine(BinDir, "HostSDK", "engine.stamp"), "  " + stamp + "\r\n");
            Eq("ShippedEngineStamp: 64-char stamp (trimmed)", stamp, MatchedHostResolver.ShippedEngineStamp);
            Write(Path.Combine(BinDir, "HostSDK", "engine.stamp"), "abc");
            Check("ShippedEngineStamp: short stamp throws InvalidDataException", Throws<InvalidDataException>(() => _ = MatchedHostResolver.ShippedEngineStamp));
            File.Delete(Path.Combine(BinDir, "HostSDK", "engine.stamp"));
            Check("ShippedEngineStamp: missing stamp throws", Throws<Exception>(() => _ = MatchedHostResolver.ShippedEngineStamp));
        }
        finally
        {
            Environment.SetEnvironmentVariable("WINUI_SURFACE_EXE", saved);
            CleanBinStaging();
        }
    }

    private static bool Stage(string version, Func<bool> body)
    {
        StageBundled(version);
        return body();
    }

    private static bool Throws<T>(Action a) where T : Exception
    {
        try
        {
            a();
            return false;
        }
        catch (T)
        {
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static string Describe(HostSelection s) =>
        $"exe={s.ExePath}, label={s.VersionLabel}, target={s.TargetVersion}, project={s.TargetProject}, " +
        $"needsUpgrade={s.NeedsUpgrade}, upgrade={s.Upgrade}, note={s.Note}";
}
