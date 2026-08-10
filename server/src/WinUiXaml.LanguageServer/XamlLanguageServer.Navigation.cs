using Microsoft.CodeAnalysis;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Workspace;
using WinUiXaml.Xaml;

namespace WinUiXaml.LanguageServer;

internal sealed partial class XamlLanguageServer
{
    internal static List<(Lsp.Range Range, bool IsDeclaration)>? ResolveOccurrences(TextDocument doc, XamlElement root, int offset)
    {
        // Malformed, still-being-typed markup: stay silent when the caret sits inside an unterminated extension (self or an enclosing one).
        if (IsInsideUnterminatedExtension(root, offset))
        {
            return null;
        }

        if (DetectSymbolAt(doc, offset) is not { } symbol)
        {
            return null;
        }

        var occurrences = new List<(Lsp.Range Range, bool IsDeclaration)>();
        if (symbol.Kind == XamlRenameKind.Name)
        {
            CollectNameOccurrences(root, symbol.Name, doc, occurrences);
        }
        else
        {
            CollectResourceOccurrences(root, symbol.Name, doc, occurrences);
        }

        return DedupeAndSort(occurrences);
    }

    /// <summary>Classifies the renameable/referenceable symbol the caret sits on: an x:Name/Name (whether the caret is on the declaration or a usage) or an x:Key resource key.</summary>
    internal static (XamlRenameKind Kind, string Name)? DetectSymbolAt(TextDocument doc, int offset)
    {
        // x:Name: the caret is on a usage (ElementName=/Storyboard.TargetName) or on the declaration itself.
        var name = FindNameReferenceAt(doc, offset)?.Name ?? FindNameDeclarationAt(doc, offset);
        if (name is { Length: > 0 })
        {
            return (XamlRenameKind.Name, name);
        }

        // Resource key: the caret is on a {StaticResource}-family usage or on the x:Key declaration.
        var key = FindResourceKeyReferenceAt(doc, offset)?.Key ?? FindKeyDeclarationAt(doc, offset);
        if (key is { Length: > 0 })
        {
            return (XamlRenameKind.Key, key);
        }

        return null;
    }

    /// <summary>True when the caret sits inside a markup extension that is not closed (or whose enclosing extension is not closed).</summary>
    internal static bool IsInsideUnterminatedExtension(XamlElement root, int offset)
    {
        foreach (var node in root.DescendantNodesAndSelf())
        {
            if (node is XamlMarkupExtension { IsClosed: false } extension &&
                extension.Span.ContainsInclusive(offset))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>The x:Name/bare Name literal the caret sits inside (the declaration), or null.</summary>
    private static string? FindNameDeclarationAt(TextDocument doc, int offset) =>
        DeclarationValueAt(doc, offset, static name =>
            string.Equals(name.LocalName, "Name", StringComparison.Ordinal) &&
            (!name.HasPrefix || string.Equals(name.Prefix, "x", StringComparison.Ordinal)));

    /// <summary>The <c>x:Key</c> literal the caret sits inside (the declaration), or null. Only the <c>x:</c>-prefixed form is a resource key.</summary>
    private static string? FindKeyDeclarationAt(TextDocument doc, int offset) =>
        DeclarationValueAt(doc, offset, static name =>
            name.HasPrefix && string.Equals(name.Prefix, "x", StringComparison.Ordinal) &&
            string.Equals(name.LocalName, "Key", StringComparison.Ordinal));

    /// <summary>The trimmed value of a non-markup attribute whose name matches nameMatches and whose value literal contains the caret — used to start a reference search from the declaration.</summary>
    private static string? DeclarationValueAt(TextDocument doc, int offset, Func<XamlName, bool> nameMatches)
    {
        for (var current = doc.Parsed.FindNode(offset); current != null; current = current.Parent)
        {
            if (current is XamlAttribute attr && !attr.IsNamespaceDeclaration &&
                attr.Value is { IsMarkupExtension: false } value && value.InnerSpan.ContainsInclusive(offset) &&
                nameMatches(attr.Name))
            {
                var text = value.Text.Trim();
                return text.Length > 0 ? text : null;
            }

            if (current is XamlElement)
            {
                break;
            }
        }

        return null;
    }

    /// <summary>The span of an attribute value's inner text with surrounding whitespace stripped</summary>
    private static TextSpan TrimmedValueSpan(XamlAttributeValue value)
    {
        var text = value.Text;
        int lead = 0;
        while (lead < text.Length && char.IsWhiteSpace(text[lead]))
        {
            lead++;
        }

        int trail = text.Length;
        while (trail > lead && char.IsWhiteSpace(text[trail - 1]))
        {
            trail--;
        }

        int start = value.InnerSpan.Start;
        return new TextSpan(start + lead, start + trail);
    }

    /// <summary>Collects, into results, the x:Name/bare Name declaration literal (flagged as declaration) plus every named-element usage of name in the subtree</summary>
    private static void CollectNameOccurrences(
        XamlElement element, string name, TextDocument doc, List<(Lsp.Range Range, bool IsDeclaration)> results)
    {
        if ((element.GetAttribute("x:Name") ?? element.GetAttribute("Name")) is { Value: { IsMarkupExtension: false } declValue } &&
            string.Equals(declValue.Text.Trim(), name, StringComparison.Ordinal))
        {
            results.Add((doc.RangeOf(TrimmedValueSpan(declValue)), true));
        }

        foreach (var attr in element.Attributes)
        {
            if (attr.IsNamespaceDeclaration)
            {
                continue;
            }

            // Storyboard.TargetName="Foo" (a plain element-name attribute value).
            if (attr.Value is { IsMarkupExtension: false } plain && IsNameReferenceAttribute(attr.Name) &&
                string.Equals(plain.Text.Trim(), name, StringComparison.Ordinal))
            {
                results.Add((doc.RangeOf(TrimmedValueSpan(plain)), false));
            }

            // VSM <Setter Target="Element.Property"> — only the element-name segment (before the first dot) names an x:Name'd element; the ".Property" tail is a member on that element.
            if (element.Name is { HasPrefix: false, LocalName: "Setter" } &&
                !attr.Name.HasPrefix && string.Equals(attr.Name.LocalName, "Target", StringComparison.Ordinal) &&
                SetterTargetElementSpan(attr.Value) is { } target &&
                string.Equals(target.Element, name, StringComparison.Ordinal))
            {
                results.Add((doc.RangeOf(target.Span), false));
            }

            // {Binding ElementName=Foo} — any markup extension with a matching named ElementName argument.
            if (attr.Value?.MarkupExtension is { } ext)
            {
                ForEachExtension(ext, e =>
                {
                    foreach (var arg in e.Arguments)
                    {
                        if (arg.IsNamed &&
                            string.Equals(arg.Name?.LocalName, "ElementName", StringComparison.Ordinal) &&
                            arg.Value is { Length: > 0 } v && string.Equals(v.Trim(), name, StringComparison.Ordinal) &&
                            arg.ValueSpan is { } vs)
                        {
                            results.Add((doc.RangeOf(vs), false));
                        }
                    }
                });
            }
        }

        foreach (var child in element.Content)
        {
            if (child is XamlElement childElement)
            {
                CollectNameOccurrences(childElement, name, doc, results);
            }
        }
    }

    /// <summary>Collects, into results, the x:Key declaration literal (flagged as declaration) plus every {StaticResource}/{ThemeResource}/{CustomResource} usage of key in the subtree (including</summary>
    private static void CollectResourceOccurrences(
        XamlElement element, string key, TextDocument doc, List<(Lsp.Range Range, bool IsDeclaration)> results)
    {
        if (element.GetAttribute("x:Key") is { Value: { IsMarkupExtension: false } keyValue } &&
            string.Equals(keyValue.Text.Trim(), key, StringComparison.Ordinal))
        {
            results.Add((doc.RangeOf(TrimmedValueSpan(keyValue)), true));
        }

        foreach (var attr in element.Attributes)
        {
            if (attr.Value?.MarkupExtension is { } ext)
            {
                ForEachExtension(ext, e =>
                {
                    if (e.Name is not { HasPrefix: false } n ||
                        n.LocalName is not ("StaticResource" or "ThemeResource" or "CustomResource"))
                    {
                        return;
                    }

                    foreach (var arg in e.Arguments)
                    {
                        if (!arg.IsNamed && arg.Value is { Length: > 0 } v &&
                            string.Equals(v.Trim(), key, StringComparison.Ordinal))
                        {
                            results.Add((doc.RangeOf(arg.ValueSpan ?? arg.Span), false));
                        }
                    }
                });
            }
        }

        foreach (var child in element.Content)
        {
            if (child is XamlElement childElement)
            {
                CollectResourceOccurrences(childElement, key, doc, results);
            }
        }
    }

    /// <summary>Invokes action on extension and each nested extension, but prunes any unterminated (malformed / still-being-typed) extension subtree</summary>
    private static void ForEachExtension(XamlMarkupExtension extension, Action<XamlMarkupExtension> action)
    {
        if (!extension.IsClosed)
        {
            return;
        }

        action(extension);
        foreach (var arg in extension.Arguments)
        {
            if (arg.NestedExtension is { } nested)
            {
                ForEachExtension(nested, action);
            }
        }
    }

    /// <summary>Removes duplicate ranges and orders the occurrences by document position.</summary>
    private static List<(Lsp.Range Range, bool IsDeclaration)> DedupeAndSort(List<(Lsp.Range Range, bool IsDeclaration)> occurrences) =>
        occurrences
            .GroupBy(o => (o.Range.Start.Line, o.Range.Start.Character, o.Range.End.Line, o.Range.End.Character))
            .Select(g => g.First())
            .OrderBy(o => o.Range.Start.Line).ThenBy(o => o.Range.Start.Character)
            .ToList();

    /// <summary>F12 on a {StaticResource Key} / {ThemeResource Key} / {CustomResource Key} value: navigates to the matching x:Key declaration in the current document</summary>
    private async Task<object?> ResolveResourceKeyDefinitionAsync(TextDocumentPositionParams p) =>
        (await ResolveResourceReferenceAsync(p).ConfigureAwait(false))?.Declaration;

    /// <summary>Hover over a resource-key reference: shows the referenced resource's element type and where it is declared (this file or App.xaml).</summary>
    private async Task<Hover?> ResolveResourceKeyHoverAsync(TextDocumentPositionParams p)
    {
        var hit = await ResolveResourceReferenceAsync(p).ConfigureAwait(false);
        if (hit == null)
        {
            return null;
        }

        var typePrefix = string.IsNullOrEmpty(hit.Value.TypeName) ? string.Empty : hit.Value.TypeName + " ";
        return new Hover
        {
            Contents = new MarkupContent
            {
                Kind = "markdown",
                Value = $"```csharp\n(resource) {typePrefix}\"{hit.Value.Key}\"\n```\nDefined in {hit.Value.FileLabel}",
            },
            Range = hit.Value.ReferenceRange,
        };
    }

    /// <summary>Shared resolver for resource-key definition and hover: detects a resource reference under the caret</summary>
    private async Task<ResourceReferenceHit?> ResolveResourceReferenceAsync(TextDocumentPositionParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc))
        {
            return null;
        }

        int offset = doc.OffsetAt(p.Position);
        var reference = FindResourceKeyReferenceAt(doc, offset);
        if (reference == null)
        {
            return null;
        }

        var (key, referenceSpan) = reference.Value;
        var referenceRange = doc.RangeOf(referenceSpan);

        // 1) The current document, resolved in lexical scope (nearest <Owner.Resources> wins) so an inner dictionary shadows an outer one; fall back to a document-wide search for keys outside the reference's ancestor scopes.
        var referenceElement = NearestEnclosingElement(doc, offset);
        var local = (referenceElement != null ? FindResourceDeclarationScoped(referenceElement, key) : null)
            ?? FindResourceDeclaration(doc.Parsed, key);
        if (local != null)
        {
            return new ResourceReferenceHit(
                key,
                referenceRange,
                new Lsp.Location { Uri = doc.Uri, Range = doc.RangeOf(local.Value.NavSpan) },
                local.Value.TypeName,
                "this file");
        }

        // 2) The project's App.xaml and every reachable merged ResourceDictionary.
        var context = await GetContextAsync(p.TextDocument.Uri).ConfigureAwait(false);
        if (context == null)
        {
            return null;
        }

        var appXaml = FindAppXamlPath(context.Value.Resolution);
        if (appXaml == null)
        {
            return null;
        }

        var projectRoot = System.IO.Path.GetDirectoryName(context.Value.Resolution.ProjectPath)!;
        foreach (var resourceFile in ReadResourceGraph(appXaml, projectRoot))
        {
            var declaration = FindResourceDeclaration(resourceFile.Parsed, key);
            if (declaration is null)
            {
                continue;
            }

            return new ResourceReferenceHit(
                key,
                referenceRange,
                new Lsp.Location
                {
                    Uri = PathToUri(resourceFile.Path),
                    Range = SpanToRange(resourceFile.Text, declaration.Value.NavSpan),
                },
                declaration.Value.TypeName,
                System.IO.Path.GetFileName(resourceFile.Path));
        }

        return null;
    }

    // --- Named-element references (ElementName / Storyboard.TargetName) ------

    /// <summary>F12/hover shared resolver for a named-element reference under the caret: a classic {Binding ElementName=Foo} argument or a Storyboard.TargetName="Foo" attribute value.</summary>
    private async Task<NameReferenceHit?> ResolveNameReferenceAsync(TextDocumentPositionParams p)
    {
        await Task.CompletedTask.ConfigureAwait(false);
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc) || doc.Parsed.Root is not { } root)
        {
            return null;
        }

        int offset = doc.OffsetAt(p.Position);
        var reference = FindNameReferenceAt(doc, offset);
        if (reference == null)
        {
            return null;
        }

        var (name, referenceSpan) = reference.Value;
        var declaration = FindNamedElement(root, name);
        if (declaration == null)
        {
            return null;
        }

        return new NameReferenceHit(
            name,
            doc.RangeOf(referenceSpan),
            new Lsp.Location { Uri = doc.Uri, Range = doc.RangeOf(declaration.Value.NavSpan) },
            declaration.Value.TypeName);
    }

    /// <summary>Hover for a named-element reference: identifies the referenced element and its type.</summary>
    private async Task<Hover?> ResolveNameReferenceHoverAsync(TextDocumentPositionParams p)
    {
        var hit = await ResolveNameReferenceAsync(p).ConfigureAwait(false);
        if (hit == null)
        {
            return null;
        }

        var typePrefix = string.IsNullOrEmpty(hit.Value.TypeName) ? string.Empty : hit.Value.TypeName + " ";
        return new Hover
        {
            Contents = new MarkupContent
            {
                Kind = "markdown",
                Value = $"```csharp\n(element) {typePrefix}\"{hit.Value.Name}\"\n```",
            },
            Range = hit.Value.ReferenceRange,
        };
    }

    /// <summary>Detects a named-element reference at offset: the value of a {Binding (or other) ElementName= named argument, or a Storyboard.TargetName="..." attribute value.</summary>
    private static (string Name, TextSpan Span)? FindNameReferenceAt(TextDocument doc, int offset)
    {
        if (doc.Parsed.Root is not { } root)
        {
            return null;
        }

        // 1) A markup-extension named "ElementName" argument ({Binding ElementName=Foo}).
        var extension = InnermostMarkupExtensionAt(root, offset);
        if (extension is not null)
        {
            foreach (var argument in extension.Arguments)
            {
                if (argument.IsNamed &&
                    string.Equals(argument.Name?.LocalName, "ElementName", StringComparison.Ordinal) &&
                    argument.Value is { Length: > 0 } name &&
                    argument.ValueSpan is { } valueSpan &&
                    valueSpan.ContainsInclusive(offset))
                {
                    return (name.Trim(), valueSpan);
                }
            }
        }

        // 2) A plain Storyboard.TargetName="Foo" attribute value (an element name, not a member).
        for (var current = doc.Parsed.FindNode(offset); current != null; current = current.Parent)
        {
            if (current is XamlAttribute attr && !attr.IsNamespaceDeclaration &&
                attr.Value is { IsMarkupExtension: false } value && value.Span.ContainsInclusive(offset) &&
                IsNameReferenceAttribute(attr.Name))
            {
                var text = value.Text.Trim();
                return text.Length > 0 ? (text, value.InnerSpan) : ((string, TextSpan)?)null;
            }

            // A VSM <Setter Target="Element.Property"> value: only the element-name segment (before the first dot) is a name reference; a caret in the ".Property" tail falls through (not a name).
            if (current is XamlAttribute setterAttr &&
                setterAttr.Parent is XamlElement { Name: { HasPrefix: false, LocalName: "Setter" } } &&
                !setterAttr.Name.HasPrefix &&
                string.Equals(setterAttr.Name.LocalName, "Target", StringComparison.Ordinal) &&
                SetterTargetElementSpan(setterAttr.Value) is { } target && target.Span.ContainsInclusive(offset))
            {
                return (target.Element, target.Span);
            }

            if (current is XamlElement)
            {
                break;
            }
        }

        return null;
    }

    /// <summary>The element-name segment of a VSM &lt;Setter Target="Element.Property"&gt; value — the token before the first dot with surrounding whitespace stripped — plus its span</summary>
    private static (string Element, TextSpan Span)? SetterTargetElementSpan(XamlAttributeValue? value)
    {
        if (value is not { IsMarkupExtension: false })
        {
            return null;
        }

        var text = value.Text;
        int lead = 0;
        while (lead < text.Length && char.IsWhiteSpace(text[lead]))
        {
            lead++;
        }

        int end = text.IndexOf('.', lead);
        if (end < 0)
        {
            end = text.Length;
        }

        while (end > lead && char.IsWhiteSpace(text[end - 1]))
        {
            end--;
        }

        if (end <= lead)
        {
            return null;
        }

        int start = value.InnerSpan.Start;
        return (text.Substring(lead, end - lead), new TextSpan(start + lead, start + end));
    }

    /// <summary>Attribute names whose (bare) value is an element x:Name reference (not a CLR member or type)</summary>
    private static bool IsNameReferenceAttribute(XamlName name) =>
        !name.HasPrefix &&
        (string.Equals(name.LocalName, "Storyboard.TargetName", StringComparison.Ordinal) ||
         CompletionProvider.RelativePanelAlignmentTargets.Contains(name.LocalName));

    /// <summary>Finds the element declaring x:Name="name" (or Name="name") anywhere in the document and returns its element type name plus the span of the name literal to navigate to, or null.</summary>
    private static (string TypeName, TextSpan NavSpan)? FindNamedElement(XamlElement element, string name)
    {
        var attr = element.GetAttribute("x:Name") ?? element.GetAttribute("Name");
        if (attr?.Value is { } value && !value.IsMarkupExtension &&
            string.Equals(value.Text.Trim(), name, StringComparison.Ordinal))
        {
            var typeName = element.Name is { LocalName.Length: > 0 } elementName ? elementName.FullName : string.Empty;
            return (typeName, value.InnerSpan);
        }

        foreach (var child in element.Content)
        {
            if (child is XamlElement childElement)
            {
                var hit = FindNamedElement(childElement, name);
                if (hit != null)
                {
                    return hit;
                }
            }
        }

        return null;
    }

    // --- Attached-property hover --------------------------------------------

    /// <summary>Hover for an attached property referenced by an attribute name (Grid.Row="1") or by a &lt;Setter Property="Grid.Row"&gt; value.</summary>
    private async Task<Hover?> ResolveAttachedPropertyHoverAsync(TextDocumentPositionParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc))
        {
            return null;
        }

        int offset = doc.OffsetAt(p.Position);

        XamlAttribute? attr = null;
        for (var current = doc.Parsed.FindNode(offset); current != null; current = current.Parent)
        {
            if (current is XamlAttribute a)
            {
                attr = a;
                break;
            }

            if (current is XamlElement)
            {
                break;
            }
        }

        if (attr is null || attr.IsNamespaceDeclaration ||
            attr.Parent is not XamlElement { Name: { } ownerElementName } ownerElement)
        {
            return null;
        }

        string ownerName;
        string memberName;
        TextSpan hoverSpan;

        // Case 1: caret on a dotted attached-property attribute name (Grid.Row="1").
        if (!attr.Name.HasPrefix && attr.Name.IsDotted && attr.Name.Span.ContainsInclusive(offset))
        {
            int dot = attr.Name.LocalName.LastIndexOf('.');
            ownerName = attr.Name.LocalName.Substring(0, dot);
            memberName = attr.Name.LocalName.Substring(dot + 1);
            hoverSpan = attr.Name.Span;
        }
        // Case 2: caret in a <Setter Property="Grid.Row"> value (dotted -> attached property).
        else if (!attr.Name.HasPrefix && string.Equals(attr.Name.LocalName, "Property", StringComparison.Ordinal) &&
                 string.Equals(ownerElementName.LocalName, "Setter", StringComparison.Ordinal) &&
                 !ownerElementName.HasPrefix &&
                 attr.Value is { IsMarkupExtension: false } setterValue &&
                 setterValue.Span.ContainsInclusive(offset))
        {
            var text = setterValue.Text.Trim();
            int dot = text.IndexOf('.');
            if (dot <= 0 || dot >= text.Length - 1)
            {
                return null;
            }

            ownerName = text.Substring(0, dot);
            memberName = text.Substring(dot + 1);
            hoverSpan = setterValue.InnerSpan;
        }
        else
        {
            return null;
        }

        var typeSystem = await GetTypeSystemAsync(p.TextDocument.Uri).ConfigureAwait(false);
        if (typeSystem == null)
        {
            return null;
        }

        var ownerType = ResolveXamlTypeName(ownerName, ownerElement.NamespaceScope, typeSystem);
        if (ownerType == null)
        {
            return null;
        }

        var attached = typeSystem.GetAttachedProperties(ownerType)
            .FirstOrDefault(m => string.Equals(m.Name, memberName, StringComparison.Ordinal));
        if (attached == null)
        {
            return null;
        }

        var valueType = attached.Type?.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat) ?? "object";
        return new Hover
        {
            Contents = new MarkupContent
            {
                Kind = "markdown",
                Value = HoverMarkdown($"(attached property) {valueType} {ownerType.Name}.{attached.Name}", attached.Symbol, methodDetails: false),
            },
            Range = doc.RangeOf(hoverSpan),
        };
    }

    /// <summary>Hover for an x:Bind attached-property path step ({x:Bind (Grid.Row)}): resolves the parenthesized Owner.Member to an attached property on the owner type and renders it exactly</summary>
    private async Task<Hover?> ResolveBindAttachedHoverAsync(TextDocumentPositionParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc))
        {
            return null;
        }

        int offset = doc.OffsetAt(p.Position);
        if (FindBindAttachedAt(doc, offset) is not { } hit)
        {
            return null;
        }

        var typeSystem = await GetTypeSystemAsync(p.TextDocument.Uri).ConfigureAwait(false);
        if (typeSystem == null)
        {
            return null;
        }

        var ownerType = ResolveXamlTypeName(hit.Owner, hit.Scope, typeSystem);
        if (ownerType == null)
        {
            return null;
        }

        var attached = typeSystem.GetAttachedProperties(ownerType)
            .FirstOrDefault(m => string.Equals(m.Name, hit.Member, StringComparison.Ordinal));
        if (attached == null)
        {
            return null;
        }

        var valueType = attached.Type?.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat) ?? "object";
        return new Hover
        {
            Contents = new MarkupContent
            {
                Kind = "markdown",
                Value = HoverMarkdown($"(attached property) {valueType} {ownerType.Name}.{attached.Name}", attached.Symbol, methodDetails: false),
            },
            Range = doc.RangeOf(hit.Span),
        };
    }

    /// <summary>Locates an x:Bind attached-property path step ((Owner.Member)) under offset: the caret must sit inside the parentheses of the first positional (or Path=) argument of an {x:Bind}</summary>
    private static BindAttachedHit? FindBindAttachedAt(TextDocument doc, int offset)
    {
        for (var current = doc.Parsed.FindNode(offset); current != null; current = current.Parent)
        {
            if (current is not XamlMarkupExtensionArgument arg)
            {
                continue;
            }

            if (arg.Value == null || arg.ValueSpan is not { } valueSpan)
            {
                return null;
            }

            if (arg.IsNamed && arg.Name?.LocalName != "Path")
            {
                return null;
            }

            if (arg.Parent is not XamlMarkupExtension ext || ext.Name?.LocalName != "Bind")
            {
                return null;
            }

            if (!valueSpan.ContainsInclusive(offset))
            {
                return null;
            }

            // Skip a leading negation/whitespace, then require an opening '(' (the attached-property step).
            string raw = arg.Value;
            int open = 0;
            while (open < raw.Length && (raw[open] == '!' || char.IsWhiteSpace(raw[open])))
            {
                open++;
            }

            if (open >= raw.Length || raw[open] != '(')
            {
                return null;
            }

            int close = raw.IndexOf(')', open + 1);
            if (close < 0)
            {
                return null;
            }

            // Locate the dot separating Owner.Member within the parentheses (raw coordinates).
            int innerStart = open + 1;
            int dot = raw.LastIndexOf('.', close - 1, close - innerStart);
            if (dot <= innerStart || dot >= close - 1)
            {
                return null; // not an Owner.Member form (a dot-less cast is handled by the member walk)
            }

            // The caret must sit on the Member portion (after the dot) -- hovering the Owner type or the dot itself is not the attached property, so it must not render the attached-property hover.
            int rel = offset - valueSpan.Start;
            if (rel <= dot || rel > close)
            {
                return null;
            }

            var scope = NearestElementScope(arg) ?? doc.Parsed.Root?.NamespaceScope;
            if (scope == null)
            {
                return null;
            }

            string owner = raw.Substring(innerStart, dot - innerStart).Trim();
            string member = raw.Substring(dot + 1, close - dot - 1).Trim();
            if (owner.Length == 0 || member.Length == 0)
            {
                return null;
            }

            // Span covers just the member identifier so the hover highlight is precise.
            var span = new TextSpan(valueSpan.Start + dot + 1, valueSpan.Start + close);
            return new BindAttachedHit(owner, member, scope, span);
        }

        return null;
    }

}
