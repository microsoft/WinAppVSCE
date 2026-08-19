"use strict";

// WinUI XAML color provider coverage for parsing, ranges, edits, and malformed input.

const assert = require("node:assert");
const h = require("./helper");

const EPS = 0.004;

function page(body) {
  return `<Page ${h.NS}>\n${body}\n</Page>`;
}

function close(actual, expected, name) {
  assert.ok(Math.abs(actual - expected) <= EPS, `${name}: expected ${expected}, got ${actual}`);
}

function dump(value) {
  return JSON.stringify(value);
}

function lineCount(buffer) {
  return buffer.replace(/\r\n/g, "\n").split("\n").length;
}

function assertColor(actual, expected, context, allColors) {
  close(actual.color.red, expected.red / 255, `${context} red; colors=${dump(allColors)}`);
  close(actual.color.green, expected.green / 255, `${context} green; colors=${dump(allColors)}`);
  close(actual.color.blue, expected.blue / 255, `${context} blue; colors=${dump(allColors)}`);
  close(actual.color.alpha, expected.alpha / 255, `${context} alpha; colors=${dump(allColors)}`);
}

function assertRangeEqual(actual, expected, message) {
  assert.deepStrictEqual(actual, expected, `${message}: expected ${dump(expected)}, got ${dump(actual)}`);
}

function assertSaneColorRanges(name, buffer, colors) {
  const lines = buffer.replace(/\r\n/g, "\n").split("\n");
  for (const c of colors) {
    assert.ok(c.range, `${name}: missing range; colors=${dump(colors)}`);
    assert.ok(c.range.start.line >= 0 && c.range.start.line < lines.length, `${name}: start line outside document; colors=${dump(colors)}`);
    assert.ok(c.range.end.line >= 0 && c.range.end.line < lines.length, `${name}: end line outside document; colors=${dump(colors)}`);
    assert.ok(c.range.start.line < c.range.end.line || c.range.start.character < c.range.end.character, `${name}: inverted/empty range; colors=${dump(colors)}`);
    assert.ok(c.text === undefined || /^#[0-9a-fA-F]+$/.test(c.text), `${name}: swatch text should be a hex token; colors=${dump(colors)}`);
  }
}

async function colorsFor(name, buffer) {
  const colors = await h.documentColorsAt(buffer);
  assertSaneColorRanges(name, buffer, colors);
  return colors;
}

function assertNoColors(name, buffer, colors) {
  assert.strictEqual(colors.length, 0, `${name}: expected no swatches for buffer:\n${buffer}\nactual documentColorsAt=${dump(colors)}`);
}

function applyEdit(buffer, range, newText) {
  const lines = buffer.replace(/\r\n/g, "\n").split("\n");
  assert.strictEqual(range.start.line, range.end.line, `test helper only applies single-line edits: ${dump(range)}`);
  const line = lines[range.start.line];
  lines[range.start.line] = line.slice(0, range.start.character) + newText + line.slice(range.end.character);
  return lines.join("\n");
}

describe("WinUI XAML red-team 38 — color provider", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("rejects realistic text values that merely contain color-looking substrings", async () => {
    const cases = [
      '<TextBlock Text="#FF0000 is red" />',
      '<TextBlock Text="call #123456 now" />',
      '<Button Content="#hashtag" />',
      '<TextBlock Text="##FF0000" />',
      '<TextBlock Text="prefix #FF00 suffix" />',
    ];
    for (const buffer of cases) {
      assertNoColors("embedded or hashtag text", buffer, await colorsFor("embedded or hashtag text", buffer));
    }
  });

  it("rejects invalid full-value hex widths, non-hex digits, empty values, and whitespace-only values", async () => {
    const cases = [
      '<Rectangle Fill="#GGG" />',
      '<Rectangle Fill="#12345" />',
      '<Rectangle Fill="#1234567" />',
      '<Rectangle Fill="#" />',
      '<Rectangle Fill="" />',
      '<Rectangle Fill="   " />',
    ];
    for (const buffer of cases) {
      assertNoColors("invalid full-value hex", buffer, await colorsFor("invalid full-value hex", buffer));
    }
  });

  it("parses all supported hex widths and casing with XAML alpha-first semantics", async () => {
    const cases = [
      { literal: "#f00", expected: { alpha: 0xff, red: 0xff, green: 0x00, blue: 0x00 } },
      { literal: "#8F0c", expected: { alpha: 0x88, red: 0xff, green: 0x00, blue: 0xcc } },
      { literal: "#00ff7F", expected: { alpha: 0xff, red: 0x00, green: 0xff, blue: 0x7f } },
      { literal: "#4080AaCc", expected: { alpha: 0x40, red: 0x80, green: 0xaa, blue: 0xcc } },
    ];
    const buffer = cases.map((c, i) => `<Rectangle x:Name="R${i}" Fill="${c.literal}" />`).join("\n");
    const colors = await colorsFor("all supported widths", buffer);
    assert.strictEqual(colors.length, cases.length, `expected ${cases.length} swatches; got ${dump(colors)}`);
    for (const c of cases) {
      const swatch = colors.find((x) => x.text === c.literal);
      assert.ok(swatch, `expected swatch text ${c.literal}; colors=${dump(colors)}`);
      assertColor(swatch, c.expected, c.literal, colors);
    }
  });

  it("trims inner whitespace and ranges only the hex token", async () => {
    const buffer = '<Rectangle Fill="  #00FF00\t " />';
    const colors = await colorsFor("trimmed whitespace", buffer);
    const swatch = colors.find((c) => c.text === "#00FF00");
    assert.ok(swatch, `expected trimmed #00FF00 swatch; got ${dump(colors)}`);
    assertRangeEqual(swatch.range, { start: { line: 0, character: 19 }, end: { line: 0, character: 26 } }, "trimmed whitespace swatch range");
  });

  it("finds multiple colors on the same line without overlapping ranges", async () => {
    const buffer = '<Grid Background="#112233"><Rectangle Fill="#445566" Stroke="#778899" /></Grid>';
    const colors = await colorsFor("multiple same-line colors", buffer);
    assert.deepStrictEqual(colors.map((c) => c.text).sort(), ["#112233", "#445566", "#778899"], `unexpected swatches: ${dump(colors)}`);
    for (const c of colors) {
      assert.strictEqual(buffer.slice(c.range.start.character, c.range.end.character), c.text, `range must isolate ${c.text}; colors=${dump(colors)}`);
    }
  });

  it("ranges a wrapped attribute on the line that actually contains the literal", async () => {
    const buffer = [
      "<Rectangle",
      "  Width=\"10\"",
      "  Fill=\"   #AABBCC\"",
      "  Height=\"10\" />",
    ].join("\n");
    const colors = await colorsFor("wrapped attribute", buffer);
    const swatch = colors.find((c) => c.text === "#AABBCC");
    assert.ok(swatch, `expected #AABBCC swatch; colors=${dump(colors)}`);
    assertRangeEqual(swatch.range, { start: { line: 2, character: 11 }, end: { line: 2, character: 18 } }, "wrapped attribute range");
  });

  it("does not color markup extensions, including hex fallback arguments", async () => {
    const buffer = [
      '<Rectangle Fill="{StaticResource AccentBrush}" />',
      '<Rectangle Fill="{ThemeResource AccentBrush}" />',
      '<Rectangle Fill="{Binding CurrentBrush}" />',
      '<Rectangle Fill="{x:Bind CurrentBrush}" />',
      '<TextBlock Foreground="{Binding Missing, FallbackValue=#FF0000}" />',
    ].join("\n");
    assertNoColors("markup extension values", buffer, await colorsFor("markup extension values", buffer));
  });

  it("skips namespace declarations even when the value itself is a valid hex literal", async () => {
    const buffer = '<Page xmlns="#FF0000" xmlns:x="#00FF00" xmlns:local="#0000FF"><Grid /></Page>';
    assertNoColors("xmlns declarations", buffer, await colorsFor("xmlns declarations", buffer));
  });

  it("does not color hex-looking text in comments or CDATA", async () => {
    const buffer = [
      "<Grid>",
      "  <!-- <Rectangle Fill=\"#FF0000\" /> -->",
      "  <TextBlock><![CDATA[#00FF00]]></TextBlock>",
      "</Grid>",
    ].join("\n");
    assertNoColors("comments and cdata", buffer, await colorsFor("comments and cdata", buffer));
  });

  it("keeps malformed color-adjacent markup crash-safe and ranges inside the document", async () => {
    const cases = [
      '<Rectangle Fill="#FF0000"',
      '<Rectangle Fill=#00FF00 />',
      '<Rectangle Fill="#0000FF',
      '<Grid>\n  <Rectangle Fill="#123456"\n  <TextBlock Text="x" />',
    ];
    for (const buffer of cases) {
      const colors = await colorsFor("malformed color-adjacent markup", buffer);
      assert.ok(colors.length <= 1, `malformed input should not produce duplicate phantom swatches for buffer:\n${buffer}\ncolors=${dump(colors)}`);
      assertSaneColorRanges("malformed color-adjacent markup", buffer, colors);
    }
  });

  it("handles a larger document with many independent color attributes", async () => {
    const rows = [];
    for (let i = 0; i < 48; i++) rows.push(`  <Rectangle x:Name="R${i}" Fill="#${i.toString(16).padStart(2, "0")}AA55" />`);
    const buffer = page(["<StackPanel>", ...rows, "</StackPanel>"].join("\n"));
    const colors = await colorsFor("larger document", buffer);
    assert.strictEqual(colors.length, 48, `expected one swatch per generated rectangle; got ${dump(colors)}`);
    assert.ok(colors.every((c) => c.range.end.line < lineCount(buffer)), `range outside document; colors=${dump(colors)}`);
  });

  it("offers uppercase bounded write-backs with opaque #RRGGBB first", async () => {
    const buffer = '<Rectangle Fill="  #ff0000  " />';
    const [swatch] = await colorsFor("opaque write-back source", buffer);
    assert.ok(swatch, "expected source swatch");
    const presentations = await h.colorPresentationsAt(buffer, { red: 0x3b / 255, green: 0x82 / 255, blue: 0xf6 / 255, alpha: 1 }, swatch.range);
    assert.strictEqual(presentations[0]?.label, "#3B82F6", `opaque pick should offer #RRGGBB first; presentations=${dump(presentations)}`);
    assert.ok(presentations.some((p) => p.label === "#FF3B82F6"), `opaque pick should also offer alpha-first form; presentations=${dump(presentations)}`);
    for (const p of presentations) {
      assert.match(p.label, /^#[0-9A-F]{6}([0-9A-F]{2})?$/, `labels must be uppercase hex; presentations=${dump(presentations)}`);
      assert.strictEqual(p.newText, p.label, `newText must equal label; presentations=${dump(presentations)}`);
      assertRangeEqual(p.editRange, swatch.range, `presentation ${p.label} edit range must equal swatch range`);
    }
  });

  it("offers uppercase bounded write-backs with translucent #AARRGGBB first", async () => {
    const buffer = '<Rectangle Fill="#112233" />';
    const [swatch] = await colorsFor("translucent write-back source", buffer);
    const presentations = await h.colorPresentationsAt(buffer, { red: 1, green: 0x80 / 255, blue: 0, alpha: 0x40 / 255 }, swatch.range);
    assert.strictEqual(presentations[0]?.label, "#40FF8000", `translucent pick should offer #AARRGGBB first; presentations=${dump(presentations)}`);
    assert.ok(presentations.some((p) => p.label === "#FF8000"), `translucent pick should also offer RGB form; presentations=${dump(presentations)}`);
    for (const p of presentations) assertRangeEqual(p.editRange, swatch.range, `presentation ${p.label} edit range must equal swatch range`);
  });

  it("round-trips parsed bytes from an existing alpha-first literal through colorPresentation", async () => {
    const buffer = '<Rectangle Fill="#4080AaCc" />';
    const [swatch] = await colorsFor("round-trip source", buffer);
    const presentations = await h.colorPresentationsAt(buffer, swatch.color, swatch.range);
    assert.strictEqual(presentations[0]?.label, "#4080AACC", `round-trip should preserve parsed AARRGGBB bytes and uppercase them; presentations=${dump(presentations)}`);
    assert.ok(presentations.some((p) => p.label === "#80AACC"), `round-trip should also offer RGB alternative; presentations=${dump(presentations)}`);
  });

  it("re-parses an applied colorPresentation edit to the same picked color", async () => {
    const buffer = '<Rectangle Fill="#000000" />';
    const [swatch] = await colorsFor("idempotence source", buffer);
    const picked = { red: 0x12 / 255, green: 0x34 / 255, blue: 0x56 / 255, alpha: 0x78 / 255 };
    const presentations = await h.colorPresentationsAt(buffer, picked, swatch.range);
    const edited = applyEdit(buffer, presentations[0].editRange, presentations[0].newText);
    const [after] = await colorsFor("idempotence edited", edited);
    assertColor(after, { alpha: 0x78, red: 0x12, green: 0x34, blue: 0x56 }, `edited buffer ${edited}`, [after]);
  });

  it("preserves exact edit bounds when two literals share one line", async () => {
    const buffer = '<Grid Background="#010203"><Rectangle Fill="#A0B0C0" /></Grid>';
    const colors = await colorsFor("same-line edit bounds", buffer);
    const fill = colors.find((c) => c.text === "#A0B0C0");
    assert.ok(fill, `expected fill swatch; colors=${dump(colors)}`);
    const presentations = await h.colorPresentationsAt(buffer, { red: 0xaa / 255, green: 0xbb / 255, blue: 0xcc / 255, alpha: 1 }, fill.range);
    for (const p of presentations) {
      assertRangeEqual(p.editRange, fill.range, `same-line presentation ${p.label} must not widen to adjacent literal`);
      const edited = applyEdit(buffer, p.editRange, p.newText);
      assert.ok(edited.includes('Background="#010203"'), `edit must not alter adjacent Background value; edited=${edited}`);
    }
  });

  it("does not disturb diagnostics on a valid page with color attributes", async () => {
    const buffer = page('  <Grid Background="#112233">\n    <Rectangle Fill="#80445566" Stroke="#778899" />\n  </Grid>');
    const diagnostics = await h.diagnosticsFor(buffer, (d) => d.length === 0);
    assert.strictEqual(diagnostics.length, 0, `valid color page should have no diagnostics; diagnostics=${dump(diagnostics)}`);
  });
});
