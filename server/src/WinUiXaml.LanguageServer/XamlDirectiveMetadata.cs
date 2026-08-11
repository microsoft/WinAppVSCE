using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Workspace;
using WinUiXaml.Xaml;

namespace WinUiXaml.LanguageServer;

/// <summary>Project-independent quick info for XAML language and markup-compatibility directives.</summary>
internal static class XamlDirectiveMetadata
{
    private static readonly IReadOnlyDictionary<string, DirectiveInfo> XamlDirectives =
        new Dictionary<string, DirectiveInfo>(StringComparer.Ordinal)
        {
            ["Class"] = new("x:Class", "Identifies the CLR class generated for and associated with this XAML root."),
            ["Name"] = new("x:Name", "Declares a name for an object in the current XAML namescope so code and bindings can reference it."),
            ["Key"] = new("x:Key", "Declares the key used to retrieve this object from a XAML resource dictionary."),
            ["DataType"] = new("x:DataType", "Specifies the data type used to compile bindings in the containing template or scope."),
            ["DefaultBindMode"] = new("x:DefaultBindMode", "Sets the default mode for compiled x:Bind expressions in this XAML scope."),
            ["FieldModifier"] = new("x:FieldModifier", "Sets the access level of the generated field for a named XAML object."),
            ["Load"] = new("x:Load", "Controls whether the XAML object is created and added to the visual tree."),
            ["Phase"] = new("x:Phase", "Assigns a compiled binding to an incremental data-template rendering phase."),
            ["Uid"] = new("x:Uid", "Identifies localized resources that provide property values for this XAML object."),
        };

    private static readonly IReadOnlyDictionary<string, DirectiveInfo> XamlExtensions =
        new Dictionary<string, DirectiveInfo>(StringComparer.Ordinal)
        {
            ["Bind"] = new("{x:Bind}", "Creates a compiled binding resolved against the page x:Class or enclosing x:DataType."),
            ["Null"] = new("{x:Null}", "Supplies a null reference value."),
            ["Static"] = new("{x:Static}", "References a static field, property, or constant."),
            ["Type"] = new("{x:Type}", "Supplies the System.Type represented by a XAML type name."),
        };

    private static readonly DirectiveInfo Ignorable = new(
        "mc:Ignorable",
        "Lists namespace prefixes that XAML processors may ignore when they do not recognize those namespaces.");

    public static DirectiveQuickInfo? Resolve(TextDocument document, int offset)
    {
        for (var node = document.Parsed.FindNode(offset); node is not null; node = node.Parent)
        {
            if (node is XamlAttribute attribute &&
                attribute.Name.Span.ContainsInclusive(offset) &&
                attribute.Parent is XamlElement owner &&
                owner.NamespaceScope.TryResolvePrefix(attribute.Name.Prefix, out var uri))
            {
                var info = uri switch
                {
                    XamlTypeSystem.XamlLanguageNamespace
                        when XamlDirectives.TryGetValue(attribute.Name.LocalName, out var directive) => directive,
                    XamlNamespaces.MarkupCompatibility
                        when string.Equals(attribute.Name.LocalName, "Ignorable", StringComparison.Ordinal) => Ignorable,
                    _ => null,
                };
                return info is null ? null : ToQuickInfo(info, document.RangeOf(attribute.Name.Span));
            }

            if (node is XamlMarkupExtension extension &&
                extension.Name is { } name &&
                name.Span.ContainsInclusive(offset))
            {
                var scope = FindScope(extension);
                if (scope is not null &&
                    scope.TryResolvePrefix(name.Prefix, out var extensionUri) &&
                    extensionUri == XamlTypeSystem.XamlLanguageNamespace &&
                    XamlExtensions.TryGetValue(name.LocalName, out var extensionInfo))
                {
                    return ToQuickInfo(extensionInfo, document.RangeOf(name.Span));
                }
            }
        }

        return null;
    }

    private static XamlNamespaceScope? FindScope(XamlNode node)
    {
        for (var current = node.Parent; current is not null; current = current.Parent)
        {
            if (current is XamlElement element)
            {
                return element.NamespaceScope;
            }
        }
        return null;
    }

    private static DirectiveQuickInfo ToQuickInfo(DirectiveInfo info, Lsp.Range range) =>
        new($"```xaml\n{info.Signature}\n```\n\n{info.Description}", range);

    private sealed record DirectiveInfo(string Signature, string Description);
}

internal sealed record DirectiveQuickInfo(string Markdown, Lsp.Range Range);
