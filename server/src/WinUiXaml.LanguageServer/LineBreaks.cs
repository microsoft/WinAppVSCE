using WinUiXaml.LanguageServer.Lsp;

namespace WinUiXaml.LanguageServer;

/// <summary>LSP line-break rules: "\r\n", "\r", and "\n" each end a line.</summary>
internal static class LineBreaks
{
    public static int[] ComputeLineStarts(string text)
    {
        var starts = new List<int> { 0 };
        for (int i = 0; i < text.Length; i++)
        {
            char c = text[i];
            if (c == '\r')
            {
                if (i + 1 < text.Length && text[i + 1] == '\n')
                {
                    i++;
                }

                starts.Add(i + 1);
            }
            else if (c == '\n')
            {
                starts.Add(i + 1);
            }
        }

        return starts.ToArray();
    }

    /// <summary>The start offset of the line containing <paramref name="offset"/>.</summary>
    public static int LineStart(string text, int offset)
    {
        int i = Math.Clamp(offset, 0, text.Length);
        while (i > 0 && text[i - 1] is not '\r' and not '\n')
        {
            i--;
        }

        return i;
    }

    /// <summary>The document's first line break, or "\n" when it has none.</summary>
    public static string Detect(string text)
    {
        int i = text.AsSpan().IndexOfAny('\r', '\n');
        if (i < 0)
        {
            return "\n";
        }

        if (text[i] == '\n')
        {
            return "\n";
        }

        return i + 1 < text.Length && text[i + 1] == '\n' ? "\r\n" : "\r";
    }

    public static Position OffsetToPosition(string text, int offset)
    {
        int limit = Math.Clamp(offset, 0, text.Length);
        int line = 0;
        int lineStart = 0;
        for (int i = 0; i < limit; i++)
        {
            char c = text[i];
            if (c == '\r' && i + 1 < text.Length && text[i + 1] == '\n')
            {
                continue;
            }

            if (c is '\r' or '\n')
            {
                line++;
                lineStart = i + 1;
            }
        }

        return new Position(line, limit - lineStart);
    }
}
