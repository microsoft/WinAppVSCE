using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Xaml;

namespace WinUiXaml.LanguageServer;

/// <summary>
/// An open text document: its text, the parsed XAML tree, and a line index for converting between
/// LSP (line, character) positions and flat character offsets. Positions use UTF-16 code units,
/// which matches .NET string indexing.
/// </summary>
internal sealed class TextDocument
{
    private readonly int[] _lineStarts;

    public TextDocument(string uri, string text)
    {
        Uri = uri;
        Text = text;
        Parsed = XamlParser.Parse(text);
        _lineStarts = ComputeLineStarts(text);
    }

    public string Uri { get; }

    public string Text { get; }

    public XamlDocument Parsed { get; }

    public int OffsetAt(Position position)
    {
        if (position.Line < 0)
        {
            return 0;
        }

        if (position.Line >= _lineStarts.Length)
        {
            return Text.Length;
        }

        int lineStart = _lineStarts[position.Line];
        int lineEnd = position.Line + 1 < _lineStarts.Length ? _lineStarts[position.Line + 1] : Text.Length;
        int offset = lineStart + Math.Max(0, position.Character);
        return Math.Min(offset, lineEnd);
    }

    public Position PositionAt(int offset)
    {
        if (offset <= 0)
        {
            return new Position(0, 0);
        }

        if (offset > Text.Length)
        {
            offset = Text.Length;
        }

        // Binary search for the greatest line start <= offset.
        int low = 0;
        int high = _lineStarts.Length - 1;
        while (low < high)
        {
            int mid = (low + high + 1) / 2;
            if (_lineStarts[mid] <= offset)
            {
                low = mid;
            }
            else
            {
                high = mid - 1;
            }
        }

        return new Position(low, offset - _lineStarts[low]);
    }

    public Lsp.Range RangeOf(TextSpan span) =>
        new(PositionAt(span.Start), PositionAt(span.End));

    private static int[] ComputeLineStarts(string text)
    {
        var starts = new List<int> { 0 };
        for (int i = 0; i < text.Length; i++)
        {
            if (text[i] == '\n')
            {
                starts.Add(i + 1);
            }
        }

        return starts.ToArray();
    }
}
