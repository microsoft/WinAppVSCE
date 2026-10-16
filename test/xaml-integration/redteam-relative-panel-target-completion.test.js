"use strict";

// RelativePanel attached-property element-name completion.

const assert = require("node:assert");
const vscode = require("vscode");
const h = require("./helper");

function page(inner) {
  return `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage">
  ${inner}
</Page>`;
}

const TARGET_PROPS = [
  "RelativePanel.Above",
  "RelativePanel.Below",
  "RelativePanel.LeftOf",
  "RelativePanel.RightOf",
  "RelativePanel.AlignLeftWith",
  "RelativePanel.AlignRightWith",
  "RelativePanel.AlignTopWith",
  "RelativePanel.AlignBottomWith",
  "RelativePanel.AlignHorizontalCenterWith",
  "RelativePanel.AlignVerticalCenterWith",
];

const WITH_PANEL_PROPS = [
  "RelativePanel.AlignLeftWithPanel",
  "RelativePanel.AlignRightWithPanel",
  "RelativePanel.AlignTopWithPanel",
  "RelativePanel.AlignBottomWithPanel",
  "RelativePanel.AlignHorizontalCenterWithPanel",
  "RelativePanel.AlignVerticalCenterWithPanel",
];

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

const elementItems = (items) => items.filter((i) => i.detail && i.detail.startsWith("(element)"));
const labels = (items) => items.map((i) => i.label).sort();
const boolItems = (items) => items.filter((i) => i.detail === "bool");

function summarize(items) {
  return JSON.stringify(items.slice(0, 40));
}

function rp(attr, extra = "") {
  return page(`<RelativePanel>
    <TextBox x:Name="AlphaBox" />
    <TextBox x:Name="BetaBox" />
    <TextBlock x:Name="GammaText" />
    <Button ${attr} />
  </RelativePanel>${extra}`);
}

async function serverElements(buffer) {
  return elementItems((await completionItemsAt(buffer)).items);
}

function requireElement(items, label, reason) {
  const hit = items.find((i) => i.label === label);
  assert.ok(hit, `${reason}; got ${summarize(items)}`);
  assert.strictEqual(hit.newText, label, `element item must insert the whole x:Name: ${JSON.stringify(hit)}`);
  assert.strictEqual(hit.kind, vscode.CompletionItemKind.Field, `element item must be Field kind: ${JSON.stringify(hit)}`);
  return hit;
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
    .map((i) => ({ label: i.label, detail: i.detail, newText: i.newText, kind: i.kind, sortText: i.sortText }))
    .sort((a, b) => `${a.detail}\0${a.label}`.localeCompare(`${b.detail}\0${b.label}`));
}

describe("WinUI XAML red-team 62 — RelativePanel alignment target completion", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("covers every element-reference RelativePanel attached property", async () => {
    for (const prop of TARGET_PROPS) {
      const items = await serverElements(rp(`${prop}="|"`));
      assert.deepStrictEqual(labels(items), ["AlphaBox", "BetaBox", "GammaText"], `${prop} element items`);
      for (const name of ["AlphaBox", "BetaBox", "GammaText"]) requireElement(items, name, `${prop} should offer ${name}`);
    }
  });

  it("keeps every boolean *WithPanel variant out of element-name completion and in bool completion", async () => {
    for (const prop of WITH_PANEL_PROPS) {
      const items = (await completionItemsAt(rp(`${prop}="|"`))).items;
      assert.deepStrictEqual(elementItems(items), [], `${prop} must not leak element-name items`);
      assert.deepStrictEqual(labels(boolItems(items)), ["False", "True"], `${prop} should still offer bool values; got ${summarize(boolItems(items))}`);
    }
  });

  it("server-filters prefixes exactly by x:Name prefix, case-insensitively", async () => {
    assert.deepStrictEqual(labels(await serverElements(rp('RelativePanel.RightOf="Alph|"'))), ["AlphaBox"]);
    assert.deepStrictEqual(labels(await serverElements(rp('RelativePanel.RightOf="alph|"'))), ["AlphaBox"]);
    assert.deepStrictEqual(labels(await serverElements(rp('RelativePanel.RightOf="Beta|"'))), ["BetaBox"]);
    assert.deepStrictEqual(labels(await serverElements(rp('RelativePanel.RightOf="zzz|"'))), []);
    assert.deepStrictEqual(labels(await serverElements(rp('RelativePanel.RightOf="|"'))), ["AlphaBox", "BetaBox", "GammaText"]);
  });

  it("documents whole-document enumeration and current-element self-inclusion", async () => {
    const buffer = page(`<StackPanel>
    <TextBox x:Name="OutsiderBox" />
    <RelativePanel>
      <TextBox x:Name="AlphaBox" />
      <Button x:Name="SelfButton" RelativePanel.RightOf="|" />
    </RelativePanel>
  </StackPanel>`);
    const items = await serverElements(buffer);
    assert.deepStrictEqual(labels(items), ["AlphaBox", "OutsiderBox", "SelfButton"]);
    requireElement(items, "OutsiderBox", "whole-document names should be offered");
    requireElement(items, "SelfButton", "the current element's own x:Name should not be excluded");
  });

  it("applies partial-value edits without duplication or leftover typed text", async () => {
    const probe = rp('RelativePanel.RightOf="Alph|"');
    const { clean, items } = await completionItemsAt(probe);
    const alpha = requireElement(elementItems(items), "AlphaBox", "expected AlphaBox for edit reconstruction");
    assert.deepStrictEqual(alpha.range, markerRange(probe), `range should cover opening quote through caret: ${JSON.stringify(alpha)}`);
    const fixed = applySingleEdit(clean, alpha);
    assert.ok(fixed.includes('RelativePanel.RightOf="AlphaBox"'), fixed);
    assert.ok(!fixed.includes('RelativePanel.RightOf="AlphAlphaBox"'), fixed);
    assert.ok(!fixed.includes('RelativePanel.RightOf="Alph"'), fixed);
  });

  it("does not leak into non-RelativePanel or near-miss dotted attributes", async () => {
    for (const [name, attr] of [
      ["made-up owner", 'Foo.RightOf="|"'],
      ["Canvas.Left", 'Canvas.Left="|"'],
      ["Grid.Row", 'Grid.Row="|"'],
      ["near suffix", 'RelativePanel.RightOfX="|"'],
      ["near member", 'RelativePanel.Right="|"'],
      ["panel boolean near target", 'RelativePanel.AlignLeftWithPanel="|"'],
    ]) {
      const items = await serverElements(rp(attr));
      assert.deepStrictEqual(items, [], `${name} must not get element-name items; got ${summarize(items)}`);
    }
  });

  it("matches RelativePanel attribute names with exact Ordinal casing only", async () => {
    for (const attr of [
      'relativepanel.rightof="|"',
      'RelativePanel.rightof="|"',
      'RELATIVEPANEL.RIGHTOF="|"',
    ]) {
      const items = await serverElements(rp(attr));
      assert.deepStrictEqual(items, [], `${attr} must not get exact-case RelativePanel element items; got ${summarize(items)}`);
    }
  });

  it("returns an empty element-name set when the document has no x:Name values", async () => {
    const items = await serverElements(page(`<RelativePanel>
    <TextBox />
    <TextBlock />
    <Button RelativePanel.RightOf="|" />
  </RelativePanel>`));
    assert.deepStrictEqual(items, [], `no named elements should mean no element-name items; got ${summarize(items)}`);
  });

  it("handles opening-quote, mid-name, and end-name caret positions", async () => {
    assert.deepStrictEqual(labels(await serverElements(rp('RelativePanel.RightOf="|"'))), ["AlphaBox", "BetaBox", "GammaText"]);
    assert.deepStrictEqual(labels(await serverElements(rp('RelativePanel.RightOf="Al|ph"'))), ["AlphaBox"]);
    assert.deepStrictEqual(labels(await serverElements(rp('RelativePanel.RightOf="Alpha|"'))), ["AlphaBox"]);
  });

  it("is deterministic for repeated identical requests", async () => {
    const probe = rp('RelativePanel.AlignVerticalCenterWith="|"');
    const first = await serverElements(probe);
    const second = await serverElements(probe);
    assert.deepStrictEqual(normalized(second), normalized(first));
  });

  it("does not throw or hang on malformed and unterminated edit states", async () => {
    for (const [name, buffer] of [
      ["unclosed RelativePanel", page('<RelativePanel><TextBox x:Name="AlphaBox" /><Button RelativePanel.RightOf="Alph|"')],
      ["unterminated attribute value", page('<RelativePanel><TextBox x:Name="AlphaBox" /><Button RelativePanel.RightOf="Alph|')],
      ["value at EOF", `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage">
  <RelativePanel><TextBox x:Name="AlphaBox" /><Button RelativePanel.RightOf="Alph|`],
      ["no closing tag", `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage">
  <RelativePanel>
    <TextBox x:Name="AlphaBox" />
    <Button RelativePanel.RightOf="|"`],
    ]) {
      const result = await completionItemsAt(buffer);
      assert.ok(Array.isArray(result.items), `${name}: completion request should return an item array`);
    }
  });

  it("suppresses element-name completions inside XML comments and CDATA", async () => {
    for (const [name, buffer] of [
      ["comment", page(`<RelativePanel>
    <TextBox x:Name="AlphaBox" />
    <!-- <Button RelativePanel.RightOf="|" /> -->
  </RelativePanel>`)],
      ["CDATA", page(`<RelativePanel>
    <TextBox x:Name="AlphaBox" />
    <![CDATA[ <Button RelativePanel.RightOf="|" /> ]]>
  </RelativePanel>`)],
    ]) {
      const items = await serverElements(buffer);
      assert.deepStrictEqual(items, [], `${name} should not get element-name items; got ${summarize(items)}`);
    }
  });

  it("does not disturb neighboring completion features", async () => {
    const sameButtonBool = (await completionItemsAt(page(`<RelativePanel>
    <TextBox x:Name="AlphaBox" />
    <Button RelativePanel.RightOf="AlphaBox" IsEnabled="|" />
  </RelativePanel>`))).items;
    assert.deepStrictEqual(labels(boolItems(sameButtonBool)), ["False", "True"], `ordinary bool completion should still work on the same Button`);
    assert.deepStrictEqual(elementItems(sameButtonBool), [], "IsEnabled must not inherit RelativePanel element-name mode");

    const storyboard = elementItems((await completionItemsAt(page(`<Grid>
    <Button x:Name="AlphaBox" />
    <VisualStateManager.VisualStateGroups>
      <VisualStateGroup>
        <VisualState>
          <Storyboard>
            <DoubleAnimation Storyboard.TargetName="|" Storyboard.TargetProperty="Opacity" To="0.8" Duration="0:0:0.1" />
          </Storyboard>
        </VisualState>
      </VisualStateGroup>
    </VisualStateManager.VisualStateGroups>
  </Grid>`))).items);
    requireElement(storyboard, "AlphaBox", "Storyboard.TargetName should still offer element names");

    const elementNames = await h.completionsAt(page("<But|"));
    assert.ok(elementNames.includes("Button"), `normal element-name completion should still include Button; got ${elementNames.slice(0, 30).join(", ")}`);
  });

  it("deduplicates duplicate x:Name declarations", async () => {
    const items = await serverElements(page(`<RelativePanel>
    <TextBox x:Name="DupeBox" />
    <Button x:Name="DupeBox" />
    <TextBlock x:Name="UniqueText" />
    <Button RelativePanel.RightOf="|" />
  </RelativePanel>`));
    assert.strictEqual(items.filter((i) => i.label === "DupeBox").length, 1, `DupeBox should appear once; got ${summarize(items)}`);
    requireElement(items, "UniqueText", "non-duplicate names should still be present");
  });
});
