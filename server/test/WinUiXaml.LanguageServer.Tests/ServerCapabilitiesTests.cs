namespace WinUiXaml.LanguageServer.Tests;

public class ServerCapabilitiesTests
{
    [Fact]
    public void FormattingCapabilitiesAreAdvertisedWhenEnabled()
    {
        var capabilities = XamlLanguageServer.CreateServerCapabilities(formattingEnabled: true);

        Assert.True(capabilities.DocumentFormattingProvider);
        Assert.True(capabilities.DocumentRangeFormattingProvider);
        Assert.NotNull(capabilities.DocumentOnTypeFormattingProvider);
    }

    [Fact]
    public void FormattingCapabilitiesAreOmittedWhenDisabled()
    {
        var capabilities = XamlLanguageServer.CreateServerCapabilities(formattingEnabled: false);

        Assert.False(capabilities.DocumentFormattingProvider);
        Assert.False(capabilities.DocumentRangeFormattingProvider);
        Assert.Null(capabilities.DocumentOnTypeFormattingProvider);
    }
}
