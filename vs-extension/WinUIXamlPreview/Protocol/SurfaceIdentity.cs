#nullable enable

using System;
using System.Diagnostics;
using System.IO;

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
    /// Registration is one-time per external-location folder (cached for the process) and requires Windows
    /// Developer Mode (or a trusted signature) to register a loose external-location package. All failures are
    /// non-fatal: the surface still renders framework types, just not packaged custom types.
    /// </summary>
    internal static class SurfaceIdentity
    {
        public const string PackageName = "WinUIXamlPreviewSurface";
        public const string Publisher = "CN=WinUIXamlPreview";
        public const string AppId = "Surface";

        /// <summary>
        /// Deterministic package family name (<c>PackageName_{hash(Publisher)}</c>); stable across machines
        /// because it derives only from the fixed publisher. For reference / diagnostics.
        /// </summary>
        public const string FamilyName = "WinUIXamlPreviewSurface_p47s87298xgjw";

        public const string ManifestFileName = "AppxManifest.xml";

        private static readonly object Gate = new object();
        private static string? _registeredForDir;

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
                if (string.Equals(_registeredForDir, surfaceDir, StringComparison.OrdinalIgnoreCase))
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

        private static bool RunRegister(string surfaceDir, string manifest, Action<string> log)
        {
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
                    var stdout = proc.StandardOutput.ReadToEnd();
                    var stderr = proc.StandardError.ReadToEnd();

                    if (!proc.WaitForExit(60000))
                    {
                        try { proc.Kill(); } catch { /* best effort */ }
                        log("Identity: registration timed out.");
                        return false;
                    }

                    var outText = (stdout ?? string.Empty).Trim();
                    if (outText.IndexOf("WXP:ALREADY", StringComparison.Ordinal) >= 0)
                    {
                        log($"Identity: sparse package already registered for {surfaceDir}.");
                        return true;
                    }

                    if (outText.IndexOf("WXP:REGISTERED", StringComparison.Ordinal) >= 0)
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
