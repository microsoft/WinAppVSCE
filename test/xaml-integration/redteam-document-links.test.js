"use strict";

// WinUI XAML document-link resolution, ranges, exclusions, and malformed input.

const assert = require("node:assert");
const h = require("./helper");

function dump(value) {
  return JSON.stringify(value);
}

function normalizePath(p) {
  return (p || "").replace(/\\/g, "/").toLowerCase();
}

function endsWith(p, name) {
  return normalizePath(p).endsWith("/" + name.toLowerCase());
}

function isFixtureTarget(link, fileName) {
  return endsWith(link.target, fileName);
}

function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function offsetToPos(starts, offset) {
  let line = 0;
  while (line + 1 < starts.length && starts[line + 1] <= offset) line++;
  return { line, character: offset - starts[line] };
}

function rangeForOccurrence(buffer, token, occurrence = 0) {
  let from = 0;
  for (let i = 0; i <= occurrence; i++) {
    const at = buffer.indexOf(token, from);
    assert.ok(at >= 0, `missing occurrence ${occurrence} of ${token} in ${dump(buffer)}`);
    if (i === occurrence) {
      const starts = lineStartsOf(buffer);
      return {
        start: offsetToPos(starts, at),
        end: offsetToPos(starts, at + token.length),
      };
    }
    from = at + token.length;
  }
  throw new Error("unreachable");
}

function linkFor(links, text, fileName) {
  return links.find((l) => l.text === text && (!fileName || isFixtureTarget(l, fileName)));
}

function xamlLinks(links) {
  return links.filter((l) => l.text.toLowerCase().endsWith(".xaml") || l.text.toLowerCase().endsWith(".xaml/"));
}

async function expectExactSchemelessLinks(label, buffer, expected) {
  const links = await h.documentLinksAt(buffer);
  assert.deepStrictEqual(
    links.map((l) => l.text),
    expected.map((e) => e.text),
    `${label}: exact schemeless link texts mismatch; got ${dump(links)}`
  );
  for (const e of expected) {
    const actual = linkFor(links, e.text, e.file);
    assert.ok(actual, `${label}: missing link ${dump(e)} in ${dump(links)}`);
    assert.ok(endsWith(actual.target, e.file), `${label}: wrong target for ${e.text}; got ${dump(actual)}`);
    if (e.occurrence !== undefined || e.assertRange) {
      const range = rangeForOccurrence(buffer, e.text, e.occurrence || 0);
      assert.deepStrictEqual(actual.range, range, `${label}: wrong range for ${e.text}; got ${dump(actual)}`);
    }
  }
  return links;
}

async function expectNoFixtureXamlLink(label, buffer) {
  const links = await h.documentLinksAt(buffer);
  const mine = links.filter((l) => l.target && normalizePath(l.target).startsWith(normalizePath(h.FIXTURE_DIR)));
  assert.strictEqual(mine.length, 0, `${label}: expected no fixture-targeted XAML document links; got ${dump(links)}`);
  return links;
}

describe("WinUI XAML — red-team 41 (document links)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("resolves existing schemeless relative, app-root, traversal, and backslash paths exactly", async () => {
    await expectExactSchemelessLinks("relative App.xaml", '<ResourceDictionary Source="App.xaml" />', [
      { text: "App.xaml", file: "App.xaml", assertRange: true },
    ]);
    await expectExactSchemelessLinks("app-root /App.xaml", '<ResourceDictionary Source="/App.xaml" />', [
      { text: "/App.xaml", file: "App.xaml", assertRange: true },
    ]);
    await expectExactSchemelessLinks("dot-dot traversal back to fixture", '<ResourceDictionary Source="../fixture/App.xaml" />', [
      { text: "../fixture/App.xaml", file: "App.xaml", assertRange: true },
    ]);
    await expectExactSchemelessLinks("backslash relative path", '<ResourceDictionary Source=".\\App.xaml" />', [
      { text: ".\\App.xaml", file: "App.xaml", assertRange: true },
    ]);
  });

  it("resolves ms-appx forms by presence without assuming VS Code built-in link counts", async () => {
    const buffers = [
      { label: "ms-appx app root", text: '<ResourceDictionary Source="ms-appx:///App.xaml" />', token: "ms-appx:///App.xaml" },
      { label: "ms-appx package host", text: '<ResourceDictionary Source="ms-appx://SomePackage/App.xaml" />', token: "ms-appx://SomePackage/App.xaml" },
      { label: "case-insensitive ms-appx", text: '<ResourceDictionary Source="MS-APPX:///App.xaml" />', token: "MS-APPX:///App.xaml" },
    ];
    for (const b of buffers) {
      const links = await h.documentLinksAt(b.text);
      const mine = linkFor(links, b.token, "App.xaml");
      assert.ok(mine, `${b.label}: expected provider link to App.xaml; got ${dump(links)}`);
      assert.deepStrictEqual(mine.range, rangeForOccurrence(b.text, b.token), `${b.label}: range should cover exact token`);
    }
  });

  it("gates missing targets for relative, app-root, ms-appx, and traversal values", async () => {
    await expectExactSchemelessLinks("missing relative", '<ResourceDictionary Source="DoesNotExist.xaml" />', []);
    await expectExactSchemelessLinks("missing app-root", '<ResourceDictionary Source="/DoesNotExist.xaml" />', []);
    await expectExactSchemelessLinks("missing traversal", '<ResourceDictionary Source="../fixture/DoesNotExist.xaml" />', []);
    const links = await h.documentLinksAt('<ResourceDictionary Source="ms-appx:///DoesNotExist.xaml" />');
    assert.ok(!linkFor(links, "ms-appx:///DoesNotExist.xaml", "DoesNotExist.xaml"), `missing ms-appx target must not provider-link; got ${dump(links)}`);
  });

  it("rejects foreign schemes and does not mistake a Windows drive prefix for a URI scheme", async () => {
    const probes = [
      '<ResourceDictionary Source="http://example.invalid/App.xaml" />',
      '<ResourceDictionary Source="https://example.invalid/App.xaml" />',
      '<ResourceDictionary Source="pack://application:,,,/App.xaml" />',
      '<ResourceDictionary Source="file:///C:/NoSuchRound41/App.xaml" />',
      '<ResourceDictionary Source="C:\\NoSuchRound41\\App.xaml" />',
    ];
    for (const probe of probes) {
      await expectNoFixtureXamlLink(`foreign/drive rejection for ${probe}`, probe);
    }
  });

  it("excludes prefixed elements, unlisted elements, and prefixed Source attributes", async () => {
    await expectExactSchemelessLinks("prefixed x ResourceDictionary", '<x:ResourceDictionary Source="App.xaml" />', []);
    await expectExactSchemelessLinks("prefixed custom ResourceDictionary", '<foo:ResourceDictionary Source="App.xaml" />', []);
    // Image asset links are covered elsewhere; MediaElement is not in the allow-list, so it remains excluded — the guard for the allow-list boundary.
    await expectExactSchemelessLinks("MediaElement Source (unlisted)", '<MediaElement Source="App.xaml" />', []);
    await expectExactSchemelessLinks("prefixed Source attribute", '<ResourceDictionary local:Source="App.xaml" />', []);
  });

  it("excludes markup-extension, empty, and whitespace-only Source values", async () => {
    await expectExactSchemelessLinks("StaticResource markup", '<ResourceDictionary Source="{StaticResource Foo}" />', []);
    await expectExactSchemelessLinks("x:Bind markup", '<ResourceDictionary Source="{x:Bind Uri}" />', []);
    await expectExactSchemelessLinks("empty Source", '<ResourceDictionary Source="" />', []);
    await expectExactSchemelessLinks("whitespace Source", '<ResourceDictionary Source="   " />', []);
  });

  it("links the existing subset under MergedDictionaries once each", async () => {
    const buffer =
      "<ResourceDictionary>\n" +
      "  <ResourceDictionary.MergedDictionaries>\n" +
      '    <ResourceDictionary Source="App.xaml" />\n' +
      '    <ResourceDictionary Source="DoesNotExist.xaml" />\n' +
      '    <ResourceDictionary Source="Page2.xaml" />\n' +
      '    <ResourceDictionary Source="../fixture/DiPage.xaml" />\n' +
      "  </ResourceDictionary.MergedDictionaries>\n" +
      "</ResourceDictionary>";
    const links = await expectExactSchemelessLinks("merged dictionaries existing subset", buffer, [
      { text: "App.xaml", file: "App.xaml", assertRange: true },
      { text: "Page2.xaml", file: "Page2.xaml", assertRange: true },
      { text: "../fixture/DiPage.xaml", file: "DiPage.xaml", assertRange: true },
    ]);
    assert.strictEqual(links.filter((l) => l.text === "DoesNotExist.xaml").length, 0, `missing merged dictionary must not link; got ${dump(links)}`);
  });

  it("keeps ranges tight with inner whitespace, same-line multiplicity, and other attributes", async () => {
    const padded = '<ResourceDictionary Source="  App.xaml  " />';
    const links = await h.documentLinksAt(padded);
    const mine = linkFor(links, "App.xaml", "App.xaml");
    assert.ok(mine, `padded Source should link over trimmed token only; got ${dump(links)}`);
    assert.deepStrictEqual(mine.range, rangeForOccurrence(padded, "App.xaml"), `padded Source range must exclude inner spaces; got ${dump(mine)}`);

    const sameLine = '<ResourceDictionary x:Key="a" Source="App.xaml" /><ResourceDictionary Source="Page2.xaml" x:Key="b" />';
    await expectExactSchemelessLinks("same-line two links", sameLine, [
      { text: "App.xaml", file: "App.xaml", occurrence: 0 },
      { text: "Page2.xaml", file: "Page2.xaml", occurrence: 0 },
    ]);
  });

  it("is deterministic for repeated document-link requests", async () => {
    const buffer =
      '<ResourceDictionary Source="App.xaml" />\n' +
      '<ResourceDictionary Source="/Page2.xaml" />\n' +
      '<ResourceDictionary Source="DoesNotExist.xaml" />';
    const first = await h.documentLinksAt(buffer);
    const second = await h.documentLinksAt(buffer);
    assert.deepStrictEqual(second, first, `document links changed between identical requests; first=${dump(first)} second=${dump(second)}`);
  });

  it("is crash-safe on malformed markup and still returns well-formed arrays", async () => {
    const probes = [
      "<ResourceDictionary",
      '<ResourceDictionary Source="App.xaml',
      "<ResourceDictionary></ResourceDictionary>",
      '<ResourceDictionary Source="DoesNotExist.xaml" Source="App.xaml" />',
      "<ResourceDictionary>\n  <ResourceDictionary.MergedDictionaries>\n    <ResourceDictionary Source=\"App.xaml\" />",
    ];
    for (const probe of probes) {
      const links = await h.documentLinksAt(probe);
      assert.ok(Array.isArray(links), `provider should return an array for malformed probe; got ${dump(links)}`);
      for (const link of links) {
        assert.ok(link.range && link.range.start && link.range.end, `link should have a well-formed range; got ${dump(link)}`);
      }
    }
  });

  it("honors XAML case sensitivity for element and attribute names", async () => {
    await expectExactSchemelessLinks("lowercase element", '<resourcedictionary Source="App.xaml" />', []);
    await expectExactSchemelessLinks("lowercase source attribute", '<ResourceDictionary source="App.xaml" />', []);
    await expectExactSchemelessLinks("uppercase SOURCE attribute", '<ResourceDictionary SOURCE="App.xaml" />', []);
  });

  it("handles a large document without inventing or dropping links", async () => {
    const filler = Array.from({ length: 400 }, (_, i) => `<Grid x:Name="Filler${i}" />`).join("\n");
    const buffer =
      "<ResourceDictionary>\n" +
      filler +
      "\n" +
      '  <ResourceDictionary Source="App.xaml" />\n' +
      filler +
      "\n" +
      '  <ResourceDictionary Source="SecondWindow.xaml" />\n' +
      "</ResourceDictionary>";
    await expectExactSchemelessLinks("large document links", buffer, [
      { text: "App.xaml", file: "App.xaml", assertRange: true },
      { text: "SecondWindow.xaml", file: "SecondWindow.xaml", assertRange: true },
    ]);
  });
});
