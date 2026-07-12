"use strict";

// Round 61 red-team probes for xmlns declaration VALUE completion and the using: handoff.

const assert = require("node:assert");
const vscode = require("vscode");
const h = require("./helper");

const PRES = "http://schemas.microsoft.com/winfx/2006/xaml/presentation";
const XAML = "http://schemas.microsoft.com/winfx/2006/xaml";
const DESIGN = "http://schemas.microsoft.com/expression/blend/2008";
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const USING = "using:";

const XMLNS_BY_DETAIL = new Map([
  ["WinUI presentation namespace", PRES],
  ["XAML language namespace (x:)", XAML],
  ["Design-time namespace (d:)", DESIGN],
  ["Markup compatibility namespace (mc:)", MC],
  ["CLR namespace reference", USING],
]);
const XMLNS_DETAILS = new Set(XMLNS_BY_DETAIL.keys());
const CLR_DETAILS = new Set(["CLR namespace", "CLR namespace (referenced)"]);

const page = (inner) => `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage">
  ${inner}
</Page>`;

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

const xmlnsValues = (items) => items.filter((i) => XMLNS_DETAILS.has(i.detail));
const clrValues = (items) => items.filter((i) => CLR_DETAILS.has(i.detail));
const sortedLabels = (items) => items.map((i) => i.label).sort();

function summarize(items) {
  return JSON.stringify(items.slice(0, 50));
}

async function valueItemsAt(buffer) {
  return xmlnsValues((await completionItemsAt(buffer)).items);
}

async function requireOnlyXmlns(buffer, expectedLabels, reason) {
  const items = await valueItemsAt(buffer);
  assert.deepStrictEqual(sortedLabels(items), [...expectedLabels].sort(), `${reason}; got ${summarize(items)}`);
  for (const item of items) {
    assert.strictEqual(item.newText, item.label, `newText must be the whole value: ${JSON.stringify(item)}`);
    assert.strictEqual(XMLNS_BY_DETAIL.get(item.detail), item.label, `detail must identify the exact value: ${JSON.stringify(item)}`);
  }
  return items;
}

function requireLabel(items, label, reason) {
  const item = items.find((i) => i.label === label);
  assert.ok(item, `${reason}; got ${summarize(items)}`);
  return item;
}

function requireNoXmlnsOrUsingHandoffLeak(items, reason) {
  const leaked = items.filter((i) => XMLNS_DETAILS.has(i.detail) || CLR_DETAILS.has(i.detail));
  assert.deepStrictEqual(leaked, [], `${reason}; leaked server namespace completions: ${summarize(leaked)}`);
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

function markerRange(buffer) {
  const caret = buffer.indexOf("|");
  assert.ok(caret >= 0, "probe text must contain a caret marker");
  const start = buffer.lastIndexOf('"', caret) + 1;
  assert.ok(start > 0, `probe caret must be inside a quoted value: ${buffer}`);
  const toPos = (offset) => {
    const before = buffer.slice(0, offset);
    const nl = before.lastIndexOf("\n");
    return {
      line: (before.match(/\n/g) || []).length,
      character: before.length - (nl + 1),
    };
  };
  return { start: toPos(start), end: toPos(caret) };
}

function normalized(items) {
  return items
    .map((i) => ({ label: i.label, detail: i.detail, newText: i.newText, sortText: i.sortText }))
    .sort((a, b) => `${a.detail}\0${a.label}`.localeCompare(`${b.detail}\0${b.label}`));
}

describe("WinUI XAML red-team 61 — xmlns value completion", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("offers the complete URI set plus using: in an empty prefixed xmlns value", async () => {
    await requireOnlyXmlns(page('<Grid xmlns:zzz="|" />'), [PRES, XAML, DESIGN, MC, USING], "empty prefixed xmlns value");
  });

  it("offers the same URI set plus using: for the default xmlns declaration", async () => {
    await requireOnlyXmlns(page('<Grid xmlns="|" />'), [PRES, XAML, DESIGN, MC, USING], "empty default xmlns value");
  });

  it("filters partial prefixes by the whole typed xmlns value", async () => {
    await requireOnlyXmlns(page('<Grid xmlns:zzz="http|" />'), [PRES, XAML, DESIGN, MC], "http should match only URI values");
    await requireOnlyXmlns(page('<Grid xmlns:zzz="usin|" />'), [USING], "usin should match only using:");
    await requireOnlyXmlns(page('<Grid xmlns:zzz="using|" />'), [USING], "using without colon should match only using:");
    await requireOnlyXmlns(page('<Grid xmlns:zzz="http://schemas.microsoft|" />'), [PRES, XAML, DESIGN], "microsoft prefix should exclude openxmlformats");
    await requireOnlyXmlns(page('<Grid xmlns:zzz="http://schemas.microsoft.com/winfx|" />'), [PRES, XAML], "winfx prefix should exclude blend and mc");
    await requireOnlyXmlns(page('<Grid xmlns:zzz="http://schemas.openxml|" />'), [MC], "openxml prefix should match only mc");
    await requireOnlyXmlns(page('<Grid xmlns:zzz="zzz|" />'), [], "garbage prefix should match nothing");
  });

  it("keeps xmlns-value and using: CLR-namespace completions mutually exclusive at handoff points", async () => {
    for (const [name, buffer] of [
      ["after colon", page('<Grid xmlns:zzz="using:|" />')],
      ["after CLR namespace prefix", page('<Grid xmlns:zzz="using:Smoke|" />')],
    ]) {
      const items = (await completionItemsAt(buffer)).items;
      assert.deepStrictEqual(xmlnsValues(items), [], `${name}: xmlns-value items must decline after lowercase using:`);
      requireLabel(clrValues(items), "SmokeFixture", `${name}: expected round-50 CLR namespace completion`);
      assert.ok(!items.some((i) => i.detail === "CLR namespace reference" && i.label === USING), `${name}: must not duplicate the using: scheme item`);
    }

    await requireOnlyXmlns(page('<Grid xmlns:zzz="usin|" />'), [USING], "partial scheme still belongs to xmlns-value completion");
    await requireOnlyXmlns(page('<Grid xmlns:zzz="using|" />'), [USING], "scheme without colon still belongs to xmlns-value completion");
  });

  it("does not leak xmlns-value items into non-xmlns attributes", async () => {
    for (const [name, buffer] of [
      ["Tag", page('<Grid Tag="|" />')],
      ["Width", page('<Grid Width="|" />')],
      ["prefixed non-xmlns", page('<Grid local:Foo="|" />')],
      ["x:Name", page('<Grid x:Name="|" />')],
      ["xmlns-prefixed but no colon", page('<Grid xmlnsfoo="|" />')],
    ]) {
      const items = (await completionItemsAt(buffer)).items;
      assert.deepStrictEqual(xmlnsValues(items), [], `${name}: expected no xmlns-value items, got ${summarize(xmlnsValues(items))}`);
    }
  });

  it("handles opening-quote, mid-token, and end-token caret positions with the correct filtered set", async () => {
    await requireOnlyXmlns(page('<Grid xmlns:zzz="|" />'), [PRES, XAML, DESIGN, MC, USING], "opening quote");
    await requireOnlyXmlns(page('<Grid xmlns:zzz="http://schemas.microsoft.com/win|" />'), [PRES, XAML], "mid URI prefix");
    await requireOnlyXmlns(page('<Grid xmlns:zzz="http://schemas.microsoft.com/winfx|" />'), [PRES, XAML], "end of token");
  });

  it("applies URI edits without prefix duplication or leftover typed text", async () => {
    const probe = page('<Grid xmlns:zzz="http|" />');
    const { clean, items } = await completionItemsAt(probe);
    const pres = requireLabel(xmlnsValues(items), PRES, "expected presentation URI for edit reconstruction");
    const fixed = applySingleEdit(clean, pres);
    assert.ok(fixed.includes(`xmlns:zzz="${PRES}"`), fixed);
    assert.ok(!fixed.includes(`xmlns:zzz="http${PRES}"`), fixed);
  });

  it("applies using: scheme edits without corrupting the partial scheme", async () => {
    const probe = page('<Grid xmlns:zzz="usin|" />');
    const { clean, items } = await completionItemsAt(probe);
    const using = requireLabel(xmlnsValues(items), USING, "expected using: scheme for edit reconstruction");
    const fixed = applySingleEdit(clean, using);
    assert.ok(fixed.includes('xmlns:zzz="using:"'), fixed);
    assert.ok(!fixed.includes('xmlns:zzz="usinusing:"'), fixed);
  });

  it("uses a whole-typed-value replacement range from opening quote to the caret", async () => {
    const probe = page('<Grid Width="10" xmlns:zzz="http|" Height="20" />');
    const { items } = await completionItemsAt(probe);
    const pres = requireLabel(xmlnsValues(items), PRES, "expected item with replacement range");
    assert.deepStrictEqual(pres.range, markerRange(probe), `range should cover only the active xmlns value prefix: ${JSON.stringify(pres)}`);

    const usingProbe = page('<Grid xmlns:zzz="usin|" />');
    const using = requireLabel(xmlnsValues((await completionItemsAt(usingProbe)).items), USING, "expected using range item");
    assert.deepStrictEqual(using.range, markerRange(usingProbe), `using: range should cover the partial scheme: ${JSON.stringify(using)}`);
  });

  it("suppresses xmlns-value completions inside XML comments and CDATA", async () => {
    for (const [name, buffer] of [
      ["comment", page('<!-- <Grid xmlns:zzz="|" /> -->\n<Grid />')],
      ["CDATA", page('<Grid><![CDATA[ <Grid xmlns:zzz="|" /> ]]></Grid>')],
    ]) {
      const items = (await completionItemsAt(buffer)).items;
      requireNoXmlnsOrUsingHandoffLeak(items, name);
    }
  });

  it("is deterministic for repeated identical xmlns-value requests", async () => {
    const probe = page('<Grid xmlns:zzz="http://schemas.microsoft|" />');
    const first = xmlnsValues((await completionItemsAt(probe)).items);
    const second = xmlnsValues((await completionItemsAt(probe)).items);
    assert.deepStrictEqual(normalized(second), normalized(first));
  });

  it("does not throw or hang on malformed and unterminated markup edit states", async () => {
    for (const [name, buffer] of [
      ["unclosed tag", page('<Grid><Broken xmlns:zzz="http|"')],
      ["unterminated attribute value", page('<Grid xmlns:zzz="http|')],
      ["missing closing quote before EOF", `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage">
  <Grid xmlns:zzz="http|`],
      ["xmlns value at EOF", `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage">
  <Grid xmlns:zzz="|`],
    ]) {
      const result = await completionItemsAt(buffer);
      assert.ok(Array.isArray(result.items), `${name}: completion request should return an item array`);
    }
  });

  it("targets the active xmlns value among multiple declarations and adjacent attributes", async () => {
    await requireOnlyXmlns(
      page(`<Grid xmlns:aaa="${PRES}" Width="10" xmlns:zzz="http://schemas.openxml|" Height="20" />`),
      [MC],
      "active zzz xmlns should be filtered independently"
    );
  });

  it("reconstructs adjacent-attribute edits without touching neighboring xmlns declarations", async () => {
    const probe = page(`<Grid xmlns:aaa="${PRES}" Width="10" xmlns:zzz="http|" Height="20" />`);
    const { clean, items } = await completionItemsAt(probe);
    const xaml = requireLabel(xmlnsValues(items), XAML, "expected XAML URI in adjacent-attribute probe");
    const fixed = applySingleEdit(clean, xaml);
    assert.ok(fixed.includes(`xmlns:aaa="${PRES}" Width="10" xmlns:zzz="${XAML}" Height="20"`), fixed);
  });

  it("treats capitalized Using: as xmlns-value scheme correction, not as round-50 CLR handoff", async () => {
    const items = (await completionItemsAt(page('<Grid xmlns:zzz="Using:|" />'))).items;
    assert.deepStrictEqual(clrValues(items), [], `capitalized Using: must not trigger lowercase-only CLR handoff: ${summarize(clrValues(items))}`);
    const valueItems = xmlnsValues(items);
    assert.deepStrictEqual(sortedLabels(valueItems), [USING], `capitalized Using: should still match the using: scheme case-insensitively; got ${summarize(valueItems)}`);
    assert.strictEqual(valueItems[0].newText, USING);
  });

  it("does not combine capitalized Using: with URI or CLR namespace result groups", async () => {
    const items = (await completionItemsAt(page('<Grid xmlns:zzz="Using:Smoke|" />'))).items;
    assert.deepStrictEqual(xmlnsValues(items), [], `overlong capitalized using prefix should not match the shorter using: scheme: ${summarize(xmlnsValues(items))}`);
    assert.deepStrictEqual(clrValues(items), [], `capitalized Using:Smoke must not trigger CLR namespace handoff: ${summarize(clrValues(items))}`);
  });
});
