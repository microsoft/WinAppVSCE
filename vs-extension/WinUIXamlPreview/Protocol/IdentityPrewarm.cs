#nullable enable

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;

namespace WinUIXamlPreview.Protocol
{
    /// <summary>
    /// P8: starts the surface's sparse-identity registration in the background as early as we learn a WinUI
    /// project has only a packaged (MSIX) build, so the first preview open finds it done (or joins the
    /// in-flight attempt via <see cref="SurfaceIdentity.EnsureRegisteredAsync"/>) instead of paying the
    /// PowerShell cost inline. Triggered from solution open (package) and from the first WinUI margin
    /// (which can run minutes before the background-loaded package under load). Each project is checked once
    /// per VS session; everything runs off the UI thread and never throws.
    /// </summary>
    internal static class IdentityPrewarm
    {
        private static readonly HashSet<string> Checked = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        public static void ForDocument(string? xamlPath, string trigger, Action<string> log)
        {
            if (string.IsNullOrWhiteSpace(xamlPath))
            {
                return;
            }

            _ = Task.Run(() =>
            {
                var csproj = ProjectDllLocator.FindOwningCsproj(xamlPath!);
                return csproj == null ? Task.CompletedTask : RunAsync(new[] { csproj }, trigger, log);
            });
        }

        public static Task ForProjectsAsync(IReadOnlyList<string> csprojPaths, string trigger, Action<string> log)
            => Task.Run(() => RunAsync(csprojPaths, trigger, log));

        private static async Task RunAsync(IReadOnlyList<string> csprojPaths, string trigger, Action<string> log)
        {
            if (!SurfaceIdentity.FallbackActive)
            {
                return; // packaged builds load without identity by default; only prewarm once the fallback is on
            }

            try
            {
                var sw = Stopwatch.StartNew();
                string? packaged = null;
                foreach (var csproj in csprojPaths)
                {
                    lock (Checked)
                    {
                        if (!Checked.Add(csproj))
                        {
                            continue;
                        }
                    }

                    if (ProjectDllLocator.IsWinUiProject(csproj) && ProjectDllLocator.NeedsPackagedIdentity(csproj))
                    {
                        packaged = csproj;
                        break;
                    }
                }

                if (packaged == null)
                {
                    return;
                }

                var exe = SurfaceResolver.Resolve(null, packaged);
                if (exe == null || !SurfaceIdentity.HasIdentityPayload(exe))
                {
                    return;
                }

                log($"Identity prewarm ({trigger}): {Path.GetFileName(packaged)} has only a packaged build; registering surface identity in the background.");
                var ok = await SurfaceIdentity.EnsureRegisteredAsync(exe, log).ConfigureAwait(false);
                log($"PERF identity.prewarm trigger={trigger} ms={sw.ElapsedMilliseconds} registered={ok}");
            }
            catch (Exception ex)
            {
                log("Identity prewarm failed: " + ex.Message);
            }
        }
    }
}
