using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using WinUiXaml.Workspace;

namespace WinUiXaml.Workspace.Tests;

/// <summary>
/// Hermetic tests for <see cref="XamlTypeSystem"/>. These synthesize small in-memory C# compilations
/// (no WinUI SDK, no MSBuild) that mimic the shapes the provider must understand: WinUI-convention
/// namespaces, XmlnsDefinitionAttribute-declared namespaces, base-type member inheritance, events, and
/// the attached-property Get/Set pattern.
/// </summary>
public sealed class XamlTypeSystemTests
{
    private const string Presentation = XamlTypeSystem.PresentationNamespace;

    // A library that follows the WinUI convention: controls live under Microsoft.UI.Xaml*, with a small
    // inheritance chain (UIElement -> Control -> Button) plus a Grid exposing an attached Row property.
    private const string WinUiLikeSource = """
        namespace Microsoft.UI.Xaml
        {
            public class DependencyObject { }
            public class UIElement : DependencyObject { }
        }
        namespace Microsoft.UI.Xaml.Controls
        {
            public class Control : Microsoft.UI.Xaml.UIElement
            {
                public bool IsEnabled { get; set; }
            }
            public class ContentControl : Control
            {
                public object Content { get; set; }
            }
            public delegate void RoutedEventHandler(object sender, object e);
            public class ButtonBase : ContentControl
            {
                public event RoutedEventHandler Click;
            }
            public class Button : ButtonBase { }
            public class Grid : Control
            {
                public static int GetRow(Microsoft.UI.Xaml.DependencyObject obj) => 0;
                public static void SetRow(Microsoft.UI.Xaml.DependencyObject obj, int value) { }
                // A getter with no matching setter must NOT be reported as an attached property.
                public static int GetActualRow(Microsoft.UI.Xaml.DependencyObject obj) => 0;
            }
            public class RelativePanel : Control
            {
                public static object GetRightOf(Microsoft.UI.Xaml.UIElement element) => new object();
                public static void SetRightOf(Microsoft.UI.Xaml.UIElement element, object value) { }
                public static bool GetAlignTopWithPanel(Microsoft.UI.Xaml.UIElement element) => false;
                public static void SetAlignTopWithPanel(Microsoft.UI.Xaml.UIElement element, bool value) { }
            }
            public static class ToolTipService
            {
                public static object GetToolTip(Microsoft.UI.Xaml.DependencyObject element) => new object();
                public static void SetToolTip(Microsoft.UI.Xaml.DependencyObject element, object value) { }
            }
        }
        namespace Microsoft.UI.Xaml.Markup
        {
            public abstract class MarkupExtension { }
        }
        namespace TestApp
        {
            public class RelativePanel
            {
                public static object GetRightOf(Microsoft.UI.Xaml.UIElement element) => new object();
                public static void SetRightOf(Microsoft.UI.Xaml.UIElement element, object value) { }
            }
            public sealed class CurrentThemeExtension : Microsoft.UI.Xaml.Markup.MarkupExtension
            {
                public bool Invert { get; set; }
            }
            public sealed class LookalikeExtension { }
        }
        """;

    [Fact]
    public void ResolvesElementFromPresentationNamespaceByConvention()
    {
        var (compilation, referenced) = CompileLibraryAndConsumer(WinUiLikeSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        var button = ts.ResolveType(Presentation, "Button");
        var grid = ts.ResolveType(Presentation, "Grid");

        Assert.NotNull(button);
        Assert.Equal("Microsoft.UI.Xaml.Controls.Button", button!.ToDisplayString());
        Assert.NotNull(grid);
        Assert.Equal("Microsoft.UI.Xaml.Controls.Grid", grid!.ToDisplayString());
    }

    [Fact]
    public void ResolvesWindowsColorFromPresentationNamespace()
    {
        const string source = """
            namespace Microsoft.UI.Xaml { public class Page { } }
            namespace Windows.UI { public struct Color { } }
            """;
        var (compilation, referenced) = CompileLibraryAndConsumer(source);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        var color = ts.ResolveType(Presentation, "Color");

        Assert.NotNull(color);
        Assert.Equal("Windows.UI.Color", color.ToDisplayString());
    }

    [Fact]
    public void UnknownElementResolvesToNull()
    {
        var (compilation, referenced) = CompileLibraryAndConsumer(WinUiLikeSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        Assert.Null(ts.ResolveType(Presentation, "NoSuchControl"));
    }

    [Fact]
    public void Capabilities_AreCapturedOnceWithoutMissingSymbolFallbacks()
    {
        var (compilation, referenced) = CompileLibraryAndConsumer(WinUiLikeSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        Assert.Same(
            ts.ResolveMetadataType("Microsoft.UI.Xaml.Controls.RelativePanel"),
            ts.Capabilities.RelativePanel);
        Assert.Same(
            ts.ResolveMetadataType("Microsoft.UI.Xaml.Markup.MarkupExtension"),
            ts.Capabilities.MarkupExtension);
        Assert.Null(ts.Capabilities.Setter);
    }

    [Fact]
    public void IsAssignableToSupportsBasesObjectAndInheritedInterfaces()
    {
        const string source = """
            namespace TestTypes
            {
                public interface IBase { }
                public interface IDerived : IBase { }
                public interface IUnrelated { }
                public class Base : IDerived { }
                public class Derived : Base { }
            }
            """;
        var (compilation, referenced) = CompileLibraryAndConsumer(source);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);
        var derived = ts.ResolveMetadataType("TestTypes.Derived")!;
        var baseType = ts.ResolveMetadataType("TestTypes.Base")!;
        var derivedInterface = ts.ResolveMetadataType("TestTypes.IDerived")!;
        var baseInterface = ts.ResolveMetadataType("TestTypes.IBase")!;
        var unrelatedInterface = ts.ResolveMetadataType("TestTypes.IUnrelated")!;
        var objectType = compilation.GetSpecialType(SpecialType.System_Object);

        Assert.True(XamlTypeSystem.IsAssignableTo(derived, derived));
        Assert.True(XamlTypeSystem.IsAssignableTo(derived, baseType));
        Assert.True(XamlTypeSystem.IsAssignableTo(derived, objectType));
        Assert.True(XamlTypeSystem.IsAssignableTo(derived, derivedInterface));
        Assert.True(XamlTypeSystem.IsAssignableTo(derived, baseInterface));
        Assert.False(XamlTypeSystem.IsAssignableTo(baseType, derived));
        Assert.False(XamlTypeSystem.IsAssignableTo(derived, unrelatedInterface));
    }

    [Theory]
    [InlineData(null, true)]
    [InlineData("RelativePanel", false)]
    [InlineData("UIElement", false)]
    [InlineData("Setter", false)]
    [InlineData("Storyboard", false)]
    [InlineData("MarkupExtension", false)]
    [InlineData("Binding", false)]
    public void CompleteNameReferenceSemanticsRequiresEveryClassifierType(
        string? missingType,
        bool expected)
    {
        var markupExtension = missingType != "MarkupExtension"
            ? "namespace Microsoft.UI.Xaml.Markup { public abstract class MarkupExtension { } }"
            : string.Empty;
        var bindingBase = missingType != "MarkupExtension"
            ? "Microsoft.UI.Xaml.Markup.MarkupExtension"
            : "object";
        var binding = missingType != "Binding"
            ? $"namespace Microsoft.UI.Xaml.Data {{ public class Binding : {bindingBase} {{ }} }}"
            : string.Empty;
        var source = $$"""
            namespace Microsoft.UI.Xaml
            {
                {{(missingType != "UIElement" ? "public class UIElement { }" : string.Empty)}}
                {{(missingType != "Setter" ? "public class Setter { }" : string.Empty)}}
            }
            namespace Microsoft.UI.Xaml.Controls
            {
                {{(missingType != "RelativePanel" ? "public class RelativePanel { }" : string.Empty)}}
            }
            namespace Microsoft.UI.Xaml.Media.Animation
            {
                {{(missingType != "Storyboard" ? "public class Storyboard { }" : string.Empty)}}
            }
            {{markupExtension}}
            {{binding}}
            """;
        var compilation = CSharpCompilation.Create(
            "TestApp",
            [CSharpSyntaxTree.ParseText(source)],
            [MetadataReference.CreateFromFile(typeof(object).Assembly.Location)],
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var ts = XamlTypeSystem.FromCompilation(
            compilation,
            ImmutableArray<IAssemblySymbol>.Empty);

        Assert.Equal(expected, ts.Capabilities.HasCompleteNameReferenceSemantics);
    }

    [Fact]
    public void MarkupExtensionTypes_AreSdkDerivedAndCached()
    {
        var (compilation, referenced) = CompileLibraryAndConsumer(WinUiLikeSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        var first = ts.GetMarkupExtensionTypes("using:TestApp");
        var second = ts.GetMarkupExtensionTypes("using:TestApp");

        Assert.Same(first, second);
        Assert.Equal(
            new[] { "TestApp.CurrentThemeExtension" },
            first.Select(type => type.ToDisplayString()));
    }

    [Fact]
    public void MarkupExtensionNamespaceCacheCanonicalizesAndBoundsMisses()
    {
        var (compilation, referenced) = CompileLibraryAndConsumer(WinUiLikeSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        for (var index = 0; index < 300; index++)
        {
            Assert.Empty(ts.GetMarkupExtensionTypes($"using:Missing.Namespace{index}"));
        }

        Assert.Equal(256, ts.MarkupExtensionNamespaceCacheCount);
        var first = ts.GetMarkupExtensionTypes("using:TestApp");
        var second = ts.GetMarkupExtensionTypes("using: TestApp ");
        Assert.Same(first, second);
        Assert.Equal(257, ts.MarkupExtensionNamespaceCacheCount);
    }

    [Fact]
    public void MarkupExtensionNamespaceCacheBoundsConcurrentMissesAndCanonicalizesClrNamespace()
    {
        var (compilation, referenced) = CompileLibraryAndConsumer(WinUiLikeSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        Parallel.For(
            0,
            1000,
            index => Assert.Empty(
                ts.GetMarkupExtensionTypes($"using:Missing.Concurrent{index}")));
        Assert.Equal(256, ts.MarkupExtensionNamespaceCacheCount);

        Assert.Empty(ts.GetMarkupExtensionTypes("using:" + new string('A', 1025)));
        Assert.Equal(256, ts.MarkupExtensionNamespaceCacheCount);

        var first = ts.GetMarkupExtensionTypes(
            "clr-namespace:TestApp;assembly=TestLib");
        var second = ts.GetMarkupExtensionTypes(
            "clr-namespace: TestApp ; Assembly= testlib ");
        Assert.Same(first, second);
        Assert.Equal(257, ts.MarkupExtensionNamespaceCacheCount);
    }

    [Fact]
    public void RelativePanelElementReferences_AreDerivedFromExactSdkOwnerAndGetterSignature()
    {
        var (compilation, referenced) = CompileLibraryAndConsumer(WinUiLikeSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);
        var relativePanel = ts.ResolveMetadataType("Microsoft.UI.Xaml.Controls.RelativePanel")!;
        var toolTipService = ts.ResolveMetadataType("Microsoft.UI.Xaml.Controls.ToolTipService")!;
        var lookalike = ts.ResolveMetadataType("TestApp.RelativePanel")!;

        Assert.True(ts.IsRelativePanelElementReference(relativePanel, "RightOf"));
        Assert.False(ts.IsRelativePanelElementReference(relativePanel, "AlignTopWithPanel"));
        Assert.False(ts.IsRelativePanelElementReference(toolTipService, "ToolTip"));
        Assert.False(ts.IsRelativePanelElementReference(lookalike, "RightOf"));
    }

    [Fact]
    public void ResolvesXamlIntrinsicLanguageTypesToClrTypes()
    {
        var (compilation, referenced) = CompileLibraryAndConsumer(WinUiLikeSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        // The XAML language namespace (x:) intrinsics map to their CLR types so that, e.g.,
        // <DataTemplate x:DataType="x:String"> re-roots {x:Bind} against string members.
        Assert.Equal(SpecialType.System_String, ts.ResolveType(XamlTypeSystem.XamlLanguageNamespace, "String")?.SpecialType);
        Assert.Equal(SpecialType.System_Int32, ts.ResolveType(XamlTypeSystem.XamlLanguageNamespace, "Int32")?.SpecialType);
        Assert.Equal(SpecialType.System_Boolean, ts.ResolveType(XamlTypeSystem.XamlLanguageNamespace, "Boolean")?.SpecialType);
        Assert.Equal(SpecialType.System_Double, ts.ResolveType(XamlTypeSystem.XamlLanguageNamespace, "Double")?.SpecialType);
        Assert.Equal(SpecialType.System_Object, ts.ResolveType(XamlTypeSystem.XamlLanguageNamespace, "Object")?.SpecialType);

        // A non-type name in the language namespace stays null (the Bind directive is not a type).
        Assert.Null(ts.ResolveType(XamlTypeSystem.XamlLanguageNamespace, "Bind"));
    }

    [Fact]
    public void GetXamlIntrinsicTypesEnumeratesAliasSymbolPairsForCompletion()
    {
        var (compilation, referenced) = CompileLibraryAndConsumer(WinUiLikeSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        var intrinsics = ts.GetXamlIntrinsicTypes(allTypeKinds: true).ToDictionary(p => p.Key, p => p.Value);

        // Every returned pair maps an alias to its resolved System.* symbol, and by convention each alias
        // equals its CLR short name (so completion can label with the alias and insert prefix:alias).
        foreach (var pair in intrinsics)
        {
            Assert.Equal(pair.Key, pair.Value.Name);
            Assert.Equal("System", pair.Value.ContainingNamespace?.ToDisplayString());
        }

        // All corelib-resident intrinsics resolve here (only System.Uri lives outside corelib and so is
        // absent from this minimal reference set — the real SDK compilation offers all 14).
        foreach (var alias in new[]
        {
            "Object", "Boolean", "Byte", "Char", "Decimal", "Single", "Double",
            "Int16", "Int32", "Int64", "String", "TimeSpan", "Type",
        })
        {
            Assert.Contains(alias, intrinsics.Keys);
        }

        Assert.Equal(SpecialType.System_String, intrinsics["String"].SpecialType);
        Assert.Equal(SpecialType.System_Boolean, intrinsics["Boolean"].SpecialType);
        Assert.Equal(SpecialType.System_Int32, intrinsics["Int32"].SpecialType);
        Assert.Equal(SpecialType.System_Object, intrinsics["Object"].SpecialType);
    }

    [Fact]
    public void GetXamlIntrinsicTypesRespectsAllTypeKindsForClassOnlySites()
    {
        var (compilation, referenced) = CompileLibraryAndConsumer(WinUiLikeSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        // allTypeKinds:false mirrors GetTypes (IsPublicClass) — a class-only reference site such as
        // TargetType="x:|" must offer only the reference-type intrinsics, never value-type aliases,
        // exactly as it filters CLR types to classes. (Uri is the 4th reference intrinsic but lives
        // outside the minimal hermetic corelib reference, so only Object/String/Type resolve here.)
        var classOnly = ts.GetXamlIntrinsicTypes(allTypeKinds: false).ToDictionary(p => p.Key, p => p.Value);
        foreach (var alias in new[] { "Object", "String", "Type" })
        {
            Assert.Contains(alias, classOnly.Keys);
            Assert.Equal(TypeKind.Class, classOnly[alias].TypeKind);
        }
        foreach (var valueAlias in new[]
        {
            "Boolean", "Byte", "Char", "Decimal", "Single", "Double", "Int16", "Int32", "Int64", "TimeSpan",
        })
        {
            Assert.DoesNotContain(valueAlias, classOnly.Keys);
        }

        // allTypeKinds:true (GetAllTypes / IsPublicType) is a strict superset that KEEPS the value types,
        // so kind-permissive sites ({x:Type}/{x:Static}/x:DataType) still offer the full alias set.
        var allKinds = ts.GetXamlIntrinsicTypes(allTypeKinds: true).ToDictionary(p => p.Key, p => p.Value);
        foreach (var alias in classOnly.Keys)
        {
            Assert.Contains(alias, allKinds.Keys);
        }
        Assert.Contains("Int32", allKinds.Keys);
        Assert.Contains("Boolean", allKinds.Keys);
        Assert.True(allKinds.Count > classOnly.Count, "allTypeKinds:true must be a strict superset of the class-only set");
    }

    [Fact]
    public void IsKnownNamespaceIsTrueForModeledAndFalseForForeignNamespaces()
    {
        var (compilation, referenced) = CompileLibraryAndConsumer(WinUiLikeSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        // The presentation namespace is modeled by convention; a design-time URI with no types is not.
        Assert.True(ts.IsKnownNamespace(Presentation));
        Assert.False(ts.IsKnownNamespace("http://schemas.microsoft.com/expression/blend/2008"));
    }

    [Fact]
    public void HasMemberIsLenientAcrossInheritanceEventsAndGetOnlyButRejectsTypos()
    {
        const string source = """
            namespace Microsoft.UI.Xaml.Controls
            {
                public delegate void Handler(object sender, object e);
                public class Base { public string Header { get; set; } }
                public class Widget : Base
                {
                    public object Content { get; set; }
                    public event Handler Tapped;
                    // Get-only property (XAML-settable via a type converter): still a real member.
                    public string Shorthand { get; }
                }
            }
            """;
        var (compilation, referenced) = CompileLibraryAndConsumer(source);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);
        var widget = ts.ResolveType(Presentation, "Widget");
        Assert.NotNull(widget);

        Assert.True(ts.HasMember(widget!, "Content"));    // own settable property
        Assert.True(ts.HasMember(widget!, "Header"));     // inherited property
        Assert.True(ts.HasMember(widget!, "Tapped"));     // event
        Assert.True(ts.HasMember(widget!, "Shorthand"));  // get-only, but a real member
        Assert.False(ts.HasMember(widget!, "Shorthnd"));  // typo

        // Contrast with FindMember (settable-only): it does not surface the get-only property.
        Assert.Null(ts.FindMember(widget!, "Shorthand"));
    }

    [Fact]
    public void GetMembersWalksBaseTypesForPropertiesAndEvents()
    {
        var (compilation, referenced) = CompileLibraryAndConsumer(WinUiLikeSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);
        var button = ts.ResolveType(Presentation, "Button")!;

        var members = ts.GetMembers(button).ToList();

        var content = members.SingleOrDefault(m => m.Name == "Content");
        var click = members.SingleOrDefault(m => m.Name == "Click");
        var isEnabled = members.SingleOrDefault(m => m.Name == "IsEnabled");

        Assert.NotNull(content);
        Assert.Equal(XamlMemberKind.Property, content!.Kind);
        Assert.Equal("ContentControl", content.DeclaringType.Name);

        Assert.NotNull(click);
        Assert.Equal(XamlMemberKind.Event, click!.Kind);
        Assert.Equal("ButtonBase", click.DeclaringType.Name);

        Assert.NotNull(isEnabled);
        Assert.Equal(XamlMemberKind.Property, isEnabled!.Kind);
        Assert.Equal("Control", isEnabled.DeclaringType.Name);
    }

    [Fact]
    public void FindMemberLocatesInheritedMember()
    {
        var (compilation, referenced) = CompileLibraryAndConsumer(WinUiLikeSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);
        var button = ts.ResolveType(Presentation, "Button")!;

        var member = ts.FindMember(button, "Content");

        Assert.NotNull(member);
        Assert.Equal(XamlMemberKind.Property, member!.Kind);
    }

    [Fact]
    public void GetAttachedPropertiesRequiresMatchedGetterAndSetter()
    {
        var (compilation, referenced) = CompileLibraryAndConsumer(WinUiLikeSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);
        var grid = ts.ResolveType(Presentation, "Grid")!;

        var attached = ts.GetAttachedProperties(grid).ToList();

        Assert.Contains(attached, m => m.Name == "Row" && m.Kind == XamlMemberKind.AttachedProperty);
        // GetActualRow has no SetActualRow, so it is not an attached property.
        Assert.DoesNotContain(attached, m => m.Name == "ActualRow");
    }

    [Fact]
    public void HasAttachedMemberIsLenientAcceptingEitherAccessorButRejectsUnknown()
    {
        var (compilation, referenced) = CompileLibraryAndConsumer(WinUiLikeSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);
        var grid = ts.ResolveType(Presentation, "Grid")!;

        // A matched Get/Set pair is obviously valid.
        Assert.True(ts.HasAttachedMember(grid, "Row"));
        // Lenient: a getter-only accessor still counts, so validation won't flag a real one-sided member.
        Assert.True(ts.HasAttachedMember(grid, "ActualRow"));
        // A genuine typo has neither accessor.
        Assert.False(ts.HasAttachedMember(grid, "Roww"));
        Assert.False(ts.HasAttachedMember(grid, string.Empty));
    }

    [Fact]
    public void ResolvesLocalTypeViaUsingScheme()
    {
        // The consumer assembly declares an app control under My.App; using: must resolve it.
        const string appSource = """
            namespace My.App
            {
                public class MyControl { public string Title { get; set; } }
            }
            """;
        var (compilation, referenced) = CompileLibraryAndConsumer(WinUiLikeSource, appSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        var type = ts.ResolveType("using:My.App", "MyControl");

        Assert.NotNull(type);
        Assert.Equal("My.App.MyControl", type!.ToDisplayString());
    }

    [Fact]
    public void FindNamespacesForTypeName_ReturnsSourceNamespaceForOwnType()
    {
        const string appSource = """
            namespace My.App.Controls
            {
                public class MyControl { public string Title { get; set; } }
            }
            """;
        var (compilation, referenced) = CompileLibraryAndConsumer(WinUiLikeSource, appSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        Assert.Equal(new[] { "My.App.Controls" }, ts.FindNamespacesForTypeName("MyControl").ToArray());
        Assert.Empty(ts.FindNamespacesForTypeName("NotDeclared"));
    }

    [Fact]
    public void FindNamespacesForTypeName_IsSourceOnly_NotReferencedMetadata()
    {
        // Button lives in the referenced TestLib metadata, not in the consumer's source. A custom prefix
        // must never be "fixed" with a using: for a framework/library type (those come through xmlns), so
        // the source-declaration search must return nothing for it.
        var (compilation, referenced) = CompileLibraryAndConsumer(WinUiLikeSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        Assert.Empty(ts.FindNamespacesForTypeName("Button"));
    }

    [Fact]
    public void FindNamespacesForTypeName_TwoNamespacesSameName_ReturnsBothSorted()
    {
        const string appSource = """
            namespace Zeta.Controls { public class MyPanel { } }
            namespace Alpha.Controls { public class MyPanel { } }
            """;
        var (compilation, referenced) = CompileLibraryAndConsumer(WinUiLikeSource, appSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        Assert.Equal(new[] { "Alpha.Controls", "Zeta.Controls" }, ts.FindNamespacesForTypeName("MyPanel").ToArray());
    }

    [Fact]
    public void FindNamespacesForTypeName_ExcludesStaticClassesAndGlobalNamespace()
    {
        const string appSource = """
            namespace Ns1 { public class Thing { } }
            namespace Ns2 { public static class Thing { } }
            public class Thing { }
            """;
        var (compilation, referenced) = CompileLibraryAndConsumer(WinUiLikeSource, appSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        // Only the instantiable, namespaced class qualifies: a static class can't be a XAML element and a
        // XAML element always needs a prefixed (non-global) namespace.
        Assert.Equal(new[] { "Ns1" }, ts.FindNamespacesForTypeName("Thing").ToArray());
    }

    [Fact]
    public void FindNamespacesForTypeName_EmptyNameReturnsEmpty()
    {
        var (compilation, referenced) = CompileLibraryAndConsumer(WinUiLikeSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        Assert.Empty(ts.FindNamespacesForTypeName(""));
    }

    [Fact]
    public void GetUsingNamespaces_ReturnsSourceNamespacesSortedAndDistinct()
    {
        const string appSource = """
            namespace Zeta.Controls { public class Widget { } }
            namespace Alpha.Controls { public class Panel { } public class Card { } }
            """;
        var (compilation, referenced) = CompileLibraryAndConsumer(WinUiLikeSource, appSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        // Ordinal-sorted, and Alpha.Controls appears once despite declaring two qualifying classes.
        Assert.Equal(new[] { "Alpha.Controls", "Zeta.Controls" }, ts.GetUsingNamespaces().ToArray());
    }

    [Fact]
    public void GetUsingNamespaces_IsSourceOnly_ExcludesReferencedMetadataNamespaces()
    {
        // The WinUi-like Button/Grid types live in the referenced TestLib metadata, not the consumer's
        // source. using: completion must offer only the project's OWN namespaces (framework/library types
        // are reached through their registered xmlns), so with no consumer source there is nothing to offer.
        var (compilation, referenced) = CompileLibraryAndConsumer(WinUiLikeSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        Assert.Empty(ts.GetUsingNamespaces());
    }

    [Fact]
    public void GetUsingNamespaces_ExcludesStaticOnly_NonPublic_Global_AndEmptyParentNamespaces()
    {
        const string appSource = """
            namespace Ok { public class Real { } }
            namespace StaticOnly { public static class Helpers { } }
            namespace HiddenOnly { internal class Secret { } }
            namespace Outer.Inner { public class Leaf { } }
            public class GlobalThing { }
            """;
        var (compilation, referenced) = CompileLibraryAndConsumer(WinUiLikeSource, appSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        // Internal source types are valid XAML types within their own assembly. StaticOnly (no
        // instantiable class), the global namespace (GlobalThing), and the empty parent "Outer"
        // (only a child namespace, no direct type) are excluded.
        Assert.Equal(new[] { "HiddenOnly", "Ok", "Outer.Inner" }, ts.GetUsingNamespaces().ToArray());
    }

    [Fact]
    public void TypeEnumeration_IncludesInternalProjectTypesButNotInternalReferencedTypes()
    {
        const string librarySource = """
            namespace Microsoft.UI.Xaml { public class DependencyObject { } }
            namespace Library.Controls
            {
                public class PublicLibraryControl : Microsoft.UI.Xaml.DependencyObject { }
                internal class InternalLibraryControl : Microsoft.UI.Xaml.DependencyObject { }
                internal class InternalLibraryModel { }
            }
            """;
        const string appSource = """
            namespace App.Controls
            {
                public class PublicAppControl : Microsoft.UI.Xaml.DependencyObject { }
                internal class InternalAppControl : Microsoft.UI.Xaml.DependencyObject { }
                internal class InternalAppModel { }
            }
            """;
        var (compilation, referenced) =
            CompileLibraryAndConsumer(librarySource, appSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        var appElements = ts.GetTypes("using:App.Controls")
            .Select(type => type.Name).ToHashSet();
        var appTypes = ts.GetAllTypes("using:App.Controls")
            .Select(type => type.Name).ToHashSet();
        var libraryElements = ts.GetTypes("using:Library.Controls")
            .Select(type => type.Name).ToHashSet();
        var libraryTypes = ts.GetAllTypes("using:Library.Controls")
            .Select(type => type.Name).ToHashSet();

        Assert.Contains("InternalAppControl", appElements);
        Assert.Contains("InternalAppModel", appTypes);
        Assert.NotNull(
            ts.ResolveType(
                "using:App.Controls",
                "InternalAppControl"));
        Assert.Contains("PublicLibraryControl", libraryElements);
        Assert.DoesNotContain("InternalLibraryControl", libraryElements);
        Assert.DoesNotContain("InternalLibraryModel", libraryTypes);
        Assert.Null(
            ts.ResolveType(
                "using:Library.Controls",
                "InternalLibraryControl"));
    }

    [Fact]
    public void GetUsingNamespaces_RequiresAnInstantiableClass_ExcludesEnumOrStructOnly()
    {
        const string appSource = """
            namespace ValuesOnly { public enum Mode { A, B } public struct Point { public int X; } }
            namespace HasClass { public class Control { } }
            """;
        var (compilation, referenced) = CompileLibraryAndConsumer(WinUiLikeSource, appSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        // Consistent with FindNamespacesForTypeName: a using: element target is an instantiable class, so a
        // namespace containing only an enum/struct is not offered.
        Assert.Equal(new[] { "HasClass" }, ts.GetUsingNamespaces().ToArray());
    }

    [Fact]
    public void StaticAttachedPropertyNamespaceIsKnownForValidation()
    {
        const string appSource = """
            namespace Extensions
            {
                public static class LayoutExtensions
                {
                    public static int GetOrder(object value) => 0;
                    public static void SetOrder(object value, int order) { }
                }
            }
            """;
        var (compilation, referenced) =
            CompileLibraryAndConsumer(WinUiLikeSource, appSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        Assert.True(ts.IsKnownNamespace("using:Extensions"));
    }

    [Fact]
    public void GetReferencedUsingNamespaces_IncludesReferencedFrameworkAndBclNamespaces()
    {
        // With no consumer source, everything comes from referenced metadata: the WinUi-like library
        // (Microsoft.UI.Xaml[.Controls]) AND the core BCL (System, ...). A control library referenced as an
        // assembly with no registered xmlns is reachable ONLY via using:, so it must be offered here.
        var (compilation, referenced) = CompileLibraryAndConsumer(WinUiLikeSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        var refs = ts.GetReferencedUsingNamespaces();
        Assert.Contains("Microsoft.UI.Xaml", refs);
        Assert.Contains("Microsoft.UI.Xaml.Controls", refs);
        Assert.Contains("System", refs); // proves the walk reaches BCL metadata, not just TestLib.

        // Ordinal-sorted and distinct so completion is deterministic.
        Assert.Equal(refs.OrderBy(n => n, StringComparer.Ordinal).ToArray(), refs.ToArray());
        Assert.Equal(refs.Count, refs.Distinct().Count());
    }

    [Fact]
    public void GetReferencedUsingNamespaces_ExcludesSourceNamespaces_DisjointFromGetUsingNamespaces()
    {
        const string appSource = """
            namespace Zeta.Controls { public class Widget { } }
            namespace Alpha.Controls { public class Panel { } }
            """;
        var (compilation, referenced) = CompileLibraryAndConsumer(WinUiLikeSource, appSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        var source = ts.GetUsingNamespaces();
        var refs = ts.GetReferencedUsingNamespaces();

        // The consumer's OWN namespaces are source (offered by GetUsingNamespaces), never referenced.
        Assert.DoesNotContain("Alpha.Controls", refs);
        Assert.DoesNotContain("Zeta.Controls", refs);
        // The two sets are disjoint, so completion never double-offers a namespace.
        Assert.Empty(refs.Intersect(source, StringComparer.Ordinal));
        // Referenced framework/library namespaces are still offered.
        Assert.Contains("Microsoft.UI.Xaml.Controls", refs);
    }

    [Fact]
    public void GetReferencedUsingNamespaces_IsCached_ReturnsSameInstance()
    {
        var (compilation, referenced) = CompileLibraryAndConsumer(WinUiLikeSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        // The reference closure is large, so the walk runs at most once per type-system instance.
        Assert.Same(ts.GetReferencedUsingNamespaces(), ts.GetReferencedUsingNamespaces());
    }

    [Fact]
    public void GetReferencedElementTypes_IncludesDependencyObjectDerivedReferencedTypes_ExcludesNonDoAndNonClass()
    {
        // A third-party control library (no registered xmlns) referenced as an assembly: its
        // DependencyObject-derived controls power the auto-xmlns element completion, while its non-DO
        // helpers, enums, and non-public types are the noise the filter must exclude.
        const string source = """
            namespace Microsoft.UI.Xaml
            {
                public class DependencyObject { }
                public class UIElement : DependencyObject { }
            }
            namespace Contoso.Controls
            {
                public class ContosoCard : Microsoft.UI.Xaml.DependencyObject { }
                public class ContosoPanel : Microsoft.UI.Xaml.UIElement { }
                public class ContosoService { }                                     // non-DO -> excluded
                public enum ContosoSizing { Small, Large }                          // enum -> excluded
                internal class ContosoHidden : Microsoft.UI.Xaml.DependencyObject { } // non-public -> excluded
                public abstract class ContosoAbstract : Microsoft.UI.Xaml.DependencyObject { }
                public class ContosoGeneric<T> : Microsoft.UI.Xaml.DependencyObject { }
            }
            """;
        var (compilation, referenced) = CompileLibraryAndConsumer(source);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        var names = ts.GetReferencedElementTypes().Select(t => t.Name).ToHashSet();

        Assert.Contains("ContosoCard", names);   // directly DependencyObject-derived
        Assert.Contains("ContosoPanel", names);  // DependencyObject-derived via UIElement
        Assert.DoesNotContain("ContosoService", names); // not a DependencyObject
        Assert.DoesNotContain("ContosoSizing", names);  // enum, not a class
        Assert.DoesNotContain("ContosoHidden", names);  // non-public
        Assert.DoesNotContain("ContosoAbstract", names); // abstract
        Assert.DoesNotContain("ContosoGeneric", names);  // open generic

        // The base-walk is O(depth) per type, so the result is cached once per instance.
        Assert.Same(ts.GetReferencedElementTypes(), ts.GetReferencedElementTypes());
    }

    [Fact]
    public void GetReferencedElementTypes_ExcludesSourceTypes_ReferencedOnly()
    {
        // Source and referenced controls are exposed through separate catalogs so completion can apply
        // the same prefix planning without conflating cross-assembly accessibility.
        const string librarySource = """
            namespace Microsoft.UI.Xaml { public class DependencyObject { } }
            namespace Contoso.Controls { public class ContosoCard : Microsoft.UI.Xaml.DependencyObject { } }
            """;
        const string consumerSource = """
            namespace App.Controls { public class AppCard : Microsoft.UI.Xaml.DependencyObject { } }
            """;
        var (compilation, referenced) = CompileLibraryAndConsumer(librarySource, consumerSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        var names = ts.GetReferencedElementTypes().Select(t => t.Name).ToHashSet();

        Assert.Contains("ContosoCard", names);    // referenced assembly
        Assert.DoesNotContain("AppCard", names);  // consumer source, not referenced
        Assert.Contains("AppCard", ts.GetSourceElementTypes().Select(t => t.Name));
    }

    [Fact]
    public void GetReferencedElementTypes_IsEmptyWhenDependencyObjectIsAbsent()
    {
        // A non-WinUI project (no Microsoft.UI.Xaml.DependencyObject) must degrade gracefully to no
        // third-party element suggestions rather than throwing.
        const string source = "namespace Contoso.Controls { public class ContosoCard { } }";
        var (compilation, referenced) = CompileLibraryAndConsumer(source);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        Assert.Empty(ts.GetReferencedElementTypes());
    }

    [Fact]
    public void ResolvesTypeViaClrNamespaceSchemeWithAssembly()
    {
        var (compilation, referenced) = CompileLibraryAndConsumer(WinUiLikeSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        var uri = "clr-namespace:Microsoft.UI.Xaml.Controls;assembly=TestLib";
        var button = ts.ResolveType(uri, "Button");

        Assert.NotNull(button);
        Assert.Equal("Microsoft.UI.Xaml.Controls.Button", button!.ToDisplayString());
    }

    [Fact]
    public void ResolveMetadataTypeFindsTypeByFullNameAndReturnsNullForUnknown()
    {
        var (compilation, referenced) = CompileLibraryAndConsumer(WinUiLikeSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        var button = ts.ResolveMetadataType("Microsoft.UI.Xaml.Controls.Button");
        Assert.NotNull(button);
        Assert.Equal("Microsoft.UI.Xaml.Controls.Button", button!.ToDisplayString());

        Assert.Null(ts.ResolveMetadataType("Microsoft.UI.Xaml.Controls.NoSuchType"));
        Assert.Null(ts.ResolveMetadataType(""));
    }

    [Fact]
    public void HonorsXmlnsDefinitionAttributeWhenPresent()
    {
        // A library that declares its own XmlnsDefinitionAttribute mapping a custom URI to a namespace.
        const string source = """
            [assembly: Contoso.Markup.XmlnsDefinition("http://contoso.com/ui", "Contoso.Controls")]
            namespace Contoso.Markup
            {
                [System.AttributeUsage(System.AttributeTargets.Assembly, AllowMultiple = true)]
                public sealed class XmlnsDefinitionAttribute : System.Attribute
                {
                    public XmlnsDefinitionAttribute(string xmlNamespace, string clrNamespace) { }
                }
            }
            namespace Contoso.Controls
            {
                public class Gadget { }
            }
            """;
        var (compilation, referenced) = CompileLibraryAndConsumer(source);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        var gadget = ts.ResolveType("http://contoso.com/ui", "Gadget");

        Assert.NotNull(gadget);
        Assert.Equal("Contoso.Controls.Gadget", gadget!.ToDisplayString());
    }

    [Fact]
    public void GetBindableMembersReturnsPropertiesFieldsAndMethodsWalkingInterfacesButSkippingObjectStaticAndNonPublic()
    {
        const string source = """
            namespace Vm
            {
                public interface IPerson { string Name { get; } }
                public interface IEmployee : IPerson { int Level { get; } }
                public class Customer
                {
                    public string Title { get; }
                    public int Age { get; set; }
                    public IEmployee Manager { get; }
                    public readonly int Id = 7;
                    private string Secret { get; }
                    public static string Global { get; }
                    public string Describe() => "";
                    internal string Hidden() => "";
                }
            }
            """;
        var (compilation, referenced) = CompileLibraryAndConsumer(source);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        var customer = compilation.GetTypeByMetadataName("Vm.Customer");
        Assert.NotNull(customer);

        var names = ts.GetBindableMembers(customer!).Select(m => m.Name).ToHashSet();
        Assert.Contains("Title", names);      // get-only property
        Assert.Contains("Age", names);        // read/write property
        Assert.Contains("Manager", names);    // interface-typed property (path continuation)
        Assert.Contains("Id", names);         // public field
        Assert.Contains("Describe", names);   // ordinary method (function binding)
        Assert.DoesNotContain("Secret", names);   // private
        Assert.DoesNotContain("Global", names);   // static
        Assert.DoesNotContain("Hidden", names);   // internal
        Assert.DoesNotContain("ToString", names); // System.Object member

        // GetMemberType drives dotted-path walking; the continuation type resolves the next segment.
        var manager = ts.GetBindableMembers(customer!).First(m => m.Name == "Manager");
        var managerType = XamlTypeSystem.GetMemberType(manager);
        Assert.NotNull(managerType);
        Assert.Equal("Vm.IEmployee", managerType!.ToDisplayString());

        // An interface root must surface its own and its inherited-interface members.
        var employeeMembers = ts.GetBindableMembers(managerType!).Select(m => m.Name).ToHashSet();
        Assert.Contains("Level", employeeMembers);
        Assert.Contains("Name", employeeMembers);
    }

    [Fact]
    public void GetAllTypesSurfacesEnumsStructsAndStaticClassesUnlikeGetTypes()
    {
        // Element-name completion (GetTypes) is instantiable-class-only, but type *references*
        // ({x:Type}, {x:Static} owner) must also offer enums, structs, and static classes — the usual
        // targets of those extensions (e.g. {x:Static Colors.Red}, {x:Type Thickness}).
        const string source = """
            namespace Microsoft.UI.Xaml.Controls
            {
                public class SampleControl { }
                public enum SampleVisibility { Visible, Collapsed }
                public struct SampleThickness { public int Width; }
                public static class SampleColors { public static int Red => 0; }
            }
            """;
        var (compilation, referenced) = CompileLibraryAndConsumer(source);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        var elementNames = ts.GetTypes(Presentation).Select(t => t.Name).ToHashSet();
        var allNames = ts.GetAllTypes(Presentation).Select(t => t.Name).ToHashSet();

        Assert.Contains("SampleControl", elementNames);
        Assert.DoesNotContain("SampleVisibility", elementNames);   // enum excluded from element list
        Assert.DoesNotContain("SampleThickness", elementNames);    // struct excluded
        Assert.DoesNotContain("SampleColors", elementNames);       // static class excluded

        Assert.Contains("SampleControl", allNames);
        Assert.Contains("SampleVisibility", allNames);
        Assert.Contains("SampleThickness", allNames);
        Assert.Contains("SampleColors", allNames);
    }

    [Fact]
    public void GetNamedColorsReturnsStaticPublicPropertyNamesOfMicrosoftUiColors()
    {
        // Named-color value completion resolves the color NAMES at runtime from Microsoft.UI.Colors'
        // static public properties (zero SDK drift). Only properties count — a static method (FromArgb)
        // and a non-public property (Secret) must be excluded.
        const string source = """
            namespace Windows.UI { public struct Color { } }
            namespace Microsoft.UI
            {
                public static class Colors
                {
                    public static Windows.UI.Color Red { get; }
                    public static Windows.UI.Color CornflowerBlue { get; }
                    public static Windows.UI.Color Transparent { get; }
                    internal static Windows.UI.Color Secret { get; }
                    public static Windows.UI.Color FromArgb(byte a, byte r, byte g, byte b) => default;
                }
            }
            """;
        var (compilation, referenced) = CompileLibraryAndConsumer(source);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        var names = ts.GetNamedColors();

        Assert.Contains("Red", names);
        Assert.Contains("CornflowerBlue", names);
        Assert.Contains("Transparent", names);
        Assert.DoesNotContain("Secret", names);     // non-public
        Assert.DoesNotContain("FromArgb", names);    // method, not a property
        Assert.Equal(3, names.Count);

        // Cached: derived purely from the immutable compilation, so the same instance is returned.
        Assert.Same(names, ts.GetNamedColors());
    }

    [Fact]
    public void GetNamedColorsIsEmptyWhenColorsTypeIsAbsent()
    {
        // A project without a WinUI reference (no Microsoft.UI.Colors) degrades to no suggestions,
        // never a failure.
        var (compilation, referenced) = CompileLibraryAndConsumer(WinUiLikeSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        Assert.Empty(ts.GetNamedColors());
    }

    [Fact]
    public void GetFontWeightsReturnsStaticPublicPropertyNamesOfMicrosoftUiTextFontWeights()
    {
        // Font-weight value completion resolves the weight NAMES at runtime from
        // Microsoft.UI.Text.FontWeights' static public properties (zero SDK drift). Only properties count —
        // a static method (FromValue) and a non-public property (Secret) must be excluded.
        const string source = """
            namespace Windows.UI.Text { public struct FontWeight { } }
            namespace Microsoft.UI.Text
            {
                public static class FontWeights
                {
                    public static Windows.UI.Text.FontWeight Thin { get; }
                    public static Windows.UI.Text.FontWeight SemiBold { get; }
                    public static Windows.UI.Text.FontWeight Bold { get; }
                    internal static Windows.UI.Text.FontWeight Secret { get; }
                    public static Windows.UI.Text.FontWeight FromValue(ushort w) => default;
                }
            }
            """;
        var (compilation, referenced) = CompileLibraryAndConsumer(source);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        var names = ts.GetFontWeights();

        Assert.Contains("Thin", names);
        Assert.Contains("SemiBold", names);
        Assert.Contains("Bold", names);
        Assert.DoesNotContain("Secret", names);     // non-public
        Assert.DoesNotContain("FromValue", names);   // method, not a property
        Assert.Equal(3, names.Count);

        // Cached: derived purely from the immutable compilation, so the same instance is returned.
        Assert.Same(names, ts.GetFontWeights());
    }

    [Fact]
    public void GetFontWeightsIsEmptyWhenFontWeightsTypeIsAbsent()
    {
        // A project without a WinUI reference (no Microsoft.UI.Text.FontWeights) degrades to no
        // suggestions, never a failure.
        var (compilation, referenced) = CompileLibraryAndConsumer(WinUiLikeSource);
        var ts = XamlTypeSystem.FromCompilation(compilation, referenced);

        Assert.Empty(ts.GetFontWeights());
    }

    [Fact]
    public void GetThemeResourcesReadsManagedGenericXamlAndCachesPerTypeSystem()
    {
        var root = CreateTemporaryDirectory();
        try
        {
            var (ts, genericXaml) = CreateFileBackedWinUiTypeSystem(root);
            WriteGenericXaml(genericXaml,
                """<SolidColorBrush x:Key="SdkBrush" /><Style x:Key="SdkStyle" />""");

            var first = ts.GetThemeResources();

            Assert.Collection(first.Where(resource => resource.Key.StartsWith("Sdk", StringComparison.Ordinal)),
                resource =>
                {
                    Assert.Equal("SdkBrush", resource.Key);
                    Assert.Equal(Presentation, resource.TypeNamespace);
                    Assert.Equal("SolidColorBrush", resource.LocalTypeName);
                },
                resource => Assert.Equal("SdkStyle", resource.Key));

            WriteGenericXaml(genericXaml, """<CornerRadius x:Key="NewSdkRadius" />""");
            Assert.Same(first, ts.GetThemeResources());

            var (updatedTypeSystem, _) = CreateFileBackedWinUiTypeSystem(root);
            Assert.Equal(
                "NewSdkRadius",
                Assert.Single(updatedTypeSystem.GetThemeResources(), resource => resource.Key == "NewSdkRadius").Key);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void GetThemeResourcesPrefersManagedGenericXamlWithNativeFallback()
    {
        var root = CreateTemporaryDirectory();
        try
        {
            var (ts, managedXaml) = CreateFileBackedWinUiTypeSystem(root);
            var nativeXaml = Path.Combine(root, "lib", "native", "Microsoft.UI", "Themes", "generic.xaml");
            WriteGenericXaml(managedXaml, """<Style x:Key="ManagedKey" />""");
            WriteGenericXaml(nativeXaml, """<Style x:Key="NativeKey" />""");

            Assert.Equal(
                "ManagedKey",
                Assert.Single(ts.GetThemeResources(), resource => resource.Key == "ManagedKey").Key);

            File.Delete(managedXaml);
            var (fallbackTypeSystem, _) = CreateFileBackedWinUiTypeSystem(root);
            Assert.Equal(
                "NativeKey",
                Assert.Single(fallbackTypeSystem.GetThemeResources(), resource => resource.Key == "NativeKey").Key);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void GetThemeResourcesIncludesWindowsSdkSystemColors()
    {
        var root = CreateTemporaryDirectory();
        try
        {
            var (typeSystem, genericXaml) = CreateFileBackedWinUiTypeSystem(root);
            WriteGenericXaml(genericXaml, """<Style x:Key="FrameworkStyle" />""");

            var resources = typeSystem.GetThemeResources().ToDictionary(resource => resource.Key);
            foreach (var key in new[]
                     {
                         "SystemColorButtonFaceColor",
                         "SystemColorButtonTextColor",
                         "SystemColorGrayTextColor",
                         "SystemColorHighlightColor",
                         "SystemColorHighlightTextColor",
                         "SystemColorHotlightColor",
                         "SystemColorWindowColor",
                         "SystemColorWindowTextColor",
                     })
            {
                Assert.Equal("Color", resources[key].LocalTypeName);
                Assert.Equal(Presentation, resources[key].TypeNamespace);
            }
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void GetThemeResourcesDegradesSafelyForAbsentOrMalformedGenericXaml()
    {
        var root = CreateTemporaryDirectory();
        try
        {
            var (absentTypeSystem, genericXaml) = CreateFileBackedWinUiTypeSystem(root);
            Assert.Empty(absentTypeSystem.GetThemeResources());
            Assert.False(absentTypeSystem.IsResourceCatalogAuthoritative);

            Directory.CreateDirectory(Path.GetDirectoryName(genericXaml)!);
            File.WriteAllText(genericXaml, """<!DOCTYPE x [<!ENTITY e SYSTEM "file:///ignored">]><x>&e;</x>""");
            var (malformedTypeSystem, _) = CreateFileBackedWinUiTypeSystem(root);
            Assert.Empty(malformedTypeSystem.GetThemeResources());
            Assert.False(malformedTypeSystem.IsResourceCatalogAuthoritative);

            WriteGenericXaml(genericXaml, string.Empty);
            var (emptyTypeSystem, _) = CreateFileBackedWinUiTypeSystem(root);
            Assert.Empty(emptyTypeSystem.GetThemeResources());
            Assert.False(emptyTypeSystem.IsResourceCatalogAuthoritative);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ResourceCatalogAuthorityRequiresPlatformOnlyReferences()
    {
        var root = CreateTemporaryDirectory();
        try
        {
            var (platformTypeSystem, genericXaml) = CreateFileBackedWinUiTypeSystem(root);
            WriteGenericXaml(genericXaml, """<Style x:Key="FrameworkStyle" />""");
            Assert.True(platformTypeSystem.IsResourceCatalogAuthoritative);

            var (thirdPartyTypeSystem, _) = CreateFileBackedWinUiTypeSystem(
                root,
                """namespace Contoso.Controls { public class FancyControl { } }""");
            Assert.False(thirdPartyTypeSystem.IsResourceCatalogAuthoritative);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void DocumentationFallsBackToXmlBesideActiveReference()
    {
        var root = CreateTemporaryDirectory();
        try
        {
            var (typeSystem, _) = CreateFileBackedWinUiTypeSystem(root);
            var xmlPath = Path.Combine(root, "lib", "net8.0", "Microsoft.WinUI.xml");
            File.WriteAllText(xmlPath, """
                <doc><members>
                  <member name="T:Microsoft.UI.Xaml.Unrelated">
                    <summary>Adjacent first member.</summary>
                  </member>
                  <member name="T:Microsoft.UI.Xaml.Style">
                    <summary>Authoritative active-package style documentation.</summary>
                  </member>
                </members></doc>
                """);
            var style = typeSystem.ResolveType(Presentation, "Style");

            var documentation = typeSystem.GetDocumentationCommentXml(style!);

            Assert.Contains("Authoritative active-package style documentation.", documentation);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void DocumentationReturnsEmptyWhenActiveReferenceHasNoSummary()
    {
        var root = CreateTemporaryDirectory();
        try
        {
            var (typeSystem, _) = CreateFileBackedWinUiTypeSystem(root);
            var style = typeSystem.ResolveType(Presentation, "Style");

            Assert.Equal(string.Empty, typeSystem.GetDocumentationCommentXml(style!));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    // --- helpers -----------------------------------------------------------------------------------

    private static (XamlTypeSystem TypeSystem, string GenericXaml) CreateFileBackedWinUiTypeSystem(
        string root,
        string? additionalLibrarySource = null)
    {
        const string source = """
            namespace Microsoft.UI.Xaml.Media
            {
                public class Brush { }
                public class SolidColorBrush : Brush { }
            }
            namespace Microsoft.UI.Xaml
            {
                public class Style { }
                public struct CornerRadius { }
            }
            """;
        var references = new[] { MetadataReference.CreateFromFile(typeof(object).Assembly.Location) };
        var library = CSharpCompilation.Create(
            "Microsoft.WinUI",
            new[] { CSharpSyntaxTree.ParseText(source) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        AssertNoErrors(library);

        var managedDirectory = Path.Combine(root, "lib", "net8.0");
        Directory.CreateDirectory(managedDirectory);
        var dllPath = Path.Combine(managedDirectory, "Microsoft.WinUI.dll");
        var emit = library.Emit(dllPath);
        Assert.True(emit.Success, string.Join("; ", emit.Diagnostics));

        var winUiReference = MetadataReference.CreateFromFile(dllPath);
        MetadataReference? additionalReference = null;
        if (additionalLibrarySource is not null)
        {
            var additionalLibrary = CSharpCompilation.Create(
                "Contoso.Controls",
                new[] { CSharpSyntaxTree.ParseText(additionalLibrarySource) },
                references,
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
            AssertNoErrors(additionalLibrary);
            var additionalPath = Path.Combine(root, "Contoso.Controls.dll");
            var additionalEmit = additionalLibrary.Emit(additionalPath);
            Assert.True(additionalEmit.Success, string.Join("; ", additionalEmit.Diagnostics));
            additionalReference = MetadataReference.CreateFromFile(additionalPath);
        }

        var consumerReferences = additionalReference is null
            ? references.Append(winUiReference)
            : references.Append(winUiReference).Append(additionalReference);
        var consumer = CSharpCompilation.Create(
            "TestApp",
            references: consumerReferences,
            options: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var assembly = (IAssemblySymbol)consumer.GetAssemblyOrModuleSymbol(winUiReference)!;
        var assemblies = additionalReference is null
            ? ImmutableArray.Create(assembly)
            : ImmutableArray.Create(
                assembly,
                (IAssemblySymbol)consumer.GetAssemblyOrModuleSymbol(additionalReference)!);
        var typeSystem = XamlTypeSystem.FromCompilation(consumer, assemblies);
        var genericXaml = Path.Combine(managedDirectory, "Microsoft.WinUI", "Themes", "generic.xaml");
        return (typeSystem, genericXaml);
    }

    private static void WriteGenericXaml(string path, string resources)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, $"""
            <ResourceDictionary
                xmlns="{Presentation}"
                xmlns:x="{XamlTypeSystem.XamlLanguageNamespace}">
              {resources}
            </ResourceDictionary>
            """);
    }

    private static string CreateTemporaryDirectory()
    {
        var path = Path.Combine(Path.GetTempPath(), "WinUiXaml.Tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    /// <summary>
    /// Compiles <paramref name="librarySource"/> into a referenced library ("TestLib") and builds a
    /// consumer compilation ("TestApp") that references it. Returns the consumer compilation plus the
    /// library's assembly symbol as the "referenced assemblies" set.
    /// </summary>
    private static (Compilation Compilation, ImmutableArray<IAssemblySymbol> Referenced)
        CompileLibraryAndConsumer(string librarySource, string? consumerSource = null)
    {
        var references = new[]
        {
            MetadataReference.CreateFromFile(typeof(object).Assembly.Location),
        };

        var libCompilation = CSharpCompilation.Create(
            "TestLib",
            new[] { CSharpSyntaxTree.ParseText(librarySource) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        AssertNoErrors(libCompilation);

        using var peStream = new System.IO.MemoryStream();
        var emit = libCompilation.Emit(peStream);
        Assert.True(emit.Success, "library failed to emit: " +
            string.Join("; ", emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));
        peStream.Position = 0;
        var libRef = MetadataReference.CreateFromStream(peStream);

        var consumerTrees = consumerSource is null
            ? System.Array.Empty<Microsoft.CodeAnalysis.SyntaxTree>()
            : new[] { CSharpSyntaxTree.ParseText(consumerSource) };

        var consumer = CSharpCompilation.Create(
            "TestApp",
            consumerTrees,
            references.Append(libRef),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        AssertNoErrors(consumer);

        var libAssembly = (IAssemblySymbol)consumer.GetAssemblyOrModuleSymbol(libRef)!;
        return (consumer, ImmutableArray.Create(libAssembly));
    }

    private static void AssertNoErrors(Compilation compilation)
    {
        var errors = compilation.GetDiagnostics()
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .ToList();
        Assert.True(errors.Count == 0, "unexpected compile errors: " + string.Join("; ", errors));
    }
}
