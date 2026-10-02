#nullable enable

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using WinUIXamlPreview.Protocol;

namespace WinUIXamlPreview.FaultTests
{
    /// <summary>
    /// Deterministic fault-injection harness (Workstream 1 T13). Runs in two roles:
    ///   • normal   — the test suite; drives the production <see cref="SurfaceClient"/> against a fake surface.
    ///   • fake surface — a controllable stand-in for Surface.exe, selected when FAKE_SURFACE_MODE is
    ///     inherited from the suite, whose behaviour is chosen by that same environment variable.
    /// No Windows App SDK or real renderer is required, so these cases run anywhere and finish in seconds.
    /// </summary>
    internal static class Program
    {
        private static int Main(string[] args)
        {
            // SurfaceClient launches us with only its own (--user-dll) args, so we can't rely on a CLI
            // flag to pick the fake-surface role. Instead the suite sets FAKE_SURFACE_MODE before each
            // launch; the child inherits it and becomes the fake. The suite starts without it set.
            if (Environment.GetEnvironmentVariable("FAKE_SURFACE_MODE") != null)
            {
                return FakeSurface.Run();
            }

            return TestSuite.Run();
        }
    }

    // ---- The fake surface -------------------------------------------------------------------------

    internal static class FakeSurface
    {
        public static int Run()
        {
            var mode = Environment.GetEnvironmentVariable("FAKE_SURFACE_MODE") ?? "ready-idle";
            var stdout = Console.Out;

            // Always announce our PID first so the suite can assert the child is reaped (no leaks).
            stdout.WriteLine($"FAKE_PID={Process.GetCurrentProcess().Id}");
            stdout.Flush();

            if (mode == "no-port")
            {
                // Never emit SURFACE_PORT — exercises the port-handshake timeout. Idle until killed.
                Thread.Sleep(Timeout.Infinite);
                return 0;
            }

            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            stdout.WriteLine($"SURFACE_PORT={port}");
            stdout.Flush();

            using var client = listener.AcceptTcpClient();
            using var netStream = client.GetStream();
            var reader = new StreamReader(netStream, Encoding.UTF8);
            var writer = new StreamWriter(netStream, new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };

            // Consume the Hello the client sends on connect.
            reader.ReadLine();

            switch (mode)
            {
                case "never-ready":
                    // Connected, but Ready never arrives — exercises the Ready timeout.
                    Thread.Sleep(Timeout.Infinite);
                    return 0;

                case "crash-before-ready":
                    // Die after the handshake but before Ready — exercises the process-exit funnel pre-Ready.
                    return 3;

                case "crash-after-ready":
                    SendReady(writer);
                    Thread.Sleep(750);
                    return 4; // Healthy start, then the renderer dies — exercises Closed after Ready.

                case "ready-idle":
                default:
                    SendReady(writer);
                    // Stay alive, draining commands, until the socket drops or we are killed.
                    try { while (reader.ReadLine() != null) { } } catch { }
                    return 0;
            }
        }

        private static void SendReady(StreamWriter writer)
            => writer.WriteLine($"{{\"type\":\"Ready\",\"protocol\":{Wire.ProtocolVersion},\"caps\":[\"frame-stream\"],\"wasdk\":\"fake\"}}");
    }

    // ---- The test suite ---------------------------------------------------------------------------

    internal static class TestSuite
    {
        private static readonly string FakeExe =
            Process.GetCurrentProcess().MainModule?.FileName
            ?? Assembly.GetEntryAssembly()!.Location;

        private static readonly List<(string Name, bool Passed, string Detail)> Results = new();

        public static int Run()
        {
            Console.WriteLine($"SurfaceClient fault-injection harness");
            Console.WriteLine($"  fake surface: {FakeExe}");
            Console.WriteLine();

            NeverReadyTimesOutAndReapsProcess();
            NeverReadyTimeoutKillsProcessWithoutDispose();
            NoPortTimesOut();
            CrashBeforeReadyFaultsOnce();
            CrashAfterReadyRaisesClosedOnce();
            MidStreamKillRaisesClosedOnce();
            SendAfterCloseIsSwallowed();
            IntentionalDisposeSuppressesClosedAndIsIdempotent();
            NoLeakedFakeSurfacesRemain();

            Console.WriteLine();
            var failed = 0;
            foreach (var r in Results)
            {
                Console.WriteLine($"  [{(r.Passed ? "PASS" : "FAIL")}] {r.Name}{(string.IsNullOrEmpty(r.Detail) ? "" : "  — " + r.Detail)}");
                if (!r.Passed) failed++;
            }

            Console.WriteLine();
            Console.WriteLine($"{Results.Count - failed}/{Results.Count} passed.");
            return failed == 0 ? 0 : 1;
        }

        // Each scenario spins up a client against the fake, exercises one failure, and records assertions.

        private static void NeverReadyTimesOutAndReapsProcess()
        {
            const string name = "never-Ready → StartAsync times out, exactly one Closed, process reaped";
            using var h = new Harness("never-ready");
            var threw = false;
            try
            {
                h.Client.StartAsync(TimeSpan.FromSeconds(1.5)).GetAwaiter().GetResult();
            }
            catch (TimeoutException) { threw = true; }
            catch (Exception ex) { Fail(name, $"expected TimeoutException, got {ex.GetType().Name}"); return; }

            // Fault() completes the awaiter and raises Closed on separate threads; wait for the event.
            var sawClosed = h.WaitForClosed(1, TimeSpan.FromSeconds(3));
            h.Client.Dispose();
            var reaped = h.WaitForFakeExit(TimeSpan.FromSeconds(5));

            Assert(name,
                threw && sawClosed && h.ClosedCount == 1 && reaped,
                $"threw={threw}, closed={h.ClosedCount} (expect 1), reaped={reaped}, pid={h.FakePid}");
        }

        private static void NeverReadyTimeoutKillsProcessWithoutDispose()
        {
            const string name = "never-Ready timeout kills the surface without waiting for Dispose (T1)";
            using var h = new Harness("never-ready");
            try
            {
                h.Client.StartAsync(TimeSpan.FromSeconds(1.5)).GetAwaiter().GetResult();
            }
            catch (TimeoutException) { }
            catch (Exception ex) { Fail(name, $"expected TimeoutException, got {ex.GetType().Name}"); return; }

            // Deliberately do NOT Dispose — Fault() itself must have requested the kill.
            var reaped = h.WaitForFakeExit(TimeSpan.FromSeconds(5));
            Assert(name, reaped, $"reaped={reaped}, pid={h.FakePid}");
        }

        private static void NoPortTimesOut()
        {
            const string name = "no SURFACE_PORT → StartAsync times out, one Closed";
            using var h = new Harness("no-port");
            var threw = false;
            try
            {
                h.Client.StartAsync(TimeSpan.FromSeconds(1.5)).GetAwaiter().GetResult();
            }
            catch (TimeoutException) { threw = true; }
            catch (Exception ex) { Fail(name, $"expected TimeoutException, got {ex.GetType().Name}"); return; }

            var closed = h.WaitForClosed(1, TimeSpan.FromSeconds(3));
            h.Client.Dispose();
            Assert(name, threw && closed && h.ClosedCount == 1, $"threw={threw}, closed={h.ClosedCount} (expect 1)");
        }

        private static void CrashBeforeReadyFaultsOnce()
        {
            const string name = "crash before Ready → StartAsync faults, exactly one Closed";
            using var h = new Harness("crash-before-ready");
            var threw = false;
            try
            {
                h.Client.StartAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult();
            }
            catch (Exception) { threw = true; }

            var closed = h.WaitForClosed(1, TimeSpan.FromSeconds(3));
            h.Client.Dispose();
            Assert(name, threw && closed && h.ClosedCount == 1, $"threw={threw}, closed={h.ClosedCount} (expect 1)");
        }

        private static void CrashAfterReadyRaisesClosedOnce()
        {
            const string name = "crash after Ready → StartAsync succeeds, exactly one Closed";
            using var h = new Harness("crash-after-ready");
            var ready = false;
            try
            {
                h.Client.StartAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult();
                ready = true;
            }
            catch (Exception ex) { Fail(name, $"expected Ready, got {ex.GetType().Name}: {ex.Message}"); return; }

            var closed = h.WaitForClosed(1, TimeSpan.FromSeconds(5));
            h.Client.Dispose();
            Assert(name, ready && closed && h.ClosedCount == 1, $"ready={ready}, closedCount={h.ClosedCount} (expect 1)");
        }

        private static void MidStreamKillRaisesClosedOnce()
        {
            const string name = "mid-stream kill after Ready → exactly one Closed";
            using var h = new Harness("ready-idle");
            try
            {
                h.Client.StartAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult();
            }
            catch (Exception ex) { Fail(name, $"expected Ready, got {ex.GetType().Name}: {ex.Message}"); return; }

            h.KillFake();
            var closed = h.WaitForClosed(1, TimeSpan.FromSeconds(5));
            h.Client.Dispose();
            Assert(name, closed && h.ClosedCount == 1, $"closedCount={h.ClosedCount} (expect 1)");
        }

        private static void SendAfterCloseIsSwallowed()
        {
            const string name = "send after close → no exception escapes";
            using var h = new Harness("ready-idle");
            try
            {
                h.Client.StartAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult();
            }
            catch (Exception ex) { Fail(name, $"expected Ready, got {ex.GetType().Name}: {ex.Message}"); return; }

            h.KillFake();
            h.WaitForClosed(1, TimeSpan.FromSeconds(5));

            var escaped = false;
            var r1 = true; var r2 = true; var r3 = true;
            try
            {
                r1 = h.Client.LoadXaml("<Grid/>", 100, 100, 1.0);
                r2 = h.Client.UpdateXaml("<Grid/>");
                r3 = h.Client.Resize(120, 120, 1.0);
            }
            catch (Exception ex) { escaped = true; Fail(name, $"Send threw {ex.GetType().Name}"); }

            if (escaped) return;
            var oneClosed = h.ClosedCount == 1; // the broken sends must not raise additional Closed events
            h.Client.Dispose();
            Assert(name, !r1 && !r2 && !r3 && oneClosed,
                $"returns={r1}/{r2}/{r3} (expect all false), closed={h.ClosedCount} (expect 1)");
        }

        private static void IntentionalDisposeSuppressesClosedAndIsIdempotent()
        {
            const string name = "intentional Dispose → no Closed, idempotent, process reaped";
            using var h = new Harness("ready-idle");
            try
            {
                h.Client.StartAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult();
            }
            catch (Exception ex) { Fail(name, $"expected Ready, got {ex.GetType().Name}: {ex.Message}"); return; }

            h.Client.Dispose();
            var reaped = h.WaitForFakeExit(TimeSpan.FromSeconds(5));
            var threwOnSecond = false;
            try { h.Client.Dispose(); } catch { threwOnSecond = true; }

            Thread.Sleep(200);
            Assert(name,
                h.ClosedCount == 0 && reaped && !threwOnSecond,
                $"closed={h.ClosedCount} (expect 0), reaped={reaped}, secondDisposeThrew={threwOnSecond}");
        }

        private static void NoLeakedFakeSurfacesRemain()
        {
            const string name = "no leaked fake-surface processes remain";
            var self = Process.GetCurrentProcess().Id;
            var leaked = new List<int>();
            foreach (var p in Process.GetProcessesByName("SurfaceClient.FaultTests"))
            {
                try { if (p.Id != self) leaked.Add(p.Id); } catch { }
                finally { p.Dispose(); }
            }

            Assert(name, leaked.Count == 0, leaked.Count == 0 ? "" : $"leaked PIDs: {string.Join(",", leaked)}");
        }

        private static void Assert(string name, bool ok, string detail) => Results.Add((name, ok, detail));
        private static void Fail(string name, string detail) => Results.Add((name, false, detail));

        /// <summary>One client + fake-surface launch, with Closed-event bookkeeping and the fake's PID.</summary>
        private sealed class Harness : IDisposable
        {
            public SurfaceClient Client { get; }
            public int ClosedCount => _closed;
            public int FakePid { get; private set; }

            private int _closed;
            private readonly ManualResetEventSlim _closedSignal = new(false);

            public Harness(string mode)
            {
                Environment.SetEnvironmentVariable("FAKE_SURFACE_MODE", mode);
                Client = new SurfaceClient(FakeExe, userDll: null, log: Log);
                Client.Closed += _ =>
                {
                    Interlocked.Increment(ref _closed);
                    _closedSignal.Set();
                };
            }

            private void Log(string line)
            {
                var marker = line.IndexOf("FAKE_PID=", StringComparison.Ordinal);
                if (marker >= 0)
                {
                    var digits = new string(Array.FindAll(line.Substring(marker + "FAKE_PID=".Length).ToCharArray(), char.IsDigit));
                    if (int.TryParse(digits, out var pid)) FakePid = pid;
                }
            }

            public bool WaitForClosed(int expected, TimeSpan timeout)
            {
                var deadline = DateTime.UtcNow + timeout;
                while (Volatile.Read(ref _closed) < expected && DateTime.UtcNow < deadline)
                {
                    _closedSignal.Wait(TimeSpan.FromMilliseconds(100));
                }

                return Volatile.Read(ref _closed) >= expected;
            }

            public void KillFake()
            {
                if (FakePid == 0) return;
                try
                {
                    using var p = Process.GetProcessById(FakePid);
                    p.Kill();
                    p.WaitForExit(5000);
                }
                catch { }
            }

            public bool WaitForFakeExit(TimeSpan timeout)
            {
                if (FakePid == 0) return true;
                var deadline = DateTime.UtcNow + timeout;
                while (DateTime.UtcNow < deadline)
                {
                    if (!IsAlive(FakePid)) return true;
                    Thread.Sleep(100);
                }

                return !IsAlive(FakePid);
            }

            private static bool IsAlive(int pid)
            {
                try
                {
                    using var p = Process.GetProcessById(pid);
                    return !p.HasExited;
                }
                catch (ArgumentException) { return false; }
                catch { return false; }
            }

            public void Dispose()
            {
                try { Client.Dispose(); } catch { }
                KillFake();
                _closedSignal.Dispose();
            }
        }
    }
}
