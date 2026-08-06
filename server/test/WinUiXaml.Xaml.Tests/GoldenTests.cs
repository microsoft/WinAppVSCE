using System.Linq;
using WinUiXaml.Xaml;

namespace WinUiXaml.Xaml.Tests
{
    public class GoldenTests
    {
        [Fact]
        public void SmokePage_ParsesWithoutDiagnostics()
        {
            var doc = XamlParser.Parse(Fixtures.SmokePage);
            Assert.Empty(doc.Diagnostics);
        }

        [Fact]
        public void DiPage_ParsesWithoutDiagnostics()
        {
            var doc = XamlParser.Parse(Fixtures.DiPage);
            Assert.Empty(doc.Diagnostics);
        }

        [Fact]
        public void Root_IsPageElement()
        {
            var doc = XamlParser.Parse(Fixtures.SmokePage);
            Assert.NotNull(doc.Root);
            Assert.Equal("Page", doc.Root!.Name!.LocalName);
            Assert.False(doc.Root.Name.HasPrefix);
            Assert.True(doc.Root.HasEndTag);
        }

        [Fact]
        public void XmlDeclaration_IsProcessingInstruction()
        {
            var doc = XamlParser.Parse(Fixtures.SmokePage);
            var pi = doc.Contents.OfType<XamlProcessingInstruction>().FirstOrDefault();
            Assert.NotNull(pi);
            Assert.Contains("xml", pi!.Text);
        }

        [Fact]
        public void XClass_AttributeResolvesToFullName()
        {
            var doc = XamlParser.Parse(Fixtures.SmokePage);
            var xClass = doc.Root!.GetAttribute("x:Class");
            Assert.NotNull(xClass);
            Assert.Equal("SmokeFixture.SmokePage", xClass!.Value!.Text);
        }

        [Fact]
        public void NamedElements_AreDiscoverable()
        {
            var doc = XamlParser.Parse(Fixtures.SmokePage);
            Assert.NotNull(TreeQuery.ByName(doc, "Scroller"));
            Assert.NotNull(TreeQuery.ByName(doc, "BoundText"));
            Assert.NotNull(TreeQuery.ByName(doc, "GoButton"));
            Assert.NotNull(TreeQuery.ByName(doc, "Repeater"));
        }

        [Fact]
        public void PropertyElement_GridRowDefinitions_IsRecognized()
        {
            var doc = XamlParser.Parse(Fixtures.SmokePage);
            var rowDefs = TreeQuery.Elements(doc)
                .First(e => e.Name?.LocalName == "Grid.RowDefinitions");
            Assert.True(rowDefs.IsPropertyElement);
            Assert.False(rowDefs.Name!.HasPrefix);
            Assert.True(rowDefs.Name.IsDotted);
            Assert.Equal(6, rowDefs.Content.OfType<XamlElement>().Count());
        }

        [Fact]
        public void AttachedProperty_GridRow_ParsesAsDottedAttribute()
        {
            var doc = XamlParser.Parse(Fixtures.SmokePage);
            var title = TreeQuery.ByName(doc, "Title")!;
            var gridRow = title.GetAttribute("Grid.Row");
            Assert.NotNull(gridRow);
            Assert.False(gridRow!.Name.HasPrefix);
            Assert.True(gridRow.Name.IsDotted);
            Assert.Equal("0", gridRow.Value!.Text);
        }

        [Fact]
        public void EventHandler_ClickAttribute_IsPlainText()
        {
            var doc = XamlParser.Parse(Fixtures.SmokePage);
            var go = TreeQuery.ByName(doc, "GoButton")!;
            var click = go.GetAttribute("Click");
            Assert.NotNull(click);
            Assert.False(click!.Value!.IsMarkupExtension);
            Assert.Equal("OnGo_Click", click.Value.Text);
        }

        [Fact]
        public void CompiledBinding_XBind_ParsesNameAndArguments()
        {
            var doc = XamlParser.Parse(Fixtures.SmokePage);
            var bound = TreeQuery.ByName(doc, "BoundText")!;
            var text = bound.GetAttribute("Text")!;
            Assert.True(text.Value!.IsMarkupExtension);

            var ext = text.Value.MarkupExtension!;
            Assert.Equal("x:Bind", ext.Name!.FullName);
            Assert.True(ext.IsClosed);
            Assert.Equal(2, ext.Arguments.Count);

            var positional = ext.Arguments[0];
            Assert.False(positional.IsNamed);
            Assert.Equal("GreetingText", positional.Value);

            var mode = ext.Arguments[1];
            Assert.True(mode.IsNamed);
            Assert.Equal("Mode", mode.Name!.LocalName);
            Assert.Equal("OneWay", mode.Value);
        }

        [Fact]
        public void StaticResource_ParsesPositionalArgument()
        {
            var doc = XamlParser.Parse(Fixtures.SmokePage);
            var title = TreeQuery.ByName(doc, "Title")!;
            var fg = title.GetAttribute("Foreground")!;
            Assert.True(fg.Value!.IsMarkupExtension);

            var ext = fg.Value.MarkupExtension!;
            Assert.Equal("StaticResource", ext.Name!.FullName);
            Assert.Single(ext.Arguments);
            Assert.Equal("SmokeAccentBrush", ext.Arguments[0].Value);
        }

        [Fact]
        public void DataTemplate_XDataType_AndEmptyBind()
        {
            var doc = XamlParser.Parse(Fixtures.SmokePage);
            var template = TreeQuery.Elements(doc).First(e => e.Name?.LocalName == "DataTemplate");
            Assert.Equal("x:String", template.GetAttribute("x:DataType")!.Value!.Text);

            var innerText = TreeQuery.Elements(template)
                .First(e => e.Name?.LocalName == "TextBlock")
                .GetAttribute("Text")!;
            Assert.True(innerText.Value!.IsMarkupExtension);
            var bind = innerText.Value.MarkupExtension!;
            Assert.Equal("x:Bind", bind.Name!.FullName);
            Assert.Empty(bind.Arguments);
            Assert.True(bind.IsClosed);
        }
    }
}
