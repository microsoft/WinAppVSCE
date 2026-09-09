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

/// <summary>Validation of binding markup: classic Binding, TemplateBinding, and {x:Bind} mode and assignment compatibility.</summary>
internal static partial class XamlValidator
{
    private static void ValidateClassicBinding(
        XamlAttribute attribute, TextDocument doc, XamlTypeSystem typeSystem,
        List<Diagnostic> diagnostics)
    {
        var element = FindParentElement(attribute);
        if (element is null ||
            attribute.Value?.MarkupExtension is not { IsClosed: true } extension ||
            !XamlSemanticFacts.IsBindingMarkupExtension(extension, element.NamespaceScope, typeSystem) ||
            XamlSemanticFacts.ResolveMarkupExtensionType(
                extension.Name?.FullName, element.NamespaceScope, typeSystem) is not { } bindingType)
        {
            return;
        }

        foreach (var argument in extension.Arguments.Where(argument => argument.IsNamed))
        {
            var name = argument.Name?.LocalName;
            if (string.IsNullOrEmpty(name))
            {
                continue;
            }

            var member = typeSystem.FindMember(bindingType, name);
            if (member is null)
            {
                diagnostics.Add(Diag(doc, argument.Name?.LocalNameSpan ?? extension.Span,
                    SeverityError, UnknownBindingArgumentCode,
                    $"'{name}' is not a named argument of '{bindingType.Name}'.",
                    SuggestData(name, typeSystem.GetAttributeCandidateNames(bindingType))));
                continue;
            }

            ValidateBindingEnumValue(argument, member.Type, $"Binding.{name}",
                InvalidBindingValueCode, typeSystem, doc, diagnostics);

            if (name == "ElementName" &&
                argument.Value is { Length: > 0 } rawElementName &&
                argument.ValueSpan is { } elementNameSpan &&
                rawElementName.Trim() is { Length: > 0 } elementName &&
                XamlSemanticFacts.FindNamedElementInScope(
                    doc, attribute.Parent, elementName, typeSystem) is null)
            {
                diagnostics.Add(Diag(doc, elementNameSpan, SeverityError, UnknownBindingElementNameCode,
                    $"No element named '{elementName}' is visible in this XAML namescope."));
            }
        }

        foreach (var nested in extension.DescendantNodesAndSelf()
                     .OfType<XamlMarkupExtension>()
                     .Where(candidate => !ReferenceEquals(candidate, extension) &&
                         candidate.Name?.LocalName == "RelativeSource"))
        {
            ValidateRelativeSource(nested, element.NamespaceScope, typeSystem, doc, diagnostics);
        }
    }

    private static void ValidateBindingEnumValue(
        XamlMarkupExtensionArgument argument, ITypeSymbol? type, string displayName, string code,
        XamlTypeSystem typeSystem, TextDocument doc, List<Diagnostic> diagnostics)
    {
        if (type is not { TypeKind: TypeKind.Enum } enumType ||
            argument.Value is not { } value ||
            argument.ValueSpan is not { } span ||
            !XamlValueConverter.TryValidate(value, enumType, typeSystem, out var valid) ||
            valid)
        {
            return;
        }

        diagnostics.Add(Diag(doc, span, SeverityError, code,
            $"'{value}' is not a valid value for {displayName}.",
            SuggestData(value, enumType.GetMembers().OfType<IFieldSymbol>()
                .Where(field => field.HasConstantValue).Select(field => field.Name))));
    }

    private static void ValidateRelativeSource(
        XamlMarkupExtension extension, XamlNamespaceScope scope, XamlTypeSystem typeSystem,
        TextDocument doc, List<Diagnostic> diagnostics)
    {
        var type = XamlSemanticFacts.ResolveMarkupExtensionType(
            extension.Name?.FullName, scope, typeSystem);
        if (type is null)
        {
            return;
        }

        foreach (var argument in extension.Arguments)
        {
            var name = argument.IsNamed ? argument.Name?.LocalName : "Mode";
            if (string.IsNullOrEmpty(name))
            {
                continue;
            }

            var member = typeSystem.FindMember(type, name);
            if (member is null)
            {
                diagnostics.Add(Diag(doc, argument.Name?.LocalNameSpan ??
                    argument.ValueSpan ?? extension.Span, SeverityError,
                    InvalidRelativeSourceCode,
                    $"'{name}' is not an argument of '{type.Name}'."));
                continue;
            }

            ValidateBindingEnumValue(argument, member.Type, $"RelativeSource.{name}",
                InvalidRelativeSourceCode, typeSystem, doc, diagnostics);
        }
    }

    private static XamlElement? FindParentElement(XamlNode? node)
    {
        for (var current = node?.Parent; current is not null; current = current.Parent)
        {
            if (current is XamlElement element)
            {
                return element;
            }
        }

        return null;
    }

    private static void ValidateTemplateBinding(
        XamlAttribute attribute, INamedTypeSymbol? templateTargetType,
        TextDocument doc, XamlTypeSystem typeSystem, List<Diagnostic> diagnostics)
    {
        var element = FindParentElement(attribute);
        if (templateTargetType is null ||
            element is null ||
            attribute.Value?.MarkupExtension is not
                { IsClosed: true, Name.LocalName: "TemplateBinding" } extension)
        {
            return;
        }

        if (extension.Name!.HasPrefix &&
            (!element.NamespaceScope.TryResolvePrefix(extension.Name.Prefix, out var uri) ||
             !XamlSemanticFacts.IsPresentationNamespace(uri)))
        {
            return;
        }

        var pathArgument = extension.Arguments.FirstOrDefault(argument =>
            (!argument.IsNamed || argument.Name?.LocalName == "Property") &&
            argument.Value is not null);
        if (pathArgument?.Value is not { } path || pathArgument.ValueSpan is not { } span)
        {
            return;
        }

        var memberName = path.Trim();
        int dot = memberName.IndexOf('.');
        if (dot > 0 && dot < memberName.Length - 1)
        {
            var ownerName = memberName[..dot];
            var attachedMemberName = memberName[(dot + 1)..];
            var owner = ResolveTypeName(ownerName, element.NamespaceScope, typeSystem);
            var attached = owner is null
                ? null
                : typeSystem.GetAttachedProperties(owner)
                    .FirstOrDefault(member =>
                        string.Equals(member.Name, attachedMemberName, StringComparison.Ordinal));
            if (attached is not null &&
                XamlTypeSystem.IsAttachedPropertyApplicable(attached, templateTargetType))
            {
                return;
            }

            var message = owner is null
                ? $"'{ownerName}' is not a known attached-property owner."
                : attached is null
                    ? $"'{attachedMemberName}' is not an attached property of '{owner.Name}'."
                    : $"The attached property '{memberName}' cannot be read from template target type '{templateTargetType.Name}'.";
            diagnostics.Add(Diag(
                doc,
                span,
                SeverityError,
                InvalidTemplateBindingCode,
                message,
                owner is null
                    ? null
                    : SuggestData(
                        attachedMemberName,
                        typeSystem.GetAttachedProperties(owner).Select(member => member.Name))));
            return;
        }

        if (IsIdentifier(memberName) &&
            !typeSystem.GetBindableMembers(templateTargetType)
                .OfType<IPropertySymbol>()
                .Any(property => string.Equals(property.Name, memberName, StringComparison.Ordinal)))
        {
            diagnostics.Add(Diag(doc, span, SeverityError, InvalidTemplateBindingCode,
                $"'{memberName}' is not a member of template target type '{templateTargetType.Name}'.",
                SuggestData(
                    memberName,
                    typeSystem.GetBindableMembers(templateTargetType)
                        .OfType<IPropertySymbol>()
                        .Select(property => property.Name))));
        }
    }

    private static void ValidateBindMode(
        XamlAttribute attribute,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        if (!XamlSemanticFacts.IsXBind(attribute, scope) ||
            attribute.Value!.MarkupExtension is not { } extension ||
            XamlSemanticFacts.ResolveMarkupArgumentType(
                extension,
                scope,
                "Mode",
                typeSystem) is not { TypeKind: TypeKind.Enum } bindingMode ||
            extension.Arguments.FirstOrDefault(argument =>
                argument.IsNamed && argument.Name?.LocalName == "Mode") is not { Value: { } mode, ValueSpan: { } span })
        {
            return;
        }

        var names = bindingMode.GetMembers().OfType<IFieldSymbol>()
            .Where(field => field.HasConstantValue)
            .Select(field => field.Name)
            .ToArray();
        if (XamlValueConverter.TryValidate(mode, bindingMode, typeSystem, out var isValid) && !isValid)
        {
            diagnostics.Add(Diag(doc, span, SeverityError, InvalidBindModeCode,
                $"'{mode}' is not a valid x:Bind mode.", SuggestData(mode, names)));
        }
    }

    private static void ValidateBindAssignment(
        XamlAttribute attribute,
        INamedTypeSymbol? elementType,
        INamedTypeSymbol bindRoot,
        INamedTypeSymbol? pageClass,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        if (elementType is null ||
            attribute.Name.HasPrefix ||
            attribute.Name.IsDotted ||
            typeSystem.FindAttributeMember(elementType, attribute.Name.LocalName) is not
                { Kind: XamlMemberKind.Property, Type: { } targetType } ||
            attribute.Value?.MarkupExtension is not { IsClosed: true } extension ||
            !XamlSemanticFacts.IsXBind(extension, scope) ||
            extension.Arguments.Any(argument =>
                argument.IsNamed &&
                argument.Name?.LocalName is "Converter" or "ConverterParameter") ||
            extension.Arguments.FirstOrDefault(argument =>
                (!argument.IsNamed || argument.Name?.LocalName == "Path") &&
                argument.Value is not null) is not { Value: { } path, ValueSpan: { } span })
        {
            return;
        }

        if (FindUnquotedCharacter(path, '!') >= 0)
        {
            return;
        }

       ITypeSymbol? resultType;
       bool isFunctionBinding = TryParseBindFunctionCall(path, out _);
       bool resolved = isFunctionBinding
           ? TryResolveBindFunctionResultType(
               path, attribute, bindRoot, pageClass, scope, typeSystem, doc, out resultType)
           : TryResolveBindResultType(
               path, attribute, bindRoot, pageClass, scope, typeSystem, doc, out resultType);
       if (!resolved || resultType is null ||
           IsImplicitlyAssignable(resultType, targetType, typeSystem) ||
           HasBuiltInBindingConversion(resultType, targetType, isFunctionBinding))
       {
           return;
       }

        string message =
            $"The x:Bind result type '{resultType.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)}' " +
            $"is not assignable to '{targetType.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)}'.";
        if (isFunctionBinding && IsBooleanToVisibilityConversion(resultType, targetType))
        {
            message += " The built-in Boolean-to-Visibility conversion applies only to property-path x:Bind expressions.";
        }

        diagnostics.Add(Diag(doc, span, SeverityError, InvalidBindAssignmentCode, message));
    }

    private static bool TryResolveBindFunctionResultType(
       string path,
       XamlAttribute attribute,
       INamedTypeSymbol bindRoot,
       INamedTypeSymbol? pageClass,
       XamlNamespaceScope scope,
       XamlTypeSystem typeSystem,
       TextDocument doc,
       [NotNullWhen(true)] out ITypeSymbol? resultType)
    {
       resultType = null;
       string call = path.Trim();
       bool negated = false;
       while (call.StartsWith("!", StringComparison.Ordinal))
       {
           negated = true;
           call = call.Substring(1).TrimStart();
       }

       INamedTypeSymbol? staticReceiverType = null;
       if (TryGetStaticBindRoot(call, scope, typeSystem, out var staticType, out var staticMembers, out _))
       {
           staticReceiverType = staticType;
           call = staticMembers;
       }

       if (!TryParseBindFunctionCall(call, out var parsed))
       {
           return false;
       }

       string functionPath = parsed.FunctionPath;
       INamedTypeSymbol functionReceiverRoot = bindRoot;
       int namedReceiverSeparator = functionPath.IndexOf('.');
       if (staticReceiverType is null &&
           namedReceiverSeparator > 0 &&
           XamlSemanticFacts.ResolveNamedElementTypeInScope(
               doc,
               attribute.Parent,
               functionPath.Substring(0, namedReceiverSeparator),
               typeSystem) is { } namedReceiverType)
       {
           functionReceiverRoot = namedReceiverType;
           functionPath = functionPath.Substring(namedReceiverSeparator + 1);
       }

       if (
           !TryResolveBindFunctionReceiver(
               functionPath,
               staticReceiverType,
               functionReceiverRoot,
               pageClass,
               typeSystem,
               out var receiverType,
               out var functionName,
               out var includeReceiverNonPublic,
               out var callIsStatic))
       {
           return false;
       }

       var argumentTypes = parsed.ArgumentRanges
           .Select(range => TryResolveBindFunctionArgumentType(
               call,
               range,
               attribute,
               bindRoot,
               pageClass,
               scope,
               typeSystem,
               doc,
               out var argumentType)
                   ? argumentType
                   : null)
           .ToArray();
       var applicableMethods = SelectBestApplicableBindFunctions(
           GetBindFunctionOverloads(
               receiverType,
               functionName,
               callIsStatic,
               includeReceiverNonPublic,
               pageClass,
               typeSystem),
           argumentTypes,
           typeSystem);
       var returnTypes = applicableMethods
           .Select(method => method.ReturnType)
           .Distinct<ITypeSymbol>(SymbolEqualityComparer.Default)
           .ToArray();
       if (returnTypes.Length != 1)
       {
           return false;
       }

       if (negated && !IsBooleanType(returnTypes[0]))
       {
           return false;
       }

       resultType = negated
           ? typeSystem.ResolveMetadataType("System.Boolean")
           : returnTypes[0];
       return resultType is not null;
    }

    private static bool TryResolveBindFunctionArgumentType(
       string path,
       (int Start, int End) range,
       XamlAttribute attribute,
       INamedTypeSymbol bindRoot,
       INamedTypeSymbol? pageClass,
       XamlNamespaceScope scope,
       XamlTypeSystem typeSystem,
       TextDocument doc,
       [NotNullWhen(true)] out ITypeSymbol? resultType)
    {
       resultType = null;
       string argument = path.Substring(range.Start, range.End - range.Start).Trim();
       if (argument.Length >= 2 &&
           argument[0] is '\'' or '"' &&
           argument[^1] == argument[0])
       {
           resultType = typeSystem.ResolveMetadataType("System.String");
           return resultType is not null;
       }

       if (bool.TryParse(argument, out _))
       {
           resultType = typeSystem.ResolveMetadataType("System.Boolean");
           return resultType is not null;
       }

       if (int.TryParse(argument, NumberStyles.Integer, CultureInfo.InvariantCulture, out _))
       {
           resultType = typeSystem.ResolveMetadataType("System.Int32");
           return resultType is not null;
       }

       if (double.TryParse(argument, NumberStyles.Float, CultureInfo.InvariantCulture, out _))
       {
           resultType = typeSystem.ResolveMetadataType("System.Double");
           return resultType is not null;
       }

       return TryResolveBindResultType(
           argument,
           attribute,
           bindRoot,
           pageClass,
           scope,
           typeSystem,
           doc,
           out resultType);
    }

    private static bool TryResolveBindResultType(
        string path,
        XamlAttribute attribute,
        INamedTypeSymbol bindRoot,
        INamedTypeSymbol? pageClass,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        [NotNullWhen(true)] out ITypeSymbol? resultType)
    {
        resultType = null;
        var text = path.Trim();
        if (text.StartsWith("!", System.StringComparison.Ordinal))
        {
            if (!TryResolveBindResultType(
                    text.Substring(1),
                    attribute,
                    bindRoot,
                    pageClass,
                    scope,
                    typeSystem,
                    doc,
                    out _))
            {
                return false;
            }

            resultType = typeSystem.ResolveMetadataType("System.Boolean");
            return resultType is not null;
        }

        ITypeSymbol current = bindRoot;
        bool firstStatic = false;
        bool allowFirstNonPublic =
            pageClass is not null &&
            SymbolEqualityComparer.Default.Equals(bindRoot, pageClass);
        string chain = text;
        if (TryGetCastPath(text, out var castName, out var castMembers, out _) &&
            ResolveTypeName(castName, scope, typeSystem) is { } castType)
        {
            current = castType;
            chain = castMembers.TrimStart('.');
            allowFirstNonPublic = false;
        }
        else if (TryGetStaticBindRoot(
                     text, scope, typeSystem, out var staticType, out var staticMembers, out _))
        {
            current = staticType;
            chain = staticMembers;
            firstStatic = true;
            allowFirstNonPublic = false;
        }
        else
        {
            var firstName = chain.Split('.')[0];
            if (XamlSemanticFacts.ResolveNamedElementTypeInScope(
                    doc, attribute.Parent, firstName, typeSystem) is { } namedType)
            {
                current = namedType;
                chain = chain.Length == firstName.Length
                    ? string.Empty
                    : chain[(firstName.Length + 1)..];
                allowFirstNonPublic = false;
            }
        }

        if (chain.Length == 0)
        {
            resultType = current;
            return true;
        }

        bool first = true;
        foreach (var rawSegment in chain.Split('.'))
        {
            var bracket = rawSegment.IndexOf('[');
            var name = (bracket < 0 ? rawSegment : rawSegment[..bracket]).Trim();
            if (!IsIdentifier(name))
            {
                return false;
            }

            ITypeSymbol? next;
            if (first && firstStatic)
            {
                var symbol = typeSystem.GetBindableStaticMembers(current, pageClass)
                    .FirstOrDefault(candidate =>
                        candidate.Name == name &&
                        candidate is IPropertySymbol or IFieldSymbol);
                next = symbol is null ? null : GetSymbolType(symbol);
                for (int i = bracket; next is not null && bracket >= 0 && i < rawSegment.Length; i++)
                {
                    if (rawSegment[i] == '[')
                    {
                        next = XamlTypeSystem.GetCollectionElementType(next);
                    }
                }
            }
            else
            {
                next = CompletionProvider.ResolveBindSegmentType(
                    typeSystem,
                    current,
                    rawSegment,
                    first && allowFirstNonPublic,
                    pageClass);
            }

            if (next is null)
            {
                return false;
            }

            current = next;
            first = false;
        }

        resultType = current;
        return true;
    }

    private static bool IsImplicitlyAssignable(
        ITypeSymbol source,
        ITypeSymbol target,
        XamlTypeSystem typeSystem)
    {
        bool sourceNullable = IsNullableType(source);
        bool targetNullable = IsNullableType(target);
        if (sourceNullable && !targetNullable)
        {
            return false;
        }

        source = XamlValueConverter.UnwrapNullable(source);
        target = XamlValueConverter.UnwrapNullable(target);
        if (SymbolEqualityComparer.Default.Equals(source, target) ||
            XamlTypeSystem.IsAssignableTo(source, target))
        {
            return true;
        }

        return typeSystem.HasImplicitConversion(source, target);
    }

    private static bool HasBuiltInBindingConversion(
        ITypeSymbol source,
        ITypeSymbol target,
        bool isFunctionBinding)
    {
        source = XamlValueConverter.UnwrapNullable(source);
        target = XamlValueConverter.UnwrapNullable(target);
        if (target.SpecialType == SpecialType.System_String)
        {
            return true;
        }

        if (source.SpecialType == SpecialType.System_String &&
            (target.Name == "Uri" &&
             target.ContainingNamespace?.ToDisplayString() == "System" ||
             target.Name == "ImageSource" &&
             target.ContainingNamespace?.ToDisplayString() is
                 "Microsoft.UI.Xaml.Media" or "Windows.UI.Xaml.Media"))
        {
            return true;
        }

        return !isFunctionBinding && IsBooleanToVisibilityConversion(source, target);
    }

    private static bool IsBooleanToVisibilityConversion(ITypeSymbol source, ITypeSymbol target)
    {
        source = XamlValueConverter.UnwrapNullable(source);
        target = XamlValueConverter.UnwrapNullable(target);
        return source.SpecialType == SpecialType.System_Boolean &&
            target.Name == "Visibility" &&
            target.ContainingNamespace?.ToDisplayString() is
                "Microsoft.UI.Xaml" or "Windows.UI.Xaml";
    }

    private static bool IsNullableType(ITypeSymbol type) =>
        type is INamedTypeSymbol named &&
        named.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T;

    private static void ValidateUntypedTemplateBinding(
        XamlAttribute attribute,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics,
        DiagnosticData? dataTypeSuggestion)
    {
        if (attribute.Value?.MarkupExtension is not { IsClosed: true } extension ||
            !XamlSemanticFacts.IsBindingMarkupExtension(extension, scope, typeSystem))
        {
            return;
        }

        diagnostics.Add(Diag(
            doc,
            extension.Name?.Span ?? extension.Span,
            SeverityWarning,
            BindingDataTypeRecommendedCode,
            "Binding inside a DataTemplate without x:DataType is not safe for Native AOT.",
            dataTypeSuggestion));
    }
}
