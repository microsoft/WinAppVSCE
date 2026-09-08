#nullable enable

using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using WinUISurface.Shared;

namespace WinUIXamlPreview.Protocol
{
    /// <summary>
    /// Owns the surface process + loopback socket. Launches <c>Surface.exe</c>, parses the
    /// <c>SURFACE_PORT=&lt;n&gt;</c> handshake line from stdout, connects, performs the Hello/Ready
    /// exchange, and raises Frame/Error/Closed events. A direct C# port of
    /// <c>client/src/visualizer/surfaceClient.ts</c> — no Visual Studio dependencies so it can be
    /// smoke-tested from a plain console harness.
    /// </summary>
    internal sealed class SurfaceClient : IDisposable
    {
        private static readonly JsonSerializerOptions ReadOptions = new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
        };

        private static readonly JsonSerializerOptions WriteOptions = new JsonSerializerOptions
        {
            // Message shapes carry explicit [JsonPropertyName] lowercase names.
        };

        private readonly string _surfaceExe;
        private readonly string? _userDll;
        private readonly string? _userAppXaml;
        private readonly string? _userPri;
        private readonly bool _liveMode;
        private readonly bool _reflectionFallback;
        private readonly bool _renderSettle;
        private readonly string? _theme;
        private readonly Action<string> _log;

        private Process? _proc;
        private TcpClient? _tcp;
        private NetworkStream? _stream;
        private readonly LineDecoder _decoder = new LineDecoder();
        private readonly StringBuilder _stdout = new StringBuilder();
        private TaskCompletionSource<ReadyMsg>? _ready;
        private bool _started;
        private bool _disposed;
        private bool _connecting;
        private string? _privateRun;

        public SurfaceClient(string surfaceExe, string? userDll, Action<string> log, string? userAppXaml = null, bool liveMode = false, string? theme = null, bool reflectionFallback = false, bool renderSettle = false, string? userPri = null)
        {
            _surfaceExe = surfaceExe;
            _userDll = userDll;
            _userAppXaml = userAppXaml;
            _userPri = userPri;
            _liveMode = liveMode;
            _reflectionFallback = reflectionFallback;
            _renderSettle = renderSettle;
            _theme = theme;
            _log = log ?? (_ => { });
        }

        public event Action<ReadyMsg>? Ready;
        public event Action<FrameMsg>? Frame;
        public event Action<ErrorMsg>? Error;
        public event Action<HwndMsg>? Hwnd;
        public event Action? NativeExited;
        public event Action<SelectedMsg>? Selected;
        public event Action<ElementPropsMsg>? ElementProps;
        public event Action<ContentPropsMsg>? ContentProps;
        public event Action<string>? Closed;

        /// <summary>Launches the surface, connects, and completes once Ready is received.</summary>
        public Task<ReadyMsg> StartAsync(TimeSpan timeout)
        {
            if (_started)
            {
                return Task.FromException<ReadyMsg>(new InvalidOperationException("SurfaceClient already started"));
            }

            _started = true;
            _ready = new TaskCompletionSource<ReadyMsg>(TaskCreationOptions.RunContinuationsAsynchronously);

            var args = new StringBuilder();
            if (!string.IsNullOrEmpty(_userDll))
            {
                args.Append("--user-dll ").Append(Quote(_userDll!));
            }

            if (!string.IsNullOrEmpty(_userAppXaml))
            {
                if (args.Length > 0)
                {
                    args.Append(' ');
                }

                args.Append("--user-appxaml ").Append(Quote(_userAppXaml!));
            }

            // Matched-host (version-matched) launch stages a pre-built MERGED core+toolkit design-time
            // resources.pri (host-side StageUserPri copies it over <host>\Surface.pri) so third-party
            // component templates resolve at the target WASDK version. Only the version-matched leg passes
            // this; the bundled 2.2.0 leg leaves it null so its launch is byte-for-byte unchanged. The path
            // must point INTO a per-session run-copy of the cached host (StageUserPri overwrites in place),
            // never the pristine cache — see MatchedHostResolver.
            if (!string.IsNullOrEmpty(_userPri))
            {
                // Every PROCESS gets its own mutable PRI, including warmed spares for the same document.
                // The input is a validated, pristine payload; never launch --user-pri against it.
                try
                {
                    var source = Path.GetDirectoryName(Path.GetFullPath(_surfaceExe))!;
                    if (!string.Equals(Path.GetFullPath(_userPri!), Path.Combine(source, "Surface.designtime.pri"), StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("Matched PRI must belong to the supplied payload.");
                    _privateRun = Path.Combine(Path.GetTempPath(), "wsr-v2", Guid.NewGuid().ToString("N"));
                    HostPayload.CreateRunCopy(source, _privateRun);
                }
                catch (Exception ex) { Fail(ex); return _ready.Task; }
                if (args.Length > 0)
                {
                    args.Append(' ');
                }

                args.Append("--user-pri ").Append(Quote(Path.Combine(_privateRun!, "Surface.designtime.pri")));
            }

            var launchExe = _privateRun == null ? _surfaceExe : Path.Combine(_privateRun, "Surface.exe");
            _log($"Launching surface: \"{launchExe}\" {args}");

            var psi = new ProcessStartInfo
            {
                FileName = launchExe,
                Arguments = args.ToString(),
                WorkingDirectory = _privateRun ?? Path.GetDirectoryName(_surfaceExe) ?? string.Empty,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };

            // Live mode is a launch-time decision: the surface reads SURFACE_LIVE_MODE once at startup and
            // (when "1") activates the real compiled page type so {x:Bind} wires up (plan §39). Set it
            // explicitly either way so an inherited value from the VS process can never flip the mode.
            psi.EnvironmentVariables["SURFACE_LIVE_MODE"] = _liveMode ? "1" : "0";

            // §51 M3: the opportunistic reflection fallback is likewise a launch-time opt-in — the surface
            // reads SURFACE_DTD_REFLECT once at startup. It only has any effect together with live mode (it
            // runs after real-type activation), and is off unless explicitly requested. Set explicitly so an
            // inherited value can never leak in.
            psi.EnvironmentVariables["SURFACE_DTD_REFLECT"] = _reflectionFallback ? "1" : "0";

            // Coverage-hardening P3: the design-time render-settle sweep is likewise a launch-time opt-in — the
            // surface reads SURFACE_RENDER_SETTLE once at startup. It is off unless explicitly requested so the
            // certified default render path (which never runs the sweep) stays byte-for-byte unchanged. Set
            // explicitly so an inherited value from the VS process can never leak in.
            psi.EnvironmentVariables["SURFACE_RENDER_SETTLE"] = _renderSettle ? "1" : "0";

            // Theme preview is likewise a launch-time decision: the surface reads SURFACE_THEME once at
            // startup and sets the app-global Application.RequestedTheme (the only mechanism that re-resolves
            // {ThemeResource} in a code-only host — a runtime flip does not; plan §47). "Light"/"Dark" force
            // that theme; anything else (incl. "Default"/empty) follows the system theme. Set explicitly so an
            // inherited value can never leak in.
            psi.EnvironmentVariables["SURFACE_THEME"] =
                string.Equals(_theme, "Dark", StringComparison.OrdinalIgnoreCase) ? "Dark" :
                string.Equals(_theme, "Light", StringComparison.OrdinalIgnoreCase) ? "Light" : "Default";

            try
            {
                _proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
                _proc.OutputDataReceived += OnStdout;
                _proc.ErrorDataReceived += OnStderr;
                _proc.Exited += OnExited;
                _proc.Start();
                _proc.BeginOutputReadLine();
                _proc.BeginErrorReadLine();
            }
            catch (Exception ex)
            {
                Fail(ex);
                return _ready.Task;
            }

            _ = Task.Delay(timeout).ContinueWith(_ =>
            {
                if (_ready != null && !_ready.Task.IsCompleted)
                {
                    Fail(new TimeoutException("Timed out waiting for SURFACE_PORT / Ready from the surface process."));
                }
            });

            return _ready.Task;
        }

        private void OnStdout(object sender, DataReceivedEventArgs e)
        {
            if (e.Data == null)
            {
                return;
            }

            var line = e.Data.TrimEnd();
            if (line.Length == 0)
            {
                return;
            }

            if (line.StartsWith("SURFACE_PORT=", StringComparison.Ordinal))
            {
                var rest = line.Substring("SURFACE_PORT=".Length).Trim();
                var digits = new string(rest.TakeWhileDigit());
                if (int.TryParse(digits, out var port))
                {
                    _log($"Surface listening on 127.0.0.1:{port}");
                    Connect(port);
                }
            }
            else
            {
                _log($"[surface] {line}");
            }
        }

        private void OnStderr(object sender, DataReceivedEventArgs e)
        {
            if (!string.IsNullOrWhiteSpace(e.Data))
            {
                _log($"[surface:err] {e.Data}");
            }
        }

        private void OnExited(object? sender, EventArgs e)
        {
            var code = TryGetExitCode();
            var reason = $"Surface process exited (code={code}).";
            _log(reason);
            Fail(new Exception(reason));
            if (!_disposed)
            {
                Closed?.Invoke(reason);
            }
        }

        private int? TryGetExitCode()
        {
            try { return _proc?.ExitCode; } catch { return null; }
        }

        private void Connect(int port)
        {
            if (_connecting || _disposed)
            {
                return;
            }

            _connecting = true;
            _ = Task.Run(async () =>
            {
                try
                {
                    var tcp = new TcpClient();
                    await tcp.ConnectAsync("127.0.0.1", port).ConfigureAwait(false);
                    _tcp = tcp;
                    _stream = tcp.GetStream();
                    _log("Connected to surface. Sending Hello.");
                    Send(new HelloMsg());
                    await ReadLoop(_stream).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    _log($"Socket error: {ex.Message}");
                    Fail(ex);
                }
            });
        }

        private async Task ReadLoop(NetworkStream stream)
        {
            var buffer = new byte[64 * 1024];
            while (!_disposed)
            {
                int n;
                try
                {
                    n = await stream.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false);
                }
                catch
                {
                    break;
                }

                if (n <= 0)
                {
                    break;
                }

                foreach (var line in _decoder.Push(buffer, n))
                {
                    Dispatch(line);
                }
            }

            if (!_disposed)
            {
                Closed?.Invoke("Surface socket closed.");
            }
        }

        private void Dispatch(string json)
        {
            string? type;
            try
            {
                using var doc = JsonDocument.Parse(json);
                type = doc.RootElement.TryGetProperty("type", out var t) ? t.GetString() : null;
            }
            catch
            {
                return; // ignore malformed/interleaved diagnostics
            }

            switch (type)
            {
                case "Ready":
                    var ready = JsonSerializer.Deserialize<ReadyMsg>(json, ReadOptions);
                    if (ready != null)
                    {
                        _ready?.TrySetResult(ready);
                        Ready?.Invoke(ready);
                    }
                    break;
                case "Frame":
                    var frame = JsonSerializer.Deserialize<FrameMsg>(json, ReadOptions);
                    if (frame != null)
                    {
                        Frame?.Invoke(frame);
                    }
                    break;
                case "Error":
                    var err = JsonSerializer.Deserialize<ErrorMsg>(json, ReadOptions);
                    if (err != null)
                    {
                        Error?.Invoke(err);
                    }
                    break;
                case "Hwnd":
                    var hwnd = JsonSerializer.Deserialize<HwndMsg>(json, ReadOptions);
                    if (hwnd != null)
                    {
                        Hwnd?.Invoke(hwnd);
                    }
                    break;
                case "NativeExited":
                    NativeExited?.Invoke();
                    break;
                case "Selected":
                    var sel = JsonSerializer.Deserialize<SelectedMsg>(json, ReadOptions);
                    if (sel != null)
                    {
                        Selected?.Invoke(sel);
                    }
                    break;
                case "ElementProps":
                    var props = JsonSerializer.Deserialize<ElementPropsMsg>(json, ReadOptions);
                    if (props != null)
                    {
                        ElementProps?.Invoke(props);
                    }
                    break;
                case "ContentProps":
                    var contentProps = JsonSerializer.Deserialize<ContentPropsMsg>(json, ReadOptions);
                    if (contentProps != null)
                    {
                        ContentProps?.Invoke(contentProps);
                    }
                    break;
                case "Pong":
                    break;
                default:
                    _log($"Unknown message from surface: {json}");
                    break;
            }
        }

        private void Send(object msg)
        {
            var stream = _stream;
            if (stream == null || _disposed)
            {
                return;
            }

            try
            {
                var json = JsonSerializer.Serialize(msg, msg.GetType(), WriteOptions) + "\n";
                var bytes = Encoding.UTF8.GetBytes(json);
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush();
            }
            catch (Exception ex)
            {
                _log($"Send failed: {ex.Message}");
            }
        }

        public void LoadXaml(string xaml, int width, int height, double scale)
            => Send(new LoadXamlMsg { Xaml = xaml, Width = width, Height = height, Scale = scale });

        public void UpdateXaml(string xaml)
            => Send(new UpdateXamlMsg { Xaml = xaml });

        public void Resize(int width, int height, double scale)
            => Send(new ResizeMsg { Width = width, Height = height, Scale = scale });

        /// <summary>Enter native-HWND mode; the surface replies with an <see cref="HwndMsg"/> to reparent.</summary>
        public void EnterNative(string xaml, double width, double height, double scale)
            => Send(new EnterNativeMsg { Xaml = xaml, Width = width, Height = height, Scale = scale });

        /// <summary>Leave native mode; the surface re-cloaks its window and replies <c>NativeExited</c>.</summary>
        public void ExitNative()
            => Send(new ExitNativeMsg());

        /// <summary>
        /// Set the design surface mode: <c>true</c> = design (clicks select an element), <c>false</c> =
        /// interact (clicks reach the live content). Applied live by the surface with no re-render (plan §41).
        /// </summary>
        public void SetMode(bool design)
            => Send(new SetModeMsg { Design = design });

        /// <summary>
        /// Select the element at an authored-tree index path (editor caret -> designer, plan §41 #2). The
        /// surface resolves the path to a live element and replies with the usual <c>Selected</c>/props.
        /// </summary>
        public void SelectByPath(string path)
            => Send(new SelectByPathMsg { Path = path });

        /// <summary>
        /// TEST-ONLY (bug D3 regression): headless equivalent of a design-mode pointer click at (<paramref
        /// name="x"/>, <paramref name="y"/>) in artboard/host DIP coordinates. The surface runs its real
        /// pick/hit-test path and replies with the usual <c>Selected</c>. Not used by the production margin;
        /// the D3 UI test uses it to assert point -> element selection deterministically.
        /// </summary>
        public void PickAt(double x, double y)
            => Send(new PickAtMsg { X = x, Y = y });

        /// <summary>
        /// Apply a live property edit from the panel to the element with the given id (plan §41 Phase C). The
        /// surface converts the value to the property's type, sets it on the live element, and replies with a
        /// fresh <c>ElementProps</c> (applied value, or reverted if the string didn't convert).
        /// </summary>
        public void SetProperty(int id, string name, string value)
            => Send(new SetPropertyMsg { Id = id, Name = name, Value = value });

        /// <summary>
        /// Preview the mounted page under a different theme (<c>Light</c>/<c>Dark</c>/<c>Default</c>). The
        /// surface applies it live to the mounted design canvas (no re-render) and persists it across re-hosts.
        /// </summary>
        public void SetTheme(string theme)
            => Send(new SetThemeMsg { Theme = theme });

        /// <summary>
        /// Pin the design canvas to a device-size preset so the page lays out at a fixed artboard size;
        /// <paramref name="width"/>/<paramref name="height"/> &lt;= 0 restores auto (the page's own size). The
        /// surface re-hosts and replies with a fresh <c>Hwnd</c>; the design surface re-fits the new board.
        /// </summary>
        public void SetCanvasSize(double width, double height)
            => Send(new SetCanvasSizeMsg { Width = width, Height = height });

        private void Fail(Exception ex)
        {
            _ready?.TrySetException(ex);
        }

        private static string Quote(string s) => s.IndexOf(' ') >= 0 ? $"\"{s}\"" : s;

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            try { _stream?.Dispose(); } catch { }
            try { _tcp?.Close(); } catch { }
            try
            {
                if (_proc != null && !_proc.HasExited)
                {
                    _proc.Kill();
                    _proc.WaitForExit(5000);
                }
            }
            catch { }
            try { _proc?.Dispose(); } catch { }
            if (_privateRun != null)
            {
                try
                {
                    if (Directory.Exists(_privateRun)) Directory.Delete(_privateRun, true);
                }
                catch (IOException ex) { _log($"Private Surface run cleanup failed for '{_privateRun}': {ex.Message}"); }
                catch (UnauthorizedAccessException ex) { _log($"Private Surface run cleanup denied for '{_privateRun}': {ex.Message}"); }
            }
        }
    }

    internal static class CharExtensions
    {
        /// <summary>Returns the leading run of ASCII digits from a string as a char array.</summary>
        public static char[] TakeWhileDigit(this string s)
        {
            int i = 0;
            while (i < s.Length && s[i] >= '0' && s[i] <= '9')
            {
                i++;
            }

            return s.Substring(0, i).ToCharArray();
        }
    }
}
