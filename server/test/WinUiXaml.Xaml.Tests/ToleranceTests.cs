using System.Linq;
using WinUiXaml.Xaml;

namespace WinUiXaml.Xaml.Tests
{
    public class ToleranceTests
    {
        private static XamlDocument ParseNoThrow(string text)
        {
            var doc = XamlParser.Parse(text);
            Assert.NotNull(doc);
            return doc;
        }

        [Fact]
        public void MissingEndTag_IsReportedNotThrown()
        {
            var doc = ParseNoThrow("<Grid><Button /></Grid");
            Assert.Contains(doc.Diagnostics, d => d.Id == XamlDiagnosticIds.MissingTagClose);
            Assert.NotNull(doc.Root);
        }

        [Fact]
        public void UnclosedElement_ProducesMissingEndTagDiagnostic()
        {
            var doc = ParseNoThrow("<Grid><Button /></Grid>".Replace("</Grid>", string.Empty));
            Assert.Contains(doc.Diagnostics, d => d.Id == XamlDiagnosticIds.MissingEndTag);
            Assert.Equal("Grid", doc.Root!.Name!.LocalName);
        }

        [Fact]
        public void UnterminatedAttributeString_IsReported()
        {
            var doc = ParseNoThrow("<Button Content=\"hello />");
            Assert.Contains(doc.Diagnostics, d => d.Id == XamlDiagnosticIds.UnterminatedString);
        }

        [Fact]
        public void StrayEndTag_IsReported()
        {
            var doc = ParseNoThrow("   </Grid>   ");
            Assert.Contains(doc.Diagnostics, d => d.Id == XamlDiagnosticIds.StrayEndTag);
        }

        [Fact]
        public void UnterminatedMarkupExtension_IsReported()
        {
            var doc = ParseNoThrow("<Button Content=\"{Binding Path=Foo\" />");
            Assert.Contains(doc.Diagnostics, d => d.Id == XamlDiagnosticIds.UnterminatedMarkupExtension);
        }

        [Fact]
        public void NestedUnterminatedMarkupExtension_ReportsSingleDiagnostic()
        {
            // A nested unterminated extension makes the enclosing one unterminated too; both end at the
            // same offset. Only the innermost should be reported (no duplicate cascade at one position).
            var doc = ParseNoThrow("<Button Content=\"{x:Bind Greeting, FallbackValue={oops\" />");
            var unterminated = doc.Diagnostics
                .Where(d => d.Id == XamlDiagnosticIds.UnterminatedMarkupExtension)
                .ToList();
            Assert.Single(unterminated);
        }

        [Fact]
        public void LoneOpenBrace_DoesNotThrow()
        {
            var doc = ParseNoThrow("<Button Content=\"{\" />");
            Assert.NotNull(doc.Root);
        }

        [Fact]
        public void EscapedBrace_IsLiteralNotMarkupExtension()
        {
            var doc = ParseNoThrow("<Button Content=\"{}{Not a binding}\" />");
            var content = doc.Root!.GetAttribute("Content")!;
            Assert.False(content.Value!.IsMarkupExtension);
            Assert.Equal("{}{Not a binding}", content.Value.Text);
        }

        [Fact]
        public void MismatchedNesting_DoesNotThrow()
        {
            var doc = ParseNoThrow("<A><B></A>");
            Assert.Equal("A", doc.Root!.Name!.LocalName);
            // <B> is left unclosed because </A> matches the ancestor on the open stack.
            Assert.Contains(doc.Diagnostics, d => d.Id == XamlDiagnosticIds.MissingEndTag);
        }

        [Fact]
        public void StrayInnerEndTag_IsConsumedAndElementStillCloses()
        {
            var doc = ParseNoThrow("<A><B></C></B></A>");
            Assert.Equal("A", doc.Root!.Name!.LocalName);
            Assert.True(doc.Root.HasEndTag);
            Assert.Contains(doc.Diagnostics, d => d.Id == XamlDiagnosticIds.StrayEndTag);
        }

        [Theory]
        [InlineData("")]
        [InlineData("   ")]
        [InlineData("<")]
        [InlineData("</")]
        [InlineData("<>")]
        [InlineData("<!--")]
        [InlineData("<![CDATA[")]
        [InlineData("<?xml")]
        [InlineData("<Grid attr")]
        [InlineData("<Grid attr=")]
        [InlineData("<Grid attr=\"")]
        [InlineData("<Grid {}=\"x\"")]
        [InlineData("=\"orphan\"")]
        [InlineData("{Binding}")]
        [InlineData("<<<<>>>>")]
        public void DegenerateInputs_DoNotThrow(string text)
        {
            var doc = XamlParser.Parse(text);
            Assert.NotNull(doc);
            Assert.Equal(text.Length, doc.Span.End);
        }
    }
}
