using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.CodeAnalysis;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Workspace;
using WinUiXaml.Xaml;

namespace WinUiXaml.LanguageServer;

internal static partial class CompletionProvider
{
    private static CompletionList CompleteDesignInstanceType(
        Context ctx, XamlNamespaceScope scope, XamlTypeSystem typeSystem, Lsp.Range replaceRange)
    {
        if (string.IsNullOrEmpty(ctx.BindPrefixPath) ||
            !scope.TryResolvePrefix(ctx.BindPrefixPath!, out var uri) ||
            !XamlNamespaces.IsDesignTime(uri))
        {
            return new CompletionList();
        }

        return CompleteTypeNameValue(ctx.Partial, scope, typeSystem, replaceRange, allTypeKinds: true);
    }

    /// <summary>Completes the static members (fields, properties, constants, enum members) of the owner type of an {x:Static Owner.|} reference.</summary>
    private static CompletionList CompleteStaticMember(
        Context ctx, XamlNamespaceScope scope, XamlTypeSystem typeSystem, Lsp.Range replaceRange)
    {
        if (string.IsNullOrEmpty(ctx.BindPrefixPath))
        {
            return new CompletionList();
        }

        SplitQualified(ctx.BindPrefixPath!, out var prefix, out var local);
        if (!scope.TryResolvePrefix(prefix, out var uri))
        {
            return new CompletionList();
        }

        var owner = typeSystem.ResolveType(uri, local);
        if (owner is null)
        {
            return new CompletionList();
        }

        var items = new List<CompletionItem>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (INamedTypeSymbol? t = owner; t != null; t = t.BaseType)
        {
            foreach (var member in t.GetMembers())
            {
                if (!member.IsStatic ||
                    member.DeclaredAccessibility != Accessibility.Public ||
                    member is not (IFieldSymbol or IPropertySymbol) ||
                    !StartsWith(member.Name, ctx.Partial) ||
                    !seen.Add(member.Name))
                {
                    continue;
                }

                var isEnumMember = member is IFieldSymbol { ContainingType.TypeKind: TypeKind.Enum };
                items.Add(new CompletionItem
                {
                    Label = member.Name,
                    Kind = isEnumMember ? CompletionItemKind.EnumMember
                        : member is IPropertySymbol ? CompletionItemKind.Property : CompletionItemKind.Field,
                    Documentation = CompletionDoc(member),
                    Detail = member.ContainingType?.Name,
                    TextEdit = new TextEdit { Range = replaceRange, NewText = member.Name },
                    FilterText = member.Name,
                    SortText = member.Name,
                });
            }
        }

        return Finish(items);
    }

    /// <summary>If the attribute value is a {TemplateBinding ...} and the caret sits in its property (first positional) argument</summary>
    private static Context? TryClassifyTemplateBinding(string text, int valueStart, int offset)
    {
        int i = valueStart;
        while (i < offset && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        if (i >= offset || text[i] != '{')
        {
            return null;
        }

        i++; // past '{'
        while (i < offset && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        int nameStart = i;
        while (i < offset && (char.IsLetterOrDigit(text[i]) || text[i] == ':'))
        {
            i++;
        }

        if (text.Substring(nameStart, i - nameStart) != "TemplateBinding")
        {
            return null;
        }

        // A space must separate the name from the property (so "{TemplateBinding" alone is name completion).
        if (i >= offset || !char.IsWhiteSpace(text[i]))
        {
            return null;
        }

        while (i < offset && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        var propSoFar = text.Substring(i, offset - i);
        foreach (var ch in propSoFar)
        {
            if (ch is '}' or ',' or '=' || char.IsWhiteSpace(ch))
            {
                return null;
            }
        }

        return new Context(ContextKind.TemplateBinding, propSoFar, i);
    }

    /// <summary>If the caret sits in a Name=value named argument of a markup extension (the attribute value opens with {)</summary>
    private static Context? TryClassifyMarkupArg(string text, int valueStart, int offset)
    {
        int open = valueStart;
        while (open < offset && char.IsWhiteSpace(text[open]))
        {
            open++;
        }

        if (open >= offset || text[open] != '{')
        {
            return null; // not a markup extension
        }

        var extension = ReadExtensionName(text, open, offset);

        // The partial value is the run of value chars immediately before the caret.
        int v = offset;
        while (v > open && (char.IsLetterOrDigit(text[v - 1]) || text[v - 1] == '_'))
        {
            v--;
        }

        // Immediately before the partial we require '=' (allowing surrounding whitespace).
        int e = v;
        while (e > open && char.IsWhiteSpace(text[e - 1]))
        {
            e--;
        }

        if (e <= open || text[e - 1] != '=')
        {
            return null;
        }

        // Read the argument name preceding '='.
        int nameEnd = e - 1;
        while (nameEnd > open && char.IsWhiteSpace(text[nameEnd - 1]))
        {
            nameEnd--;
        }

        int nameStart = nameEnd;
        while (nameStart > open && (char.IsLetterOrDigit(text[nameStart - 1]) || text[nameStart - 1] == '_'))
        {
            nameStart--;
        }

        if (nameStart >= nameEnd)
        {
            return null;
        }

        var argName = text.Substring(nameStart, nameEnd - nameStart);
        var partial = text.Substring(v, offset - v);
        return new Context(ContextKind.MarkupArg, partial, v, attributeName: argName, markupExtension: extension);
    }

    /// <summary>Reads the extension name token immediately after the opening <c>{</c> at <paramref name="open"/>.</summary>
    private static string ReadExtensionName(string text, int open, int limit)
    {
        int i = open + 1;
        while (i < limit && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        int start = i;
        while (i < limit && (char.IsLetterOrDigit(text[i]) || text[i] is '_' or ':'))
        {
            i++;
        }

        return text.Substring(start, i - start);
    }

    /// <summary>If the caret sits where a markup extension ARGUMENT NAME would be typed (just after the extension name or after a , separator, with no = yet)</summary>
    private static Context? TryClassifyMarkupArgName(string text, int valueStart, int offset)
    {
        int open = valueStart;
        while (open < offset && char.IsWhiteSpace(text[open]))
        {
            open++;
        }

        if (open >= offset || text[open] != '{')
        {
            return null;
        }

        int nameStartIdx = open + 1;
        while (nameStartIdx < offset && char.IsWhiteSpace(text[nameStartIdx]))
        {
            nameStartIdx++;
        }

        int nameEndIdx = nameStartIdx;
        while (nameEndIdx < offset && (char.IsLetterOrDigit(text[nameEndIdx]) || text[nameEndIdx] is '_' or ':'))
        {
            nameEndIdx++;
        }

        var extension = text.Substring(nameStartIdx, nameEndIdx - nameStartIdx);
        if (extension.Length == 0 || nameEndIdx >= offset)
        {
            return null; // still typing the name itself, or empty — handled by TryClassifyMarkupName
        }

        // The current token (argument-name partial) run immediately before the caret.
        int p = offset;
        while (p > nameEndIdx && (char.IsLetterOrDigit(text[p - 1]) || text[p - 1] == '_'))
        {
            p--;
        }

        // Skip whitespace back to the boundary that precedes the partial.
        int b = p;
        while (b > nameEndIdx && char.IsWhiteSpace(text[b - 1]))
        {
            b--;
        }

        // Valid name position: right after the extension name, or after an argument separator ','.
        bool afterName = b == nameEndIdx && p > nameEndIdx;
        bool afterComma = b > nameEndIdx && text[b - 1] == ',';
        if (!afterName && !afterComma)
        {
            return null;
        }

        var partial = text.Substring(p, offset - p);
        return new Context(ContextKind.MarkupArg, partial, p, attributeName: null, markupExtension: extension);
    }

    /// <summary>If the attribute value beginning at valueStart opens a markup extension ({) and the caret is still inside the extension's NAME token (no whitespace or argument separator typed</summary>
    private static Context? TryClassifyMarkupName(string text, int valueStart, int offset)
    {
        int i = valueStart;
        while (i < offset && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        if (i >= offset || text[i] != '{')
        {
            return null;
        }

        i++; // past '{'
        while (i < offset && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        int nameStart = i;
        while (i < offset && (char.IsLetterOrDigit(text[i]) || text[i] is '_' or ':'))
        {
            i++;
        }

        // The caret must sit at the end of the name token. Anything after it (space, '=', ',', '}', '(') means the user has moved past the name into the extension's arguments.
        if (i != offset)
        {
            return null;
        }

        var partial = text.Substring(nameStart, offset - nameStart);
        return new Context(ContextKind.MarkupName, partial, nameStart);
    }

    /// <summary>If the attribute value beginning at valueStart is an {x:Bind ...} or a classic {Binding ...} expression and the caret sits in its first positional (path) argument or its Path=</summary>
    private static Context? TryClassifyBind(string text, int valueStart, int offset)
    {
        int i = valueStart;
        while (i < offset && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        if (i >= offset || text[i] != '{')
        {
            return null;
        }

        int braceIndex = i;
        i++; // past '{'
        while (i < offset && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        int nameStart = i;
        while (i < offset && (char.IsLetterOrDigit(text[i]) || text[i] == ':'))
        {
            i++;
        }

        var extName = text.Substring(nameStart, i - nameStart);
        int colon = extName.IndexOf(':');
        var localName = colon >= 0 ? extName.Substring(colon + 1) : extName;
        if (localName != "Bind" && localName != "Binding")
        {
            return null; // only compiled bindings and classic {Binding} offer a statically typed path
        }

        bool isClassic = localName == "Binding";

        // A classic {Binding} roots its path away from the DataContext when its source is redirected.
        string? bindElementName = null;
        if (isClassic)
        {
            var redirect = ClassifyBindingSource(text, i, braceIndex, out var elementName);
            if (redirect == ClassicBindingRoot.Other)
            {
                return null;
            }

            if (redirect == ClassicBindingRoot.ElementName)
            {
                bindElementName = elementName;
            }
        }

        while (i < offset && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        // Locate the argument the caret sits in and whether it is the first.
        int argStart = i;
        bool firstArg = true;
        int depth = 0;
        for (int j = i; j < offset; j++)
        {
            char c = text[j];
            if (c is '(' or '{')
            {
                depth++;
            }
            else if (c is ')' or '}')
            {
                if (depth > 0)
                {
                    depth--;
                }
            }
            else if (c == ',' && depth == 0)
            {
                argStart = j + 1;
                firstArg = false;
            }
        }

        int p = argStart;
        while (p < offset && char.IsWhiteSpace(text[p]))
        {
            p++;
        }

        // A top-level '=' in this argument marks it named (Name=value).
        int eq = -1;
        int nameDepth = 0;
        for (int j = p; j < offset; j++)
        {
            char c = text[j];
            if (c is '(' or '{')
            {
                nameDepth++;
            }
            else if (c is ')' or '}')
            {
                if (nameDepth > 0)
                {
                    nameDepth--;
                }
            }
            else if (c == '=' && nameDepth == 0)
            {
                eq = j;
                break;
            }
        }

        int pathStart;
        if (eq >= 0)
        {
            if (text.Substring(p, eq - p).Trim() != "Path")
            {
                return null; // Mode=, Converter=, etc. — not a statically typed path
            }

            pathStart = eq + 1;
            while (pathStart < offset && char.IsWhiteSpace(text[pathStart]))
            {
                pathStart++;
            }
        }
        else
        {
            if (!firstArg)
            {
                return null; // only the first argument may be a bare positional path
            }

            pathStart = p;
        }

        // Everything from the path start to the caret is the path typed so far.
        while (pathStart < offset && (text[pathStart] == '!' || char.IsWhiteSpace(text[pathStart])))
        {
            pathStart++;
        }

        // A leading cast ((local:Type)Member) rebinds the completion root to the named type; skip the parenthesized type so the members typed after ')' complete against the cast target.
        string? bindCastType = null;
        if (pathStart < offset && text[pathStart] == '(')
        {
            int close = text.IndexOf(')', pathStart + 1);
            if (close < 0 || close >= offset)
            {
                return null;
            }

            string inner = text.Substring(pathStart + 1, close - pathStart - 1).Trim();
            if (inner.Length == 0 || inner.IndexOf('.') >= 0)
            {
                return null;
            }

            bindCastType = inner;
            pathStart = close + 1;
            while (pathStart < offset && char.IsWhiteSpace(text[pathStart]))
            {
                pathStart++;
            }
        }

        // A function binding (Method(arg, arg)) roots each ARGUMENT against the bind root.
        int argDepth = 0;
        int currentArgStart = pathStart;
        bool insideFunctionArgs = false;
        for (int j = pathStart; j < offset; j++)
        {
            char c = text[j];
            if (c == '(')
            {
                argDepth++;
                if (argDepth == 1)
                {
                    currentArgStart = j + 1;
                    insideFunctionArgs = true;
                }
            }
            else if (c == ')')
            {
                if (argDepth > 0)
                {
                    argDepth--;
                }

                if (argDepth == 0)
                {
                    insideFunctionArgs = false;
                }
            }
            else if (c == ',' && argDepth == 1)
            {
                currentArgStart = j + 1;
            }
        }

        if (insideFunctionArgs)
        {
            pathStart = currentArgStart;
            while (pathStart < offset && char.IsWhiteSpace(text[pathStart]))
            {
                pathStart++;
            }

            bindCastType = null; // a cast inside a function argument is not modelled for completion
        }

        var pathSoFar = text.Substring(pathStart, offset - pathStart);
        foreach (var ch in pathSoFar)
        {
            if (!char.IsLetterOrDigit(ch) && ch != '_' && ch != '.' && ch != ':' && ch != '[' && ch != ']')
            {
                return null;
            }
        }

        int dot = pathSoFar.LastIndexOf('.');
        if (dot < 0)
        {
            return new Context(ContextKind.BindPath, pathSoFar, pathStart, bindPrefixPath: string.Empty, markupExtension: extName, bindCastType: bindCastType, isClassicBinding: isClassic, bindElementName: bindElementName, isExplicitBindingPath: eq >= 0);
        }

        var prefixPath = pathSoFar.Substring(0, dot);
        var memberPartial = pathSoFar.Substring(dot + 1);
        return new Context(ContextKind.BindPath, memberPartial, pathStart + dot + 1, bindPrefixPath: prefixPath, markupExtension: extName, bindCastType: bindCastType, isClassicBinding: isClassic, bindElementName: bindElementName, isExplicitBindingPath: eq >= 0);
    }

    /// <summary>How a classic <c>{Binding}</c> roots the path being completed.</summary>
    private enum ClassicBindingRoot { DataContext, ElementName, Other }

    /// <summary>Classifies how a classic {Binding} roots its path by inspecting its TOP-LEVEL arguments.</summary>
    private static ClassicBindingRoot ClassifyBindingSource(string text, int nameEnd, int braceIndex, out string? elementName)
    {
        elementName = null;

        int end = braceIndex + 1;
        int depth = 1;
        while (end < text.Length)
        {
            char c = text[end];
            if (c == '{')
            {
                depth++;
            }
            else if (c == '}')
            {
                depth--;
                if (depth == 0)
                {
                    break;
                }
            }
            else if (c is '"' or '\'' or '\n')
            {
                break;
            }

            end++;
        }

        var root = ClassicBindingRoot.DataContext;
        int argStart = nameEnd;
        int d = 0;
        for (int j = nameEnd; j <= end; j++)
        {
            bool boundary = j >= end || j >= text.Length;
            char c = boundary ? ',' : text[j];
            if (!boundary && c is '(' or '{' or '[')
            {
                d++;
            }
            else if (!boundary && c is ')' or '}' or ']')
            {
                if (d > 0)
                {
                    d--;
                }
            }
            else if (c == ',' && d == 0)
            {
                var (name, val) = SplitMarkupArg(text, argStart, j);
                if (name is "Source" or "RelativeSource")
                {
                    return ClassicBindingRoot.Other; // a hard redirect wins immediately
                }

                if (name == "ElementName")
                {
                    root = ClassicBindingRoot.ElementName;
                    elementName = val;
                }

                argStart = j + 1;
            }

            if (boundary)
            {
                break;
            }
        }

        return root;
    }

    // --- Symbol helpers ---------------------------------------------------------------------------

}
