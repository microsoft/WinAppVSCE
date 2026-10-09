using Xunit;

namespace WinUiXaml.Xaml.Tests
{
    public class IntrospectionTests
    {
        [Fact]
        public void SmokePage_XClass_Resolves()
        {
            Assert.Equal("SmokeFixture.SmokePage", XamlIntrospection.GetClass(Fixtures.SmokePage));
        }

        [Fact]
        public void DiPage_XClass_Resolves()
        {
            Assert.Equal("SmokeFixture.DiPage", XamlIntrospection.GetClass(Fixtures.DiPage));
        }

        [Fact]
        public void XClass_ValueSpan_PointsAtClassName()
        {
            var doc = XamlParser.Parse(Fixtures.SmokePage);
            Assert.True(XamlIntrospection.TryGetClass(doc, out var name, out var span));
            Assert.Equal("SmokeFixture.SmokePage", name);
            Assert.Equal(name, Fixtures.SmokePage.Substring(span.Start, span.Length));
        }

        [Fact]
        public void XClass_IdentifiedByNamespace_NotLiteralPrefix()
        {
            // Bind the XAML namespace to a non-standard prefix; x:Class must still resolve.
            const string xaml =
                "<Page xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" " +
                "xmlns:w=\"http://schemas.microsoft.com/winfx/2006/xaml\" " +
                "w:Class=\"My.Page\"></Page>";
            Assert.Equal("My.Page", XamlIntrospection.GetClass(xaml));
        }

        [Fact]
        public void PrefixBoundToOtherNamespace_IsNotXClass()
        {
            // A "Class" attribute whose prefix is NOT the XAML namespace must be ignored.
            const string xaml =
                "<Page xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" " +
                "xmlns:x=\"urn:not-xaml\" " +
                "x:Class=\"My.Page\"></Page>";
            Assert.Null(XamlIntrospection.GetClass(xaml));
        }

        [Fact]
        public void NoXClass_ReturnsNull()
        {
            const string xaml =
                "<Page xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\"></Page>";
            Assert.Null(XamlIntrospection.GetClass(xaml));
        }

        [Fact]
        public void EmptyDocument_ReturnsNull()
        {
            Assert.Null(XamlIntrospection.GetClass(string.Empty));
        }
    }
}
