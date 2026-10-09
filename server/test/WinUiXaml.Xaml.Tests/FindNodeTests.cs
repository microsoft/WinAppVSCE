using System;
using WinUiXaml.Xaml;

namespace WinUiXaml.Xaml.Tests
{
    public class FindNodeTests
    {
        [Fact]
        public void Caret_InsideAttributeValue_ReturnsAttributeValue()
        {
            var text = Fixtures.SmokePage;
            var doc = XamlParser.Parse(text);

            int i = text.IndexOf("x:Name=\"Scroller\"", StringComparison.Ordinal);
            int pos = i + "x:Name=\"".Length + 2; // a couple chars into "Scroller"

            var node = doc.FindNode(pos);
            var value = Assert.IsType<XamlAttributeValue>(node);
            Assert.Equal("Scroller", value.Text);
        }

        [Fact]
        public void Caret_InsideElementName_ReturnsElement()
        {
            var text = Fixtures.SmokePage;
            var doc = XamlParser.Parse(text);

            int i = text.IndexOf("<ScrollViewer", StringComparison.Ordinal);
            int pos = i + 3; // inside "ScrollViewer"

            var node = doc.FindNode(pos);
            var element = Assert.IsType<XamlElement>(node);
            Assert.Equal("ScrollViewer", element.Name!.LocalName);
        }

        [Fact]
        public void Caret_InsideBindArgument_ReturnsMarkupArgument()
        {
            var text = Fixtures.SmokePage;
            var doc = XamlParser.Parse(text);

            int i = text.IndexOf("GreetingText", StringComparison.Ordinal);
            int pos = i + 2;

            var node = doc.FindNode(pos);
            var arg = Assert.IsType<XamlMarkupExtensionArgument>(node);
            Assert.Equal("GreetingText", arg.Value);
        }

        [Fact]
        public void FindNode_OutsideDocument_ReturnsNull()
        {
            var doc = XamlParser.Parse("<Grid/>");
            Assert.Null(doc.FindNode(9999));
            Assert.Null(doc.FindNode(-1));
        }

        [Fact]
        public void FindNode_AtEveryOffset_NeverThrows()
        {
            var text = Fixtures.SmokePage;
            var doc = XamlParser.Parse(text);

            for (int p = 0; p <= text.Length; p++)
            {
                _ = doc.FindNode(p); // must not throw at any offset
            }
        }

        [Fact]
        public void FoundNode_SpanContainsQueriedOffset()
        {
            var text = Fixtures.DiPage;
            var doc = XamlParser.Parse(text);

            for (int p = 0; p < text.Length; p += 7)
            {
                var node = doc.FindNode(p);
                Assert.NotNull(node);
                Assert.True(node!.Span.ContainsInclusive(p));
            }
        }
    }
}
