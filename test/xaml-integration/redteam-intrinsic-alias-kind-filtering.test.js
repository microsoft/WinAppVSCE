"use strict";

// Kind-filtered XAML intrinsic aliases in type-reference completion. Server-only fields distinguish results from VS Code word suggestions.

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

function normalize(items) {
  return items.map((i) => ({ label: i.label, detail: i.detail, newText: i.newText, kind: i.kind })).sort((a, b) =>
    `${a.label}\0${a.detail}\0${a.newText}\0${a.kind}`.localeCompare(`${b.label}\0${b.detail}\0${b.newText}\0${b.kind}`)
  );
}

function assertArrayNoThrow(items, message) {
  assert.ok(Array.isArray(items), `${message}; got ${typeof items}`);
}

function styleTargetType(valueWithCaret) {
  return page(`<Page.Resources><Style TargetType="${valueWithCaret}"><Setter Property="Tag" Value="probe" /></Style></Page.Resources>`);
}

function controlTemplateTargetType(valueWithCaret) {
  return page(`<Page.Resources><ControlTemplate TargetType="${valueWithCaret}"><Grid /></ControlTemplate></Page.Resources>`);
}

function dataTemplateDataType(valueWithCaret) {
  return page(`<ListView><ListView.ItemTemplate><DataTemplate x:DataType="${valueWithCaret}"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>`);
}

function assertReferenceOnlyClassIntrinsics(items, prefix = "x") {
  for (const alias of REFERENCE_INTRINSICS) {
    const item = requireIntrinsic(items, alias, prefix);
    assert.strictEqual(item.kind, vscode.CompletionItemKind.Class, `${prefix}:${alias} should be a Class completion`);
  }
  for (const alias of VALUE_INTRINSICS) {
    assertNoIntrinsic(items, alias, `${prefix}: class-only site must not offer value-type intrinsic ${alias}`);
  }
}

describe("WinUI XAML — red-team 56 (kind-filtered XAML intrinsic type aliases)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("kind-filters Style TargetType x:| to reference-type intrinsics only", async () => {
    assertReferenceOnlyClassIntrinsics(await itemsAt(styleTargetType("x:|")));
  });

  it("kind-filters ControlTemplate TargetType x:| to reference-type intrinsics only", async () => {
    assertReferenceOnlyClassIntrinsics(await itemsAt(controlTemplateTargetType("x:|")));
  });

  it("preserves TargetType partial filtering while excluding value-type lookalikes", async () => {
    const cases = [
      ["x:T|", ["Type"], ["TimeSpan"]],
      ["x:Int|", [], ["Int16", "Int32", "Int64"]],
      ["x:Str|", ["String"], ["Boolean", "Int32"]],
      ["x:U|", ["Uri"], ["Int32"]],
      ["x:O|", ["Object"], ["Int32"]],
      ["x:D|", [], ["Decimal", "Double"]],
      ["x:By|", [], ["Byte"]],
      ["x:Ch|", [], ["Char"]],
      ["x:Si|", [], ["Single"]],
      ["x:De|", [], ["Decimal"]],
    ];
    for (const [partial, yes, no] of cases) {
      const items = await itemsAt(styleTargetType(partial));
      for (const alias of yes) requireIntrinsic(items, alias);
      for (const alias of no) assertNoIntrinsic(items, alias, `${partial} should not offer ${alias} in class-only TargetType`);
    }
  });

  it("kind-filters a custom XAML-URI prefix in TargetType and preserves that prefix in newText", async () => {
    const items = await itemsAt(pageWith(`xmlns:sys="${XAML_NS}"`, '<Page.Resources><Style TargetType="sys:|"><Setter Property="Tag" Value="probe" /></Style></Page.Resources>'));
    assertReferenceOnlyClassIntrinsics(items, "sys");
  });

  it("keeps all 14 intrinsics in DataTemplate x:DataType x:|", async () => {
    const items = await itemsAt(dataTemplateDataType("x:|"));
    for (const alias of ALL_INTRINSICS) requireIntrinsic(items, alias);
    for (const alias of REFERENCE_INTRINSICS) assert.strictEqual(requireIntrinsic(items, alias).kind, vscode.CompletionItemKind.Class, `${alias} kind`);
    for (const alias of VALUE_INTRINSICS) assert.strictEqual(requireIntrinsic(items, alias).kind, vscode.CompletionItemKind.Struct, `${alias} kind`);
  });

  it("keeps value and reference intrinsics in {x:Type x:|} type arguments", async () => {
    const items = await itemsAt(page('<Button Tag="{x:Type x:|}" />'));
    for (const alias of ["Int32", "Boolean", "Double", "String", "Object", "Type"]) requireIntrinsic(items, alias);
  });

  it("keeps value and reference intrinsics in {x:Static x:|} owners", async () => {
    const items = await itemsAt(page('<Button Tag="{x:Static x:|}" />'));
    for (const alias of ["Int32", "String", "Object", "Type"]) requireIntrinsic(items, alias);
  });

  it("preserves permissive-site partial filtering for integer aliases", async () => {
    const items = await itemsAt(dataTemplateDataType("x:Int|"));
    for (const alias of ["Int16", "Int32", "Int64"]) requireIntrinsic(items, alias);
    assertNoIntrinsic(items, "String", "x:DataType x:Int| should not offer String");
  });

  it("preserves permissive-site partial filtering for TimeSpan in x:Type", async () => {
    const items = await itemsAt(page('<Button Tag="{x:Type x:Ti|}" />'));
    requireIntrinsic(items, "TimeSpan");
    assertNoIntrinsic(items, "Type", "{x:Type x:Ti|} should not offer Type");
  });

  it("keeps framework type completion in TargetType while filtering value intrinsics", async () => {
    const items = await itemsAt(styleTargetType("x:|"));
    requireIntrinsic(items, "String");
    assertNoIntrinsic(items, "Int32", "TargetType x:| should filter Int32");

    const frameworkItems = await itemsAt(styleTargetType("Butt|"));
    findItem(frameworkItems, (i) => i.label === "Button" && i.detail !== "System", "TargetType Butt| should still offer WinUI Button");
  });

  it("proves the same x:Int| partial diverges between TargetType and x:DataType exactly on kind", async () => {
    const classOnly = await itemsAt(styleTargetType("x:Int|"));
    for (const alias of ["Int16", "Int32", "Int64"]) assertNoIntrinsic(classOnly, alias, "TargetType x:Int| must reject integer value types");

    const permissive = await itemsAt(dataTemplateDataType("x:Int|"));
    for (const alias of ["Int16", "Int32", "Int64"]) {
      assert.strictEqual(requireIntrinsic(permissive, alias).kind, vscode.CompletionItemKind.Struct, `x:DataType ${alias} should be Struct`);
    }
  });

  it("does not leak System intrinsics for unprefixed default-namespace type names", async () => {
    for (const buffer of [styleTargetType("Str|"), dataTemplateDataType("Str|")]) {
      const items = await itemsAt(buffer);
      for (const alias of ["String", "Int32", "Type"]) assertNoIntrinsic(items, alias, "unprefixed completion must not offer XAML intrinsics");
    }
  });

  it("does not leak System intrinsics for local or undeclared prefixes", async () => {
    for (const buffer of [styleTargetType("local:|"), styleTargetType("local:Str|"), styleTargetType("zzzz:|"), dataTemplateDataType("zzzz:Int|")]) {
      const items = await itemsAt(buffer);
      for (const alias of ["String", "Int32", "Type"]) assertNoIntrinsic(items, alias, "non-XAML prefix must not offer XAML intrinsics");
    }
  });

  it("applies the String edit over TargetType x:Str| without corrupting the prefix or local", async () => {
    const probe = styleTargetType("x:Str|");
    const { clean, items } = await completionItemsWithRangesAt(probe);
    const edited = applySingleEdit(clean, requireIntrinsic(items, "String"));
    assert.ok(edited.includes('TargetType="x:String"'), `edit should yield exactly x:String; got ${edited}`);
    assert.ok(!edited.includes("x:x:String") && !edited.includes("x:StrString") && !edited.includes("x:Stringing"), `edit must not duplicate prefix/local; got ${edited}`);
  });

  it("applies the Type edit over TargetType x:| without duplicating x:", async () => {
    const probe = styleTargetType("x:|");
    const { clean, items } = await completionItemsWithRangesAt(probe);
    const edited = applySingleEdit(clean, requireIntrinsic(items, "Type"));
    assert.ok(edited.includes('TargetType="x:Type"'), `edit should yield exactly x:Type; got ${edited}`);
    assert.ok(!edited.includes("x:x:Type") && !edited.includes("x:TypeType"), `edit must not duplicate prefix/local; got ${edited}`);
  });

  it("returns arrays without throwing for malformed TargetType prefix contexts", async () => {
    for (const [name, buffer] of [
      ["unterminated quote and element", `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  <Page.Resources><Style TargetType="x:|`],
      ["unquoted value", page('<Page.Resources><Style TargetType=x:|><Setter Property="Tag" Value="probe" /></Style></Page.Resources>')],
      ["caret mid-prefix", styleTargetType("x|:Int32")],
      ["caret after colon before existing local", styleTargetType("x:|Int32")],
    ]) {
      assertArrayNoThrow(await itemsAt(buffer), `${name} should return a completion array`);
    }
  });

  it("is deterministic for representative TargetType intrinsic completion", async () => {
    const probe = styleTargetType("x:T|");
    assert.deepStrictEqual(normalize(await itemsAt(probe)), normalize(await itemsAt(probe)), "TargetType x:T| completion should be stable across calls");
  });

  it("uses the resolved namespace URI, not the literal x prefix, for positive and foreign-prefix negatives", async () => {
    const aliasItems = await itemsAt(pageWith(`xmlns:alias56="${XAML_NS}"`, '<Page.Resources><Style TargetType="alias56:Str|"><Setter Property="Tag" Value="probe" /></Style></Page.Resources>'));
    requireIntrinsic(aliasItems, "String", "alias56");
    assertNoIntrinsic(aliasItems, "Int32", "alias56 TargetType should still be class-only");

    const foreignItems = await itemsAt(pageWith('xmlns:foreign56="using:SmokeFixture"', '<Page.Resources><Style TargetType="foreign56:Str|"><Setter Property="Tag" Value="probe" /></Style></Page.Resources>'));
    assertNoIntrinsic(foreignItems, "String", "foreign prefix must not be treated as XAML intrinsics");
  });
});
