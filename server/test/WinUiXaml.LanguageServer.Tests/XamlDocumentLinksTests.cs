using System;
using System.Collections.Generic;
using System.IO;
using WinUiXaml.LanguageServer;
using WinUiXaml.LanguageServer.Lsp;
using Xunit;

namespace WinUiXaml.LanguageServer.Tests;

/// <summary>
/// Hermetic coverage for <see cref="XamlDocumentLinks"/>. The filesystem probe is injected, so these
/// tests assert the resolution + scoping rules (which element/attribute links, ms-appx / app-root /
/// relative base selection, existence gating, range precision) without touching disk. Base dirs:
/// document = <c>C:\proj\Views</c>, project root = <c>C:\proj</c>.
/// </summary>
public class XamlDocumentLinksTests
{
    private const string DocDir = @"C:\proj\Views";
    private const string ProjDir = @"C:\proj";

    private static Func<string, bool> ExistsSet(params string[] paths)
    {
        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var p in paths)
        {
            set.Add(Path.GetFullPath(p));
        }

        return set.Contains;
    }

    private static List<DocumentLink> Collect(string text, Func<string, bool> exists) =>
        XamlDocumentLinks.Collect(new TextDocument("file:///C:/proj/Views/Page.xaml", text), DocDir, ProjDir, exists);

    private static string Covered(TextDocument doc, Lsp.Range range) =>
        doc.Text.Substring(doc.OffsetAt(range.Start), doc.OffsetAt(range.End) - doc.OffsetAt(range.Start));

    [Fact]
    public void RelativeSource_ExistingFile_LinksToDocumentRelativePath()
    {
        var text = "<ResourceDictionary Source=\"Colors.xaml\" />";
        var links = Collect(text, ExistsSet(@"C:\proj\Views\Colors.xaml"));

        Assert.Single(links);
        Assert.Equal(LspUri.FromPath(@"C:\proj\Views\Colors.xaml"), links[0].Target);
        var doc = new TextDocument("file:///C:/proj/Views/Page.xaml", text);
        Assert.Equal("Colors.xaml", Covered(doc, links[0].Range));
    }

    [Fact]
    public void RelativeSource_MissingFile_NoLink()
    {
        // Existence gating: a dangling reference must never produce a link.
        var links = Collect("<ResourceDictionary Source=\"Nope.xaml\" />", ExistsSet());
        Assert.Empty(links);
    }

    [Fact]
    public void MsAppxTripleSlash_ResolvesUnderProjectRoot()
    {
        var links = Collect(
            "<ResourceDictionary Source=\"ms-appx:///Themes/Generic.xaml\" />",
            ExistsSet(@"C:\proj\Themes\Generic.xaml"));

        Assert.Single(links);
        Assert.Equal(LspUri.FromPath(@"C:\proj\Themes\Generic.xaml"), links[0].Target);
    }

    [Fact]
    public void MsAppxWithPackageAuthority_DropsAuthority_ResolvesUnderProjectRoot()
    {
        var links = Collect(
            "<ResourceDictionary Source=\"ms-appx://MyApp/Themes/Generic.xaml\" />",
            ExistsSet(@"C:\proj\Themes\Generic.xaml"));

        Assert.Single(links);
        Assert.Equal(LspUri.FromPath(@"C:\proj\Themes\Generic.xaml"), links[0].Target);
    }

    [Fact]
    public void LeadingSlash_IsAppRootRelative_ResolvesUnderProjectRoot()
    {
        var links = Collect(
            "<ResourceDictionary Source=\"/Styles/App.xaml\" />",
            ExistsSet(@"C:\proj\Styles\App.xaml"));

        Assert.Single(links);
        Assert.Equal(LspUri.FromPath(@"C:\proj\Styles\App.xaml"), links[0].Target);
    }

    [Fact]
    public void BackslashSeparators_AreNormalized()
    {
        var links = Collect(
            "<ResourceDictionary Source=\"Sub\\Colors.xaml\" />",
            ExistsSet(@"C:\proj\Views\Sub\Colors.xaml"));

        Assert.Single(links);
        Assert.Equal(LspUri.FromPath(@"C:\proj\Views\Sub\Colors.xaml"), links[0].Target);
    }

    [Fact]
    public void ForeignUriScheme_NoLink()
    {
        var links = Collect(
            "<ResourceDictionary Source=\"http://example.com/Colors.xaml\" />",
            _ => true); // even if "exists" says yes, a foreign scheme must not link
        Assert.Empty(links);
    }

    [Fact]
    public void FileUriScheme_NoLink()
    {
        var links = Collect(
            "<Image Source=\"file:///C:/proj/Assets/Logo.png\" />",
            ExistsSet(@"C:\proj\Assets\Logo.png"));
        Assert.Empty(links);
    }

    [Fact]
    public void MarkupExtensionValue_NoLink()
    {
        var links = Collect("<ResourceDictionary Source=\"{StaticResource Foo}\" />", _ => true);
        Assert.Empty(links);
    }

    [Fact]
    public void EmptyOrWhitespaceValue_NoLink()
    {
        Assert.Empty(Collect("<ResourceDictionary Source=\"\" />", _ => true));
        Assert.Empty(Collect("<ResourceDictionary Source=\"   \" />", _ => true));
    }

    [Fact]
    public void ImageSource_BareRelative_ResolvesFromAppRoot_NotDocumentRelative()
    {
        // WinUI resolves Image Source="Assets/Logo.png" from the app package root regardless of the page's
        // folder — so an asset beside the app root links, while a same-named file next to the document does
        // NOT (that is not what the loader would open).
        var appRootHit = Collect("<Image Source=\"Assets/Logo.png\" />", ExistsSet(@"C:\proj\Assets\Logo.png"));
        Assert.Single(appRootHit);
        Assert.Equal(LspUri.FromPath(@"C:\proj\Assets\Logo.png"), appRootHit[0].Target);

        var docRelativeOnly = Collect("<Image Source=\"Assets/Logo.png\" />", ExistsSet(@"C:\proj\Views\Assets\Logo.png"));
        Assert.Empty(docRelativeOnly);
    }

    [Fact]
    public void ImageSource_MsAppx_ResolvesUnderProjectRoot()
    {
        var links = Collect(
            "<Image Source=\"ms-appx:///Assets/Logo.png\" />",
            ExistsSet(@"C:\proj\Assets\Logo.png"));

        Assert.Single(links);
        Assert.Equal(LspUri.FromPath(@"C:\proj\Assets\Logo.png"), links[0].Target);
    }

    [Fact]
    public void ImageSource_RangeCoversTrimmedPathOnly()
    {
        var text = "<Image Source=\"  Assets/Logo.png  \" />";
        var links = Collect(text, ExistsSet(@"C:\proj\Assets\Logo.png"));

        Assert.Single(links);
        var doc = new TextDocument("file:///C:/proj/Views/Page.xaml", text);
        Assert.Equal("Assets/Logo.png", Covered(doc, links[0].Range));
    }

    [Theory]
    [InlineData("<ImageIcon Source=\"Assets/Logo.png\" />")]
    [InlineData("<ImageBrush ImageSource=\"Assets/Logo.png\" />")]
    [InlineData("<BitmapImage UriSource=\"Assets/Logo.png\" />")]
    [InlineData("<SvgImageSource UriSource=\"Assets/Logo.png\" />")]
    public void AssetSourceAttributes_AllResolveFromAppRoot(string markup)
    {
        var links = Collect(markup, ExistsSet(@"C:\proj\Assets\Logo.png"));
        Assert.Single(links);
        Assert.Equal(LspUri.FromPath(@"C:\proj\Assets\Logo.png"), links[0].Target);
    }

    [Fact]
    public void BitmapImageInsideImageSourceElement_Links()
    {
        // The nested long form: <Image.Source><BitmapImage UriSource="…"/></Image.Source>.
        var text =
            "<Image>\n" +
            "  <Image.Source>\n" +
            "    <BitmapImage UriSource=\"Assets/Logo.png\" />\n" +
            "  </Image.Source>\n" +
            "</Image>";
        var links = Collect(text, ExistsSet(@"C:\proj\Assets\Logo.png"));

        Assert.Single(links);
        var doc = new TextDocument("file:///C:/proj/Views/Page.xaml", text);
        Assert.Equal("Assets/Logo.png", Covered(doc, links[0].Range));
    }

    [Fact]
    public void ImageSource_MissingAsset_NoLink()
    {
        Assert.Empty(Collect("<Image Source=\"Assets/Nope.png\" />", ExistsSet()));
    }

    [Fact]
    public void ImageSource_MarkupExtension_NoLink()
    {
        var links = Collect("<Image Source=\"{x:Bind LogoUri}\" />", _ => true);
        Assert.Empty(links);
    }

    [Fact]
    public void PrefixedImage_NoLink()
    {
        // local:Image is a user type that merely shares the name, not the framework Image.
        var links = Collect("<local:Image Source=\"Assets/Logo.png\" />", ExistsSet(@"C:\proj\Assets\Logo.png"));
        Assert.Empty(links);
    }

    [Fact]
    public void UnlistedElementWithSource_NoLink()
    {
        // A framework element outside the allow-list (Hyperlink.Source-like) must not link.
        var links = Collect("<MediaElement Source=\"Assets/clip.mp4\" />", ExistsSet(@"C:\proj\Assets\clip.mp4"));
        Assert.Empty(links);
    }

    [Fact]
    public void PrefixedResourceDictionary_NoLink()
    {
        // local:ResourceDictionary is a user type, not the framework dictionary.
        var links = Collect("<local:ResourceDictionary Source=\"Colors.xaml\" />", ExistsSet(@"C:\proj\Views\Colors.xaml"));
        Assert.Empty(links);
    }

    [Fact]
    public void MergedDictionaries_MultipleSources_LinksEach()
    {
        var text =
            "<ResourceDictionary>\n" +
            "  <ResourceDictionary.MergedDictionaries>\n" +
            "    <ResourceDictionary Source=\"A.xaml\" />\n" +
            "    <ResourceDictionary Source=\"B.xaml\" />\n" +
            "  </ResourceDictionary.MergedDictionaries>\n" +
            "</ResourceDictionary>";
        var links = Collect(text, ExistsSet(@"C:\proj\Views\A.xaml", @"C:\proj\Views\B.xaml"));

        Assert.Equal(2, links.Count);
        var doc = new TextDocument("file:///C:/proj/Views/Page.xaml", text);
        Assert.Equal("A.xaml", Covered(doc, links[0].Range));
        Assert.Equal("B.xaml", Covered(doc, links[1].Range));
    }

    [Fact]
    public void InnerWhitespace_RangeCoversTrimmedPathOnly()
    {
        var text = "<ResourceDictionary Source=\"  Colors.xaml  \" />";
        var links = Collect(text, ExistsSet(@"C:\proj\Views\Colors.xaml"));

        Assert.Single(links);
        var doc = new TextDocument("file:///C:/proj/Views/Page.xaml", text);
        Assert.Equal("Colors.xaml", Covered(doc, links[0].Range));
    }

    [Fact]
    public void ResolvePath_DriveLetterPath_IsNotTreatedAsForeignScheme()
    {
        // A "C:\..." value is an absolute path, not a URI; existence still gates it.
        var target = XamlDocumentLinks.ResolvePath(
            @"C:\other\Colors.xaml", DocDir, ProjDir, ExistsSet(@"C:\other\Colors.xaml"));
        Assert.Equal(Path.GetFullPath(@"C:\other\Colors.xaml"), target);
    }

    [Fact]
    public void ResolvePath_NoProjectRoot_MsAppxYieldsNull_RelativeStillResolves()
    {
        Assert.Null(XamlDocumentLinks.ResolvePath("ms-appx:///A.xaml", DocDir, null, _ => true));
        Assert.Equal(
            Path.GetFullPath(@"C:\proj\Views\A.xaml"),
            XamlDocumentLinks.ResolvePath("A.xaml", DocDir, null, ExistsSet(@"C:\proj\Views\A.xaml")));
    }
}
