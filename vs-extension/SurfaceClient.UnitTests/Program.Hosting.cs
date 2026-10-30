using System;
using System.Collections.Concurrent;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using WinUIXamlPreview.Protocol;

namespace WinUIXamlPreview.UnitTests;

internal static partial class Program
{
    private static void MatchedHostBuildTests()
    {
        MatchedHostBuild Started(out Func<CancellationToken> token)
        {
            var b = new MatchedHostBuild("2.1.0");
            CancellationToken seen = default;
            b.Start(ct => { seen = ct; return new TaskCompletionSource<HostBuildOutcome>().Task; });
            token = () => seen;
            return b;
        }

        var shared = Started(out var tok);
        shared.AddInterest();
        shared.Release(cancelIfLast: true);
        Check("one of two previews cancelling keeps the shared build running", !tok().IsCancellationRequested);
        shared.Release(cancelIfLast: true);
        Check("last preview cancelling cancels the build", tok().IsCancellationRequested);

        var promoted = Started(out tok);
        promoted.Release(cancelIfLast: false);
        Check("last release without cancelIfLast (promote) leaves the build alone", !tok().IsCancellationRequested);

        var extra = Started(out tok);
        extra.Release(cancelIfLast: false);
        extra.Release(cancelIfLast: false);
        extra.AddInterest();
        extra.Release(cancelIfLast: true);
        Check("over-release never goes negative: one new interest then its release cancels", tok().IsCancellationRequested);

        var twice = Started(out tok);
        twice.Release(cancelIfLast: true);
        bool threw = false;
        try { twice.Release(cancelIfLast: true); } catch { threw = true; }
        Check("releasing after cancel is safe", !threw && tok().IsCancellationRequested);

        var fresh = new MatchedHostBuild("2.2.0");
        Check("Completion before Start is a finished non-success outcome",
            fresh.Completion.IsCompleted && !fresh.Completion.Result.Success && fresh.Version == "2.2.0");
    }

    private static void MatchedHostPrebuildTests()
    {
        HostSelection Plan(string? version, string? project, bool upgrade = true) => new HostSelection
        {
            NeedsUpgrade = upgrade,
            Upgrade = upgrade ? HostUpgradeKind.Build : HostUpgradeKind.None,
            TargetVersion = version,
            TargetProject = project,
        };
        Func<string, bool> none = _ => false;

        Check("prebuild: matched plan → yes", MatchedHostPrebuild.ShouldPrebuild(Plan("2.3.0", "A.csproj"), true, none));
        Check("prebuild: Full fidelity off → no", !MatchedHostPrebuild.ShouldPrebuild(Plan("2.3.0", "A.csproj"), false, none));
        Check("prebuild: bundled version → no", !MatchedHostPrebuild.ShouldPrebuild(Plan("2.2.0", "A.csproj", upgrade: false), true, none));
        Check("prebuild: no project → no", !MatchedHostPrebuild.ShouldPrebuild(Plan("2.3.0", null), true, none));
        Check("prebuild: no plan → no", !MatchedHostPrebuild.ShouldPrebuild(null, true, none));
        Check("prebuild: version already failed → no", !MatchedHostPrebuild.ShouldPrebuild(Plan("2.3.0", "A.csproj"), true, v => v == "2.3.0"));

        MatchedHostBuild Build(string version, Task<HostBuildOutcome> completion, out Func<CancellationToken> token)
        {
            var b = new MatchedHostBuild(version);
            CancellationToken seen = default;
            b.Start(ct => { seen = ct; return completion; });
            token = () => seen;
            return b;
        }

        var plans = new System.Collections.Generic.Dictionary<string, HostSelection>
        {
            ["a"] = Plan("2.3.0", "A.csproj"),
            ["b"] = Plan("2.2.0", "B.csproj", upgrade: false),
            ["c"] = Plan("2.4.0", "C.csproj"),
            ["a2"] = Plan("2.3.0", "A.csproj"),
        };
        var log = new ConcurrentQueue<string>();

        // Builds run one at a time, duplicates are skipped, and a failure is remembered for previews.
        FailedHostVersions.ResetForTests();
        var acquired = new ConcurrentQueue<string>();
        var first = new TaskCompletionSource<HostBuildOutcome>();
        Func<CancellationToken>? firstToken = null;
        var run = MatchedHostPrebuild.RunAsync(new[] { "a", "b", "c", "a2" }, () => true, log.Enqueue, CancellationToken.None,
            p => plans[p],
            (v, p) =>
            {
                acquired.Enqueue(v + "|" + p);
                return v == "2.3.0"
                    ? Build(v, first.Task, out firstToken)
                    : Build(v, Task.FromResult(new HostBuildOutcome { Success = false, Error = "restore failed" }), out _);
            });
        Check("prebuild: waits for one build before the next", acquired.Count == 1 && !run.IsCompleted);
        first.SetResult(new HostBuildOutcome { Success = true, Status = "built" });
        run.Wait(TimeSpan.FromSeconds(5));
        Eq("prebuild: matched projects only, once each", "2.3.0|A.csproj,2.4.0|C.csproj", string.Join(",", acquired));
        Check("prebuild: a failed build is remembered", FailedHostVersions.Contains("2.4.0") && !FailedHostVersions.Contains("2.3.0"));

        // A failed version isn't retried on the next solution open.
        acquired = new ConcurrentQueue<string>();
        MatchedHostPrebuild.RunAsync(new[] { "c", "a" }, () => true, log.Enqueue, CancellationToken.None, p => plans[p],
            (v, p) => { acquired.Enqueue(v); return Build(v, Task.FromResult(new HostBuildOutcome { Success = true }), out _); }).Wait(5000);
        Eq("prebuild: failed version skipped", "2.3.0", string.Join(",", acquired));

        // The prebuild holds no interest: a preview that joins and then cancels stops the build.
        FailedHostVersions.ResetForTests();
        MatchedHostBuild? held = null;
        Func<CancellationToken>? heldToken = null;
        var pending = new TaskCompletionSource<HostBuildOutcome>();
        var observe = MatchedHostPrebuild.RunAsync(new[] { "a" }, () => true, log.Enqueue, CancellationToken.None, p => plans[p],
            (v, p) => held = Build(v, pending.Task, out heldToken));
        held!.AddInterest();
        held.Release(cancelIfLast: true);
        Check("prebuild: a joined preview's Cancel cancels the build", heldToken!().IsCancellationRequested);
        pending.SetResult(new HostBuildOutcome { Success = false, Error = "cancelled" });
        observe.Wait(5000);
        Check("prebuild: a cancelled build isn't a failure", !FailedHostVersions.Contains("2.3.0"));

        // No toolchain stops the run; Full fidelity off does nothing.
        int calls = 0;
        MatchedHostPrebuild.RunAsync(new[] { "a", "c" }, () => true, log.Enqueue, CancellationToken.None, p => plans[p],
            (v, p) => { calls++; return null; }).Wait(5000);
        Check("prebuild: no .NET SDK → stop after the first try", calls == 1);
        calls = 0;
        MatchedHostPrebuild.RunAsync(new[] { "a", "c" }, () => false, log.Enqueue, CancellationToken.None, p => plans[p],
            (v, p) => { calls++; return null; }).Wait(5000);
        Check("prebuild: Full fidelity off → nothing", calls == 0);

        // Large solutions are capped.
        calls = 0;
        var many = Enumerable.Range(0, 20).Select(i => "p" + i).ToArray();
        MatchedHostPrebuild.RunAsync(many, () => true, log.Enqueue, CancellationToken.None, p => Plan("2.3." + p, p + ".csproj"),
            (v, p) => { calls++; return Build(v, Task.FromResult(new HostBuildOutcome { Success = true }), out _); }).Wait(5000);
        Eq("prebuild: capped", MatchedHostPrebuild.MaxProjects.ToString(), calls.ToString());

        // A resolver that throws on one project doesn't stop the others.
        calls = 0;
        MatchedHostPrebuild.RunAsync(new[] { "boom", "a" }, () => true, log.Enqueue, CancellationToken.None,
            p => p == "boom" ? throw new IOException("locked") : plans[p],
            (v, p) => { calls++; return Build(v, Task.FromResult(new HostBuildOutcome { Success = true }), out _); }).Wait(5000);
        Check("prebuild: one unreadable project is skipped", calls == 1);
        FailedHostVersions.ResetForTests();
    }

    private static void SurfaceIdentityTests()
    {
        var root = NewDir("ident");
        try
        {
            var bare = Directory.CreateDirectory(Path.Combine(root, "bare")).FullName;
            var payload = Directory.CreateDirectory(Path.Combine(root, "payload")).FullName;
            File.WriteAllText(Path.Combine(payload, SurfaceIdentity.ManifestFileName), "<Package/>");
            var bareExe = Path.Combine(bare, "Surface.exe");

            Check("HasIdentityPayload: manifest beside exe", SurfaceIdentity.HasIdentityPayload(Path.Combine(payload, "Surface.exe")));
            Check("HasIdentityPayload: dev build without manifest", !SurfaceIdentity.HasIdentityPayload(bareExe));
            Check("HasIdentityPayload: null/empty/garbage path", !SurfaceIdentity.HasIdentityPayload(null)
                && !SurfaceIdentity.HasIdentityPayload("") && !SurfaceIdentity.HasIdentityPayload("\0bad"));

            var logs = new ConcurrentQueue<string>();
            Check("EnsureRegistered without manifest returns false and explains (no PowerShell)",
                !SurfaceIdentity.EnsureRegistered(bareExe, logs.Enqueue) && Any(logs, "no AppxManifest.xml"));
            Check("EnsureRegistered with a bad path returns false", !SurfaceIdentity.EnsureRegistered("\0bad", _ => { }));

            var first = SurfaceIdentity.EnsureRegisteredAsync(bareExe);
            Check("EnsureRegisteredAsync failure surfaces as false", first.Wait(10000) && !first.Result);
            var retry = SurfaceIdentity.EnsureRegisteredAsync(bareExe);
            Check("a failed registration is not cached: next caller retries", !ReferenceEquals(first, retry) && retry.Wait(10000) && !retry.Result);

            // Concurrent callers share one in-flight registration (fake PowerShell step, held open until released).
            int runs = 0;
            bool succeed = false;
            using (var release = new ManualResetEventSlim(false))
            {
                SurfaceIdentity.RegisterOverride = (dir, manifest, log) => { Interlocked.Increment(ref runs); release.Wait(10000); return succeed; };
                try
                {
                    var payloadExe = Path.Combine(payload, "Surface.exe");
                    var callers = Enumerable.Range(0, 8).Select(_ => Task.Factory.StartNew(() => SurfaceIdentity.EnsureRegisteredAsync(payloadExe))).ToArray();
                    Task.WaitAll(callers, 10000);
                    var shared = callers.Select(c => c.Result).Distinct().Count();
                    SpinWait.SpinUntil(() => Volatile.Read(ref runs) > 0, 5000);
                    release.Set();
                    var all = callers.Select(c => c.Result).ToArray();
                    Check("concurrent EnsureRegisteredAsync callers share one registration",
                        shared == 1 && Task.WaitAll(all, 10000) && runs == 1 && all.All(t => !t.Result), $"tasks={shared} runs={runs}");

                    succeed = true;
                    var again = SurfaceIdentity.EnsureRegisteredAsync(payloadExe);
                    var joined = SurfaceIdentity.EnsureRegisteredAsync(payloadExe);
                    Check("after a failure the next caller retries and later callers join it",
                        ReferenceEquals(again, joined) && again.Wait(10000) && again.Result && runs == 2, "runs=" + runs);
                    var cached = SurfaceIdentity.EnsureRegisteredAsync(payloadExe);
                    Check("a successful registration is reused without running again",
                        ReferenceEquals(cached, again) && SurfaceIdentity.EnsureRegistered(payloadExe) && runs == 2, "runs=" + runs);
                }
                finally
                {
                    SurfaceIdentity.RegisterOverride = null;
                }
            }

            // Identity prewarm is a no-op until a surface asks for the fallback (checked BEFORE RequestFallback:
            // the fallback flag is process-wide and never resets).
            var notWinUi = Path.Combine(root, "Lib.csproj");
            File.WriteAllText(notWinUi, "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>");
            var pre = new ConcurrentQueue<string>();
            Check("prewarm is a no-op before the fallback is active",
                !SurfaceIdentity.FallbackActive && IdentityPrewarm.ForProjectsAsync(new[] { notWinUi }, "test", pre.Enqueue).Wait(10000) && pre.IsEmpty);

            int raised = 0;
            Action ok = () => Interlocked.Increment(ref raised);
            Action boom = () => throw new InvalidOperationException("handler bug");
            SurfaceIdentity.FallbackRequested += ok;
            SurfaceIdentity.FallbackRequested += boom;
            var fl = new ConcurrentQueue<string>();
            bool threw = false;
            try
            {
                SurfaceIdentity.RequestFallback(fl.Enqueue);
                SurfaceIdentity.RequestFallback(fl.Enqueue);
            }
            catch { threw = true; }
            finally
            {
                SurfaceIdentity.FallbackRequested -= ok;
                SurfaceIdentity.FallbackRequested -= boom;
            }
            Check("RequestFallback activates once, raises once, contains handler errors",
                !threw && SurfaceIdentity.FallbackActive && raised == 1 && Any(fl, "handler failed"), "raised=" + raised);

            pre = new ConcurrentQueue<string>();
            Check("prewarm skips non-WinUI projects once active",
                IdentityPrewarm.ForProjectsAsync(new[] { notWinUi }, "test", pre.Enqueue).Wait(10000) && pre.IsEmpty, string.Join("|", pre));
            Check("prewarm with a missing csproj never throws",
                IdentityPrewarm.ForProjectsAsync(new[] { Path.Combine(root, "missing.csproj") }, "test", pre.Enqueue).Wait(10000));
        }
        finally
        {
            try { Directory.Delete(root, true); } catch { }
        }
    }

    private static bool Any(ConcurrentQueue<string> q, string needle)
    {
        foreach (var l in q) if (l.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) return true;
        return false;
    }
}
