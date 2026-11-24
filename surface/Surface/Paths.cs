using System;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;

namespace Surface;

/// <summary>
/// Resolves on-disk locations relative to the running Surface executable so the
/// harness works regardless of where it is launched from.
/// </summary>
internal static class Paths
{
    private const string Tfm = "net10.0-windows10.0.26100.0";

    /// <summary>The <c>surface\</c> directory (repo\surface).</summary>
    public static string SurfaceRoot { get; } = FindSurfaceRoot();

    /// <summary>The <c>surface\out\</c> directory where JPEGs are written.</summary>
    public static string OutDir => Path.Combine(SurfaceRoot, "out");

    /// <summary>
    /// BB-049: <c>%LOCALAPPDATA%\WinUIXamlPreview\surface</c>, next to the extension's preview.log. An installed
    /// surface has no repo above it, so <see cref="SurfaceRoot"/> would put logs in the root of %LOCALAPPDATA%.
    /// </summary>
    public static string LogDir { get; } = ResolveLogDir();

    /// <summary>Per-file cap; a larger log is moved to <c>name.1.log</c> at startup.</summary>
    public const long MaxLogBytes = 5L * 1024 * 1024;

    public static string LogFile(string name) => Path.Combine(LogDir, name);

    /// <summary>Moves <paramref name="path"/> to <c>name.1.ext</c> once it is over <see cref="MaxLogBytes"/>.</summary>
    public static void RotateIfLarge(string path)
    {
        try
        {
            var info = new FileInfo(path);
            if (!info.Exists || info.Length <= MaxLogBytes)
            {
                return;
            }

            var backup = Path.Combine(
                Path.GetDirectoryName(path) ?? string.Empty,
                Path.GetFileNameWithoutExtension(path) + ".1" + Path.GetExtension(path));
            File.Move(path, backup, overwrite: true);
        }
        catch
        {
            // another surface is writing it; the next start rotates
        }
    }

    private static string ResolveLogDir()
    {
        try
        {
            var dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "WinUIXamlPreview",
                "surface");
            Directory.CreateDirectory(dir);
            return dir;
        }
        catch
        {
            return Path.GetTempPath();
        }
    }

    /// <summary>The current process architecture as an MSBuild platform folder name.</summary>
    public static string Platform =>
        RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.Arm64 => "ARM64",
            Architecture.X86 => "x86",
            _ => "x64",
        };

    /// <summary>
    /// Absolute path to the built TestUserApp.dll (the "user app" assembly the
    /// Surface loads at runtime). Searched under the sibling TestUserApp project's
    /// build output; prefers the folder matching this process's architecture.
    /// </summary>
    public static string TestUserAppDll => ResolveTestUserAppDll();

    private static string FindSurfaceRoot()
    {
        // Walk up from the executable until we find the spike root: the directory that
        // contains BOTH the Surface and TestUserApp project folders. (We cannot match on
        // the folder name "surface" alone, because the "Surface" project folder compares
        // equal to it case-insensitively.)
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            if (Directory.Exists(Path.Combine(dir.FullName, "TestUserApp")) &&
                Directory.Exists(Path.Combine(dir.FullName, "Surface")))
            {
                return dir.FullName;
            }
            dir = dir.Parent;
        }

        // Fallback: six levels up from the exe (…\surface\Surface\bin\<plat>\<cfg>\<tfm>\<rid>\).
        return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", ".."));
    }

    private static string ResolveTestUserAppDll()
    {
        var binRoot = Path.Combine(SurfaceRoot, "TestUserApp", "bin");

        // Preferred deterministic path (x64 Debug, no RID subfolder for the class lib).
        var preferred = Path.Combine(binRoot, Platform, "Debug", Tfm, "TestUserApp.dll");
        if (File.Exists(preferred))
        {
            return preferred;
        }

        // Otherwise search and pick the most recently built copy that matches this arch.
        if (Directory.Exists(binRoot))
        {
            var matches = Directory.GetFiles(binRoot, "TestUserApp.dll", SearchOption.AllDirectories);
            var best = matches
                .OrderByDescending(p => p.Contains(Platform, StringComparison.OrdinalIgnoreCase))
                .ThenByDescending(p => File.GetLastWriteTimeUtc(p))
                .FirstOrDefault();
            if (best != null)
            {
                return best;
            }
        }

        return preferred; // return the expected path so the error message is meaningful
    }
}
