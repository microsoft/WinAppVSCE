using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

namespace Surface;

/// <summary>
/// The <c>--wgc</c> path (S5 Part 2). Answers the feasibility question the plan raises: since the
/// warm render window is cloaked + off-screen, can <c>Windows.Graphics.Capture</c> — which grabs a
/// window's DWM-<em>composed</em> output — capture it at all, and how does its capture→CPU cost
/// compare to the RTB GPU→CPU readback? It probes three window states (cloaked+off-screen,
/// uncloaked+off-screen, uncloaked+on-screen), records exactly which one produces a non-blank frame,
/// and — for the first working state — measures WGC vs RTB capture/readback/encode over
/// <paramref name="measured"/> iterations on the typical doc at both sizes. RTB stays the default
/// live-path capture no matter the outcome; a negative result here is itself a valid finding.
/// </summary>
internal static class WgcBenchmark
{
    public static async Task RunAsync(RenderHost host, int warmup = 3, int measured = 20)
    {
        var sb = new StringBuilder();
        void Emit(string line)
        {
            Console.Out.WriteLine(line);
            Console.Out.Flush();
            sb.AppendLine(line);
        }

        bool supported = WgcCapture.IsSupported();

        Emit("");
        Emit("===================== S5 PART 2 — WGC vs RTB CAPTURE (feasibility + timing) =====================");
        Emit($"  dpiScale={host.DpiScale.ToString("0.###", CultureInfo.InvariantCulture)}  " +
             $"wgcSupported={supported}  warmup={warmup}  measured={measured}");
        Emit($"  processors={Environment.ProcessorCount}  os={Environment.OSVersion.Version}");
        Emit("  Q: can WGC capture our HEADLESS render window, and in what state (cloaked / off-screen / on-screen)?");
        Emit("  note: WGC grabs the whole COMPOSED WINDOW (chrome incl.); RTB grabs the element subtree — sizes differ.");
        Emit("================================================================================================");

        var sizes = new (int w, int h)[] { (800, 600), (1600, 1200) };
        var entries = new List<object>();

        if (!supported)
        {
            Emit("");
            Emit("  RESULT: GraphicsCaptureSession.IsSupported() = FALSE on this host.");
            Emit("  => WGC is unavailable here; RTB remains the only viable capture path. (See report interpretation.)");
            WriteJson(host, supported, entries, sb);
            return;
        }

        foreach (var (w, h) in sizes)
        {
            Emit("");
            Emit($"### typical @ {w}x{h} (viewport DIP) ###");

            var root = await host.HostContentAsync(Benchmark.TypicalDoc, w, h);
            if (root is null)
            {
                Emit("  (failed to host content; skipping this size)");
                continue;
            }
            var hwnd = host.RenderWindowHwnd;

            // ---- feasibility probe: which window state yields a non-blank WGC frame? ----
            var states = new (string name, bool cloaked, int x, int y)[]
            {
                ("cloaked+offscreen",   true,  -32000, -32000),  // the current headless default
                ("uncloaked+offscreen", false, -32000, -32000),  // composed but parked off-screen
                ("uncloaked+onscreen",  false, 120,    120),     // control: unambiguously composed
            };

            var probeOutcomes = new List<object>();
            (string name, bool cloaked, int x, int y)? working = null;

            foreach (var st in states)
            {
                host.SetRenderWindowCloaked(st.cloaked);
                host.MoveRenderWindow(st.x, st.y);
                await Task.Delay(180); // let DWM react to the cloak/position change before capturing

                var p = await WgcCapture.CaptureWindowAsync(hwnd, timeoutMs: 1200);
                string verdict = p.Success ? (p.Blank ? "BLANK frame" : $"OK non-blank {p.Width}x{p.Height}")
                                           : $"FAIL ({p.Error})";
                Emit($"  probe [{st.name,-20}] device={p.DeviceKind,-8} setup={p.SetupMs,6:F1}  " +
                     $"firstFrame={p.FirstFrameMs,6:F1}  readback={p.ReadbackMs,6:F1}  (ms)  -> {verdict}");

                probeOutcomes.Add(new
                {
                    state = st.name,
                    cloaked = st.cloaked,
                    success = p.Success,
                    blank = p.Blank,
                    error = p.Error,
                    deviceKind = p.DeviceKind,
                    outputPixels = new { width = p.Width, height = p.Height },
                    setupMs = Math.Round(p.SetupMs, 3),
                    firstFrameMs = Math.Round(p.FirstFrameMs, 3),
                    readbackMs = Math.Round(p.ReadbackMs, 3),
                });

                if (working is null && p.Success && !p.Blank)
                {
                    working = st; // remember the first working state, but keep probing the rest
                }
            }

            object? comparison = null;
            if (working is null)
            {
                Emit($"  => no window state produced a non-blank WGC frame at {w}x{h}. WGC cannot capture this headless window here.");
            }
            else
            {
                var st = working.Value;
                Emit($"  => first working state: [{st.name}].  Measuring WGC vs RTB in that state ({measured} iters)…");

                host.SetRenderWindowCloaked(st.cloaked);
                host.MoveRenderWindow(st.x, st.y);
                await Task.Delay(180);

                // Visual verification (one-off): dump a WGC frame and an RTB frame so we can confirm
                // WGC actually captured the RENDERED XAML (not just white chrome) from this window state.
                try
                {
                    var vp = await WgcCapture.CaptureWindowAsync(hwnd, timeoutMs: 1500);
                    if (vp.Success && vp.Pixels is not null)
                    {
                        var wjpeg = await RenderHost.EncodeJpegPublicAsync(vp.Pixels, vp.Width, vp.Height);
                        File.WriteAllBytes(Path.Combine(Paths.OutDir, $"wgc-sample-{w}x{h}.jpg"), wjpeg);
                    }
                    var (rpx, rw2, rh2, _, _) = await host.CaptureHostedRtbAsync(root);
                    if (rw2 > 0)
                    {
                        var rjpeg = await RenderHost.EncodeJpegPublicAsync(rpx, rw2, rh2);
                        File.WriteAllBytes(Path.Combine(Paths.OutDir, $"rtb-sample-{w}x{h}.jpg"), rjpeg);
                    }
                    Emit($"  (wrote wgc-sample-{w}x{h}.jpg + rtb-sample-{w}x{h}.jpg for visual verification)");
                }
                catch (Exception ex) { Emit($"  (sample dump failed: {ex.Message})"); }

                var wgcAcquire = new List<double>();   // StartCapture -> first frame
                var wgcReadback = new List<double>();  // CreateCopyFromSurface + CopyToBuffer
                var wgcEncode = new List<double>();
                var wgcSetup = new List<double>();
                var wgcKB = new List<double>();
                int wgcW = 0, wgcH = 0, wgcFail = 0;

                var rtbRender = new List<double>();     // RenderTargetBitmap.RenderAsync
                var rtbReadback = new List<double>();   // GetPixelsAsync
                var rtbEncode = new List<double>();
                var rtbKB = new List<double>();
                int rtbW = 0, rtbH = 0;

                for (int i = 0; i < warmup + measured; i++)
                {
                    bool warm = i < warmup;

                    // WGC path
                    var p = await WgcCapture.CaptureWindowAsync(hwnd, timeoutMs: 1500);
                    if (p.Success && !p.Blank && p.Pixels is not null)
                    {
                        long te = System.Diagnostics.Stopwatch.GetTimestamp();
                        var jpeg = await RenderHost.EncodeJpegPublicAsync(p.Pixels, p.Width, p.Height);
                        double encMs = RenderHost.ElapsedMs(te);
                        if (!warm)
                        {
                            wgcAcquire.Add(p.FirstFrameMs);
                            wgcReadback.Add(p.ReadbackMs);
                            wgcEncode.Add(encMs);
                            wgcSetup.Add(p.SetupMs);
                            wgcKB.Add(jpeg.Length / 1024.0);
                            wgcW = p.Width; wgcH = p.Height;
                        }
                    }
                    else if (!warm)
                    {
                        wgcFail++;
                    }

                    // RTB path on the SAME hosted content, same window state (apples-to-apples)
                    var (pixels, rw, rh, renderMs, readbackMs) = await host.CaptureHostedRtbAsync(root);
                    if (rw > 0 && rh > 0)
                    {
                        long te = System.Diagnostics.Stopwatch.GetTimestamp();
                        var jpeg = await RenderHost.EncodeJpegPublicAsync(pixels, rw, rh);
                        double encMs = RenderHost.ElapsedMs(te);
                        if (!warm)
                        {
                            rtbRender.Add(renderMs);
                            rtbReadback.Add(readbackMs);
                            rtbEncode.Add(encMs);
                            rtbKB.Add(jpeg.Length / 1024.0);
                            rtbW = rw; rtbH = rh;
                        }
                    }
                }

                var wAcq = Stat.From(wgcAcquire);
                var wRb = Stat.From(wgcReadback);
                var wEnc = Stat.From(wgcEncode);
                var wSet = Stat.From(wgcSetup);
                var wKB = Stat.From(wgcKB);
                var rRnd = Stat.From(rtbRender);
                var rRb = Stat.From(rtbReadback);
                var rEnc = Stat.From(rtbEncode);
                var rKB = Stat.From(rtbKB);

                Emit("");
                Emit($"  {"method",-10}{"acquire p50",13}{"p95",8}{"readback p50",14}{"p95",8}{"encode p50",12}{"cpuTotal p50",14}{"frameKB",9}");
                Emit($"  {"WGC",-10}{wAcq.P50,13:F1}{wAcq.P95,8:F1}{wRb.P50,14:F1}{wRb.P95,8:F1}{wEnc.P50,12:F1}" +
                     $"{(wAcq.P50 + wRb.P50),14:F1}{wKB.P50,9:F1}   ({wgcW}x{wgcH} px, whole window; setup p50={wSet.P50:F1}ms/frame)");
                Emit($"  {"RTB",-10}{rRnd.P50,13:F1}{rRnd.P95,8:F1}{rRb.P50,14:F1}{rRb.P95,8:F1}{rEnc.P50,12:F1}" +
                     $"{(rRnd.P50 + rRb.P50),14:F1}{rKB.P50,9:F1}   ({rtbW}x{rtbH} px, element subtree)");
                if (wgcFail > 0) Emit($"  (WGC failed/blank on {wgcFail}/{measured} measured iterations)");

                comparison = new
                {
                    workingState = st.name,
                    iterations = measured,
                    wgcFailures = wgcFail,
                    wgc = new
                    {
                        outputPixels = new { width = wgcW, height = wgcH },
                        scope = "whole-window(chrome incl.)",
                        acquireMs = wAcq.ToObj(),
                        readbackMs = wRb.ToObj(),
                        encodeMs = wEnc.ToObj(),
                        setupMsPerFrame = wSet.ToObj(),
                        frameKB = wKB.ToObj(),
                    },
                    rtb = new
                    {
                        outputPixels = new { width = rtbW, height = rtbH },
                        scope = "element-subtree",
                        renderMs = rRnd.ToObj(),
                        readbackMs = rRb.ToObj(),
                        encodeMs = rEnc.ToObj(),
                        frameKB = rKB.ToObj(),
                    },
                };
            }

            // Restore the headless default (cloaked + parked off-screen) and unmount.
            host.SetRenderWindowCloaked(true);
            host.MoveRenderWindow(-32000, -32000);
            host.ClearRenderContent();

            entries.Add(new
            {
                document = "typical",
                width = w,
                height = h,
                probes = probeOutcomes,
                workingState = working?.name,
                comparison,
            });
        }

        Emit("");
        Emit("================================================================================================");
        WriteJson(host, supported, entries, sb);
    }

    private static void WriteJson(RenderHost host, bool supported, List<object> entries, StringBuilder sb)
    {
        string outPath = Path.Combine(Paths.OutDir, "s5-wgc-results.json");
        try
        {
            Directory.CreateDirectory(Paths.OutDir);
            var payload = new
            {
                spike = "S5",
                part = 2,
                wgcSupported = supported,
                machine = new
                {
                    dpiScale = host.DpiScale,
                    processorCount = Environment.ProcessorCount,
                    osVersion = Environment.OSVersion.Version.ToString(),
                    timestamp = DateTimeOffset.Now.ToString("o"),
                },
                results = entries,
            };
            File.WriteAllText(outPath, JsonSerializer.Serialize(payload, new JsonSerializerOptions { WriteIndented = true }));
            Console.Out.WriteLine($"  wrote {outPath}");
            Console.Out.Flush();
            sb.AppendLine($"  wrote {outPath}");
        }
        catch (Exception ex)
        {
            Console.Out.WriteLine($"  WARNING: failed to write {outPath}: {ex.Message}");
        }
        Console.Out.WriteLine("========================= WGC BENCHMARK COMPLETE =========================");
        Console.Out.Flush();
        App.Log("WGC benchmark complete.\n" + sb);
    }

    /// <summary>Six-number summary (mirrors Benchmark.Stat; kept local so the two harnesses stay independent).</summary>
    private readonly struct Stat
    {
        public double P50 { get; init; }
        public double P95 { get; init; }
        public double P99 { get; init; }
        public double Min { get; init; }
        public double Max { get; init; }
        public double Mean { get; init; }

        public static Stat From(List<double> values)
        {
            if (values.Count == 0) return new Stat();
            var sorted = values.ToArray();
            Array.Sort(sorted);
            return new Stat
            {
                P50 = Percentile(sorted, 50),
                P95 = Percentile(sorted, 95),
                P99 = Percentile(sorted, 99),
                Min = sorted[0],
                Max = sorted[^1],
                Mean = sorted.Average(),
            };
        }

        public object ToObj() => new
        {
            p50 = Math.Round(P50, 3),
            p95 = Math.Round(P95, 3),
            p99 = Math.Round(P99, 3),
            min = Math.Round(Min, 3),
            max = Math.Round(Max, 3),
            mean = Math.Round(Mean, 3),
        };

        private static double Percentile(double[] sortedAsc, double p)
        {
            int n = sortedAsc.Length;
            if (n == 1) return sortedAsc[0];
            double rank = (p / 100.0) * (n - 1);
            int lo = (int)Math.Floor(rank), hi = (int)Math.Ceiling(rank);
            if (lo == hi) return sortedAsc[lo];
            return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (rank - lo);
        }
    }
}
