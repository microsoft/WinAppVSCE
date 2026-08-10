"use strict";

// Type-name completion inside x:DataType values. Server-only fields distinguish results from VS Code word suggestions.

const assert = require("node:assert");
const vscode = require("vscode");
const h = require("./helper");

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
  return JSON.stringify(items.slice(0, 40));
}

function findItem(items, predicate, message) {
  const item = items.find(predicate);
  assert.ok(item, `${message}; got ${summarize(items)}`);
  return item;
}

function findSmokeType(items, message) {
  return findItem(
    items,
    (i) => i.label === "SmokePage" && i.newText === "local:SmokePage" && i.detail === "SmokeFixture",
    message
  );
}

function assertNoSmokeType(items, message) {
  const leaked = items.filter((i) => i.newText === "local:SmokePage" || i.detail === "SmokeFixture");
  assert.deepStrictEqual(leaked, [], `${message}; leaked ${JSON.stringify(leaked)} from ${summarize(items)}`);
}

function assertArrayNoThrow(items, message) {
  assert.ok(Array.isArray(items), `${message}; got ${typeof items}`);
}

describe("WinUI XAML — red-team 54 (x:DataType value type completion)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("offers a project type for x:DataType=\"local:|\"", async () => {
    const items = await itemsAt(page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="local:|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>'));
    findSmokeType(items, "local: empty partial should offer SmokePage as a prefix-qualified type item");
  });

  it("offers a filtered project type for x:DataType=\"local:Smo|\"", async () => {
    const items = await itemsAt(page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="local:Smo|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>'));
    findSmokeType(items, "local:Smo partial should offer SmokePage as a prefix-qualified type item");
  });

  it("replaces the partial project type token instead of corrupting it", async () => {
    const probe = page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="local:Smo|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>');
    const { clean, items } = await completionItemsWithRangesAt(probe);
    const smoke = findSmokeType(items, "local:Smo partial should offer an applicable SmokePage edit");
    const edited = applySingleEdit(clean, smoke);
    assert.ok(edited.includes('x:DataType="local:SmokePage"'), `edit should yield exactly local:SmokePage; got ${edited}`);
    assert.ok(!edited.includes("local:Smolocal:SmokePage") && !edited.includes("local:SmoSmokePage"), `edit must not duplicate typed text; got ${edited}`);
  });

  it("offers default-namespace framework types for a typed prefix", async () => {
    const items = await itemsAt(page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="Butt|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>'));
    findItem(
      items,
      (i) => i.label === "Button" && (i.detail || "").includes("Microsoft.UI.Xaml.Controls"),
      "default namespace Butt partial should offer Button from Microsoft.UI.Xaml.Controls"
    );
  });

  it("offers multiple default-namespace framework types for an empty value", async () => {
    const items = await itemsAt(page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>'));
    const controls = items.filter((i) => (i.detail || "").includes("Microsoft.UI.Xaml.Controls"));
    findItem(items, (i) => i.label === "Button" && (i.detail || "").includes("Microsoft.UI.Xaml.Controls"), "empty partial should include Button");
    assert.ok(controls.length >= 10, `empty partial should expose a broad default-namespace type list; got ${controls.length}: ${summarize(items)}`);
  });

  it("includes non-class default-namespace types when allTypeKinds is enabled", async () => {
    const items = await itemsAt(page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="Visib|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>'));
    findItem(
      items,
      (i) => i.label === "Visibility" && i.newText === "Visibility" && i.detail === "Microsoft.UI.Xaml" && i.kind === vscode.CompletionItemKind.Enum,
      "Visib should offer Microsoft.UI.Xaml.Visibility as an Enum, not a class-only list"
    );
  });

  it("returns no project type for an undeclared value prefix", async () => {
    const items = await itemsAt(page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="zzzz:|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>'));
    assertNoSmokeType(items, "undeclared zzzz: prefix should not fall back to local/default type completion");
  });

  it("filters away project types that do not match the typed local partial", async () => {
    const items = await itemsAt(page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="local:Zzz|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>'));
    assertNoSmokeType(items, "local:Zzz should not offer local:SmokePage");
  });

  it("does not offer type completion in other x: directive attribute values", async () => {
    for (const attr of ["x:Name", "x:Key", "x:Class", "x:Uid"]) {
      const items = await itemsAt(page(`<Grid ${attr}="local:Smo|" />`));
      assertNoSmokeType(items, `${attr} must not reuse x:DataType type completion`);
    }
  });

  it("does not offer type completion in plain string-valued attributes", async () => {
    for (const attr of ["Tag", "Text"]) {
      const items = await itemsAt(page(`<TextBlock ${attr}="local:Smo|" />`));
      assertNoSmokeType(items, `${attr} must not reuse x:DataType type completion`);
    }
  });

  it("matches the x:DataType attribute name case-sensitively", async () => {
    const items = await itemsAt(page('<ListView><ListView.ItemTemplate><DataTemplate x:datatype="local:Smo|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>'));
    assertNoSmokeType(items, "lowercase x:datatype must not be treated as x:DataType");
  });

  it("matches the reserved x prefix case-sensitively", async () => {
    const items = await itemsAt(pageWith('xmlns:X="http://schemas.microsoft.com/winfx/2006/xaml"', '<ListView><ListView.ItemTemplate><DataTemplate X:DataType="local:Smo|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>'));
    assertNoSmokeType(items, "capital X:DataType must not be treated as literal x:DataType");
  });

  it("does not recognize a foreign prefix mapped to the XAML namespace", async () => {
    const items = await itemsAt(pageWith('xmlns:zzz="http://schemas.microsoft.com/winfx/2006/xaml"', '<ListView><ListView.ItemTemplate><DataTemplate zzz:DataType="local:Smo|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>'));
    assertNoSmokeType(items, "zzz:DataType mapped to XAML URI must not be treated as literal x:DataType");
  });

  it("does not recognize a foreign prefix mapped to the project namespace", async () => {
    const items = await itemsAt(pageWith('xmlns:zzz="using:SmokeFixture"', '<ListView><ListView.ItemTemplate><DataTemplate zzz:DataType="local:Smo|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>'));
    assertNoSmokeType(items, "zzz:DataType mapped to SmokeFixture must not be treated as literal x:DataType");
  });

  it("completed x:DataType text roots x:Bind member completion inside the DataTemplate", async () => {
    const offered = await itemsAt(page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="local:Smo|"><TextBlock Text="{x:Bind GreetingText}" /></DataTemplate></ListView.ItemTemplate></ListView>'));
    findSmokeType(offered, "authoring should offer local:SmokePage before member completion is tested");

    const members = await h.completionsAt(page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="local:SmokePage"><TextBlock Text="{x:Bind Gree|}" /></DataTemplate></ListView.ItemTemplate></ListView>'));
    assert.ok(members.includes("GreetingText"), `authored x:DataType local:SmokePage should root x:Bind at SmokePage; got ${members.slice(0, 80).join(", ")}`);
  });

  it("handles caret immediately after the opening quote without throwing", async () => {
    const items = await itemsAt(page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="|local"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>'));
    assertArrayNoThrow(items, "opening-quote caret should return a completion array");
    findItem(items, (i) => i.label === "Button" && (i.detail || "").includes("Microsoft.UI.Xaml.Controls"), "opening-quote caret should still behave like an empty default-namespace type partial");
  });

  it("handles a caret in the middle of the namespace prefix without throwing or leaking project types", async () => {
    const items = await itemsAt(page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="lo|cal:SmokePage"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>'));
    assertArrayNoThrow(items, "mid-prefix caret should return a completion array");
    assertNoSmokeType(items, "mid-prefix caret should not resolve as local:");
  });

  it("handles a caret right after the colon before an existing type token", async () => {
    const items = await itemsAt(page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="local:|SmokePage"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>'));
    assertArrayNoThrow(items, "post-colon caret should return a completion array");
    findSmokeType(items, "post-colon caret should offer project types");
  });

  it("handles a caret at the end of an existing type token", async () => {
    const items = await itemsAt(page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="local:SmokePage|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>'));
    assertArrayNoThrow(items, "end-token caret should return a completion array");
    findSmokeType(items, "end-token caret should still identify the existing project type");
  });

  it("survives malformed and unterminated x:DataType values", async () => {
    for (const [name, buffer] of [
      ["unterminated value", page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="local:| <TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>')],
      ["unterminated element", `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  <ListView><ListView.ItemTemplate><DataTemplate x:DataType="local:|`],
      ["unquoted value", page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType=local:|><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>')],
    ]) {
      const items = await itemsAt(buffer);
      assertArrayNoThrow(items, `${name} should not throw`);
    }
  });

  it("offers x:DataType type completion even when the attribute is on a non-DataTemplate element", async () => {
    const items = await itemsAt(page('<Grid x:DataType="local:Smo|"><TextBlock /></Grid>'));
    findSmokeType(items, "the provider is intentionally not gated to DataTemplate elements");
  });

  it("is deterministic for a representative x:DataType type completion request", async () => {
    const probe = page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="local:Smo|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>');
    const normalize = (items) => items.map((i) => ({ label: i.label, detail: i.detail, newText: i.newText, kind: i.kind })).sort((a, b) =>
      `${a.label}\0${a.detail}\0${a.newText}\0${a.kind}`.localeCompare(`${b.label}\0${b.detail}\0${b.newText}\0${b.kind}`)
    );
    assert.deepStrictEqual(normalize(await itemsAt(probe)), normalize(await itemsAt(probe)), "same x:DataType probe should produce identical completion items");
  });
});
