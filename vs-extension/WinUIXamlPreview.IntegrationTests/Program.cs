using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json.Nodes;
using System.Threading;

namespace WinUIXamlPreview.IntegrationTests
{
    /// <summary>
    /// In-VS integration tests for the WinUI XAML Preview extension. Each section is a <c>Group_*</c> method; run one
    /// with <c>--group Name</c> (comma-separated for several). Results go to the console and to &lt;out&gt;\results.log
    /// (the console is invisible when run on the hidden desktop).
    /// </summary>
    internal static partial class Program
    {
        private const string ProductVsixId = "WinUIXamlPreview.735e99b9-7953-4336-b8e8-b083b29effa4";
        private const string AgentVsixId = "WinUIXamlPreview.TestAgent.6b0c3a4e-2f5d-4b8e-9a51-7c3e2d9f1a60";
        internal const string ToolWindowGuid = "019aaf07-5cd5-483d-9231-159c5d00dfb7";
        internal const string CommandSetGuid = "5c97e212-6033-4935-8de3-82e1bd9245df";
        internal const int ShowPreviewCommandId = 0x0100;

        private static string _devenv = "";
        private static string _instance = "";
        private static string _rootSuffix = "WinUIPreviewTest";
        private static string _out = "";
        private static StreamWriter? _log;
        private static Process? _vs;
        private static AgentClient? _agent;
        private static Fixture _fx = null!;
        private static int _passed, _failed;
        private static readonly List<string> Failures = new List<string>();
        private static readonly HashSet<int> SurfacePids = new HashSet<int>();

        private static readonly (string Name, Action Body)[] Groups =
        {
            ("Load", Group_Load),
            ("Margin", Group_Margin),
            ("Render", Group_Render),
            ("Edit", Group_Edit),
            ("Caret", Group_Caret),
            ("Toolbar", Group_Toolbar),
            ("Errors", Group_Errors),
            ("Crash", Group_Crash),
        };

        private static int Main(string[] args)
        {
            string? productVsix = null, agentVsix = null, only = null;
            bool install = true, keepOpen = false;
            for (int i = 0; i < args.Length; i++)
            {
                string Next() => args[++i];
                switch (args[i])
                {
                    case "--vsix": productVsix = Next(); break;
                    case "--agent-vsix": agentVsix = Next(); break;
                    case "--devenv": _devenv = Next(); break;
                    case "--instance": _instance = Next(); break;
                    case "--root-suffix": _rootSuffix = Next(); break;
                    case "--out": _out = Next(); break;
                    case "--group": only = Next(); break;
                    case "--no-install": install = false; break;
                    case "--keep-open": keepOpen = true; break;
                    default: Console.Error.WriteLine("unknown arg " + args[i]); return 2;
                }
            }

            if (_devenv.Length == 0 || _instance.Length == 0 || _out.Length == 0)
            {
                Console.Error.WriteLine("usage: --devenv <devenv.exe> --instance <id> --out <dir> [--vsix p] [--agent-vsix p] [--group A,B] [--no-install] [--keep-open]");
                return 2;
            }

            Directory.CreateDirectory(_out);
            _log = new StreamWriter(Path.Combine(_out, "results.log"), append: false) { AutoFlush = true };
            _fx = new Fixture(Path.Combine(_out, "fixture"));

            try
            {
                _fx.Create();
                PrimeHiveIfNeeded();
                if (install)
                {
                    var changed = InstallVsix(productVsix ?? throw new ArgumentException("--vsix required"), ProductVsixId)
                                | InstallVsix(agentVsix ?? throw new ArgumentException("--agent-vsix required"), AgentVsixId);
                    if (changed)
                    {
                        // VSIXInstaller doesn't always mark the hive's config as stale, so new pkgdefs can be ignored.
                        Log("  updateconfiguration exit " + RunProcess(_devenv, $"/rootsuffix {_rootSuffix} /updateconfiguration", 300));
                    }
                }
                LaunchVs();

                var selected = only == null
                    ? Groups
                    : Groups.Where(g => only.Split(',').Any(o => string.Equals(o.Trim(), g.Name, StringComparison.OrdinalIgnoreCase))).ToArray();
                if (selected.Length == 0)
                {
                    Log("No groups matched '" + only + "'. Known: " + string.Join(", ", Groups.Select(g => g.Name)));
                    return 2;
                }

                foreach (var g in selected)
                {
                    Log("");
                    Log("## " + g.Name);
                    ResetState();
                    g.Body();
                }
            }
            catch (Exception ex)
            {
                _failed++;
                Failures.Add("SETUP: " + ex.Message);
                Log("SETUP FAILED: " + ex);
            }
            finally
            {
                if (!keepOpen)
                {
                    ShutdownVs();
                }
            }

            Log("");
            foreach (var f in Failures)
            {
                Log("  FAILED: " + f);
            }
            Log($"===== {_passed} passed, {_failed} failed =====");
            return _failed == 0 ? 0 : 1;
        }

        // ---------------------------------------------------------------------------------------------------
        // Harness
        // ---------------------------------------------------------------------------------------------------

        internal static void Log(string line)
        {
            var stamped = DateTime.Now.ToString("HH:mm:ss.fff") + " " + line;
            Console.WriteLine(stamped);
            _log?.WriteLine(stamped);
        }

        private static string HiveGlob() => "*_" + _instance + _rootSuffix;

        private static void PrimeHiveIfNeeded()
        {
            var vsData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "VisualStudio");
            var hive = Directory.Exists(vsData) ? Directory.GetDirectories(vsData, HiveGlob()).FirstOrDefault() : null;
            if (hive != null && File.Exists(Path.Combine(hive, "wxp-primed.txt")))
            {
                return;
            }

            // A brand-new hive shows the first-run sign-in dialog, which blocks automation. Resetting to the General
            // profile and exiting once marks first-run as complete.
            Log("Priming VS hive '" + _rootSuffix + "' (first-run)...");
            var code = RunProcess(_devenv, $"/rootsuffix {_rootSuffix} /resetsettings General.vssettings /command File.Exit", 300);
            Log("  prime exit " + code);

            // Startup = "Empty environment": the Start window otherwise replaces the main window until dismissed.
            var ideRoot = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(_devenv)!, "..", ".."));
            var regedit = Path.Combine(Path.GetDirectoryName(_devenv)!, "vsregedit.exe");
            Log("  start window off: " + RunProcess(regedit, $"set \"{ideRoot}\" {_rootSuffix} HKCU General OnEnvironmentStartup dword 4", 60));
            hive = Directory.GetDirectories(vsData, HiveGlob()).FirstOrDefault()
                ?? throw new InvalidOperationException("hive not created by priming");
            File.WriteAllText(Path.Combine(hive, "wxp-primed.txt"), DateTime.Now.ToString("o"));
        }

        private static string? HiveDir()
        {
            var vsData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "VisualStudio");
            return Directory.Exists(vsData) ? Directory.GetDirectories(vsData, HiveGlob()).FirstOrDefault() : null;
        }

        /// <summary>(Re)installs <paramref name="vsix"/> unless this exact file is already installed in the hive
        /// (VSIXInstaller costs ~1-2 min per package). Returns true if it installed.</summary>
        private static bool InstallVsix(string vsix, string id)
        {
            string hash;
            using (var sha = System.Security.Cryptography.SHA256.Create())
            using (var fs = File.OpenRead(vsix))
            {
                hash = BitConverter.ToString(sha.ComputeHash(fs)).Replace("-", "");
            }
            var marker = Path.Combine(HiveDir() ?? Path.GetTempPath(), "wxp-installed-" + id + ".sha256");
            if (File.Exists(marker) && File.ReadAllText(marker).Trim() == hash)
            {
                Log($"{Path.GetFileName(vsix)} unchanged; already installed");
                return false;
            }
            if (File.Exists(marker))
            {
                File.Delete(marker);
            }

            var installer = Path.Combine(Path.GetDirectoryName(_devenv)!, "VSIXInstaller.exe");
            var scope = $"/quiet /rootSuffix:{_rootSuffix} /instanceIds:{_instance}";
            // The product version is fixed, so a plain install of a rebuilt VSIX is skipped as "already installed".
            var u = RunProcess(installer, $"{scope} /uninstall:{id}", 300);
            var code = RunProcess(installer, $"{scope} \"{vsix}\"", 300);
            Log($"Installed {Path.GetFileName(vsix)} (uninstall={u}, install={code})");
            if (code != 0)
            {
                throw new InvalidOperationException($"VSIXInstaller failed ({code}) for {vsix}; see %TEMP%\\dd_VSIXInstaller_*.log");
            }
                            File.WriteAllText(marker, hash);
                            return true;
        }

        private static int RunProcess(string exe, string args, int timeoutSeconds)
        {
            using var p = Process.Start(new ProcessStartInfo(exe, args) { UseShellExecute = false })!;
            if (!p.WaitForExit(timeoutSeconds * 1000))
            {
                try { p.Kill(); } catch { }
                throw new TimeoutException($"{Path.GetFileName(exe)} timed out");
            }
            return p.ExitCode;
        }

        private static void LaunchVs()
        {
            var pipe = "wxp-test-" + Guid.NewGuid().ToString("N");
            var psi = new ProcessStartInfo(_devenv, $"/rootsuffix {_rootSuffix} \"{_fx.Solution}\"") { UseShellExecute = false };
            psi.EnvironmentVariables["WINUI_PREVIEW_TEST_PIPE"] = pipe;
            Log("Launching VS...");
            _vs = Process.Start(psi)!;

            var sw = Stopwatch.StartNew();
            while (sw.Elapsed < TimeSpan.FromSeconds(240))
            {
                if (_vs.HasExited)
                {
                    throw new InvalidOperationException("devenv exited during startup with code " + _vs.ExitCode);
                }
                _agent = AgentClient.TryConnect(pipe, 2000);
                if (_agent != null)
                {
                    break;
                }
            }
            if (_agent == null)
            {
                throw new TimeoutException("agent pipe never came up (is the TestAgent VSIX installed and enabled?)");
            }
            Log($"Agent connected after {sw.Elapsed.TotalSeconds:0.0}s (devenv pid {_vs.Id})");
            Call("ping");

            // Wait until both fixture projects are loaded (fullName set) so .xaml files get the XAML content type.
            var load = Stopwatch.StartNew();
            JsonNode? projects = null;
            while (load.Elapsed < TimeSpan.FromSeconds(120))
            {
                projects = Call("projects");
                if (projects!.AsArray().Count(p => ((string?)p?["fullName"])?.EndsWith(".csproj") == true) >= 2)
                {
                    break;
                }
                Thread.Sleep(500);
            }
            Log($"Solution projects after {load.Elapsed.TotalSeconds:0.0}s: {projects?.ToJsonString()}");
        }

        private static void ShutdownVs()
        {
            if (_vs == null)
            {
                return;
            }
            try
            {
                if (!_vs.HasExited && _agent != null)
                {
                    try { CollectPids(); Call("quit"); } catch { }
                }
                if (!_vs.WaitForExit(90_000))
                {
                    Log("devenv did not exit; killing " + _vs.Id);
                    try { _vs.Kill(); } catch { }
                }
            }
            finally
            {
                _agent?.Dispose();
                _agent = null;
            }
        }

        /// <summary>Clean slate between groups: default options, no open documents, pristine fixture pages.</summary>
        private static void ResetState()
        {
            CollectPids();
            Call("closeAll");
            Call("resetOptions");
            _fx.ResetPages();
        }

        internal static JsonNode? Call(string cmd, object? args = null) =>
            (_agent ?? throw new InvalidOperationException("no agent")).Call(cmd, args);

        internal static JsonObject Snap()
        {
            var s = Call("snapshot")!.AsObject();
            foreach (var session in s["sessions"]!.AsArray())
            {
                AddPid(session?["clientPid"]);
                AddPid(session?["sparePid"]);
            }
            return s;
        }

        private static void AddPid(JsonNode? n)
        {
            if (n != null && n.GetValueKind() == System.Text.Json.JsonValueKind.Number)
            {
                SurfacePids.Add(n.GetValue<int>());
            }
        }

        private static void CollectPids()
        {
            try { Snap(); } catch { }
        }

        internal static JsonObject? Margin(JsonObject snap, string path) =>
            snap["margins"]!.AsArray().OfType<JsonObject>()
                .FirstOrDefault(m => string.Equals((string?)m["path"], path, StringComparison.OrdinalIgnoreCase) && m["disposed"]?.GetValue<bool>() != true);

        internal static JsonObject? Preview(JsonObject snap, string path) => Margin(snap, path)?["preview"]?.AsObject();

        /// <summary>Polls the snapshot until <paramref name="pred"/> holds; throws with the last snapshot on timeout.</summary>
        internal static JsonObject WaitFor(string what, Func<JsonObject, bool> pred, int timeoutMs = 30_000)
        {
            var sw = Stopwatch.StartNew();
            JsonObject snap;
            while (true)
            {
                snap = Snap();
                bool ok;
                try { ok = pred(snap); } catch (Exception) { ok = false; }
                if (ok)
                {
                    return snap;
                }
                if (sw.ElapsedMilliseconds > timeoutMs)
                {
                    throw new TestFailure($"timed out after {timeoutMs}ms waiting for: {what}\n      last snapshot: {Trim(snap.ToJsonString())}");
                }
                Thread.Sleep(150);
            }
        }

        /// <summary>Asserts <paramref name="pred"/> stays true for <paramref name="ms"/> (negative checks).</summary>
        internal static void Holds(string what, Func<JsonObject, bool> pred, int ms)
        {
            var sw = Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < ms)
            {
                var snap = Snap();
                if (!pred(snap))
                {
                    throw new TestFailure($"expected to hold for {ms}ms: {what}\n      snapshot: {Trim(snap.ToJsonString())}");
                }
                Thread.Sleep(150);
            }
        }

        private static string Trim(string s) => s.Length > 3000 ? s.Substring(0, 3000) + "..." : s;

        internal static bool Rendered(JsonObject? preview) =>
            preview != null && (preview["hasNative"]?.GetValue<bool>() == true || preview["hasFrame"]?.GetValue<bool>() == true)
            && preview["statusVisible"]?.GetValue<bool>() != true;

        internal static void Run(string name, Action body)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                body();
                _passed++;
                Log($"PASS  {name} ({sw.ElapsedMilliseconds}ms)");
            }
            catch (Exception ex)
            {
                _failed++;
                Failures.Add(name);
                Log($"FAIL  {name} ({sw.ElapsedMilliseconds}ms): {(ex is TestFailure ? ex.Message : ex.ToString())}");
                try { Call("closeAll"); } catch { }
            }
        }

        internal static void Assert(bool condition, string message)
        {
            if (!condition)
            {
                throw new TestFailure(message);
            }
        }

        internal static void Eq<T>(T expected, T actual, string what)
        {
            if (!EqualityComparer<T>.Default.Equals(expected, actual))
            {
                throw new TestFailure($"{what}: expected <{expected}> but was <{actual}>");
            }
        }

        internal static bool IsAlive(int pid)
        {
            try
            {
                using var p = Process.GetProcessById(pid);
                return !p.HasExited;
            }
            catch (ArgumentException)
            {
                return false;
            }
        }

        internal static IReadOnlyCollection<int> SeenSurfacePids => SurfacePids;
    }

    internal sealed class TestFailure : Exception
    {
        public TestFailure(string message) : base(message) { }
    }
}
