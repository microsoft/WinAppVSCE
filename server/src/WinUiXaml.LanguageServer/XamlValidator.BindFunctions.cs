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

/// <summary>Validation of {x:Bind} function calls: parsing, overload resolution, and argument checking.</summary>
internal static partial class XamlValidator
{
    /// <summary>Validates unambiguous member paths in x:Bind function arguments.</summary>
    private static void ValidateBindFunctionArgs(
        string path,
        TextSpan valueSpan,
        XamlAttribute attribute,
        XamlNamespaceScope scope,
        INamedTypeSymbol bindRoot,
        INamedTypeSymbol? accessWithin,
        bool includeRootNonPublic,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics,
        INamedTypeSymbol? staticReceiverType = null,
        INamedTypeSymbol? functionReceiverRoot = null)
    {
        if (!TryParseBindFunctionCall(path, out var parsed))
        {
            return; // no method name before '(' — a cast or non-function path, not our concern here.
        }

        var functionPath = parsed.FunctionPath;
        var functionName = functionPath;
        int receiverSeparator = functionPath.LastIndexOf('.');
        if (receiverSeparator >= 0)
        {
            var receiverSegments = functionPath.Substring(0, receiverSeparator).Split('.');
            if (staticReceiverType is null)
            {
                ValidateMemberChain(
                    functionReceiverRoot ?? bindRoot,
                    receiverSegments,
                    parsed.Start,
                    valueSpan,
                    skipFirst: false,
                    includeRootNonPublic,
                    accessWithin,
                    typeSystem,
                    doc,
                    diagnostics);
            }
        }

        if (!TryResolveBindFunctionReceiver(
                functionPath,
                staticReceiverType,
                functionReceiverRoot ?? bindRoot,
                accessWithin,
                typeSystem,
                out var receiverType,
                out functionName,
                out var includeReceiverNonPublic,
                out var callIsStatic))
        {
            return;
        }

        var overloads = GetBindFunctionOverloads(
                receiverType,
                functionName,
                callIsStatic,
                includeReceiverNonPublic,
                accessWithin,
                typeSystem)
            .ToList();
        if (overloads.Count == 0)
        {
            var functionSpan = new TextSpan(
                valueSpan.Start + parsed.Start,
                valueSpan.Start + parsed.Open);
            diagnostics.Add(Diag(doc, functionSpan, SeverityWarning, InvalidBindFunctionCode,
                $"'{functionName}' is not a callable method on '{receiverType.Name}'."));
        }
        else if (!overloads.Any(m => AcceptsArgumentCount(m, parsed.ArgumentRanges.Count)))
        {
            var functionSpan = new TextSpan(
                valueSpan.Start + parsed.Start,
                valueSpan.Start + parsed.Open);
            diagnostics.Add(Diag(doc, functionSpan, SeverityWarning, InvalidBindFunctionCode,
                $"No overload of '{functionName}' accepts {parsed.ArgumentRanges.Count} argument(s)."));
        }
        else
        {
            var argumentTypes = parsed.ArgumentRanges
                .Select(range => TryResolveBindFunctionArgumentType(
                    path,
                    range,
                    attribute,
                    bindRoot,
                    accessWithin,
                    scope,
                    typeSystem,
                    doc,
                    out var argumentType)
                        ? argumentType
                        : null)
                .ToArray();
            var applicable = SelectBestApplicableBindFunctions(
                overloads,
                argumentTypes,
                typeSystem);
            if (argumentTypes.All(type => type is not null) && applicable.Length == 0)
            {
                var functionSpan = new TextSpan(
                    valueSpan.Start + parsed.Start,
                    valueSpan.Start + parsed.Close + 1);
                var typeNames = string.Join(
                    ", ",
                    argumentTypes.Select(type =>
                        $"'{type!.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)}'"));
                diagnostics.Add(Diag(
                    doc,
                    functionSpan,
                    SeverityError,
                    InvalidBindFunctionCode,
                    $"No overload of '{functionName}' accepts argument type(s) {typeNames}."));
            }
            else if (parsed.IsNegated &&
                     applicable.Length > 0 &&
                     applicable.All(method => !IsBooleanType(method.ReturnType)))
            {
                var functionSpan = new TextSpan(
                    valueSpan.Start + parsed.Start,
                    valueSpan.Start + parsed.Close + 1);
                diagnostics.Add(Diag(
                    doc,
                    functionSpan,
                    SeverityError,
                    InvalidBindFunctionCode,
                    $"The result of '{functionName}' cannot be negated because it is not Boolean."));
            }
        }

        foreach (var (argumentStart, argumentEnd) in parsed.ArgumentRanges)
        {
            ValidateBindFunctionArg(
                path, argumentStart, argumentEnd, valueSpan, bindRoot,
                attribute, accessWithin, includeRootNonPublic, typeSystem, doc, diagnostics);
        }
    }

    private static int FindUnquotedCharacter(string text, char target)
    {
        char quote = '\0';
        for (int index = 0; index < text.Length; index++)
        {
            char current = text[index];
            if (quote != '\0')
            {
                if (current is '\\' or '^')
                {
                    index++;
                }
                else if (current == quote)
                {
                    quote = '\0';
                }
                continue;
            }

            if (current is '\'' or '"')
            {
                quote = current;
            }
            else if (current == target)
            {
                return index;
            }
        }

        return -1;
    }

    private sealed record ParsedBindFunctionCall(
        int Start,
        int Open,
        int Close,
        bool IsNegated,
        string FunctionPath,
        IReadOnlyList<(int Start, int End)> ArgumentRanges);

    private static bool TryParseBindFunctionCall(
        string path,
        [NotNullWhen(true)] out ParsedBindFunctionCall? parsed)
    {
        parsed = null;
        int start = 0;
        bool isNegated = false;
        while (start < path.Length && (path[start] == '!' || char.IsWhiteSpace(path[start])))
        {
            isNegated |= path[start] == '!';
            start++;
        }

        int open = path.IndexOf('(', start);
        if (open <= start)
        {
            return false;
        }

        var argumentRanges = new List<(int Start, int End)>();
        int argumentStart = open + 1;
        int parenthesisDepth = 1;
        int bracketDepth = 0;
        char quote = '\0';
        for (int index = open + 1; index < path.Length; index++)
        {
            char current = path[index];
            if (quote != '\0')
            {
                if (current == '\\')
                {
                    index++;
                }
                else if (current == quote)
                {
                    quote = '\0';
                }
                continue;
            }

            if (current is '\'' or '"')
            {
                quote = current;
            }
            else if (current == '[')
            {
                bracketDepth++;
            }
            else if (current == ']' && bracketDepth > 0)
            {
                bracketDepth--;
            }
            else if (current == '(')
            {
                parenthesisDepth++;
            }
            else if (current == ')')
            {
                parenthesisDepth--;
                if (parenthesisDepth == 0)
                {
                    if (path.AsSpan(index + 1).Trim().Length != 0)
                    {
                        return false;
                    }

                    if (ContainsNonWhitespace(path, argumentStart, index) ||
                        argumentRanges.Count > 0)
                    {
                        argumentRanges.Add((argumentStart, index));
                    }

                    parsed = new ParsedBindFunctionCall(
                        start,
                        open,
                        index,
                        isNegated,
                        path.Substring(start, open - start).Trim(),
                        argumentRanges);
                    return true;
                }
            }
            else if (current == ',' && parenthesisDepth == 1 && bracketDepth == 0)
            {
                argumentRanges.Add((argumentStart, index));
                argumentStart = index + 1;
            }
        }

        return false;
    }

    private static bool TryResolveBindFunctionReceiver(
        string functionPath,
        INamedTypeSymbol? staticReceiverType,
        INamedTypeSymbol bindRoot,
        ISymbol? accessWithin,
        XamlTypeSystem typeSystem,
        [NotNullWhen(true)] out ITypeSymbol? receiverType,
        out string functionName,
        out bool includeReceiverNonPublic,
        out bool callIsStatic)
    {
        receiverType = staticReceiverType ?? bindRoot;
        functionName = functionPath;
        includeReceiverNonPublic =
            staticReceiverType is null &&
            accessWithin is not null &&
            SymbolEqualityComparer.Default.Equals(bindRoot, accessWithin);
        bool atStaticReceiverRoot = staticReceiverType is not null;
        int receiverSeparator = functionPath.LastIndexOf('.');
        if (receiverSeparator >= 0)
        {
            foreach (var receiverSegment in functionPath.Substring(0, receiverSeparator).Split('.'))
            {
                var next = atStaticReceiverRoot
                    ? CompletionProvider.ResolveStaticBindSegmentType(
                        typeSystem, receiverType, receiverSegment, accessWithin)
                    : CompletionProvider.ResolveBindSegmentType(
                        typeSystem,
                        receiverType,
                        receiverSegment,
                        includeReceiverNonPublic,
                        accessWithin);
                if (next is null)
                {
                    callIsStatic = false;
                    return false;
                }

                receiverType = next;
                includeReceiverNonPublic = false;
                atStaticReceiverRoot = false;
            }

            functionName = functionPath.Substring(receiverSeparator + 1);
        }

        callIsStatic = staticReceiverType is not null && receiverSeparator < 0;
        return true;
    }

    private static IEnumerable<IMethodSymbol> GetBindFunctionOverloads(
        ITypeSymbol receiverType,
        string functionName,
        bool callIsStatic,
        bool includeReceiverNonPublic,
        ISymbol? accessWithin,
        XamlTypeSystem typeSystem) =>
        (!callIsStatic
            ? typeSystem.GetBindableMethods(
                receiverType,
                includeReceiverNonPublic,
                accessWithin)
            : typeSystem.GetBindableStaticMembers(receiverType, accessWithin)
                .OfType<IMethodSymbol>())
        .Where(method => string.Equals(method.Name, functionName, StringComparison.Ordinal));

    private static bool IsApplicableBindFunction(
        IMethodSymbol method,
        IReadOnlyList<ITypeSymbol?> argumentTypes,
        XamlTypeSystem typeSystem)
    {
        if (!AcceptsArgumentCount(method, argumentTypes.Count))
        {
            return false;
        }

        for (int index = 0; index < argumentTypes.Count; index++)
        {
            if (argumentTypes[index] is not { } argumentType)
            {
                continue;
            }

            ITypeSymbol parameterType = GetBindFunctionParameterType(method, index);
            if (!IsImplicitlyAssignable(argumentType, parameterType, typeSystem))
            {
                return false;
            }
        }

        return true;
    }

    private static IMethodSymbol[] SelectBestApplicableBindFunctions(
        IEnumerable<IMethodSymbol> methods,
        IReadOnlyList<ITypeSymbol?> argumentTypes,
        XamlTypeSystem typeSystem)
    {
        var scored = methods
            .Where(method => IsApplicableBindFunction(method, argumentTypes, typeSystem))
            .Select(method => (
                Method: method,
                Score: argumentTypes.Select((argumentType, index) =>
                    argumentType is null
                        ? 0
                        : SymbolEqualityComparer.Default.Equals(
                            XamlValueConverter.UnwrapNullable(argumentType),
                            XamlValueConverter.UnwrapNullable(
                                GetBindFunctionParameterType(method, index)))
                            ? 2
                            : 1).Sum(),
                UsesExpandedParams: UsesExpandedParams(method, argumentTypes, typeSystem),
                OmittedOptionalCount: method.Parameters
                    .Skip(argumentTypes.Count)
                    .Count(parameter => parameter.IsOptional)))
            .ToArray();
        if (scored.Length == 0)
        {
            return Array.Empty<IMethodSymbol>();
        }

        int bestScore = scored.Max(candidate => candidate.Score);
        var best = scored.Where(candidate => candidate.Score == bestScore).ToArray();
        bool hasNormalForm = best.Any(candidate => !candidate.UsesExpandedParams);
        if (hasNormalForm)
        {
            best = best.Where(candidate => !candidate.UsesExpandedParams).ToArray();
        }

        int fewestOmitted = best.Min(candidate => candidate.OmittedOptionalCount);
        return best
            .Where(candidate => candidate.OmittedOptionalCount == fewestOmitted)
            .Select(candidate => candidate.Method)
            .ToArray();
    }

    private static bool UsesExpandedParams(
        IMethodSymbol method,
        IReadOnlyList<ITypeSymbol?> argumentTypes,
        XamlTypeSystem typeSystem)
    {
        if (method.Parameters.LastOrDefault() is not { IsParams: true } parameter)
        {
            return false;
        }

        if (argumentTypes.Count != method.Parameters.Length ||
            argumentTypes[^1] is not { } lastArgument)
        {
            return true;
        }

        return !IsImplicitlyAssignable(lastArgument, parameter.Type, typeSystem);
    }

    private static ITypeSymbol GetBindFunctionParameterType(IMethodSymbol method, int index)
    {
        var parameter = index < method.Parameters.Length
            ? method.Parameters[index]
            : method.Parameters[^1];
        return parameter.IsParams && parameter.Type is IArrayTypeSymbol array
            ? array.ElementType
            : parameter.Type;
    }

    private static bool IsBooleanType(ITypeSymbol type) =>
        XamlValueConverter.UnwrapNullable(type).SpecialType == SpecialType.System_Boolean;

    private static bool AcceptsArgumentCount(IMethodSymbol method, int argumentCount)
    {
        int required = method.Parameters.Count(p => !p.IsOptional && !p.IsParams);
        if (argumentCount < required)
        {
            return false;
        }

        return method.Parameters.Any(p => p.IsParams) || argumentCount <= method.Parameters.Length;
    }

    private static bool ContainsNonWhitespace(string value, int start, int end)
    {
        for (int i = start; i < end; i++)
        {
            if (!char.IsWhiteSpace(value[i]))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>Validates a single function-binding argument spanning <c>[from, to)</c> of <paramref name="path"/> when — and only when — it is a plain member path; anything else is skipped.</summary>
    private static void ValidateBindFunctionArg(
        string path,
        int from,
        int to,
        TextSpan valueSpan,
        INamedTypeSymbol bindRoot,
        XamlAttribute attribute,
        INamedTypeSymbol? accessWithin,
        bool includeRootNonPublic,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        int s = from;
        while (s < to && char.IsWhiteSpace(path[s]))
        {
            s++;
        }

        int e = to;
        while (e > s && char.IsWhiteSpace(path[e - 1]))
        {
            e--;
        }

        if (e <= s)
        {
            return; // empty argument.
        }

        var arg = path.Substring(s, e - s);

        // Only a plain member path is validatable. Skip literals (numbers/strings), prefixed names (x:Null / x:Static), nested markup ('{'), nested calls ('('), and anything with a ':' or quote.
        if (!(char.IsLetter(arg[0]) || arg[0] == '_'))
        {
            return;
        }

        foreach (char c in arg)
        {
            if (!(char.IsLetterOrDigit(c) || c == '_' || c == '.' || c == '[' || c == ']'))
            {
                return;
            }
        }

        int argAbsStart = valueSpan.Start + s;
        ITypeSymbol current = bindRoot;
        bool atRoot = true;
        int segStart = 0;
        var segments = arg.Split('.');
        int firstSegment = 0;
        if (XamlSemanticFacts.ResolveNamedElementTypeInScope(
                doc,
                attribute.Parent,
                segments[0],
                typeSystem) is { } namedElementType)
        {
            current = namedElementType;
            atRoot = false;
            firstSegment = 1;
            segStart = segments[0].Length + 1;
        }

        for (int i = firstSegment; i < segments.Length; i++)
        {
            var seg = segments[i];
            int bracket = seg.IndexOf('[');
            var baseName = (bracket < 0 ? seg : seg.Substring(0, bracket)).Trim();
            if (baseName.Length == 0 || !IsIdentifier(baseName))
            {
                return; // cannot verify (an unexpected shape) — stay silent.
            }

            var member = typeSystem.GetBindableMembers(
                    current,
                    includeRootNonPublic: atRoot && includeRootNonPublic,
                    accessWithin)
                .FirstOrDefault(m => string.Equals(m.Name, baseName, System.StringComparison.Ordinal));
            if (member is null)
            {
                int badStart = argAbsStart + segStart;
                int badEnd = badStart + baseName.Length;
                var badSpan = badEnd <= valueSpan.End ? new TextSpan(badStart, badEnd) : valueSpan;
                diagnostics.Add(Diag(doc, badSpan, SeverityWarning, UnknownBindMemberCode,
                    $"'{baseName}' is not a member of '{current.Name}' bound by x:Bind.",
                    SuggestData(
                        baseName,
                        typeSystem.GetBindableMembers(
                                current,
                                includeRootNonPublic: atRoot && includeRootNonPublic,
                                accessWithin)
                            .Select(m => m.Name))));
                return;
            }

            var next = CompletionProvider.ResolveBindSegmentType(
                typeSystem, current, seg, atRoot && includeRootNonPublic, accessWithin);
            if (next is null)
            {
                return;
            }

            current = next;
            atRoot = false;
            segStart += seg.Length + 1;
        }
    }

    /// <summary>Extracts the first identifier segment of an x:Bind path, or false when it is not a plain member name we can check (empty, a cast (ns:Type), or a function-arg reference).</summary>
    private static bool TryFirstBindSegment(string path, out string segment)
    {
        segment = string.Empty;
        var trimmed = path.Trim();

        // A leading '!' negates a boolean path ({x:Bind !IsEnabled}); validate the member after it.
        while (trimmed.StartsWith("!", System.StringComparison.Ordinal))
        {
            trimmed = trimmed.Substring(1).TrimStart();
        }

        int paren = trimmed.IndexOf('(');
        if (paren == 0)
        {
            return false; // leading '(' — a cast or a function whose first token is an argument path.
        }

        if (paren > 0)
        {
            trimmed = trimmed.Substring(0, paren); // function binding: check the method name before '('.
        }

        int dot = trimmed.IndexOf('.');
        var first = (dot >= 0 ? trimmed.Substring(0, dot) : trimmed).Trim();

        // Strip a trailing indexer (Items[0]) and validate the base member name; a non-identifier base (cast, empty) is skipped so only genuine unknown members are reported.
        int bracket = first.IndexOf('[');
        if (bracket >= 0)
        {
            first = first.Substring(0, bracket);
        }

        if (first.Length == 0 || !IsIdentifier(first))
        {
            return false;
        }

        segment = first;
        return true;
    }

    private static bool IsIdentifier(string text)
    {
        if (text.Length == 0 || !(char.IsLetter(text[0]) || text[0] == '_'))
        {
            return false;
        }

        foreach (var c in text)
        {
            if (!(char.IsLetterOrDigit(c) || c == '_'))
            {
                return false;
            }
        }

        return true;
    }
}
