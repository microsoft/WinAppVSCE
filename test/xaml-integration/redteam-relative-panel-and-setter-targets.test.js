"use strict";

const assert = require("node:assert");
const h = require("./helper");

const RP_ATTRS = [
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

const RP_WITH_PANEL_ATTRS = [
  "RelativePanel.AlignLeftWithPanel",
  "RelativePanel.AlignRightWithPanel",
  "RelativePanel.AlignTopWithPanel",
  "RelativePanel.AlignBottomWithPanel",
  "RelativePanel.AlignHorizontalCenterWithPanel",
  "RelativePanel.AlignVerticalCenterWithPanel",
];

function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n${inner}\n</Page>`;
}

function clean(text) {
  return text.replace("|", "").replace("[|]", "");
}

function declLine(buffer, name) {
  return clean(buffer).split("\n").findIndex((l) => l.includes(`x:Name="${name}"`));
}

function sig(items) {
  return items.map((r) => `${r.line}:${r.character}:${r.text}`).sort();
}

function assertAllEdits(edits, oldName, newName, expectedCount, why) {
  assert.strictEqual(edits.length, expectedCount, `${why}: expected ${expectedCount} edits; got ${JSON.stringify(edits)}`);
  assert.ok(edits.every((e) => e.text === oldName), `${why}: every edit must cover exactly ${oldName}; got ${JSON.stringify(edits)}`);
  assert.ok(edits.every((e) => e.newText === newName), `${why}: every edit must write exactly ${newName}; got ${JSON.stringify(edits)}`);
}

function assertNoEdits(res, why) {
  if ((res.edits || []).length !== 0) {
    assert.fail(`${why}: expected no rename edits; got ${JSON.stringify(res)}`);
  }
}

describe("WinUI XAML — red-team 80 (RelativePanel + Setter.Target references)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("resolves every RelativePanel element-reference attribute with F12 from value to declaration", async () => {
    for (const attr of RP_ATTRS) {
      const buf = page(
        `  <RelativePanel>\n` +
        `    <TextBox x:Name="Anchor" />\n` +
        `    <Button ${attr}="An|chor" />\n` +
        `  </RelativePanel>`
      );
      const defs = await h.definitionsAt(buf);
      const line = declLine(buf, "Anchor");
      assert.ok(defs.some((d) => d.line === line), `${attr}: expected F12 to line ${line}; got ${JSON.stringify(defs)}`);

      const hover = await h.hoverAt(buf);
      assert.strictEqual(hover, '```csharp\n(element) TextBox "Anchor"\n```', `${attr}: unexpected hover markdown`);
    }
  });

  it("finds, highlights, and renames the exact combined set for all ten RelativePanel attrs from declaration and usage carets", async () => {
    const usageLines = RP_ATTRS.map((attr) => `    <Button ${attr}="Anchor" />`).join("\n");
    const declBuf = page(`  <RelativePanel>\n    <TextBox x:Name="An|chor" />\n${usageLines}\n  </RelativePanel>`);
    const usageBuf = declBuf.replace('x:Name="An|chor"', 'x:Name="Anchor"').replace('RelativePanel.RightOf="Anchor"', 'RelativePanel.RightOf="An|chor"');

    for (const [label, buf] of [["declaration", declBuf], ["usage", usageBuf]]) {
      const refs = await h.referencesAt(buf);
      assert.strictEqual(refs.length, 11, `${label}: expected decl + 10 usages; got ${JSON.stringify(refs)}`);
      assert.ok(refs.every((r) => r.text === "Anchor"), `${label}: references must cover only Anchor; got ${JSON.stringify(refs)}`);

      const highlights = (await h.highlightsAt(buf)).filter((x) => x.text === "Anchor");
      assert.strictEqual(highlights.length, 11, `${label}: expected 11 Anchor highlights; got ${JSON.stringify(highlights)}`);
      assert.ok(highlights.some((x) => x.kind === 2), `${label}: expected a Write highlight for x:Name; got ${JSON.stringify(highlights)}`);
      assert.strictEqual(highlights.filter((x) => x.kind === 1).length, 10, `${label}: expected ten Read highlights; got ${JSON.stringify(highlights)}`);
      assert.deepStrictEqual(sig(highlights), sig(refs), `${label}: highlight set must match reference set`);

      const res = await h.renameAt(buf, "Mooring");
      assert.ok(!res.error, `${label}: rename should not error; got ${JSON.stringify(res)}`);
      assertAllEdits(res.edits, "Anchor", "Mooring", 11, label);
      assert.deepStrictEqual(sig(res.edits), sig(refs), `${label}: rename edit set must match reference set`);
    }
  });

  it("does not treat RelativePanel *WithPanel booleans as element references, even when an x:Name is literally True", async () => {
    for (const attr of RP_WITH_PANEL_ATTRS) {
      const positive = page(
        `  <RelativePanel>\n` +
        `    <TextBox x:Name="Anchor" />\n` +
        `    <TextBox x:Name="True" />\n` +
        `    <Button RelativePanel.RightOf="An|chor" ${attr}="True" />\n` +
        `  </RelativePanel>`
      );
      assert.ok((await h.definitionsAt(positive)).some((d) => d.line === declLine(positive, "Anchor")), `${attr}: positive control did not resolve Anchor`);

      const boolCaret = positive.replace('RelativePanel.RightOf="An|chor"', 'RelativePanel.RightOf="Anchor"').replace(`${attr}="True"`, `${attr}="Tr|ue"`);
      assert.deepStrictEqual(await h.definitionsAt(boolCaret), [], `${attr}: bool value must not F12 to x:Name=True`);
      assert.ok(!(await h.referencesAt(boolCaret)).some((r) => r.text === "True" || r.text === "Anchor"), `${attr}: bool value must not return element refs`);
      assertNoEdits(await h.renameAt(boolCaret, "FalseName"), `${attr}: bool value`);
      assert.ok(!(await h.highlightsAt(boolCaret)).some((x) => x.text === "True" && x.kind === 1), `${attr}: bool value must not be a Read highlight`);
    }
  });

  it("renames Setter.Target element segments exactly from declaration and Target carets without touching property or Value", async () => {
    const body =
      `  <Border x:Name="Hero" />\n` +
      `  <VisualStateManager.VisualStateGroups>\n` +
      `    <VisualStateGroup>\n` +
      `      <VisualState>\n` +
      `        <VisualState.Setters>\n` +
      `          <Setter Target="Hero.Background" Value="Red" />\n` +
      `          <Setter Target="Hero.Opacity" Value="0.5" />\n` +
      `        </VisualState.Setters>\n` +
      `      </VisualState>\n` +
      `    </VisualStateGroup>\n` +
      `  </VisualStateManager.VisualStateGroups>`;

    for (const [label, buf] of [
      ["declaration", page(body.replace('x:Name="Hero"', 'x:Name="He|ro"'))],
      ["Target segment", page(body.replace('Target="Hero.Background"', 'Target="He|ro.Background"'))],
    ]) {
      const res = await h.renameAt(buf, "Banner");
      assert.ok(!res.error, `${label}: rename should not error; got ${JSON.stringify(res)}`);
      assertAllEdits(res.edits, "Hero", "Banner", 3, label);
      assert.ok(!res.edits.some((e) => e.text.includes(".") || e.newText.includes(".")), `${label}: property tail was included/corrupted: ${JSON.stringify(res.edits)}`);
      assert.ok(!res.edits.some((e) => e.text === "Red"), `${label}: Value attr must be untouched: ${JSON.stringify(res.edits)}`);
    }
  });

  it("rejects Setter.Target .Property tail carets for F12, references, highlights, and rename while same-buffer element segment resolves", async () => {
    const positive = page(`  <Border x:Name="Hero" />\n  <Setter Target="He|ro.Background" Value="Red" />`);
    assert.ok((await h.definitionsAt(positive)).some((d) => d.line === declLine(positive, "Hero")), "positive Target segment did not resolve");

    const tail = positive.replace("He|ro.Background", "Hero.Backgr|ound");
    assert.deepStrictEqual(await h.definitionsAt(tail), [], "property tail must not F12 to Hero");
    assert.ok(!(await h.referencesAt(tail)).some((r) => r.text === "Hero"), "property tail must not return Hero references");
    assert.ok(!(await h.highlightsAt(tail)).some((x) => x.text === "Hero"), "property tail must not highlight Hero");
    assertNoEdits(await h.renameAt(tail, "Banner"), "property tail");
  });

  it("handles whitespace in Setter.Target by covering only the trimmed element token and preserving the property tail", async () => {
    const buf = page(`  <Border x:Name="Hero" />\n  <Setter Target="  He|ro . Background" Value="Red" />`);
    const refs = await h.referencesAt(buf);
    assert.strictEqual(refs.filter((r) => r.text === "Hero").length, 2, `expected decl + spaced Target segment; got ${JSON.stringify(refs)}`);
    const res = await h.renameAt(buf, "Banner");
    assert.ok(!res.error, `rename should not error; got ${JSON.stringify(res)}`);
    assertAllEdits(res.edits, "Hero", "Banner", 2, "spaced Setter.Target");
    assert.ok(!res.edits.some((e) => e.text !== "Hero" || e.newText !== "Banner"), `spaced Target property tail/whitespace corrupted: ${JSON.stringify(res.edits)}`);
  });

  it("is benign for Setter.Target without a dot: no crash, and any edit covers only the element token", async () => {
    const buf = page(`  <Border x:Name="Solo" />\n  <Setter Target="So|lo" Value="Red" />`);
    const refs = await h.referencesAt(buf);
    assert.ok(Array.isArray(refs), `references must return an array; got ${JSON.stringify(refs)}`);
    const res = await h.renameAt(buf, "RenamedSolo");
    if (!res.error && (res.edits || []).length > 0) {
      assertAllEdits(res.edits, "Solo", "RenamedSolo", 2, "dotless Setter.Target");
    }
  });

  it("guards Setter.Target parsing by value shape and owner element", async () => {
    const positive = page(`  <Border x:Name="Hero" />\n  <Setter Target="He|ro.Background" Value="Red" />`);
    assert.ok((await h.definitionsAt(positive)).some((d) => d.line === declLine(positive, "Hero")), "positive control did not resolve Hero");

    for (const [label, buf] of [
      ["markup-valued Target", page(`  <Border x:Name="Hero" />\n  <Setter Target="{Binding |X}" Value="Red" />`)],
      ["non-Setter Target attr", page(`  <Border x:Name="Hero" />\n  <Foo Target="He|ro.Background" />`)],
      ["prefixed local:Setter", page(`  <Border x:Name="Hero" />\n  <local:Setter Target="He|ro.Background" Value="Red" />`)],
    ]) {
      assert.deepStrictEqual(await h.definitionsAt(buf), [], `${label}: must not F12`);
      assert.ok(!(await h.referencesAt(buf)).some((r) => r.text === "Hero"), `${label}: must not return Hero references`);
      assertNoEdits(await h.renameAt(buf, "Banner"), label);
    }
  });

  it("matches names and attribute local names case-sensitively for Setter.Target and RelativePanel", async () => {
    const positive = page(`  <RelativePanel>\n    <Border x:Name="Hero" />\n    <Setter Target="He|ro.Background" Value="Red" />\n    <Button RelativePanel.RightOf="Hero" />\n  </RelativePanel>`);
    assert.strictEqual((await h.referencesAt(positive)).filter((r) => r.text === "Hero").length, 3, "positive case-control should find decl + Setter + RelativePanel");

    for (const [label, buf] of [
      ["wrong-case Setter.Target value", page(`  <Border x:Name="Hero" />\n  <Setter Target="he|ro.Background" Value="Red" />`)],
      ["wrong-case RelativePanel value", page(`  <RelativePanel>\n    <Border x:Name="Hero" />\n    <Button RelativePanel.RightOf="he|ro" />\n  </RelativePanel>`)],
      ["wrong-case Setter attr local name", page(`  <Border x:Name="Hero" />\n  <Setter target="He|ro.Background" Value="Red" />`)],
      ["wrong-case RelativePanel attr local name", page(`  <RelativePanel>\n    <Border x:Name="Hero" />\n    <Button RelativePanel.rightOf="He|ro" />\n  </RelativePanel>`)],
    ]) {
      assert.deepStrictEqual(await h.definitionsAt(buf), [], `${label}: must not resolve cross-case`);
      assert.ok(!(await h.referencesAt(buf)).some((r) => r.text === "Hero"), `${label}: must not fold into Hero refs`);
      const res = await h.renameAt(buf, "Banner");
      const line = declLine(buf, "Hero");
      assert.ok(
        !res.error && (res.edits || []).length > 0
          ? !res.edits.some((e) => e.line === line)
          : true,
        `${label}: wrong-case rename must not edit the x:Name declaration; got ${JSON.stringify(res)}`
      );
    }
  });

  it("resolves forward references before declarations and renames mixed RelativePanel plus Setter.Target sets together", async () => {
    const buf = page(
      `  <RelativePanel>\n` +
      `    <Setter Target="Forward.Background" Value="Red" />\n` +
      `    <Button RelativePanel.AlignBottomWith="Forward" />\n` +
      `    <Border x:Name="For|ward" />\n` +
      `  </RelativePanel>`
    );
    const refs = await h.referencesAt(buf);
    assert.strictEqual(refs.length, 3, `expected decl + Setter + RelativePanel forward refs; got ${JSON.stringify(refs)}`);
    assert.ok(refs.every((r) => r.text === "Forward"), `forward refs must cover only Forward; got ${JSON.stringify(refs)}`);
    const res = await h.renameAt(buf, "After");
    assert.ok(!res.error, `rename should not error; got ${JSON.stringify(res)}`);
    assertAllEdits(res.edits, "Forward", "After", 3, "forward mixed refs");
  });

  it("returns deterministic references, highlights, and rename edits for repeated identical requests", async () => {
    const buf = page(`  <RelativePanel>\n    <Border x:Name="Mix" />\n    <Setter Target="Mi|x.Background" Value="Red" />\n    <Button RelativePanel.LeftOf="Mix" />\n  </RelativePanel>`);
    const r1 = await h.referencesAt(buf);
    const r2 = await h.referencesAt(buf);
    assert.deepStrictEqual(sig(r2), sig(r1), `references changed between identical requests: ${JSON.stringify({ r1, r2 })}`);

    const h1 = (await h.highlightsAt(buf)).filter((x) => x.text === "Mix");
    const h2 = (await h.highlightsAt(buf)).filter((x) => x.text === "Mix");
    assert.deepStrictEqual(sig(h2), sig(h1), `highlights changed between identical requests: ${JSON.stringify({ h1, h2 })}`);

    const e1 = await h.renameAt(buf, "Blend");
    const e2 = await h.renameAt(buf, "Blend");
    assert.ok(!e1.error && !e2.error, `rename should not error: ${JSON.stringify({ e1, e2 })}`);
    assert.deepStrictEqual(sig(e2.edits), sig(e1.edits), `rename edits changed between identical requests: ${JSON.stringify({ e1, e2 })}`);
  });

  it("survives malformed and empty Setter.Target / RelativePanel values without bogus Hero edits", async () => {
    for (const [label, buf] of [
      ["unterminated Setter", page(`  <Border x:Name="Hero" />\n  <Setter Target="He|ro.Background" Value="Red"`).replace("</Page>", "")],
      ["missing close tag", page(`  <RelativePanel>\n    <Border x:Name="Hero" />\n    <Button RelativePanel.RightOf="He|ro"`).replace("</Page>", "")],
      ["empty Setter.Target", page(`  <Border x:Name="Hero" />\n  <Setter Target="|" Value="Red" />`)],
      ["dot-only Setter.Target", page(`  <Border x:Name="Hero" />\n  <Setter Target=".|" Value="Red" />`)],
      ["property-only Setter.Target", page(`  <Border x:Name="Hero" />\n  <Setter Target=".Pr|op" Value="Red" />`)],
      ["empty RelativePanel attr", page(`  <RelativePanel>\n    <Border x:Name="Hero" />\n    <Button RelativePanel.RightOf="|" />\n  </RelativePanel>`)],
    ]) {
      assert.ok(Array.isArray(await h.definitionsAt(buf)), `${label}: definitions must return an array`);
      assert.ok(Array.isArray(await h.referencesAt(buf)), `${label}: references must return an array`);
      assert.ok(Array.isArray(await h.highlightsAt(buf)), `${label}: highlights must return an array`);
      const res = await h.renameAt(buf, "Banner");
      if (!label.startsWith("unterminated") && !label.startsWith("missing close")) {
        assertNoEdits(res, label);
      } else if (!res.error) {
        assert.ok((res.edits || []).every((e) => e.text === "Hero" || e.text === "Hero.Background"), `${label}: malformed edit covered unexpected text: ${JSON.stringify(res)}`);
      }
    }
  });

  it("hovers the Setter.Target element segment (hover parity with RelativePanel), not only the property tail", async () => {
    const buf = page(`  <Border x:Name="Hero" />\n  <Setter Target="He|ro.Background" Value="Red" />`);
    const hover = await h.hoverAt(buf);
    assert.ok(/Hero/.test(hover) && /element/i.test(hover), `expected an element hover for Hero; got ${JSON.stringify(hover)}`);
  });

  it("resolves the Setter.Target caret just before the dot but not just after it", async () => {
    const before = page(`  <Border x:Name="Hero" />\n  <Setter Target="Hero|.Background" Value="Red" />`);
    const after = page(`  <Border x:Name="Hero" />\n  <Setter Target="Hero.|Background" Value="Red" />`);
    assert.ok((await h.definitionsAt(before)).some((d) => d.line === declLine(before, "Hero")), "caret just before the dot should resolve Hero");
    assert.deepStrictEqual(await h.definitionsAt(after), [], "caret just after the dot must not resolve the element");
  });

  it("resolves Setter.Target and RelativePanel against a plain Name= declaration (no x: prefix)", async () => {
    const buf = page(`  <RelativePanel>\n    <Border Name="Plain" />\n    <Setter Target="Pl|ain.Background" Value="Red" />\n    <Button RelativePanel.RightOf="Plain" />\n  </RelativePanel>`);
    const refs = await h.referencesAt(buf);
    assert.strictEqual(refs.filter((r) => r.text === "Plain").length, 3, `expected decl + Setter + RelativePanel against Name=; got ${JSON.stringify(refs)}`);
  });

  it("isolates distinct elements — renaming Hero never touches a sibling Setter.Target for Other", async () => {
    const buf = page(
      `  <Border x:Name="Hero" />\n` +
      `  <Border x:Name="Other" />\n` +
      `  <Setter Target="He|ro.Background" Value="Red" />\n` +
      `  <Setter Target="Other.Opacity" Value="0.5" />`
    );
    const res = await h.renameAt(buf, "Banner");
    assert.ok(!res.error, `rename should not error; got ${JSON.stringify(res)}`);
    assertAllEdits(res.edits, "Hero", "Banner", 2, "distinct-element isolation");
  });

  it("trims surrounding whitespace in a RelativePanel value, covering exactly the name on rename", async () => {
    const buf = page(`  <RelativePanel>\n    <Border x:Name="An|chor" />\n    <Button RelativePanel.RightOf=" Anchor " />\n  </RelativePanel>`);
    const res = await h.renameAt(buf, "Mooring");
    assert.ok(!res.error, `rename should not error; got ${JSON.stringify(res)}`);
    assertAllEdits(res.edits, "Anchor", "Mooring", 2, "RelativePanel value whitespace");
  });
});
