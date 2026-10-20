"use strict";

// Contextual parent-container attached-property completion.

const assert = require("node:assert");
const vscode = require("vscode");
const h = require("./helper");

function page(inner) {
  return `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage">
  ${inner}
</Page>`;
}

const GRID_PROPS = ["Grid.Column", "Grid.ColumnSpan", "Grid.Row", "Grid.RowSpan"];
const CANVAS_PROPS = ["Canvas.Left", "Canvas.Top", "Canvas.ZIndex"];
const RELATIVE_PANEL_PROPS = [
  "RelativePanel.Above",
  "RelativePanel.AlignBottomWith",
  "RelativePanel.AlignBottomWithPanel",
  "RelativePanel.AlignHorizontalCenterWith",
  "RelativePanel.AlignHorizontalCenterWithPanel",
  "RelativePanel.AlignLeftWith",
  "RelativePanel.AlignLeftWithPanel",
  "RelativePanel.AlignRightWith",
  "RelativePanel.AlignRightWithPanel",
  "RelativePanel.AlignTopWith",
  "RelativePanel.AlignTopWithPanel",
  "RelativePanel.AlignVerticalCenterWith",
  "RelativePanel.AlignVerticalCenterWithPanel",
  "RelativePanel.Below",
  "RelativePanel.LeftOf",
  "RelativePanel.RightOf",
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
      // #2 attribute-name value snippet: VS Code exposes a SnippetString insertText + item.range (not item.textEdit) for snippet items, so fall back to item.range for the covered span.
      range: item.textEdit
        ? rangeShape(item.textEdit.range)
        : item.range
          ? rangeShape(item.range)
          : undefined,
    })),
  };
}

const attachedItems = (items) => items.filter((i) =>
  i.detail &&
  i.detail.startsWith("attached property") &&
  !i.label.startsWith("AutomationProperties."));
const ownItems = (items) => items.filter((i) => !(i.detail && i.detail.startsWith("attached property")));
const labels = (items) => items.map((i) => i.label).sort();
const gridChild = (attr) => page(`<Grid>
    <Button ${attr} />
  </Grid>`);

function summarize(items) {
  return JSON.stringify(items.slice(0, 40));
}

function assertAttachedShape(item, label) {
  assert.ok(item, `missing attached-property item ${label}`);
  assert.strictEqual(item.label, label);
  assert.strictEqual(item.kind, vscode.CompletionItemKind.Property, `${label} must be Property kind: ${JSON.stringify(item)}`);
  assert.ok(item.detail.startsWith("attached property"), `${label} must have attached-property detail: ${JSON.stringify(item)}`);
  assert.strictEqual(item.newText, `${label}="$0"`, `${label} must insert the whole qualified name with a ="$0" value snippet (VS parity)`);
  assert.ok(item.sortText && item.sortText.startsWith("2"), `${label} must sort in group 2: ${JSON.stringify(item)}`);
}

function assertExactAttached(items, expected, reason) {
  const got = labels(attachedItems(items));
  assert.deepStrictEqual(got, expected.slice().sort(), `${reason}; got ${summarize(attachedItems(items))}`);
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
    .map((i) => ({ label: i.label, detail: i.detail, newText: i.newText, kind: i.kind, sortText: i.sortText }))
    .sort((a, b) => `${a.detail}\0${a.label}`.localeCompare(`${b.detail}\0${b.label}`));
}

describe("WinUI XAML red-team 63 — container attached-property completion", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("offers exactly the four Grid attached properties on a Grid child with qualified item shape", async () => {
    const items = (await completionItemsAt(gridChild("|"))).items;
    assertExactAttached(items, GRID_PROPS, "Grid child attached-property set");
    for (const prop of GRID_PROPS) assertAttachedShape(attachedItems(items).find((i) => i.label === prop), prop);
  });

  it("offers exactly Canvas attached properties on a Canvas child and never leaks outer Grid props", async () => {
    const items = (await completionItemsAt(page(`<Grid>
    <Canvas>
      <Button |/>
    </Canvas>
  </Grid>`))).items;
    assertExactAttached(items, CANVAS_PROPS, "nested Canvas child must use the immediate Canvas container");
    assert.ok(!labels(attachedItems(items)).some((l) => l.startsWith("Grid.")), `Grid props leaked through Canvas: ${summarize(attachedItems(items))}`);
    for (const prop of CANVAS_PROPS) assertAttachedShape(attachedItems(items).find((i) => i.label === prop), prop);
  });

  it("offers the full RelativePanel attached-property name set on a RelativePanel child", async () => {
    const items = (await completionItemsAt(page(`<RelativePanel>
    <Button |/>
  </RelativePanel>`))).items;
    assertExactAttached(items, RELATIVE_PANEL_PROPS, "RelativePanel child attached-property set");
    for (const prop of ["RelativePanel.Above", "RelativePanel.AlignTopWithPanel", "RelativePanel.RightOf"]) {
      assertAttachedShape(attachedItems(items).find((i) => i.label === prop), prop);
    }
  });

  it("keeps Button own members alongside attached properties and ranks attached properties after them", async () => {
    const items = (await completionItemsAt(gridChild("|"))).items;
    for (const name of ["Content", "IsEnabled"]) {
      const hit = ownItems(items).find((i) => i.label === name);
      assert.ok(hit, `${name} should still be offered as a non-attached own member; got ${summarize(items)}`);
      assert.ok(hit.sortText && /^[01]/.test(hit.sortText), `${name} should sort in own-member group 0/1: ${JSON.stringify(hit)}`);
    }
    const row = attachedItems(items).find((i) => i.label === "Grid.Row");
    const isEnabled = ownItems(items).find((i) => i.label === "IsEnabled");
    assert.ok(row.sortText > isEnabled.sortText, `attached properties should sort after own members: ${JSON.stringify({ row, isEnabled })}`);
  });

  it("honors immediate-container precision for StackPanel and Border containers with no attached props", async () => {
    for (const [name, buffer] of [
      ["StackPanel nested in Grid", page(`<Grid>
    <StackPanel>
      <Button |/>
    </StackPanel>
  </Grid>`)],
      ["Border nested in Grid", page(`<Grid>
    <Border>
      <Button |/>
    </Border>
  </Grid>`)],
    ]) {
      const items = attachedItems((await completionItemsAt(buffer)).items);
      assert.deepStrictEqual(items, [], `${name} must not inherit Grid attached props; got ${summarize(items)}`);
    }
  });

  it("uses only the immediate owner when an unusual control container really has attached props", async () => {
    const items = attachedItems((await completionItemsAt(page(`<Grid>
    <Button>
      <TextBlock |/>
    </Button>
  </Grid>`))).items);
    assert.deepStrictEqual(labels(items), ["Button.IsTemplateFocusTarget", "Button.IsTemplateKeyTipTarget"], `Button's own attached props are allowed, but Grid must not leak; got ${summarize(items)}`);
  });

  it("does not treat a Page direct child as root: it uses Page's immediate attached props only", async () => {
    const items = attachedItems((await completionItemsAt(page(`<Button |/>`))).items);
    assert.deepStrictEqual(labels(items), ["Page.IsTemplateFocusTarget", "Page.IsTemplateKeyTipTarget"], `Page direct child should not be root and must not leak other owners; got ${summarize(items)}`);
  });

  it("filters proactive Grid props by member name, qualified owner name, case-insensitively, and garbage", async () => {
    const cases = [
      ["empty", "|", GRID_PROPS],
      ["member Ro", "Ro|", ["Grid.Row", "Grid.RowSpan"]],
      ["member ROW", "ROW|", ["Grid.Row", "Grid.RowSpan"]],
      ["qualified Grid", "Grid|", GRID_PROPS],
      ["qualified lowercase grid", "grid|", GRID_PROPS],
      ["garbage", "Zzz|", []],
    ];
    for (const [name, attr, expected] of cases) {
      const items = (await completionItemsAt(gridChild(attr))).items;
      assertExactAttached(items, expected, `filter case ${name}`);
    }
  });

  it("uses the pre-existing dotted attached-property path without duplicates or conflict", async () => {
    const all = attachedItems((await completionItemsAt(gridChild("Grid.|"))).items);
    assert.deepStrictEqual(labels(all), GRID_PROPS, `Grid.| should offer each Grid attached property exactly once; got ${summarize(all)}`);
    const rows = attachedItems((await completionItemsAt(gridChild("Grid.Ro|"))).items);
    assert.deepStrictEqual(labels(rows), ["Grid.Row", "Grid.RowSpan"], `Grid.Ro| should filter in the dotted branch; got ${summarize(rows)}`);
  });

  it("dedupes already-present attached attributes without suppressing siblings", async () => {
    const items = attachedItems((await completionItemsAt(gridChild('Grid.Row="0" |'))).items);
    assert.ok(!labels(items).includes("Grid.Row"), `already-set Grid.Row must not be re-offered; got ${summarize(items)}`);
    for (const prop of ["Grid.Column", "Grid.ColumnSpan", "Grid.RowSpan"]) {
      assert.ok(labels(items).includes(prop), `${prop} should still be offered; got ${summarize(items)}`);
    }
  });

  it("applies proactive and dotted edits over the replace range without corrupting neighbors", async () => {
    const proactiveProbe = gridChild('Ro| IsEnabled="True" Content="OK"');
    const proactive = await completionItemsAt(proactiveProbe);
    const row = attachedItems(proactive.items).find((i) => i.label === "Grid.Row");
    const proactiveFixed = applySingleEdit(proactive.clean, row);
    assert.ok(proactiveFixed.includes('<Button Grid.Row="$0" IsEnabled="True" Content="OK" />'), proactiveFixed);
    assert.ok(!proactiveFixed.includes("RoGrid.Row"), proactiveFixed);
    assert.ok(!proactiveFixed.includes("<Button Ro "), proactiveFixed);

    const dottedProbe = gridChild('Grid.Ro| IsEnabled="True"');
    const dotted = await completionItemsAt(dottedProbe);
    const dottedRow = attachedItems(dotted.items).find((i) => i.label === "Grid.Row");
    const dottedFixed = applySingleEdit(dotted.clean, dottedRow);
    assert.ok(dottedFixed.includes('<Button Grid.Row="$0" IsEnabled="True" />'), dottedFixed);
    assert.ok(!dottedFixed.includes("Grid.RoGrid.Row"), dottedFixed);
  });

  it("does not offer attached properties on the root Page start tag", async () => {
    const buffer = `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage"
    |>
</Page>`;
    const items = attachedItems((await completionItemsAt(buffer)).items);
    assert.deepStrictEqual(items, [], `document root must not have a container; got ${summarize(items)}`);
  });

  it("documents property-element skip over-offer inside Grid.RowDefinitions without crashing", async () => {
    const items = attachedItems((await completionItemsAt(page(`<Grid>
    <Grid.RowDefinitions>
      <RowDefinition |/>
    </Grid.RowDefinitions>
  </Grid>`))).items);
    assert.ok(labels(items).includes("Grid.Row"), `documented over-offer should include Grid.Row; got ${summarize(items)}`);
    assert.ok(labels(items).includes("Grid.Column"), `skipped property element should resolve the Grid container; got ${summarize(items)}`);
  });

  it("is deterministic for repeated identical attached-property requests", async () => {
    const probe = page(`<Grid>
    <Canvas>
      <Button |/>
      <Button Canvas.Left="1" />
    </Canvas>
  </Grid>`);
    const first = attachedItems((await completionItemsAt(probe)).items);
    const second = attachedItems((await completionItemsAt(probe)).items);
    assert.deepStrictEqual(normalized(second), normalized(first));
  });

  it("does not surface server attached-property completions in XML comments or CDATA", async () => {
    for (const [name, buffer] of [
      ["comment", page(`<Grid>
    <!-- <Button |/> -->
  </Grid>`)],
      ["CDATA", page(`<Grid>
    <![CDATA[ <Button |/> ]]>
  </Grid>`)],
    ]) {
      const items = attachedItems((await completionItemsAt(buffer)).items);
      assert.deepStrictEqual(items, [], `${name} should not get attached-property items; got ${summarize(items)}`);
    }
  });

  it("returns completion arrays for malformed and unterminated edit states", async () => {
    for (const [name, buffer] of [
      ["unterminated Button in Grid", page("<Grid><Button |")],
      ["missing Grid close", `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage">
  <Grid><Button |`],
      ["partial attr at EOF", `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage">
  <Grid><Button Ro|`],
    ]) {
      const result = await completionItemsAt(buffer);
      assert.ok(Array.isArray(result.items), `${name}: completion request should return an item array`);
    }
  });
});
