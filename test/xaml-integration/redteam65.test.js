"use strict";

// Round 65 red-team probes for markup-extension enum value completion in x:Bind/Bind.

const assert = require("node:assert");
const vscode = require("vscode");
const h = require("./helper");

const UST_DETAIL = "UpdateSourceTrigger";
const MODE_DETAIL = "BindingMode";
const UST_MEMBERS = ["Default", "Explicit", "LostFocus", "PropertyChanged"];
const MODE_MEMBERS = ["OneTime", "OneWay", "TwoWay"];

function page(inner) {
  return `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage">
  ${inner}
</Page>`;
}

function textBox(textValue) {
  return page(`<TextBox Text="${textValue}" />`);
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

async function completionItemsAt(text) {
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
      sortText: item.sortText,
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

const byDetail = (items, detail) => items.filter((i) => i.detail === detail);
const labels = (items) => items.map((i) => i.label).sort();
const ust = (items) => byDetail(items, UST_DETAIL);
const mode = (items) => byDetail(items, MODE_DETAIL);

function summarize(items) {
  return JSON.stringify(items.map((i) => ({
    label: i.label,
    detail: i.detail,
    kind: i.kind,
    newText: i.newText,
    sortText: i.sortText,
    range: i.range,
  })));
}

function assertDetailLabels(items, detail, expected, reason) {
  const actual = byDetail(items, detail);
  assert.deepStrictEqual(labels(actual), expected.slice().sort(), `${reason}; got ${summarize(actual)}`);
}

function assertNoBindEnumItems(items, reason) {
  const actual = items.filter((i) => i.detail === UST_DETAIL || i.detail === MODE_DETAIL);
  assert.deepStrictEqual(actual, [], `${reason}; got ${summarize(actual)}`);
}

function assertEnumItemShape(item, label, detail) {
  assert.ok(item, `missing ${detail}.${label}`);
  assert.strictEqual(item.label, label);
  assert.strictEqual(item.kind, vscode.CompletionItemKind.EnumMember, `${label} must be EnumMember: ${JSON.stringify(item)}`);
  assert.strictEqual(item.detail, detail);
  assert.strictEqual(item.newText, label);
  assert.strictEqual(item.sortText, label);
}

function assertPropertyItem(items, label, reason) {
  const item = items.find((i) => i.label === label);
  assert.ok(item, `${reason}; missing ${label}; got ${summarize(items)}`);
  assert.strictEqual(item.kind, vscode.CompletionItemKind.Property, `${label} must be Property: ${JSON.stringify(item)}`);
  assert.strictEqual(item.newText, label);
}

function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function offsetOf(starts, line, character) {
  assert.ok(line < starts.length, `line ${line} should exist in probe text`);
  return starts[line] + character;
}

function applySingleEdit(text, item) {
  assert.ok(item.range, `completion item should carry a textEdit range: ${JSON.stringify(item)}`);
  const starts = lineStartsOf(text);
  const start = offsetOf(starts, item.range.start.line, item.range.start.character);
  const end = offsetOf(starts, item.range.end.line, item.range.end.character);
  return text.slice(0, start) + item.newText + text.slice(end);
}

function normalized(items) {
  return items
    .map((i) => ({ label: i.label, detail: i.detail, kind: i.kind, newText: i.newText, sortText: i.sortText, range: i.range }))
    .sort((a, b) => `${a.detail}\0${a.label}`.localeCompare(`${b.detail}\0${b.label}`));
}

describe("WinUI XAML red-team 65 — x:Bind enum argument value completion", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("red-team 65 basic x:Bind UpdateSourceTrigger empty value returns exactly enum members with server shape", async () => {
    const items = (await completionItemsAt(textBox("{x:Bind GreetingText, UpdateSourceTrigger=|}"))).items;
    assertDetailLabels(items, UST_DETAIL, UST_MEMBERS, "x:Bind UpdateSourceTrigger empty value should complete exactly the enum");
    for (const label of UST_MEMBERS) assertEnumItemShape(ust(items).find((i) => i.label === label), label, UST_DETAIL);
  });

  it("red-team 65 x:Bind UpdateSourceTrigger partial filtering is prefix and case-insensitive", async () => {
    assertDetailLabels((await completionItemsAt(textBox("{x:Bind GreetingText, UpdateSourceTrigger=Prop|}"))).items, UST_DETAIL, ["PropertyChanged"], "Prop should narrow to PropertyChanged");
    assertDetailLabels((await completionItemsAt(textBox("{x:Bind GreetingText, UpdateSourceTrigger=L|}"))).items, UST_DETAIL, ["LostFocus"], "L should narrow to LostFocus");
    assertDetailLabels((await completionItemsAt(textBox("{x:Bind GreetingText, UpdateSourceTrigger=z|}"))).items, UST_DETAIL, [], "z should match no UpdateSourceTrigger members");
    assertDetailLabels((await completionItemsAt(textBox("{x:Bind GreetingText, UpdateSourceTrigger=prop|}"))).items, UST_DETAIL, ["PropertyChanged"], "prop should match case-insensitively");
  });

  it("red-team 65 x:Bind Mode still completes through the curated enum map", async () => {
    const items = (await completionItemsAt(textBox("{x:Bind GreetingText, Mode=|}"))).items;
    assertDetailLabels(items, MODE_DETAIL, MODE_MEMBERS, "x:Bind Mode empty value should complete BindingMode");
    for (const label of MODE_MEMBERS) assertEnumItemShape(mode(items).find((i) => i.label === label), label, MODE_DETAIL);
    assertDetailLabels((await completionItemsAt(textBox("{x:Bind GreetingText, Mode=Tw|}"))).items, MODE_DETAIL, ["TwoWay"], "Mode=Tw should narrow to TwoWay");
  });

  it("red-team 65 classic Binding reflection path still completes UpdateSourceTrigger and Mode without duplicates", async () => {
    const ustItems = (await completionItemsAt(textBox("{Binding Path=GreetingText, UpdateSourceTrigger=|}"))).items;
    assertDetailLabels(ustItems, UST_DETAIL, UST_MEMBERS, "classic Binding UpdateSourceTrigger should still reflect enum values");
    assert.strictEqual(ust(ustItems).length, UST_MEMBERS.length, `classic Binding UpdateSourceTrigger should not duplicate items; got ${summarize(ust(ustItems))}`);

    const modeItems = (await completionItemsAt(textBox("{Binding Path=GreetingText, Mode=|}"))).items;
    assertDetailLabels(modeItems, MODE_DETAIL, MODE_MEMBERS, "classic Binding Mode should still reflect enum values");
    assert.strictEqual(mode(modeItems).length, MODE_MEMBERS.length, `classic Binding Mode should not duplicate items; got ${summarize(mode(modeItems))}`);
  });

  it("red-team 65 x:Bind UpdateSourceTrigger is found after prior enum and nested markup arguments", async () => {
    assertDetailLabels((await completionItemsAt(textBox("{x:Bind GreetingText, Mode=TwoWay, UpdateSourceTrigger=|}"))).items, UST_DETAIL, UST_MEMBERS, "UpdateSourceTrigger after Mode should complete");
    assertDetailLabels((await completionItemsAt(textBox("{x:Bind GreetingText, Converter={StaticResource C}, UpdateSourceTrigger=|}"))).items, UST_DETAIL, UST_MEMBERS, "UpdateSourceTrigger after nested StaticResource should complete");
  });

  it("red-team 65 whitespace around x:Bind separators does not suppress enum value completion", async () => {
    assertDetailLabels((await completionItemsAt(textBox("{x:Bind GreetingText,\n    Mode = TwoWay,\n    UpdateSourceTrigger = |}"))).items, UST_DETAIL, UST_MEMBERS, "wrapped whitespace around '=' should complete UpdateSourceTrigger");
    assertDetailLabels((await completionItemsAt(textBox("{x:Bind GreetingText ,   UpdateSourceTrigger = L|}"))).items, UST_DETAIL, ["LostFocus"], "spaces around comma and '=' should preserve partial filtering");
  });

  it("red-team 65 bare Bind receives the same compiled-binding enum fallback", async () => {
    assertDetailLabels((await completionItemsAt(textBox("{Bind GreetingText, UpdateSourceTrigger=|}"))).items, UST_DETAIL, UST_MEMBERS, "bare Bind UpdateSourceTrigger should complete through compiled-binding fallback");
    assertDetailLabels((await completionItemsAt(textBox("{Bind GreetingText, Mode=Tw|}"))).items, MODE_DETAIL, ["TwoWay"], "bare Bind Mode partial should complete through compiled-binding fallback");
  });

  it("red-team 65 non-enum x:Bind arguments do not leak BindingMode or UpdateSourceTrigger enum members", async () => {
    for (const arg of ["Converter", "ConverterParameter", "ConverterLanguage", "FallbackValue", "TargetNullValue", "BindBack"]) {
      assertNoBindEnumItems((await completionItemsAt(textBox(`{x:Bind GreetingText, ${arg}=|}`))).items, `${arg}= must not receive enum completions`);
    }
  });

  it("red-team 65 argument-name completion still offers x:Bind names as Property items", async () => {
    assertPropertyItem((await completionItemsAt(textBox("{x:Bind GreetingText, |}"))).items, "UpdateSourceTrigger", "empty arg-name position should offer UpdateSourceTrigger");
    assertPropertyItem((await completionItemsAt(textBox("{x:Bind GreetingText, Update|}"))).items, "UpdateSourceTrigger", "partial Update should offer UpdateSourceTrigger");
    assertPropertyItem((await completionItemsAt(textBox("{x:Bind GreetingText, Mode|}"))).items, "Mode", "partial Mode should offer Mode");
  });

  it("red-team 65 x:Bind enum argument-name lookup is case-insensitive in the value branch", async () => {
    assertDetailLabels((await completionItemsAt(textBox("{x:Bind GreetingText, updatesourcetrigger=|}"))).items, UST_DETAIL, UST_MEMBERS, "lower-case arg name should hit OrdinalIgnoreCase map");
    assertDetailLabels((await completionItemsAt(textBox("{x:Bind GreetingText, UPDATESOURCETRIGGER=Prop|}"))).items, UST_DETAIL, ["PropertyChanged"], "upper-case arg name should hit OrdinalIgnoreCase map and filter partial");
  });

  it("red-team 65 positional x:Bind path text is not confused with an enum argument value", async () => {
    const items = (await completionItemsAt(textBox("{x:Bind UpdateSourceTrigger|}"))).items;
    assertNoBindEnumItems(items, "first positional segment should be a path completion context, not UpdateSourceTrigger enum values");
  });

  it("red-team 65 applied edit replaces only the current partial enum token", async () => {
    const result = await completionItemsAt(textBox("{x:Bind GreetingText, UpdateSourceTrigger=Prop|}"));
    const edited = applySingleEdit(result.clean, ust(result.items).find((i) => i.label === "PropertyChanged"));
    assert.ok(edited.includes("UpdateSourceTrigger=PropertyChanged}"), edited);
    assert.ok(!edited.includes("PropertyChangedPropertyChanged"), edited);
    assert.ok(!edited.includes("UpdateSourceTrigger=Prop}"), edited);
  });

  it("red-team 65 applied edit inserts an empty enum value without consuming following markup", async () => {
    const result = await completionItemsAt(textBox("{x:Bind GreetingText, UpdateSourceTrigger=|}"));
    const edited = applySingleEdit(result.clean, ust(result.items).find((i) => i.label === "Default"));
    assert.ok(edited.includes("UpdateSourceTrigger=Default}"), edited);
    assert.ok(edited.includes('<TextBox Text="{x:Bind GreetingText, UpdateSourceTrigger=Default}" />'), edited);
    assert.ok(!edited.includes("DefaultDefault"), edited);
  });

  it("red-team 65 malformed x:Bind enum contexts return arrays and inert text does not leak enum members", async () => {
    const cases = [
      ["unterminated markup extension", textBox("{x:Bind GreetingText, UpdateSourceTrigger=|")],
      ["EOF after caret", `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage">
  <TextBox Text="{x:Bind GreetingText, UpdateSourceTrigger=|`],
      ["malformed element", page(`<Grid <TextBox Text="{x:Bind GreetingText, UpdateSourceTrigger=|}" />`)],
      ["comment", page(`<Grid>
    <!-- <TextBox Text="{x:Bind GreetingText, UpdateSourceTrigger=|}" /> -->
  </Grid>`)],
      ["CDATA", page(`<Grid>
    <![CDATA[ <TextBox Text="{x:Bind GreetingText, UpdateSourceTrigger=|}" /> ]]>
  </Grid>`)],
      ["multi-line wrapped extension", page(`<TextBox Text="{x:Bind GreetingText,
    Mode=TwoWay,
    UpdateSourceTrigger=|}" />`)],
    ];

    for (const [name, buffer] of cases) {
      const result = await completionItemsAt(buffer);
      assert.ok(Array.isArray(result.items), `${name}: completion request should return an item array`);
      if (name === "comment" || name === "CDATA") {
        assertNoBindEnumItems(result.items, `${name} should not receive enum completions`);
      }
    }
  });

  it("red-team 65 repeated identical x:Bind enum requests are deterministic", async () => {
    const probe = textBox("{x:Bind GreetingText, UpdateSourceTrigger=Prop|}");
    const first = ust((await completionItemsAt(probe)).items);
    const second = ust((await completionItemsAt(probe)).items);
    assert.deepStrictEqual(normalized(second), normalized(first));
  });

  it("red-team 65 curated x:Bind enum fallback must not leak into unrelated markup extensions", async () => {
    const leaks = [];
    for (const probe of [
      "{StaticResource UpdateSourceTrigger=|}",
      "{StaticResource Mode=|}",
      "{ThemeResource UpdateSourceTrigger=|}",
      "{ThemeResource Mode=|}",
      "{TemplateBinding UpdateSourceTrigger=|}",
      "{TemplateBinding Mode=|}",
      "{RelativeSource UpdateSourceTrigger=|}",
      "{x:Null UpdateSourceTrigger=|}",
      "{x:Null Mode=|}",
    ]) {
      const actual = (await completionItemsAt(textBox(probe))).items.filter((i) => i.detail === UST_DETAIL || i.detail === MODE_DETAIL);
      if (actual.length) leaks.push({ probe, leaked: actual.map((i) => `${i.detail}.${i.label}`).sort() });
    }
    if (leaks.length) {
      throw new Error(`non-Bind markup extensions must not use the curated x:Bind enum map; leaks=${JSON.stringify(leaks)}`);
    }
  });
});
