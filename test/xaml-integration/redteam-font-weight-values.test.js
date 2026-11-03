"use strict";

const assert = require("node:assert");
const vscode = require("vscode");
const h = require("./helper");

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
    })),
  };
}

const EXPECTED_WEIGHT_NAMES = [
  "Thin", "ExtraLight", "Light", "SemiLight", "Normal", "Medium",
  "SemiBold", "Bold", "ExtraBold", "Black", "ExtraBlack",
].sort();

const weightItems = (items) => items.filter((i) => i.detail === "font weight");
const weightLabels = (items) => weightItems(items).map((i) => i.label).sort();
const summarizeWeights = (items) => JSON.stringify(weightItems(items).map((i) => ({
  label: i.label,
  detail: i.detail,
  newText: i.newText,
  kind: i.kind,
})));

async function assertExactWeightSet(buffer, reason) {
  const { items } = await rawCompletionItemsAt(buffer);
  const weights = weightItems(items);
  assert.deepStrictEqual(weightLabels(items), EXPECTED_WEIGHT_NAMES, `${reason}: expected exactly the 11 WinUI FontWeights; got ${summarizeWeights(items)}`);
  for (const item of weights) {
    assert.strictEqual(item.kind, vscode.CompletionItemKind.Value, `${reason}: ${item.label} kind should be Value; got ${item.kind}`);
    assert.strictEqual(item.detail, "font weight", `${reason}: ${item.label} should use generic detail`);
    assert.strictEqual(item.newText, item.label, `${reason}: ${item.label} should replace with the bare name; got ${JSON.stringify(item.newText)}`);
  }
  return items;
}

async function assertNoWeights(buffer, reason) {
  const { items } = await rawCompletionItemsAt(buffer);
  assert.deepStrictEqual(weightLabels(items), [], `${reason}: must not offer FontWeight names; got ${summarizeWeights(items)}`);
  return items;
}

async function applyWeightCompletion(buffer, label) {
  const { items } = await rawCompletionItemsAt(buffer);
  const item = weightItems(items).find((i) => i.label === label);
  assert.ok(item, `expected FontWeight ${label}; got ${summarizeWeights(items)}`);
  const range = replacingRangeOf(item.raw);
  assert.ok(range, `expected ${label} to carry a TextEdit range; item=${JSON.stringify(item)}`);
  const doc = h.getDoc();
  const actual = doc.getText();
  const start = doc.offsetAt(range.start);
  const end = doc.offsetAt(range.end);
  return {
    text: actual.slice(0, start) + item.newText + actual.slice(end),
    replaced: actual.slice(start, end),
    item,
  };
}

describe("WinUI XAML red-team 73 (FontWeight named-value completion adversarial)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("red-team 73 TextBlock.FontWeight exposes exactly the 11 WinUI weights with exact details, newText, and kind", async () => {
    await assertExactWeightSet(page('<TextBlock FontWeight="|" />'), "TextBlock.FontWeight");
  });

  it("red-team 73 Control subclasses resolve inherited FontWeight exactly like TextBlock", async () => {
    for (const [name, inner] of [
      ["Button.FontWeight", '<Button FontWeight="|" />'],
      ["CheckBox.FontWeight", '<CheckBox FontWeight="|" />'],
    ]) {
      await assertExactWeightSet(page(inner), name);
    }
  });

  it("red-team 73 prefix filtering is StartsWith and OrdinalIgnoreCase", async () => {
    for (const [value, expected] of [
      ["|", EXPECTED_WEIGHT_NAMES],
      ["Ex|", ["ExtraBlack", "ExtraBold", "ExtraLight"]],
      ["ex|", ["ExtraBlack", "ExtraBold", "ExtraLight"]],
      ["EX|", ["ExtraBlack", "ExtraBold", "ExtraLight"]],
      ["semi|", ["SemiBold", "SemiLight"]],
      ["SemiB|", ["SemiBold"]],
      ["NoSuchWeight|", []],
      ["7|", []],
    ]) {
      const items = (await rawCompletionItemsAt(page(`<TextBlock FontWeight="${value}" />`))).items;
      assert.deepStrictEqual(weightLabels(items), expected.slice().sort(), `prefix ${value}: got ${summarizeWeights(items)}`);
    }
  });

  it("red-team 73 accepted completion reconstructs end-token and mid-token values without duplicated suffixes", async () => {
    const endApplied = await applyWeightCompletion(page('<TextBlock FontWeight="Sem|" Tag="tail" />'), "SemiBold");
    assert.strictEqual(endApplied.replaced, "Sem", `end-token range should replace the typed token; got ${JSON.stringify(endApplied.replaced)}`);
    assert.ok(endApplied.text.includes('<TextBlock FontWeight="SemiBold" Tag="tail" />'), `end-token edit corrupted text; got=${JSON.stringify(endApplied.text)}`);
    assert.ok(!endApplied.text.includes('SemSemiBold') && !endApplied.text.includes('SemiBoldSem'), `end-token edit left partials; got=${JSON.stringify(endApplied.text)}`);

    const midApplied = await applyWeightCompletion(page('<TextBlock FontWeight="Sem|iBold" Tag="tail" />'), "SemiBold");
    assert.strictEqual(midApplied.replaced, "SemiBold", `mid-token range must replace the whole value token; got ${JSON.stringify(midApplied.replaced)}`);
    assert.ok(midApplied.text.includes('<TextBlock FontWeight="SemiBold" Tag="tail" />'), `mid-token edit corrupted text; got=${JSON.stringify(midApplied.text)}`);
    assert.ok(!midApplied.text.includes('SemiBoldiBold') && !midApplied.text.includes('SemSemiBold'), `mid-token edit left partials; got=${JSON.stringify(midApplied.text)}`);
  });

  it("red-team 73 opening-quote, mid-token, and end-token carets return appropriate stable candidates", async () => {
    assert.deepStrictEqual(weightLabels((await rawCompletionItemsAt(page('<TextBlock FontWeight="|" />'))).items), EXPECTED_WEIGHT_NAMES, "opening quote should show the full set");
    assert.ok(weightLabels((await rawCompletionItemsAt(page('<TextBlock FontWeight="Sem|iBold" />'))).items).includes("SemiBold"), "mid-token should include the exact whole-token candidate");
    assert.deepStrictEqual(weightLabels((await rawCompletionItemsAt(page('<TextBlock FontWeight="SemiBold|" />'))).items), ["SemiBold"], "end-token should use the whole token");
  });

  it("red-team 73 non-FontWeight attribute values never leak named weights", async () => {
    const negatives = [
      ["Button.Width double", '<Button Width="|" />'],
      ["Button.Height double", '<Button Height="|" />'],
      ["Button.Opacity double", '<Button Opacity="|" />'],
      ["Button.MinHeight double", '<Button MinHeight="|" />'],
      ["Button.Visibility enum", '<Button Visibility="|" />'],
      ["Button.HorizontalAlignment enum", '<Button HorizontalAlignment="|" />'],
      ["TextBlock.Text string", '<TextBlock Text="|" />'],
      ["TextBlock.Tag object/string-like", '<TextBlock Tag="|" />'],
      ["Button.Content object/string-like", '<Button Content="|" />'],
      ["Button.IsEnabled bool", '<Button IsEnabled="|" />'],
    ];
    for (const [name, inner] of negatives) {
      await assertNoWeights(page(inner), name);
    }
  });

  it("red-team 73 bool completion remains True/False and not FontWeight names", async () => {
    const items = await assertNoWeights(page('<Button IsEnabled="|" />'), "IsEnabled boolean");
    const labels = items.map((i) => i.label);
    assert.ok(labels.includes("True"), `IsEnabled should still offer True; got ${JSON.stringify(labels.slice(0, 40))}`);
    assert.ok(labels.includes("False"), `IsEnabled should still offer False; got ${JSON.stringify(labels.slice(0, 40))}`);
  });

  it("red-team 73 markup-extension FontWeight values route away from named weights", async () => {
    for (const [name, inner] of [
      ["StaticResource", '<TextBlock FontWeight="{StaticResource |}" />'],
      ["x:Bind", '<TextBlock FontWeight="{x:Bind |}" />'],
      ["Binding", '<TextBlock FontWeight="{Binding |}" />'],
    ]) {
      await assertNoWeights(page(inner), `${name} inside FontWeight`);
    }
  });

  it("red-team 73 numeric literals do not match named weights", async () => {
    for (const value of ["7|", "70|", "700|"]) {
      await assertNoWeights(page(`<TextBlock FontWeight="${value}" />`), `numeric literal ${value}`);
    }
  });

  it("red-team 73 identical requests are deterministic", async () => {
    const buffer = page('<TextBlock FontWeight="Ex|" />');
    const shape = (items) => weightItems(items).map((i) => [i.label, i.detail, i.newText, i.kind]).sort();
    const first = shape((await rawCompletionItemsAt(buffer)).items);
    const second = shape((await rawCompletionItemsAt(buffer)).items);
    assert.deepStrictEqual(second, first, `identical completion request should be deterministic; first=${JSON.stringify(first)} second=${JSON.stringify(second)}`);
  });

  it("red-team 73 comments and CDATA suppress named-weight completions", async () => {
    await assertNoWeights(page('<!-- <TextBlock FontWeight="|" /> -->'), "comment body");
    await assertNoWeights(page('<Grid><![CDATA[<TextBlock FontWeight="|" />]]></Grid>'), "CDATA body");
  });

  it("red-team 73 malformed and unterminated markup returns arrays and does not throw", async () => {
    const probes = [
      page('<TextBlock FontWeight="|'),
      page('<TextBlock FontWeight="{StaticResource |" />'),
      page('<TextBlock FontWeight="{x:Bind |" />'),
      `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  <TextBlock FontWeight="|"`,
      `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  <Button FontWeight="Sem|`,
    ];
    for (const probe of probes) {
      const { items } = await rawCompletionItemsAt(probe);
      assert.ok(Array.isArray(items), `malformed completion should return an array; got=${typeof items}`);
    }
  });

  it("red-team 73 Style Setter.Value completes FontWeight like a direct attribute (found+fixed gap)", async () => {
    // Setter.Value uses the same scalar completion path as direct attributes.
    const styleBuf = (setter) =>
      `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  <Page.Resources>\n    <Style TargetType="TextBlock">\n      ${setter}\n    </Style>\n  </Page.Resources>\n</Page>`;

    await assertExactWeightSet(styleBuf('<Setter Property="FontWeight" Value="|" />'), "Setter.Value FontWeight");

    // Mid-token acceptance in a setter replaces the whole token.
    const mid = await applyWeightCompletion(styleBuf('<Setter Property="FontWeight" Value="Sem|iBold" />'), "SemiBold");
    assert.strictEqual(mid.replaced, "SemiBold", `Setter.Value mid-token must replace the whole value token; got ${JSON.stringify(mid.replaced)}`);
    assert.ok(mid.text.includes('Value="SemiBold"') && !mid.text.includes("SemiBoldiBold"), `Setter.Value mid-token edit corrupted; got ${JSON.stringify(mid.text)}`);

    // Negative: a double-typed setter value (Opacity) must still offer no weights.
    await assertNoWeights(styleBuf('<Setter Property="Opacity" Value="|" />'), "Setter.Value Opacity double");
  });

  it.skip("red-team 73 user-defined different-namespace FontWeight collision requires a fixture type not present here", async () => {
    // The fixture has no custom non-framework FontWeight property. This needs a dedicated fixture type before the namespace-chain guard can be integration-tested.
  });
});
