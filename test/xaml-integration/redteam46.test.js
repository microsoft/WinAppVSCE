"use strict";

// Round 46 red-team probes for WinUI XAML asset document links.
// These drive the real VS Code extension and deliberately avoid asserting total counts for scheme'd
// values because VS Code's built-in link detector may contribute non-provider links.

const assert = require("node:assert");
const h = require("./helper");

const STORE = "Assets/StoreLogo.png";
const APPICON = "Assets/AppIcon.ico";
const SPLASH = "Assets/SplashScreen.scale-200.png";
const MISSING = "Assets/DoesNotExist.png";

function dump(value) {
  return JSON.stringify(value);
}

function normalizePath(p) {
  return (p || "").replace(/\\/g, "/").toLowerCase();
}

function endsWith(p, suffix) {
  return normalizePath(p).endsWith("/" + suffix.toLowerCase());
}

function fixtureFileLinks(links) {
  return links.filter((l) => l.target && normalizePath(l.target).startsWith(normalizePath(h.FIXTURE_DIR)));
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
  return links.find((l) => l.text === text && (!fileName || endsWith(l.target, fileName)));
}

function assertLink(label, links, token, fileName, buffer, occurrence = 0) {
  const actual = linkFor(links, token, fileName);
  assert.ok(actual, `${label}: missing provider link for ${token} -> ${fileName}; got ${dump(links)}`);
  assert.ok(endsWith(actual.target, fileName), `${label}: wrong target for ${token}; got ${dump(actual)}`);
  assert.deepStrictEqual(actual.range, rangeForOccurrence(buffer, token, occurrence), `${label}: wrong range for ${token}; got ${dump(actual)}`);
  return actual;
}

async function expectExactSchemelessLinks(label, buffer, expected) {
  const links = await h.documentLinksAt(buffer);
  assert.deepStrictEqual(
    links.map((l) => l.text),
    expected.map((e) => e.text),
    `${label}: exact schemeless link texts mismatch; got ${dump(links)}`
  );
  for (const e of expected) {
    assertLink(label, links, e.text, e.file, buffer, e.occurrence || 0);
  }
  return links;
}

async function expectNoFixtureFileLink(label, buffer) {
  const links = await h.documentLinksAt(buffer);
  const mine = fixtureFileLinks(links);
  assert.strictEqual(mine.length, 0, `${label}: expected no fixture-targeted provider links; got ${dump(links)}`);
  return links;
}

describe("WinUI XAML — red-team 46 (asset document links)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("links Image.Source and every allow-listed asset source element", async () => {
    const probes = [
      { label: "Image.Source", buffer: `<Image Source="${STORE}" />`, token: STORE, file: STORE },
      { label: "ImageIcon.Source", buffer: `<ImageIcon Source="${APPICON}" />`, token: APPICON, file: APPICON },
      { label: "ImageBrush.ImageSource", buffer: `<ImageBrush ImageSource="${STORE}" />`, token: STORE, file: STORE },
      { label: "BitmapImage.UriSource", buffer: `<BitmapImage UriSource="${STORE}" />`, token: STORE, file: STORE },
      { label: "SvgImageSource.UriSource", buffer: `<SvgImageSource UriSource="${STORE}" />`, token: STORE, file: STORE },
    ];
    for (const p of probes) {
      await expectExactSchemelessLinks(p.label, p.buffer, [{ text: p.token, file: p.file }]);
    }
  });

  it("links nested Image.Source BitmapImage long form via the UriSource token", async () => {
    const buffer =
      "<Image>\n" +
      "  <Image.Source>\n" +
      `    <BitmapImage UriSource="${STORE}" />\n` +
      "  </Image.Source>\n" +
      "</Image>";
    await expectExactSchemelessLinks("nested BitmapImage", buffer, [{ text: STORE, file: STORE }]);
  });

  it("links multiple existing asset and dictionary attributes without cross-talk", async () => {
    const buffer =
      `<Image Source="${STORE}" />\n` +
      `<BitmapImage UriSource="${APPICON}" />\n` +
      '<ResourceDictionary Source="App.xaml" />\n' +
      `<Image Source="${MISSING}" />`;
    await expectExactSchemelessLinks("mixed existing and missing", buffer, [
      { text: STORE, file: STORE },
      { text: APPICON, file: APPICON },
      { text: "App.xaml", file: "App.xaml" },
    ]);
  });

  it("links normalizing traversal and dot paths but not traversal that escapes to a missing file", async () => {
    await expectExactSchemelessLinks("asset dot segment", `<Image Source="./${STORE}" />`, [{ text: `./${STORE}`, file: STORE }]);
    await expectExactSchemelessLinks("asset traversal back to asset", '<Image Source="Assets/../Assets/StoreLogo.png" />', [
      { text: "Assets/../Assets/StoreLogo.png", file: STORE },
    ]);
    await expectExactSchemelessLinks("asset traversal missing", '<Image Source="../fixture-not-present/Assets/StoreLogo.png" />', []);
  });

  it("keeps ranges tight for inner whitespace and surrounding attributes", async () => {
    const padded = `<Image Source="  ${STORE}  " />`;
    const links = await h.documentLinksAt(padded);
    assertLink("inner whitespace", links, STORE, STORE, padded);

    const withAttrs = `<Image Width="12" x:Name="Logo" Source="${APPICON}" Height="12" />`;
    const links2 = await h.documentLinksAt(withAttrs);
    assertLink("surrounding attributes", links2, APPICON, APPICON, withAttrs);
  });

  it("keeps same-line asset link ranges independent and exact", async () => {
    const buffer = `<Image Source="${STORE}" /><ImageIcon Source="${APPICON}" />`;
    const links = await expectExactSchemelessLinks("same-line assets", buffer, [
      { text: STORE, file: STORE },
      { text: APPICON, file: APPICON },
    ]);
    assert.deepStrictEqual(linkFor(links, STORE, STORE).range, { start: { line: 0, character: 15 }, end: { line: 0, character: 35 } });
    assert.deepStrictEqual(linkFor(links, APPICON, APPICON).range, { start: { line: 0, character: 58 }, end: { line: 0, character: 76 } });
  });

  it("applies existence gating when valid and missing asset values share a buffer", async () => {
    const buffer = `<Image Source="${MISSING}" />\n<Image Source="${SPLASH}" />`;
    await expectExactSchemelessLinks("missing plus valid", buffer, [{ text: SPLASH, file: SPLASH }]);
  });

  it("rejects missing, markup-extension, empty, and whitespace-only asset values", async () => {
    const probes = [
      `<Image Source="${MISSING}" />`,
      '<Image Source="{x:Bind LogoUri}" />',
      '<Image Source="{Binding Logo}" />',
      '<BitmapImage UriSource="{StaticResource X}" />',
      '<Image Source="" />',
      '<BitmapImage UriSource="   " />',
    ];
    for (const probe of probes) {
      await expectExactSchemelessLinks(`negative ${probe}`, probe, []);
    }
  });

  it("rejects foreign URI schemes without confusing VS Code built-in URI links for provider links", async () => {
    const probes = [
      '<Image Source="http://example.com/x.png" />',
      '<Image Source="pack://application:,,,/Assets/StoreLogo.png" />',
    ];
    for (const probe of probes) {
      await expectNoFixtureFileLink(`foreign scheme ${probe}`, probe);
    }
  });

  it("rejects prefixed elements and prefixed source attributes", async () => {
    await expectExactSchemelessLinks("prefixed Image element", `<local:Image Source="${STORE}" />`, []);
    await expectExactSchemelessLinks("prefixed Image Source attribute", `<Image local:Source="${STORE}" />`, []);
    await expectExactSchemelessLinks("prefixed BitmapImage UriSource attribute", `<BitmapImage local:UriSource="${STORE}" />`, []);
  });

  it("keeps MediaElement, MediaPlayerElement, and other Source-like elements outside the allow-list", async () => {
    const probes = [
      `<MediaElement Source="${STORE}" />`,
      `<MediaPlayerElement Source="${STORE}" />`,
      `<WebView2 Source="${STORE}" />`,
      `<FontIcon Source="${STORE}" />`,
    ];
    for (const probe of probes) {
      await expectExactSchemelessLinks(`allow-list boundary ${probe}`, probe, []);
    }
  });

  it("returns deterministic document links for repeated requests on the same asset buffer", async () => {
    const buffer =
      `<Image Source="${STORE}" />\n` +
      `<ImageIcon Source="${APPICON}" />\n` +
      `<BitmapImage UriSource="${MISSING}" />`;
    const first = await h.documentLinksAt(buffer);
    const second = await h.documentLinksAt(buffer);
    assert.deepStrictEqual(second, first, `document links changed between identical requests; first=${dump(first)} second=${dump(second)}`);
  });

  it("treats on-disk asset casing according to the Windows filesystem", async () => {
    const token = "Assets/storelogo.png";
    const buffer = `<Image Source="${token}" />`;
    const links = await h.documentLinksAt(buffer);
    assertLink("case-insensitive Windows asset lookup", links, token, STORE, buffer);
  });

  it("finds provider links for ms-appx asset forms by exact token without asserting total link count", async () => {
    const probes = [
      { buffer: '<Image Source="ms-appx:///Assets/StoreLogo.png" />', token: "ms-appx:///Assets/StoreLogo.png" },
      { buffer: '<BitmapImage UriSource="ms-appx://PackageName/Assets/StoreLogo.png" />', token: "ms-appx://PackageName/Assets/StoreLogo.png" },
    ];
    for (const p of probes) {
      const links = await h.documentLinksAt(p.buffer);
      assertLink(`ms-appx provider ${p.token}`, links, p.token, STORE, p.buffer);
    }
  });
});
