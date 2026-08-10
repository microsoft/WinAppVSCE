using System;
using System.Collections.Generic;
using Microsoft.CodeAnalysis;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Workspace;
using WinUiXaml.Xaml;

namespace WinUiXaml.LanguageServer;

internal static partial class CompletionProvider
{
    private static INamedTypeSymbol? ResolveElementType(
        XamlName name, XamlNamespaceScope scope, XamlTypeSystem typeSystem)
    {
        if (!scope.TryResolvePrefix(name.Prefix, out var uri))
        {
            return null;
        }

        return typeSystem.ResolveType(uri, name.LocalName);
    }

    private static XamlName ParseQualified(string qualified)
    {
        SplitQualified(qualified, out var prefix, out var local);
        var empty = TextSpan.Empty(0);
        return new XamlName(prefix.Length > 0 ? prefix : null, local, empty, null, empty);
    }

    private static void SplitQualified(string name, out string prefix, out string local)
    {
        int colon = name.IndexOf(':');
        if (colon >= 0)
        {
            prefix = name.Substring(0, colon);
            local = name.Substring(colon + 1);
        }
        else
        {
            prefix = string.Empty;
            local = name;
        }
    }

    private static XamlElement? FindEnclosingElement(XamlNode? node)
    {
        for (var current = node; current != null; current = current.Parent)
        {
            if (current is XamlElement element)
            {
                return element;
            }
        }

        return null;
    }

    private static XamlNamespaceScope EffectiveScope(XamlNode? node, XamlDocument document)
    {
        for (var current = node; current != null; current = current.Parent)
        {
            if (current is XamlElement element && element.NamespaceScope.Declarations.Count > 0)
            {
                return element.NamespaceScope;
            }
        }

        return document.Root?.NamespaceScope ?? XamlNamespaceScope.Empty;
    }

    private static string DescribeMember(XamlMemberInfo member)
    {
        var typeName = member.Type?.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat) ?? "?";
        var kind = member.Kind == XamlMemberKind.Event ? "event" : "property";
        return $"{kind} : {typeName}";
    }

    /// <summary>The symbol's XML-doc &lt;summary&gt; as a completion documentation flyout (VS quick-info or null when the symbol carries no documentation.</summary>
    private static MarkupContent? CompletionDoc(ISymbol? symbol)
    {
        var summary = symbol is null ? null : XmlDocSummary.Extract(symbol.GetDocumentationCommentXml());
        return summary is null ? null : new MarkupContent { Value = summary };
    }

    private static bool StartsWith(string candidate, string partial) =>
        partial.Length == 0 || candidate.StartsWith(partial, StringComparison.OrdinalIgnoreCase);

    private static bool IsNameChar(char c) =>
        char.IsLetterOrDigit(c) || c is '_' or ':' or '.';

    private static int IndexOfWhitespace(string s)
    {
        for (int i = 0; i < s.Length; i++)
        {
            if (char.IsWhiteSpace(s[i]))
            {
                return i;
            }
        }

        return -1;
    }

    private const int MaxItems = 2000;

    private static CompletionList Finish(List<CompletionItem> items)
    {
        bool incomplete = items.Count > MaxItems;
        if (incomplete)
        {
            items = items.GetRange(0, MaxItems);
        }

        return new CompletionList { IsIncomplete = incomplete, Items = items };
    }
}
