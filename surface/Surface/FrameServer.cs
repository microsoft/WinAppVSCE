using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.UI.Dispatching;

namespace Surface;

/// <summary>
/// A warm, long-lived loopback TCP frame server. Replaces the S1/S2 "render two docs then
/// exit" batch flow: it binds an ephemeral port, announces it on stdout, accepts one client
/// (the VS Code extension) and services an interactive edit→render loop over a newline-delimited
/// JSON protocol until the client disconnects (or stdin closes / the process is killed).
///
/// Threading: the accept + read loop runs on background threads. Every render is marshalled onto
/// the UI <see cref="DispatcherQueue"/> (where <c>XamlReader.Load</c> / <c>RenderTargetBitmap</c>
/// must run), and the resulting frame/error is written back over the socket. Socket writes are
/// serialised with a lock so multiple producers never interleave a message.
/// </summary>
internal sealed class FrameServer
{
    private const int Protocol = 1;
    private const string WasdkVersion = "2.2.0";
    private static readonly string[] Caps = { "frame-stream", "native-hwnd" };

    private static readonly JsonSerializerOptions WriteOptions = new()
    {
        // Loopback-only channel: relaxed escaping keeps base64 ('+', '/') and markup ('<', '>')
        // compact. Control chars (incl. '\n') are still escaped, so newline framing stays safe.
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private readonly RenderHost _host;
    private readonly DispatcherQueue _uiDispatcher;
    private readonly object _writeLock = new();

    private TcpListener? _listener;
    private TcpClient? _client;
    private NetworkStream? _stream;
    private int _shuttingDown;

    // Persisted render state so UpdateXaml/Resize can reuse the last size/scale/document.
    private string? _lastXaml;
    private double _lastWidth = 800;
    private double _lastHeight = 600;
    private double _lastScale = 1.0;

    // When true the client has entered native-HWND mode: the warm window hosts the live design canvas
    // and its HWND is reparented into the IDE tool window, so edits re-host in place (no Frame reply).
    private bool _nativeMode;

    public FrameServer(RenderHost host)
    {
        _host = host;
        _uiDispatcher = DispatcherQueue.GetForCurrentThread();
        _host.SelectionChanged += OnSelection;
        _host.PropsRefreshed += OnPropsRefreshed;
    }

    /// <summary>
    /// Binds 127.0.0.1:0, prints the single clean <c>SURFACE_PORT=&lt;port&gt;</c> line to stdout,
    /// and starts the background accept + stdin-watch loops. Returns the bound port.
    /// </summary>
    public int Start()
    {
        _listener = new TcpListener(IPAddress.Loopback, 0);
        _listener.Start();
        int port = ((IPEndPoint)_listener.LocalEndpoint).Port;

        // The ONLY thing written to stdout — the extension parses this to connect.
        // All diagnostics go to stderr (see App.Log), keeping this line clean/parseable.
        Console.Out.WriteLine($"SURFACE_PORT={port}");
        Console.Out.Flush();
        App.Log($"Listening on 127.0.0.1:{port}");

        new Thread(AcceptLoop) { IsBackground = true, Name = "surface-accept" }.Start();
        new Thread(StdinWatch) { IsBackground = true, Name = "surface-stdin" }.Start();
        return port;
    }

    private void AcceptLoop()
    {
        try
        {
            _client = _listener!.AcceptTcpClient();
            _client.NoDelay = true;
            _stream = _client.GetStream();
            App.Log("Client connected.");
            ReadLoop(_stream);
        }
        catch (Exception ex)
        {
            if (_shuttingDown == 0)
            {
                App.Log("Accept/read loop error: " + ex.Message);
            }
        }
        finally
        {
            App.Log("Client disconnected.");
            Shutdown();
        }
    }

    /// <summary>Reads newline-delimited JSON messages until the client closes the stream.</summary>
    private void ReadLoop(NetworkStream stream)
    {
        using var reader = new StreamReader(stream, new UTF8Encoding(false), false, 64 * 1024, leaveOpen: true);
        string? line;
        while ((line = reader.ReadLine()) != null)
        {
            line = line.Trim();
            if (line.Length == 0)
            {
                continue;
            }

            try
            {
                HandleMessage(line);
            }
            catch (Exception ex)
            {
                App.Log("Message handling error: " + ex.Message);
                Send(Error("render", "Server error: " + ex.Message));
            }
        }
        App.Log("Client stream reached EOF.");
    }

    private void HandleMessage(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        if (!root.TryGetProperty("type", out var typeEl) || typeEl.ValueKind != JsonValueKind.String)
        {
            Send(Error("parse", "Message is missing a string 'type' field."));
            return;
        }

        var type = typeEl.GetString();
        switch (type)
        {
            case "Hello":
                App.Log("<- Hello");
                Send(new
                {
                    type = "Ready",
                    protocol = Protocol,
                    caps = Caps,
                    wasdk = WasdkVersion,
                });
                break;

            case "Ping":
                Send(new { type = "Pong" });
                break;

            case "LoadXaml":
            {
                var xaml = GetString(root, "xaml");
                if (xaml is null)
                {
                    Send(Error("parse", "LoadXaml is missing the 'xaml' field."));
                    break;
                }
                _lastXaml = xaml;
                _lastWidth = GetPositiveDouble(root, "width", _lastWidth);
                _lastHeight = GetPositiveDouble(root, "height", _lastHeight);
                _lastScale = GetPositiveDouble(root, "scale", _lastScale);
                App.Log($"<- LoadXaml ({xaml.Length} chars @ {_lastWidth}x{_lastHeight} x{_lastScale})");
                RenderAndReply();
                break;
            }

            case "UpdateXaml":
            {
                var xaml = GetString(root, "xaml");
                if (xaml is null)
                {
                    Send(Error("parse", "UpdateXaml is missing the 'xaml' field."));
                    break;
                }
                _lastXaml = xaml;
                if (_nativeMode)
                {
                    App.Log($"<- UpdateXaml ({xaml.Length} chars, native re-host)");
                    HostLiveAndReply(prepareWindow: false);
                }
                else
                {
                    App.Log($"<- UpdateXaml ({xaml.Length} chars, reuse {_lastWidth}x{_lastHeight} x{_lastScale})");
                    RenderAndReply();
                }
                break;
            }

            case "EnterNative":
            {
                // Switch to native-HWND mode: host the document live in the warm window and return its
                // HWND for the client to reparent. Optional size fields seed the canvas fallback size.
                var xaml = GetString(root, "xaml");
                if (xaml is null)
                {
                    Send(Error("parse", "EnterNative is missing the 'xaml' field."));
                    break;
                }
                _lastXaml = xaml;
                _lastWidth = GetPositiveDouble(root, "width", _lastWidth);
                _lastHeight = GetPositiveDouble(root, "height", _lastHeight);
                _lastScale = GetPositiveDouble(root, "scale", _lastScale);
                _nativeMode = true;
                App.Log($"<- EnterNative ({xaml.Length} chars) — hosting live for reparent");
                HostLiveAndReply(prepareWindow: true);
                break;
            }

            case "ExitNative":
            {
                // Return to frame-streaming mode: unmount + re-cloak the warm window off-screen.
                App.Log("<- ExitNative — restoring off-screen frame mode");
                _nativeMode = false;
                bool ok = _uiDispatcher.TryEnqueue(() => _host.RestoreRenderWindowOffscreen());
                Send(new { type = "NativeExited" });
                if (!ok) App.Log("ExitNative: UI dispatcher rejected the restore request.");
                break;
            }

            case "Resize":
            {
                _lastWidth = GetPositiveDouble(root, "width", _lastWidth);
                _lastHeight = GetPositiveDouble(root, "height", _lastHeight);
                _lastScale = GetPositiveDouble(root, "scale", _lastScale);
                App.Log($"<- Resize -> {_lastWidth}x{_lastHeight} x{_lastScale}");
                if (_nativeMode)
                {
                    // In native mode the client owns the child window's on-screen rect (MoveWindow); the
                    // design canvas is a fixed size, so a pane resize needs no surface round-trip.
                    App.Log("Resize ignored in native mode (client owns child placement).");
                }
                else if (_lastXaml != null)
                {
                    RenderAndReply();
                }
                else
                {
                    App.Log("Resize with no document loaded; size stored for the next render.");
                }
                break;
            }

            case "SetMode":
            {
                // Design mode intercepts input for element selection (plan §41); interact mode passes
                // input to the live content. A launch-independent runtime toggle — applies live to the
                // mounted design surface without a re-render.
                bool design = root.TryGetProperty("design", out var dm) && dm.ValueKind == JsonValueKind.True;
                App.Log($"<- SetMode design={design}");
                bool ok = _uiDispatcher.TryEnqueue(() => _host.SetDesignMode(design));
                if (!ok) App.Log("SetMode: UI dispatcher rejected the request.");
                break;
            }

            case "SelectByPath":
            {
                // Editor caret -> designer selection (plan §41 #2). The client resolved the caret to an
                // authored-tree path; select that element on the UI thread. The surface replies with the
                // usual Selected + ElementProps, which the client suppresses echoing back to the caret.
                string? path = root.TryGetProperty("path", out var pp) && pp.ValueKind == JsonValueKind.String
                    ? pp.GetString()
                    : null;
                bool ok = _uiDispatcher.TryEnqueue(() =>
                {
                    if (!_host.SelectByPath(path))
                    {
                        App.Log($"SelectByPath: path '{path}' did not resolve.");
                    }
                });
                if (!ok) App.Log("SelectByPath: UI dispatcher rejected the request.");
                break;
            }

            case "PickAt":
            {
                // TEST-ONLY (bug D3 regression): headless equivalent of a design-mode pointer click at (x,y) in
                // artboard/host DIP coordinates. Runs the real PickForClick path on the UI thread and replies
                // with the usual Selected (+ ElementProps). The production VS client never sends this; it exists
                // so the D3 regression can assert point -> element selection without synthesizing pointer input.
                double px = root.TryGetProperty("x", out var pxe) && pxe.TryGetDouble(out var pxv) ? pxv : double.NaN;
                double py = root.TryGetProperty("y", out var pye) && pye.TryGetDouble(out var pyv) ? pyv : double.NaN;
                if (double.IsNaN(px) || double.IsNaN(py))
                {
                    Send(Error("parse", "PickAt requires numeric 'x' and 'y' fields."));
                    break;
                }
                bool ok = _uiDispatcher.TryEnqueue(() =>
                {
                    if (!_host.PickAt(px, py))
                    {
                        App.Log($"PickAt: no authored element at ({px},{py}).");
                    }
                });
                if (!ok) App.Log("PickAt: UI dispatcher rejected the request.");
                break;
            }

            case "SetProperty":
            {
                // Live property edit from the panel (plan §41 Phase C). Apply it to the selected element on the
                // UI thread; the surface replies with a fresh ElementProps (applied value, or reverted if the
                // string didn't convert). The live HWND repaints itself — no frame reply needed.
                int id = root.TryGetProperty("id", out var ide) && ide.TryGetInt32(out var idv) ? idv : -1;
                string? name = GetString(root, "name");
                string value = GetString(root, "value") ?? "";
                if (id < 0 || string.IsNullOrEmpty(name))
                {
                    Send(Error("parse", "SetProperty requires an integer 'id' and a string 'name'."));
                    break;
                }

                App.Log($"<- SetProperty #{id} {name}='{value}'");
                bool ok = _uiDispatcher.TryEnqueue(() =>
                {
                    if (!_host.SetProperty(id, name!, value))
                    {
                        App.Log($"SetProperty #{id} {name} did not apply.");
                    }
                });
                if (!ok) App.Log("SetProperty: UI dispatcher rejected the request.");
                break;
            }

            case "SetTheme":
            {
                // Theme preview is a PER-PROCESS concern. Because the surface is a code-only Application
                // (no App.xaml — required to own the IXamlMetadataProvider chain), a runtime RequestedTheme
                // flip does NOT re-resolve {ThemeResource} brushes (WinUI only propagates theme changes for
                // XamlControlsResources when merged via App.xaml markup). The reliable mechanism is the
                // app-global Application.RequestedTheme, set once at startup from the SURFACE_THEME env var.
                // So the client changes theme by RELAUNCHING the surface with a new SURFACE_THEME — this live
                // message is retained only for protocol compatibility and does nothing but log.
                string themeStr = GetString(root, "theme") ?? "Light";
                App.Log($"<- SetTheme {themeStr} (no-op; theme is applied per-process via SURFACE_THEME at launch)");
                break;
            }

            case "SetCanvasSize":
            {
                // Pin the design canvas to a device-size preset (width/height <= 0 => auto). Store the
                // override and re-host so the design surface re-fits the new board into the pane.
                double w = GetPositiveDouble(root, "width", 0);
                double h = GetPositiveDouble(root, "height", 0);
                bool auto = !(w > 0 && h > 0);
                App.Log($"<- SetCanvasSize {(auto ? "auto" : $"{w}x{h}")}");
                _host.SetCanvasSizeOverride(auto ? ((double, double)?)null : (w, h));
                if (_nativeMode && _lastXaml != null)
                {
                    HostLiveAndReply(prepareWindow: false);
                }
                break;
            }

            default:
                Send(Error("parse", $"Unknown message type '{type}'."));
                break;
        }
    }

    /// <summary>
    /// Marshals a render of the current document onto the UI thread, waits for the result on
    /// this background thread, and writes back a Frame (success) or Error (failure).
    /// </summary>
    private void RenderAndReply()
    {
        RenderResult result = RenderOnUiThreadAsync(_lastXaml!, _lastWidth, _lastHeight, _lastScale)
            .GetAwaiter().GetResult();

        if (result.Success)
        {
            Send(new
            {
                type = "Frame",
                format = "png",
                width = result.Width,
                height = result.Height,
                dipWidth = result.DipWidth,
                dipHeight = result.DipHeight,
                data = Convert.ToBase64String(result.Image!),
            });
        }
        else
        {
            Send(new
            {
                type = "Error",
                phase = result.Phase,
                message = result.Message,
                line = result.Line,
                column = result.Column,
                notDesignable = result.NotDesignable,
            });
        }
    }

    private Task<RenderResult> RenderOnUiThreadAsync(string xaml, double width, double height, double scale)
    {
        var tcs = new TaskCompletionSource<RenderResult>(TaskCreationOptions.RunContinuationsAsynchronously);

        bool queued = _uiDispatcher.TryEnqueue(async void () =>
        {
            try
            {
                var result = await _host.RenderAsync(xaml, width, height, scale);
                tcs.TrySetResult(result);
            }
            catch (Exception ex)
            {
                // RenderAsync is designed not to throw, but never let an async-void escape.
                tcs.TrySetResult(RenderResult.Fail("render", "Unhandled render exception: " + ex.Message));
            }
        });

        if (!queued)
        {
            tcs.TrySetResult(RenderResult.Fail("render", "UI dispatcher rejected the render request."));
        }

        return tcs.Task;
    }

    /// <summary>
    /// Native-mode counterpart of <see cref="RenderAndReply"/>: host the current document live in the
    /// warm window on the UI thread and write back an <c>Hwnd</c> message (the reparent target + its
    /// DIP/pixel size) on success, or an <c>Error</c> on a parse/activation failure.
    /// </summary>
    private void HostLiveAndReply(bool prepareWindow)
    {
        LiveResult result = HostLiveOnUiThreadAsync(_lastXaml!, prepareWindow)
            .GetAwaiter().GetResult();

        if (result.Success)
        {
            Send(new
            {
                type = "Hwnd",
                hwnd = result.Hwnd.ToInt64(),
                dipWidth = result.DipWidth,
                dipHeight = result.DipHeight,
                pixelWidth = result.PixelWidth,
                pixelHeight = result.PixelHeight,
                scale = result.DpiScale,
            });

            // Teach the client the authored subtree's custom content-property names (bug D1) so its XAML
            // source-map recurses into explicit property elements (e.g. <controls:ControlExample.Example>) and
            // derives the same paths the surface does. Sent after every (re)host so live edits refresh the map.
            SendContentProps();
        }
        else
        {
            Send(new
            {
                type = "Error",
                phase = result.Phase,
                message = result.Message,
                line = result.Line,
                column = result.Column,
                notDesignable = result.NotDesignable,
            });
        }
    }

    /// <summary>
    /// Collects the mounted design surface's custom content-property map on the UI thread and sends it to the
    /// client as a <c>ContentProps</c> message (bug D1). Harmless when empty. Called after each successful host.
    /// </summary>
    private void SendContentProps()
    {
        var tcs = new TaskCompletionSource<Dictionary<string, string>>(TaskCreationOptions.RunContinuationsAsynchronously);
        bool queued = _uiDispatcher.TryEnqueue(() =>
        {
            try
            {
                tcs.TrySetResult(_host.CollectContentProps());
            }
            catch (Exception ex)
            {
                App.Log("CollectContentProps failed: " + ex.Message);
                tcs.TrySetResult(new Dictionary<string, string>());
            }
        });

        if (!queued)
        {
            App.Log("SendContentProps: UI dispatcher rejected the collect request.");
            return;
        }

        var map = tcs.Task.GetAwaiter().GetResult();
        Send(new { type = "ContentProps", map });
    }

    private Task<LiveResult> HostLiveOnUiThreadAsync(string xaml, bool prepareWindow)    {
        var tcs = new TaskCompletionSource<LiveResult>(TaskCreationOptions.RunContinuationsAsynchronously);

        bool queued = _uiDispatcher.TryEnqueue(async void () =>
        {
            try
            {
                var result = await _host.HostLiveAsync(xaml, prepareWindow);
                tcs.TrySetResult(result);
            }
            catch (Exception ex)
            {
                tcs.TrySetResult(LiveResult.Fail("render", "Unhandled host exception: " + ex.Message));
            }
        });

        if (!queued)
        {
            tcs.TrySetResult(LiveResult.Fail("render", "UI dispatcher rejected the host request."));
        }

        return tcs.Task;
    }

    // ---- socket write (serialised) -------------------------------------------

    /// <summary>
    /// Forward a design-surface selection to the client as two messages: a lightweight <c>Selected</c>
    /// (id + type + adorner bounds) and a heavier <c>ElementProps</c> (the reflected property rows). Runs on
    /// the UI thread (the pointer handler); <see cref="Send"/> is serialized by the write lock.
    /// </summary>
    private void OnSelection(DesignSelectionPayload p)
    {
        Send(new { type = "Selected", id = p.Id, elementType = p.TypeName, name = p.Name, path = p.Path, x = p.X, y = p.Y, w = p.W, h = p.H });
        SendProps(p);
    }

    /// <summary>
    /// A live property edit re-read the element (Phase C). Refresh ONLY the panel — send <c>ElementProps</c>
    /// without a <c>Selected</c>, so an edit never moves the editor caret (plan §41 #1). Runs on the UI thread.
    /// </summary>
    private void OnPropsRefreshed(DesignSelectionPayload p) => SendProps(p);

    private void SendProps(DesignSelectionPayload p)
    {
        var props = new List<object>(p.Props.Count);
        foreach (var pi in p.Props)
        {
            props.Add(new { name = pi.Name, category = pi.Category, type = pi.TypeName, value = pi.Value, readOnly = pi.ReadOnly, options = pi.Options });
        }

        Send(new { type = "ElementProps", id = p.Id, props });
    }

    private void Send(object message)
    {
        var stream = _stream;
        if (stream is null)
        {
            return;
        }

        var json = JsonSerializer.Serialize(message, WriteOptions);
        var bytes = Encoding.UTF8.GetBytes(json + "\n");

        lock (_writeLock)
        {
            try
            {
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush();
            }
            catch (Exception ex)
            {
                App.Log("Socket write failed: " + ex.Message);
            }
        }
    }

    private static object Error(string phase, string message) => new
    {
        type = "Error",
        phase,
        message,
        line = (int?)null,
        column = (int?)null,
    };

    // ---- shutdown / lifecycle ------------------------------------------------

    private void StdinWatch()
    {
        bool everReadData = false;
        try
        {
            using var stdin = Console.OpenStandardInput();
            var buffer = new byte[256];
            int n;
            while ((n = stdin.Read(buffer, 0, buffer.Length)) > 0)
            {
                // Drain and ignore any bytes; we only care about EOF.
                everReadData = true;
            }
        }
        catch
        {
            // stdin not available/redirected — ignore and stop watching.
            return;
        }

        // The VS Code client launches us with a pre-closed stdin (stdio[0] = "ignore"), so an
        // immediate EOF with no data ever read means "no controlling stdin" — NOT a shutdown
        // signal. Treating it as one races the socket connect and can kill the surface right
        // after a client attaches. Process/host death is already covered by the socket lifecycle
        // (AcceptLoop's finally -> Shutdown), so only a genuine stdin pipe that delivered data and
        // then closed should trigger shutdown here.
        if (!everReadData)
        {
            App.Log("stdin pre-closed/redirected; stdin-close will not trigger shutdown (socket lifecycle governs).");
            return;
        }

        App.Log("stdin closed — shutting down.");
        Shutdown();
    }

    private void Shutdown()
    {
        if (Interlocked.Exchange(ref _shuttingDown, 1) != 0)
        {
            return;
        }

        App.Log("Server shutting down (exit 0).");
        try { _stream?.Dispose(); } catch { }
        try { _client?.Close(); } catch { }
        try { _listener?.Stop(); } catch { }
        Environment.Exit(0);
    }

    // ---- JSON field helpers --------------------------------------------------

    private static string? GetString(JsonElement el, string name)
        => el.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static double GetPositiveDouble(JsonElement el, string name, double fallback)
    {
        if (el.TryGetProperty(name, out var v) &&
            v.ValueKind == JsonValueKind.Number &&
            v.TryGetDouble(out var d) &&
            d > 0)
        {
            return d;
        }
        return fallback;
    }
}
