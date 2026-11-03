"use strict";

// Storyboard.TargetProperty parenthesized (Owner.Property) qualifiers. Server-only fields distinguish results from VS Code word suggestions.

const assert = require("node:assert");
const vscode = require("vscode");
const h = require("./helper");

function page(inner) {
  return `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage">
  ${inner}
</Page>`;
}

function storyboard(tp, targetAttr = 'Storyboard.TargetName="Probe"') {
  return page([
    "<StackPanel>",
    '  <Border x:Name="Probe" />',
    "  <Storyboard>",
    `    <DoubleAnimation ${targetAttr} Storyboard.TargetProperty="${tp}" />`,
    "  </Storyboard>",
    "</StackPanel>",
  ].join("\n  "));
}

function setterTarget(target) {
  return page([
    "<VisualStateManager.VisualStateGroups>",
    '  <VisualStateGroup x:Name="CommonStates">',
    '    <VisualState x:Name="Normal">',
    "      <VisualState.Setters>",
    `        <Setter Target="${target}" Value="1" />`,
    "      </VisualState.Setters>",
    "    </VisualState>",
    "  </VisualStateGroup>",
    "</VisualStateManager.VisualStateGroups>",
  ].join("\n  "));
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

function summarize(items) {
  return JSON.stringify(items.map((i) => ({
    label: i.label,
    detail: i.detail,
    newText: i.newText,
  })).slice(0, 80));
}

const serverItems = (items) => items.filter((i) => i.detail);

function findServer(items, label, detailPattern, note) {
  const hit = items.find((i) => i.label === label && i.detail && (!detailPattern || detailPattern.test(i.detail)));
  assert.ok(hit, `${note}: expected server item ${label}/${detailPattern}; got ${summarize(items)}`);
  return hit;
}

function assertServerLacks(items, label, note) {
  const hits = serverItems(items).filter((i) => i.label === label);
  assert.deepStrictEqual(hits, [], `${note}: must not offer server item ${label}; got ${summarize(hits)}`);
}

function assertNoServerItems(items, note) {
  assert.deepStrictEqual(serverItems(items), [], `${note}: expected no server completion items; got ${summarize(serverItems(items))}`);
}

function assertNoDuplicateServerLabels(items, note) {
  const counts = new Map();
  for (const item of serverItems(items)) counts.set(item.label, (counts.get(item.label) || 0) + 1);
  const dupes = [...counts].filter(([, n]) => n > 1);
  assert.deepStrictEqual(dupes, [], `${note}: duplicate server labels; got ${summarize(serverItems(items))}`);
}

function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function offsetOf(starts, line, character) {
  assert.ok(line < starts.length, `line ${line} should exist`);
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
  return serverItems(items)
    .map((i) => ({ label: i.label, detail: i.detail, newText: i.newText }))
    .sort((a, b) => `${a.detail}\0${a.label}\0${a.newText}`.localeCompare(`${b.detail}\0${b.label}\0${b.newText}`));
}

describe("WinUI XAML — red-team 77 (Storyboard.TargetProperty parenthesized qualifiers)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("red-team 77 offers Canvas attached properties inside an explicit owner group", async () => {
    const items = (await completionItemsAt(storyboard("(Canvas.|"))).items;
    findServer(items, "Left", /^attached property/, "Canvas explicit owner should offer Canvas.Left");
    findServer(items, "Top", /^attached property/, "Canvas explicit owner should offer Canvas.Top");
    assertServerLacks(items, "GreetingText", "Canvas explicit owner must not leak page x:Bind members");
    assertNoDuplicateServerLabels(items, "Canvas explicit owner");
  });

  it("red-team 77 offers UIElement instance properties and does not require attached-property detail", async () => {
    const items = (await completionItemsAt(storyboard("(UIElement.|"))).items;
    findServer(items, "Opacity", /^property\s*:/i, "UIElement explicit owner should offer Opacity");
    findServer(items, "RenderTransform", /^property\s*:/i, "UIElement explicit owner should offer RenderTransform");
    assertServerLacks(items, "GreetingText", "UIElement explicit owner must not leak SmokePage");
  });

  it("red-team 77 filters Canvas attached properties by prefix without widening to unrelated members", async () => {
    const items = (await completionItemsAt(storyboard("(Canvas.Le|"))).items;
    findServer(items, "Left", /^attached property/, "Canvas.Le should offer Left");
    assertServerLacks(items, "Top", "Canvas.Le should not offer Top");
    assertServerLacks(items, "GreetingText", "Canvas.Le must not leak SmokePage");
  });

  it("red-team 77 filters UIElement instance properties case-insensitively", async () => {
    const items = (await completionItemsAt(storyboard("(UIElement.opac|"))).items;
    findServer(items, "Opacity", /^property\s*:/i, "UIElement.opac should offer Opacity");
    assertServerLacks(items, "RenderTransform", "UIElement.opac should not offer RenderTransform");
    assertServerLacks(items, "GreetingText", "UIElement.opac must not leak SmokePage");
  });

  it("red-team 77 returns no server items for a resolvable owner with an impossible member prefix", async () => {
    await completionItemsAt(storyboard("(Canvas.|"));
    const items = (await completionItemsAt(storyboard("(Canvas.zzz|"))).items;
    assertNoServerItems(items, "Canvas.zzz should decline rather than falling back to target/page members");
  });

  it("red-team 77 returns no server items while the owner token is still being typed", async () => {
    await completionItemsAt(storyboard("(UIElement.|"));
    for (const [name, probe] of [["empty owner", "(|"], ["partial owner", "(Canv|"]]) {
      const items = (await completionItemsAt(storyboard(probe))).items;
      assertNoServerItems(items, `${name} should not leak target members`);
    }
  });

  it("red-team 77 returns no server items for unknown default and prefixed owners", async () => {
    await completionItemsAt(storyboard("(Canvas.|"));
    for (const [name, probe] of [["unknown owner", "(NoSuchOwner.|"], ["unknown prefix", "(nope:Foo.|"]]) {
      const items = (await completionItemsAt(storyboard(probe))).items;
      assertNoServerItems(items, `${name} should not crash or garbage-complete`);
    }
  });

  it("red-team 77 completes a chained transform tail in the second parenthesized group", async () => {
    const items = (await completionItemsAt(storyboard("(UIElement.RenderTransform).(CompositeTransform.Trans|"))).items;
    findServer(items, "TranslateX", /^property\s*:/i, "CompositeTransform.Trans should offer TranslateX");
    findServer(items, "TranslateY", /^property\s*:/i, "CompositeTransform.Trans should offer TranslateY");
    assertServerLacks(items, "Opacity", "second group must not jump back to UIElement or target Border");
    assertServerLacks(items, "GreetingText", "second group must not leak SmokePage");
  });

  it("red-team 77 completes the first group of a chain while it is still being authored", async () => {
    const items = (await completionItemsAt(storyboard("(UIElement.RenderTrans|"))).items;
    findServer(items, "RenderTransform", /^property\s*:/i, "UIElement.RenderTrans should offer RenderTransform");
    assertServerLacks(items, "Opacity", "filtered first group should not offer nonmatching UIElement members");
    assertServerLacks(items, "GreetingText", "filtered first group must not leak SmokePage");
  });

  it("red-team 77 documents closed-group-plus-dot behavior as empty and crash-safe", async () => {
    await completionItemsAt(storyboard("Opac|"));
    const items = (await completionItemsAt(storyboard("(Canvas.Left).|"))).items;
    assertNoServerItems(items, "closed group followed by dot currently falls through to the simple path walker and yields no server items");
  });

  it("red-team 77 resolves prefixed local owners independently of the Border target", async () => {
    const items = (await completionItemsAt(storyboard("(local:SmokePage.Opac|"))).items;
    findServer(items, "Opacity", /^property\s*:/i, "local:SmokePage owner should resolve and expose inherited Page/UIElement properties");
    assertServerLacks(items, "Child", "local:SmokePage owner must not root at the Border target");
  });

  it("red-team 77 treats lowercase framework owner tokens as unresolved", async () => {
    await completionItemsAt(storyboard("(Canvas.|"));
    const items = (await completionItemsAt(storyboard("(canvas.|"))).items;
    assertNoServerItems(items, "lowercase canvas owner should be case-sensitive and unresolved");
  });

  it("red-team 77 applies completion edits without duplicating a partially typed attached member", async () => {
    const probe = storyboard("(Canvas.Le|");
    const result = await completionItemsAt(probe);
    const left = findServer(result.items, "Left", /^attached property/, "Canvas.Le edit test");
    assert.strictEqual(left.newText, "(Canvas.Left", `attached completion should preserve the owner prefix exactly: ${JSON.stringify(left)}`);
    const edited = applySingleEdit(result.clean, left);
    assert.ok(edited.includes('Storyboard.TargetProperty="(Canvas.Left"'), edited);
    assert.ok(!edited.includes("(Canvas.LeLeft") && !edited.includes("(Canvas.Leftft"), edited);
  });

  it("red-team 77 applies completion edits without duplicating a partially typed chained member", async () => {
    const probe = storyboard("(UIElement.RenderTransform).(CompositeTransform.Trans|");
    const result = await completionItemsAt(probe);
    const tx = findServer(result.items, "TranslateX", /^property\s*:/i, "CompositeTransform.Trans edit test");
    assert.strictEqual(tx.newText, "(UIElement.RenderTransform).(CompositeTransform.TranslateX", `chained completion should preserve both group prefixes: ${JSON.stringify(tx)}`);
    const edited = applySingleEdit(result.clean, tx);
    assert.ok(edited.includes('Storyboard.TargetProperty="(UIElement.RenderTransform).(CompositeTransform.TranslateX"'), edited);
    assert.ok(!edited.includes("TransTranslateX") && !edited.includes("TranslateXlate"), edited);
  });

  it("red-team 77 keeps simple non-parenthesized Storyboard.TargetProperty fallback alive", async () => {
    for (const [name, probe] of [["empty", "|"], ["filtered", "Opac|"]]) {
      const items = (await completionItemsAt(storyboard(probe))).items;
      findServer(items, "Opacity", /^property\s*:/i, `${name} simple path should root at Border target`);
      assertServerLacks(items, "GreetingText", `${name} simple path must not leak SmokePage`);
    }
  });

  it("red-team 77 falls back safely after a closed group with no dot", async () => {
    const items = (await completionItemsAt(storyboard("(Canvas.Left)|"))).items;
    assert.ok(Array.isArray(items), "closed group without dot should return an array");
    assertServerLacks(items, "GreetingText", "closed group without dot must not leak SmokePage");
  });

  it("red-team 77 is crash-safe on malformed parenthesized paths", async () => {
    const cases = [
      ["unterminated first member", "(Canvas.Left|"],
      ["double open", "((Canvas.|"],
      ["double dot", "(Canvas..|"],
      ["empty owner before dot", "(.|"],
      ["empty second group", "(Canvas.Left).(|"],
    ];
    for (const [name, probe] of cases) {
      const items = (await completionItemsAt(storyboard(probe))).items;
      assert.ok(Array.isArray(items), `${name}: completion should return an array`);
    }
  });

  it("red-team 77 does not bleed parenthesized Storyboard grammar into VisualState Setter.Target", async () => {
    const items = (await completionItemsAt(setterTarget("(Canvas.Left)|"))).items;
    assert.ok(Array.isArray(items), "Setter.Target parenthesized text should not crash");
    assertServerLacks(items, "Left", "Setter.Target must not use Storyboard parenthesized owner completion");
  });

  it("red-team 77 completes explicit owners even when Storyboard.TargetName is missing", async () => {
    const items = (await completionItemsAt(storyboard("(Canvas.|", ""))).items;
    findServer(items, "Left", /^attached property/, "explicit Canvas owner should not depend on Storyboard.TargetName");
    findServer(items, "Top", /^attached property/, "explicit Canvas owner should not depend on Storyboard.TargetName");
    assertServerLacks(items, "GreetingText", "missing TargetName explicit owner must not leak SmokePage");
  });

  it("red-team 77 is deterministic for repeated identical parenthesized requests", async () => {
    const probe = storyboard("(UIElement.|");
    const first = normalized((await completionItemsAt(probe)).items);
    const second = normalized((await completionItemsAt(probe)).items);
    assert.deepStrictEqual(second, first, `parenthesized completion should be deterministic; first=${JSON.stringify(first)} second=${JSON.stringify(second)}`);
  });
});
