using WinUiXaml.LanguageServer;

namespace WinUiXaml.LanguageServer.Tests;

/// <summary>
/// Regression tests for LSP-URI ⇄ path conversion. The percent-encoded drive-colon case
/// (<c>file:///c%3A/…</c>) is exactly what VS Code sends and what broke project resolution in real
/// use while the stdio smoke test — which builds URIs with an unencoded colon — stayed green.
/// </summary>
public class LspUriTests
{
    [Fact]
    public void EncodedDriveColon_DecodesToDrivePath()
    {
        // VS Code encodes the drive colon as %3A.
        var path = LspUri.ToPath("file:///c%3A/Users/nikolame/source/App.xaml");
        Assert.Equal(@"c:\Users\nikolame\source\App.xaml", path);
    }

    [Fact]
    public void UnencodedDriveColon_DecodesToSameDrivePath()
    {
        // The stdio smoke client (System.Uri.AbsoluteUri) leaves the colon unencoded.
        var path = LspUri.ToPath("file:///c:/Users/nikolame/source/App.xaml");
        Assert.Equal(@"c:\Users\nikolame\source\App.xaml", path);
    }

    [Fact]
    public void EncodedAndUnencoded_Converge()
    {
        Assert.Equal(
            LspUri.ToPath("file:///c:/a/b/Page.xaml"),
            LspUri.ToPath("file:///c%3A/a/b/Page.xaml"));
    }

    [Fact]
    public void PercentEncodedSpaces_AreDecoded()
    {
        var path = LspUri.ToPath("file:///c%3A/My%20Projects/App%20Shell/Page.xaml");
        Assert.Equal(@"c:\My Projects\App Shell\Page.xaml", path);
    }

    [Fact]
    public void UncPath_UsesDoubleBackslashHost()
    {
        var path = LspUri.ToPath("file://build-server/share/App.xaml");
        Assert.Equal(@"\\build-server\share\App.xaml", path);
    }

    [Fact]
    public void NonFileScheme_ReturnsNull()
    {
        Assert.Null(LspUri.ToPath("untitled:Untitled-1"));
        Assert.Null(LspUri.ToPath("http://example.com/x.xaml"));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    public void EmptyOrNull_ReturnsNull(string? uri)
    {
        Assert.Null(LspUri.ToPath(uri));
    }

    [Fact]
    public void RoundTrip_PathToUriToPath_Preserves()
    {
        const string original = @"c:\Users\nikolame\source\design-research\smoke\fixture\SmokePage.xaml";
        var uri = LspUri.FromPath(original);
        var back = LspUri.ToPath(uri);
        Assert.Equal(original, back, ignoreCase: true);
    }
}
