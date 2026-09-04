using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Linq;
using Microsoft.CodeAnalysis;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Workspace;
using WinUiXaml.Xaml;
using Diagnostic = WinUiXaml.LanguageServer.Lsp.Diagnostic;

namespace WinUiXaml.LanguageServer;

/// <summary>Validation of {x:Bind} member paths, including static roots, casts, and attached-property steps.</summary>
internal static partial class XamlValidator
{
    /// <summary>Reports an {x:Bind} path segment that is not a member of the type produced by the segment before it (the first segment is checked against bindRoot</summary>
    private static void ValidateBindPath(
        XamlAttribute attribute,
        INamedTypeSymbol bindRoot,
        INamedTypeSymbol? pageClass,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        if (!XamlSemanticFacts.IsXBind(attribute, scope) ||
            attribute.Value?.MarkupExtension is not { IsClosed: true } ext)
        {
            return;
        }

        var pathArg = ext.Arguments.FirstOrDefault(
            a => (!a.IsNamed && a.NestedExtension is null && a.Value is not null) ||
                 (a.IsNamed && a.Name?.LocalName == "Path" && a.Value is not null));
        if (pathArg?.Value is not { } path || pathArg.ValueSpan is not { } valueSpan)
        {
            return;
        }

        int unsupportedNegation = FindUnquotedCharacter(path, '!');
        if (unsupportedNegation >= 0)
        {
            diagnostics.Add(Diag(
                doc,
                new TextSpan(
                    valueSpan.Start + unsupportedNegation,
                    valueSpan.Start + unsupportedNegation + 1),
                SeverityError,
                InvalidBindSyntaxCode,
                "The '!' operator is not supported in x:Bind expressions. Use an inverted property or a Boolean helper function."));
            return;
        }

        bool allowRootNonPublic =
            pageClass is not null &&
            SymbolEqualityComparer.Default.Equals(bindRoot, pageClass);

        if (ValidateLeadingAttachedBindPath(
                path, valueSpan, pageClass, scope, typeSystem, doc, diagnostics))
        {
            return;
        }

        // Validate cast paths only when the target type is unambiguous.
        if (TryGetCastPath(path, out var castTypeName, out var castMembers, out var castMemberOffset))
        {
            if (ResolveTypeName(castTypeName, scope, typeSystem) is { } castType)
            {
                ValidateMemberChain(
                    castType, castMembers.Split('.'), castMemberOffset, valueSpan,
                    skipFirst: false, includeRootNonPublic: false, pageClass,
                    typeSystem, doc, diagnostics);
            }

            return; // a cast path is fully handled here (reported or safely skipped) — never falls through.
        }

        int staticBodyOffset = 0;
        int negationCount = 0;
        while (staticBodyOffset < path.Length &&
               (path[staticBodyOffset] == '!' || char.IsWhiteSpace(path[staticBodyOffset])))
        {
            if (path[staticBodyOffset] == '!')
            {
                negationCount++;
            }
            staticBodyOffset++;
        }
        string staticCandidate = path.Substring(staticBodyOffset);
        if (TryGetStaticBindRoot(
                staticCandidate,
                scope,
                typeSystem,
                out var staticType,
                out var staticMembers,
                out var staticOffset))
        {
            if (staticMembers.IndexOf('(') >= 0)
            {
                string functionPath = new string('!', negationCount) + staticMembers;
                ValidateBindFunctionArgs(
                    functionPath,
                    new TextSpan(
                        valueSpan.Start + staticBodyOffset + staticOffset - negationCount,
                        valueSpan.End),
                    attribute,
                    scope,
                    bindRoot,
                    pageClass,
                    allowRootNonPublic,
                    typeSystem,
                    doc,
                    diagnostics,
                    staticType);
            }
            else
            {
                ValidateStaticMemberChain(
                    staticType,
                    staticMembers,
                    staticOffset,
                    valueSpan,
                    pageClass,
                    typeSystem,
                    doc,
                    diagnostics);
            }
            return;
        }

        if (!TryFirstBindSegment(path, out var segment))
        {
            return;
        }

        if (typeSystem.GetBindableMembers(
                bindRoot,
                includeRootNonPublic: allowRootNonPublic,
                accessWithin: pageClass)
            .Any(m => string.Equals(m.Name, segment, System.StringComparison.Ordinal)))
        {
            // The first segment is valid — validate any remaining dotted segments too, so a bad non-first member (GreetingText.Nope, Items[0].Nope) is caught rather than silently accepted.
            ValidateBindPathTail(
                path, valueSpan, bindRoot, pageClass, allowRootNonPublic,
                typeSystem, doc, diagnostics);

            // For a function binding (Method(arg, arg)) each argument is itself a path bound against the root, so a bogus argument member is flagged the same as a bogus root path.
            ValidateBindFunctionArgs(
                path, valueSpan, attribute, scope, bindRoot, pageClass, allowRootNonPublic,
                typeSystem, doc, diagnostics);
            return;
        }

        if (FindInaccessibleMember(bindRoot, segment, pageClass, typeSystem) is not null)
        {
            diagnostics.Add(Diag(doc, valueSpan, SeverityError, InaccessibleBindMemberCode,
                $"'{segment}' is not accessible to x:Bind."));
            return;
        }

        if (XamlSemanticFacts.ResolveNamedElementTypeInScope(
                doc,
                attribute.Parent,
                segment,
                typeSystem) is { } namedElementType)
        {
            int separator = path.IndexOf('.');
            if (separator >= 0 && path.IndexOf('(', separator + 1) >= 0)
            {
                int receiverStart = path.IndexOf(segment, StringComparison.Ordinal);
                string prefix = receiverStart > 0 ? path.Substring(0, receiverStart) : string.Empty;
                string functionPath = prefix + path.Substring(separator + 1);
                ValidateBindFunctionArgs(
                    functionPath,
                    new TextSpan(
                        valueSpan.Start + separator + 1 - prefix.Length,
                        valueSpan.End),
                    attribute,
                    scope,
                    bindRoot,
                    pageClass,
                    allowRootNonPublic,
                    typeSystem,
                    doc,
                    diagnostics,
                    functionReceiverRoot: namedElementType);
            }
            else
            {
                ValidateNamedElementBindPathTail(
                    path,
                    valueSpan,
                    namedElementType,
                    pageClass,
                    typeSystem,
                    doc,
                    diagnostics);
            }
            return;
        }

        diagnostics.Add(Diag(doc, valueSpan, SeverityWarning, UnknownBindMemberCode,
            $"'{segment}' is not a member of '{bindRoot.Name}' bound by x:Bind.",
            SuggestData(
                segment,
                typeSystem.GetBindableMembers(
                        bindRoot,
                        includeRootNonPublic: allowRootNonPublic,
                        accessWithin: pageClass)
                    .Select(m => m.Name))));
    }

    private static bool TryGetStaticBindRoot(
        string path, XamlNamespaceScope scope, XamlTypeSystem typeSystem,
        [NotNullWhen(true)] out INamedTypeSymbol? type,
        out string memberChain, out int memberOffset)
    {
        type = null;
        memberChain = string.Empty;
        memberOffset = 0;
        var trimmed = path.TrimStart();
        int leading = path.Length - trimmed.Length;
        int dot = trimmed.IndexOf('.');
        if (dot <= 0 || trimmed[..dot].IndexOf(':') <= 0 ||
            ResolveTypeName(trimmed[..dot], scope, typeSystem) is not { } resolved)
        {
            return false;
        }

        type = resolved;
        memberChain = trimmed[(dot + 1)..];
        memberOffset = leading + dot + 1;
        return true;
    }

    private static void ValidateStaticMemberChain(
        INamedTypeSymbol type, string chain, int chainOffset, TextSpan valueSpan,
        INamedTypeSymbol? accessWithin,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        ITypeSymbol current = type;
        int offset = chainOffset;
        bool first = true;
        foreach (var segment in chain.Split('.'))
        {
            var trimmed = segment.Trim();
            int bracket = trimmed.IndexOf('[');
            var name = bracket < 0 ? trimmed : trimmed[..bracket];
            ITypeSymbol? next;
            if (first)
            {
                var symbol = typeSystem.GetBindableStaticMembers(current, accessWithin)
                    .FirstOrDefault(member =>
                        member.Name == name &&
                        member is IPropertySymbol or IFieldSymbol);
                next = symbol is null ? null : GetSymbolType(symbol);
                for (int i = bracket; next is not null && bracket >= 0 && i < trimmed.Length; i++)
                {
                    if (trimmed[i] == '[')
                    {
                        next = XamlTypeSystem.GetCollectionElementType(next);
                    }
                }
            }
            else
            {
                next = CompletionProvider.ResolveBindSegmentType(
                    typeSystem, current, trimmed, false, accessWithin);
            }

            if (next is null)
            {
                diagnostics.Add(Diag(doc,
                    new TextSpan(valueSpan.Start + offset, valueSpan.Start + offset + name.Length),
                    SeverityWarning, UnknownBindMemberCode,
                    $"'{name}' is not a bindable member of '{current.Name}'."));
                return;
            }

            current = next;
            offset += segment.Length + 1;
            first = false;
        }
    }

    private static ISymbol? FindInaccessibleMember(
        ITypeSymbol type,
        string name,
        ISymbol? accessWithin,
        XamlTypeSystem typeSystem)
    {
        for (var current = type as INamedTypeSymbol; current is not null; current = current.BaseType)
        {
            var member = current.GetMembers(name).FirstOrDefault(candidate =>
            {
                var accessibilitySymbol = candidate is IPropertySymbol { GetMethod: { } getter }
                    ? getter
                    : candidate;
                return !candidate.IsStatic &&
                       (accessWithin is null ||
                        !typeSystem.IsSymbolAccessibleWithin(accessibilitySymbol, accessWithin, type)) &&
                       candidate is IPropertySymbol or IFieldSymbol or IMethodSymbol;
            });
            if (member is not null)
            {
                return member;
            }
        }

        return null;
    }

    private static ITypeSymbol? GetSymbolType(ISymbol symbol) => symbol switch
    {
        IPropertySymbol property => property.Type,
        IFieldSymbol field => field.Type,
        IMethodSymbol method => method.ReturnType,
        _ => null,
    };

    /// <summary>Validates a leading attached-property binding step.</summary>
    private static bool ValidateLeadingAttachedBindPath(
        string path,
        TextSpan valueSpan,
        INamedTypeSymbol? accessWithin,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        int open = 0;
        while (open < path.Length && (path[open] == '!' || char.IsWhiteSpace(path[open])))
        {
            open++;
        }

        if (open >= path.Length || path[open] != '(')
        {
            return false;
        }

        int close = path.IndexOf(')', open + 1);
        if (close < 0)
        {
            return true;
        }

        var inner = path.Substring(open + 1, close - open - 1).Trim();
        int dot = inner.LastIndexOf('.');
        if (dot <= 0 || dot >= inner.Length - 1)
        {
            return false; // a cast, not an attached-property step
        }

        var ownerName = inner.Substring(0, dot).Trim();
        var memberName = inner.Substring(dot + 1).Trim();
        if (!IsIdentifier(memberName))
        {
            return true;
        }

        var owner = ResolveTypeName(ownerName, scope, typeSystem);
        if (owner is null)
        {
            return true;
        }

        var memberType = typeSystem.GetAttachedMemberType(owner, memberName);
        if (memberType is null)
        {
            int memberOffset = path.IndexOf(memberName, open + 1, System.StringComparison.Ordinal);
            var memberSpan = memberOffset >= 0
                ? new TextSpan(valueSpan.Start + memberOffset, valueSpan.Start + memberOffset + memberName.Length)
                : valueSpan;
            diagnostics.Add(Diag(doc, memberSpan, SeverityWarning, UnknownAttachedPropertyCode,
                $"'{memberName}' is not an attached property of '{owner.Name}'.",
                SuggestData(memberName, typeSystem.GetAttachedProperties(owner).Select(m => m.Name))));
            return true;
        }

        int tailStart = close + 1;
        while (tailStart < path.Length && char.IsWhiteSpace(path[tailStart]))
        {
            tailStart++;
        }

        if (tailStart >= path.Length)
        {
            return true;
        }

        if (path[tailStart] != '.')
        {
            return true;
        }

        tailStart++;
        while (tailStart < path.Length && char.IsWhiteSpace(path[tailStart]))
        {
            tailStart++;
        }

        if (tailStart < path.Length)
        {
            ValidateMemberChain(
                memberType,
                path.Substring(tailStart).Split('.'),
                tailStart,
                valueSpan,
                skipFirst: false,
                includeRootNonPublic: false,
                accessWithin,
                typeSystem,
                doc,
                diagnostics);
        }

        return true;
    }

    /// <summary>Walks the dotted segments of an {x:Bind} path after the first (which the caller has already validated)</summary>
    private static void ValidateBindPathTail(
        string path,
        TextSpan valueSpan,
        INamedTypeSymbol bindRoot,
        INamedTypeSymbol? accessWithin,
        bool includeRootNonPublic,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        // Skip the leading '!' negation run (and whitespace), keeping the offset so segment spans stay aligned with the document text.
        int start = 0;
        while (start < path.Length && (path[start] == '!' || char.IsWhiteSpace(path[start])))
        {
            start++;
        }

        var body = path.Substring(start);

        // A function binding (Method(...)) or a cast ((ns:Type)Member) is not a plain member chain the tail walk can verify — the first-segment check already covered what it safely can.
        if (body.IndexOf('(') >= 0)
        {
            return;
        }

        var segments = body.Split('.');
        if (segments.Length < 2)
        {
            return; // only one segment — already validated by the caller.
        }

        ValidateMemberChain(
            bindRoot,
            segments,
            start,
            valueSpan,
            skipFirst: true,
            includeRootNonPublic,
            accessWithin,
            typeSystem,
            doc,
            diagnostics);
    }

    private static void ValidateNamedElementBindPathTail(
        string path,
        TextSpan valueSpan,
        INamedTypeSymbol namedElementType,
        INamedTypeSymbol? accessWithin,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        int start = 0;
        while (start < path.Length && (path[start] == '!' || char.IsWhiteSpace(path[start])))
        {
            start++;
        }

        var body = path.Substring(start);
        if (body.IndexOf('(') >= 0)
        {
            return;
        }

        var segments = body.Split('.');
        if (segments.Length < 2)
        {
            return;
        }

        int tailStart = start + segments[0].Length + 1;
        ValidateMemberChain(
            namedElementType,
            segments.Skip(1).ToArray(),
            tailStart,
            valueSpan,
            skipFirst: false,
            includeRootNonPublic: false,
            accessWithin,
            typeSystem,
            doc,
            diagnostics);
    }

    /// <summary>Walks a dotted member chain against a starting type, flagging the FIRST segment that is not a member of the type produced by the preceding segment.</summary>
    private static void ValidateMemberChain(
        ITypeSymbol rootType,
        string[] segments,
        int chainStart,
        TextSpan valueSpan,
        bool skipFirst,
        bool includeRootNonPublic,
        ISymbol? accessWithin,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        ITypeSymbol current = rootType;
        bool atRoot = true;
        int segStart = chainStart;

        for (int i = 0; i < segments.Length; i++)
        {
            var seg = segments[i];

            // The member name is the segment without any trailing indexer (Items[0] -> Items).
            int bracket = seg.IndexOf('[');
            var baseName = (bracket < 0 ? seg : seg.Substring(0, bracket)).Trim();

            if (baseName.Length == 0 || !IsIdentifier(baseName))
            {
                return; // an empty or non-identifier segment (nested cast/call, malformed) — stay silent.
            }

            var member = typeSystem.GetBindableMembers(
                    current,
                    includeRootNonPublic: atRoot && includeRootNonPublic,
                    accessWithin)
                .FirstOrDefault(m => string.Equals(m.Name, baseName, System.StringComparison.Ordinal));

            if (member is null)
            {
                if (skipFirst && i == 0)
                {
                    return; // the first segment is the caller's responsibility.
                }

                // Underline just the offending member name within the path value.
                int lead = seg.Length - seg.TrimStart().Length;
                int badStart = valueSpan.Start + segStart + lead;
                int badEnd = badStart + baseName.Length;
                var badSpan = badEnd <= valueSpan.End ? new TextSpan(badStart, badEnd) : valueSpan;
                if (FindInaccessibleMember(
                        current, baseName, accessWithin, typeSystem) is not null)
                {
                    diagnostics.Add(Diag(doc, badSpan, SeverityError, InaccessibleBindMemberCode,
                        $"'{baseName}' is not accessible to x:Bind."));
                }
                else
                {
                    diagnostics.Add(Diag(doc, badSpan, SeverityWarning, UnknownBindMemberCode,
                        $"'{baseName}' is not a member of '{current.Name}' bound by x:Bind.",
                        SuggestData(
                            baseName,
                            typeSystem.GetBindableMembers(
                                    current,
                                    includeRootNonPublic: atRoot,
                                    accessWithin)
                                .Select(m => m.Name))));
                }
                return;
            }

            var next = CompletionProvider.ResolveBindSegmentType(
                typeSystem, current, seg, atRoot, accessWithin);
            if (next is null)
            {
                return; // the chain leads to a type we cannot model further — stop without reporting.
            }

            current = next;
            atRoot = false;
            segStart += seg.Length + 1; // advance past the segment and its trailing '.'
        }
    }

    /// <summary>Splits an unambiguous leading x:Bind cast from its member path.</summary>
    private static bool TryGetCastPath(string path, out string castType, out string memberChain, out int memberOffset)
    {
        castType = string.Empty;
        memberChain = string.Empty;
        memberOffset = 0;

        int i = 0;
        while (i < path.Length && (path[i] == '!' || char.IsWhiteSpace(path[i])))
        {
            i++;
        }

        if (i >= path.Length || path[i] != '(')
        {
            return false;
        }

        int open = i;
        int close = path.IndexOf(')', open + 1);
        if (close < 0)
        {
            return false; // unterminated cast — leave it to the tolerant parser.
        }

        var inner = path.Substring(open + 1, close - open - 1).Trim();
        if (inner.Length == 0 || inner.IndexOf('.') >= 0)
        {
            return false; // empty, or an attached-property step (Owner.Member) — not a cast.
        }

        castType = inner;
        memberChain = path.Substring(close + 1);
        memberOffset = close + 1;
        return true;
    }
}
