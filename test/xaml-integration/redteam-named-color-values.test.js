
"use strict";

const assert = require("node:assert");
const vscode = require("vscode");
const h = require("./helper");

function page(inner) {
  return `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage">
  ${inner}
</Page>`;
}

function caretPosition(text) {
  const i = text.indexOf("|");
  assert.ok(i >= 0, "probe text must contain a | caret marker");
  const before = text.slice(0, i);
  const nl = before.lastIndexOf("\n");
  const line = (before.match(/\n/g) || []).length;
  const character = before.length - (nl + 1);
  return {
    clean: text.slice(0, i) + text.slice(i + 1),
    position: new vscode.Position(line, character),
  };
}

function labelOf(item) {
  return typeof item.label === "string" ? item.label : item.label.label;
}

function newTextOf(item) {
  return item.textEdit
    ? item.textEdit.newText
    : typeof item.insertText === "string"
      ? item.insertText
      : item.insertText && item.insertText.value !== undefined
        ? item.insertText.value
        : undefined;
}

function replacingRangeOf(item) {
  if (!item.textEdit) return undefined;
  return item.textEdit.range || item.textEdit.replacing;
}

async function rawCompletionItemsAt(bufferWithCaret) {
  const { clean, position } = caretPosition(bufferWithCaret);
  await h.setBuffer(clean);
  const list = await vscode.commands.executeCommand(
    "vscode.executeCompletionItemProvider",
    h.getDoc().uri,
    position
  );
  return {
    clean,
    items: (list && list.items ? list.items : []).map((item) => ({
      raw: item,
      label: labelOf(item),
      detail: item.detail,
      newText: newTextOf(item),
      kind: item.kind,
      filterText: item.filterText,
      sortText: item.sortText,
    })),
  };
}

const EXPECTED_COLOR_NAMES = [
  "AliceBlue", "AntiqueWhite", "Aqua", "Aquamarine", "Azure", "Beige", "Bisque", "Black",
  "BlanchedAlmond", "Blue", "BlueViolet", "Brown", "BurlyWood", "CadetBlue", "Chartreuse",
  "Chocolate", "Coral", "CornflowerBlue", "Cornsilk", "Crimson", "Cyan", "DarkBlue", "DarkCyan",
  "DarkGoldenrod", "DarkGray", "DarkGreen", "DarkKhaki", "DarkMagenta", "DarkOliveGreen",
  "DarkOrange", "DarkOrchid", "DarkRed", "DarkSalmon", "DarkSeaGreen", "DarkSlateBlue",
  "DarkSlateGray", "DarkTurquoise", "DarkViolet", "DeepPink", "DeepSkyBlue", "DimGray",
  "DodgerBlue", "Firebrick", "FloralWhite", "ForestGreen", "Fuchsia", "Gainsboro", "GhostWhite",
  "Gold", "Goldenrod", "Gray", "Green", "GreenYellow", "Honeydew", "HotPink", "IndianRed",
  "Indigo", "Ivory", "Khaki", "Lavender", "LavenderBlush", "LawnGreen", "LemonChiffon",
  "LightBlue", "LightCoral", "LightCyan", "LightGoldenrodYellow", "LightGray", "LightGreen",
  "LightPink", "LightSalmon", "LightSeaGreen", "LightSkyBlue", "LightSlateGray", "LightSteelBlue",
  "LightYellow", "Lime", "LimeGreen", "Linen", "Magenta", "Maroon", "MediumAquamarine",
  "MediumBlue", "MediumOrchid", "MediumPurple", "MediumSeaGreen", "MediumSlateBlue",
  "MediumSpringGreen", "MediumTurquoise", "MediumVioletRed", "MidnightBlue", "MintCream",
  "MistyRose", "Moccasin", "NavajoWhite", "Navy", "OldLace", "Olive", "OliveDrab", "Orange",
  "OrangeRed", "Orchid", "PaleGoldenrod", "PaleGreen", "PaleTurquoise", "PaleVioletRed",
  "PapayaWhip", "PeachPuff", "Peru", "Pink", "Plum", "PowderBlue", "Purple", "Red",
  "RosyBrown", "RoyalBlue", "SaddleBrown", "Salmon", "SandyBrown", "SeaGreen", "SeaShell",
  "Sienna", "Silver", "SkyBlue", "SlateBlue", "SlateGray", "Snow", "SpringGreen", "SteelBlue",
  "Tan", "Teal", "Thistle", "Tomato", "Transparent", "Turquoise", "Violet", "Wheat", "White",
  "WhiteSmoke", "Yellow", "YellowGreen",
].sort();

const EXPECTED_HEX = {
  AliceBlue: "#F0F8FF",
  Black: "#000000",
  CornflowerBlue: "#6495ED",
  Cornsilk: "#FFF8DC",
  Fuchsia: "#FF00FF",
  Red: "#FF0000",
  Transparent: "#FFFFFF00",
  White: "#FFFFFF",
  YellowGreen: "#9ACD32",
};

const isHex = (detail) => /^#[0-9A-Fa-f]{6,8}$/.test(detail || "");
const colorItems = (items) => items.filter((i) => isHex(i.detail));
const colorLabels = (items) => colorItems(items).map((i) => i.label).sort();
const summarizeColors = (items) => JSON.stringify(colorItems(items).map((i) => ({
  label: i.label,
  detail: i.detail,
  newText: i.newText,
  kind: i.kind,
})));

async function assertExactNamedColorSet(buffer, reason) {
  const { items } = await rawCompletionItemsAt(buffer);
  const colors = colorItems(items);
  assert.deepStrictEqual(colorLabels(items), EXPECTED_COLOR_NAMES, `${reason}: expected exactly the 141 WinUI named colors; got ${summarizeColors(items)}`);
  for (const item of colors) {
    assert.strictEqual(item.kind, vscode.CompletionItemKind.Color, `${reason}: ${item.label} kind should be Color; got ${item.kind}`);
    assert.strictEqual(item.newText, item.label, `${reason}: ${item.label} should replace with its name; got ${JSON.stringify(item.newText)}`);
  }
  for (const [name, hex] of Object.entries(EXPECTED_HEX)) {
    const item = colors.find((i) => i.label === name);
    assert.ok(item, `${reason}: missing ${name}`);
    assert.strictEqual(item.detail, hex, `${reason}: ${name} swatch should be ${hex}; got ${JSON.stringify(item.detail)}`);
  }
  return items;
}

async function assertNoNamedColors(buffer, reason) {
  const { items } = await rawCompletionItemsAt(buffer);
  assert.deepStrictEqual(colorLabels(items), [], `${reason}: must not offer hex-detail named colors; got ${summarizeColors(items)}`);
  return items;
}

async function applyColorCompletion(buffer, label) {
  const { items } = await rawCompletionItemsAt(buffer);
  const item = colorItems(items).find((i) => i.label === label);
  assert.ok(item, `expected named color ${label}; got ${summarizeColors(items)}`);
  const range = replacingRangeOf(item.raw);
  assert.ok(range, `expected ${label} to carry a TextEdit range; item=${JSON.stringify(item)}`);
  const doc = h.getDoc();
  const actual = doc.getText();
  const start = doc.offsetAt(range.start);
  const end = doc.offsetAt(range.end);
  return actual.slice(0, start) + item.newText + actual.slice(end);
}

describe("WinUI XAML red-team 72 (named-color value completion adversarial)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("red-team 72 Brush-valued surfaces expose exactly the full WinUI named-color set with swatches", async () => {
    const surfaces = [
      ["TextBlock.Foreground", '<TextBlock Foreground="|" />'],
      ["Grid.Background", '<Grid Background="|" />'],
      ["Border.BorderBrush", '<Border BorderBrush="|" />'],
      ["Rectangle.Fill", '<Rectangle Fill="|" />'],
      ["Rectangle.Stroke", '<Rectangle Stroke="|" />'],
    ];
    for (const [name, inner] of surfaces) {
      await assertExactNamedColorSet(page(inner), name);
    }
  });

  it("red-team 72 Color-valued SolidColorBrush.Color and GradientStop.Color use IsColor and expose the full set", async () => {
    const surfaces = [
      ["SolidColorBrush.Color", '<Grid><Grid.Background><SolidColorBrush Color="|" /></Grid.Background></Grid>'],
      ["GradientStop.Color", '<LinearGradientBrush><GradientStop Offset="0" Color="|" /></LinearGradientBrush>'],
    ];
    for (const [name, inner] of surfaces) {
      await assertExactNamedColorSet(page(inner), name);
    }
  });

  it("red-team 72 prefix filtering is case-insensitive, exact to the current token, and rejects garbage", async () => {
    for (const [value, expected] of [
      ["|", EXPECTED_COLOR_NAMES],
      ["Corn|", ["CornflowerBlue", "Cornsilk"]],
      ["corn|", ["CornflowerBlue", "Cornsilk"]],
      ["CORN|", ["CornflowerBlue", "Cornsilk"]],
      ["Cornflower|", ["CornflowerBlue"]],
      ["NoSuchColor|", []],
      ["#FF|", []],
    ]) {
      const items = (await rawCompletionItemsAt(page(`<TextBlock Foreground="${value}" />`))).items;
      assert.deepStrictEqual(colorLabels(items), expected.slice().sort(), `prefix ${value}: got ${summarizeColors(items)}`);
    }
  });

  it("red-team 72 accepted completion reconstructs the token without duplicated prefixes or suffixes", async () => {
    const endApplied = await applyColorCompletion(page('<TextBlock Foreground="Corn|" Tag="tail" />'), "CornflowerBlue");
    assert.ok(endApplied.includes('<TextBlock Foreground="CornflowerBlue" Tag="tail" />'), `end-token edit corrupted text; got=${JSON.stringify(endApplied)}`);
    assert.ok(!/Foreground="CornCornflowerBlue|Foreground="CornflowerBlueflowerBlue/.test(endApplied), `end-token edit left partials; got=${JSON.stringify(endApplied)}`);

    const midApplied = await applyColorCompletion(page('<TextBlock Foreground="Corn|silk" Tag="tail" />'), "Cornsilk");
    assert.ok(midApplied.includes('<TextBlock Foreground="Cornsilk" Tag="tail" />'), `mid-token edit corrupted text; got=${JSON.stringify(midApplied)}`);
    assert.ok(!midApplied.includes('Cornsilksilk') && !midApplied.includes('CornCornsilk'), `mid-token edit left partials; got=${JSON.stringify(midApplied)}`);
  });

  it("red-team 72 opening-quote, mid-token, and end-token carets return stable named-color candidates", async () => {
    assert.deepStrictEqual(colorLabels((await rawCompletionItemsAt(page('<TextBlock Foreground="|" />'))).items), EXPECTED_COLOR_NAMES, "opening quote should show the full set");
    assert.ok(colorLabels((await rawCompletionItemsAt(page('<TextBlock Foreground="Corn|silk" />'))).items).includes("Cornsilk"), "mid-token should still include the exact whole-token candidate");
    assert.deepStrictEqual(colorLabels((await rawCompletionItemsAt(page('<TextBlock Foreground="Cornsilk|" />'))).items), ["Cornsilk"], "end-token should use the whole token");
  });

  it("red-team 72 non-Brush/Color attributes never leak named colors", async () => {
    const negatives = [
      ["Button.Width double", '<Button Width="|" />'],
      ["Button.Height double", '<Button Height="|" />'],
      ["Button.MinWidth double", '<Button MinWidth="|" />'],
      ["Button.MaxWidth double", '<Button MaxWidth="|" />'],
      ["Button.MinHeight double", '<Button MinHeight="|" />'],
      ["Button.MaxHeight double", '<Button MaxHeight="|" />'],
      ["Button.Visibility enum", '<Button Visibility="|" />'],
      ["Button.HorizontalAlignment enum", '<Button HorizontalAlignment="|" />'],
      ["TextBlock.Text string", '<TextBlock Text="|" />'],
      ["TextBlock.Tag object/string-like", '<TextBlock Tag="|" />'],
      ["Grid.Row attached int", '<Grid><TextBlock Grid.Row="|" /></Grid>'],
      ["Button.IsEnabled bool", '<Button IsEnabled="|" />'],
    ];
    for (const [name, inner] of negatives) {
      await assertNoNamedColors(page(inner), name);
    }
  });

  it("red-team 72 markup-extension values route to resource and x:Bind classifiers instead of named colors", async () => {
    const staticItems = await assertNoNamedColors(page('<Grid Background="{StaticResource |}" />'), "StaticResource in Brush property");
    const staticLabels = staticItems.map((i) => i.label);
    assert.ok(staticLabels.includes("SmokeAccentBrush"), `StaticResource should still offer fixture resource keys; got ${JSON.stringify(staticLabels.slice(0, 30))}`);

    const themeItems = await assertNoNamedColors(page('<Grid Background="{ThemeResource |}" />'), "ThemeResource in Brush property");
    assert.ok(themeItems.some((i) => String(i.label).includes("AccentFillColorDefaultBrush")), `ThemeResource should still offer framework keys; got ${JSON.stringify(themeItems.map((i) => i.label).slice(0, 30))}`);

    const bindItems = await assertNoNamedColors(page('<TextBlock Text="{x:Bind |}" />'), "x:Bind in string property");
    const bindLabels = bindItems.map((i) => i.label);
    assert.ok(bindLabels.includes("GreetingText"), `x:Bind should still offer page members; got ${JSON.stringify(bindLabels.slice(0, 30))}`);
  });

  it("red-team 72 typed hex literal remains free-form completion and document color stays a separate surface", async () => {
    await assertNoNamedColors(page('<Rectangle Fill="#FF0000|" />'), "direct #FF0000 literal");
    const colors = await h.documentColorsAt(page('<Rectangle Fill="#FF0000" />'));
    assert.ok(colors.some((c) => c.text === "#FF0000"), `document color provider should still see #FF0000 separately; got ${JSON.stringify(colors)}`);
  });

  it("red-team 72 identical requests are deterministic", async () => {
    const buffer = page('<Border BorderBrush="Corn|" />');
    const shape = (items) => colorItems(items).map((i) => [i.label, i.detail, i.newText, i.kind]).sort();
    const first = shape((await rawCompletionItemsAt(buffer)).items);
    const second = shape((await rawCompletionItemsAt(buffer)).items);
    assert.deepStrictEqual(second, first, `identical completion request should be deterministic; first=${JSON.stringify(first)} second=${JSON.stringify(second)}`);
  });

  it("red-team 72 comments and CDATA suppress named-color completions", async () => {
    await assertNoNamedColors(page('<!-- <TextBlock Foreground="|" /> -->'), "comment body");
    await assertNoNamedColors(page('<Grid><![CDATA[<TextBlock Foreground="|" />]]></Grid>'), "CDATA body");
  });

  it("red-team 72 malformed and unterminated markup returns arrays and does not throw", async () => {
    const probes = [
      page('<TextBlock Foreground="|'),
      page('<TextBlock Foreground="{StaticResource |" />'),
      page('<TextBlock Foreground="{x:Bind |" />'),
      page('<SolidColorBrush Color="Corn|'),
      `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  <Grid Background="|"`,
    ];
    for (const probe of probes) {
      const { items } = await rawCompletionItemsAt(probe);
      assert.ok(Array.isArray(items), `malformed completion should return an array; got=${typeof items}`);
    }
  });

  it.skip("red-team 72 user-defined Brush/Color name collision requires a fixture type not present here", async () => {
    // The fixture has no custom non-WinUI Brush or Color property.
  });
});
