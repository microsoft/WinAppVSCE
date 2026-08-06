"use strict";

const assert = require("node:assert");
const h = require("./helper");

const TOOLKIT_NS = "CommunityToolkit.WinUI.Controls";
const TOOLKIT_XMLNS = `using:${TOOLKIT_NS}`;
const DI_NS = "Microsoft.Extensions.DependencyInjection";

function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
}

function pageWith(extraXmlns, inner) {
  return `<Page ${h.NS}\n    ${extraXmlns}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
}

function lineCharToOffset(text, pos) {
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < pos.line; i++) offset += lines[i].length + 1;
  return offset + pos.character;
}

function clean(buffer) {
  return buffer.replaceAll("|", "");
}

function assertZeroWidthRootXmlnsEdit(buffer, edit, expectedText) {
  assert.deepStrictEqual(edit.range.start, edit.range.end, "xmlns edit must be zero-width");
  assert.strictEqual(edit.newText, expectedText, "xmlns edit text");
  const noCaret = clean(buffer);
  const insertAt = lineCharToOffset(noCaret, edit.range.start);
  const rootOpenEnd = noCaret.indexOf(">");
  assert.ok(insertAt > 0 && insertAt < rootOpenEnd, `xmlns edit must land inside the root start tag; offset ${insertAt}, root end ${rootOpenEnd}`);
  assert.ok(
    noCaret.slice(0, insertAt).includes('xmlns:local="using:SmokeFixture"'),
    "xmlns edit should be after existing root xmlns declarations"
  );
}

function applyAdditionalEdits(text, edits) {
  let result = text;
  for (const edit of [...edits].sort((a, b) => lineCharToOffset(result, b.range.start) - lineCharToOffset(result, a.range.start))) {
    const start = lineCharToOffset(result, edit.range.start);
    const end = lineCharToOffset(result, edit.range.end);
    result = result.slice(0, start) + edit.newText + result.slice(end);
  }
  return result;
}

function assertAppliedSettEdit(buffer, item, expectedPrefix) {
  assert.strictEqual(item.additionalTextEdits.length, 1, "generated-prefix completion should carry exactly one xmlns edit");
  assertZeroWidthRootXmlnsEdit(buffer, item.additionalTextEdits[0], ` xmlns:${expectedPrefix}="${TOOLKIT_XMLNS}"`);
  const withoutCaret = clean(buffer);
  const afterXmlns = applyAdditionalEdits(withoutCaret, item.additionalTextEdits);
  const applied = afterXmlns.replace("<Sett", `<${item.newText}`);
  assert.ok(applied.includes(`<${expectedPrefix}:SettingsCard`), `element edit should produce prefixed SettingsCard; got ${applied}`);
  assert.ok(applied.includes(`xmlns:${expectedPrefix}="${TOOLKIT_XMLNS}"`), `root xmlns should be present; got ${applied}`);
  assert.ok(!applied.includes("SettSettingsCard"), `completion must replace the partial, not append to it; got ${applied}`);
  assert.strictEqual((applied.match(new RegExp(`xmlns:${expectedPrefix}=`, "g")) || []).length, 1, "injected xmlns must not duplicate");
}

function toolkitItems(items) {
  return items.filter((i) => (i.detail || "").includes(TOOLKIT_NS) || /^(controls\d*|toolkit|ctk|odd_prefix|z):Settings/.test(i.newText || ""));
}

function diItems(items) {
  return items.filter((i) => (i.detail || "").includes(DI_NS) || /Service(Collection|Provider|Descriptor)/.test(i.newText || ""));
}

describe("WinUI XAML — gap #4 red-team", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("collision-suffixes a generated prefix when controls is already bound to another namespace and applies safely", async () => {
    const buffer = pageWith('xmlns:controls="using:Something.Else"', "<Grid><Sett|</Grid>");
    const items = await h.completionEditsAt(buffer);
    const card = items.find((i) => i.newText === "controls2:SettingsCard");
    assert.ok(card, `expected controls2:SettingsCard; got ${JSON.stringify(toolkitItems(items))}`);
    assert.ok(!items.some((i) => i.newText === "controls:SettingsCard" && (i.detail || "").includes(TOOLKIT_NS)), "must not clash with existing controls prefix");
    assert.strictEqual(card.detail, `${TOOLKIT_NS} (adds xmlns:controls2)`);
    assertAppliedSettEdit(buffer, card, "controls2");
  });

  it("reuses odd and duplicate declared prefixes with no xmlns injection", async () => {
    const odd = await h.completionEditsAt(pageWith(`xmlns:odd_prefix="${TOOLKIT_XMLNS}"`, "<Grid><Sett|</Grid>"));
    const oddCard = odd.find((i) => i.newText === "odd_prefix:SettingsCard");
    assert.ok(oddCard, `expected odd_prefix reuse; got ${JSON.stringify(toolkitItems(odd))}`);
    assert.strictEqual(oddCard.detail, TOOLKIT_NS);
    assert.deepStrictEqual(oddCard.additionalTextEdits, []);
    assert.ok(!odd.some((i) => i.newText === "controls:SettingsCard"), "declared odd prefix should suppress generated prefix");

    const dup = await h.completionEditsAt(pageWith(`xmlns:ctk="${TOOLKIT_XMLNS}"\n    xmlns:z="${TOOLKIT_XMLNS}"`, "<Grid><Sett|</Grid>"));
    const reused = toolkitItems(dup).filter((i) => i.newText === "ctk:SettingsCard" || i.newText === "z:SettingsCard");
    assert.strictEqual(reused.length, 1, `same namespace declared twice should produce one reused item; got ${JSON.stringify(toolkitItems(dup))}`);
    assert.strictEqual(reused[0].detail, TOOLKIT_NS);
    assert.deepStrictEqual(reused[0].additionalTextEdits, []);
  });

  it("filters SettingsCard out of typed collection property elements while a same-buffer panel child positive works", async () => {
    const rowBuffer = page("<Grid>\n    <Grid.RowDefinitions><Sett|</Grid.RowDefinitions>\n    <StackPanel><SettingsC</StackPanel>\n  </Grid>");
    const rowItems = await h.completionEditsAt(rowBuffer);
    assert.ok(!toolkitItems(rowItems).some((i) => i.newText && i.newText.endsWith(":SettingsCard")), `SettingsCard is not a RowDefinition; got ${JSON.stringify(toolkitItems(rowItems))}`);

    const panelItems = await h.completionEditsAt(page("<Grid>\n    <Grid.RowDefinitions><RowDefinition /></Grid.RowDefinitions>\n    <StackPanel><Sett|</StackPanel>\n  </Grid>"));
    assert.ok(panelItems.some((i) => i.newText === "controls:SettingsCard" && (i.detail || "").includes(TOOLKIT_NS)), "positive control: panel child should offer SettingsCard");
  });

  it("does not double-offer framework controls as prefixed third-party elements", async () => {
    for (const partial of ["But", "Grid", "TextBl"]) {
      const items = await h.completionEditsAt(page(`<StackPanel><${partial}|</StackPanel>`));
      assert.ok(items.some((i) => i.label && String(i.label).startsWith(partial[0])), `positive control: completion should not be globally empty for ${partial}`);
      const leaked = items.filter((i) => /^(controls\d*|toolkit):/.test(i.newText || "") && /Microsoft\.UI\.Xaml/.test(i.detail || ""));
      assert.strictEqual(leaked.length, 0, `${partial} must not be offered as a prefixed third-party framework item; got ${JSON.stringify(leaked)}`);
    }
  });

  it("excludes Microsoft.Extensions.DependencyInjection non-DependencyObject types with a same-buffer toolkit positive", async () => {
    for (const partial of ["Serv", "ServiceP", "ServiceD"]) {
      const probe = page(`<Grid><Sett__CARET__</Grid>\n  <Grid><${partial}__NEG__</Grid>`);
      const positive = await h.completionEditsAt(probe.replace("__CARET__", "|").replace("__NEG__", ""));
      assert.ok(positive.some((i) => i.newText === "controls:SettingsCard" && (i.detail || "").includes(TOOLKIT_NS)), "positive control: toolkit item should still be discoverable from this project");
      const items = await h.completionEditsAt(probe.replace("__CARET__", "").replace("__NEG__", "|"));
      assert.strictEqual(diItems(items).length, 0, `${partial} must not offer DI service types; got ${JSON.stringify(diItems(items))}`);
    }
  });

  it("does not offer generated-prefix toolkit items for rootless, prefixed, comment, or CDATA contexts", async () => {
    for (const buffer of [
      "<Sett|",
      page("<Grid><x:Sett|</Grid>"),
      page("<Grid><local:Sett|</Grid>"),
      page("<Grid><!-- <Sett| --><Sett</Grid>"),
      page("<Grid><![CDATA[ <Sett| ]]><Sett</Grid>"),
    ]) {
      const items = await h.completionEditsAt(buffer);
      assert.strictEqual(toolkitItems(items).length, 0, `toolkit item must be suppressed in this context; got ${JSON.stringify(toolkitItems(items))}`);
    }
    const positive = await h.completionEditsAt(page("<Grid><Sett|</Grid>"));
    assert.ok(positive.some((i) => i.newText === "controls:SettingsCard"), "positive control: normal unprefixed child should offer SettingsCard");
  });

  it("is crash-safe on broken markup around the caret", async () => {
    const items = await h.completionEditsAt(page("<Grid><Border><Sett|"));
    assert.ok(Array.isArray(items), "broken markup should return an array, not throw/crash");
  });

  it("keeps partial filtering precise for SettingsC, SettingsE, and broad S", async () => {
    const card = toolkitItems(await h.completionEditsAt(page("<Grid><SettingsC|</Grid>"))).map((i) => i.newText);
    assert.ok(card.includes("controls:SettingsCard"), `SettingsC should include SettingsCard; got ${JSON.stringify(card)}`);
    assert.ok(!card.includes("controls:SettingsExpander"), `SettingsC must not include SettingsExpander; got ${JSON.stringify(card)}`);

    const expander = toolkitItems(await h.completionEditsAt(page("<Grid><SettingsE|</Grid>"))).map((i) => i.newText);
    assert.ok(expander.includes("controls:SettingsExpander"), `SettingsE should include SettingsExpander; got ${JSON.stringify(expander)}`);
    assert.ok(!expander.includes("controls:SettingsCard"), `SettingsE must not include SettingsCard; got ${JSON.stringify(expander)}`);

    const broad = toolkitItems(await h.completionEditsAt(page("<Grid><S|</Grid>"))).map((i) => i.newText);
    assert.ok(broad.includes("controls:SettingsCard") && broad.includes("controls:SettingsExpander"), `S should include both toolkit controls; got ${JSON.stringify(broad)}`);
  });

  it("is deterministic for identical server-only completion items", async () => {
    const buffer = page("<Grid><Sett|</Grid>");
    const normalize = (items) => toolkitItems(items).map((i) => ({
      newText: i.newText,
      detail: i.detail,
      additionalTextEdits: i.additionalTextEdits,
    })).sort((a, b) => String(a.newText).localeCompare(String(b.newText)));
    const first = normalize(await h.completionEditsAt(buffer));
    const second = normalize(await h.completionEditsAt(buffer));
    assert.deepStrictEqual(second, first, `server-only toolkit items changed between identical requests: ${JSON.stringify({ first, second })}`);
  });

  it("applies the generated-prefix edit safely with several root declarations and x:Class", async () => {
    const buffer = page("<Grid><Sett|</Grid>");
    const items = await h.completionEditsAt(buffer);
    const card = items.find((i) => i.newText === "controls:SettingsCard");
    assert.ok(card, `expected controls:SettingsCard; got ${JSON.stringify(toolkitItems(items))}`);
    assertAppliedSettEdit(buffer, card, "controls");
  });
});
