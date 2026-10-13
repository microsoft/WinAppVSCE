using System;
using System.Collections.Concurrent;
using System.IO;
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
