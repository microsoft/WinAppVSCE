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
/// The <c>--benchmark</c> path (S5 Part 1). Runs entirely separate from the TCP frame server:
/// it drives <see cref="RenderHost.RenderAsync"/> directly on the UI thread with a
/// <see cref="RenderTimings"/> collector, over a fixed set of documents × sizes, discarding a
/// warm-up burst and then measuring ≥40 iterations each. For every (document × size) it prints a
/// per-stage p50/p95/p99/min/max/mean table (milliseconds) plus frame KB to stdout, and writes the
/// same data as machine-readable JSON to <c>surface\out\s5-results.json</c>.
///
/// Stages measured (see <see cref="RenderTimings"/>): clean, parse, layout, capture (RTB), encode,
/// total. The pipeline itself is unchanged from the live server path — this only observes it.
/// </summary>
internal static class Benchmark
{
    private const string Pres = "http://schemas.microsoft.com/winfx/2006/xaml/presentation";
    private const string X = "http://schemas.microsoft.com/winfx/2006/xaml";

    // (a) "Typical" page — the samples\Demo.xaml shape: a real Page with x:Class, {x:Bind}, a Click
    // handler, d:/mc: design namespaces, two {StaticResource} refs, the implicit teal Button style,
    // and the custom local:FancyBadge (~8 controls). Two deliberate deviations from Demo.xaml so the
    // size sweep is meaningful: Background moved to the Page root and the intrinsic d:DesignWidth
    // dropped, so the page fills each viewport (otherwise a fixed 700px width would mask size scaling).
    // Internal so the S5 Part 2 (WGC) benchmark can reuse the exact same "typical" document.
    internal static readonly string TypicalDoc =
$@"<Page x:Class=""TestUserApp.DemoPage""
      xmlns=""{Pres}""
      xmlns:x=""{X}""
      xmlns:d=""http://schemas.microsoft.com/expression/blend/2008""
      xmlns:mc=""http://schemas.openxmlformats.org/markup-compatibility/2006""
      xmlns:local=""using:TestUserApp""
      mc:Ignorable=""d""
      Background=""White"">
    <StackPanel Spacing=""16"" Padding=""24"">
        <TextBlock Text=""WinUI Live Visualizer"" Style=""{{StaticResource HeaderTextStyle}}""/>
        <TextBlock TextWrapping=""Wrap"" Opacity=""0.7""
                   Text=""A real Page: x:Class, x:Bind, Click, d:/mc: and StaticResource are all handled.""/>
        <Button Content=""Click me"" Click=""OnClick"" Foreground=""{{StaticResource AccentBrush}}""/>
        <local:FancyBadge Label=""custom control""/>
        <TextBlock Text=""{{x:Bind Title}}""/>
        <Border Background=""#E8F0FE"" CornerRadius=""8"" Padding=""16"">
            <TextBlock Text=""Edit this file and the preview updates.""/>
        </Border>
    </StackPanel>
</Page>";

    /// <summary>Runs the RTB benchmark and writes the table (stdout) + JSON (out\s5-results.json).</summary>
    public static async Task RunAsync(RenderHost host, int warmup = 5, int measured = 40)
    {
        var docs = new (string name, string xaml)[]
        {
            ("typical", TypicalDoc),
            ("heavy", BuildHeavyGrid(12, 12)),
        };
        var sizes = new (int w, int h)[] { (800, 600), (1600, 1200) };

        var sb = new StringBuilder();
        void Emit(string line)
        {
            Console.Out.WriteLine(line);
            Console.Out.Flush();
            sb.AppendLine(line);
        }

        Emit("");
        Emit("========================= S5 RENDER-LATENCY BENCHMARK (RTB pipeline) =========================");
        Emit($"  dpiScale={host.DpiScale.ToString("0.###", CultureInfo.InvariantCulture)}  " +
             $"warmup={warmup}  measured={measured}  scale=1.0  captureMethod=rtb");
        Emit($"  processors={Environment.ProcessorCount}  64-bit={Environment.Is64BitProcess}  " +
             $"clr={Environment.Version}  os={Environment.OSVersion.Version}");
        Emit("  all times in milliseconds; stages = clean, parse, layout, capture(RTB), encode, total");
        Emit("=============================================================================================");

        var entries = new List<object>();

        foreach (var (docName, xaml) in docs)
        {
            foreach (var (w, h) in sizes)
            {
                var clean = new List<double>(measured);
                var parse = new List<double>(measured);
                var layout = new List<double>(measured);
                var capture = new List<double>(measured);
                var cRender1 = new List<double>(measured);
                var cSettle = new List<double>(measured);
                var cRender2 = new List<double>(measured);
                var cReadback = new List<double>(measured);
                var encode = new List<double>(measured);
                var total = new List<double>(measured);
                var frameKB = new List<double>(measured);
                int outW = 0, outH = 0, failures = 0;

                // Warm-up (discarded): JIT, first-touch allocations, GPU warm-up, WIC codec load.
                for (int i = 0; i < warmup; i++)
                {
                    await host.RenderAsync(xaml, w, h, 1.0, new RenderTimings());
                }

                // Measured.
                for (int i = 0; i < measured; i++)
                {
                    var t = new RenderTimings();
                    var r = await host.RenderAsync(xaml, w, h, 1.0, t);
                    if (!r.Success)
                    {
                        failures++;
                        App.Log($"[benchmark] {docName}@{w}x{h} iter {i} FAILED: {r.Phase}: {r.Message}");
                        continue;
                    }
                    clean.Add(t.CleanMs);
                    parse.Add(t.ParseMs);
                    layout.Add(t.LayoutMs);
                    capture.Add(t.CaptureMs);
                    cRender1.Add(t.CaptureRender1Ms);
                    cSettle.Add(t.CaptureSettleMs);
                    cRender2.Add(t.CaptureRender2Ms);
                    cReadback.Add(t.CaptureReadbackMs);
                    encode.Add(t.EncodeMs);
                    total.Add(t.TotalMs);
                    frameKB.Add(t.FrameBytes / 1024.0);
                    outW = r.Width;
                    outH = r.Height;
                }

                var sClean = Stat.From(clean);
                var sParse = Stat.From(parse);
                var sLayout = Stat.From(layout);
                var sCapture = Stat.From(capture);
                var sR1 = Stat.From(cRender1);
                var sSettle = Stat.From(cSettle);
                var sR2 = Stat.From(cRender2);
                var sReadback = Stat.From(cReadback);
                var sEncode = Stat.From(encode);
                var sTotal = Stat.From(total);
                var sFrame = Stat.From(frameKB);

                Emit("");
                Emit($"--- {docName} @ {w}x{h}  (output {outW}x{outH} px, frame {sFrame.P50:F1} KB, " +
                     $"{total.Count}/{measured} ok{(failures > 0 ? $", {failures} failed" : "")}) ---");
                Emit($"  {"stage",-8}{"p50",9}{"p95",9}{"p99",9}{"min",9}{"max",9}{"mean",9}");
                Emit(Row("clean", sClean));
                Emit(Row("parse", sParse));
                Emit(Row("layout", sLayout));
                Emit(Row("capture", sCapture));
                Emit(Row("encode", sEncode));
                Emit(Row("total", sTotal));
                Emit($"  capture(RTB) breakdown p50: render1={sR1.P50:F1}  settle={sSettle.P50:F1}  " +
                     $"render2={sR2.P50:F1}  readback={sReadback.P50:F1}  (ms)");

                entries.Add(new
                {
                    document = docName,
                    width = w,
                    height = h,
                    scale = 1.0,
                    captureMethod = "rtb",
                    outputPixels = new { width = outW, height = outH },
                    iterations = total.Count,
                    failures,
                    frameKB = sFrame.ToObj(),
                    stages = new
                    {
                        clean = sClean.ToObj(),
                        parse = sParse.ToObj(),
                        layout = sLayout.ToObj(),
                        capture = sCapture.ToObj(),
                        encode = sEncode.ToObj(),
                        total = sTotal.ToObj(),
                    },
                    captureBreakdown = new
                    {
                        render1 = sR1.ToObj(),
                        settle = sSettle.ToObj(),
                        render2 = sR2.ToObj(),
                        readback = sReadback.ToObj(),
                    },
                });
            }
        }

        Emit("");
        Emit("=============================================================================================");

        // Persist machine-readable results next to the other spike artifacts (git-ignored out\).
        string outPath = Path.Combine(Paths.OutDir, "s5-results.json");
        try
        {
            Directory.CreateDirectory(Paths.OutDir);
            var payload = new
            {
                spike = "S5",
                part = 1,
                captureMethod = "rtb",
                warmup,
                measured,
                machine = new
                {
                    dpiScale = host.DpiScale,
                    processorCount = Environment.ProcessorCount,
                    is64BitProcess = Environment.Is64BitProcess,
                    clrVersion = Environment.Version.ToString(),
                    osVersion = Environment.OSVersion.Version.ToString(),
                    timestamp = DateTimeOffset.Now.ToString("o"),
                },
                results = entries,
            };
            File.WriteAllText(outPath, JsonSerializer.Serialize(payload, new JsonSerializerOptions { WriteIndented = true }));
            Emit($"  wrote {outPath}");
        }
        catch (Exception ex)
        {
            Emit($"  WARNING: failed to write {outPath}: {ex.Message}");
        }

        Emit("========================= BENCHMARK COMPLETE =========================");
        App.Log("Benchmark complete.\n" + sb);
    }

    private static string Row(string label, Stat s) =>
        $"  {label,-8}{s.P50,9:F2}{s.P95,9:F2}{s.P99,9:F2}{s.Min,9:F2}{s.Max,9:F2}{s.Mean,9:F2}";

    /// <summary>
    /// Builds a "heavy" document: a <paramref name="rows"/>×<paramref name="cols"/> star grid whose
    /// cells cycle through TextBlock / Button / (Border wrapping a TextBlock), to show how latency
    /// scales with tree size. 12×12 → 144 cells (~192 elements incl. the Border-nested TextBlocks).
    /// </summary>
    internal static string BuildHeavyGrid(int rows, int cols)
    {
        var sb = new StringBuilder(16 * 1024);
        sb.Append($"<Grid xmlns=\"{Pres}\" xmlns:x=\"{X}\" Background=\"White\">");
        sb.Append("<Grid.RowDefinitions>");
        for (int r = 0; r < rows; r++) sb.Append("<RowDefinition Height=\"*\"/>");
        sb.Append("</Grid.RowDefinitions><Grid.ColumnDefinitions>");
        for (int c = 0; c < cols; c++) sb.Append("<ColumnDefinition Width=\"*\"/>");
        sb.Append("</Grid.ColumnDefinitions>");

        int i = 0;
        for (int r = 0; r < rows; r++)
        {
            for (int c = 0; c < cols; c++)
            {
                switch (i % 3)
                {
                    case 0:
                        sb.Append($"<TextBlock Grid.Row=\"{r}\" Grid.Column=\"{c}\" Margin=\"4\" " +
                                  $"Foreground=\"#202020\" Text=\"R{r}C{c}\"/>");
                        break;
                    case 1:
                        sb.Append($"<Button Grid.Row=\"{r}\" Grid.Column=\"{c}\" Margin=\"4\" " +
                                  $"Content=\"B{i}\"/>");
                        break;
                    default:
                        sb.Append($"<Border Grid.Row=\"{r}\" Grid.Column=\"{c}\" Margin=\"4\" " +
                                  $"Background=\"#E0E7FF\" CornerRadius=\"4\" Padding=\"6\">" +
                                  $"<TextBlock Foreground=\"#3730A3\" Text=\"{i}\"/></Border>");
                        break;
                }
                i++;
            }
        }
        sb.Append("</Grid>");
        return sb.ToString();
    }

    /// <summary>Six-number summary of a sample set, computed once and reused for the table and JSON.</summary>
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
            if (values.Count == 0)
            {
                return new Stat();
            }
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
            p50 = Round(P50),
            p95 = Round(P95),
            p99 = Round(P99),
            min = Round(Min),
            max = Round(Max),
            mean = Round(Mean),
        };

        private static double Round(double v) => Math.Round(v, 3);

        // Linear-interpolation percentile (NumPy default) over an ascending-sorted array.
        private static double Percentile(double[] sortedAsc, double p)
        {
            int n = sortedAsc.Length;
            if (n == 1) return sortedAsc[0];
            double rank = (p / 100.0) * (n - 1);
            int lo = (int)Math.Floor(rank);
            int hi = (int)Math.Ceiling(rank);
            if (lo == hi) return sortedAsc[lo];
            double frac = rank - lo;
            return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * frac;
        }
    }
}
