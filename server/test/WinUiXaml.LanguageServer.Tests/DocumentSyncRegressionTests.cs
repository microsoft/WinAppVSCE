using System.Text;
using System.Text.Json;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Xaml;

namespace WinUiXaml.LanguageServer.Tests;

/// <summary>Regressions for #360 (CR line endings, lone surrogates) and #366 (deep outline responses).</summary>
public sealed class DocumentSyncRegressionTests
{
    [Theory]
    [InlineData("\r")]
    [InlineData("\n")]
    [InlineData("\r\n")]
    public void LineEndingsMapPositionsToTheRightLine(string nl)
    {
        var text = $"<Grid>{nl}  <TextBlock/>{nl}  <Buton/>{nl}</Grid>";
        var doc = new TextDocument("file:///t.xaml", text);
        int offset = text.IndexOf("Buton", StringComparison.Ordinal);

        Assert.Equal(new Position(2, 3), doc.PositionAt(offset));
        Assert.Equal(offset, doc.OffsetAt(new Position(2, 3)));
        Assert.Equal(4, doc.LineCount);
    }

    [Fact]
    public void FormattingReindentsCrOnlyDocuments()
    {
        var doc = new TextDocument("file:///t.xaml", "<Grid>\r<TextBlock/>\r</Grid>");
        var edit = Assert.Single(XamlFormatter.Format(doc, new FormattingOptions { TabSize = 4, InsertSpaces = true }));
        Assert.Equal(1, edit.Range.Start.Line);
        Assert.Equal("    ", edit.NewText);
    }

    [Fact]
    public void OffsetToPositionTreatsCrAsALineBreak()
    {
        Assert.Equal(new Position(2, 1), LineBreaks.OffsetToPosition("a\rb\r\ncd", 6));
        Assert.Equal("\r", LineBreaks.Detect("a\rb"));
        Assert.Equal("\r\n", LineBreaks.Detect("a\r\nb"));
    }

    [Theory]
    [InlineData("""{"textDocument":{"uri":"file:///t.xaml"},"contentChanges":[{"text":"<Grid>\uD800</Grid>"}]}""")]
    [InlineData("""{"textDocument":{"uri":"file:///t.xaml"},"contentChanges":[{"text":"<Grid>\uDC00x\uD83D</Grid>"}]}""")]
    public void LoneSurrogatesInDidChangeAreReplacedNotRejected(string json)
    {
        var p = JsonSerializer.Deserialize(json, LspJsonContext.Default.DidChangeTextDocumentParams)!;
        var text = p.ContentChanges[0].Text;

        Assert.StartsWith("<Grid>\uFFFD", text);
        Assert.EndsWith("</Grid>", text);
        Assert.DoesNotContain(text, char.IsSurrogate);
    }

    [Fact]
    public void LoneSurrogateInDidOpenIsReplacedAndKeepsOtherEscapes()
    {
        var json = """{"textDocument":{"uri":"u","languageId":"xaml","version":1,"text":"a\tb\"\uD800\u00e9\uD83D\uDE00"}}""";
        var p = JsonSerializer.Deserialize(json, LspJsonContext.Default.DidOpenTextDocumentParams)!;
        Assert.Equal("a\tb\"\uFFFD\u00e9\U0001F600", p.TextDocument.Text);
    }

    [Fact]
    public void ReplacedSurrogateIsReportedAsAnInvalidCharacter()
    {
        var doc = new TextDocument("file:///t.xaml", "<Grid>\uD800</Grid>");
        Assert.Contains(doc.Parsed.Diagnostics, d => d.Id == XamlDiagnosticIds.InvalidCharacter);
    }

    [Theory]
    [InlineData(10)]
    [InlineData(500)]
    [InlineData(512)]
    public async Task DeepOutlineSerializesAndKeepsEveryElement(int depth)
    {
        var text = string.Concat(Enumerable.Repeat("<StackPanel>", depth)) + "<TextBlock/>" +
            string.Concat(Enumerable.Repeat("</StackPanel>", depth));
        var doc = new TextDocument("file:///t.xaml", text);

        var outline = XamlLanguageServer.BuildOutline(doc);
        var json = await RespondAsync(outline);

        Assert.Empty(doc.Parsed.Diagnostics);
        Assert.Equal(depth + 1, Count(outline));
        Assert.Contains("\"result\":[", json);
        Assert.Contains("TextBlock", json);
    }

    [Fact]
    public async Task DeepSelectionRangeSerializes()
    {
        int depth = 512;
        var text = string.Concat(Enumerable.Repeat("<StackPanel>", depth)) + "<TextBlock/>" +
            string.Concat(Enumerable.Repeat("</StackPanel>", depth));
        var doc = new TextDocument("file:///t.xaml", text);
        var position = doc.PositionAt(text.IndexOf("TextBlock", StringComparison.Ordinal));

        var ranges = XamlSelectionRange.Compute(doc, new[] { position });
        var json = await RespondAsync(ranges);

        Assert.Contains("\"result\":[", json);
        var outermost = ranges[0];
        while (outermost.Parent != null)
        {
            outermost = outermost.Parent;
        }

        Assert.Equal(doc.PositionAt(text.Length), outermost.Range.End);
    }

    // Requests run on default 1 MB threads; an overflow here would kill the server process.
    [Theory]
    [InlineData(512)]
    [InlineData(5000)]
    public void DeepDocumentFeaturesFitInADefaultThreadStack(int depth)
    {
        var text = "<Page xmlns:x=\"x\">" +
            string.Concat(Enumerable.Repeat("<StackPanel Margin=\"1\" x:Name=\"a\">", depth)) +
            "<TextBlock Text=\"{Binding A, Mode=OneWay}\"/>" +
            string.Concat(Enumerable.Repeat("</StackPanel>", depth)) + "</Page>";
        bool completed = false;
        var thread = new Thread(() =>
        {
            var doc = new TextDocument("file:///t.xaml", text);
            XamlLanguageServer.BuildOutline(doc);
            XamlFormatter.Format(doc, new FormattingOptions { TabSize = 2, InsertSpaces = true });
            XamlSelectionRange.Compute(doc, new[] { doc.PositionAt(text.IndexOf("TextBlock", StringComparison.Ordinal)) });
            XamlFolding.Compute(doc);
            XamlSemanticTokens.Compute(doc);
            completed = true;
        }, 1024 * 1024);
        thread.Start();
        thread.Join();
        Assert.True(completed);
    }

    [Fact]
    public async Task UnserializableResultStillGetsAnErrorResponse()
    {
        var body = Encoding.UTF8.GetBytes("""{"jsonrpc":"2.0","id":7,"method":"deep"}""");
        var frame = Encoding.ASCII.GetBytes($"Content-Length: {body.Length}\r\n\r\n").Concat(body).ToArray();
        await using var input = new MemoryStream(frame);
        await using var output = new MemoryStream();
        var connection = new JsonRpcConnection(input, output)
        {
            // 600 levels exceed Utf8JsonWriter's depth limit of 1000 (object plus children array per level).
            OnRequest = (_, _, _) => Task.FromResult<object?>(Nest(600)),
        };

        await connection.RunAsync();

        var response = Encoding.UTF8.GetString(output.ToArray());
        Assert.True(response.Contains("\"code\":-32603"), response.Substring(0, Math.Min(300, response.Length)));
        Assert.Contains("\"id\":7", response);
    }

    /// <summary>Serializes a result exactly as the server does, by answering a request through the connection.</summary>
    private static async Task<string> RespondAsync(object result)
    {
        var body = Encoding.UTF8.GetBytes("""{"jsonrpc":"2.0","id":1,"method":"m"}""");
        var frame = Encoding.ASCII.GetBytes($"Content-Length: {body.Length}\r\n\r\n").Concat(body).ToArray();
        await using var input = new MemoryStream(frame);
        await using var output = new MemoryStream();
        var connection = new JsonRpcConnection(input, output)
        {
            OnRequest = (_, _, _) => Task.FromResult<object?>(result),
        };

        await connection.RunAsync();
        return Encoding.UTF8.GetString(output.ToArray());
    }

    private static List<DocumentSymbol> Nest(int depth)
    {
        List<DocumentSymbol>? children = null;
        for (int i = 0; i < depth; i++)
        {
            children = new List<DocumentSymbol> { new() { Name = "n", Children = children } };
        }

        return children!;
    }

    private static int Count(List<DocumentSymbol>? symbols) =>
        symbols?.Sum(symbol => 1 + Count(symbol.Children)) ?? 0;
}
