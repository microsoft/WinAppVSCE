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
    private static readonly (string Name, string Detail)[] MarkupExtensions =
    {
        ("x:Bind", "Compiled binding to a field/property (page x:Class or template x:DataType)"),
        ("Binding", "Runtime binding through the element's DataContext"),
        ("StaticResource", "Resource reference resolved once at load time"),
        ("ThemeResource", "Resource reference re-evaluated when the theme changes"),
        ("TemplateBinding", "Binds to a property on the templated parent"),
        ("RelativeSource", "Source relative to the target (Self / TemplatedParent)"),
        ("x:Static", "References a static field, property, or constant"),
        ("x:Type", "A System.Type reference for the named type"),
        ("x:Null", "The null value"),
    };

    private static CompletionList CompleteMarkupName(
        Context ctx,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        Lsp.Range replaceRange)
    {
        var items = new List<CompletionItem>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        void AddCuratedExtensions()
        {
            foreach (var (name, detail) in MarkupExtensions)
            {
                if (!StartsWith(name, ctx.Partial) || !seen.Add(name))
                {
                    continue;
                }

                items.Add(new CompletionItem
                {
                    Label = name,
                    Kind = CompletionItemKind.Keyword,
                    Detail = detail,
                    TextEdit = new TextEdit { Range = replaceRange, NewText = name },
                    FilterText = name,
                    SortText = name,
                });
            }
        }

        void AddRuntimeExtensions()
        {
            foreach (var declaration in scope.Declarations)
            {
                if (string.Equals(declaration.Value, XamlTypeSystem.XamlLanguageNamespace, StringComparison.Ordinal))
                {
                    continue;
                }

                foreach (var type in typeSystem.GetMarkupExtensionTypes(declaration.Value))
                {
                    var localName = type.Name.EndsWith("Extension", StringComparison.Ordinal) &&
                        type.Name.Length > "Extension".Length
                            ? type.Name.Substring(0, type.Name.Length - "Extension".Length)
                            : type.Name;
                    var name = declaration.Key.Length == 0
                        ? localName
                        : declaration.Key + ":" + localName;
                    if (!StartsWith(name, ctx.Partial) || !seen.Add(name))
                    {
                        continue;
                    }

                    items.Add(new CompletionItem
                    {
                        Label = name,
                        Kind = CompletionItemKind.Class,
                        Detail = type.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat),
                        Documentation = CompletionDoc(type),
                        TextEdit = new TextEdit { Range = replaceRange, NewText = name },
                        FilterText = name,
                        SortText = name,
                    });
                }
            }
        }

        var preferCustomDefault =
            scope.TryResolvePrefix(string.Empty, out var defaultNamespace) &&
            !string.Equals(
                defaultNamespace,
                XamlTypeSystem.PresentationNamespace,
                StringComparison.Ordinal);
        if (preferCustomDefault)
        {
            AddRuntimeExtensions();
            AddCuratedExtensions();
        }
        else
        {
            AddCuratedExtensions();
            AddRuntimeExtensions();
        }

        return Finish(items);
    }

    /// <summary>Completes a markup extension's named arguments: the argument NAMES when no = has been typed.</summary>
    private static CompletionList CompleteMarkupArg(
        TextDocument doc,
        Context ctx,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        Lsp.Range replaceRange)
    {
        var extensionType = XamlSemanticFacts.ResolveMarkupExtensionType(
            ctx.MarkupExtension,
            scope,
            typeSystem);

        // Argument-name completion: offer the extension type's settable property names.
        if (string.IsNullOrEmpty(ctx.AttributeName))
        {
            // x:Bind/Bind is compiled and has no runtime extension type to reflect over, so offer its curated named arguments (Mode, Converter, FallbackValue, ...) directly.
            if (IsBindExtension(ctx.MarkupExtension))
            {
                var bindNames = new List<CompletionItem>();
                var bindingType = typeSystem.ResolveMetadataType(BindingMetadataName);
                foreach (var name in XBindArgumentNames)
                {
                    if (!StartsWith(name, ctx.Partial))
                    {
                        continue;
                    }

                    var bindingMember = bindingType is null ? null : typeSystem.FindMember(bindingType, name);
                    bindNames.Add(new CompletionItem
                    {
                        Label = name,
                        Kind = CompletionItemKind.Property,
                        Detail = XBindArgumentDetail(name, bindingMember),
                        Documentation = XBindArgumentDoc(name, bindingMember),
                        TextEdit = new TextEdit { Range = replaceRange, NewText = name },
                        FilterText = name,
                        SortText = name,
                    });
                }

                return Finish(bindNames);
            }

            if (extensionType is null)
            {
                return new CompletionList();
            }

            var names = new List<CompletionItem>();
            foreach (var member in typeSystem.GetMembers(extensionType))
            {
                if (member.Kind != XamlMemberKind.Property || !StartsWith(member.Name, ctx.Partial))
                {
                    continue;
                }

                names.Add(new CompletionItem
                {
                    Label = member.Name,
                    Kind = CompletionItemKind.Property,
                    Documentation = CompletionDoc(member.Symbol),
                    Detail = DescribeMember(member),
                    TextEdit = new TextEdit { Range = replaceRange, NewText = member.Name },
                    FilterText = member.Name,
                    SortText = member.Name,
                });
            }

            return Finish(names);
        }

        // Argument-value completion: resolve the argument's type on the extension, complete enum members.

        // ElementName=<caret> (classic {Binding ElementName=...}) completes the x:Name'd elements in the doc.
        if (string.Equals(ctx.AttributeName, "ElementName", StringComparison.OrdinalIgnoreCase))
        {
            return CompleteNamedElements(doc, ctx.Partial, replaceRange);
        }

        var argType = extensionType is null
            ? null
            : typeSystem.FindMember(extensionType, ctx.AttributeName!)?.Type;

        // {x:Bind}/{Bind} is compiled and has no reflectable runtime extension type, so its enum-typed named arguments (Mode, UpdateSourceTrigger
        if (argType is null &&
            IsBindExtension(ctx.MarkupExtension) &&
            ctx.AttributeName is { } argName &&
            BindEnumArgumentTypes.TryGetValue(argName, out var enumMetadataName))
        {
            argType = typeSystem.ResolveMetadataType(enumMetadataName);
        }

        if (argType is { TypeKind: TypeKind.Enum })
        {
            return CompleteEnumValue(argType, ctx.Partial, replaceRange);
        }

        if (argType is { SpecialType: SpecialType.System_Boolean })
        {
            return CompleteBooleanValue(ctx.Partial, replaceRange);
        }

        return new CompletionList();
    }

    /// <summary>Completes the <c>x:Name</c>'d elements declared in the document (for <c>ElementName=</c>).</summary>
    private static CompletionList CompleteNamedElements(TextDocument doc, string partial, Lsp.Range replaceRange)
    {
        var items = new List<CompletionItem>();
        if (doc.Parsed.Root is { } root)
        {
            foreach (var (name, typeName) in CollectNamedElements(root))
            {
                if (!StartsWith(name, partial))
                {
                    continue;
                }

                items.Add(new CompletionItem
                {
                    Label = name,
                    Kind = CompletionItemKind.Field,
                    Detail = typeName,
                    TextEdit = new TextEdit { Range = replaceRange, NewText = name },
                    FilterText = name,
                    SortText = name,
                });
            }
        }

        return Finish(items);
    }

    /// <summary>Walks the AST yielding each element's <c>x:Name</c>/<c>Name</c> value and its element type name.</summary>
    private static IEnumerable<(string Name, string TypeName)> CollectNamedElements(XamlElement element)
    {
        var attr = element.GetAttribute("x:Name") ?? element.GetAttribute("Name");
        var text = attr?.Value?.Text?.Trim();
        if (!string.IsNullOrEmpty(text) && attr?.Value is { IsMarkupExtension: false })
        {
            yield return (text!, element.Name is { LocalName.Length: > 0 } n ? n.FullName : string.Empty);
        }

        foreach (var child in element.Content)
        {
            if (child is XamlElement childElement)
            {
                foreach (var hit in CollectNamedElements(childElement))
                {
                    yield return hit;
                }
            }
        }
    }

    /// <summary>The named arguments of a compiled <c>{x:Bind}</c> expression, offered for arg-name completion.</summary>
    private static readonly string[] XBindArgumentNames =
    {
        "Mode",
        "Converter",
        "ConverterParameter",
        "ConverterLanguage",
        "FallbackValue",
        "TargetNullValue",
        "BindBack",
        "UpdateSourceTrigger",
    };

    /// <summary>Metadata name of the classic binding type whose properties back the curated x:Bind arg names.</summary>
    private const string BindingMetadataName = "Microsoft.UI.Xaml.Data.Binding";

    /// <summary>Documentation for the x:Bind-only BindBack argument, which has no classic Binding property to borrow a &lt;summary&gt</summary>
    private static readonly MarkupContent BindBackDoc = new()
    {
        Value = "Specifies the function called to write the value back to the source in a TwoWay compiled binding.",
    };

    /// <summary>The completion Detail (popup type-hint header) for the x:Bind-only BindBack argument.</summary>
    private const string BindBackDetail = "method";

    /// <summary>The documentation flyout for a curated {x:Bind} named argument.</summary>
    private static MarkupContent? XBindArgumentDoc(string argName, XamlMemberInfo? bindingMember) =>
        string.Equals(argName, "BindBack", StringComparison.Ordinal)
            ? BindBackDoc
            : CompletionDoc(bindingMember?.Symbol);

    /// <summary>The completion Detail (the dimmed type-hint header beside the popup) for a curated {x:Bind} named argument — the same property : Type string the classic {Binding} arg name shows</summary>
    private static string? XBindArgumentDetail(string argName, XamlMemberInfo? bindingMember) =>
        string.Equals(argName, "BindBack", StringComparison.Ordinal)
            ? BindBackDetail
            : bindingMember is null ? null : DescribeMember(bindingMember);

    /// <summary>The enum-typed {x:Bind} named arguments mapped to their CLR enum metadata name.</summary>
    private static readonly Dictionary<string, string> BindEnumArgumentTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Mode"] = "Microsoft.UI.Xaml.Data.BindingMode",
        ["UpdateSourceTrigger"] = "Microsoft.UI.Xaml.Data.UpdateSourceTrigger",
    };

    /// <summary>True for the compiled-binding extension in either its prefixed (<c>x:Bind</c>) or bare (<c>Bind</c>) form.</summary>
    private static bool IsBindExtension(string? extension) =>
        string.Equals(extension, "x:Bind", StringComparison.Ordinal) ||
        string.Equals(extension, "Bind", StringComparison.Ordinal);

    // --- Resource keys ({StaticResource | ThemeResource key}) -------------------------------------

    /// <summary>Completes the key of a {StaticResource}/{ThemeResource} reference from the x:Keyd resources defined in this document plus the project's App.xaml (passed in).</summary>
    private static CompletionList CompleteResourceKey(
        TextDocument doc,
        int offset,
        Context ctx,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        IReadOnlyCollection<string>? appResourceKeys,
        Lsp.Range replaceRange,
        Action<string, string>? themeTypeResolutionObserver)
    {
        var projectKeys = new SortedSet<string>(StringComparer.Ordinal);
        if (doc.Parsed.Root is { } root)
        {
            CollectResourceKeysCore(root, projectKeys);
        }

        if (appResourceKeys != null)
        {
            foreach (var key in appResourceKeys)
            {
                projectKeys.Add(key);
            }
        }

        // A null target accepts every resource key.
        var targetType = ResolveResourceTargetType(doc, offset, ctx, scope, typeSystem);

        // Exclude local keys only when their declaring type is definitely incompatible.
        var docLocalDecls = doc.Parsed.Root is { } declRoot
            ? CollectDocLocalKeyDeclarations(declRoot)
            : new Dictionary<string, XamlElement>(StringComparer.Ordinal);

        var items = new List<CompletionItem>();

        // Project-defined resources first (document-local + App.xaml); the "0" sort group keeps them above the framework keys, which are grouped under "1".
        foreach (var key in projectKeys)
        {
            if (!StartsWith(key, ctx.Partial))
            {
                continue;
            }

            if (docLocalDecls.TryGetValue(key, out var decl) &&
                (appResourceKeys is null || !appResourceKeys.Contains(key)) &&
                !AuthorKeyMatchesTarget(decl, targetType, scope, typeSystem))
            {
                continue;
            }

            items.Add(ResourceKeyItem(key, "resource", "0", replaceRange));
        }

        var compatibilityByType =
            new Dictionary<(string Namespace, string LocalName), bool>();

        // SDK theme resources follow project resources and omit keys overridden by the project.
        foreach (var resource in typeSystem.GetThemeResources())
        {
            var key = resource.Key;
            if (!StartsWith(key, ctx.Partial) || projectKeys.Contains(key))
            {
                continue;
            }

            if (ThemeKeyMatchesTarget(
                resource,
                targetType,
                typeSystem,
                compatibilityByType,
                themeTypeResolutionObserver))
            {
                items.Add(ResourceKeyItem(key, "theme resource", "1", replaceRange));
            }
        }

        return Finish(items);
    }

    /// <summary>Resolves the CLR type of the property a resource reference feeds, used to scope framework theme keys.</summary>
    private static ITypeSymbol? ResolveResourceTargetType(
        TextDocument doc, int offset, Context ctx, XamlNamespaceScope scope, XamlTypeSystem typeSystem)
    {
        if (string.IsNullOrEmpty(ctx.AttributeName))
        {
            return null;
        }

        var element = FindEnclosingElement(doc.Parsed.FindNode(Math.Max(0, offset - 1)));
        if (element?.Name is null)
        {
            return null;
        }

        var type = XamlSemanticFacts.IsSetter(element, typeSystem) &&
                   string.Equals(ctx.AttributeName, "Value", StringComparison.Ordinal)
            ? XamlSemanticFacts.ResolveSetterValueType(element, scope, typeSystem)
            : ResolveAttributeType(ctx.AttributeName!, element, scope, typeSystem);

        if (type is null || type.SpecialType == SpecialType.System_Object)
        {
            return null;
        }

        return UnwrapNullable(type);
    }

    /// <summary>Excludes a theme resource only when its declared type is definitely incompatible.</summary>
    private static bool ThemeKeyMatchesTarget(
        ThemeResourceInfo resource,
        ITypeSymbol? targetType,
        XamlTypeSystem typeSystem,
        Dictionary<(string Namespace, string LocalName), bool> compatibilityByType,
        Action<string, string>? typeResolutionObserver)
    {
        if (targetType is null)
        {
            return true;
        }

        var typeIdentity = (resource.TypeNamespace, resource.LocalTypeName);
        if (compatibilityByType.TryGetValue(typeIdentity, out var isCompatible))
        {
            return isCompatible;
        }

        typeResolutionObserver?.Invoke(resource.TypeNamespace, resource.LocalTypeName);
        var keyType = typeSystem.ResolveType(resource.TypeNamespace, resource.LocalTypeName);
        isCompatible = keyType is null ||
            XamlTypeSystem.IsAssignableTo(keyType, targetType) ||
            XamlTypeSystem.IsAssignableTo(targetType, keyType);
        compatibilityByType.Add(typeIdentity, isCompatible);
        return isCompatible;
    }

    private static CompletionItem ResourceKeyItem(string key, string detail, string sortGroup, Lsp.Range replaceRange) => new()
    {
        Label = key,
        Kind = CompletionItemKind.Value,
        Detail = detail,
        TextEdit = new TextEdit { Range = replaceRange, NewText = key },
        FilterText = key,
        SortText = sortGroup + key,
    };

    /// <summary>Gathers every <c>x:Key</c> value declared anywhere in <paramref name="document"/>.</summary>
    public static List<string> CollectResourceKeys(XamlDocument document)
    {
        var keys = new HashSet<string>(StringComparer.Ordinal);
        if (document.Root is { } root)
        {
            CollectResourceKeysCore(root, keys);
        }

        return keys.ToList();
    }

    private static void CollectResourceKeysCore(XamlElement element, ISet<string> into)
    {
        foreach (var attribute in element.Attributes)
        {
            if (!attribute.IsNamespaceDeclaration &&
                attribute.Name.Prefix == "x" && attribute.Name.LocalName == "Key" &&
                attribute.Value is { } value && value.Text.Length > 0)
            {
                into.Add(value.Text);
            }
        }

        foreach (var child in element.Content)
        {
            if (child is XamlElement childElement)
            {
                CollectResourceKeysCore(childElement, into);
            }
        }
    }

    /// <summary>Maps each document-local x:Key value to the element that DECLARES it (the resource object element carrying the x:Key)</summary>
    private static Dictionary<string, XamlElement> CollectDocLocalKeyDeclarations(XamlElement root)
    {
        var map = new Dictionary<string, XamlElement>(StringComparer.Ordinal);
        CollectKeyDeclarationsCore(root, map);
        return map;
    }

    private static void CollectKeyDeclarationsCore(XamlElement element, Dictionary<string, XamlElement> into)
    {
        foreach (var attribute in element.Attributes)
        {
            if (!attribute.IsNamespaceDeclaration &&
                attribute.Name.Prefix == "x" && attribute.Name.LocalName == "Key" &&
                attribute.Value is { } value && value.Text.Length > 0)
            {
                if (!into.ContainsKey(value.Text))
                {
                    into.Add(value.Text, element);
                }
            }
        }

        foreach (var child in element.Content)
        {
            if (child is XamlElement childElement)
            {
                CollectKeyDeclarationsCore(childElement, into);
            }
        }
    }

    /// <summary>Conservative type-scoping for the project's document-local author keys: follow-on).</summary>
    private static bool AuthorKeyMatchesTarget(
        XamlElement declaringElement, ITypeSymbol? targetType, XamlNamespaceScope scope, XamlTypeSystem typeSystem)
    {
        if (targetType is null || declaringElement.Name is not { } name)
        {
            return true;
        }

        var keyType = ResolveElementType(name, scope, typeSystem);
        if (keyType is null)
        {
            return true;
        }

        return XamlTypeSystem.IsAssignableTo(keyType, targetType) ||
               XamlTypeSystem.IsAssignableTo(targetType, keyType);
    }


    private static CompletionList CompleteBooleanValue(string partial, Lsp.Range replaceRange)
    {
        var items = new List<CompletionItem>();
        foreach (var value in new[] { "True", "False" })
        {
            if (!StartsWith(value, partial))
            {
                continue;
            }

            items.Add(new CompletionItem
            {
                Label = value,
                Kind = CompletionItemKind.Value,
                Detail = "bool",
                TextEdit = new TextEdit { Range = replaceRange, NewText = value },
                FilterText = value,
                SortText = value,
            });
        }

        return Finish(items);
    }

    /// <summary>The end offset of the value token the caret sits in — the caret plus any trailing value characters up to the closing quote / whitespace / attribute delimiter.</summary>
    private static int ValueTokenEnd(string text, int caret)
    {
        int i = caret;
        while (i < text.Length && !IsValueDelimiter(text[i]))
        {
            i++;
        }

        return i;
    }

    /// <summary>Characters that terminate an attribute value token (quotes, whitespace, XML/markup punctuation).</summary>
    private static bool IsValueDelimiter(char c) =>
        c is '"' or '\'' or '<' or '>' or '{' or '}' or '=' or '/' || char.IsWhiteSpace(c);

    /// <summary>LSP <c>InsertTextFormat.Snippet</c> — the value uses <c>$0</c>/<c>${n}</c> tab-stop syntax.</summary>
    private const int SnippetInsertFormat = 2;

    /// <summary>Index just past the attribute-name token starting/continuing at <paramref name="caret"/>.</summary>
    private static int AttributeNameTokenEnd(string text, int caret)
    {
        int i = caret;
        while (i < text.Length && IsNameChar(text[i]))
        {
            i++;
        }

        return i;
    }

    /// <summary>The first non-whitespace char at or after <paramref name="index"/>, or <c>'\0'</c> at end.</summary>
    private static char NextNonWhitespace(string text, int index)
    {
        for (int i = index; i < text.Length; i++)
        {
            if (!char.IsWhiteSpace(text[i]))
            {
                return text[i];
            }
        }

        return '\0';
    }

    /// <summary>The two keyword <c>GridLength</c> sizings VS/Blend offer; numeric px/star values stay free-form.</summary>
    private static readonly (string Value, string Detail)[] GridLengthKeywords =
    {
        ("Auto", "GridLength — size to content"),
        ("*", "GridLength — star sizing (one share of the remaining space)"),
    };

    /// <summary>Completes a GridLength-typed attribute value.</summary>
    private static CompletionList CompleteGridLength(string partial, Lsp.Range replaceRange)
    {
        var items = new List<CompletionItem>();
        foreach (var (value, detail) in GridLengthKeywords)
        {
            if (!StartsWith(value, partial))
            {
                continue;
            }

            items.Add(new CompletionItem
            {
                Label = value,
                Kind = CompletionItemKind.Value,
                Detail = detail,
                TextEdit = new TextEdit { Range = replaceRange, NewText = value },
                FilterText = value,
                SortText = value,
            });
        }

        return Finish(items);
    }

    /// <summary>Completes a Brush/Color-typed attribute value with the WinUI named colors (Microsoft.UI.Colors — Red, CornflowerBlue, …, Transparent).</summary>
    private static CompletionList CompleteNamedColor(string partial, XamlTypeSystem typeSystem, Lsp.Range replaceRange)
    {
        var items = new List<CompletionItem>();
        foreach (var name in typeSystem.GetNamedColors())
        {
            if (!StartsWith(name, partial))
            {
                continue;
            }

            items.Add(new CompletionItem
            {
                Label = name,
                Kind = CompletionItemKind.Color,
                Detail = "named color",
                TextEdit = new TextEdit { Range = replaceRange, NewText = name },
                FilterText = name,
                SortText = name,
            });
        }

        return Finish(items);
    }

    /// <summary>Completes a FontWeight-typed attribute value with the WinUI named weights (Microsoft.UI.Text.FontWeights — Thin, Light, Normal, SemiBold, Bold, …), matching Visual Studio/Blend.</summary>
    private static CompletionList CompleteFontWeight(string partial, XamlTypeSystem typeSystem, Lsp.Range replaceRange)
    {
        var items = new List<CompletionItem>();
        foreach (var name in typeSystem.GetFontWeights())
        {
            if (!StartsWith(name, partial))
            {
                continue;
            }

            items.Add(new CompletionItem
            {
                Label = name,
                Kind = CompletionItemKind.Value,
                Detail = "font weight",
                TextEdit = new TextEdit { Range = replaceRange, NewText = name },
                FilterText = name,
                SortText = name,
            });
        }

        return Finish(items);
    }
    private static ITypeSymbol? ResolveAttributeType(
        string attributeName, XamlElement element, XamlNamespaceScope scope, XamlTypeSystem typeSystem)
    {
        int dot = attributeName.IndexOf('.');
        if (dot >= 0)
        {
            var ownerName = attributeName.Substring(0, dot);
            var memberName = attributeName.Substring(dot + 1);
            var owner = ResolveElementType(ParseQualified(ownerName), scope, typeSystem);
            if (owner is null)
            {
                return null;
            }

            return typeSystem.GetAttachedProperties(owner)
                .FirstOrDefault(m => string.Equals(m.Name, memberName, StringComparison.Ordinal))?.Type;
        }

        // A prefixed attribute.
        if (attributeName.IndexOf(':') >= 0 || element.Name is null)
        {
            return null;
        }

        var elementType = ResolveElementType(element.Name, scope, typeSystem);
        return elementType is null ? null : typeSystem.FindMember(elementType, attributeName)?.Type;
    }

    private static ITypeSymbol UnwrapNullable(ITypeSymbol type) =>
        type is INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } named &&
        named.TypeArguments.Length == 1
            ? named.TypeArguments[0]
            : type;

    // --- x:Bind member path (compiled binding) ----------------------------------------------------

    /// <summary>Completes a member of an {x:Bind path} expression.</summary>
    private static CompletionList CompleteBindPath(
        TextDocument doc,
        int offset,
        Context ctx,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        INamedTypeSymbol? pageClass,
        Lsp.Range replaceRange)
    {
        var root = string.IsNullOrEmpty(ctx.BindCastType)
            ? (string.IsNullOrEmpty(ctx.BindElementName)
                ? ResolveBindRoot(doc, offset, scope, typeSystem, pageClass, ctx.IsClassicBinding)
                : ResolveNamedElementType(doc.Parsed.Root, ctx.BindElementName!, scope, typeSystem))
            : ResolveElementType(ParseQualified(ctx.BindCastType!), scope, typeSystem);
        if (root is null)
        {
            return new CompletionList();
        }

        // Walk the segments already typed before the last dot.
        ITypeSymbol current = root;
        bool atRoot = true;
        if (!string.IsNullOrEmpty(ctx.BindPrefixPath))
        {
            foreach (var segment in ctx.BindPrefixPath!.Split('.'))
            {
                if (segment.Length == 0)
                {
                    return new CompletionList();
                }

                var resolved = ResolveBindSegmentType(typeSystem, current, segment, atRoot);
                if (resolved is null)
                {
                    return new CompletionList();
                }

                current = resolved;
                atRoot = false;
            }
        }

        var items = new List<CompletionItem>();
        foreach (var member in typeSystem.GetBindableMembers(current, includeRootNonPublic: atRoot))
        {
            if (!StartsWith(member.Name, ctx.Partial) || IsBindCompletionNoise(member))
            {
                continue;
            }

            items.Add(new CompletionItem
            {
                Label = member.Name,
                Kind = BindMemberKind(member),
                Documentation = CompletionDoc(member),
                Detail = DescribeBindMember(member),
                TextEdit = new TextEdit { Range = replaceRange, NewText = member.Name },
                FilterText = member.Name,
                // Properties and fields before methods; the common bind target is a property.
                SortText = (member is IMethodSymbol ? "1" : "0") + member.Name,
            });
        }

        return Finish(items);
    }

    /// <summary>Resolves one {x:Bind} path segment to the type it evaluates to, handling indexer suffixes: a segment like Items[0] resolves the Items member</summary>
    internal static ITypeSymbol? ResolveBindSegmentType(
        XamlTypeSystem typeSystem, ITypeSymbol current, string segment, bool atRoot)
    {
        int bracket = segment.IndexOf('[');
        string name = (bracket < 0 ? segment : segment.Substring(0, bracket)).Trim();
        if (name.Length == 0)
        {
            return null;
        }

        var member = typeSystem.GetBindableMembers(current, includeRootNonPublic: atRoot)
            .FirstOrDefault(m => string.Equals(m.Name, name, StringComparison.Ordinal));
        var type = member is null ? null : XamlTypeSystem.GetMemberType(member);
        if (type is null)
        {
            return null;
        }

        for (int i = bracket; bracket >= 0 && i < segment.Length; i++)
        {
            if (segment[i] != '[')
            {
                continue;
            }

            type = XamlTypeSystem.GetCollectionElementType(type);
            if (type is null)
            {
                return null;
            }
        }

        return type;
    }

    /// <summary>True when a bindable member should be hidden from {x:Bind} completion because it is noise rather than a real authoring target</summary>
    private static bool IsBindCompletionNoise(ISymbol member)
    {
        var declarations = member.DeclaringSyntaxReferences;

        // Generated code-behind plumbing: every declaration lives in a generated file.
        if (declarations.Length > 0 && declarations.All(r => IsGeneratedDocumentPath(r.SyntaxTree.FilePath)))
        {
            return true;
        }

        // Inherited framework methods (defined only in metadata) flood the list and are rarely bound.
        return member is IMethodSymbol && declarations.IsEmpty;
    }

    private static bool IsGeneratedDocumentPath(string? path) =>
        !string.IsNullOrEmpty(path) &&
        (path!.EndsWith(".g.cs", StringComparison.OrdinalIgnoreCase) ||
         path.EndsWith(".g.i.cs", StringComparison.OrdinalIgnoreCase));

    /// <summary>Determines the type a binding path binds against at the caret.</summary>
    private static ITypeSymbol? ResolveBindRoot(
        TextDocument doc, int offset, XamlNamespaceScope scope, XamlTypeSystem typeSystem,
        INamedTypeSymbol? pageClass, bool classic)
    {
        for (var node = doc.Parsed.FindNode(Math.Max(0, offset - 1)); node != null; node = node.Parent)
        {
            if (node is not XamlElement element)
            {
                continue;
            }

            // A DataTemplate re-roots BOTH compiled and classic bindings to its x:DataType (the templated item), so it always wins at its scope; an empty/unresolvable x:DataType yields no root.
            if (XamlSemanticFacts.IsDataTemplate(element, typeSystem))
            {
                var dataType = element.Attributes.FirstOrDefault(a =>
                    !a.IsNamespaceDeclaration && a.Name.Prefix == "x" && a.Name.LocalName == "DataType");
                var typeName = dataType?.Value?.Text?.Trim();
                return string.IsNullOrEmpty(typeName)
                    ? null
                    : XamlSemanticFacts.ResolveTypeName(
                        typeName!,
                        element.NamespaceScope,
                        typeSystem);
            }

            // Classic {Binding} binds to the runtime DataContext, whose type is only statically known when a design-time hint declares it: d:DataContext="{d:DesignInstance Type=local:Foo}".
            if (classic)
            {
                var designContext = element.Attributes.FirstOrDefault(a =>
                    !a.IsNamespaceDeclaration && a.Name.HasPrefix && a.Name.LocalName == "DataContext"
                    && scope.TryResolvePrefix(a.Name.Prefix, out var uri) && XamlNamespaces.IsDesignTime(uri));
                if (designContext is not null)
                {
                    var value = designContext.Value?.Text;

                    // The value must ALSO be a design-time DesignInstance extension: its prefix has to resolve to a design-time namespace, as required for d:DataContext.
                    if (!IsDesignInstanceExtension(value, scope))
                    {
                        return null;
                    }

                    var typeName = ParseDesignInstanceType(value);
                    return typeName is null
                        ? null
                        : ResolveElementType(ParseQualified(typeName), scope, typeSystem);
                }
            }
        }

        return classic ? null : pageClass;
    }

    /// <summary>True when attributeName is the mc:Ignorable markup-compatibility directive — matched by the RESOLVED namespace URI (so a custom prefix mapped to the markup-compatibility URI</summary>
    private static bool IsMcIgnorableAttribute(string? attributeName, XamlNamespaceScope scope)
    {
        if (attributeName is null)
        {
            return false;
        }

        int colon = attributeName.IndexOf(':');
        if (colon < 0)
        {
            return false; // Ignorable must be prefixed with the markup-compatibility prefix
        }

        return string.Equals(attributeName.Substring(colon + 1), "Ignorable", StringComparison.Ordinal)
            && scope.TryResolvePrefix(attributeName.Substring(0, colon), out var uri)
            && string.Equals(uri, XamlNamespaces.MarkupCompatibility, StringComparison.Ordinal);
    }

    /// <summary>Completes the space-separated mc:Ignorable="d …" value with the DECLARED prefixes that map to a design-time namespace (blend/2008 or /2006)</summary>
    private static CompletionList CompleteMcIgnorable(
        TextDocument doc, int offset, Context ctx, XamlNamespaceScope scope, Lsp.Range replaceRange)
    {
        var value = ctx.Partial; // opening-quote .. caret (may hold earlier space-separated prefixes)
        int lastWs = -1;
        for (int i = 0; i < value.Length; i++)
        {
            if (char.IsWhiteSpace(value[i]))
            {
                lastWs = i;
            }
        }

        var currentToken = value.Substring(lastWs + 1);
        var listed = new HashSet<string>(
            value.Substring(0, lastWs + 1).Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries),
            StringComparer.Ordinal);

        // Replace ONLY the current token (after the last whitespace), not the whole multi-prefix value.
        var tokenRange = lastWs < 0
            ? replaceRange
            : doc.RangeOf(new TextSpan(ctx.ReplaceStart + lastWs + 1, offset));

        var items = new List<CompletionItem>();
        foreach (var declaration in scope.Declarations)
        {
            var prefix = declaration.Key;
            if (string.IsNullOrEmpty(prefix) ||
                !XamlNamespaces.IsDesignTime(declaration.Value) ||
                listed.Contains(prefix) ||
                !StartsWith(prefix, currentToken))
            {
                continue;
            }

            items.Add(new CompletionItem
            {
                Label = prefix,
                Kind = CompletionItemKind.Value,
                Detail = "Ignorable design-time prefix",
                TextEdit = new TextEdit { Range = tokenRange, NewText = prefix },
                FilterText = prefix,
                SortText = prefix,
            });
        }

        return Finish(items);
    }

    /// <summary>Extracts the design-time DataContext type name from a d:DataContext value shaped like {d:DesignInstance Type=local:Foo, IsDesignTimeCreatable=True}</summary>
    internal static string? ParseDesignInstanceType(string? value)
    {
        var text = value?.Trim();
        if (string.IsNullOrEmpty(text) || text![0] != '{')
        {
            return null;
        }

        int i = 1;
        while (i < text.Length && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        int nameStart = i;
        while (i < text.Length && (char.IsLetterOrDigit(text[i]) || text[i] == ':'))
        {
            i++;
        }

        if (LocalPart(text.Substring(nameStart, i - nameStart)) != "DesignInstance")
        {
            return null;
        }

        // Bound the argument list to the extension's matching '}'.
        int end = i;
        int braceDepth = 1;
        while (end < text.Length)
        {
            char ch = text[end];
            if (ch == '{')
            {
                braceDepth++;
            }
            else if (ch == '}')
            {
                braceDepth--;
                if (braceDepth == 0)
                {
                    break;
                }
            }

            end++;
        }

        // Split the args on TOP-LEVEL commas; prefer an explicit Type=, else the first positional value.
        string? positional = null;
        int argStart = i;
        int depth = 0;
        for (int j = i; j <= end; j++)
        {
            bool boundary = j >= end;
            char ch = boundary ? ',' : text[j];
            if (!boundary && ch is '(' or '{' or '[')
            {
                depth++;
            }
            else if (!boundary && ch is ')' or '}' or ']')
            {
                if (depth > 0)
                {
                    depth--;
                }
            }
            else if (ch == ',' && depth == 0)
            {
                var (name, val) = SplitMarkupArg(text, argStart, j);
                if (name == "Type")
                {
                    return XamlSemanticFacts.NormalizeTypeToken(val);
                }

                if (name is null && positional is null && val.Length > 0)
                {
                    positional = XamlSemanticFacts.NormalizeTypeToken(val);
                }

                argStart = j + 1;
            }

            if (boundary)
            {
                break;
            }
        }

        return positional;
    }

    /// <summary>The local part of a possibly-prefixed markup name (<c>d:DesignInstance</c> → <c>DesignInstance</c>).</summary>
    private static string LocalPart(string name)
    {
        int colon = name.IndexOf(':');
        return colon >= 0 ? name.Substring(colon + 1) : name;
    }

    /// <summary>The prefix of a possibly-prefixed markup name (<c>d:DesignInstance</c> → <c>d</c>; empty when none).</summary>
    private static string PrefixPart(string name)
    {
        int colon = name.IndexOf(':');
        return colon >= 0 ? name.Substring(0, colon) : string.Empty;
    }

    /// <summary>Reads the leading markup-extension name from a value like {d:DesignInstance …} → d:DesignInstance.</summary>
    private static string? ReadExtensionName(string? value)
    {
        var text = value?.Trim();
        if (string.IsNullOrEmpty(text) || text![0] != '{')
        {
            return null;
        }

        int i = 1;
        while (i < text.Length && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        int start = i;
        while (i < text.Length && (char.IsLetterOrDigit(text[i]) || text[i] == ':'))
        {
            i++;
        }

        var name = text.Substring(start, i - start);
        return name.Length > 0 ? name : null;
    }

    /// <summary>True when value is a DesignInstance markup extension whose PREFIX resolves to a design-time namespace — mirroring the d:DataContext attribute check</summary>
    private static bool IsDesignInstanceExtension(string? value, XamlNamespaceScope scope)
    {
        var name = ReadExtensionName(value);
        if (name is null || LocalPart(name) != "DesignInstance")
        {
            return false;
        }

        var prefix = PrefixPart(name);
        return prefix.Length > 0
            && scope.TryResolvePrefix(prefix, out var uri)
            && XamlNamespaces.IsDesignTime(uri);
    }

    /// <summary>Splits a markup-extension argument into (name, value) on its first TOP-LEVEL =; a positional argument (no =) returns a null name and the whole trimmed token as the value.</summary>
    private static (string? name, string val) SplitMarkupArg(string text, int start, int endExclusive)
    {
        int eq = -1;
        int depth = 0;
        for (int j = start; j < endExclusive; j++)
        {
            char ch = text[j];
            if (ch is '(' or '{' or '[')
            {
                depth++;
            }
            else if (ch is ')' or '}' or ']')
            {
                if (depth > 0)
                {
                    depth--;
                }
            }
            else if (ch == '=' && depth == 0)
            {
                eq = j;
                break;
            }
        }

        return eq >= 0
            ? (text.Substring(start, eq - start).Trim(), text.Substring(eq + 1, endExclusive - eq - 1).Trim())
            : (null, text.Substring(start, endExclusive - start).Trim());
    }


    private static int BindMemberKind(ISymbol member) => member switch
    {
        IMethodSymbol => CompletionItemKind.Method,
        IFieldSymbol => CompletionItemKind.Field,
        _ => CompletionItemKind.Property,
    };

    private static string DescribeBindMember(ISymbol member)
    {
        var type = XamlTypeSystem.GetMemberType(member);
        var typeName = type?.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat) ?? "?";
        var kind = member switch
        {
            IMethodSymbol => "method",
            IFieldSymbol => "field",
            _ => "property",
        };
        return $"{kind} : {typeName}";
    }

    // --- Context classification -------------------------------------------------------------------

}
