using WinUiXaml.LanguageServer.Lsp;
using System.Text.Json;

namespace WinUiXaml.LanguageServer.Tests;

public sealed class XamlDiagnosticConfigurationTests
{
    private static readonly Diagnostic Error = new() { Severity = 1, Message = "error" };
    private static readonly Diagnostic Warning = new() { Severity = 2, Message = "warning" };

    [Fact]
    public void WarningLevelPreservesAllDiagnostics()
    {
        var filtered = XamlLanguageServer.FilterDiagnosticsForLevel(
            new[] { Error, Warning },
            "warning");

        Assert.Equal(2, filtered.Count);
    }

    [Fact]
    public void ErrorLevelKeepsOnlyErrors()
    {
        var filtered = XamlLanguageServer.FilterDiagnosticsForLevel(
            new[] { Error, Warning },
            "error");

        Assert.Same(Error, Assert.Single(filtered));
    }

    [Fact]
    public void CanonicalErrorsOnlyLevelKeepsOnlyErrors()
    {
        Assert.Equal(
            "error",
            XamlLanguageServer.NormalizeDiagnosticsLevel("errorsOnly"));
        Assert.Same(
            Error,
            Assert.Single(XamlLanguageServer.FilterDiagnosticsForLevel(
                new[] { Error, Warning },
                "errorsOnly")));
    }

    [Fact]
    public void OffLevelSuppressesAllDiagnostics()
    {
        Assert.Empty(XamlLanguageServer.FilterDiagnosticsForLevel(
            new[] { Error, Warning },
            "off"));
    }

    [Fact]
    public void PublishedDiagnosticsCarryDocumentVersion()
    {
        var payload = JsonSerializer.Serialize(new PublishDiagnosticsParams
        {
            Uri = "file:///C:/Page.xaml",
            Version = 7,
        });

        Assert.Contains("\"version\":7", payload);
    }

    [Fact]
    public void PublishedDiagnosticsSerializeRuleCode()
    {
        var payload = JsonSerializer.Serialize(
            new PublishDiagnosticsParams
            {
                Uri = "file:///C:/Page.xaml",
                Diagnostics =
                [
                    new Diagnostic
                    {
                        Severity = 2,
                        Code = XamlValidator.UnknownTypeCode,
                        Message = "unknown",
                    },
                ],
            },
            LspJson.Options);

        Assert.Contains($"\"code\":\"{XamlValidator.UnknownTypeCode}\"", payload);
    }
}
