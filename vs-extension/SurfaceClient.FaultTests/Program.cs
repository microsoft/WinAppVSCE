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

            // Consume the Hello the client sends on connect, and report it so the suite can check what went on the wire.
            var hello = reader.ReadLine();
            stdout.WriteLine("FAKE_HELLO=" + hello);
            stdout.Flush();

            switch (mode)
            {
                case "ready-incompatible":
                    // A surface from a future extension that dropped v1: no shared version (R2).
                    writer.WriteLine("{\"type\":\"Ready\",\"protocol\":99,\"minProtocol\":99,\"caps\":[\"frame-stream\"],\"wasdk\":\"fake\"}");
                    try { while (reader.ReadLine() != null) { } } catch { }
                    return 0;

                case "reject-hello":
                    // The surface didn't accept our Hello range (R2): it answers with a protocol-phase Error, not Ready.
                    writer.WriteLine("{\"type\":\"Error\",\"phase\":\"protocol\",\"message\":\"Surface speaks protocol v7; client speaks v1.\"}");
                    try { while (reader.ReadLine() != null) { } } catch { }
                    return 0;

                case "ready-legacy":
                    // A pre-negotiation surface: no protocol/minProtocol fields at all (treated as v1).
                    writer.WriteLine("{\"type\":\"Ready\",\"caps\":[\"frame-stream\"]}");
                    try { while (reader.ReadLine() != null) { } } catch { }
                    return 0;

                case "ready-newer-range":
                    // A newer surface that still speaks v1, reporting its real WASDK (R3).
                    writer.WriteLine("{\"type\":\"Ready\",\"protocol\":5,\"minProtocol\":1,\"caps\":[\"frame-stream\"],\"wasdk\":\"2.2.0\"}");
                    try { while (reader.ReadLine() != null) { } } catch { }
                    return 0;

                case "ready-then-render-error":
                    SendReady(writer);
                    // Render errors are ordinary; only phase "protocol" is fatal.
                    writer.WriteLine("{\"type\":\"Error\",\"phase\":\"parse\",\"message\":\"bad xaml\"}");
                    try { while (reader.ReadLine() != null) { } } catch { }
                    return 0;

                case "ready-malformed":
                    // Ready with a wrong-typed field: the handshake can't be trusted, so the client must fail fast.
                    writer.WriteLine("{\"type\":\"Ready\",\"protocol\":\"one\",\"caps\":\"frame-stream\"}");
                    try { while (reader.ReadLine() != null) { } } catch { }
                    return 0;

                case "ready-then-garbage":
                    SendReady(writer);
                    // Junk a buggy/older surface (or stray diagnostics) could put on the wire after Ready:
                    // non-JSON, non-object JSON, no type, unknown type, and known types with wrong field shapes.
                    writer.WriteLine("this is not json");
                    writer.WriteLine("[1,2,3]");
                    writer.WriteLine("{\"no\":\"type\"}");
                    writer.WriteLine("{\"type\":\"Bogus\",\"x\":1}");
                    writer.WriteLine("{\"type\":\"Error\",\"phase\":5,\"message\":[]}");
                    writer.WriteLine("{\"type\":\"Selected\",\"id\":\"not-a-number\"}");
                    writer.WriteLine("{\"type\":\"Frame\",\"width\":\"wide\",\"png\":42}");
                    // A well-formed message afterwards proves the read loop survived.
                    writer.WriteLine("{\"type\":\"Error\",\"phase\":\"parse\",\"message\":\"after garbage\"}");
                    try { while (reader.ReadLine() != null) { } } catch { }
                    return 0;

                case "never-ready":
                    // Connected, but Ready never arrives — exercises the Ready timeout.
                    Thread.Sleep(Timeout.Infinite);
                    return 0;

                case "crash-before-ready":
                    // Die after the handshake but before Ready — exercises the process-exit funnel pre-Ready.
                    return 3;

                case "crash-after-ready":
                    SendReady(writer);
                    // Long enough for a cold client (first JSON/TPL use) to process Ready before the exit races it.
                    Thread.Sleep(2500);
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
            HelloAdvertisesProtocolRange();
            IncompatibleReadyFaultsFastAndPermanently();
            ProtocolErrorFaultsFastAndPermanently();
            LegacyReadyIsAccepted();
            NewerCompatibleRangeIsAcceptedWithWasdk();
            RenderErrorIsNotAProtocolFault();
            GarbageAfterReadyIsIgnored();
            MalformedReadyFaultsFast();
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

        // ---- R2/R3 protocol negotiation over a real process + socket ----

        private static void HelloAdvertisesProtocolRange()
        {
            const string name = "R2: Hello on the wire carries protocol and minProtocol";
            using var h = new Harness("ready-idle");
            try { h.Client.StartAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult(); }
            catch (Exception ex) { Fail(name, $"expected Ready, got {ex.GetType().Name}: {ex.Message}"); return; }

            var hello = h.WaitForHello(TimeSpan.FromSeconds(3));
            var ok = hello != null
                && hello.Contains("\"type\":\"Hello\"")
                && hello.Contains($"\"protocol\":{Wire.ProtocolVersion}")
                && hello.Contains($"\"minProtocol\":{Wire.MinProtocolVersion}");
            Assert(name, ok, hello ?? "no Hello captured");
        }

        private static void IncompatibleReadyFaultsFastAndPermanently()
            => AssertProtocolFault("ready-incompatible",
                "R2: incompatible Ready → StartAsync fails fast with SurfaceProtocolException, one Closed, reaped", "v99");

        private static void ProtocolErrorFaultsFastAndPermanently()
            => AssertProtocolFault("reject-hello",
                "R2: Hello rejected (Error phase=protocol) → fails fast with SurfaceProtocolException, one Closed, reaped", "client speaks v1");

        // The mismatch must short-circuit startup (not sit until the Ready timeout), flag the client so the
        // preview doesn't auto-restart, carry a readable reason, and still kill the surface.
        private static void AssertProtocolFault(string mode, string name, string reasonFragment)
        {
            using var h = new Harness(mode);
            var timeout = TimeSpan.FromSeconds(20);
            var sw = Stopwatch.StartNew();
            Exception? caught = null;
            try { h.Client.StartAsync(timeout).GetAwaiter().GetResult(); }
            catch (Exception ex) { caught = ex; }
            sw.Stop();

            var closed = h.WaitForClosed(1, TimeSpan.FromSeconds(3));
            var reaped = h.WaitForFakeExit(TimeSpan.FromSeconds(5)); // before Dispose: the fault itself must kill it
            var fast = sw.Elapsed < TimeSpan.FromSeconds(10);
            var reasonOk = caught?.Message.Contains(reasonFragment) == true && h.ClosedReason?.Contains(reasonFragment) == true;
            Assert(name,
                caught is SurfaceProtocolException && h.Client.IsProtocolMismatch && h.Client.IsFaulted && fast
                    && closed && h.ClosedCount == 1 && reaped && reasonOk && h.ErrorCount == 0,
                $"exception={caught?.GetType().Name ?? "none"}, mismatch={h.Client.IsProtocolMismatch}, " +
                $"elapsed={sw.ElapsedMilliseconds}ms, closed={h.ClosedCount} (expect 1), reaped={reaped}, " +
                $"errorEvents={h.ErrorCount} (expect 0), reason='{h.ClosedReason}'");
        }

        private static void LegacyReadyIsAccepted()
        {
            const string name = "R2: legacy Ready (no protocol fields) → starts as v1";
            using var h = new Harness("ready-legacy");
            ReadyMsg? ready = null;
            try { ready = h.Client.StartAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult(); }
            catch (Exception ex) { Fail(name, $"expected Ready, got {ex.GetType().Name}: {ex.Message}"); return; }

            Thread.Sleep(200);
            Assert(name, ready != null && !h.Client.IsFaulted && !h.Client.IsProtocolMismatch && h.ClosedCount == 0,
                $"faulted={h.Client.IsFaulted}, mismatch={h.Client.IsProtocolMismatch}, closed={h.ClosedCount}");
        }

        private static void NewerCompatibleRangeIsAcceptedWithWasdk()
        {
            const string name = "R2/R3: newer surface still speaking v1 → starts, Ready.wasdk passed through";
            using var h = new Harness("ready-newer-range");
            ReadyMsg? ready = null;
            try { ready = h.Client.StartAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult(); }
            catch (Exception ex) { Fail(name, $"expected Ready, got {ex.GetType().Name}: {ex.Message}"); return; }

            Assert(name,
                ready != null && ready.Protocol == 5 && ready.MinProtocol == 1 && ready.Wasdk == "2.2.0" && !h.Client.IsFaulted,
                $"protocol={ready?.Protocol}, minProtocol={ready?.MinProtocol}, wasdk={ready?.Wasdk ?? "null"}, faulted={h.Client.IsFaulted}");
        }

        private static void RenderErrorIsNotAProtocolFault()
        {
            const string name = "R2: a render Error after Ready stays a render error (no fault, no Closed)";
            using var h = new Harness("ready-then-render-error");
            try { h.Client.StartAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult(); }
            catch (Exception ex) { Fail(name, $"expected Ready, got {ex.GetType().Name}: {ex.Message}"); return; }

            var gotError = h.WaitForError(TimeSpan.FromSeconds(3));
            Assert(name,
                gotError && !h.Client.IsFaulted && !h.Client.IsProtocolMismatch && h.ClosedCount == 0,
                $"errorEvents={h.ErrorCount}, faulted={h.Client.IsFaulted}, mismatch={h.Client.IsProtocolMismatch}, closed={h.ClosedCount}");
        }

        private static void GarbageAfterReadyIsIgnored()
        {
            const string name = "malformed/unknown/mis-shaped messages after Ready are ignored; the next valid message still arrives";
            using var h = new Harness("ready-then-garbage");
            try { h.Client.StartAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult(); }
            catch (Exception ex) { Fail(name, $"expected Ready, got {ex.GetType().Name}: {ex.Message}"); return; }

            var gotError = h.WaitForError(TimeSpan.FromSeconds(3));
            Thread.Sleep(200);
            Assert(name,
                gotError && !h.Client.IsFaulted && h.ClosedCount == 0,
                $"errorEvents={h.ErrorCount}, faulted={h.Client.IsFaulted}, closed={h.ClosedCount}, reason='{h.ClosedReason}'");
        }

        private static void MalformedReadyFaultsFast()
        {
            const string name = "malformed Ready → StartAsync fails fast (no timeout wait), one Closed";
            using var h = new Harness("ready-malformed");
            var sw = Stopwatch.StartNew();
            var threw = false;
            try { h.Client.StartAsync(TimeSpan.FromSeconds(20)).GetAwaiter().GetResult(); }
            catch (Exception) { threw = true; }
            var elapsed = sw.ElapsedMilliseconds;
            var closed = h.WaitForClosed(1, TimeSpan.FromSeconds(3));
            Assert(name, threw && elapsed < 10000 && closed && h.ClosedCount == 1,
                $"threw={threw}, elapsed={elapsed}ms, closed={h.ClosedCount}");
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
            public string? ClosedReason { get; private set; }
            public int ErrorCount => Volatile.Read(ref _errors);

            private int _closed;
            private int _errors;
            private volatile string? _hello;
            private readonly ManualResetEventSlim _closedSignal = new(false);

            public Harness(string mode)
            {
                Environment.SetEnvironmentVariable("FAKE_SURFACE_MODE", mode);
                Client = new SurfaceClient(FakeExe, userDll: null, log: Log);
                Client.Closed += reason =>
                {
                    ClosedReason = reason;
                    Interlocked.Increment(ref _closed);
                    _closedSignal.Set();
                };
                Client.Error += _ => Interlocked.Increment(ref _errors);
            }

            private void Log(string line)
            {
                var helloAt = line.IndexOf("FAKE_HELLO=", StringComparison.Ordinal);
                if (helloAt >= 0)
                {
                    _hello = line.Substring(helloAt + "FAKE_HELLO=".Length);
                    return;
                }

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

            public string? WaitForHello(TimeSpan timeout)
            {
                var deadline = DateTime.UtcNow + timeout;
                while (_hello == null && DateTime.UtcNow < deadline) Thread.Sleep(50);
                return _hello;
            }

            public bool WaitForError(TimeSpan timeout)
            {
                var deadline = DateTime.UtcNow + timeout;
                while (ErrorCount == 0 && DateTime.UtcNow < deadline) Thread.Sleep(50);
                return ErrorCount > 0;
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
