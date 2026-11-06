#nullable enable

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace WinUIXamlPreview.Protocol
{
    /// <summary>
    /// WinAppSDK versions whose matched-host build already failed this VS session. Previews don't retry them
    /// (no retry loop), and a failed background prebuild counts too. Thread-safe.
    /// </summary>
    internal static class FailedHostVersions
    {
        private static readonly HashSet<string> Versions = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        public static bool Contains(string? version)
        {
            if (string.IsNullOrEmpty(version))
            {
                return false;
            }

            lock (Versions)
            {
                return Versions.Contains(version!);
            }
        }

        public static void Add(string version)
        {
            lock (Versions)
            {
                Versions.Add(version);
            }
        }

        internal static void ResetForTests()
        {
            lock (Versions)
            {
                Versions.Clear();
            }
        }
    }

    /// <summary>
    /// Builds the version-matched preview host for a solution's WinUI projects in the background when the
    /// solution opens, so the first preview of a page that needs Full fidelity finds it cached instead of
    /// waiting on a first-run build. Uses the same shared build as the previews: a preview opened meanwhile
    /// joins it. The prebuild holds no interest in that build, so a preview's Cancel still cancels it.
    /// </summary>
    internal static class MatchedHostPrebuild
    {
        // A solution with dozens of WinUI projects shouldn't queue dozens of builds; previews build the rest.
        internal const int MaxProjects = 8;

        /// <summary>Whether <paramref name="plan"/> calls for building a matched host ahead of time.</summary>
        public static bool ShouldPrebuild(HostSelection? plan, bool fullFidelityOn, Func<string, bool> failed) =>
            fullFidelityOn &&
            plan is { NeedsUpgrade: true, Upgrade: HostUpgradeKind.Build } &&
            !string.IsNullOrEmpty(plan.TargetVersion) &&
            !string.IsNullOrEmpty(plan.TargetProject) &&
            !failed(plan.TargetVersion!);

        /// <summary>
        /// Prebuild for each of <paramref name="projects"/> in turn (one build at a time). Stops early when
        /// <paramref name="fullFidelityOn"/> turns false, the toolchain is missing, or <paramref name="ct"/> is
        /// cancelled. Background thread; never throws except <see cref="OperationCanceledException"/>.
        /// </summary>
        public static async Task RunAsync(
            IEnumerable<string> projects,
            Func<bool> fullFidelityOn,
            Action<string> log,
            CancellationToken ct,
            Func<string, HostSelection>? resolve = null,
            Func<string, string, MatchedHostBuild?>? acquire = null)
        {
            resolve ??= csproj => MatchedHostResolver.Resolve(csproj, _ => { });
            acquire ??= (version, project) => HostProvisionerRunner.Acquire(version, project, log);
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var started = 0;

            foreach (var csproj in projects)
            {
                ct.ThrowIfCancellationRequested();
                if (started >= MaxProjects || !fullFidelityOn())
                {
                    return;
                }

                HostSelection plan;
                try
                {
                    plan = resolve(csproj);
                }
                catch (Exception ex)
                {
                    log($"Prebuild: couldn't inspect {Path.GetFileName(csproj)}: {ex.Message}");
                    continue;
                }

                if (!ShouldPrebuild(plan, fullFidelityOn(), FailedHostVersions.Contains) ||
                    !seen.Add(plan.TargetVersion + "|" + plan.TargetProject))
                {
                    continue;
                }

                var version = plan.TargetVersion!;
                var build = acquire(version, plan.TargetProject!);
                if (build == null)
                {
                    log("Prebuild: no .NET SDK, so matched preview hosts are built on demand (or not at all).");
                    return;
                }

                started++;
                // Observe only: a preview that joins owns the interest, so its Cancel can stop the build.
                build.Release(cancelIfLast: false);
                log($"Prebuild: preparing the WinAppSDK {version} preview host for {Path.GetFileName(plan.TargetProject)}.");

                HostBuildOutcome outcome;
                try
                {
                    outcome = await build.Completion.ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    outcome = new HostBuildOutcome { Success = false, Error = ex.Message };
                }

                if (outcome.Success)
                {
                    log($"Prebuild: WinAppSDK {version} preview host ready ({outcome.Status}, {outcome.DurationSeconds:n1}s).");
                }
                else if (outcome.Error == "cancelled")
                {
                    log($"Prebuild: WinAppSDK {version} preview host build was cancelled.");
                }
                else
                {
                    FailedHostVersions.Add(version);
                    log($"Prebuild: WinAppSDK {version} preview host build failed ({outcome.Error}); previews stay on the bundled host.");
                }
            }
        }
    }
}
