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
        private readonly bool _renderSettle;
        private readonly string? _theme;
        private readonly Action<string> _log;

        private Process? _proc;
        private TcpClient? _tcp;
        private NetworkStream? _stream;
        private readonly LineDecoder _decoder = new LineDecoder();
        private readonly StringBuilder _stdout = new StringBuilder();
        private TaskCompletionSource<ReadyMsg>? _ready;
        private Stopwatch? _startSw;
        private long _spawnMs;
        private bool _started;
        private bool _disposed;
        private bool _connecting;
        private string? _privateRun;

        // Failure funnel: every failure (startup, connect, read-loop close, timeout, process exit) routes
        // through Fault(). _lifetimeCts cancels the connect + read loop on fault/dispose; _timeoutCts (linked
        // to it) is cancelled on its own the moment Ready arrives, so the startup timeout can never fire
        // against a healthy surface. _faulted guards Fault() so exactly one Closed is raised however many
        // failures race in; _intentionalStop suppresses Closed when we stop the surface on purpose.
        private readonly CancellationTokenSource _lifetimeCts = new CancellationTokenSource();
        private CancellationTokenSource? _timeoutCts;
        private int _faulted;
        private volatile bool _intentionalStop;

        public SurfaceClient(string surfaceExe, string? userDll, Action<string> log, string? userAppXaml = null, string? theme = null, bool renderSettle = false, string? userPri = null)
        {
            _surfaceExe = surfaceExe;
            _userDll = userDll;
            _userAppXaml = userAppXaml;
            _userPri = userPri;
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
        public event Action<ViewMsg>? View;
        public event Action<string>? Closed;

        /// <summary>True once the connection has faulted (process died / socket failed); Closed is raised at most once.</summary>
        public bool IsFaulted => Volatile.Read(ref _faulted) != 0;

        /// <summary>Launches the surface, connects, and completes once Ready is received.</summary>
        public Task<ReadyMsg> StartAsync(TimeSpan timeout)
        {
            if (_started)
            {
                return Task.FromException<ReadyMsg>(new InvalidOperationException("SurfaceClient already started"));
            }

            _started = true;
            _ready = new TaskCompletionSource<ReadyMsg>(TaskCreationOptions.RunContinuationsAsynchronously);
            _startSw = Stopwatch.StartNew();

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
            // this; the bundled 2.2.0 leg leaves it null so its launch is byte-for-byte unchanged. The supplied
            // exe/pri belong to the pristine, read-only cache entry; StageUserPri overwrites in place, so it
            // only ever runs against the per-process run-copy made below.
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
                    var rcSw = Stopwatch.StartNew();
                    HostPayload.CreateRunCopy(source, _privateRun);
                    _log($"PERF client.runcopy ms={rcSw.ElapsedMilliseconds}");
                }
                catch (Exception ex) { Fault("Failed to stage the matched-host PRI run-copy.", ex); return _ready.Task; }
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
                _spawnMs = _startSw.ElapsedMilliseconds;
                _proc.BeginOutputReadLine();
                _proc.BeginErrorReadLine();
            }
            catch (Exception ex)
            {
                Fault("Failed to start the surface process.", ex);
                return _ready.Task;
            }

            _timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(_lifetimeCts.Token);
            var timeoutToken = _timeoutCts.Token;
            _ = Task.Delay(timeout, timeoutToken).ContinueWith(t =>
            {
                if (t.IsCanceled)
                {
                    return; // Ready arrived (or we're tearing down) — nothing to time out.
                }

                if (_ready != null && !_ready.Task.IsCompleted)
                {
                    Fault("Timed out waiting for SURFACE_PORT / Ready from the surface process.",
                        new TimeoutException("Timed out waiting for SURFACE_PORT / Ready from the surface process."));
                }
            }, TaskScheduler.Default);

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
            Fault($"Surface process exited (code={code}).");
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
            var token = _lifetimeCts.Token;
            _ = Task.Run(async () =>
            {
                var tcp = new TcpClient();
                // net472 TcpClient.ConnectAsync has no CancellationToken overload; closing the socket
                // from the token callback aborts a hung connect the instant we fault or dispose (T2).
                using var reg = token.Register(() => { try { tcp.Close(); } catch { } });
                try
                {
                    await tcp.ConnectAsync("127.0.0.1", port).ConfigureAwait(false);
                    _tcp = tcp;
                    _stream = tcp.GetStream();
                    _log("Connected to surface. Sending Hello.");
                    Send(new HelloMsg());
                    await ReadLoop(_stream, token).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    if (token.IsCancellationRequested)
                    {
                        return; // Intentional teardown aborted the connect; Fault already ran (or Dispose owns it).
                    }

                    Fault($"Surface connection failed: {ex.Message}", ex);
                }
            });
        }

        private async Task ReadLoop(NetworkStream stream, CancellationToken token)
        {
            var buffer = new byte[64 * 1024];
            var closeReason = "Surface socket closed.";
            while (!_disposed && !token.IsCancellationRequested)
            {
                int n;
                try
                {
                    n = await stream.ReadAsync(buffer, 0, buffer.Length, token).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    // Cancellation/disposal is an intentional teardown — the fault (if any) is already
                    // funnelled, so stay quiet. Anything else is a genuine transport error worth logging (T3).
                    if (token.IsCancellationRequested || _disposed)
                    {
                        return;
                    }

                    closeReason = $"Surface socket read failed: {ex.Message}";
                    break;
                }

                if (n <= 0)
                {
                    closeReason = "Surface closed the connection (end of stream).";
                    break;
                }

                foreach (var line in _decoder.Push(buffer, n))
                {
                    Dispatch(line);
                }
            }

            Fault(closeReason);
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
                    _timeoutCts?.Cancel();
                    if (_startSw != null)
                    {
                        _log($"PERF client.ready ms={_startSw.ElapsedMilliseconds} spawnAt={_spawnMs} privateRun={(_privateRun != null ? "yes" : "no")}");
                    }
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
                case "View":
                    var view = JsonSerializer.Deserialize<ViewMsg>(json, ReadOptions);
                    if (view != null)
                    {
                        View?.Invoke(view);
                    }
                    break;
                case "Pong":
                    break;
                default:
                    _log($"Unknown message from surface: {json}");
                    break;
            }
        }

        /// <summary>
        /// Writes a message to the surface. Returns <c>true</c> when the bytes were handed to the socket,
        /// <c>false</c> when the client is already torn down or the write failed. A write failure means the
        /// pipe is broken, so it is funnelled through <see cref="Fault"/> — the UI then sees a single
        /// disconnected/recovery signal instead of a silently dropped command (T4).
        /// </summary>
        private bool Send(object msg)
        {
            var stream = _stream;
            if (stream == null || _disposed)
            {
                return false;
            }

            try
            {
                var json = JsonSerializer.Serialize(msg, msg.GetType(), WriteOptions) + "\n";
                var bytes = Encoding.UTF8.GetBytes(json);
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush();
                return true;
            }
            catch (Exception ex)
            {
                Fault($"Surface send failed: {ex.Message}", ex);
                return false;
            }
        }

        /// <summary>
        /// WS2-F6: placeholder sample data for <c>{x:Bind}</c> pages. Sent with every document message; null
        /// omits the field so the surface keeps its default (on).
        /// </summary>
        public bool? SampleData { get; set; }

        public bool LoadXaml(string xaml, int width, int height, double scale)
            => Send(new LoadXamlMsg { Xaml = xaml, Width = width, Height = height, Scale = scale, SampleData = SampleData });

        public bool UpdateXaml(string xaml)
            => Send(new UpdateXamlMsg { Xaml = xaml, SampleData = SampleData });

        public bool Resize(int width, int height, double scale)
            => Send(new ResizeMsg { Width = width, Height = height, Scale = scale });

        /// <summary>Enter native-HWND mode; the surface replies with an <see cref="HwndMsg"/> to reparent.</summary>
        public bool EnterNative(string xaml, double width, double height, double scale, int paneWidthPx = 0, int paneHeightPx = 0, ViewMsg? view = null)
            => Send(new EnterNativeMsg
            {
                Xaml = xaml, Width = width, Height = height, Scale = scale, SampleData = SampleData,
                PaneWidthPx = paneWidthPx > 0 ? paneWidthPx : (int?)null,
                PaneHeightPx = paneHeightPx > 0 ? paneHeightPx : (int?)null,
                View = view,
            });

        /// <summary>Leave native mode; the surface re-cloaks its window and replies <c>NativeExited</c>.</summary>
        public bool ExitNative()
            => Send(new ExitNativeMsg());

        /// <summary>
        /// Set the design surface mode: <c>true</c> = design (clicks select an element), <c>false</c> =
        /// interact (clicks reach the live content). Applied live by the surface with no re-render (plan §41).
        /// </summary>
        public bool SetMode(bool design)
            => Send(new SetModeMsg { Design = design });

        /// <summary>
        /// Select the element at an authored-tree index path (editor caret -> designer, plan §41 #2). The
        /// surface resolves the path to a live element and replies with the usual <c>Selected</c>/props.
        /// </summary>
        public bool SelectByPath(string path)
            => Send(new SelectByPathMsg { Path = path });

        /// <summary>
        /// TEST-ONLY (bug D3 regression): headless equivalent of a design-mode pointer click at (<paramref
        /// name="x"/>, <paramref name="y"/>) in artboard/host DIP coordinates. The surface runs its real
        /// pick/hit-test path and replies with the usual <c>Selected</c>. Not used by the production margin;
        /// the D3 UI test uses it to assert point -> element selection deterministically.
        /// </summary>
        public bool PickAt(double x, double y)
            => Send(new PickAtMsg { X = x, Y = y });

        /// <summary>
        /// Apply a live property edit from the panel to the element with the given id (plan §41 Phase C). The
        /// surface converts the value to the property's type, sets it on the live element, and replies with a
        /// fresh <c>ElementProps</c> (applied value, or reverted if the string didn't convert).
        /// </summary>
        public bool SetProperty(int id, string name, string value)
            => Send(new SetPropertyMsg { Id = id, Name = name, Value = value });

        /// <summary>
        /// Preview the mounted page under a different theme (<c>Light</c>/<c>Dark</c>/<c>Default</c>). The
        /// surface applies it live to the mounted design canvas (no re-render) and persists it across re-hosts.
        /// </summary>
        public bool SetTheme(string theme)
            => Send(new SetThemeMsg { Theme = theme });

        /// <summary>
        /// Pin the design canvas to a device-size preset so the page lays out at a fixed artboard size;
        /// <paramref name="width"/>/<paramref name="height"/> &lt;= 0 restores auto (the page's own size). The
        /// surface re-hosts and replies with a fresh <c>Hwnd</c>; the design surface re-fits the new board.
        /// </summary>
        public bool SetCanvasSize(double width, double height)
            => Send(new SetCanvasSizeMsg { Width = width, Height = height });

        // Single funnel for every failure — startup, connect, read-loop close, timeout, process exit.
        // Idempotent (first fault wins), so _ready is completed once and exactly one Closed is raised.
        // Cancels the lifetime token to stop the read loop; suppresses Closed during intentional stop/dispose.
        private void Fault(string reason, Exception? ex = null)
        {
            if (Interlocked.Exchange(ref _faulted, 1) != 0)
            {
                return;
            }

            _log(reason);
            _ready?.TrySetException(ex ?? new Exception(reason));
            try { _lifetimeCts.Cancel(); } catch (ObjectDisposedException) { }

            // T1: terminate a wedged/faulted surface right away (e.g. one that never sent Ready) so it can't
            // linger as an orphan. Non-blocking Kill() only — full reaping/disposal stays with Dispose. On an
            // intentional stop, Dispose already owns the kill, so skip it here to avoid racing _proc disposal.
            if (!_intentionalStop)
            {
                RequestKill();
            }

            if (!_disposed && !_intentionalStop)
            {
                Closed?.Invoke(reason);
            }
        }

        // Fire-and-forget terminate; never waits, so it is safe to call from the UI thread via Send/Fault.
        private void RequestKill()
        {
            try
            {
                var proc = _proc;
                if (proc != null && !proc.HasExited)
                {
                    proc.Kill();
                }
            }
            catch { }
        }

        private static string Quote(string s) => s.IndexOf(' ') >= 0 ? $"\"{s}\"" : s;

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }

            _intentionalStop = true;
            _disposed = true;
            try { _lifetimeCts.Cancel(); } catch { }
            try { _stream?.Dispose(); } catch { }
            try { _tcp?.Close(); } catch { }

            // T5: request termination synchronously (Kill() does not block), but move the WaitForExit and the
            // run-copy cleanup — which blocks until the process releases its file locks — onto a background
            // thread so Dispose never stalls the caller (typically the VS UI thread). Hand ownership of _proc
            // and the run directory to that task so nothing else touches them while it reaps.
            var proc = _proc;
            _proc = null;
            var runDir = _privateRun;
            _privateRun = null;
            try { if (proc != null && !proc.HasExited) proc.Kill(); } catch { }

            if (proc != null || runDir != null)
            {
                Task.Run(() =>
                {
                    try { proc?.WaitForExit(5000); } catch { }
                    try { proc?.Dispose(); } catch { }
                    if (runDir != null)
                    {
                        // The image and its DLLs can stay locked briefly after exit (notably under x64
                        // emulation). Retry for a few seconds; whatever remains is reclaimed by the next
                        // session's SweepRunRoot.
                        for (var attempt = 0; attempt < 10 && Directory.Exists(runDir); attempt++)
                        {
                            if (attempt > 0) Thread.Sleep(500);
                            try { if (HostPayload.TryRetire(runDir, _log, deleteAttempts: 10)) break; }
                            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException) { }
                        }
                        if (Directory.Exists(runDir)) _log($"Private Surface run cleanup deferred for '{runDir}'.");
                    }
                });
            }

            try { _lifetimeCts.Dispose(); } catch { }
            try { _timeoutCts?.Dispose(); } catch { }
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
