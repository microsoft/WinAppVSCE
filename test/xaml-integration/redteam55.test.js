"use strict";

// Round 55 red-team probes for XAML intrinsic-alias completion in type references.
// Positive assertions discriminate on server-only fields (newText/detail/kind/range), not bare
// labels, because VS Code merges word-based suggestions harvested from the buffer.

const assert = require("node:assert");
const vscode = require("vscode");
const h = require("./helper");

const XAML_NS = "http://schemas.microsoft.com/winfx/2006/xaml";
const INTRINSICS = [
  "String",
  "Boolean",
  "Byte",
  "Char",
  "Decimal",
  "Single",
  "Double",
  "Int16",
  "Int32",
  "Int64",
  "Object",
  "TimeSpan",
  "Uri",
  "Type",
];

function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
}

function pageWith(extraNs, inner) {
  return `<Page ${h.NS}\n    ${extraNs}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
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

function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function offsetOf(starts, text, line, character) {
  assert.ok(line < starts.length, `line ${line} should exist in ${JSON.stringify(text)}`);
  return Math.min(starts[line] + character, text.length);
}

function applySingleEdit(text, item) {
  assert.ok(item.range, `completion item should carry a textEdit range: ${JSON.stringify(item)}`);
  const starts = lineStartsOf(text);
  const start = offsetOf(starts, text, item.range.start.line, item.range.start.character);
  const end = offsetOf(starts, text, item.range.end.line, item.range.end.character);
  return text.slice(0, start) + item.newText + text.slice(end);
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
  return JSON.stringify(items.slice(0, 50));
}

function findItem(items, predicate, message) {
  const item = items.find(predicate);
  assert.ok(item, `${message}; got ${summarize(items)}`);
  return item;
}

function intrinsicItem(items, alias, prefix = "x") {
  return items.find((i) => i.label === alias && i.newText === `${prefix}:${alias}` && i.detail === "System");
}

function requireIntrinsic(items, alias, prefix = "x") {
  return findItem(
    items,
    (i) => i.label === alias && i.newText === `${prefix}:${alias}` && i.detail === "System",
    `expected intrinsic ${prefix}:${alias} with detail System`
  );
}

function assertNoIntrinsic(items, alias, message) {
  const leaked = items.filter((i) => i.label === alias && i.detail === "System");
  assert.deepStrictEqual(leaked, [], `${message}; leaked ${JSON.stringify(leaked)} from ${summarize(items)}`);
}

function assertArrayNoThrow(items, message) {
  assert.ok(Array.isArray(items), `${message}; got ${typeof items}`);
}

function normalize(items) {
  return items.map((i) => ({ label: i.label, detail: i.detail, newText: i.newText, kind: i.kind })).sort((a, b) =>
    `${a.label}\0${a.detail}\0${a.newText}\0${a.kind}`.localeCompare(`${b.label}\0${b.detail}\0${b.newText}\0${b.kind}`)
  );
}

describe("WinUI XAML — red-team 55 (intrinsic aliases in type references)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("offers the full intrinsic alias set for x:DataType=\"x:|\"", async () => {
    const items = await itemsAt(page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="x:|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>'));
    for (const alias of INTRINSICS) requireIntrinsic(items, alias);
  });

  it("filters x:Str| to String and not unrelated aliases", async () => {
    const items = await itemsAt(page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="x:Str|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>'));
    requireIntrinsic(items, "String");
    assertNoIntrinsic(items, "Boolean", "x:Str| must not offer Boolean");
    assertNoIntrinsic(items, "Int32", "x:Str| must not offer Int32");
  });

  it("filters x:Int| to the three integer-width aliases only", async () => {
    const items = await itemsAt(page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="x:Int|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>'));
    for (const alias of ["Int16", "Int32", "Int64"]) requireIntrinsic(items, alias);
    assertNoIntrinsic(items, "String", "x:Int| must not offer String");
    assertNoIntrinsic(items, "Boolean", "x:Int| must not offer Boolean");
  });

  it("returns no intrinsic aliases for a non-matching x:Zzz| partial", async () => {
    const items = await itemsAt(page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="x:Zzz|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>'));
    for (const alias of INTRINSICS) assertNoIntrinsic(items, alias, "x:Zzz| must not offer intrinsics");
  });

  it("applies the String edit over x:Str| without duplicating typed text", async () => {
    const probe = page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="x:Str|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>');
    const { clean, items } = await completionItemsWithRangesAt(probe);
    const edited = applySingleEdit(clean, requireIntrinsic(items, "String"));
    assert.ok(edited.includes('x:DataType="x:String"'), `edit should yield exactly x:String; got ${edited}`);
    assert.ok(!edited.includes("x:Strx:String") && !edited.includes("x:StrString"), `edit must not duplicate typed text; got ${edited}`);
  });

  it("applies the String edit over empty x:| without corrupting the prefix", async () => {
    const probe = page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="x:|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>');
    const { clean, items } = await completionItemsWithRangesAt(probe);
    const edited = applySingleEdit(clean, requireIntrinsic(items, "String"));
    assert.ok(edited.includes('x:DataType="x:String"'), `edit should yield exactly x:String; got ${edited}`);
    assert.ok(!edited.includes("x:x:String") && !edited.includes('x:DataType="x:StringString"'), `edit must not duplicate prefix/local; got ${edited}`);
  });

  it("classifies intrinsic kinds sanely", async () => {
    const items = await itemsAt(page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="x:|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>'));
    assert.strictEqual(requireIntrinsic(items, "String").kind, vscode.CompletionItemKind.Class, "System.String should be a Class completion");
    assert.strictEqual(requireIntrinsic(items, "Type").kind, vscode.CompletionItemKind.Class, "System.Type should be a Class completion");
    assert.strictEqual(requireIntrinsic(items, "Int32").kind, vscode.CompletionItemKind.Struct, "System.Int32 should be a Struct completion");
    assert.strictEqual(requireIntrinsic(items, "Boolean").kind, vscode.CompletionItemKind.Struct, "System.Boolean should be a Struct completion");
  });

  it("resolves a custom sys prefix by the XAML namespace URI", async () => {
    const items = await itemsAt(pageWith(`xmlns:sys="${XAML_NS}"`, '<ListView><ListView.ItemTemplate><DataTemplate x:DataType="sys:Str|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>'));
    requireIntrinsic(items, "String", "sys");
  });

  it("resolves a second arbitrary custom prefix by the XAML namespace URI", async () => {
    const items = await itemsAt(pageWith(`xmlns:alias55="${XAML_NS}"`, '<ListView><ListView.ItemTemplate><DataTemplate x:DataType="alias55:Ty|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>'));
    requireIntrinsic(items, "Type", "alias55");
  });

  it("does not surface intrinsics for an unprefixed default-namespace partial", async () => {
    const items = await itemsAt(page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="Str|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>'));
    assertNoIntrinsic(items, "String", "unprefixed Str| resolves the default namespace, not XAML intrinsics");
  });

  it("does not surface intrinsics for a local project namespace prefix", async () => {
    const items = await itemsAt(page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="local:Str|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>'));
    assertNoIntrinsic(items, "String", "local:Str| must not offer XAML intrinsics");
  });

  it("does not surface intrinsics for an undeclared value prefix", async () => {
    const items = await itemsAt(page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="zzzz:|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>'));
    for (const alias of ["String", "Int32", "Type"]) assertNoIntrinsic(items, alias, "undeclared zzzz: must not offer XAML intrinsics");
  });

  it("kind-filters Style TargetType intrinsics to reference types (refined by round 56)", async () => {
    const items = await itemsAt(page('<Page.Resources><Style TargetType="x:|"><Setter Property="Tag" Value="probe" /></Style></Page.Resources>'));
    requireIntrinsic(items, "String");
    requireIntrinsic(items, "Object");
    requireIntrinsic(items, "Type");
    assertNoIntrinsic(items, "Int32", "TargetType is class-only so value-type intrinsics are filtered out");
    assertNoIntrinsic(items, "Boolean", "TargetType is class-only so value-type intrinsics are filtered out");
  });

  it("offers intrinsics in {x:Type x:|} markup-extension type arguments", async () => {
    const items = await itemsAt(page('<Button Tag="{x:Type x:St|}" />'));
    requireIntrinsic(items, "String");
    assertNoIntrinsic(items, "Boolean", "{x:Type x:St|} must filter by the typed local partial");
  });

  it("offers intrinsics in the {x:Static x:|} owner position", async () => {
    const items = await itemsAt(page('<Button Tag="{x:Static x:|}" />'));
    requireIntrinsic(items, "String");
    requireIntrinsic(items, "Int32");
  });

  it("roots x:Bind member completion at System.String for x:DataType=\"x:String\"", async () => {
    const members = await h.completionsAt(page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="x:String"><TextBlock Text="{x:Bind Len|}" /></DataTemplate></ListView.ItemTemplate></ListView>'));
    assert.ok(members.includes("Length"), `x:String x:DataType should offer System.String.Length; got ${members.slice(0, 80).join(", ")}`);
    assert.ok(!members.includes("GreetingText"), `x:String x:DataType must not root at SmokePage; got ${members.slice(0, 80).join(", ")}`);
  });

  it("does not duplicate intrinsic aliases for x:|", async () => {
    const items = await itemsAt(page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="x:|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>'));
    for (const alias of ["String", "Object", "Int32"]) {
      const hits = items.filter((i) => i.label === alias && i.detail === "System" && i.newText === `x:${alias}`);
      assert.strictEqual(hits.length, 1, `${alias} should appear exactly once as an intrinsic; hits=${JSON.stringify(hits)} from ${summarize(items)}`);
    }
  });

  it("survives malformed x:DataType intrinsic-prefix values", async () => {
    for (const [name, buffer] of [
      ["unterminated quote and element", `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  <ListView><ListView.ItemTemplate><DataTemplate x:DataType="x:|`],
      ["unquoted value", page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType=x:|><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>')],
      ["caret mid-prefix", page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="x|:String"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>')],
      ["caret after colon before existing local", page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="x:|String"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>')],
    ]) {
      const items = await itemsAt(buffer);
      assertArrayNoThrow(items, `${name} should return a completion array`);
    }
  });

  it("is deterministic for a representative intrinsic request", async () => {
    const probe = page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="x:Int|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>');
    assert.deepStrictEqual(normalize(await itemsAt(probe)), normalize(await itemsAt(probe)), "same intrinsic probe should produce identical completion items");
  });
});
