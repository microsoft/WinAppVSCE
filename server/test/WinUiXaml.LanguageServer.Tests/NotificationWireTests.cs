using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using WinUiXaml.LanguageServer.Lsp;

namespace WinUiXaml.LanguageServer.Tests;

// Notifications serialize by runtime type under Native AOT, with no reflection fallback and no reply path.
// Registered-type round trips miss the sent-but-unregistered defect; source-based coverage asks whether we registered what we send.
// Without this, a build-required prompt lost to NotSupportedException looks like a project that built fine.
public class NotificationWireTests
{
    /// <summary>Reads the framed payload of every message written to an output stream.</summary>
    private static List<JsonDocument> ReadFramedMessages(byte[] output)
    {
        var messages = new List<JsonDocument>();
        var text = Encoding.UTF8.GetString(output);
        var offset = 0;
        while (true)
        {
            var headerEnd = text.IndexOf("\r\n\r\n", offset, StringComparison.Ordinal);
            if (headerEnd < 0)
            {
                break;
            }

            var header = text.Substring(offset, headerEnd - offset);
            var match = Regex.Match(header, @"Content-Length:\s*(\d+)");
            Assert.True(match.Success, $"framing lost its Content-Length header: '{header}'");

            var length = int.Parse(match.Groups[1].Value);
            var bodyStart = headerEnd + 4;
            // Content-Length counts bytes, and these payloads are ASCII-safe, so the byte count and
            // the char count agree; asserting the slice exists keeps a truncated write from parsing.
            Assert.True(
                bodyStart + length <= text.Length,
                "Content-Length promised more bytes than were written");
            messages.Add(JsonDocument.Parse(text.Substring(bodyStart, length)));
            offset = bodyStart + length;
        }

        return messages;
    }

    private static async Task<JsonDocument> SendAndReadAsync(string method, object payload)
    {
        await using var input = new MemoryStream();
        await using var output = new MemoryStream();
        var connection = new JsonRpcConnection(input, output);

        await connection.SendNotificationAsync(method, payload);

        var messages = ReadFramedMessages(output.ToArray());
        Assert.Single(messages);
        return messages[0];
    }

    public static TheoryData<string, object, string, string> Notifications() => new()
    {
        {
            "window/showMessage",
            new ShowMessageParams { Type = 2, Message = "MSBuild is unavailable." },
            "message",
            "MSBuild is unavailable."
        },
        {
            "winui-xaml/projectRestoreRequired",
            new ProjectRestoreRequiredParams { ProjectPath = @"C:\app\App.csproj" },
            "projectPath",
            @"C:\app\App.csproj"
        },
        {
            "winui-xaml/projectBuildRequired",
            new ProjectBuildRequiredParams
            {
                ProjectPath = @"C:\app\App.csproj",
                UnresolvedAssemblies = new List<string> { "PlainLib" },
            },
            "projectPath",
            @"C:\app\App.csproj"
        },
        {
            "winui-xaml/projectContextStatus",
            new ProjectContextStatusParams
            {
                Uri = "file:///a.xaml",
                State = "build-required",
                Message = "PlainLib has not been built",
            },
            "state",
            "build-required"
        },
        {
            "textDocument/publishDiagnostics",
            new PublishDiagnosticsParams
            {
                Uri = "file:///a.xaml",
                Diagnostics = new List<Diagnostic>(),
            },
            "uri",
            "file:///a.xaml"
        },
    };

    [Theory]
    [MemberData(nameof(Notifications))]
    public async Task EveryNotificationTheServerSendsReachesTheWire(
        string method,
        object payload,
        string payloadProperty,
        string expectedValue)
    {
        var message = await SendAndReadAsync(method, payload);

        Assert.Equal("2.0", message.RootElement.GetProperty("jsonrpc").GetString());
        Assert.Equal(method, message.RootElement.GetProperty("method").GetString());
        // A notification carries no id; one here would make the client wait for a reply that the
        // server has no path to send.
        Assert.False(message.RootElement.TryGetProperty("id", out _));

        // Reading a field back proves the params were serialized rather than emitted as an empty
        // object -- the shape an unregistered nested type would produce if it failed quietly.
        var value = message.RootElement
            .GetProperty("params")
            .GetProperty(payloadProperty)
            .GetString();
        Assert.Equal(expectedValue, value);
    }

    [Fact]
    public async Task ANotificationWithAnUnregisteredPayloadFailsLoudly()
    {
        // Floor for the test above: assert the registration-specific exception, not any throw,
        // so an unrelated connection failure cannot masquerade as evidence.
        var error = await Assert.ThrowsAsync<InvalidOperationException>(async () =>
        {
            await using var input = new MemoryStream();
            await using var output = new MemoryStream();
            var connection = new JsonRpcConnection(input, output);
            await connection.SendNotificationAsync("test/unregistered", new UnregisteredPayload());
        });

        Assert.Contains(nameof(UnregisteredPayload), error.Message);
    }

    private sealed class UnregisteredPayload
    {
        public string Value { get; set; } = "unreachable";
    }

    [Fact]
    public void EveryPayloadTypeTheServerSendsIsRegisteredInTheJsonContext()
    {
        var sources = Directory
            .EnumerateFiles(ServerSourceDirectory(), "*.cs", SearchOption.AllDirectories)
            .ToList();

        var sent = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var file in sources)
        {
            var text = File.ReadAllText(file);
            foreach (Match match in Regex.Matches(
                text,
                @"SendNotificationAsync\(\s*""(?<method>[^""]+)""\s*,\s*new\s+(?<type>\w+)"))
            {
                sent[match.Groups["type"].Value] = match.Groups["method"].Value;
            }
        }

        // If the call shape is ever refactored past this regex the harvest silently empties and the
        // test passes while checking nothing, so the harvest size is asserted before its contents.
        Assert.True(
            sent.Count >= 5,
            $"harvested only {sent.Count} notification payload types; the regex has probably " +
            "stopped matching the call shape in XamlLanguageServer*.cs");

        var registered = LspJsonContextRoundTripTests.RegisteredTypes()
            .Select(type => type.Name)
            .ToHashSet(StringComparer.Ordinal);

        var unregistered = sent
            .Where(pair => !registered.Contains(pair.Key))
            .Select(pair => $"{pair.Key} (sent as {pair.Value})")
            .ToList();

        Assert.True(
            unregistered.Count == 0,
            "these payload types are sent but absent from LspJsonContext, so serializing them " +
            "throws under Native AOT and the notification is silently never delivered: " +
            string.Join(", ", unregistered));
    }

    private static string ServerSourceDirectory()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null)
        {
            var candidate = Path.Combine(
                directory.FullName,
                "server",
                "src",
                "WinUiXaml.LanguageServer");
            if (Directory.Exists(candidate))
            {
                return candidate;
            }

            directory = directory.Parent;
        }

        throw new DirectoryNotFoundException(
            "could not locate server/src/WinUiXaml.LanguageServer above " + AppContext.BaseDirectory);
    }
}
