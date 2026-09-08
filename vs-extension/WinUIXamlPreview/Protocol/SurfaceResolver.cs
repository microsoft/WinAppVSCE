#nullable enable

using System;
using System.IO;
using System.Linq;

namespace WinUIXamlPreview.Protocol
{
    /// <summary>
    /// Locates the prebuilt <c>Surface.exe</c>. Resolution order:
    /// 1. explicit <paramref name="preferred"/> path (from options),
    /// 2. <c>WINUI_SURFACE_EXE</c> environment variable,
    /// 3. the copy bundled inside the installed extension (<c>&lt;extensionDir&gt;\Surface\Surface.exe</c>) —
    ///    this is what makes an installed VSIX "just work" on any project,
    /// 4. walk up from <paramref name="nearPath"/> (e.g. the active document) looking for a
    ///    <c>surface\Surface\bin\**\Surface.exe</c> build output, newest wins (dev/F5 convenience).
    /// </summary>
    internal static class SurfaceResolver
    {
        public static string? Resolve(string? preferred, string? nearPath, Action<string>? log = null)
        {
            log ??= _ => { };

            if (!string.IsNullOrWhiteSpace(preferred) && File.Exists(preferred))
            {
                log($"Surface resolved from options: {preferred}");
                return preferred;
            }

            var env = Environment.GetEnvironmentVariable("WINUI_SURFACE_EXE");
            if (!string.IsNullOrWhiteSpace(env) && File.Exists(env))
            {
                log($"Surface resolved from WINUI_SURFACE_EXE: {env}");
                return env;
            }

            var bundled = BundledSurface();
            if (bundled != null)
            {
                log($"Surface resolved from installed extension: {bundled}");
                return bundled;
            }

            var found = SearchUpwards(nearPath, log);
            if (found != null)
            {
                log($"Surface resolved by search: {found}");
            }

            return found;
        }

        /// <summary>
        /// The <c>Surface.exe</c> shipped inside the extension, next to this assembly under
        /// <c>Surface\</c>. Uses the assembly's own location (NOT
        /// <see cref="AppDomain.BaseDirectory"/>, which for an in-proc VS package is devenv's
        /// directory, not the extension install folder).
        /// </summary>
        private static string? BundledSurface()
        {
            try
            {
                var asmPath = typeof(SurfaceResolver).Assembly.Location;
                var asmDir = Path.GetDirectoryName(asmPath);
                if (string.IsNullOrEmpty(asmDir))
                {
                    return null;
                }

                var exe = Path.Combine(asmDir, "Surface", "Surface.exe");
                return File.Exists(exe) ? exe : null;
            }
            catch
            {
                return null;
            }
        }

        private static string? SearchUpwards(string? nearPath, Action<string> log)
        {
            var start = FirstExistingDir(nearPath)
                        ?? FirstExistingDir(AppDomain.CurrentDomain.BaseDirectory)
                        ?? FirstExistingDir(Environment.CurrentDirectory);

            var dir = start;
            for (int depth = 0; dir != null && depth < 30; depth++)
            {
                var surfaceRoot = Path.Combine(dir.FullName, "surface", "Surface", "bin");
                if (Directory.Exists(surfaceRoot))
                {
                    var exe = NewestSurfaceExe(surfaceRoot);
                    if (exe != null)
                    {
                        return exe;
                    }
                }

                dir = dir.Parent;
            }

            return null;
        }

        private static string? NewestSurfaceExe(string binRoot)
        {
            try
            {
                return Directory
                    .EnumerateFiles(binRoot, "Surface.exe", SearchOption.AllDirectories)
                    .OrderByDescending(File.GetLastWriteTimeUtc)
                    .FirstOrDefault();
            }
            catch
            {
                return null;
            }
        }

        private static DirectoryInfo? FirstExistingDir(string? path)
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                return null;
            }

            try
            {
                if (File.Exists(path))
                {
                    return new FileInfo(path).Directory;
                }

                if (Directory.Exists(path))
                {
                    return new DirectoryInfo(path);
                }
            }
            catch
            {
                // ignore malformed paths
            }

            return null;
        }
    }
}
