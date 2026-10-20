using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Xaml;

namespace WinUiXaml.LanguageServer;

internal static class XamlNamespaceActions
{
    public static List<TextEdit> RemoveUnusedRootNamespaces(TextDocument doc)
    {
        if (doc.Parsed.Root is not { } root)
        {
            return new List<TextEdit>();
        }

        var used = CollectUsedPrefixes(root);
        var edits = new List<TextEdit>();
        foreach (var attribute in root.Attributes)
        {
            if (!attribute.IsNamespaceDeclaration ||
                attribute.Name.FullName == "xmlns" ||
                !attribute.Name.FullName.StartsWith("xmlns:", StringComparison.Ordinal))
            {
                continue;
            }

            var prefix = attribute.Name.FullName.Substring("xmlns:".Length);
            if (!used.Contains(prefix))
            {
                edits.Add(new TextEdit
                {
                    Range = doc.RangeOf(ExpandRemovalSpan(doc.Text, attribute.Span)),
                    NewText = string.Empty,
                });
            }
        }

        return edits;
    }

    private static HashSet<string> CollectUsedPrefixes(XamlElement root)
    {
        var used = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in root.DescendantNodesAndSelf())
        {
            switch (node)
            {
                case XamlElement element:
                    AddNamePrefix(element.Name, used);
                    AddNamePrefix(element.EndTagName, used);
                    break;

                case XamlAttribute attribute when !attribute.IsNamespaceDeclaration:
                    AddNamePrefix(attribute.Name, used);
                    CollectValuePrefixes(attribute, used);
                    break;

                case XamlMarkupExtension extension:
                    AddNamePrefix(extension.Name, used);
                    break;

                case XamlMarkupExtensionArgument argument:
                    AddNamePrefix(argument.Name, used);
                    break;
            }
        }

        return used;
    }

    private static void CollectValuePrefixes(XamlAttribute attribute, HashSet<string> used)
    {
        if (attribute.Value is not { } value)
        {
            return;
        }

        var text = value.Text;
        for (int i = 0; i < text.Length; i++)
        {
            if (!(char.IsLetter(text[i]) || text[i] == '_'))
            {
                continue;
            }

            int start = i++;
            while (i < text.Length && (char.IsLetterOrDigit(text[i]) || text[i] is '_' or '-'))
            {
                i++;
            }

            if (i < text.Length && text[i] == ':')
            {
                used.Add(text.Substring(start, i - start));
            }

            i--;
        }

        // Keep prefixes named by mc:Ignorable unless the action can also rewrite that directive.
        if (attribute.Name.LocalName == "Ignorable")
        {
            foreach (var token in text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries))
            {
                used.Add(token);
            }
        }
    }

    private static void AddNamePrefix(XamlName? name, HashSet<string> used)
    {
        if (name?.Prefix is { Length: > 0 } prefix)
        {
            used.Add(prefix);
        }
    }

    internal static TextSpan ExpandRemovalSpan(string text, TextSpan span)
    {
        int lineStart = span.Start;
        while (lineStart > 0 && text[lineStart - 1] is not '\r' and not '\n')
        {
            lineStart--;
        }

        bool onlyIndentBefore = true;
        for (int i = lineStart; i < span.Start; i++)
        {
            if (text[i] is not ' ' and not '\t')
            {
                onlyIndentBefore = false;
                break;
            }
        }

        int lineEnd = span.End;
        while (lineEnd < text.Length && text[lineEnd] is ' ' or '\t')
        {
            lineEnd++;
        }

        if (onlyIndentBefore && (lineEnd == text.Length || text[lineEnd] is '\r' or '\n'))
        {
            if (lineEnd < text.Length && text[lineEnd] == '\r')
            {
                lineEnd++;
            }
            if (lineEnd < text.Length && text[lineEnd] == '\n')
            {
                lineEnd++;
            }

            return new TextSpan(lineStart, lineEnd);
        }

        int start = span.Start;
        while (start > lineStart && text[start - 1] is ' ' or '\t')
        {
            start--;
        }

        return new TextSpan(start, span.End);
    }
}
