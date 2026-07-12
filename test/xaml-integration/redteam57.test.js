"use strict";

// Round 57 red-team probes for type-name completion in {d:DesignInstance ...} TYPE arguments.
// Positive/negative assertions use server-only fields (newText/detail) to avoid VS Code word
// suggestions from the x:Class="SmokeFixture.SmokePage" text in every probe.

const assert = require("node:assert");
const vscode = require("vscode");
const h = require("./helper");

const DESIGN_2008 = "http://schemas.microsoft.com/expression/blend/2008";
const DESIGN_2006 = "http://schemas.microsoft.com/expression/blend/2006";

function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
}

function pageWith(extraNs, inner) {
  return `<Page ${h.NS}\n    ${extraNs}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
}

function gridDesign(valueWithCaret) {
  return page(`<Grid d:DataContext="${valueWithCaret}" />`);
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
  return h.completionItemsAt(buffer);
}

function summarize(items) {
  return JSON.stringify(items.slice(0, 40));
}

function isSmokePageType(i) {
  return i.newText === "local:SmokePage" && i.detail === "SmokeFixture";
}

function isButtonType(i) {
  return i.label === "Button" && (i.detail || "").includes("Microsoft.UI.Xaml.Controls");
}

function isIntrinsic(i, alias, prefix = "x") {
  return i.label === alias && i.newText === `${prefix}:${alias}` && i.detail === "System";
}

function requireSmoke(items, message = "expected local:SmokePage type completion") {
  assert.ok(items.some(isSmokePageType), `${message}; got ${summarize(items)}`);
}

function requireNoSmoke(items, message = "expected no local:SmokePage type completion") {
  assert.ok(!items.some(isSmokePageType), `${message}; got ${JSON.stringify(items.filter(isSmokePageType))}`);
}

function requireButton(items, message = "expected default-namespace Button type completion") {
  assert.ok(items.some(isButtonType), `${message}; got ${summarize(items)}`);
}

function requireIntrinsic(items, alias, prefix = "x") {
  assert.ok(items.some((i) => isIntrinsic(i, alias, prefix)), `expected ${prefix}:${alias} (System); got ${summarize(items)}`);
}

function requireNoIntrinsic(items, alias, message) {
  assert.ok(!items.some((i) => i.label === alias && i.detail === "System"), `${message}; got ${summarize(items)}`);
}

function normalize(items) {
  return items
    .map((i) => ({ label: i.label, detail: i.detail, newText: i.newText }))
    .sort((a, b) => `${a.label}\0${a.detail}\0${a.newText}`.localeCompare(`${b.label}\0${b.detail}\0${b.newText}`));
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

describe("WinUI XAML — red-team 57 ({d:DesignInstance} type completion)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("completes project and framework types in positional DesignInstance arguments", async () => {
    requireSmoke(await itemsAt(gridDesign("{d:DesignInstance local:Smo|}")));
    requireButton(await itemsAt(gridDesign("{d:DesignInstance Butt|}")));
  });

  it("completes Type= project types in multiple named-argument shapes", async () => {
    for (const value of [
      "{d:DesignInstance Type=local:Smo|}",
      "{d:DesignInstance IsDesignTimeCreatable=True, Type=local:Smo|}",
      "{d:DesignInstance Type= local:Smo|}",
      "{d:DesignInstance Type =local:Smo|}",
      "{d:DesignInstance Type = local:Smo|}",
    ]) {
      requireSmoke(await itemsAt(gridDesign(value)), `expected type completion for ${value}`);
    }
  });

  it("completes framework types in Type= arguments", async () => {
    requireButton(await itemsAt(gridDesign("{d:DesignInstance Type=Butt|}")));
    requireButton(await itemsAt(gridDesign("{d:DesignInstance Type=|}")), "empty Type= should offer default-namespace framework types");
  });

  it("honors design-time namespace aliases including blend/2008 and blend/2006", async () => {
    requireSmoke(await itemsAt(pageWith(`xmlns:dd="${DESIGN_2008}"`, '<Grid d:DataContext="{dd:DesignInstance local:Smo|}" />')), "blend/2008 alias should complete");
    requireSmoke(await itemsAt(pageWith(`xmlns:d06="${DESIGN_2006}"`, '<Grid d:DataContext="{d06:DesignInstance local:Smo|}" />')), "blend/2006 alias should complete");
  });

  it("does not complete when the DesignInstance prefix is foreign, undeclared, local, or absent", async () => {
    for (const [name, buffer] of [
      ["undeclared prefix", gridDesign("{zzz:DesignInstance local:Smo|}")],
      ["unprefixed extension", gridDesign("{DesignInstance local:Smo|}")],
      ["using namespace prefix", gridDesign("{local:DesignInstance local:Smo|}")],
      ["non-design URI prefix", pageWith('xmlns:foreign57="using:SmokeFixture"', '<Grid d:DataContext="{foreign57:DesignInstance local:Smo|}" />')],
    ]) {
      requireNoSmoke(await itemsAt(buffer), `${name} must not complete DesignInstance type names`);
    }
  });

  it("does not treat non-Type named arguments or lowercase type= as type references", async () => {
    for (const [name, value] of [
      ["empty IsDesignTimeCreatable", "{d:DesignInstance IsDesignTimeCreatable=|}"],
      ["partial IsDesignTimeCreatable", "{d:DesignInstance IsDesignTimeCreatable=Tr|}"],
      ["case-sensitive lowercase type", "{d:DesignInstance type=local:Smo|}"],
    ]) {
      const items = await itemsAt(gridDesign(value));
      requireNoSmoke(items, `${name} must not offer local:SmokePage type completion`);
      requireNoIntrinsic(items, "String", `${name} must not offer intrinsic type completion`);
    }
  });

  it("only treats the first positional argument as the DesignInstance type", async () => {
    requireNoSmoke(await itemsAt(gridDesign("{d:DesignInstance local:SmokePage, local:Smo|}")), "second positional token must not complete as a type");
    requireNoSmoke(await itemsAt(gridDesign("{d:DesignInstance local:SmokePage, |}")), "empty second positional token must not complete as a type");
  });

  it("does not complete after an ended type token or after the markup extension closes", async () => {
    requireNoSmoke(await itemsAt(gridDesign("{d:DesignInstance local:SmokePage |}")), "caret after whitespace following complete token must not complete");
    requireNoSmoke(await itemsAt(page('<Grid d:DataContext="{d:DesignInstance local:SmokePage}"| />')), "caret after closed extension must not complete");
  });

  it("keeps wrapped {x:Type} completion both positional and Type= named", async () => {
    requireSmoke(await itemsAt(gridDesign("{d:DesignInstance {x:Type local:Smo|}}")), "inner positional {x:Type} should complete");
    requireSmoke(await itemsAt(gridDesign("{d:DesignInstance Type={x:Type local:Smo|}}")), "inner named {x:Type} should complete");
  });

  it("does not use the outer DesignInstance classifier when caret is outside wrapped inner braces", async () => {
    requireNoSmoke(await itemsAt(gridDesign("{d:DesignInstance {x:Type local:SmokePage} |}")), "outside inner {x:Type}, the first positional arg is already ended");
  });

  it("offers XAML intrinsic aliases in DesignInstance type arguments and filters by partial", async () => {
    const all = await itemsAt(gridDesign("{d:DesignInstance x:|}"));
    for (const alias of ["String", "Int32", "Boolean", "Type"]) requireIntrinsic(all, alias);

    const filtered = await itemsAt(gridDesign("{d:DesignInstance x:Str|}"));
    requireIntrinsic(filtered, "String");
    requireNoIntrinsic(filtered, "Int32", "x:Str| should not offer integer aliases");
  });

  it("applies the SmokePage edit over local:Smo without corrupting the token", async () => {
    const probe = gridDesign("{d:DesignInstance local:Smo|}");
    const { clean, items } = await completionItemsWithRangesAt(probe);
    const item = items.find(isSmokePageType);
    assert.ok(item, `expected local:SmokePage item with range; got ${summarize(items)}`);
    const edited = applySingleEdit(clean, item);
    assert.ok(edited.includes('d:DataContext="{d:DesignInstance local:SmokePage}"'), `edit should yield exactly local:SmokePage; got ${edited}`);
    assert.ok(!edited.includes("local:SmoSmokePage") && !edited.includes("local:local:SmokePage"), `edit must not duplicate prefix/local; got ${edited}`);
  });

  it("handles empty, prefix, post-colon, and mid-token caret positions", async () => {
    requireButton(await itemsAt(gridDesign("{d:DesignInstance |}")), "empty positional type should offer default-namespace framework types");
    requireSmoke(await itemsAt(gridDesign("{d:DesignInstance local:|}")), "post-colon local: should offer project types");
    requireSmoke(await itemsAt(gridDesign("{d:DesignInstance local:Smo|kePage}")), "mid-token local:Smo|kePage should offer project types");
    assert.ok(Array.isArray(await itemsAt(gridDesign("{d:DesignInstance local|:SmokePage}"))), "mid-prefix local|:SmokePage should not throw");
  });

  it("does not throw for malformed or unterminated DesignInstance contexts", async () => {
    for (const [name, buffer] of [
      ["no space or args", gridDesign("{d:DesignInstance|}")],
      ["trailing space without close", page('<Grid d:DataContext="{d:DesignInstance |" />')],
      ["unterminated type", page('<Grid d:DataContext="{d:DesignInstance local:Smo|" />')],
      ["open paren", gridDesign("{d:DesignInstance (|}")],
      ["empty Type=", gridDesign("{d:DesignInstance Type=|}")],
      ["nested open brace", gridDesign("{d:DesignInstance {|}")],
      ["unquoted attribute value", page('<Grid d:DataContext={d:DesignInstance local:Smo|} />')],
    ]) {
      const items = await itemsAt(buffer);
      assert.ok(Array.isArray(items), `${name} should return a completion array`);
    }
  });

  it("is consistent with x:DataType and {x:Type} for local:Smo partials", async () => {
    for (const [name, buffer] of [
      ["x:DataType", page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="local:Smo|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>')],
      ["x:Type", page('<Button Tag="{x:Type local:Smo|}" />')],
      ["d:DesignInstance", gridDesign("{d:DesignInstance local:Smo|}")],
    ]) {
      requireSmoke(await itemsAt(buffer), `${name} should complete local:SmokePage`);
    }
  });

  it("offers non-class project types in permissive type-reference sites", async () => {
    for (const [name, buffer] of [
      ["x:Type", page('<Button Tag="{x:Type local:IG|}" />')],
      ["d:DesignInstance", gridDesign("{d:DesignInstance local:IG|}")],
    ]) {
      const items = await itemsAt(buffer);
      assert.ok(items.some((i) => i.newText === "local:IGreetingService" && i.detail === "SmokeFixture"), `${name} should offer the local interface; got ${summarize(items)}`);
    }
  });

  it("classifies the extension independent of the containing attribute name", async () => {
    requireSmoke(await itemsAt(page('<Button Tag="{d:DesignInstance local:Smo|}" />')), "Tag attribute should still complete because the extension is the signal");
  });

  it("is deterministic for the same DesignInstance buffer", async () => {
    const probe = gridDesign("{d:DesignInstance local:Smo|}");
    assert.deepStrictEqual(normalize(await itemsAt(probe)), normalize(await itemsAt(probe)), "same buffer should produce identical server completions");
  });
});
