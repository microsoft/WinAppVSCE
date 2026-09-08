using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.UI.Dispatching;
using Surface;
using WinUIXamlPreview.Protocol;

internal static class Compatibility
{
    private static readonly JsonSerializerOptions ReadOptions = new() { PropertyNameCaseInsensitive = true };
    private static readonly Dictionary<string, Type> Dtos = new()
    {
        ["Hello"] = typeof(HelloMsg), ["LoadXaml"] = typeof(LoadXamlMsg),
        ["UpdateXaml"] = typeof(UpdateXamlMsg), ["Resize"] = typeof(ResizeMsg),
        ["EnterNative"] = typeof(EnterNativeMsg), ["ExitNative"] = typeof(ExitNativeMsg),
        ["SetMode"] = typeof(SetModeMsg), ["SelectByPath"] = typeof(SelectByPathMsg),
        ["PickAt"] = typeof(PickAtMsg), ["SetProperty"] = typeof(SetPropertyMsg),
        ["SetTheme"] = typeof(SetThemeMsg), ["SetCanvasSize"] = typeof(SetCanvasSizeMsg),
        ["Ready"] = typeof(ReadyMsg), ["Frame"] = typeof(FrameMsg), ["Error"] = typeof(ErrorMsg),
        ["Hwnd"] = typeof(HwndMsg), ["NativeExited"] = typeof(NativeExitedMsg),
        ["Selected"] = typeof(SelectedMsg), ["ElementProps"] = typeof(ElementPropsMsg),
        ["ContentProps"] = typeof(ContentPropsMsg),
    };
    private static int _assertions;
    private static JsonArray _fixtures = null!;

    public static void Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        Check(args.Length == 1, "Usage: Compatibility <fixtures.json|->");
        _fixtures = JsonNode.Parse(args[0] == "-" ? Console.In.ReadToEnd() : File.ReadAllText(args[0]))!["messages"]!.AsArray();
        Check(Wire.ProtocolVersion == 1, "production protocol version");
        Check(_fixtures.Select(x => x!["id"]!.GetValue<string>()).Distinct().Count() == _fixtures.Count, "unique fixture ids");
        TestDtos();
        TestClient();
        TestFraming();
        TestServer();
        Console.WriteLine(JsonSerializer.Serialize(new { kind = "summary", assertions = _assertions, fixtures = _fixtures.Count }));
    }

    private static void Check(bool condition, string context)
    {
        _assertions++;
        if (!condition) throw new InvalidOperationException("ASSERTION FAILED: " + context);
    }

    private static void Equal(JsonNode? actual, JsonNode? expected, string context)
        => Check(JsonNode.DeepEquals(actual, expected), $"{context}\nExpected: {expected}\nActual: {actual}");

    private static JsonNode WireFixture(string id)
        => _fixtures.Single(x => x!["id"]!.GetValue<string>() == id)!["wire"]!.DeepClone();

    private static void Emit(string kind, string id, JsonNode message)
        => Console.WriteLine(new JsonObject { ["kind"] = kind, ["id"] = id, ["message"] = message.DeepClone() }.ToJsonString());

    private static void TestDtos()
    {
        foreach (var fixture in _fixtures)
        {
            var id = fixture!["id"]!.GetValue<string>();
            var wire = fixture["wire"]!;
            var type = wire["type"]!.GetValue<string>();
            if (!Dtos.TryGetValue(type, out var dto))
            {
                Check(type is "Ping" or "Pong", $"no untested DTO: {type}");
                continue; // Production has no Ping/Pong DTOs; server/client tests cover them.
            }
            var value = JsonSerializer.Deserialize(wire.ToJsonString(), dto, ReadOptions)!;
            var serialized = JsonSerializer.Serialize(value, dto);
            Equal(JsonNode.Parse(serialized), fixture["normalized"] ?? wire, $"DTO roundtrip {id}");
            Check(!serialized.Contains('\n') && !serialized.Contains('\r'), $"one physical line: {id}");
            Emit("dto", id, JsonNode.Parse(serialized)!);

            var extended = wire.DeepClone().AsObject();
            extended["futureField"] = new JsonObject { ["nested"] = new JsonArray(1, "future", true) };
            var withUnknown = JsonSerializer.Deserialize(extended.ToJsonString(), dto, ReadOptions)!;
            Equal(JsonSerializer.SerializeToNode(withUnknown, dto), JsonNode.Parse(serialized), $"ignore unknown fields: {id}");
        }

        Equal(JsonSerializer.SerializeToNode(new HelloMsg()), WireFixture("hello"), "constructed Hello defaults");
        Equal(JsonSerializer.SerializeToNode(new LoadXamlMsg()), Expected("load-defaults"), "constructed Load defaults");
        Equal(JsonSerializer.SerializeToNode(new SetThemeMsg()), Expected("theme-defaults"), "constructed theme default");
        var missing = JsonSerializer.Deserialize<FrameMsg>("{}", ReadOptions)!;
        Check(missing.Type == null && missing.Format == null && missing.Width == 0 && missing.Data == null,
            "C# DTOs do not validate required response fields");
        var explicitNull = JsonSerializer.Deserialize<ReadyMsg>("{\"caps\":null,\"wasdk\":null}", ReadOptions)!;
        Check(explicitNull.Caps == null && explicitNull.Wasdk == null, "nullable fields accept explicit null");
        var wrongTypeRejected = false;
        try { JsonSerializer.Deserialize<FrameMsg>("{\"width\":\"800\"}", ReadOptions); }
        catch (JsonException) { wrongTypeRejected = true; }
        Check(wrongTypeRejected, "numeric strings are not coerced by C# DTOs");
        var wideWire = WireFixture("hwnd");
        wideWire["hwnd"] = 9007199254740993L;
        var wide = JsonSerializer.Deserialize<HwndMsg>(wideWire.ToJsonString(), ReadOptions)!;
        Check(wide.Hwnd == 9007199254740993L, "C# preserves Int64 beyond JavaScript precision");
        Emit("int64", "unsafe-hwnd", JsonSerializer.SerializeToNode(wide)!);
    }

    private static JsonNode Expected(string id)
    {
        var fixture = _fixtures.Single(x => x!["id"]!.GetValue<string>() == id)!;
        return fixture["normalized"] ?? fixture["wire"]!;
    }

    private static void TestClient()
    {
        var logs = new List<string>();
        using var client = new SurfaceClient("not-launched", null, logs.Add);
        var received = new List<JsonNode>();
        void Capture(object value) => received.Add(JsonSerializer.SerializeToNode(value, value.GetType())!);
        client.Ready += Capture;
        client.Frame += Capture;
        client.Error += Capture;
        client.Hwnd += Capture;
        client.Selected += Capture;
        client.ElementProps += Capture;
        client.ContentProps += Capture;
        client.NativeExited += () => received.Add(new JsonObject { ["type"] = "NativeExited" });
        var dispatch = typeof(SurfaceClient).GetMethod("Dispatch", BindingFlags.Instance | BindingFlags.NonPublic)!;
        void Dispatch(string json) => dispatch.Invoke(client, new object[] { json });

        foreach (var fixture in _fixtures.Where(x => x!["direction"]!.GetValue<string>() == "server"))
        {
            var id = fixture!["id"]!.GetValue<string>();
            var before = received.Count;
            Dispatch(fixture["wire"]!.ToJsonString());
            if (id == "pong") Check(received.Count == before, "Pong has no event");
            else
            {
                Check(received.Count == before + 1, $"dispatch event: {id}");
                Equal(received[^1], Expected(id), $"dispatch payload: {id}");
            }
        }
        var count = received.Count;
        foreach (var json in new[] { "", "diagnostic", "{", "null", "[]", "{\"type\":4}", "{\"TYPE\":\"Frame\"}", "{\"type\":\"FutureReply\"}", "{\"type\":\"frame\"}" })
            Dispatch(json);
        Check(received.Count == count, "malformed, missing/exact-case discriminator and unknown messages do not raise events");
        Check(logs.Any(x => x.Contains("FutureReply")), "unknown server type logged");
        Dispatch("{\"type\":\"Frame\",\"WIDTH\":9,\"future\":true}");
        Check(received[^1]["width"]!.GetValue<int>() == 9, "payload properties are case-insensitive after exact type dispatch");
        Dispatch("{\"type\":\"Ready\",\"protocol\":999,\"caps\":[]}");
        Check(received[^1]["protocol"]!.GetValue<int>() == 999, "client does not reject Ready version mismatch");
        var framesBefore = received.Count;
        Dispatch("{\"type\":\"Frame\",\"width\":2,\"requestId\":2}");
        Dispatch("{\"type\":\"Frame\",\"width\":1,\"requestId\":1}");
        Check(received.Count == framesBefore + 2 && received[^1]["width"]!.GetValue<int>() == 1,
            "no protocol request-id filtering: older frames still dispatch; requestId is unknown");
        var threw = false;
        try { Dispatch("{\"type\":\"Frame\",\"width\":\"wrong\"}"); }
        catch (TargetInvocationException ex) when (ex.InnerException is JsonException) { threw = true; }
        Check(threw, "typed payload errors escape Dispatch (not silently accepted)");
    }

    private static void TestFraming()
    {
        var lines = _fixtures.Select(x => x!["wire"]!.ToJsonString()).ToArray();
        // Raw non-ASCII, CRLF, multiple messages, blank lines, and a final unterminated tail.
        var source = string.Join("\r\n", lines) + "\r\n\n{\"type\":\"UpdateXaml\",\"xaml\":\"雪 😀\"}\nunterminated";
        var bytes = Encoding.UTF8.GetBytes(source);
        var decoder = new LineDecoder();
        var result = new List<string>();
        foreach (var b in bytes) result.AddRange(decoder.Push(new[] { b }, 1));
        Check(result.Count == lines.Length + 2, "one-byte fragmentation yields all complete lines only");
        for (var i = 0; i < lines.Length; i++) Equal(JsonNode.Parse(result[i]), JsonNode.Parse(lines[i]), $"framing payload {i}");
        Check(result[^2] == "", "decoder emits blank lines (Dispatch ignores them)");
        Check(JsonNode.Parse(result[^1])!["xaml"]!.GetValue<string>() == "雪 😀", "split UTF-8 sequences survive");
        Check(decoder.Push(new byte[] { 10 }, 1).Single() == "unterminated", "tail retained until LF");
        var whole = new LineDecoder().Push(bytes, bytes.Length).ToArray();
        Check(whole.SequenceEqual(result), "coalesced and fragmented streams decode identically");
    }

    private static void TestServer()
    {
        using var server = new ServerHarness();
        var host = server.Host;
        JsonNode[] Request(string json) => server.Request(json);
        void Silent(string json) => Check(Request(json).Length == 0, $"no reply: {json}");
        JsonNode One(string json)
        {
            var result = Request(json);
            Check(result.Length == 1, $"exactly one reply: {json}");
            return result[0];
        }
        var ready = One("{\"type\":\"Hello\",\"protocol\":999,\"client\":null,\"caps\":[\"future-cap\"]}");
        var expectedReady = WireFixture("ready");
        expectedReady["caps"]!.AsArray().RemoveAt(2);
        Equal(ready, expectedReady, "server advertises fixed version and capabilities; no negotiation");
        Emit("server", "ready", ready);
        Equal(One("{\"type\":\"Ping\"}"), WireFixture("pong"), "Ping/Pong");
        Silent("   ");

        foreach (var command in new[] { "{\"type\":\"LoadXaml\"}", "{\"type\":\"UpdateXaml\",\"xaml\":null}", "{\"type\":\"EnterNative\",\"xaml\":42}" })
            Check(One(command)["phase"]!.GetValue<string>() == "parse", "required string XAML");
        Equal(One("{\"type\":\"Future\"}"), WireFixture("error-helper"), "unknown client command");
        Emit("server", "error-helper", One("{\"type\":\"Future\"}"));
        Check(One("{\"TYPE\":\"Hello\"}")["phase"]!.GetValue<string>() == "parse", "case-sensitive server fields");
        Check(One("{\"type\":4}")["phase"]!.GetValue<string>() == "parse", "non-string discriminator");
        foreach (var json in new[] { "{", "null", "[]", "{\"type\":\"PickAt\",\"x\":\"bad\",\"y\":1}", "{\"type\":\"SetProperty\",\"id\":\"7\",\"name\":\"Text\"}" })
        {
            var error = One(json);
            Check(error["phase"]!.GetValue<string>() == "render" && error["message"]!.GetValue<string>().StartsWith("Server error:"),
                $"outer catch reports render error: {json}");
            Check(error["notDesignable"] == null, "helper error omits notDesignable");
        }
        foreach (var json in new[] { "{\"type\":\"PickAt\",\"x\":1}", "{\"type\":\"SetProperty\",\"id\":-1,\"name\":\"Text\"}", "{\"type\":\"SetProperty\",\"id\":1.5,\"name\":\"Text\"}", "{\"type\":\"SetProperty\",\"id\":7,\"name\":\"\"}" })
            Check(One(json)["phase"]!.GetValue<string>() == "parse", $"semantic validation: {json}");

        Silent("{\"type\":\"Resize\"}");
        var frame = One("{\"type\":\"LoadXaml\",\"xaml\":\"<Grid />\",\"future\":true}");
        Equal(frame, WireFixture("frame"), "real server frame serializer");
        Emit("server", "frame", frame);
        Check(host.LastRender == ("<Grid />", 800d, 600d, 1d), "server initial viewport defaults");
        One("{\"type\":\"Resize\",\"width\":100.5,\"height\":200.25,\"scale\":1.5}");
        Check(host.LastRender == ("<Grid />", 100.5, 200.25, 1.5), "positive fractional viewport updates");
        One("{\"type\":\"LoadXaml\",\"xaml\":\"\",\"width\":0,\"height\":-1,\"scale\":\"2\"}");
        Check(host.LastRender == ("", 100.5, 200.25, 1.5), "empty XAML accepted; invalid dimensions preserve state");
        One("{\"type\":\"Resize\",\"width\":null,\"height\":false}");
        Check(host.LastRender == ("", 100.5, 200.25, 1.5), "null/boolean/missing dimensions preserve state");
        One("{\"type\":\"UpdateXaml\",\"xaml\":\"updated\",\"width\":999}");
        Check(host.LastRender == ("updated", 100.5, 200.25, 1.5), "UpdateXaml ignores size fields");

        var native = Request(WireFixture("enter").ToJsonString());
        Check(native.Length == 2, "native success sends Hwnd followed by ContentProps");
        Equal(native[0], WireFixture("hwnd"), "real server native serializer");
        Equal(native[1], WireFixture("content"), "real server content-property serializer");
        Emit("server", "hwnd", native[0]);
        Emit("server", "content", native[1]);
        Check(host.LastHost == ("<Page />", true), "first native entry prepares window");
        var renders = host.Renders;
        Silent("{\"type\":\"Resize\",\"width\":900,\"height\":700,\"scale\":2}");
        Check(host.Renders == renders, "native Resize does not render");
        Check(Request("{\"type\":\"UpdateXaml\",\"xaml\":\"live\"}").Length == 2 && host.LastHost == ("live", false), "native update rehosts, not frame");
        Check(Request("{\"type\":\"SetCanvasSize\",\"width\":390.5,\"height\":844}").Length == 2 && host.Canvas == (390.5, 844d), "canvas preset rehosts native");
        Request("{\"type\":\"SetCanvasSize\",\"width\":390,\"height\":0}");
        Check(host.Canvas == null, "either nonpositive canvas dimension clears both");
        var hosts = host.Hosts;
        Silent("{\"type\":\"SetTheme\",\"theme\":\"Dark\"}");
        Check(host.Hosts == hosts && host.Renders == renders, "SetTheme is a compatibility no-op");
        One("{\"type\":\"LoadXaml\",\"xaml\":\"frame-even-when-native\"}");
        Check(host.LastRender == ("frame-even-when-native", 900d, 700d, 2d), "LoadXaml always frames, including native mode");
        Check(Request("{\"type\":\"UpdateXaml\",\"xaml\":\"still-native\"}").Length == 2, "LoadXaml does not clear native flag");
        Equal(One("{\"type\":\"ExitNative\"}"), WireFixture("native-exited"), "ExitNative acknowledgement");
        Check(host.Restored, "ExitNative dispatches restoration");
        One("{\"type\":\"UpdateXaml\",\"xaml\":\"frame-again\"}");
        Check(host.LastRender == ("frame-again", 900d, 700d, 2d), "ExitNative resumes frames and native Resize persisted viewport");
        Silent("{\"type\":\"SetCanvasSize\",\"width\":400,\"height\":300}");
        Check(host.Canvas == (400d, 300d), "canvas override stored without frame reply");

        Silent("{\"type\":\"SetMode\",\"design\":true}");
        Check(host.Design, "design true");
        Silent("{\"type\":\"SetMode\",\"design\":\"true\"}");
        Check(!host.Design, "only JSON true enables design mode");
        Silent("{\"type\":\"SelectByPath\",\"path\":\"0.1.0\"}");
        Check(host.Path == "0.1.0", "path forwarded unchanged; unresolved host produces no reply");
        Silent("{\"type\":\"SelectByPath\",\"path\":4}");
        Check(host.Path == null, "non-string path becomes null");
        Silent(WireFixture("pick").ToJsonString());
        Check(host.Point == (-2.5, 44.25), "fractional negative point forwarded");
        Silent("{\"type\":\"SetProperty\",\"id\":7,\"name\":\"Text\",\"value\":null}");
        Check(host.Property == (7, "Text", ""), "null property value becomes empty string");
        Silent(WireFixture("property").ToJsonString());
        Check(host.Property == (7, "Text", "雪\n\"quoted\"\\end"), "property payload is not corrupted");

        var selection = new DesignSelectionPayload
        {
            Id = 7, TypeName = "TextBlock", Name = "Greeting", Path = "0.1.0",
            X = 12.5, Y = -4.25, W = 120.5, H = 30,
            Props = WireFixture("props")["props"]!.AsArray().Select(p => new DesignPropInfo
            {
                Name = p!["name"]!.GetValue<string>(), Category = p["category"]!.GetValue<string>(),
                TypeName = p["type"]!.GetValue<string>(), Value = p["value"]!.GetValue<string>(),
                ReadOnly = p["readOnly"]!.GetValue<bool>(),
                Options = p["options"]?.AsArray().Select(x => x!.GetValue<string>()).ToList(),
            }).ToList(),
        };
        host.Select(selection);
        var events = Request("{\"type\":\"SetMode\"}");
        Check(events.Length == 2, "selection emits two messages");
        Equal(events[0], WireFixture("selected"), "real Selected serializer");
        Equal(events[1], WireFixture("props"), "real ElementProps serializer");
        Emit("server", "selected", events[0]);
        Emit("server", "props", events[1]);
        host.Refresh(selection);
        Equal(One("{\"type\":\"SetMode\"}"), WireFixture("props"), "property refresh has no Selected echo");

        foreach (var id in new[] { "error-parse", "error-activation", "error-nonpage" })
        {
            var error = WireFixture(id);
            host.Render = new RenderResult
            {
                Phase = error["phase"]!.GetValue<string>(), Message = error["message"]!.GetValue<string>(),
                Line = error["line"]?.GetValue<int>(), Column = error["column"]?.GetValue<int>(),
                NotDesignable = error["notDesignable"]!.GetValue<bool>(),
            };
            Equal(One("{\"type\":\"LoadXaml\",\"xaml\":\"bad\"}"), error, $"render failure fields {id}");
        }
        host.Live = new LiveResult { Phase = "activation", Message = "Cannot activate user type." };
        Equal(One("{\"type\":\"EnterNative\",\"xaml\":\"bad\"}"), WireFixture("error-activation"), "native failure fields");
        Equal(One("{\"type\":\"UpdateXaml\",\"xaml\":\"still bad\"}"), WireFixture("error-activation"), "failed EnterNative retains native mode");
        DispatcherQueue.Reject = true;
        try
        {
            Equal(One("{\"type\":\"ExitNative\"}"), WireFixture("native-exited"), "NativeExited is acknowledged even if dispatcher rejects");
            Equal(One("{\"type\":\"LoadXaml\",\"xaml\":\"queued\"}"), WireFixture("error-render"), "dispatcher failure response");
        }
        finally { DispatcherQueue.Reject = false; }
    }

    private sealed class ServerHarness : IDisposable
    {
        private readonly TcpClient _client = new();
        private readonly TcpClient _accepted;
        private readonly StreamReader _reader;
        private readonly StreamWriter _writer;
        private readonly Task _loop;
        public RenderHost Host { get; } = new();

        public ServerHarness()
        {
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            try
            {
                _client.Connect((IPEndPoint)listener.LocalEndpoint);
                _accepted = listener.AcceptTcpClient();
            }
            finally { listener.Stop(); }
            _client.ReceiveTimeout = 5000;
            _client.NoDelay = true;
            _accepted.NoDelay = true;
            _reader = new StreamReader(_client.GetStream(), new UTF8Encoding(false));
            _writer = new StreamWriter(_client.GetStream(), new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
            var server = new FrameServer(Host);
            typeof(FrameServer).GetField("_stream", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(server, _accepted.GetStream());
            // Never call Start/AcceptLoop/Shutdown: those own the real process lifecycle.
            _loop = Task.Run(() => typeof(FrameServer).GetMethod("ReadLoop", BindingFlags.Instance | BindingFlags.NonPublic)!
                .Invoke(server, new object[] { _accepted.GetStream() }));
        }

        public JsonNode[] Request(string json)
        {
            _writer.WriteLine(json);
            _writer.WriteLine("{\"type\":\"Ping\"}");
            var replies = new List<JsonNode>();
            var commandIsPing = json == "{\"type\":\"Ping\"}";
            while (true)
            {
                var line = _reader.ReadLine() ?? throw new InvalidOperationException("Server unexpectedly closed");
                var reply = JsonNode.Parse(line)!;
                if (reply["type"]!.GetValue<string>() == "Pong")
                {
                    if (!commandIsPing) break;
                    commandIsPing = false;
                }
                replies.Add(reply);
            }
            return replies.ToArray();
        }

        public void Dispose()
        {
            _client.Client.Shutdown(SocketShutdown.Send);
            Check(_loop.Wait(TimeSpan.FromSeconds(5)), "server read loop completes on EOF");
            _writer.Dispose();
            _reader.Dispose();
            _client.Dispose();
            _accepted.Dispose();
        }
    }
}
