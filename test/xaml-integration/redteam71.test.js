"use strict";

const assert = require("node:assert");
const vscode = require("vscode");
const h = require("./helper");

const AUTO_DETAIL = "GridLength — size to content";
const STAR_DETAIL = "GridLength — star sizing (one share of the remaining space)";
const EXPECTED_GRID_LABELS = ["*", "Auto"];

function page(inner) {
  return `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage">
  ${inner}
</Page>`;
}

function caretPosition(text) {
  const i = text.indexOf("|");
  assert.ok(i >= 0, "probe text must contain a | caret marker");
  const before = text.slice(0, i);
  const nl = before.lastIndexOf("\n");
  const line = (before.match(/\n/g) || []).length;
  const character = before.length - (nl + 1);
  return {
    clean: text.slice(0, i) + text.slice(i + 1),
    position: new vscode.Position(line, character),
  };
}

function labelOf(item) {
  return typeof item.label === "string" ? item.label : item.label.label;
}

function newTextOf(item) {
  return item.textEdit
    ? item.textEdit.newText
    : typeof item.insertText === "string"
      ? item.insertText
      : item.insertText && item.insertText.value !== undefined
        ? item.insertText.value
        : undefined;
}

function replacingRangeOf(item) {
  if (!item.textEdit) return undefined;
  return item.textEdit.range || item.textEdit.replacing;
}

async function rawCompletionItemsAt(bufferWithCaret) {
  const { clean, position } = caretPosition(bufferWithCaret);
  await h.setBuffer(clean);
  const list = await vscode.commands.executeCommand(
    "vscode.executeCompletionItemProvider",
    h.getDoc().uri,
    position
  );
  return {
    clean,
    items: (list && list.items ? list.items : []).map((item) => ({
      raw: item,
      label: labelOf(item),
      detail: item.detail,
      newText: newTextOf(item),
      kind: item.kind,
      filterText: item.filterText,
      sortText: item.sortText,
    })),
  };
}

const gridItems = (items) => items.filter((i) => (i.detail || "").startsWith("GridLength"));
const gridLabels = (items) => gridItems(items).map((i) => i.label).sort();
const summarize = (items) => JSON.stringify(gridItems(items).map((i) => ({
  label: i.label,
  detail: i.detail,
  newText: i.newText,
  kind: i.kind,
  filterText: i.filterText,
  sortText: i.sortText,
})));

async function assertGridLabels(buffer, expected, reason) {
  const { items } = await rawCompletionItemsAt(buffer);
  assert.deepStrictEqual(gridLabels(items), expected, `${reason}; buffer=${JSON.stringify(buffer)} gridItems=${summarize(items)}`);
  return items;
}

// NOTE: vscode.executeCompletionItemProvider NORMALIZES the item — when filterText/sortText EQUAL the
// label, VS Code omits them from the returned item (they read back undefined here even though the server
// sets FilterText = SortText = token, as PROVEN on the raw LSP wire and locked by the stdio smoke). This is
// a harness-API limitation (documented round 64), NOT a product gap — so the harness shape asserts exactly
// the fields VS Code preserves: label, detail, newText, kind.
function assertExactGridShapes(items, reason) {
  const actual = gridItems(items)
    .map((i) => ({
      label: i.label,
      detail: i.detail,
      newText: i.newText,
      kind: i.kind,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  assert.deepStrictEqual(actual, [
    {
      label: "*",
      detail: STAR_DETAIL,
      newText: "*",
      kind: vscode.CompletionItemKind.Value,
    },
    {
      label: "Auto",
      detail: AUTO_DETAIL,
      newText: "Auto",
      kind: vscode.CompletionItemKind.Value,
    },
  ], `${reason}: exact GridLength item shape`);
}

async function applyGridCompletion(buffer, label) {
  const { items } = await rawCompletionItemsAt(buffer);
  const item = gridItems(items).find((i) => i.label === label);
  assert.ok(item, `expected GridLength ${label}; buffer=${JSON.stringify(buffer)} gridItems=${summarize(items)}`);
  const range = replacingRangeOf(item.raw);
  assert.ok(range, `expected ${label} to carry a TextEdit range; item=${JSON.stringify(item)}`);
  const doc = h.getDoc();
  const actual = doc.getText();
  const start = doc.offsetAt(range.start);
  const end = doc.offsetAt(range.end);
  return actual.slice(0, start) + item.newText + actual.slice(end);
}

describe("WinUI XAML red-team 71 (GridLength value completion adversarial)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("red-team 71 RowDefinition.Height exact GridLength item set and full shape", async () => {
    const items = await assertGridLabels(
      page('<Grid>\n    <Grid.RowDefinitions>\n      <RowDefinition Height="|" />\n    </Grid.RowDefinitions>\n  </Grid>'),
      EXPECTED_GRID_LABELS,
      "RowDefinition.Height should offer exactly Auto and *"
    );
    assertExactGridShapes(items, "RowDefinition.Height");
  });

  it("red-team 71 ColumnDefinition.Width exact GridLength item set and full shape", async () => {
    const items = await assertGridLabels(
      page('<Grid>\n    <Grid.ColumnDefinitions>\n      <ColumnDefinition Width="|" />\n    </Grid.ColumnDefinitions>\n  </Grid>'),
      EXPECTED_GRID_LABELS,
      "ColumnDefinition.Width should offer exactly Auto and *"
    );
    assertExactGridShapes(items, "ColumnDefinition.Width");
  });

  it("red-team 71 applying Auto replaces only the typed Height value and preserves neighbors", async () => {
    const applied = await applyGridCompletion(
      page('<Grid><Grid.RowDefinitions><RowDefinition MinHeight="1" Height="A|" MaxHeight="9" /></Grid.RowDefinitions></Grid>'),
      "Auto"
    );
    assert.ok(applied.includes('<RowDefinition MinHeight="1" Height="Auto" MaxHeight="9" />'), `Auto edit corrupted neighboring text or left partials; got=${JSON.stringify(applied)}`);
    assert.ok(!applied.includes('Height="AAuto"') && !applied.includes('HeightAuto'), `Auto edit must not insert at caret only; got=${JSON.stringify(applied)}`);
  });

  it("red-team 71 applying star preserves quotes and neighbors", async () => {
    const applied = await applyGridCompletion(
      page('<Grid><Grid.ColumnDefinitions><ColumnDefinition MinWidth="1" Width="|" MaxWidth="9" /></Grid.ColumnDefinitions></Grid>'),
      "*"
    );
    assert.ok(applied.includes('<ColumnDefinition MinWidth="1" Width="*" MaxWidth="9" />'), `* edit corrupted neighboring text or quotes; got=${JSON.stringify(applied)}`);
    assert.ok(!applied.includes('Width**') && !applied.includes('Width*='), `* edit must not be mangled; got=${JSON.stringify(applied)}`);
  });

  it("red-team 71 prefix filtering is ordinal-ignore-case and token-specific", async () => {
    const cases = [
      ["empty", 'Height="|"', EXPECTED_GRID_LABELS],
      ["A", 'Height="A|"', ["Auto"]],
      ["a", 'Height="a|"', ["Auto"]],
      ["au", 'Height="au|"', ["Auto"]],
      ["AUTO", 'Height="AUTO|"', ["Auto"]],
      ["star", 'Height="*|"', ["*"]],
    ];
    for (const [name, attr, expected] of cases) {
      await assertGridLabels(
        page(`<Grid><Grid.RowDefinitions><RowDefinition ${attr} /></Grid.RowDefinitions></Grid>`),
        expected,
        `prefix ${name}`
      );
    }
  });

  it("red-team 71 non-matching prefixes yield zero GridLength-detail items", async () => {
    for (const value of ["z|", "2|", "xyz|", "Auto |"]) {
      await assertGridLabels(
        page(`<Grid><Grid.RowDefinitions><RowDefinition Height="${value}" /></Grid.RowDefinitions></Grid>`),
        [],
        `bad prefix ${value}`
      );
    }
  });

  it("red-team 71 FrameworkElement double Width and Height do not leak GridLength keywords", async () => {
    for (const buffer of [
      page('<Button Width="|" />'),
      page('<Button Height="|" />'),
      page('<Grid Width="|" />'),
      page('<TextBlock Height="|" />'),
    ]) {
      await assertGridLabels(buffer, [], "double Width/Height must not offer GridLength");
    }
  });

  it("red-team 71 unrelated string, double, and enum attributes do not leak GridLength keywords", async () => {
    for (const buffer of [
      page('<Button Content="|" />'),
      page('<Button Opacity="|" />'),
      page('<Button HorizontalAlignment="|" />'),
    ]) {
      await assertGridLabels(buffer, [], "unrelated attribute value must not offer GridLength");
    }
  });

  it("red-team 71 bool and enum value completion still work and carry no GridLength details", async () => {
    const boolItems = (await rawCompletionItemsAt(page('<Button IsEnabled="|" />'))).items;
    assert.ok(boolItems.map((i) => i.label).includes("True"), `expected True bool completion; got=${JSON.stringify(boolItems.map((i) => i.label))}`);
    assert.ok(boolItems.map((i) => i.label).includes("False"), `expected False bool completion; got=${JSON.stringify(boolItems.map((i) => i.label))}`);
    assert.deepStrictEqual(gridLabels(boolItems), [], `bool completion must not leak GridLength; got=${summarize(boolItems)}`);

    const enumItems = (await rawCompletionItemsAt(page('<Button HorizontalAlignment="|" />'))).items;
    for (const label of ["Left", "Center", "Right", "Stretch"]) {
      assert.ok(enumItems.map((i) => i.label).includes(label), `expected HorizontalAlignment.${label}; got=${JSON.stringify(enumItems.map((i) => i.label))}`);
    }
    assert.deepStrictEqual(gridLabels(enumItems), [], `enum completion must not leak GridLength; got=${summarize(enumItems)}`);
  });

  it("red-team 71 opening-quote, mid-token, and end-token caret positions are stable", async () => {
    await assertGridLabels(
      page('<Grid><Grid.RowDefinitions><RowDefinition Height="|" /></Grid.RowDefinitions></Grid>'),
      EXPECTED_GRID_LABELS,
      "opening quote"
    );
    await assertGridLabels(
      page('<Grid><Grid.RowDefinitions><RowDefinition Height="A|uto" /></Grid.RowDefinitions></Grid>'),
      ["Auto"],
      "mid token"
    );
    await assertGridLabels(
      page('<Grid><Grid.RowDefinitions><RowDefinition Height="Auto|" /></Grid.RowDefinitions></Grid>'),
      ["Auto"],
      "end token"
    );
  });

  it("red-team 71 repeated identical request is deterministic", async () => {
    const buffer = page('<Grid><Grid.ColumnDefinitions><ColumnDefinition Width="|" /></Grid.ColumnDefinitions></Grid>');
    const first = gridItems((await rawCompletionItemsAt(buffer)).items).map((i) => [i.label, i.detail, i.newText, i.kind, i.filterText, i.sortText]).sort();
    const second = gridItems((await rawCompletionItemsAt(buffer)).items).map((i) => [i.label, i.detail, i.newText, i.kind, i.filterText, i.sortText]).sort();
    assert.deepStrictEqual(second, first, `identical completion request should be deterministic; first=${JSON.stringify(first)} second=${JSON.stringify(second)}`);
  });

  it("red-team 71 malformed unterminated GridLength markup returns an array and does not throw", async () => {
    const { items } = await rawCompletionItemsAt(page('<Grid><Grid.RowDefinitions><RowDefinition Height="|'));
    assert.ok(Array.isArray(items), `malformed completion should return an array; got=${typeof items}`);
  });

  it("red-team 71 self-closed and open RowDefinition elements both resolve Height as GridLength", async () => {
    await assertGridLabels(
      page('<Grid><Grid.RowDefinitions><RowDefinition Height="|" /></Grid.RowDefinitions></Grid>'),
      EXPECTED_GRID_LABELS,
      "self-closed RowDefinition"
    );
    await assertGridLabels(
      page('<Grid><Grid.RowDefinitions><RowDefinition Height="|"></RowDefinition></Grid.RowDefinitions></Grid>'),
      EXPECTED_GRID_LABELS,
      "open RowDefinition"
    );
  });

  it("red-team 71 bare RowDefinition outside Grid.RowDefinitions still resolves Height by element type", async () => {
    await assertGridLabels(
      page('<RowDefinition Height="|" />'),
      EXPECTED_GRID_LABELS,
      "bare RowDefinition.Height"
    );
  });

  it("red-team 71 attached int/double lookalikes do not match GridLength by name accident", async () => {
    for (const buffer of [
      page('<Grid><Button Grid.RowSpan="|" /></Grid>'),
      page('<Canvas><Button Canvas.Left="|" /></Canvas>'),
    ]) {
      await assertGridLabels(buffer, [], "attached non-GridLength value must not offer GridLength");
    }
  });

  it("red-team 71 RowDefinition MinHeight and MaxHeight are double, only Height is GridLength", async () => {
    for (const attr of ["MinHeight", "MaxHeight"]) {
      await assertGridLabels(
        page(`<Grid><Grid.RowDefinitions><RowDefinition ${attr}="|" /></Grid.RowDefinitions></Grid>`),
        [],
        `${attr} should be double, not GridLength`
      );
    }
    await assertGridLabels(
      page('<Grid><Grid.RowDefinitions><RowDefinition Height="|" /></Grid.RowDefinitions></Grid>'),
      EXPECTED_GRID_LABELS,
      "control Height probe"
    );
  });

  it("red-team 71 ColumnDefinition MinWidth and MaxWidth are double, only Width is GridLength", async () => {
    for (const attr of ["MinWidth", "MaxWidth"]) {
      await assertGridLabels(
        page(`<Grid><Grid.ColumnDefinitions><ColumnDefinition ${attr}="|" /></Grid.ColumnDefinitions></Grid>`),
        [],
        `${attr} should be double, not GridLength`
      );
    }
    await assertGridLabels(
      page('<Grid><Grid.ColumnDefinitions><ColumnDefinition Width="|" /></Grid.ColumnDefinitions></Grid>'),
      EXPECTED_GRID_LABELS,
      "control Width probe"
    );
  });
});
