"use strict";

// XAML intrinsic aliases as element names. Server-only fields distinguish results from VS Code word suggestions.

const assert = require("node:assert");
const vscode = require("vscode");
const h = require("./helper");

const XAML_NS = "http://schemas.microsoft.com/winfx/2006/xaml";
const REFERENCE_INTRINSICS = ["Object", "String", "Uri", "Type"];
const VALUE_INTRINSICS = ["Boolean", "Byte", "Char", "Decimal", "Single", "Double", "Int16", "Int32", "Int64", "TimeSpan"];
const ALL_INTRINSICS = [
  "Object",
  "String",
  "Uri",
  "Type",
  "Boolean",
  "Byte",
  "Char",
  "Decimal",
  "Single",
  "Double",
  "Int16",
  "Int32",
  "Int64",
  "TimeSpan",
];

function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
}

function pageWith(extraNs, inner) {
  return `<Page ${h.NS}\n    ${extraNs}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
}

function resources(inner) {
  return page(`<Page.Resources>\n    ${inner}\n  </Page.Resources>`);
}

function labelOf(item) {
  return typeof item.label === "string" ? item.label : item.label.label;
}

function caretPosition(text) {
  const i = text.indexOf("|");
  assert.ok(i >= 0, "probe text must contain a | caret marker");
  const before = text.slice(0, i);
  const nl = before.lastIndexOf("\n");
  const line = (before.match(/\n/g) || []).length;
  const character = before.length - (nl + 1);
  const clean = text.slice(0, i) + text.slice(i + 1);
  return { clean, position: new vscode.Position(line, character) };
}

function rangeShape(range) {
  if (!range) return undefined;
  if (range.inserting && range.replacing) range = range.replacing;
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

async function completionItemsWithRangesAt(text) {
  const { clean, position } = caretPosition(text);
  await h.setBuffer(clean);
  const list = await vscode.commands.executeCommand(
    "vscode.executeCompletionItemProvider",
    h.getDoc().uri,
    position
  );
  return {
    clean,
    items: (list && list.items ? list.items : []).map((item) => ({
      label: labelOf(item),
      detail: item.detail,
      kind: item.kind,
      newText: item.textEdit
        ? item.textEdit.newText
        : typeof item.insertText === "string"
          ? item.insertText
          : item.insertText && item.insertText.value !== undefined
            ? item.insertText.value
            : undefined,
      range: item.textEdit ? rangeShape(item.textEdit.range) : undefined,
    })),
  };
}

async function itemsAt(buffer) {
  return (await completionItemsWithRangesAt(buffer)).items;
}

function summarize(items) {
  return JSON.stringify(items.slice(0, 60));
}

function systemItems(items) {
  return items.filter((i) => i.detail === "System" || ALL_INTRINSICS.includes(i.label));
}

function isIntrinsic(i, alias, prefix = "x") {
  return i.label === alias && i.newText === `${prefix}:${alias}` && i.detail === "System";
}

function requireIntrinsic(items, alias, prefix = "x") {
  const item = items.find((i) => isIntrinsic(i, alias, prefix));
  assert.ok(item, `expected intrinsic element ${prefix}:${alias}; server-ish items=${JSON.stringify(systemItems(items))}; got ${summarize(items)}`);
  return item;
}

function requireAllIntrinsics(items, prefix = "x") {
  for (const alias of ALL_INTRINSICS) requireIntrinsic(items, alias, prefix);
}

function requireNoIntrinsic(items, message) {
  const leaked = items.filter((i) => i.detail === "System" && ALL_INTRINSICS.includes(i.label));
  assert.deepStrictEqual(leaked, [], `${message}; leaked=${JSON.stringify(leaked)}; got ${summarize(items)}`);
}

function intrinsicLabels(items) {
  return items.filter((i) => i.detail === "System" && ALL_INTRINSICS.includes(i.label)).map((i) => i.label).sort();
}

function normalizeServerIntrinsics(items) {
  return items
    .filter((i) => i.detail === "System" && ALL_INTRINSICS.includes(i.label))
    .map((i) => ({ label: i.label, detail: i.detail, newText: i.newText, kind: i.kind }))
    .sort((a, b) => `${a.label}\0${a.detail}\0${a.newText}\0${a.kind}`.localeCompare(`${b.label}\0${b.detail}\0${b.newText}\0${b.kind}`));
}

function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function offsetOf(starts, text, line, character) {
  assert.ok(line < starts.length, `line ${line} should exist in probe text`);
  return Math.min(starts[line] + character, text.length);
}

function applySingleEdit(text, item) {
  assert.ok(item.range, `completion item should carry a textEdit range: ${JSON.stringify(item)}`);
  const starts = lineStartsOf(text);
  const start = offsetOf(starts, text, item.range.start.line, item.range.start.character);
  const end = offsetOf(starts, text, item.range.end.line, item.range.end.character);
  return text.slice(0, start) + item.newText + text.slice(end);
}

describe("WinUI XAML — red-team 58 intrinsic element completion", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("offers all 14 intrinsic elements in Page.Resources", async () => {
    requireAllIntrinsics(await itemsAt(resources("<x:|")));
  });

  it("offers all value-type intrinsic structs as elements", async () => {
    const items = await itemsAt(resources("<x:|"));
    for (const alias of VALUE_INTRINSICS) requireIntrinsic(items, alias);
  });

  it("offers all reference-type intrinsic aliases as elements", async () => {
    const items = await itemsAt(resources("<x:|"));
    for (const alias of REFERENCE_INTRINSICS) requireIntrinsic(items, alias);
  });

  it("assigns Struct kind to value-type intrinsic elements", async () => {
    const items = await itemsAt(resources("<x:|"));
    for (const alias of VALUE_INTRINSICS) {
      assert.strictEqual(requireIntrinsic(items, alias).kind, vscode.CompletionItemKind.Struct, `${alias} should be Struct kind`);
    }
  });

  it("assigns Class kind to reference-type intrinsic elements", async () => {
    const items = await itemsAt(resources("<x:|"));
    for (const alias of REFERENCE_INTRINSICS) {
      assert.strictEqual(requireIntrinsic(items, alias).kind, vscode.CompletionItemKind.Class, `${alias} should be Class kind`);
    }
  });

  it("filters <x:Str| to String only among intrinsics", async () => {
    const items = await itemsAt(resources("<x:Str|"));
    assert.deepStrictEqual(intrinsicLabels(items), ["String"], `unexpected server intrinsics: ${JSON.stringify(systemItems(items))}`);
    requireIntrinsic(items, "String");
  });

  it("filters <x:Int| to the three integer aliases and no unrelated intrinsics", async () => {
    const items = await itemsAt(resources("<x:Int|"));
    assert.deepStrictEqual(intrinsicLabels(items), ["Int16", "Int32", "Int64"], `unexpected server intrinsics: ${JSON.stringify(systemItems(items))}`);
  });

  it("filters <x:Dou| to Double only", async () => {
    const items = await itemsAt(resources("<x:Dou|"));
    assert.deepStrictEqual(intrinsicLabels(items), ["Double"], `unexpected server intrinsics: ${JSON.stringify(systemItems(items))}`);
  });

  it("filters <x:Ti| to TimeSpan only, not Type", async () => {
    const items = await itemsAt(resources("<x:Ti|"));
    assert.deepStrictEqual(intrinsicLabels(items), ["TimeSpan"], `unexpected server intrinsics: ${JSON.stringify(systemItems(items))}`);
  });

  it("filters <x:Zzz| to no intrinsic aliases", async () => {
    requireNoIntrinsic(await itemsAt(resources("<x:Zzz|")), "unknown intrinsic partial must not leak System aliases");
  });

  it("matches intrinsic element partials case-insensitively for lowercase str", async () => {
    const items = await itemsAt(resources("<x:str|"));
    assert.deepStrictEqual(intrinsicLabels(items), ["String"], `unexpected server intrinsics: ${JSON.stringify(systemItems(items))}`);
    requireIntrinsic(items, "String");
  });

  it("matches intrinsic element partials case-insensitively for uppercase INT", async () => {
    const items = await itemsAt(resources("<x:INT|"));
    assert.deepStrictEqual(intrinsicLabels(items), ["Int16", "Int32", "Int64"], `unexpected server intrinsics: ${JSON.stringify(systemItems(items))}`);
  });

  it("resolves a custom sys prefix by XAML URI and emits sys-qualified newText", async () => {
    const buffer = pageWith(`xmlns:sys="${XAML_NS}"`, `<Page.Resources>\n    <sys:|\n  </Page.Resources>`);
    requireAllIntrinsics(await itemsAt(buffer), "sys");
  });

  it("does not offer intrinsic elements at an unprefixed default-namespace <| position", async () => {
    requireNoIntrinsic(await itemsAt(page("<|")), "unprefixed element name must not show x: intrinsic elements");
  });

  it("does not offer intrinsic elements for unprefixed <Str| partials", async () => {
    requireNoIntrinsic(await itemsAt(page("<Str|")), "unprefixed partial must not show x: intrinsic elements");
  });

  it("does not offer intrinsic elements for an undeclared prefix", async () => {
    requireNoIntrinsic(await itemsAt(resources("<zzz:|")), "undeclared prefix must not show x: intrinsic elements");
  });

  it("does not offer intrinsic elements for a foreign declared prefix", async () => {
    const buffer = pageWith('xmlns:foreign58="using:SmokeFixture"', `<Page.Resources>\n    <foreign58:|\n  </Page.Resources>`);
    requireNoIntrinsic(await itemsAt(buffer), "foreign prefix must not show x: intrinsic elements");
  });

  it("filters intrinsics out of Grid.RowDefinitions for x:-prefixed element names", async () => {
    const items = await itemsAt(page(`<Grid>\n    <Grid.RowDefinitions>\n      <x:|\n    </Grid.RowDefinitions>\n  </Grid>`));
    requireNoIntrinsic(items, "RowDefinitions should reject non-assignable System intrinsic elements");
  });

  it("still offers RowDefinition in an unprefixed Grid.RowDefinitions child position", async () => {
    const items = await itemsAt(page(`<Grid>\n    <Grid.RowDefinitions>\n      <|\n    </Grid.RowDefinitions>\n  </Grid>`));
    assert.ok(items.some((i) => i.label === "RowDefinition" && i.detail && i.detail.includes("Microsoft.UI.Xaml")), `expected RowDefinition CLR element; got ${summarize(items)}`);
    requireNoIntrinsic(items, "unprefixed RowDefinitions child must not show x: intrinsic elements");
  });

  it("keeps all intrinsics in Page.Resources where content type is permissive", async () => {
    requireAllIntrinsics(await itemsAt(resources("<x:|")));
  });

  it("keeps intrinsics for a direct object-element (object-typed content) child position", async () => {
    // A ContentControl's Content is object-typed, so intrinsics stay offered as element children.
    requireAllIntrinsics(await itemsAt(page(`<Button>\n    <x:|\n  </Button>`)));
  });

  it("applies the <x:Str| completion edit without duplicating prefix or partial", async () => {
    const probe = resources("<x:Str|");
    const { clean, items } = await completionItemsWithRangesAt(probe);
    const edited = applySingleEdit(clean, requireIntrinsic(items, "String"));
    assert.ok(edited.includes("<x:String"), `edit should yield <x:String; got ${edited}`);
    assert.ok(!edited.includes("<x:Strx:String") && !edited.includes("<x:StringString"), `edit must not duplicate text; got ${edited}`);
  });

  it("applies the empty <x:| completion edit without dropping or duplicating the prefix", async () => {
    const probe = resources("<x:|");
    const { clean, items } = await completionItemsWithRangesAt(probe);
    const edited = applySingleEdit(clean, requireIntrinsic(items, "String"));
    assert.ok(edited.includes("<x:String"), `edit should yield <x:String; got ${edited}`);
    assert.ok(!edited.includes("<x:x:String") && !edited.includes("<String"), `edit must keep exactly one x: prefix; got ${edited}`);
  });

  it("does not duplicate any server intrinsic alias", async () => {
    const labels = intrinsicLabels(await itemsAt(resources("<x:|")));
    assert.deepStrictEqual(labels, [...new Set(labels)], `duplicate server intrinsic labels: ${JSON.stringify(labels)}`);
  });

  it("is deterministic across repeated completion calls", async () => {
    const probe = resources("<x:|");
    assert.deepStrictEqual(normalizeServerIntrinsics(await itemsAt(probe)), normalizeServerIntrinsics(await itemsAt(probe)));
  });

  it("suppresses intrinsic element completion inside XML comments", async () => {
    requireNoIntrinsic(await itemsAt(page("<!-- <x:| -->\n<Grid />")), "comments must suppress x: intrinsic element completion");
  });

  it("suppresses intrinsic element completion inside CDATA", async () => {
    requireNoIntrinsic(await itemsAt(page("<Grid><![CDATA[ <x:| ]]></Grid>")), "CDATA must suppress x: intrinsic element completion");
  });

  it("does not throw for malformed or unterminated x: element-name contexts", async () => {
    for (const [name, buffer] of [
      ["bare x colon", resources("<x:|")],
      ["bare x prefix without colon", resources("<x|")],
      ["unterminated partial", resources("<x:Str|")],
      ["missing close in Page child", page("<Grid>\n    <x:Str|\n  </Grid>")],
    ]) {
      const items = await itemsAt(buffer);
      assert.ok(Array.isArray(items), `${name} should return a completion array`);
    }
  });
});
