using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Workspace;
using WinUiXaml.Xaml;

namespace WinUiXaml.LanguageServer;

/// <summary>Builds textDocument/codeAction quick fixes from the diagnostics the client hands back.</summary>
internal static class XamlCodeActions
{
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
    };

    // Well-known XAML prefixes whose namespace URI is unambiguous, so an undeclared-prefix diagnostic (WXAML0001) can be fixed by inserting the standard declaration on the root. Custom prefixes need an author-chosen using: target we never guess.
    private static readonly Dictionary<string, string> WellKnownNamespaces = new(StringComparer.Ordinal)
    {
        ["x"] = XamlTypeSystem.XamlLanguageNamespace,
        ["d"] = XamlNamespaces.DesignTime2008,
        ["mc"] = XamlNamespaces.MarkupCompatibility,
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

                // Undeclared prefix (WXAML0001): offer to add the missing xmlns declaration on the root — the standard URI for a well-known prefix (x/d/mc), or an inferred using: for a custom prefix that names one of the project's own types.
                if (string.Equals(diagnostic.Code, XamlValidator.UndeclaredPrefixCode, StringComparison.Ordinal))
                {
                    AddUndeclaredPrefixFixes(actions, uri, doc, diagnostic, typeSystem, seenXmlnsDeclarations);
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
                    actions.Add(new CodeAction
                    {
                        Title = bad.Length == 0 ? $"Change to '{suggestion}'" : $"Change '{bad}' to '{suggestion}'",
                        Kind = "quickfix",
                        Diagnostics = new List<Diagnostic> { diagnostic },
                        IsPreferred = i == 0 && !preferredImportAdded ? true : null,
                        Edit = new WorkspaceEdit
                        {
                            Changes = new Dictionary<string, List<TextEdit>>
                            {
                                [uri] = new List<TextEdit> { new() { Range = EditRange(doc, diagnostic.Range, bad), NewText = suggestion } },
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

    /// <summary>Builds the "Add xmlns:… declaration" quick fix(es) for an undeclared prefix (WXAML0001).</summary>
    private static void AddUndeclaredPrefixFixes(
        List<CodeAction> actions, string uri, TextDocument? doc, Diagnostic diagnostic,
        XamlTypeSystem? typeSystem, HashSet<string> seen)
    {
        if (doc is null)
        {
            return;
        }

        // The diagnostic underlines the prefix token; strip any ":local" tail defensively.
        string raw = RangeText(doc, diagnostic.Range);
        int colon = raw.IndexOf(':');
        string prefix = (colon >= 0 ? raw.Substring(0, colon) : raw).Trim();
        if (prefix.Length == 0)
        {
            return;
        }

        // A well-known prefix is unambiguous: one standard declaration, and never also a using: guess.
        if (WellKnownNamespaces.TryGetValue(prefix, out var wellKnownUri))
        {
            if (seen.Add(prefix + "\0" + wellKnownUri))
            {
                var declarationEdit =
                    XamlNamespaceImport.BuildRootDeclarationEditForUri(doc, prefix, wellKnownUri);
                if (declarationEdit is null)
                {
                    return;
                }

                actions.Add(BuildAddXmlnsAction(
                    uri, declarationEdit, $"Add xmlns:{prefix} declaration", isPreferred: true, diagnostic));
            }

            return;
        }

        // Custom prefix: infer using: targets from the project's own types, but only when the prefix is on an ELEMENT (a type reference). Needs the type system; absent it, offer nothing (as before).
        if (typeSystem is null)
        {
            return;
        }

        var localName = FindElementTypeLocalNameForPrefix(doc, diagnostic.Range, prefix);
        if (localName is null)
        {
            return;
        }

        var namespaces = typeSystem.FindNamespacesForTypeName(localName);
        bool single = namespaces.Count == 1;
        foreach (var ns in namespaces)
        {
            var usingUri = "using:" + ns;
            if (!seen.Add(prefix + "\0" + usingUri))
            {
                continue;
            }

            var declarationEdit =
                XamlNamespaceImport.BuildRootDeclarationEditForUri(doc, prefix, usingUri);
            if (declarationEdit is null)
            {
                continue;
            }

            actions.Add(BuildAddXmlnsAction(
                uri, declarationEdit, $"Add xmlns:{prefix}=\"{usingUri}\"", isPreferred: single, diagnostic));
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

    /// <summary>The local (type) name of the ELEMENT whose undeclared prefix the diagnostic flags — the name to search for a using: target.</summary>
    private static string? FindElementTypeLocalNameForPrefix(TextDocument doc, Lsp.Range range, string prefix)
    {
        var root = doc.Parsed.Root;
        if (root is null)
        {
            return null;
        }

        int offset = doc.OffsetAt(range.Start);
        return FindElementTypeLocalName(root, prefix, offset);
    }

    private static string? FindElementTypeLocalName(XamlElement element, string prefix, int offset)
    {
        var name = element.Name;
        if (name is { HasPrefix: true } && string.Equals(name.Prefix, prefix, StringComparison.Ordinal))
        {
            var span = name.PrefixSpan ?? name.Span;
            if (span.Start <= offset && offset < span.End)
            {
                return name.LocalName;
            }
        }

        foreach (var child in element.Content)
        {
            if (child is XamlElement childElement)
            {
                var found = FindElementTypeLocalName(childElement, prefix, offset);
                if (found is not null)
                {
                    return found;
                }
            }
        }

        return null;
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
