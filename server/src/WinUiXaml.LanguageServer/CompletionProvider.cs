using System;
using System.Collections.Generic;
using Microsoft.CodeAnalysis;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Workspace;
using WinUiXaml.Xaml;

namespace WinUiXaml.LanguageServer;

/// <summary>Produces XAML completion items for the caret context.</summary>
internal static partial class CompletionProvider
{
    private enum ContextKind { None, ElementName, AttributeName, AttributeValue, BindPath, MarkupName, MarkupArg, ResourceKey, TemplateBinding, TypeName, StaticMember, CloseTag, UsingNamespace, XmlnsValue, DesignInstanceType }

    public static CompletionList Provide(TextDocument doc, int offset, XamlTypeSystem typeSystem, INamedTypeSymbol? pageClass = null, IReadOnlyCollection<string>? appResourceKeys = null)
        => ProvideCore(doc, offset, typeSystem, pageClass, appResourceKeys, null);

    internal static CompletionList ProvideForTest(
        TextDocument doc,
        int offset,
        XamlTypeSystem typeSystem,
        Action<string, string> themeTypeResolutionObserver)
        => ProvideCore(doc, offset, typeSystem, null, null, themeTypeResolutionObserver);

    private static CompletionList ProvideCore(
        TextDocument doc,
        int offset,
        XamlTypeSystem typeSystem,
        INamedTypeSymbol? pageClass,
        IReadOnlyCollection<string>? appResourceKeys,
        Action<string, string>? themeTypeResolutionObserver)
    {
        var ctx = Classify(doc.Text, offset);
        if (ctx.Kind == ContextKind.None)
        {
            return new CompletionList();
        }

        var scope = EffectiveScope(doc.Parsed.FindNode(Math.Max(0, offset - 1)), doc.Parsed);
        var replaceRange = doc.RangeOf(new TextSpan(ctx.ReplaceStart, offset));

        return ctx.Kind switch
        {
            ContextKind.ElementName => CompleteElementName(doc, ctx, scope, typeSystem, replaceRange, ResolveChildContentType(doc, ctx, scope, typeSystem)),
            ContextKind.CloseTag => CompleteCloseTag(doc, offset, ctx.ReplaceStart, replaceRange),
            ContextKind.AttributeValue => MaybeQuoteUnquotedValues(CompleteAttributeValue(doc, offset, ctx, scope, typeSystem, pageClass, replaceRange), doc, offset, ctx),
            ContextKind.BindPath => CompleteBindPath(doc, offset, ctx, scope, typeSystem, pageClass, replaceRange),
            ContextKind.MarkupName => CompleteMarkupName(ctx, replaceRange),
            ContextKind.MarkupArg => CompleteMarkupArg(doc, ctx, typeSystem, replaceRange),
            ContextKind.ResourceKey => CompleteResourceKey(
                doc, offset, ctx, scope, typeSystem, appResourceKeys, replaceRange, themeTypeResolutionObserver),
            ContextKind.TemplateBinding => CompleteTemplateBinding(doc, offset, ctx, scope, typeSystem, replaceRange),
            ContextKind.TypeName => CompleteTypeNameValue(ctx.Partial, scope, typeSystem, replaceRange, allTypeKinds: true),
            ContextKind.DesignInstanceType => CompleteDesignInstanceType(ctx, scope, typeSystem, replaceRange),
            ContextKind.StaticMember => CompleteStaticMember(ctx, scope, typeSystem, replaceRange),
            ContextKind.UsingNamespace => CompleteUsingNamespace(ctx, typeSystem, replaceRange),
            ContextKind.XmlnsValue => CompleteXmlnsValue(ctx, replaceRange),
            _ => CompleteAttributeName(doc, offset, ctx, scope, typeSystem, replaceRange),
        };
    }

    /// <summary>Quotes unquoted completions and replaces the entire value token.</summary>
    private static CompletionList MaybeQuoteUnquotedValues(CompletionList list, TextDocument doc, int offset, Context ctx)
    {
        if (!ctx.IsUnquoted || list.Items.Count == 0)
        {
            return list;
        }

        var wholeToken = doc.RangeOf(new TextSpan(ctx.ReplaceStart, ValueTokenEnd(doc.Text, offset)));
        foreach (var item in list.Items)
        {
            if (item.TextEdit is { } edit)
            {
                edit.Range = wholeToken;
                edit.NewText = "\"" + edit.NewText + "\"";
            }
        }

        return list;
    }

    /// <summary>Returns a stable description of the caret context for tests.</summary>
    internal static string ClassifyForTest(string text, int offset)
    {
        var ctx = Classify(text, offset);
        return ctx.Kind switch
        {
            ContextKind.None => "None",
            ContextKind.BindPath => (ctx.IsClassicBinding ? "ClassicBindPath" : "BindPath")
                + (string.IsNullOrEmpty(ctx.BindElementName) ? string.Empty : $"@{ctx.BindElementName}")
                + ":" + (string.IsNullOrEmpty(ctx.BindCastType)
                ? $"{ctx.BindPrefixPath}|{ctx.Partial}"
                : $"({ctx.BindCastType}){ctx.BindPrefixPath}|{ctx.Partial}"),
            ContextKind.AttributeValue => $"AttributeValue:{ctx.AttributeName}:{ctx.Partial}",
            ContextKind.StaticMember => $"StaticMember:{ctx.BindPrefixPath}:{ctx.Partial}",
            ContextKind.DesignInstanceType => $"DesignInstanceType:{ctx.BindPrefixPath}:{ctx.Partial}",
            _ => $"{ctx.Kind}:{ctx.Partial}",
        };
    }

    /// <summary>Returns close-tag completion edits for tests.</summary>
    internal static IReadOnlyList<string> CloseTagItemsForTest(string text, int offset)
    {
        var doc = new TextDocument("test://close-tag", text);
        var ctx = Classify(doc.Text, offset);
        if (ctx.Kind != ContextKind.CloseTag)
        {
            return System.Array.Empty<string>();
        }

        var replaceRange = doc.RangeOf(new TextSpan(ctx.ReplaceStart, offset));
        var list = CompleteCloseTag(doc, offset, ctx.ReplaceStart, replaceRange);
        var result = new List<string>();
        foreach (var item in list.Items)
        {
            result.Add($"{item.Label}=>{item.TextEdit?.NewText ?? item.InsertText}");
        }

        return result;
    }

}
