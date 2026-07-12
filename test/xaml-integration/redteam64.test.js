"use strict";

// Round 64 red-team probes for mc:Ignorable value completion.

const assert = require("node:assert");
const vscode = require("vscode");
const h = require("./helper");

const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const D2008 = "http://schemas.microsoft.com/expression/blend/2008";
const D2006 = "http://schemas.microsoft.com/expression/blend/2006";
const DETAIL = "Ignorable design-time prefix";

function page(inner) {
  return `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage">
  ${inner}
</Page>`;
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

const dt = (items) => items.filter((i) => i.detail === DETAIL);
const labels = (items) => items.map((i) => i.label).sort();
const grid = (attrs) => page(`<Grid xmlns:dd="${D2006}" ${attrs} />`);
const triGrid = (attrs) => page(`<Grid xmlns:dd="${D2006}" xmlns:des="${D2008}" ${attrs} />`);

function summarize(items) {
  return JSON.stringify(items.map((i) => ({
    label: i.label,
    detail: i.detail,
    kind: i.kind,
    newText: i.newText,
    range: i.range,
  })));
}

function assertDtLabels(items, expected, reason) {
  assert.deepStrictEqual(labels(dt(items)), expected.slice().sort(), `${reason}; got ${summarize(dt(items))}`);
}

function assertDtEmpty(items, reason) {
  assert.deepStrictEqual(dt(items), [], `${reason}; got ${summarize(dt(items))}`);
}

function assertDtShape(item, label) {
  assert.ok(item, `missing ${label}; got no item`);
  assert.strictEqual(item.label, label);
  assert.strictEqual(item.kind, vscode.CompletionItemKind.Value, `${label} must be Value kind: ${JSON.stringify(item)}`);
  assert.strictEqual(item.detail, DETAIL);
  assert.strictEqual(item.newText, label);
  assert.strictEqual(item.sortText, label);
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

describe("WinUI XAML red-team 64 — mc:Ignorable value completion", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("red-team 64 basic empty value offers exactly design-time prefixes with server item shape", async () => {
    const items = (await completionItemsAt(grid('mc:Ignorable="|"'))).items;
    assertDtLabels(items, ["d", "dd"], "empty mc:Ignorable should offer only in-scope design-time prefixes");
    for (const label of ["d", "dd"]) assertDtShape(dt(items).find((i) => i.label === label), label);
    for (const notPrefix of ["", "mc", "x", "local"]) {
      assert.ok(!labels(dt(items)).includes(notPrefix), `${notPrefix} must not be offered; got ${summarize(dt(items))}`);
    }
  });

  it("red-team 64 partial filtering is prefix-based and returns zero for garbage", async () => {
    assertDtLabels((await completionItemsAt(grid('mc:Ignorable="d|"'))).items, ["d", "dd"], "d should match d and dd");
    assertDtLabels((await completionItemsAt(grid('mc:Ignorable="dd|"'))).items, ["dd"], "dd should match only dd");
    assertDtEmpty((await completionItemsAt(grid('mc:Ignorable="z|"'))).items, "z should match no design-time prefix");
    assertDtEmpty((await completionItemsAt(grid('mc:Ignorable="garbage|"'))).items, "garbage should match no design-time prefix");
  });

  it("red-team 64 excludes listed prefixes before current empty token and edits only that token", async () => {
    const result = await completionItemsAt(grid('mc:Ignorable="d |"'));
    const items = dt(result.items);
    assert.deepStrictEqual(labels(items), ["dd"], `d is already listed, dd remains; got ${summarize(items)}`);
    const edited = applySingleEdit(result.clean, items.find((i) => i.label === "dd"));
    assert.ok(edited.includes('mc:Ignorable="d dd"'), edited);
    assert.ok(!edited.includes('mc:Ignorable="dd"'), edited);
  });

  it("red-team 64 filters the current token separately from already-listed earlier tokens", async () => {
    assertDtLabels((await completionItemsAt(grid('mc:Ignorable="d d|"'))).items, ["dd"], "earlier d excludes d, current d still filters dd in");
    assertDtLabels((await completionItemsAt(grid('mc:Ignorable="dd d|"'))).items, ["d"], "earlier dd excludes dd, current d still permits d");
  });

  it("red-team 64 does not exclude prefixes that appear only after the caret", async () => {
    const result = await completionItemsAt(grid('mc:Ignorable="|d"'));
    const items = dt(result.items);
    assert.deepStrictEqual(labels(items), ["d", "dd"], `only tokens before the caret are listed; got ${summarize(items)}`);
    const edited = applySingleEdit(result.clean, items.find((i) => i.label === "dd"));
    assert.ok(edited.includes('mc:Ignorable="ddd"'), `empty current token edit should not consume text after caret: ${edited}`);
  });

  it("red-team 64 custom prefix mapped to the mc URI gates in by resolved URI", async () => {
    assertDtLabels((await completionItemsAt(page(`<Grid xmlns:dd="${D2006}" xmlns:compat="${MC}" compat:Ignorable="|" />`))).items, ["d", "dd"], "compat:Ignorable resolves to the mc URI");
  });

  it("red-team 64 wrong attribute namespace or missing prefix gates out", async () => {
    for (const [name, buffer] of [
      ["design-time prefix", page(`<Grid xmlns:dd="${D2006}" d:Ignorable="|" />`)],
      ["unprefixed", page(`<Grid xmlns:dd="${D2006}" Ignorable="|" />`)],
      ["foreign prefix", page(`<Grid xmlns:dd="${D2006}" xmlns:foreign="urn:not-mc" foreign:Ignorable="|" />`)],
    ]) {
      assertDtEmpty((await completionItemsAt(buffer)).items, `${name} must not trigger mc:Ignorable completion`);
    }
  });

  it("red-team 64 local name is exact and ordinal-case-sensitive", async () => {
    for (const attr of ["mc:Ignorablex", "mc:Ignore", "mc:ignorable"]) {
      assertDtEmpty((await completionItemsAt(grid(`${attr}="|"`))).items, `${attr} must not match mc:Ignorable`);
    }
  });

  it("red-team 64 default xmlns mapped to design-time is never offered as an empty prefix", async () => {
    const buffer = `<Page xmlns="${D2008}" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" xmlns:mc="${MC}" x:Class="SmokeFixture.SmokePage">
  <Grid mc:Ignorable="|" />
</Page>`;
    assertDtEmpty((await completionItemsAt(buffer)).items, "default design-time namespace has no prefix token to offer");
  });

  it("red-team 64 non-mc attributes do not surface design-time prefix completions and boolean fallback still works", async () => {
    for (const attr of ["Tag", "Text", "Width", "HorizontalAlignment"]) {
      assertDtEmpty((await completionItemsAt(page(`<Button ${attr}="|" />`))).items, `${attr} must not trigger the mc:Ignorable branch`);
    }
    const boolItems = (await completionItemsAt(page('<Button IsEnabled="|" />'))).items;
    assertDtEmpty(boolItems, "bool attribute must not trigger mc:Ignorable branch");
    assert.ok(labels(boolItems).includes("True") && labels(boolItems).includes("False"), `bool completion should still fall through; got ${summarize(boolItems)}`);
  });

  it("red-team 64 caret positions cover opening quote, mid-token, end-token, trailing space, and between prefixes", async () => {
    assertDtLabels((await completionItemsAt(grid('mc:Ignorable="|"'))).items, ["d", "dd"], "opening quote");
    assertDtLabels((await completionItemsAt(grid('mc:Ignorable="d|d"'))).items, ["d", "dd"], "mid-token sees only text before caret");
    assertDtLabels((await completionItemsAt(grid('mc:Ignorable="dd|"'))).items, ["dd"], "end-token filters to dd");
    assertDtLabels((await completionItemsAt(grid('mc:Ignorable="dd |"'))).items, ["d"], "trailing space starts a new token and excludes dd");
    assertDtLabels((await completionItemsAt(grid('mc:Ignorable="d | dd"'))).items, ["dd"], "between prefixes only excludes tokens before caret");
  });

  it("red-team 64 malformed, unterminated, wrapped, comment, and CDATA probes return arrays and do not leak server items in inert text", async () => {
    const cases = [
      ["unterminated value", grid('mc:Ignorable="d|')],
      ["unterminated element", `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage">
  <Grid xmlns:dd="${D2006}" mc:Ignorable="d|`],
      ["malformed markup", page(`<Grid xmlns:dd="${D2006}" <Button mc:Ignorable="|" />`)],
      ["comment", page(`<Grid xmlns:dd="${D2006}">
    <!-- <Button mc:Ignorable="|" /> -->
  </Grid>`)],
      ["CDATA", page(`<Grid xmlns:dd="${D2006}">
    <![CDATA[ <Button mc:Ignorable="|" /> ]]>
  </Grid>`)],
      ["EOF after caret", `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage">
  <Grid xmlns:dd="${D2006}" mc:Ignorable="|`],
      ["multi-line wrapped attribute", page(`<Grid
    xmlns:dd="${D2006}"
    mc:Ignorable="d |" />`)],
    ];

    for (const [name, buffer] of cases) {
      const result = await completionItemsAt(buffer);
      assert.ok(Array.isArray(result.items), `${name}: completion request should return an item array`);
      if (name === "comment" || name === "CDATA") {
        assertDtEmpty(result.items, `${name} should not get mc:Ignorable server completions`);
      }
    }
  });

  it("red-team 64 repeated identical requests are deterministic", async () => {
    const probe = triGrid('mc:Ignorable="d|"');
    const first = dt((await completionItemsAt(probe)).items);
    const second = dt((await completionItemsAt(probe)).items);
    assert.deepStrictEqual(normalized(second), normalized(first));
  });

  it("red-team 64 three design-time prefixes obey empty, partial, and already-listed subsets", async () => {
    assertDtLabels((await completionItemsAt(triGrid('mc:Ignorable="|"'))).items, ["d", "dd", "des"], "three prefixes on empty token");
    assertDtLabels((await completionItemsAt(triGrid('mc:Ignorable="de|"'))).items, ["des"], "partial de should narrow to des");
    assertDtLabels((await completionItemsAt(triGrid('mc:Ignorable="d des |"'))).items, ["dd"], "listed d and des should leave dd");
  });
});
