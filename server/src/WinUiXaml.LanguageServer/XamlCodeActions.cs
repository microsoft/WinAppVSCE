using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Workspace;
using WinUiXaml.Xaml;

namespace WinUiXaml.LanguageServer;

internal sealed class PromptedTextEditCommandArguments
{
    public string DocumentUri { get; init; } = string.Empty;
    public Lsp.Range Range { get; init; } = new();
    public string Prompt { get; init; } = string.Empty;
    public string PlaceHolder { get; init; } = string.Empty;
    public string InitialValue { get; init; } = string.Empty;
    public string Prefix { get; init; } = string.Empty;
    public string Suffix { get; init; } = string.Empty;
    public int? ExpectedVersion { get; init; }
    public string ExpectedText { get; init; } = string.Empty;
    public string[] Choices { get; init; } = Array.Empty<string>();
    public string CustomChoiceLabel { get; init; } = string.Empty;
    public string ValidationPattern { get; init; } = string.Empty;
    public string ValidationMessage { get; init; } = string.Empty;
}

internal sealed class GuardedTextEditCommandArguments
{
    public string DocumentUri { get; init; } = string.Empty;
    public int? ExpectedVersion { get; init; }
    public GuardedTextEdit[] Edits { get; init; } = Array.Empty<GuardedTextEdit>();
}

internal sealed class GuardedTextEdit
{
    public Lsp.Range Range { get; init; }
    public string ExpectedText { get; init; } = string.Empty;
    public string NewText { get; init; } = string.Empty;
}

/// <summary>Builds textDocument/codeAction quick fixes from the diagnostics the client hands back.</summary>
internal static class XamlCodeActions
{
    internal const string PromptTextEditCommand = "winui-xaml.promptTextEdit";
    internal const string ApplyGuardedTextEditsCommand = "winui-xaml.applyGuardedTextEdits";

    // The unknown-name diagnostics whose data carries spelling suggestions.
    private static readonly HashSet<string> SuggestibleCodes = new(StringComparer.Ordinal)
    {
        XamlValidator.UnknownTypeCode,
        XamlValidator.UnknownAttributeCode,
        XamlValidator.UnknownAttachedPropertyCode,
        XamlValidator.UnknownPropertyElementCode,
        XamlValidator.UnknownBindMemberCode,
        XamlValidator.UnknownResourceKeyCode,
        XamlValidator.InvalidSetterPropertyCode,
        XamlValidator.InvalidBindModeCode,
        XamlValidator.InvalidAttributeValueCode,
        XamlValidator.UnknownNamespaceDeclarationCode,
    };

    public static List<CodeAction> Compute(string uri, TextDocument? doc, CodeActionContext context, XamlTypeSystem? typeSystem = null)
    {
        var actions = new List<CodeAction>();
        if (context is null)
        {
            return actions;
        }

        if (QuickFixKindAllowed(context.Only))
        {
            var seenXmlnsDeclarations = new HashSet<string>(StringComparer.Ordinal);
            foreach (var diagnostic in context.Diagnostics)
            {
                if (diagnostic.Code is null)
                {
                    continue;
                }

                // Undeclared prefix (WXAML0001): only consume an unambiguous namespace URI
                // supplied by validation; code actions must not infer or guess an import.
                if (string.Equals(diagnostic.Code, XamlValidator.UndeclaredPrefixCode, StringComparison.Ordinal))
                {
                    AddUndeclaredPrefixFix(actions, uri, doc, diagnostic, seenXmlnsDeclarations);
                    continue;
                }

                if (string.Equals(diagnostic.Code, XamlDiagnosticIds.StrayEndTag, StringComparison.Ordinal))
                {
                    AddMismatchedEndTagFix(actions, uri, doc, diagnostic);
                    continue;
                }

                if (string.Equals(diagnostic.Code, XamlValidator.DataTemplateDataTypeRequiredCode, StringComparison.Ordinal) ||
                    string.Equals(diagnostic.Code, XamlValidator.BindingDataTypeRecommendedCode, StringComparison.Ordinal))
                {
                    AddDataTypeFix(actions, uri, doc, diagnostic, typeSystem);
                    continue;
                }

                if (AddMechanicalFix(actions, uri, doc, diagnostic, typeSystem))
                {
                    continue;
                }

                bool preferredImportAdded = false;
                if (string.Equals(diagnostic.Code, XamlValidator.UnknownTypeCode, StringComparison.Ordinal))
                {
                    preferredImportAdded =
                        AddUnprefixedTypeImportFixes(actions, uri, doc, diagnostic, typeSystem);
                }

                if (!SuggestibleCodes.Contains(diagnostic.Code))
                {
                    continue;
                }

                var (bad, suggestions) = ReadSuggestions(diagnostic.Data);
                if (suggestions.Count == 0)
                {
                    AddPromptedReplacementFix(actions, uri, doc, diagnostic, bad);
                    continue;
                }

                // The stored token is authoritative; fall back to the live span only if it is somehow absent.
                if (bad.Length == 0 && doc is not null)
                {
                    bad = RangeText(doc, diagnostic.Range);
                }

                for (int i = 0; i < suggestions.Count; i++)
                {
                    var suggestion = suggestions[i];
                    var editRange = EditRange(doc, diagnostic.Range, bad);
                    if (doc is not null &&
                        bad.Length > 0 &&
                        !string.Equals(RangeText(doc, editRange), bad, StringComparison.Ordinal))
                    {
                        continue;
                    }
                    var edits = BuildSpellingEdits(doc, diagnostic, bad, suggestion);
                    bool uniqueNamespaceSuggestion =
                        !string.Equals(
                            diagnostic.Code,
                            XamlValidator.UnknownNamespaceDeclarationCode,
                            StringComparison.Ordinal) ||
                        suggestions.Count == 1;
                    actions.Add(new CodeAction
                    {
                        Title = bad.Length == 0 ? $"Change to '{suggestion}'" : $"Change '{bad}' to '{suggestion}'",
                        Kind = "quickfix",
                        Diagnostics = new List<Diagnostic> { diagnostic },
                        IsPreferred =
                            i == 0 && !preferredImportAdded && uniqueNamespaceSuggestion
                                ? true
                                : null,
                        Edit = new WorkspaceEdit
                        {
                            Changes = new Dictionary<string, List<TextEdit>>
                            {
                                [uri] = edits,
                            },
                        },
                    });
                }
            }
        }

        if (doc is not null && KindAllowed(context.Only, "source.organizeImports"))
        {
            var edits = XamlNamespaceActions.RemoveUnusedRootNamespaces(doc);
            if (edits.Count > 0)
            {
                actions.Add(new CodeAction
                {
                    Title = "Remove unused XAML namespaces",
                    Kind = "source.organizeImports",
                    Edit = new WorkspaceEdit
                    {
                        Changes = new Dictionary<string, List<TextEdit>> { [uri] = edits },
                    },
                });
            }
        }

        return actions;
    }

    /// <summary>LSP kind gate: a <c>quickfix</c> is offered when the client sends no <c>only</c> filter, or an entry that equals <c>quickfix</c> or is one of its parent kinds.</summary>
    internal static bool QuickFixKindAllowed(string[]? only)
        => KindAllowed(only, "quickfix");

    private static bool KindAllowed(string[]? only, string target)
    {
        if (only is null || only.Length == 0)
        {
            return true;
        }

        foreach (var kind in only)
        {
            if (kind.Length == 0 || string.Equals(kind, target, StringComparison.Ordinal) ||
                target.StartsWith(kind + ".", StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>Extracts the mistyped token and its ranked suggestions from a diagnostic's data.</summary>
    private static (string Bad, IReadOnlyList<string> Suggestions) ReadSuggestions(object? data)
    {
        switch (data)
        {
            case DiagnosticData typed:
                var list = typed.Suggestions?.Where(s => !string.IsNullOrEmpty(s)).ToList() ?? new List<string>();
                return (typed.Bad ?? string.Empty, list);

            case JsonElement json when json.ValueKind == JsonValueKind.Object:
                string bad = json.TryGetProperty("bad", out var b) && b.ValueKind == JsonValueKind.String
                    ? b.GetString() ?? string.Empty
                    : string.Empty;

                var suggestions = new List<string>();
                if (json.TryGetProperty("suggestions", out var s) && s.ValueKind == JsonValueKind.Array)
                {
                    foreach (var item in s.EnumerateArray())
                    {
                        if (item.ValueKind == JsonValueKind.String && item.GetString() is { Length: > 0 } str)
                        {
                            suggestions.Add(str);
                        }
                    }
                }

                return (bad, suggestions);

            default:
                return (string.Empty, Array.Empty<string>());
        }
    }

    private static string RangeText(TextDocument doc, Lsp.Range range)
    {
        int start = doc.OffsetAt(range.Start);
        int end = doc.OffsetAt(range.End);
        return start >= 0 && end >= start && end <= doc.Text.Length
            ? doc.Text.Substring(start, end - start)
            : string.Empty;
    }

    /// <summary>The range the fix should replace: normally the flagged span itself, but when the diagnostic underlines a WIDER region than the mistyped token (the first-segment x:Bind path</summary>
    private static Lsp.Range EditRange(TextDocument? doc, Lsp.Range range, string bad)
    {
        if (doc is null || bad.Length == 0)
        {
            return range;
        }

        var text = RangeText(doc, range);
        if (text.Length <= bad.Length)
        {
            return range; // the span already IS the token (or smaller) — replace it whole.
        }

        int idx = text.IndexOf(bad, StringComparison.Ordinal);
        if (idx < 0)
        {
            return range; // token not found inside the flagged span — replace the whole span.
        }

        int start = doc.OffsetAt(range.Start) + idx;
        return new Lsp.Range(doc.PositionAt(start), doc.PositionAt(start + bad.Length));
    }

    private static List<TextEdit> BuildSpellingEdits(
        TextDocument? doc, Diagnostic diagnostic, string bad, string suggestion)
    {
        var edits = new List<TextEdit>
        {
            new() { Range = EditRange(doc, diagnostic.Range, bad), NewText = suggestion },
        };

        if (doc?.Parsed.Root is null ||
            !string.Equals(diagnostic.Code, XamlValidator.UnknownTypeCode, StringComparison.Ordinal))
        {
            return edits;
        }

        int diagnosticStart = doc.OffsetAt(diagnostic.Range.Start);
        var element = FindElementByOpenName(doc.Parsed.Root, diagnosticStart);
        if (element?.Name is not { } openName ||
            element.EndTagName is not { } endName ||
            !string.Equals(openName.LocalName, bad, StringComparison.Ordinal) ||
            !string.Equals(endName.FullName, openName.FullName, StringComparison.Ordinal))
        {
            return edits;
        }

        edits.Add(new TextEdit
        {
            Range = doc.RangeOf(endName.LocalNameSpan),
            NewText = suggestion,
        });
        return edits;
    }

    private static XamlElement? FindElementByOpenName(XamlElement element, int offset)
    {
        if (element.Name?.Span.ContainsInclusive(offset) == true)
        {
            return element;
        }

        foreach (var child in element.Content)
        {
            if (child is XamlElement childElement &&
                FindElementByOpenName(childElement, offset) is { } found)
            {
                return found;
            }
        }

        return null;
    }

    private static void AddDataTypeFix(
        List<CodeAction> actions,
        string uri,
        TextDocument? doc,
        Diagnostic diagnostic,
        XamlTypeSystem? typeSystem)
    {
        if (doc is null)
        {
            return;
        }

        var (namespaceUri, suggestions) = ReadSuggestions(diagnostic.Data);
        var dataTemplate = FindEnclosingDataTemplate(
            doc.Parsed.FindNode(doc.OffsetAt(diagnostic.Range.Start)), typeSystem);
        if (dataTemplate is null)
        {
            return;
        }

        string? xamlPrefix = dataTemplate.NamespaceScope.Declarations
            .Where(declaration =>
                declaration.Key.Length > 0 &&
                string.Equals(
                    declaration.Value,
                    XamlTypeSystem.XamlLanguageNamespace,
                    StringComparison.Ordinal))
            .Select(declaration => declaration.Key)
            .FirstOrDefault();
        if (xamlPrefix is null)
        {
            return;
        }

        var validSuggestedTypes = suggestions
            .Select(suggestion =>
                TryValidateInferredXamlType(suggestion, namespaceUri, out var inferred)
                    ? inferred
                    : string.Empty)
            .Where(inferred =>
            {
                int typeColon = inferred.IndexOf(':');
                string typePrefix =
                    typeColon < 0 ? string.Empty : inferred.Substring(0, typeColon);
                return inferred.Length > 0 &&
                    dataTemplate.NamespaceScope.TryResolvePrefix(
                        typePrefix,
                        out var resolvedTypeNamespace) &&
                    string.Equals(
                        resolvedTypeNamespace,
                        namespaceUri,
                        StringComparison.Ordinal);
            })
            .Distinct(StringComparer.Ordinal)
            .ToList();
        bool hasInferredType = validSuggestedTypes.Count == 1;
        string inferredType = hasInferredType ? validSuggestedTypes[0] : string.Empty;
        string directiveName = xamlPrefix + ":DataType";

        TextEdit edit;
        var existing = XamlSemanticFacts.GetDirectiveAttribute(dataTemplate, "DataType");
        if (existing is not null)
        {
            if (existing.Value is null ||
                existing.Value.Text.Trim().Length != 0)
            {
                return;
            }

            edit = new TextEdit
            {
                Range = doc.RangeOf(existing.Value.InnerSpan),
                NewText = hasInferredType ? inferredType : string.Empty,
            };
        }
        else
        {
            int insertionOffset = dataTemplate.OpenTagSpan.End - 1;
            if (insertionOffset < dataTemplate.OpenTagSpan.Start ||
                insertionOffset >= doc.Text.Length)
            {
                return;
            }

            if (insertionOffset > dataTemplate.OpenTagSpan.Start &&
                doc.Text[insertionOffset - 1] == '/')
            {
                insertionOffset--;
            }

            edit = new TextEdit
            {
                Range = doc.RangeOf(TextSpan.Empty(insertionOffset)),
                NewText = hasInferredType
                    ? $" {directiveName}=\"{inferredType}\""
                    : string.Empty,
            };
        }

        if (!hasInferredType)
        {
            AddPromptTextEditAction(
                actions,
                diagnostic,
                $"Set {directiveName}...",
                doc,
                edit.Range,
                "Enter the XAML type for this template",
                "models:Item",
                string.Empty,
                existing is null ? $" {directiveName}=\"" : string.Empty,
                existing is null ? "\"" : string.Empty,
                "xamlType",
                validSuggestedTypes,
                "Enter another type...");
            return;
        }

        actions.Add(new CodeAction
        {
            Title = $"Set {directiveName} to '{inferredType}'",
            Kind = "quickfix",
            Diagnostics = new List<Diagnostic> { diagnostic },
            IsPreferred = true,
            Edit = new WorkspaceEdit
            {
                Changes = new Dictionary<string, List<TextEdit>>
                {
                    [uri] = new List<TextEdit> { edit },
                },
            },
        });
    }

    private static bool TryValidateInferredXamlType(
        string suggestion, string namespaceUri, out string inferredType)
    {
        inferredType = suggestion.Trim();
        if (inferredType.Length == 0 ||
            inferredType.Any(character =>
                char.IsWhiteSpace(character) || character is '"' or '\'' or '<' or '>' or '{' or '}' or '='))
        {
            return false;
        }

        int colon = inferredType.IndexOf(':');
        string prefix = colon < 0 ? string.Empty : inferredType.Substring(0, colon);
        return namespaceUri.Length > 0 && (colon < 0 || colon < inferredType.Length - 1) &&
            prefix.IndexOf(':') < 0;
    }

    private static XamlElement? FindEnclosingDataTemplate(
        XamlNode? node, XamlTypeSystem? typeSystem)
    {
        for (; node is not null; node = node.Parent)
        {
            if (node is XamlElement element &&
                (typeSystem is not null && XamlSemanticFacts.IsDataTemplate(element, typeSystem) ||
                 string.Equals(element.Name?.LocalName, "DataTemplate", StringComparison.Ordinal)))
            {
                return element;
            }
        }

        return null;
    }

    /// <summary>Adds xmlns only when the diagnostic itself supplies one unique namespace URI.</summary>
    private static void AddUndeclaredPrefixFix(
        List<CodeAction> actions, string uri, TextDocument? doc, Diagnostic diagnostic,
        HashSet<string> seen)
    {
        if (doc is null)
        {
            return;
        }

        // The diagnostic underlines the prefix token; strip any ":local" tail defensively.
        string raw = RangeText(doc, diagnostic.Range);
        int colon = raw.IndexOf(':');
        string prefix = (colon >= 0 ? raw.Substring(0, colon) : raw).Trim();
        var diagnosticNode = doc.Parsed.FindNode(doc.OffsetAt(diagnostic.Range.Start));
        var activeElement = FindAncestor<XamlElement>(diagnosticNode);
        if (prefix.Length == 0 ||
            activeElement?.NamespaceScope.TryResolvePrefix(prefix, out _) == true)
        {
            return;
        }

        var (bad, suggestions) = ReadSuggestions(diagnostic.Data);
        if (!string.Equals(bad, prefix, StringComparison.Ordinal) ||
            suggestions.Count != 1 ||
            !IsNamespaceUri(suggestions[0]))
        {
            var insertion = XamlNamespaceImport.BuildRootDeclarationEditForUri(
                doc, prefix, "using:Placeholder");
            if (insertion is not null)
            {
                AddPromptTextEditAction(
                    actions,
                    diagnostic,
                    $"Add xmlns:{prefix}...",
                    doc,
                    insertion.Range,
                    $"Enter the namespace URI for '{prefix}'",
                    "using:MyApp.Controls",
                    string.Empty,
                    $" xmlns:{prefix}=\"",
                    "\"",
                    "namespaceUri",
                    suggestions.Where(IsNamespaceUri).Distinct(StringComparer.Ordinal).ToArray(),
                    "Enter another namespace URI...");
            }
            return;
        }

        string namespaceUri = suggestions[0];
        if (!seen.Add(prefix + "\0" + namespaceUri))
        {
            return;
        }

        var declarationEdit =
            XamlNamespaceImport.BuildRootDeclarationEditForUri(doc, prefix, namespaceUri);
        if (declarationEdit is null)
        {
            return;
        }

        actions.Add(BuildAddXmlnsAction(
            uri, declarationEdit, $"Add xmlns:{prefix}=\"{namespaceUri}\"", isPreferred: true, diagnostic));
    }

    private static bool IsNamespaceUri(string value) =>
        value.StartsWith("using:", StringComparison.Ordinal) && value.Length > "using:".Length ||
        Uri.TryCreate(value, UriKind.Absolute, out var uri) &&
        (string.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) ||
         string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase));

    private static bool AddMechanicalFix(
        List<CodeAction> actions,
        string uri,
        TextDocument? doc,
        Diagnostic diagnostic,
        XamlTypeSystem? typeSystem)
    {
        if (doc is null)
        {
            return false;
        }

        int offset = doc.OffsetAt(diagnostic.Range.Start);
        switch (diagnostic.Code)
        {
            case XamlValidator.DuplicateNameCode:
            case XamlValidator.InvalidNameCode:
            {
                var attribute = FindAncestor<XamlAttribute>(doc.Parsed.FindNode(offset));
                if (attribute?.Value is null ||
                    typeSystem is null ||
                    attribute.Parent is not XamlElement nameOwner ||
                    XamlSemanticFacts.ResolveElementType(nameOwner, typeSystem) is not { } nameOwnerType ||
                    !XamlSemanticFacts.IsNameAttribute(
                        attribute,
                        nameOwnerType,
                        nameOwner.NamespaceScope,
                        typeSystem) ||
                    !DiagnosticTargetsSpan(doc, diagnostic.Range, attribute.Value.InnerSpan) ||
                    diagnostic.Code == XamlValidator.InvalidNameCode &&
                    XamlRename.IsValidName(attribute.Value.Text) ||
                    diagnostic.Code == XamlValidator.DuplicateNameCode &&
                    !IsDuplicateName(doc, attribute, typeSystem))
                {
                    return false;
                }

                string replacement = MakeUniqueXamlName(
                    doc,
                    attribute,
                    diagnostic.Code == XamlValidator.InvalidNameCode
                        ? XamlRename.SanitizeName(attribute.Value.Text)
                        : attribute.Value.Text,
                    typeSystem!);
                var renameOccurrences = diagnostic.Code == XamlValidator.InvalidNameCode
                    ? XamlLanguageServer.ResolveNameOccurrences(
                        doc,
                        nameOwner,
                        attribute.Value.Text,
                        typeSystem)
                    : new List<(Lsp.Range Range, bool IsDeclaration)>();
                var targetRange = doc.RangeOf(attribute.Value.InnerSpan);
                var renameEdits = renameOccurrences.Count(occurrence => occurrence.IsDeclaration) == 1 &&
                    renameOccurrences.Any(occurrence =>
                        occurrence.IsDeclaration && occurrence.Range.Equals(targetRange))
                    ? renameOccurrences.Select(occurrence => new TextEdit
                        {
                            Range = occurrence.Range,
                            NewText = replacement,
                        }).ToList()
                    : null;
                AddGuardedEditAction(
                    actions,
                    doc,
                    diagnostic,
                    $"Rename to '{replacement}'",
                    renameEdits ?? new List<TextEdit>
                    {
                        new() { Range = targetRange, NewText = replacement },
                    });
                return true;
            }

            case XamlValidator.DuplicateAttributeCode:
            {
                var attribute = FindAncestor<XamlAttribute>(doc.Parsed.FindNode(offset));
                if (attribute is null ||
                    !DiagnosticTargetsSpan(doc, diagnostic.Range, attribute.Name.Span) ||
                    attribute.Parent is not XamlElement parent ||
                    parent.Attributes.Count(candidate =>
                        string.Equals(
                            XamlSemanticFacts.GetExpandedAttributeName(parent, candidate),
                            XamlSemanticFacts.GetExpandedAttributeName(parent, attribute),
                            StringComparison.Ordinal)) < 2)
                {
                    return false;
                }

                AddEditAction(
                    actions,
                    doc,
                    diagnostic,
                    $"Remove duplicate '{attribute.Name.FullName}' attribute",
                    doc.RangeOf(XamlNamespaceActions.ExpandRemovalSpan(doc.Text, attribute.Span)),
                    string.Empty);
                return true;
            }

            case XamlValidator.MultipleScalarChildrenCode:
            {
                var element = FindAncestor<XamlElement>(doc.Parsed.FindNode(offset));
                if (element is null ||
                    !DiagnosticTargetsSpan(
                        doc,
                        diagnostic.Range,
                        element.Name?.Span ?? element.Span) ||
                    typeSystem is null ||
                    element.Parent is not XamlElement parent ||
                    !HasScalarElementContent(parent, typeSystem) ||
                    parent.Content.OfType<XamlElement>()
                        .Where(child => !child.IsPropertyElement)
                        .Take(2)
                        .Count() < 2 ||
                    ReferenceEquals(
                        parent.Content.OfType<XamlElement>()
                            .First(child => !child.IsPropertyElement),
                        element))
                {
                    return false;
                }

                AddEditAction(
                    actions,
                    doc,
                    diagnostic,
                    $"Remove extra '{element.Name?.FullName ?? "child"}'",
                    doc.RangeOf(XamlNamespaceActions.ExpandRemovalSpan(doc.Text, element.Span)),
                    string.Empty);
                return true;
            }

            case XamlValidator.InvalidAttributeValueCode:
            {
                var attribute = FindAncestor<XamlAttribute>(doc.Parsed.FindNode(offset));
                var element = attribute?.Parent as XamlElement;
                var elementType = element is null || typeSystem is null
                    ? null
                    : XamlSemanticFacts.ResolveElementType(element, typeSystem);
                var memberType = elementType is null || attribute is null
                    ? null
                    : typeSystem!.FindAttributeMember(elementType, attribute.Name.LocalName)?.Type;
                string? replacement = memberType is null
                    ? null
                    : XamlValueConverter.GetDefaultLiteral(memberType);
                if (attribute?.Value is null ||
                    replacement is null ||
                    !DiagnosticTargetsSpan(doc, diagnostic.Range, attribute.Value.InnerSpan) ||
                    memberType is not null &&
                    XamlValueConverter.TryValidate(
                        attribute.Value.Text,
                        memberType,
                        typeSystem!,
                        out bool isValid) &&
                    isValid)
                {
                    return false;
                }

                AddEditAction(
                    actions,
                    doc,
                    diagnostic,
                    $"Replace with '{replacement}'",
                    doc.RangeOf(attribute.Value.InnerSpan),
                    replacement);
                return true;
            }

            default:
                return false;
        }
    }

    private static void AddPromptedReplacementFix(
        List<CodeAction> actions,
        string uri,
        TextDocument? doc,
        Diagnostic diagnostic,
        string bad)
    {
        if (doc is null)
        {
            return;
        }

        string title;
        string prompt;
        string placeholder;
        string validationKind;
        switch (diagnostic.Code)
        {
            case XamlValidator.UnknownBindMemberCode:
                title = "Replace x:Bind member...";
                prompt = "Enter a bindable member name";
                placeholder = bad.Length == 0 ? "PropertyName" : bad;
                validationKind = "xamlName";
                break;
            case XamlValidator.InvalidSetterPropertyCode:
                title = "Replace Setter property...";
                prompt = "Enter a property on the style target type";
                placeholder = bad.Length == 0 ? "PropertyName" : bad;
                validationKind = "xamlMember";
                break;
            default:
                return;
        }

        var range = EditRange(doc, diagnostic.Range, bad);
        if (bad.Length > 0 &&
            !string.Equals(RangeText(doc, range), bad, StringComparison.Ordinal))
        {
            return;
        }

        AddPromptTextEditAction(
            actions,
            diagnostic,
            title,
            doc,
            range,
            prompt,
            placeholder,
            bad,
            string.Empty,
            string.Empty,
            validationKind);
    }

    private static void AddPromptTextEditAction(
        List<CodeAction> actions,
        Diagnostic diagnostic,
        string title,
        TextDocument doc,
        Lsp.Range range,
        string prompt,
        string placeholder,
        string initialValue,
        string prefix,
        string suffix,
        string validationKind,
        IReadOnlyList<string>? choices = null,
        string customChoiceLabel = "Enter another value...")
    {
        actions.Add(new CodeAction
        {
            Title = title,
            Kind = "quickfix",
            Diagnostics = new List<Diagnostic> { diagnostic },
            Command = new Command
            {
                Title = title,
                Name = PromptTextEditCommand,
                Arguments = new object[]
                {
                    new PromptedTextEditCommandArguments
                    {
                        DocumentUri = doc.Uri,
                        Range = range,
                        Prompt = prompt,
                        PlaceHolder = placeholder,
                        InitialValue = initialValue,
                        Prefix = prefix,
                        Suffix = suffix,
                        ExpectedVersion = doc.Version,
                        ExpectedText = RangeText(doc, range),
                        Choices = choices?.ToArray() ?? Array.Empty<string>(),
                        CustomChoiceLabel = customChoiceLabel,
                        ValidationPattern = PromptValidationPattern(validationKind),
                        ValidationMessage = PromptValidationMessage(validationKind),
                    },
                },
            },
        });
    }

    private static void AddEditAction(
        List<CodeAction> actions,
        TextDocument doc,
        Diagnostic diagnostic,
        string title,
        Lsp.Range range,
        string newText)
    {
        actions.Add(new CodeAction
        {
            Title = title,
            Kind = "quickfix",
            Diagnostics = new List<Diagnostic> { diagnostic },
            IsPreferred = true,
            Edit = new WorkspaceEdit
            {
                Changes = new Dictionary<string, List<TextEdit>>(StringComparer.Ordinal)
                {
                    [doc.Uri] = new List<TextEdit>
                    {
                        new() { Range = range, NewText = newText },
                    },
                },
            },
            Command = GuardedEditCommand(doc, title, new List<TextEdit>
            {
                new() { Range = range, NewText = newText },
            }),
        });
    }

    private static void AddGuardedEditAction(
        List<CodeAction> actions,
        TextDocument doc,
        Diagnostic diagnostic,
        string title,
        List<TextEdit> edits)
    {
        actions.Add(new CodeAction
        {
            Title = title,
            Kind = "quickfix",
            Diagnostics = new List<Diagnostic> { diagnostic },
            IsPreferred = true,
            Edit = new WorkspaceEdit
            {
                Changes = new Dictionary<string, List<TextEdit>>(StringComparer.Ordinal)
                {
                    [doc.Uri] = edits,
                },
            },
            Command = GuardedEditCommand(doc, title, edits),
        });
    }

    private static Command GuardedEditCommand(
        TextDocument doc,
        string title,
        List<TextEdit> edits) =>
        new()
        {
            Title = title,
            Name = ApplyGuardedTextEditsCommand,
            Arguments = new object[]
            {
                new GuardedTextEditCommandArguments
                {
                    DocumentUri = doc.Uri,
                    ExpectedVersion = doc.Version,
                    Edits = edits.Select(edit => new GuardedTextEdit
                    {
                        Range = edit.Range,
                        ExpectedText = RangeText(doc, edit.Range),
                        NewText = edit.NewText,
                    }).ToArray(),
                },
            },
        };

    private static T? FindAncestor<T>(XamlNode? node) where T : XamlNode
    {
        for (; node is not null; node = node.Parent)
        {
            if (node is T result)
            {
                return result;
            }
        }

        return null;
    }

    private static string MakeUniqueXamlName(
        TextDocument doc,
        XamlAttribute target,
        string basis,
        XamlTypeSystem typeSystem)
    {
        var owner = target.Parent as XamlElement;
        var names = owner is null
            ? new HashSet<string>(StringComparer.Ordinal)
            : XamlSemanticFacts.EnumerateNamedElementsInScope(doc, owner, typeSystem)
                .Select(entry => entry.Name)
                .ToHashSet(StringComparer.Ordinal);

        string candidate = basis.Length == 0 ? "Element" : basis;
        for (int suffix = 2; names.Contains(candidate); suffix++)
        {
            candidate = basis + suffix;
        }

        return candidate;
    }

    private static bool IsDuplicateName(
        TextDocument doc,
        XamlAttribute target,
        XamlTypeSystem? typeSystem)
    {
        if (target.Value is null)
        {
            return false;
        }

        if (target.Parent is XamlElement owner && typeSystem is not null)
        {
            return XamlSemanticFacts.EnumerateNamedElementsInScope(doc, owner, typeSystem)
                .Count(entry =>
                    string.Equals(
                        entry.Name,
                        target.Value.Text.Trim(),
                        StringComparison.Ordinal)) > 1;
        }

        return false;
    }

    private static bool DiagnosticTargetsSpan(
        TextDocument doc,
        Lsp.Range range,
        TextSpan span)
    {
        int start = doc.OffsetAt(range.Start);
        int end = doc.OffsetAt(range.End);
        return start == span.Start && end == span.End;
    }


    private static bool HasScalarElementContent(
        XamlElement parent,
        XamlTypeSystem typeSystem)
    {
        Microsoft.CodeAnalysis.ITypeSymbol? contentType;
        if (parent.IsPropertyElement)
        {
            contentType =
                XamlSemanticFacts.ResolvePropertyElementMember(parent, typeSystem)?.PropertyType;
        }
        else
        {
            var parentType = XamlSemanticFacts.ResolveElementType(parent, typeSystem);
            contentType = parentType is null
                ? null
                : typeSystem.GetContentPropertyDeclaredType(parentType);
        }

        return contentType is not null &&
            XamlTypeSystem.GetCollectionElementType(contentType) is null;
    }

    private static string PromptValidationPattern(string validationKind)
    {
        const string identifier = @"[\p{L}_][\p{L}\p{N}_]*";
        const string namespacePrefix = @"[\p{L}_][\p{L}\p{N}_.-]*";
        return validationKind switch
        {
            "namespaceUri" =>
                $@"(?:using:{identifier}(?:\.{identifier})*|https?://[^\s""'&<>]+)",
            "xamlType" => $@"(?:{namespacePrefix}:)?{identifier}",
            "xamlMember" =>
                $@"(?:(?:{namespacePrefix}:)?{identifier}\.)?{identifier}",
            _ => identifier,
        };
    }

    private static string PromptValidationMessage(string validationKind) =>
        validationKind switch
        {
            "namespaceUri" =>
                "Enter a using: namespace or an http(s) namespace URI without whitespace or XML metacharacters.",
            "xamlType" => "Enter a XAML type name such as models:Item.",
            "xamlMember" => "Enter a property name such as Width or Grid.Row.",
            _ => "Enter a valid XAML identifier.",
        };

    private static void AddMismatchedEndTagFix(
        List<CodeAction> actions, string uri, TextDocument? doc, Diagnostic diagnostic)
    {
        if (doc?.Parsed.Root is null)
        {
            return;
        }

        int diagnosticStart = doc.OffsetAt(diagnostic.Range.Start);
        int diagnosticEnd = doc.OffsetAt(diagnostic.Range.End);
        var parserDiagnostic = doc.Parsed.Diagnostics.FirstOrDefault(item =>
            item.Id == XamlDiagnosticIds.StrayEndTag &&
            item.Span.Start == diagnosticStart &&
            item.Span.End == diagnosticEnd);
        if (parserDiagnostic is null ||
            !TryReadEndTagName(doc.Text, parserDiagnostic.Span, out var closeName, out var closeNameSpan))
        {
            return;
        }

        var candidates = new List<XamlElement>();
        CollectUnclosedElementsAt(doc.Parsed.Root, parserDiagnostic.Span.Start, candidates);
        var target = candidates
            .Where(element => element.Name is not null &&
                doc.Parsed.Diagnostics.Any(item =>
                    item.Id == XamlDiagnosticIds.MissingEndTag &&
                    item.Span.Start == element.Name.Span.Start &&
                    item.Span.End == element.Name.Span.End))
            .OrderByDescending(element => element.Name!.Span.Start)
            .FirstOrDefault();
        if (target?.Name is not { } openName ||
            string.Equals(openName.FullName, closeName, StringComparison.Ordinal))
        {
            return;
        }

        actions.Add(new CodeAction
        {
            Title = $"Change closing tag '{closeName}' to '{openName.FullName}'",
            Kind = "quickfix",
            Diagnostics = new List<Diagnostic> { diagnostic },
            IsPreferred = true,
            Edit = new WorkspaceEdit
            {
                Changes = new Dictionary<string, List<TextEdit>>
                {
                    [uri] = new List<TextEdit>
                    {
                        new() { Range = doc.RangeOf(closeNameSpan), NewText = openName.FullName },
                    },
                },
            },
        });
    }

    private static bool TryReadEndTagName(
        string text, TextSpan span, out string name, out TextSpan nameSpan)
    {
        int start = span.Start;
        int end = Math.Min(span.End, text.Length);
        if (start + 2 > end || text[start] != '<' || text[start + 1] != '/')
        {
            name = string.Empty;
            nameSpan = TextSpan.Empty(start);
            return false;
        }

        int nameStart = start + 2;
        while (nameStart < end && char.IsWhiteSpace(text[nameStart]))
        {
            nameStart++;
        }

        int nameEnd = nameStart;
        while (nameEnd < end && !char.IsWhiteSpace(text[nameEnd]) &&
               text[nameEnd] != '>' && text[nameEnd] != '/')
        {
            nameEnd++;
        }

        name = text.Substring(nameStart, nameEnd - nameStart);
        nameSpan = TextSpan.FromBounds(nameStart, nameEnd);
        return name.Length > 0;
    }

    private static void CollectUnclosedElementsAt(
        XamlElement element, int offset, List<XamlElement> candidates)
    {
        if (!element.IsClosed && element.Span.Start <= offset && offset < element.Span.End)
        {
            candidates.Add(element);
        }

        foreach (var child in element.Content)
        {
            if (child is XamlElement childElement)
            {
                CollectUnclosedElementsAt(childElement, offset, candidates);
            }
        }
    }

    /// <summary>Builds a single zero-width "Add xmlns:PREFIX=…" quick fix.</summary>
    private static CodeAction BuildAddXmlnsAction(
        string uri, TextEdit declarationEdit, string title, bool isPreferred, Diagnostic diagnostic)
    {
        return new CodeAction
        {
            Title = title,
            Kind = "quickfix",
            Diagnostics = new List<Diagnostic> { diagnostic },
            IsPreferred = isPreferred ? true : (bool?)null,
            Edit = new WorkspaceEdit
            {
                Changes = new Dictionary<string, List<TextEdit>>
                {
                    [uri] = new List<TextEdit> { declarationEdit },
                },
            },
        };
    }

    private static bool AddUnprefixedTypeImportFixes(
        List<CodeAction> actions,
        string uri,
        TextDocument? doc,
        Diagnostic diagnostic,
        XamlTypeSystem? typeSystem)
    {
        if (doc?.Parsed.Root is null || typeSystem is null)
        {
            return false;
        }

        var target = FindUnprefixedElement(doc.Parsed.Root, doc.OffsetAt(diagnostic.Range.Start));
        if (target?.Name is not { HasPrefix: false, IsDotted: false } name ||
            name.LocalName.Length == 0)
        {
            return false;
        }

        var defaultNamespaces = new HashSet<string>(StringComparer.Ordinal);
        if (target.NamespaceScope.TryResolvePrefix(string.Empty, out var defaultUri))
        {
            foreach (var clrNamespace in typeSystem.ClrNamespacesForUri(defaultUri))
            {
                defaultNamespaces.Add(clrNamespace);
            }
        }

        var candidates = typeSystem.FindElementTypesByName(name.LocalName)
            .Where(type => type.ContainingNamespace is { IsGlobalNamespace: false })
            .GroupBy(type => type.ContainingNamespace.ToDisplayString(), StringComparer.Ordinal)
            .Where(group => !defaultNamespaces.Contains(group.Key))
            .OrderBy(group => group.Key, StringComparer.Ordinal)
            .ToList();
        bool single = candidates.Count == 1;
        bool preferredAdded = false;

        foreach (var candidate in candidates)
        {
            if (!XamlNamespaceImport.TryPlan(
                    doc, target.NamespaceScope, typeSystem, candidate.Key,
                    out var prefix, out var declarationEdit))
            {
                continue;
            }

            var edits = new List<TextEdit>();
            if (declarationEdit is not null)
            {
                edits.Add(declarationEdit);
            }

            edits.Add(new TextEdit
            {
                Range = doc.RangeOf(new TextSpan(name.Span.Start, name.Span.Start)),
                NewText = prefix + ":",
            });

            if (target.EndTagName is { HasPrefix: false } endName &&
                string.Equals(endName.LocalName, name.LocalName, StringComparison.Ordinal))
            {
                edits.Add(new TextEdit
                {
                    Range = doc.RangeOf(new TextSpan(endName.Span.Start, endName.Span.Start)),
                    NewText = prefix + ":",
                });
            }

            actions.Add(new CodeAction
            {
                Title = $"Import '{name.LocalName}' from '{candidate.Key}'",
                Kind = "quickfix",
                Diagnostics = new List<Diagnostic> { diagnostic },
                IsPreferred = single ? true : null,
                Edit = new WorkspaceEdit
                {
                    Changes = new Dictionary<string, List<TextEdit>> { [uri] = edits },
                },
            });
            preferredAdded |= single;
        }

        return preferredAdded;
    }

    private static XamlElement? FindUnprefixedElement(XamlElement element, int offset)
    {
        if (element.Name is { HasPrefix: false } name && name.LocalNameSpan.ContainsInclusive(offset))
        {
            return element;
        }

        foreach (var child in element.Content)
        {
            if (child is XamlElement childElement &&
                FindUnprefixedElement(childElement, offset) is { } found)
            {
                return found;
            }
        }

        return null;
    }
}
