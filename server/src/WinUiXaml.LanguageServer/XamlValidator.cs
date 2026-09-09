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
internal static partial class XamlValidator
{
    /// <summary>An undeclared xmlns prefix — certain, so reported as an error.</summary>
    public const string UndeclaredPrefixCode = "WXAML0001";

    /// <summary>A type not found in a known namespace.</summary>
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

    /// <summary>An <c>x:Bind</c> function has no overload accepting the supplied arguments.</summary>
    public const string InvalidBindFunctionCode = "WXAML0011";

    /// <summary>A literal attribute value cannot be converted to the property's primitive or enum type.</summary>
    public const string InvalidAttributeValueCode = "WXAML0012";

    /// <summary>A resource key closely resembles a known key but does not resolve.</summary>
    public const string UnknownResourceKeyCode = "WXAML0013";

    /// <summary>An x:Name value does not follow XAML identifier grammar.</summary>
    public const string InvalidNameCode = "WXAML0014";
    /// <summary>A plain event-handler name is absent from the resolved x:Class hierarchy.</summary>
    public const string MissingEventHandlerCode = "WXAML0015";
    /// <summary>More than one object is assigned to a scalar content property.</summary>
    public const string MultipleScalarChildrenCode = "WXAML0016";
    /// <summary>A Setter names no property on its resolved Style.TargetType.</summary>
    public const string InvalidSetterPropertyCode = "WXAML0017";
    /// <summary>An x:Bind in a DataTemplate has no local x:DataType.</summary>
    public const string DataTemplateDataTypeRequiredCode = "WXAML0018";
    /// <summary>An expanded attribute name occurs more than once on an element.</summary>
    public const string DuplicateAttributeCode = "WXAML0019";
    /// <summary>A resolved property-element child is not assignable to the property's item type.</summary>
    public const string InvalidPropertyElementChildCode = "WXAML0020";
    /// <summary>The resolved x:Class is not assignable to the resolved root element type.</summary>
    public const string InvalidRootClassCode = "WXAML0021";
    /// <summary>An x:Bind Mode is absent from the SDK BindingMode enum.</summary>
    public const string InvalidBindModeCode = "WXAML0022";
    /// <summary>An x:Class directive names no type in the authoritative project compilation.</summary>
    public const string UnknownRootClassCode = "WXAML0023";
    /// <summary>A named argument is not exposed by the resolved Binding type.</summary>
    public const string UnknownBindingArgumentCode = "WXAML0024";
    /// <summary>A classic Binding enum argument has an invalid value.</summary>
    public const string InvalidBindingValueCode = "WXAML0025";
    /// <summary>A RelativeSource argument or mode is invalid.</summary>
    public const string InvalidRelativeSourceCode = "WXAML0026";
    /// <summary>A Binding ElementName is absent from the applicable XAML namescope.</summary>
    public const string UnknownBindingElementNameCode = "WXAML0027";
    /// <summary>A TemplateBinding path is absent from the authoritative template target type.</summary>
    public const string InvalidTemplateBindingCode = "WXAML0028";
    /// <summary>An x:DataType names a missing type in a known namespace.</summary>
    public const string UnknownDataTypeCode = "WXAML0029";
    /// <summary>An x:Bind result is definitely not assignable to its target property.</summary>
    public const string InvalidBindAssignmentCode = "WXAML0030";
    /// <summary>An x:Bind path names an inaccessible member.</summary>
    public const string InaccessibleBindMemberCode = "WXAML0031";
    /// <summary>An event handler exists but no overload matches the event delegate.</summary>
    public const string IncompatibleEventHandlerCode = "WXAML0032";
    /// <summary>A using:/clr-namespace: declaration resolves to no usable compilation namespace.</summary>
    public const string UnknownNamespaceDeclarationCode = "WXAML0033";
    /// <summary>A local Style resource cannot be applied to the consuming element's resolved type.</summary>
    public const string InvalidStyleTargetTypeCode = "WXAML0034";
    /// <summary>An <c>x:Bind</c> expression uses syntax unsupported by the WinUI XAML compiler.</summary>
    public const string InvalidBindSyntaxCode = "WXAML0035";
    /// <summary>Classic Binding in an untyped DataTemplate is not safe for Native AOT.</summary>
    public const string BindingDataTypeRecommendedCode = "WMC1510";

    private const int SeverityError = 1;
    private const int SeverityWarning = 2;
    private static readonly HashSet<string> ReservedPrefixes = new(System.StringComparer.Ordinal)
    {
        "xml", "xmlns",
    };

    public static List<Diagnostic> Validate(
        TextDocument doc,
        XamlTypeSystem typeSystem,
        IReadOnlyCollection<string>? projectResourceKeys = null,
        bool resourceCatalogIsAuthoritative = true)
    {
        var diagnostics = new List<Diagnostic>();
        if (doc.Parsed.Root is { } root)
        {
            var resourceKeys = new HashSet<string>(System.StringComparer.Ordinal);
            if (projectResourceKeys is not null)
            {
                foreach (var key in projectResourceKeys)
                {
                    resourceKeys.Add(key);
                }
            }

            // Unresolved binding roots remain silent to avoid false positives.
            var resourceIndex = XamlSemanticFacts.CreateResourceIndex(root, typeSystem);
            var pageClass = ResolvePageClass(root, typeSystem);
            ValidateRootClassExists(root, pageClass, doc, diagnostics);
            ValidateRootClass(root, pageClass, typeSystem, doc, diagnostics);
            Walk(root, doc, typeSystem, diagnostics, pageClass, pageClass, resourceKeys, resourceIndex, resourceCatalogIsAuthoritative, styleTargetType: null, dataTemplateNeedsDataType: false, dataTypeSuggestion: null);

            ValidateUniqueNames(root, doc, typeSystem, diagnostics);
            ValidateUniqueResourceKeys(root, doc, typeSystem, diagnostics);
        }

        return diagnostics;
    }

    private static void Walk(
        XamlElement element,
        TextDocument doc,
        XamlTypeSystem typeSystem,
        List<Diagnostic> diagnostics,
        INamedTypeSymbol? bindRoot,
        INamedTypeSymbol? pageClass,
        IReadOnlySet<string> resourceKeys,
        XamlSemanticFacts.ResourceScopeIndex resourceIndex,
        bool resourceCatalogIsAuthoritative,
        INamedTypeSymbol? styleTargetType,
        bool dataTemplateNeedsDataType,
        DiagnosticData? dataTypeSuggestion)
    {
        var elementType = ResolveElementType(element, typeSystem);

        // A template creates a new binding root. It must not inherit the page's x:Bind root.
        var effectiveRoot = bindRoot;
        var effectiveTemplateNeedsDataType = dataTemplateNeedsDataType;
        var effectiveDataTypeSuggestion = dataTypeSuggestion;
        if (elementType is not null &&
            typeSystem.Capabilities.DataTemplate is { } dataTemplate &&
            XamlTypeSystem.IsAssignableTo(elementType, dataTemplate))
        {
            effectiveRoot = null;
            effectiveTemplateNeedsDataType = !TryGetDirectiveValue(element, "DataType", out _);
            effectiveDataTypeSuggestion = effectiveTemplateNeedsDataType
                ? InferDataTemplateType(element, bindRoot, typeSystem, doc)
                : null;
        }

        // An unresolved x:DataType disables binding checks for its subtree.
        if (TryGetDirectiveValue(element, "DataType", out var dataTypeText))
        {
            effectiveRoot = ResolveTypeName(dataTypeText, element.NamespaceScope, typeSystem);
            effectiveTemplateNeedsDataType = false;
            effectiveDataTypeSuggestion = null;
            if (effectiveRoot is null)
            {
                ValidateDataType(element, dataTypeText, typeSystem, doc, diagnostics);
            }
        }

        var effectiveStyleTarget = styleTargetType;
        if (elementType is not null &&
            ((typeSystem.Capabilities.Style is { } styleType &&
              XamlTypeSystem.IsAssignableTo(elementType, styleType)) ||
             (typeSystem.Capabilities.ControlTemplate is { } controlTemplate &&
              XamlTypeSystem.IsAssignableTo(elementType, controlTemplate))))
        {
            effectiveStyleTarget = TryResolveTypeAttribute(element, "TargetType", typeSystem);
        }

        ValidateElement(element, elementType, doc, typeSystem, diagnostics, effectiveRoot, pageClass, effectiveStyleTarget, effectiveTemplateNeedsDataType, effectiveDataTypeSuggestion);
        ValidateResourceReferences(
            element,
            elementType,
            doc,
            typeSystem,
            diagnostics,
            resourceKeys,
            resourceIndex,
            resourceCatalogIsAuthoritative);

        foreach (var child in element.Content)
        {
            if (child is XamlElement childElement)
            {
                Walk(childElement, doc, typeSystem, diagnostics, effectiveRoot, pageClass, resourceKeys, resourceIndex, resourceCatalogIsAuthoritative, effectiveStyleTarget, effectiveTemplateNeedsDataType, effectiveDataTypeSuggestion);
            }
        }
    }

    private static void ValidateRootClassExists(
        XamlElement root,
        INamedTypeSymbol? pageClass,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        if (pageClass is not null ||
            XamlSemanticFacts.GetDirectiveAttribute(root, "Class")?.Value is not { } value)
        {
            return;
        }

        var className = value.Text.Trim();
        if (className.Length > 0)
        {
            diagnostics.Add(Diag(
                doc,
                value.InnerSpan,
                SeverityError,
                UnknownRootClassCode,
                $"The x:Class type '{className}' was not found in the project compilation."));
        }
    }

    private static void ValidateRootClass(
        XamlElement root,
        INamedTypeSymbol? pageClass,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        if (pageClass is null || ResolveElementType(root, typeSystem) is not { } rootType ||
            XamlTypeSystem.IsAssignableTo(pageClass, rootType))
        {
            return;
        }

        var classAttribute = XamlSemanticFacts.GetDirectiveAttribute(root, "Class");
        if (classAttribute?.Value is { } value)
        {
            diagnostics.Add(Diag(doc, value.InnerSpan, SeverityError, InvalidRootClassCode,
                $"The x:Class type '{pageClass.ToDisplayString()}' is not assignable to the root element type '{rootType.ToDisplayString()}'."));
        }
    }

    private static void ReportUndeclaredPrefix(
        XamlName name, XamlNamespaceScope scope, TextDocument doc, List<Diagnostic> diagnostics)
    {
        if (name.HasPrefix && !ReservedPrefixes.Contains(name.Prefix!) &&
            !scope.TryResolvePrefix(name.Prefix, out _))
        {
            diagnostics.Add(Diag(doc, name.PrefixSpan ?? name.Span, SeverityError, UndeclaredPrefixCode,
                $"The namespace prefix '{name.Prefix}' is not declared.",
                GetUniqueNamespaceSuggestion(name.Prefix!, string.Empty, typeSystem: null)));
        }
    }

    private static DiagnosticData? GetUniqueNamespaceSuggestion(
        string prefix,
        string localTypeName,
        XamlTypeSystem? typeSystem)
    {
        var standardNamespace = prefix switch
        {
            "x" => XamlTypeSystem.XamlLanguageNamespace,
            "d" => "http://schemas.microsoft.com/expression/blend/2008",
            "mc" => "http://schemas.openxmlformats.org/markup-compatibility/2006",
            _ => null,
        };
        if (standardNamespace is not null)
        {
            return new DiagnosticData
            {
                Bad = prefix,
                Suggestions = [standardNamespace],
            };
        }

        if (typeSystem is null)
        {
            return null;
        }

        var namespaces = typeSystem.FindNamespacesForTypeName(localTypeName);
        return namespaces.Count == 1
            ? new DiagnosticData
            {
                Bad = prefix,
                Suggestions = [$"using:{namespaces[0]}"],
            }
            : null;
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

    private static DiagnosticData? SuggestNamespaceData(
        string bad,
        IEnumerable<string> usingNamespaces)
    {
        var candidates = usingNamespaces.Select(ns => $"using:{ns}").ToArray();
        if (SuggestData(bad, candidates) is { } nearest)
        {
            return nearest;
        }

        var badSegments = NormalizeNamespace(bad);
        if (badSegments.Length < 3)
        {
            return null;
        }

        var structuralMatches = candidates.Where(candidate =>
        {
            var candidateSegments = NormalizeNamespace(candidate);
            if (candidateSegments.Length < 3 ||
                !string.Equals(badSegments[^1], candidateSegments[^1], StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            return IsNamespaceSubsequence(badSegments, candidateSegments) ||
                IsNamespaceSubsequence(candidateSegments, badSegments);
        }).ToArray();

        return structuralMatches.Length == 1
            ? new DiagnosticData { Bad = bad, Suggestions = structuralMatches }
            : null;
    }

    private static bool IsNamespaceSubsequence(string[] larger, string[] smaller)
    {
        if (larger.Length < smaller.Length)
        {
            return false;
        }

        int next = 0;
        foreach (var segment in larger)
        {
            if (next < smaller.Length &&
                string.Equals(segment, smaller[next], StringComparison.OrdinalIgnoreCase))
            {
                next++;
            }
        }

        return next == smaller.Length;
    }

    private static string[] NormalizeNamespace(string value) =>
        value.StartsWith("using:", StringComparison.Ordinal)
            ? value.Substring("using:".Length)
                .Split('.', StringSplitOptions.RemoveEmptyEntries)
                .Select(segment => segment.Replace("_", string.Empty, StringComparison.Ordinal))
                .ToArray()
            : Array.Empty<string>();
}
