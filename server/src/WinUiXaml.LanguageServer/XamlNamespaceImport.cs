using System;
using System.Collections.Generic;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Workspace;
using WinUiXaml.Xaml;

namespace WinUiXaml.LanguageServer;

/// <summary>Shares namespace-prefix selection and root declaration edits across completion and code actions.</summary>
internal static class XamlNamespaceImport
{
    public static bool TryPlan(
        TextDocument doc,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        string clrNamespace,
        out string prefix,
        out TextEdit? declarationEdit)
    {
        foreach (var declaration in scope.Declarations)
        {
            if (declaration.Key.Length == 0)
            {
                continue;
            }

            foreach (var declaredNamespace in typeSystem.ClrNamespacesForUri(declaration.Value))
            {
                if (string.Equals(declaredNamespace, clrNamespace, StringComparison.Ordinal))
                {
                    prefix = declaration.Key;
                    declarationEdit = null;
                    return true;
                }
            }
        }

        prefix = GeneratePrefix(clrNamespace, scope.Declarations.Keys);
        declarationEdit = BuildRootDeclarationEdit(doc, prefix, clrNamespace);
        return declarationEdit is not null;
    }

    internal static string GeneratePrefix(string clrNamespace, IEnumerable<string> declaredPrefixes)
    {
        var last = clrNamespace;
        var dot = clrNamespace.LastIndexOf('.');
        if (dot >= 0 && dot < clrNamespace.Length - 1)
        {
            last = clrNamespace.Substring(dot + 1);
        }

        var basePrefix = last.ToLowerInvariant();
        if (basePrefix.Length == 0)
        {
            basePrefix = "ns";
        }

        var used = new HashSet<string>(declaredPrefixes, StringComparer.Ordinal);
        var candidate = basePrefix;
        var counter = 2;
        while (used.Contains(candidate))
        {
            candidate = basePrefix + counter;
            counter++;
        }

        return candidate;
    }

    internal static TextEdit? BuildRootDeclarationEdit(TextDocument doc, string prefix, string clrNamespace)
        => BuildRootDeclarationEditForUri(doc, prefix, "using:" + clrNamespace);

    internal static TextEdit? BuildRootDeclarationEditForUri(
        TextDocument doc,
        string prefix,
        string namespaceUri)
    {
        var root = doc.Parsed.Root;
        if (root?.Name is null)
        {
            return null;
        }

        var insertAt = root.Name.Span.End;
        XamlAttribute? lastNamespace = null;
        foreach (var attribute in root.Attributes)
        {
            if (attribute.IsNamespaceDeclaration && attribute.Span.End > insertAt)
            {
                insertAt = attribute.Span.End;
                lastNamespace = attribute;
            }
        }

        var leading = " ";
        if (lastNamespace is not null &&
            TryGetLineIndent(doc.Text, lastNamespace.Span.Start, out var indent))
        {
            leading = DetectNewLine(doc.Text) + indent;
        }

        var pos = doc.PositionAt(insertAt);
        return new TextEdit
        {
            Range = new Lsp.Range(pos, pos),
            NewText = $"{leading}xmlns:{prefix}=\"{namespaceUri}\"",
        };
    }

    private static bool TryGetLineIndent(string text, int offset, out string indent)
    {
        var lineStart = offset > 0
            ? text.LastIndexOf('\n', offset - 1) + 1
            : 0;
        var length = offset - lineStart;
        for (var index = 0; index < length; index++)
        {
            var ch = text[lineStart + index];
            if (ch != ' ' && ch != '\t')
            {
                indent = string.Empty;
                return false;
            }
        }

        indent = text.Substring(lineStart, length);
        return true;
    }

    private static string DetectNewLine(string text) =>
        text.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";
}
