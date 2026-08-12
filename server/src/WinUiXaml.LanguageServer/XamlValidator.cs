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

/// <summary>Reports semantic diagnostics against the project's XAML type system.</summary>
internal static class XamlValidator
{
    /// <summary>An undeclared xmlns prefix — certain, so reported as an error.</summary>
    public const string UndeclaredPrefixCode = "WXAML0001";

    /// <summary>A type not found in a known namespace — heuristic, so reported as a warning.</summary>
    public const string UnknownTypeCode = "WXAML0002";

    /// <summary>An attribute that is not a member of the element's type — heuristic, so a warning.</summary>
    public const string UnknownAttributeCode = "WXAML0003";

    /// <summary>A dotted attribute whose member is not an attached property of the owner — a warning.</summary>
    public const string UnknownAttachedPropertyCode = "WXAML0004";

    /// <summary>An <c>{x:Bind}</c> path whose first segment is not a member of the bind root — a warning.</summary>
    public const string UnknownBindMemberCode = "WXAML0005";

    /// <summary>A property element (<c>&lt;Grid.RowDefinitions&gt;</c>) whose member is not found on the owner type — a warning.</summary>
    public const string UnknownPropertyElementCode = "WXAML0006";

    /// <summary>Two elements share an <c>x:Name</c>/<c>Name</c> in the same XAML name scope — a compile error.</summary>
    public const string DuplicateNameCode = "WXAML0007";

    /// <summary>Two resources share an <c>x:Key</c> in the same <c>ResourceDictionary</c> — a compile error.</summary>
    public const string DuplicateKeyCode = "WXAML0008";

    /// <summary>A design-time directive names a type that cannot be resolved.</summary>
    public const string UnknownDirectiveTypeCode = "WXAML0009";

    /// <summary>An <c>mc:Ignorable</c> entry does not name a declared namespace prefix.</summary>
    public const string UnknownIgnorablePrefixCode = "WXAML0010";

    /// <summary>An <c>x:Bind</c> function has no overload accepting the supplied argument count.</summary>
    public const string InvalidBindFunctionCode = "WXAML0011";

    /// <summary>A literal attribute value cannot be converted to the property's primitive or enum type.</summary>
    public const string InvalidAttributeValueCode = "WXAML0012";

    private const int SeverityError = 1;
    private const int SeverityWarning = 2;
    private static readonly HashSet<string> ReservedPrefixes = new(System.StringComparer.Ordinal)
    {
        "xml", "xmlns",
    };

    public static List<Diagnostic> Validate(TextDocument doc, XamlTypeSystem typeSystem)
    {
        var diagnostics = new List<Diagnostic>();
        if (doc.Parsed.Root is { } root)
        {
            // Unresolved binding roots remain silent to avoid false positives.
            var pageClass = ResolvePageClass(root, typeSystem);
            Walk(root, doc, typeSystem, diagnostics, pageClass);

            ValidateUniqueNames(root, doc, diagnostics);
            ValidateUniqueResourceKeys(root, doc, diagnostics);
        }

        return diagnostics;
    }

    private static void Walk(
        XamlElement element, TextDocument doc, XamlTypeSystem typeSystem, List<Diagnostic> diagnostics, INamedTypeSymbol? bindRoot)
    {
        // An unresolved x:DataType disables binding checks for its subtree.
        var effectiveRoot = bindRoot;
        if (TryGetDirectiveValue(element, "DataType", out var dataTypeText))
        {
            effectiveRoot = ResolveTypeName(dataTypeText, element.NamespaceScope, typeSystem);
        }

        ValidateElement(element, doc, typeSystem, diagnostics, effectiveRoot);

        foreach (var child in element.Content)
        {
            if (child is XamlElement childElement)
            {
                Walk(childElement, doc, typeSystem, diagnostics, effectiveRoot);
            }
        }
    }

    private static void ValidateElement(
        XamlElement element, TextDocument doc, XamlTypeSystem typeSystem, List<Diagnostic> diagnostics, INamedTypeSymbol? bindRoot)
    {
        var scope = element.NamespaceScope;

        // {x:Bind} member checks are independent of whether the element type resolves.
        if (bindRoot is not null)
        {
            foreach (var attribute in element.Attributes)
            {
                ValidateBindPath(attribute, bindRoot, scope, typeSystem, doc, diagnostics);
            }
        }

        // Undeclared prefixes on attributes are independent of whether the element type resolves.
        foreach (var attribute in element.Attributes)
        {
            if (!attribute.IsNamespaceDeclaration)
            {
                ReportUndeclaredPrefix(attribute.Name, scope, doc, diagnostics);
            }
        }

        ValidateDirectives(element, scope, typeSystem, doc, diagnostics);

        var name = element.Name;
        if (name is null)
        {
            return;
        }

        // An undeclared element prefix supersedes any type/member check (the namespace is unresolvable).
        if (name.HasPrefix && !ReservedPrefixes.Contains(name.Prefix!) &&
            !scope.TryResolvePrefix(name.Prefix, out _))
        {
            diagnostics.Add(Diag(doc, name.PrefixSpan ?? name.Span, SeverityError, UndeclaredPrefixCode,
                $"The namespace prefix '{name.Prefix}' is not declared."));
            return;
        }

        // Out of scope: the x: language namespace (built-in primitives) and any namespace the type system cannot model (design-time, third-party). A property element carries no prefix, so it resolves through the default namespace like any other element here.
        if (!scope.TryResolvePrefix(name.Prefix, out var uri) ||
            uri == XamlTypeSystem.XamlLanguageNamespace ||
            !typeSystem.IsKnownNamespace(uri))
        {
            return;
        }

        // A property element (<Grid.RowDefinitions>) names a member of an owner type, not an element type, so it has no element-type/attribute surface — validate the member against the owner and stop.
        if (element.IsPropertyElement)
        {
            ValidatePropertyElement(name, uri, typeSystem, doc, diagnostics);
            return;
        }

        var elementType = typeSystem.ResolveType(uri, name.LocalName);
        if (elementType is null)
        {
            diagnostics.Add(Diag(doc, name.LocalNameSpan, SeverityWarning, UnknownTypeCode,
                $"The type '{name.LocalName}' was not found in the XAML namespace '{uri}'.",
                SuggestData(name.LocalName, typeSystem.GetAllTypes(uri).Select(t => t.Name))));
            return;
        }

        // The element type is known — verify its simple attributes name real members.
        foreach (var attribute in element.Attributes)
        {
            ValidateAttributeMember(attribute, elementType, scope, typeSystem, doc, diagnostics);
        }
    }

    private static void ValidateAttributeMember(
        XamlAttribute attribute,
        INamedTypeSymbol elementType,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        var name = attribute.Name;

        if (attribute.IsNamespaceDeclaration || name.LocalName.Length == 0)
        {
            return;
        }

        // Attached property (Owner.Member): validate the member against the OWNER type, not the element.
        if (name.IsDotted)
        {
            ValidateAttachedProperty(attribute, scope, typeSystem, doc, diagnostics);
            return;
        }

        // Language/foreign directives (x:, d:, mc:) need dedicated handling and are left for future work.
        if (name.HasPrefix)
        {
            return;
        }

        var member = typeSystem.FindMember(elementType, name.LocalName);
        if (member is null)
        {
            diagnostics.Add(Diag(doc, name.LocalNameSpan, SeverityWarning, UnknownAttributeCode,
                $"'{name.LocalName}' is not a property or event of '{elementType.Name}'.",
                SuggestData(name.LocalName, typeSystem.GetAttributeCandidateNames(elementType))));
            return;
        }

        if (member.Kind == XamlMemberKind.Property && member.Type is not null)
        {
            ValidateLiteralAttributeValue(attribute, member.Type, doc, diagnostics);
        }
    }

    private static void ValidateLiteralAttributeValue(
        XamlAttribute attribute,
        ITypeSymbol memberType,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        var value = attribute.Value;
        if (value is null ||
            value.IsMarkupExtension ||
            value.Quote is null)
        {
            return;
        }

        var targetType = UnwrapNullable(memberType);
        if (!IsKnownInvalidPrimitive(value.Text, targetType))
        {
            return;
        }

        diagnostics.Add(Diag(
            doc,
            value.InnerSpan,
            SeverityError,
            InvalidAttributeValueCode,
            $"'{value.Text}' is not a valid value for '{attribute.Name.FullName}' ({targetType.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)})."));
    }

    private static ITypeSymbol UnwrapNullable(ITypeSymbol type) =>
        type is INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } nullable
            ? nullable.TypeArguments[0]
            : type;

    private static bool IsKnownInvalidPrimitive(string text, ITypeSymbol type)
    {
        if (type.TypeKind == TypeKind.Enum)
        {
            if (long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out _))
            {
                return false;
            }

            var names = type.GetMembers().OfType<IFieldSymbol>()
                .Where(field => field.HasConstantValue)
                .Select(field => field.Name)
                .ToHashSet(System.StringComparer.Ordinal);
            return text.Split(',').Any(part => !names.Contains(part.Trim()));
        }

        return type.SpecialType switch
        {
            SpecialType.System_Boolean => !bool.TryParse(text, out _),
            SpecialType.System_Byte => !byte.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out _),
            SpecialType.System_SByte => !sbyte.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out _),
            SpecialType.System_Int16 => !short.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out _),
            SpecialType.System_UInt16 => !ushort.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out _),
            SpecialType.System_Int32 => !int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out _),
            SpecialType.System_UInt32 => !uint.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out _),
            SpecialType.System_Int64 => !long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out _),
            SpecialType.System_UInt64 => !ulong.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out _),
            SpecialType.System_Single => !IsValidFloatingPoint(text, single: true),
            SpecialType.System_Double => !IsValidFloatingPoint(text, single: false),
            SpecialType.System_Decimal => !decimal.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out _),
            SpecialType.System_Char => text.Length != 1,
            _ => false,
        };
    }

    private static bool IsValidFloatingPoint(string text, bool single) =>
        string.Equals(text, "Auto", System.StringComparison.OrdinalIgnoreCase) ||
        (single
            ? float.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out _)
            : double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out _));

    /// <summary>Validates an Owner.Member attached-property attribute: resolves the owner type through the attribute's namespace and checks it actually exposes the member.</summary>
    private static void ValidateAttachedProperty(
        XamlAttribute attribute,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        var name = attribute.Name;
        int dot = name.LocalName.LastIndexOf('.');
        if (dot <= 0 || dot >= name.LocalName.Length - 1)
        {
            return; // malformed dotted name — leave it to the parser
        }

        var ownerLocal = name.LocalName.Substring(0, dot);
        var memberName = name.LocalName.Substring(dot + 1);

        // Resolve the owner's namespace via the attribute prefix (null prefix = the default/presentation ns).
        if (!scope.TryResolvePrefix(name.Prefix, out var uri) ||
            uri == XamlTypeSystem.XamlLanguageNamespace ||
            !typeSystem.IsKnownNamespace(uri))
        {
            return;
        }

        var owner = typeSystem.ResolveType(uri, ownerLocal);
        if (owner is null)
        {
            return; // unknown owner: stay silent
        }

        var memberType = typeSystem.GetAttachedMemberType(owner, memberName);
        if (memberType is not null)
        {
            ValidateLiteralAttributeValue(attribute, memberType, doc, diagnostics);
            return;
        }

        // Underline just the member part, past "Owner.".
        var memberSpan = new TextSpan(name.LocalNameSpan.Start + dot + 1, name.LocalNameSpan.End);
        diagnostics.Add(Diag(doc, memberSpan, SeverityWarning, UnknownAttachedPropertyCode,
            $"'{memberName}' is not an attached property of '{owner.Name}'.",
            SuggestData(memberName, typeSystem.GetAttachedProperties(owner).Select(m => m.Name))));
    }

    /// <summary>Validates a property element (&lt;Grid.RowDefinitions&gt;): the dotted name references a member of an owner type</summary>
    private static void ValidatePropertyElement(
        XamlName name,
        string uri,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        int dot = name.LocalName.LastIndexOf('.');
        if (dot <= 0 || dot >= name.LocalName.Length - 1)
        {
            return; // malformed dotted name — leave it to the parser
        }

        var ownerLocal = name.LocalName.Substring(0, dot);
        var memberName = name.LocalName.Substring(dot + 1);

        var owner = typeSystem.ResolveType(uri, ownerLocal);
        if (owner is null)
        {
            // The enclosing namespace is already known/trusted (the caller gated on IsKnownNamespace), so a property element whose OWNER type does not resolve is a genuine unknown type
            var ownerSpan = new TextSpan(name.LocalNameSpan.Start, name.LocalNameSpan.Start + dot);
            diagnostics.Add(Diag(doc, ownerSpan, SeverityWarning, UnknownTypeCode,
                $"The type '{ownerLocal}' was not found in the XAML namespace '{uri}'.",
                SuggestData(ownerLocal, typeSystem.GetAllTypes(uri).Select(t => t.Name))));
            return;
        }

        if (typeSystem.HasProperty(owner, memberName) ||
            typeSystem.HasAttachedMember(owner, memberName))
        {
            return; // a real settable property / attached member used in element form
        }

        // Underline just the member part, past "Owner.". An event exists as a member but cannot be set through property-element syntax (it needs an attribute), so it gets a distinct message.
        var memberSpan = new TextSpan(name.LocalNameSpan.Start + dot + 1, name.LocalNameSpan.End);
        bool isEvent = typeSystem.HasMember(owner, memberName);
        var message = isEvent
            ? $"'{memberName}' is an event and cannot be set using property-element syntax."
            : $"The property '{memberName}' was not found in the type '{owner.Name}'.";
        var data = isEvent ? null : SuggestData(memberName, typeSystem.GetPropertyElementCandidateNames(owner));
        diagnostics.Add(Diag(doc, memberSpan, SeverityWarning, UnknownPropertyElementCode, message, data));
    }

    private static void ReportUndeclaredPrefix(
        XamlName name, XamlNamespaceScope scope, TextDocument doc, List<Diagnostic> diagnostics)
    {
        if (name.HasPrefix && !ReservedPrefixes.Contains(name.Prefix!) &&
            !scope.TryResolvePrefix(name.Prefix, out _))
        {
            diagnostics.Add(Diag(doc, name.PrefixSpan ?? name.Span, SeverityError, UndeclaredPrefixCode,
                $"The namespace prefix '{name.Prefix}' is not declared."));
        }
    }

    private static Diagnostic Diag(TextDocument doc, TextSpan span, int severity, string code, string message) =>
        new()
        {
            Range = doc.RangeOf(span),
            Severity = severity,
            Code = code,
            Message = message,
        };

    private static Diagnostic Diag(TextDocument doc, TextSpan span, int severity, string code, string message, DiagnosticData? data) =>
        new()
        {
            Range = doc.RangeOf(span),
            Severity = severity,
            Code = code,
            Message = message,
            Data = data,
        };

    /// <summary>Builds the DiagnosticData spelling-suggestion payload for a mistyped bad name against the valid candidates, or null when nothing is close enough</summary>
    private static DiagnosticData? SuggestData(string bad, IEnumerable<string> candidates)
    {
        var nearest = XamlSuggestions.Nearest(bad, candidates);
        return nearest.Count == 0 ? null : new DiagnosticData { Bad = bad, Suggestions = nearest.ToArray() };
    }

    /// <summary>Reports an {x:Bind} path segment that is not a member of the type produced by the segment before it (the first segment is checked against bindRoot</summary>
    private static void ValidateBindPath(
        XamlAttribute attribute,
        INamedTypeSymbol bindRoot,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        if (attribute.Value?.MarkupExtension is not { IsClosed: true } ext ||
            ext.Name is not { LocalName: "Bind" } extName ||
            !string.Equals(extName.Prefix, "x", System.StringComparison.Ordinal))
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

        if (ValidateLeadingAttachedBindPath(path, valueSpan, scope, typeSystem, doc, diagnostics))
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
                    skipFirst: false, typeSystem, doc, diagnostics);
            }

            return; // a cast path is fully handled here (reported or safely skipped) — never falls through.
        }

        if (!TryFirstBindSegment(path, out var segment))
        {
            return;
        }

        if (typeSystem.GetBindableMembers(bindRoot, includeRootNonPublic: true)
            .Any(m => string.Equals(m.Name, segment, System.StringComparison.Ordinal)))
        {
            // The first segment is valid — validate any remaining dotted segments too, so a bad non-first member (GreetingText.Nope, Items[0].Nope) is caught rather than silently accepted.
            ValidateBindPathTail(path, valueSpan, bindRoot, typeSystem, doc, diagnostics);

            // For a function binding (Method(arg, arg)) each argument is itself a path bound against the root, so a bogus argument member is flagged the same as a bogus root path.
            ValidateBindFunctionArgs(path, valueSpan, bindRoot, typeSystem, doc, diagnostics);
            return;
        }

        diagnostics.Add(Diag(doc, valueSpan, SeverityWarning, UnknownBindMemberCode,
            $"'{segment}' is not a member of '{bindRoot.Name}' bound by x:Bind.",
            SuggestData(segment, typeSystem.GetBindableMembers(bindRoot, includeRootNonPublic: true).Select(m => m.Name))));
    }

    /// <summary>Validates a leading attached-property binding step.</summary>
    private static bool ValidateLeadingAttachedBindPath(
        string path,
        TextSpan valueSpan,
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

        ValidateMemberChain(bindRoot, segments, start, valueSpan, skipFirst: true, typeSystem, doc, diagnostics);
    }

    /// <summary>Walks a dotted member chain against a starting type, flagging the FIRST segment that is not a member of the type produced by the preceding segment.</summary>
    private static void ValidateMemberChain(
        ITypeSymbol rootType,
        string[] segments,
        int chainStart,
        TextSpan valueSpan,
        bool skipFirst,
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

            var member = typeSystem.GetBindableMembers(current, includeRootNonPublic: atRoot)
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
                diagnostics.Add(Diag(doc, badSpan, SeverityWarning, UnknownBindMemberCode,
                    $"'{baseName}' is not a member of '{current.Name}' bound by x:Bind.",
                    SuggestData(baseName, typeSystem.GetBindableMembers(current, includeRootNonPublic: atRoot).Select(m => m.Name))));
                return;
            }

            var next = CompletionProvider.ResolveBindSegmentType(typeSystem, current, seg, atRoot);
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

    /// <summary>Validates unambiguous member paths in x:Bind function arguments.</summary>
    private static void ValidateBindFunctionArgs(
        string path,
        TextSpan valueSpan,
        INamedTypeSymbol bindRoot,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        int start = 0;
        while (start < path.Length && (path[start] == '!' || char.IsWhiteSpace(path[start])))
        {
            start++;
        }

        int open = path.IndexOf('(', start);
        if (open <= start)
        {
            return; // no method name before '(' — a cast or non-function path, not our concern here.
        }

        // Find the matching close paren for the argument list.
        int depth = 0;
        int close = -1;
        char closeScanQuote = '\0';
        for (int j = open; j < path.Length; j++)
        {
            char c = path[j];
            if (closeScanQuote != '\0')
            {
                if (c == '\\')
                {
                    j++;
                }
                else if (c == closeScanQuote)
                {
                    closeScanQuote = '\0';
                }

                continue;
            }

            if (c is '\'' or '"')
            {
                closeScanQuote = c;
            }
            else if (c == '(')
            {
                depth++;
            }
            else if (c == ')')
            {
                depth--;
                if (depth == 0)
                {
                    close = j;
                    break;
                }
            }
        }

        if (close < 0)
        {
            return; // unbalanced parentheses — stay silent.
        }

        // Split the argument list on top-level commas (nested parens/indexers do not split).
        var argumentRanges = new List<(int Start, int End)>();
        int argStart = open + 1;
        int d = 0;
        char quote = '\0';
        for (int j = open + 1; j < close; j++)
        {
            char c = path[j];
            if (quote != '\0')
            {
                if (c == '\\')
                {
                    j++;
                }
                else if (c == quote)
                {
                    quote = '\0';
                }

                continue;
            }

            if (c is '\'' or '"')
            {
                quote = c;
                continue;
            }

            if (c is '(' or '[')
            {
                d++;
            }
            else if (c is ')' or ']')
            {
                if (d > 0)
                {
                    d--;
                }
            }
            else if (c == ',' && d == 0)
            {
                argumentRanges.Add((argStart, j));
                argStart = j + 1;
            }
        }

        if (ContainsNonWhitespace(path, argStart, close) || argumentRanges.Count > 0)
        {
            argumentRanges.Add((argStart, close));
        }

        var functionPath = path.Substring(start, open - start).Trim();
        var functionName = functionPath;
        ITypeSymbol receiverType = bindRoot;
        bool includeReceiverNonPublic = true;
        int receiverSeparator = functionPath.LastIndexOf('.');
        if (receiverSeparator >= 0)
        {
            var receiverSegments = functionPath.Substring(0, receiverSeparator).Split('.');
            ValidateMemberChain(
                bindRoot,
                receiverSegments,
                start,
                valueSpan,
                skipFirst: false,
                typeSystem,
                doc,
                diagnostics);
            foreach (var receiverSegment in receiverSegments)
            {
                var next = CompletionProvider.ResolveBindSegmentType(
                    typeSystem,
                    receiverType,
                    receiverSegment,
                    includeReceiverNonPublic);
                if (next is null)
                {
                    return;
                }

                receiverType = next;
                includeReceiverNonPublic = false;
            }

            functionName = functionPath.Substring(receiverSeparator + 1);
        }

        var overloads = typeSystem.GetBindableMethods(receiverType, includeReceiverNonPublic)
            .Where(m => string.Equals(m.Name, functionName, System.StringComparison.Ordinal))
            .ToList();
        if (overloads.Count == 0)
        {
            var functionSpan = new TextSpan(valueSpan.Start + start, valueSpan.Start + open);
            diagnostics.Add(Diag(doc, functionSpan, SeverityWarning, InvalidBindFunctionCode,
                $"'{functionName}' is not a callable method on '{receiverType.Name}'."));
        }
        else if (!overloads.Any(m => AcceptsArgumentCount(m, argumentRanges.Count)))
        {
            var functionSpan = new TextSpan(valueSpan.Start + start, valueSpan.Start + open);
            diagnostics.Add(Diag(doc, functionSpan, SeverityWarning, InvalidBindFunctionCode,
                $"No overload of '{functionName}' accepts {argumentRanges.Count} argument(s)."));
        }

        foreach (var (argumentStart, argumentEnd) in argumentRanges)
        {
            ValidateBindFunctionArg(
                path, argumentStart, argumentEnd, valueSpan, bindRoot, typeSystem, doc, diagnostics);
        }
    }

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
        for (int i = 0; i < segments.Length; i++)
        {
            var seg = segments[i];
            int bracket = seg.IndexOf('[');
            var baseName = (bracket < 0 ? seg : seg.Substring(0, bracket)).Trim();
            if (baseName.Length == 0 || !IsIdentifier(baseName))
            {
                return; // cannot verify (an unexpected shape) — stay silent.
            }

            var member = typeSystem.GetBindableMembers(current, includeRootNonPublic: atRoot)
                .FirstOrDefault(m => string.Equals(m.Name, baseName, System.StringComparison.Ordinal));
            if (member is null)
            {
                int badStart = argAbsStart + segStart;
                int badEnd = badStart + baseName.Length;
                var badSpan = badEnd <= valueSpan.End ? new TextSpan(badStart, badEnd) : valueSpan;
                diagnostics.Add(Diag(doc, badSpan, SeverityWarning, UnknownBindMemberCode,
                    $"'{baseName}' is not a member of '{current.Name}' bound by x:Bind.",
                    SuggestData(baseName, typeSystem.GetBindableMembers(current, includeRootNonPublic: atRoot).Select(m => m.Name))));
                return;
            }

            var next = CompletionProvider.ResolveBindSegmentType(typeSystem, current, seg, atRoot);
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

    /// <summary>Resolves the page's x:Class code-behind type from the root element, or null.</summary>
    private static INamedTypeSymbol? ResolvePageClass(XamlElement root, XamlTypeSystem typeSystem) =>
        TryGetDirectiveValue(root, "Class", out var className)
            ? typeSystem.ResolveMetadataType(className.Trim())
            : null;

    /// <summary>Reads an <c>x:</c>-prefixed directive value.</summary>
    private static bool TryGetDirectiveValue(XamlElement element, string localName, out string value)
    {
        foreach (var attribute in element.Attributes)
        {
            if (string.Equals(attribute.Name.Prefix, "x", System.StringComparison.Ordinal) &&
                string.Equals(attribute.Name.LocalName, localName, System.StringComparison.Ordinal) &&
                attribute.Value is { Text.Length: > 0 } v)
            {
                value = v.Text;
                return true;
            }
        }

        value = string.Empty;
        return false;
    }

    /// <summary>Resolves a XAML type reference (<c>local:Page2</c> or a metadata name) to a symbol, or null.</summary>
    private static INamedTypeSymbol? ResolveTypeName(string text, XamlNamespaceScope scope, XamlTypeSystem typeSystem)
    {
        text = text.Trim();
        if (text.Length == 0)
        {
            return null;
        }

        int colon = text.IndexOf(':');
        if (colon >= 0)
        {
            var prefix = text.Substring(0, colon);
            var local = text.Substring(colon + 1);
            return scope.TryResolvePrefix(prefix, out var uri) ? typeSystem.ResolveType(uri, local) : null;
        }

        var byDefault = scope.TryResolvePrefix(null, out var defaultUri) ? typeSystem.ResolveType(defaultUri, text) : null;
        return byDefault ?? typeSystem.ResolveMetadataType(text);
    }

    private static void ValidateDirectives(
        XamlElement element,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        foreach (var attribute in element.Attributes)
        {
            if (attribute.IsNamespaceDeclaration ||
                !attribute.Name.HasPrefix ||
                !scope.TryResolvePrefix(attribute.Name.Prefix, out var attributeUri))
            {
                continue;
            }

            if (XamlNamespaces.IsDesignTime(attributeUri) &&
                attribute.Name.LocalName == "DataContext" &&
                attribute.Value is { } designValue &&
                designValue.MarkupExtension is { Name.LocalName: "DesignInstance" } extension &&
                extension.Name.HasPrefix &&
                scope.TryResolvePrefix(extension.Name.Prefix, out var extensionUri) &&
                XamlNamespaces.IsDesignTime(extensionUri))
            {
                var typeName = CompletionProvider.ParseDesignInstanceType(designValue.Text);
                if (!string.IsNullOrWhiteSpace(typeName) &&
                    ResolveTypeName(typeName, scope, typeSystem) is null)
                {
                    int relative = designValue.Text.IndexOf(typeName, System.StringComparison.Ordinal);
                    var span = relative >= 0
                        ? new TextSpan(designValue.InnerSpan.Start + relative, designValue.InnerSpan.Start + relative + typeName.Length)
                        : designValue.InnerSpan;
                    diagnostics.Add(Diag(doc, span, SeverityWarning, UnknownDirectiveTypeCode,
                        $"The design-time type '{typeName}' could not be resolved."));
                }
            }

            if (attributeUri == XamlNamespaces.MarkupCompatibility &&
                attribute.Name.LocalName == "Ignorable" &&
                attribute.Value is { MarkupExtension: null } ignorableValue)
            {
                ValidateIgnorablePrefixes(ignorableValue.Text, ignorableValue.InnerSpan, scope, doc, diagnostics);
            }
        }
    }

    private static void ValidateIgnorablePrefixes(
        string value,
        TextSpan valueSpan,
        XamlNamespaceScope scope,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        int i = 0;
        while (i < value.Length)
        {
            while (i < value.Length && char.IsWhiteSpace(value[i]))
            {
                i++;
            }

            int start = i;
            while (i < value.Length && !char.IsWhiteSpace(value[i]))
            {
                i++;
            }

            if (start < i)
            {
                var prefix = value.Substring(start, i - start);
                if (!ReservedPrefixes.Contains(prefix) && !scope.TryResolvePrefix(prefix, out _))
                {
                    diagnostics.Add(Diag(
                        doc,
                        new TextSpan(valueSpan.Start + start, valueSpan.Start + i),
                        SeverityWarning,
                        UnknownIgnorablePrefixCode,
                        $"The namespace prefix '{prefix}' listed in mc:Ignorable is not declared."));
                }
            }
        }
    }

    // --- Structural uniqueness: duplicate x:Name / x:Key --------------------------------------------

    /// <summary>Elements whose CONTENTS start a fresh XAML name scope, so an x:Name inside one does not collide with the same name outside it (each instantiated template has its own scope).</summary>
    private static readonly HashSet<string> NameScopeBoundaries = new(System.StringComparer.Ordinal)
    {
        "DataTemplate", "ControlTemplate", "ItemsPanelTemplate",
    };

    /// <summary>Reports duplicate x:Name/Name declarations within the same XAML name scope (WXAML0007, an error — the XAML compiler rejects it).</summary>
    private static void ValidateUniqueNames(XamlElement root, TextDocument doc, List<Diagnostic> diagnostics)
    {
        CollectScopedNames(root, new HashSet<string>(System.StringComparer.Ordinal), doc, diagnostics);
    }

    private static void CollectScopedNames(
        XamlElement element, HashSet<string> scope, TextDocument doc, List<Diagnostic> diagnostics)
    {
        // The element's own name belongs to the CURRENT scope (a template's own x:Name is outer-scoped).
        if (TryGetStaticValue(element, "x:Name", "Name", out var nameAttr, out var nameText) &&
            !scope.Add(nameText))
        {
            diagnostics.Add(Diag(doc, nameAttr.Value!.InnerSpan, SeverityError, DuplicateNameCode,
                $"The name '{nameText}' already exists in the current name scope."));
        }

        // A template re-scopes its subtree; every other element shares the current scope.
        var childScope = IsNameScopeBoundary(element)
            ? new HashSet<string>(System.StringComparer.Ordinal)
            : scope;

        foreach (var child in element.Content)
        {
            if (child is XamlElement childElement)
            {
                CollectScopedNames(childElement, childScope, doc, diagnostics);
            }
        }
    }

    private static bool IsNameScopeBoundary(XamlElement element) =>
        element.Name is { HasPrefix: false, IsDotted: false } n && NameScopeBoundaries.Contains(n.LocalName);

    /// <summary>Reports duplicate x:Key declarations within the same ResourceDictionary (WXAML0008, an error).</summary>
    private static void ValidateUniqueResourceKeys(XamlElement root, TextDocument doc, List<Diagnostic> diagnostics)
    {
        FindResourceScopes(root, doc, diagnostics);
    }

    /// <summary>Walks outside any dictionary looking for dictionary boundaries to validate as scopes.</summary>
    private static void FindResourceScopes(XamlElement element, TextDocument doc, List<Diagnostic> diagnostics)
    {
        if (IsResourceScopeBoundary(element))
        {
            ProcessDictionaryScope(element, doc, diagnostics);
            return;
        }

        foreach (var child in element.Content)
        {
            if (child is XamlElement childElement)
            {
                FindResourceScopes(childElement, doc, diagnostics);
            }
        }
    }

    /// <summary>Collects the keys of a single dictionary's direct entry children into one scope; nested dictionaries (explicit, or under merged/theme property elements) recurse as separate scopes.</summary>
    private static void ProcessDictionaryScope(XamlElement boundary, TextDocument doc, List<Diagnostic> diagnostics)
    {
        var scope = new HashSet<string>(System.StringComparer.Ordinal);
        foreach (var child in boundary.Content)
        {
            if (child is not XamlElement entry)
            {
                continue;
            }

            // An explicit nested <ResourceDictionary>.
            if (IsResourceScopeBoundary(entry))
            {
                ProcessDictionaryScope(entry, doc, diagnostics);
                continue;
            }

            // A structural property element (MergedDictionaries/ThemeDictionaries) is not a keyed entry; its subtree holds nested dictionaries, each their own scope.
            if (entry.IsPropertyElement)
            {
                FindResourceScopes(entry, doc, diagnostics);
                continue;
            }

            // A keyed resource entry: its x:Key must be unique within THIS dictionary. Both a plain string key and an {x:Type Foo} implicit-style key are tracked (in separate key-spaces).
            if (TryGetResourceKey(entry, out var canonicalKey, out var keySpan) && !scope.Add(canonicalKey))
            {
                diagnostics.Add(Diag(doc, keySpan, SeverityError, DuplicateKeyCode,
                    "An item with the same key has already been added."));
            }

            // The entry's own subtree may nest further dictionaries (rare) — validate them independently.
            FindResourceScopes(entry, doc, diagnostics);
        }
    }

    private static bool IsResourceScopeBoundary(XamlElement element)
    {
        if (element.Name is not { } n)
        {
            return false;
        }

        // An explicit dictionary element.
        if (!n.IsDotted && n.LocalName == "ResourceDictionary")
        {
            return true;
        }

        // A ".Resources" property element on any type (Page.Resources, Application.Resources, ...).
        if (n.IsDotted && !n.HasPrefix)
        {
            int dot = n.LocalName.LastIndexOf('.');
            return dot > 0 && dot < n.LocalName.Length - 1 &&
                   string.Equals(n.LocalName.Substring(dot + 1), "Resources", System.StringComparison.Ordinal);
        }

        return false;
    }

    /// <summary>Reads an entry's x:Key as a canonical, scope-comparable key.</summary>
    private static bool TryGetResourceKey(XamlElement entry, out string canonicalKey, out TextSpan keySpan)
    {
        canonicalKey = string.Empty;
        keySpan = default;

        if (entry.GetAttribute("x:Key")?.Value is not { } value)
        {
            return false;
        }

        // Plain string key: its literal text is the key (namespaced so it never aliases a type key).
        if (!value.IsMarkupExtension)
        {
            var text = value.Text?.Trim();
            if (string.IsNullOrEmpty(text))
            {
                return false;
            }

            canonicalKey = "s:" + text;
            keySpan = value.InnerSpan;
            return true;
        }

        // {x:Type Foo} implicit-style key: canonicalize by the (trimmed) type argument text so two {x:Type Foo} entries in the same dictionary are a duplicate, matching the XAML compiler.
        if (value.MarkupExtension is { IsClosed: true, Name: { LocalName: "Type" } typeName } ext &&
            string.Equals(typeName.Prefix, "x", System.StringComparison.Ordinal))
        {
            var typeArg = ext.Arguments.FirstOrDefault(
                a => !a.IsNamed && a.NestedExtension is null && a.Value is { Length: > 0 });
            var argText = typeArg?.Value?.Trim();
            if (!string.IsNullOrEmpty(argText))
            {
                canonicalKey = "t:" + argText;
                keySpan = typeArg!.ValueSpan ?? value.InnerSpan;
                return true;
            }
        }

        return false; // other markup-extension key forms — skip conservatively.
    }

    /// <summary>Reads a static (non-markup-extension, non-empty) directive value off an element, trying primary then optional fallback.</summary>
    private static bool TryGetStaticValue(
        XamlElement element, string primary, string? fallback,
        [NotNullWhen(true)] out XamlAttribute? attr, out string text)
    {
        attr = element.GetAttribute(primary) ?? (fallback is null ? null : element.GetAttribute(fallback));
        if (attr?.Value is { IsMarkupExtension: false } value)
        {
            var trimmed = value.Text?.Trim();
            if (!string.IsNullOrEmpty(trimmed))
            {
                text = trimmed!;
                return true;
            }
        }

        attr = null;
        text = string.Empty;
        return false;
    }
}
