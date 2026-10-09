using System;
using System.Collections.Generic;
using System.Text;
using WinUiXaml.Xaml;

namespace WinUiXaml.Xaml.Tests
{
    public class FuzzTests
    {
        [Fact]
        public void EveryTruncationOfFixture_ParsesWithoutThrowing()
        {
            foreach (var text in new[] { Fixtures.SmokePage, Fixtures.DiPage })
            {
                for (int len = 0; len <= text.Length; len++)
                {
                    var doc = XamlParser.Parse(text.Substring(0, len));
                    Assert.NotNull(doc);
                    Assert.Equal(len, doc.Span.End);
                }
            }
        }

        [Fact]
        public void RandomByteInsertionsIntoFixture_DoNotThrow()
        {
            var rng = new Random(1234);
            var baseline = Fixtures.SmokePage;
            const string noise = "<>/{}\"'= \tabcXY:.-";

            for (int iteration = 0; iteration < 400; iteration++)
            {
                var sb = new StringBuilder(baseline);
                int edits = rng.Next(1, 12);
                for (int e = 0; e < edits; e++)
                {
                    int at = rng.Next(0, sb.Length + 1);
                    char ch = noise[rng.Next(noise.Length)];
                    sb.Insert(at, ch);
                }

                var doc = XamlParser.Parse(sb.ToString());
                Assert.NotNull(doc);
            }
        }

        [Fact]
        public void RandomStrings_DoNotThrow()
        {
            var rng = new Random(9876);
            const string alphabet = "<>/{}\"'=[]!?-:. \n\tabcABCxyz012";

            for (int iteration = 0; iteration < 2000; iteration++)
            {
                int length = rng.Next(0, 200);
                var sb = new StringBuilder(length);
                for (int i = 0; i < length; i++)
                {
                    sb.Append(alphabet[rng.Next(alphabet.Length)]);
                }

                var text = sb.ToString();
                var doc = XamlParser.Parse(text);
                Assert.NotNull(doc);
                Assert.Equal(text.Length, doc.Span.End);

                // FindNode must be safe across the whole buffer.
                for (int p = 0; p <= text.Length; p += 3)
                {
                    _ = doc.FindNode(p);
                }
            }
        }

        [Fact]
        public void DeeplyNestedInput_DoesNotStackOverflow()
        {
            var sb = new StringBuilder();
            for (int i = 0; i < 5000; i++)
            {
                sb.Append("<a>");
            }

            var doc = XamlParser.Parse(sb.ToString());
            Assert.NotNull(doc);
        }
    }
}
