#nullable enable

using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace WinUIXamlPreview.Protocol
{
    /// <summary>
    /// Gives the bundled <c>Surface.exe</c> a <b>sparse (external-location) package identity</b> at runtime
    /// so it can host <b>packaged (MSIX-built)</b> user assemblies.
    ///
    /// A packaged user assembly has the Windows App SDK <c>DeploymentManager</c> auto-initializer compiled
    /// into its module <c>.cctor</c>; it calls <c>DeploymentManager.Initialize()</c>, which throws
    /// <i>"The process has no package identity"</i> inside an unpackaged host, so the app's generated
    /// <c>XamlTypeInfo</c> provider can't be instantiated and custom controls vanish. Registering the surface
    /// as a sparse package (external location = its own folder) makes a direct launch of the exe run <i>with</i>
    /// identity, satisfying that gate. The exe carries a matching <c>&lt;msix&gt;</c> element in its manifest
    /// (embedded post-build); that element is inert until this package is registered, so the same exe still
    /// launches unpackaged for non-packaged projects (dual-mode). See plan §38.
    ///
    /// This is now a <b>fallback</b>: the surface normally loads packaged builds without identity by disabling
    /// the deployment auto-initializer in memory (Surface <c>PackagedAppShim</c>). Registration only runs after a
    /// surface reports <see cref="SurfaceClient.IdentityRequiredMarker"/> (see <see cref="RequestFallback"/>).
    ///
    /// Registration is one-time per external-location folder (cached for the process) and requires Windows
    /// Developer Mode (or a trusted signature) to register a loose external-location package. All failures are
    /// non-fatal: the surface still renders framework types, just not packaged custom types.
    /// </summary>
    internal static class SurfaceIdentity
    {
#if MIGRATION_IDENTITY
        public const string PackageName = "WinUIXamlPreviewSurface.Migration24e47e37";
        public const bool IsExperimental = true;
#else
        public const string PackageName = "WinUIXamlPreviewSurface";
        public const bool IsExperimental = false;
#endif
        public const string Publisher = "CN=WinUIXamlPreview";
        public const string AppId = "Surface";

        /// <summary>
        /// Deterministic package family name (<c>PackageName_{hash(Publisher)}</c>); stable across machines
        /// because it derives only from the fixed publisher. For reference / diagnostics.
        /// </summary>
        public const string FamilyName = PackageName + "_p47s87298xgjw";

        public const string ManifestFileName = "AppxManifest.xml";

        private static readonly object Gate = new object();
        private static string? _registeredForDir;
        private static Task<bool>? _pending;
        private static string? _pendingDir;
        private static int _fallbackRequested;

        /// <summary>
        /// True once a surface reported <see cref="SurfaceClient.IdentityRequiredMarker"/> this VS session.
        /// Registration is skipped until then: the surface normally loads packaged builds without identity
        /// (PackagedAppShim).
        /// </summary>
        public static bool FallbackActive => Volatile.Read(ref _fallbackRequested) != 0;

        /// <summary>Raised (once per VS session, on a background thread) when the identity fallback activates.</summary>
        public static event Action? FallbackRequested;

        /// <summary>Activates the identity fallback. Only the first call raises <see cref="FallbackRequested"/>.</summary>
        public static void RequestFallback(Action<string>? log = null)
        {
            if (Interlocked.Exchange(ref _fallbackRequested, 1) != 0)
            {
                return;
            }

            log?.Invoke("Identity: surface reported it needs package identity; enabling sparse-identity fallback.");
            try { FallbackRequested?.Invoke(); }
            catch (Exception ex) { log?.Invoke("Identity fallback handler failed: " + ex.Message); }
        }

        /// <summary>
        /// Shared, de-duplicated <see cref="EnsureRegistered"/>: a background prewarm and the preview open path
        /// await the SAME in-flight registration for a folder instead of running PowerShell twice. A failed
        /// attempt is not cached, so the next caller retries.
        /// </summary>
        public static Task<bool> EnsureRegisteredAsync(string surfaceExePath, Action<string>? log = null)
        {
            string dir;
            try
            {
                dir = Path.GetDirectoryName(Path.GetFullPath(surfaceExePath))!;
            }
            catch
            {
                return Task.Run(() => EnsureRegistered(surfaceExePath, log));
            }

            lock (Gate)
            {
                if (_pending != null && string.Equals(_pendingDir, dir, StringComparison.OrdinalIgnoreCase))
                {
                    if (!_pending.IsCompleted)
                    {
                        return _pending;
                    }
                    if (!IsExperimental && _pending.Status == TaskStatus.RanToCompletion && _pending.Result)
                    {
                        return _pending;
                    }
                }

                _pendingDir = dir;
                _pending = Task.Run(() => EnsureRegistered(surfaceExePath, log));
                return _pending;
            }
        }

        /// <summary>
        /// True when the surface next to <paramref name="surfaceExePath"/> ships with the sparse-identity
        /// payload (an <see cref="ManifestFileName"/> beside the exe). A raw dev build has none, so identity
        /// can't be registered for it.
        /// </summary>
        public static bool HasIdentityPayload(string? surfaceExePath)
        {
            try
            {
                var dir = string.IsNullOrEmpty(surfaceExePath) ? null : Path.GetDirectoryName(surfaceExePath);
                return dir != null && File.Exists(Path.Combine(dir, ManifestFileName));
            }
            catch
            {
                return false;
            }
        }

        /// <summary>
        /// Ensures the sparse package is registered with external location = the surface's own folder.
        /// Idempotent and cached per folder. Returns <c>false</c> (with a logged reason) when the payload is
        /// missing or registration fails (e.g. Developer Mode is off) — callers should proceed regardless.
        /// Blocking (spawns Windows PowerShell); call off the UI thread.
        /// </summary>
        public static bool EnsureRegistered(string surfaceExePath, Action<string>? log = null)
        {
            log ??= _ => { };

            string surfaceDir;
            try
            {
                surfaceDir = Path.GetDirectoryName(Path.GetFullPath(surfaceExePath))!;
            }
            catch (Exception ex)
            {
                log("Identity: bad surface path — " + ex.Message);
                return false;
            }

            lock (Gate)
            {
                if (!IsExperimental && string.Equals(_registeredForDir, surfaceDir, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }

            var manifest = Path.Combine(surfaceDir, ManifestFileName);
            if (!File.Exists(manifest))
            {
                log($"Identity: no {ManifestFileName} beside Surface.exe ({surfaceDir}); this surface build " +
                    "can't host packaged (MSIX) projects, so their custom types may not resolve.");
                return false;
            }

            // Fast path: ask the OS directly (milliseconds) instead of spawning PowerShell and loading the
            // Appx module (~5 s+) just to learn the package is already registered at this folder.
            if (!IsExperimental && IsRegisteredAt(surfaceDir))
            {
                lock (Gate)
                {
                    _registeredForDir = surfaceDir;
                }
                log($"Identity: sparse package already registered for {surfaceDir} (fast check).");
                return true;
            }

            var ok = RunRegister(surfaceDir, manifest, log);
            if (ok)
            {
                lock (Gate)
                {
                    _registeredForDir = surfaceDir;
                }
            }

            return ok;
        }

        private const int ErrorInsufficientBuffer = 122;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern int GetPackagesByPackageFamily(
            string packageFamilyName, ref uint count, IntPtr packageFullNames, ref uint bufferLength, IntPtr buffer);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern int GetPackagePathByFullName(string packageFullName, ref uint pathLength, StringBuilder? path);

        /// <summary>
        /// True when a package of <see cref="FamilyName"/> is registered for the current user with its
        /// (external) location equal to <paramref name="surfaceDir"/>. Any API failure returns false so the
        /// caller falls back to the authoritative PowerShell check-then-register.
        /// </summary>
        private static bool IsRegisteredAt(string surfaceDir)
        {
            IntPtr names = IntPtr.Zero, buffer = IntPtr.Zero;
            try
            {
                uint count = 0, bufferLength = 0;
                int rc = GetPackagesByPackageFamily(FamilyName, ref count, IntPtr.Zero, ref bufferLength, IntPtr.Zero);
                if (rc != ErrorInsufficientBuffer || count == 0)
                {
                    return false;
                }

                names = Marshal.AllocHGlobal((int)count * IntPtr.Size);
                buffer = Marshal.AllocHGlobal((int)bufferLength * sizeof(char));
                if (GetPackagesByPackageFamily(FamilyName, ref count, names, ref bufferLength, buffer) != 0)
                {
                    return false;
                }

                var want = Path.GetFullPath(surfaceDir).TrimEnd('\\');
                for (int i = 0; i < count; i++)
                {
                    var fullName = Marshal.PtrToStringUni(Marshal.ReadIntPtr(names, i * IntPtr.Size));
                    if (string.IsNullOrEmpty(fullName))
                    {
                        continue;
                    }

                    uint len = 0;
                    if (GetPackagePathByFullName(fullName, ref len, null) != ErrorInsufficientBuffer || len == 0)
                    {
                        continue;
                    }
                    var path = new StringBuilder((int)len);
                    if (GetPackagePathByFullName(fullName, ref len, path) != 0)
                    {
                        continue;
                    }

                    if (string.Equals(Path.GetFullPath(path.ToString()).TrimEnd('\\'), want, StringComparison.OrdinalIgnoreCase))
                    {
                        return true;
                    }
                }

                return false;
            }
            catch
            {
                return false;
            }
            finally
            {
                if (names != IntPtr.Zero) Marshal.FreeHGlobal(names);
                if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
            }
        }

        private static bool RunRegister(string surfaceDir, string manifest, Action<string> log)
        {
#if MIGRATION_IDENTITY
            // The experimental binary does not contain or execute the shipping replacement script.
            // Revalidate registration on every call: AppX state is user-scoped, not hive-scoped.
            string script;
            using (var stream = typeof(SurfaceIdentity).Assembly.GetManifestResourceStream("WinUIXamlPreview.RegisterExperimental"))
            using (var reader = new StreamReader(stream ?? throw new InvalidOperationException("Experimental registration resource missing.")))
                script = reader.ReadToEnd();
            script += "\ntry { Invoke-ExperimentalSurfaceRegistration -SurfaceDir $env:WXP_EXTLOC -Manifest $env:WXP_MANIFEST; exit 0 } catch { Write-Output ('WXP:ERROR ' + $_.Exception.Message); exit 1 }\n";
#else
            // Idempotent check-then-register in one Windows PowerShell invocation, printing a status token we
            // parse. Re-registers when the recorded external location differs from the current one (e.g. after
            // a VSIX update relocated the extension folder). Paths are passed via environment variables to
            // avoid any quoting/escaping pitfalls.
            const string script =
                "$ErrorActionPreference='Stop';" +
                "$name='" + PackageName + "';" +
                "try{" +
                "  $loc=[System.IO.Path]::GetFullPath($env:WXP_EXTLOC).TrimEnd('\\');" +
                "  $man=[System.IO.Path]::GetFullPath($env:WXP_MANIFEST);" +
                "  $p=Get-AppxPackage -Name $name -ErrorAction SilentlyContinue;" +
                "  if($p -and $p.InstallLocation -and ([System.IO.Path]::GetFullPath($p.InstallLocation)).TrimEnd('\\') -ieq $loc){ Write-Output 'WXP:ALREADY'; exit 0 }" +
                "  if($p){ Remove-AppxPackage -Package $p.PackageFullName -ErrorAction SilentlyContinue }" +
                "  Add-AppxPackage -Register $man -ExternalLocation $loc -ErrorAction Stop;" +
                "  Write-Output 'WXP:REGISTERED'; exit 0" +
                "}catch{ Write-Output ('WXP:ERROR ' + $_.Exception.Message); exit 1 }";
#endif

            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "powershell.exe",
                    Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command -",
                    UseShellExecute = false,
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                };
                psi.EnvironmentVariables["WXP_EXTLOC"] = surfaceDir;
                psi.EnvironmentVariables["WXP_MANIFEST"] = manifest;

                using (var proc = Process.Start(psi))
                {
                    if (proc == null)
                    {
                        log("Identity: could not start powershell.exe for registration.");
                        return false;
                    }

                    proc.StandardInput.Write(script);
                    proc.StandardInput.Close();

                    // Output is a single tiny status token, so reading stdout to EOF (which completes when the
                    // child exits) before draining stderr cannot deadlock here.
                    var stdoutTask = proc.StandardOutput.ReadToEndAsync();
                    var stderrTask = proc.StandardError.ReadToEndAsync();

                    if (!proc.WaitForExit(60000))
                    {
                        try { proc.Kill(); } catch { /* best effort */ }
                        log("Identity: registration timed out.");
                        return false;
                    }

                    // VSTHRD002: these synchronous waits are safe — WaitForExit above has already returned,
                    // so the child has exited and both read tasks are complete; GetResult() returns
                    // immediately and cannot deadlock. The method is inherently synchronous, and the async
                    // reads exist only to drain stdout/stderr concurrently so a full pipe can't stall exit.
#pragma warning disable VSTHRD002 // Synchronous wait on an already-completed task; see note above.
                    var stdout = stdoutTask.GetAwaiter().GetResult();
                    var stderr = stderrTask.GetAwaiter().GetResult();
#pragma warning restore VSTHRD002
                    var outText = (stdout ?? string.Empty).Trim();
                    if (proc.ExitCode == 0 && outText == "WXP:ALREADY")
                    {
                        log($"Identity: sparse package already registered for {surfaceDir}.");
                        return true;
                    }

                    if (proc.ExitCode == 0 && outText == "WXP:REGISTERED")
                    {
                        log($"Identity: registered sparse package '{PackageName}' (external location {surfaceDir}).");
                        return true;
                    }

                    var reason = outText.Replace("WXP:ERROR", string.Empty).Trim();
                    if (string.IsNullOrEmpty(reason))
                    {
                        reason = (stderr ?? string.Empty).Trim();
                    }

                    log("Identity: registration failed — " + (string.IsNullOrEmpty(reason) ? "unknown error" : reason) +
                        ". Packaged (MSIX) custom types may not resolve. Ensure Windows Developer Mode is on " +
                        "(Settings ▸ System ▸ For developers).");
                    return false;
                }
            }
            catch (Exception ex)
            {
                log("Identity: registration invocation failed — " + ex.Message);
                return false;
            }
        }
    }
}
