"use strict";

// Unknown-owner diagnostics for unprefixed dotted property elements.

const assert = require("node:assert");
const h = require("./helper");

function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
}

function wxaml(diags) {
  return diags.filter((x) => /^WXAML/.test(String(x.code || "")));
}

function summary(diags) {
  return diags.map((d) => `${d.code}:${d.message}`).join("; ");
}

function countByCode(diags, code) {
  return wxaml(diags).filter((x) => x.code === code).length;
}

async function clearWxamlDiagnostics() {
  const diags = await h.diagnosticsFor(page("<Grid />"), () => false, 6000);
  assert.strictEqual(wxaml(diags).length, 0, `diagnostic clear page should be WXAML-silent; got ${summary(wxaml(diags))}`);
}

function assertNamesOwnerOnly(diag, owner, member) {
  assert.ok(new RegExp(`\\b${owner}\\b`).test(diag.message), `should name owner '${owner}'; got ${diag.message}`);
  assert.ok(!new RegExp(`\\b${member}\\b`).test(diag.message), `should NOT name member '${member}'; got ${diag.message}`);
}

describe("WinUI XAML red-team 23 — unknown-owner property-element (WXAML0002) probes", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("unknown property-element owner raises exactly one WXAML0002 on the owner", async () => {
    const buffer = page("<Grid>\n    <Bogus.Foo>\n      <RowDefinition />\n    </Bogus.Foo>\n  </Grid>");
    const diags = await h.diagnosticsFor(buffer, (d) => d.some((x) => x.code === "WXAML0002" && /\bBogus\b/.test(x.message)));
    const only = wxaml(diags);
    assert.strictEqual(only.length, 1, `expected exactly 1 WXAML diagnostic; got ${summary(only)}`);
    assert.strictEqual(only[0].code, "WXAML0002", `expected WXAML0002; got ${summary(only)}`);
    assert.strictEqual(only[0].severity, 0, `WXAML0002 should be a VS Code error; got severity ${only[0].severity}`);
    assertNamesOwnerOnly(only[0], "Bogus", "Foo");
  });

  for (const probe of [
    {
      name: "Grid.RowDefinitions",
      xaml: "<Grid>\n    <Grid.RowDefinitions>\n      <RowDefinition />\n    </Grid.RowDefinitions>\n  </Grid>",
    },
    {
      name: "Grid.ColumnDefinitions",
      xaml: "<Grid>\n    <Grid.ColumnDefinitions>\n      <ColumnDefinition />\n    </Grid.ColumnDefinitions>\n  </Grid>",
    },
    {
      name: "StackPanel.Background",
      xaml: "<StackPanel>\n    <StackPanel.Background>\n      <SolidColorBrush Color=\"Red\" />\n    </StackPanel.Background>\n  </StackPanel>",
    },
    {
      name: "Border.Child",
      xaml: "<Border>\n    <Border.Child>\n      <Button Content=\"ok\" />\n    </Border.Child>\n  </Border>",
    },
    {
      name: "ScrollViewer.Content",
      xaml: "<ScrollViewer>\n    <ScrollViewer.Content>\n      <Button Content=\"ok\" />\n    </ScrollViewer.Content>\n  </ScrollViewer>",
    },
  ]) {
    it(`valid property element stays silent: ${probe.name}`, async () => {
      const buffer = page(probe.xaml);
      const diags = await h.diagnosticsFor(buffer, () => false, 6000);
      assert.strictEqual(wxaml(diags).length, 0, `${probe.name} must stay silent; got ${summary(wxaml(diags))}`);
    });
  }

  for (const probe of [
    { name: "Grid.Row", xaml: "<Button>\n    <Grid.Row>1</Grid.Row>\n  </Button>" },
    { name: "Grid.Column", xaml: "<Button>\n    <Grid.Column>2</Grid.Column>\n  </Button>" },
    { name: "Canvas.Left", xaml: "<Button>\n    <Canvas.Left>10</Canvas.Left>\n  </Button>" },
    { name: "Canvas.Top", xaml: "<Button>\n    <Canvas.Top>20</Canvas.Top>\n  </Button>" },
  ]) {
    it(`attached property in element form stays silent: ${probe.name}`, async () => {
      const buffer = page(probe.xaml);
      const diags = await h.diagnosticsFor(buffer, () => false, 6000);
      assert.strictEqual(wxaml(diags).length, 0, `${probe.name} attached element form must stay silent; got ${summary(wxaml(diags))}`);
    });
  }

  it("known owner with bad member raises exactly one WXAML0006 and no WXAML0002", async () => {
    const buffer = page("<Grid>\n    <Grid.rowDefinitions>\n      <RowDefinition />\n    </Grid.rowDefinitions>\n  </Grid>");
    const diags = await h.diagnosticsFor(buffer, (d) => d.some((x) => x.code === "WXAML0006"));
    const only = wxaml(diags);
    assert.strictEqual(only.length, 1, `expected exactly 1 WXAML diagnostic; got ${summary(only)}`);
    assert.strictEqual(only[0].code, "WXAML0006", `expected WXAML0006 only; got ${summary(only)}`);
    assert.ok(/rowDefinitions/.test(only[0].message), `WXAML0006 should name the bad member; got ${only[0].message}`);
    assert.strictEqual(countByCode(diags, "WXAML0002"), 0, `known owner must not also raise WXAML0002; got ${summary(only)}`);
  });

  it("multi-dot unknown owner uses the last dot and names owner A.B only", async () => {
    const buffer = page("<Grid>\n    <A.B.C>\n      <Button />\n    </A.B.C>\n  </Grid>");
    const diags = await h.diagnosticsFor(buffer, () => false, 6000);
    const only = wxaml(diags);
    assert.strictEqual(only.length, 1, `expected exactly 1 WXAML diagnostic; got ${summary(only)}`);
    assert.strictEqual(only[0].code, "WXAML0002", `expected WXAML0002; got ${summary(only)}`);
    assertNamesOwnerOnly(only[0], "A.B", "C");
  });

  it("repeated unknown owners each fire once without member diagnostics", async () => {
    const buffer = page("<Grid>\n    <Bogus.Foo />\n    <Nope.Bar />\n  </Grid>");
    const diags = await h.diagnosticsFor(buffer, (d) => wxaml(d).filter((x) => x.code === "WXAML0002").length >= 2);
    const only = wxaml(diags);
    assert.strictEqual(only.length, 2, `expected exactly 2 WXAML diagnostics; got ${summary(only)}`);
    assert.strictEqual(countByCode(diags, "WXAML0002"), 2, `expected two WXAML0002 diagnostics; got ${summary(only)}`);
    assert.strictEqual(countByCode(diags, "WXAML0006"), 0, `unknown owners must not also raise WXAML0006; got ${summary(only)}`);
    assert.ok(only.some((x) => /Bogus/.test(x.message) && !/Foo/.test(x.message)), `Bogus diagnostic should name owner only; got ${summary(only)}`);
    assert.ok(only.some((x) => /Nope/.test(x.message) && !/Bar/.test(x.message)), `Nope diagnostic should name owner only; got ${summary(only)}`);
  });

  for (const probe of [
    { name: "trailing dot", xaml: "<Grid>\n    <Grid.>\n    </Grid.>\n  </Grid>" },
    { name: "leading dot", xaml: "<Grid>\n    <.Foo>\n    </.Foo>\n  </Grid>" },
    { name: "lone dotted", xaml: "<Grid>\n    <.>\n    </.>\n  </Grid>" },
  ]) {
    it(`malformed dotted name stays WXAML-silent: ${probe.name}`, async () => {
      const buffer = page(probe.xaml);
      const diags = await h.diagnosticsFor(buffer, () => false, 6000);
      assert.strictEqual(wxaml(diags).length, 0, `${probe.name} is parser-owned and must stay WXAML-silent; got ${summary(wxaml(diags))}`);
    });
  }

  it("design-time prefixed dotted tag stays WXAML-silent", async () => {
    const buffer = page("<Grid>\n    <d:Bogus.Foo />\n  </Grid>");
    const diags = await h.diagnosticsFor(buffer, () => false, 6000);
    assert.strictEqual(wxaml(diags).length, 0, `d: dotted tags must stay silent; got ${summary(wxaml(diags))}`);
  });

  it("mixed buffer produces one unknown-owner WXAML0002 and one bad-member WXAML0006", async () => {
    const buffer = page("<Grid>\n    <Grid.RowDefinitions>\n      <RowDefinition />\n    </Grid.RowDefinitions>\n    <Bogus.Foo />\n    <Grid.rowDefinitions>\n      <RowDefinition />\n    </Grid.rowDefinitions>\n  </Grid>");
    const diags = await h.diagnosticsFor(buffer, (d) => countByCode(d, "WXAML0002") >= 1 && countByCode(d, "WXAML0006") >= 1);
    const only = wxaml(diags);
    assert.strictEqual(only.length, 2, `expected exactly two WXAML diagnostics; got ${summary(only)}`);
    assert.strictEqual(countByCode(diags, "WXAML0002"), 1, `expected one WXAML0002; got ${summary(only)}`);
    assert.strictEqual(countByCode(diags, "WXAML0006"), 1, `expected one WXAML0006; got ${summary(only)}`);
    assert.ok(only.some((x) => x.code === "WXAML0002" && /Bogus/.test(x.message) && !/Foo/.test(x.message)), `unknown-owner diagnostic should name Bogus only; got ${summary(only)}`);
    assert.ok(only.some((x) => x.code === "WXAML0006" && /rowDefinitions/.test(x.message)), `bad-member diagnostic should name rowDefinitions; got ${summary(only)}`);
  });

  it("unknown owner and unrelated x:Bind diagnostic stay independent", async () => {
    const buffer = page("<StackPanel>\n    <Bogus.Foo />\n    <TextBlock Text=\"{x:Bind GreetingText.NopeRound23}\" />\n  </StackPanel>");
    const diags = await h.diagnosticsFor(buffer, (d) => countByCode(d, "WXAML0002") >= 1 && countByCode(d, "WXAML0005") >= 1);
    const only = wxaml(diags);
    assert.strictEqual(only.length, 2, `expected exactly two WXAML diagnostics; got ${summary(only)}`);
    assert.strictEqual(countByCode(diags, "WXAML0002"), 1, `expected one WXAML0002; got ${summary(only)}`);
    assert.strictEqual(countByCode(diags, "WXAML0005"), 1, `expected one WXAML0005; got ${summary(only)}`);
    assert.ok(only.some((x) => x.code === "WXAML0002" && /Bogus/.test(x.message) && !/Foo/.test(x.message)), `WXAML0002 should name Bogus only; got ${summary(only)}`);
    assert.ok(only.some((x) => x.code === "WXAML0005" && /NopeRound23/.test(x.message)), `WXAML0005 should name the x:Bind miss; got ${summary(only)}`);
  });

  it("prefixed dotted local tag follows regular element path and reports the whole local name", async () => {
    await clearWxamlDiagnostics();
    const buffer = page("<Grid>\n    <local:SmokePage.Foo />\n  </Grid>");
    const diags = await h.diagnosticsFor(buffer, () => false, 6000);
    const only = wxaml(diags);
    assert.strictEqual(only.length, 1, `expected exactly one regular-element diagnostic; got ${summary(only)}`);
    assert.strictEqual(only[0].code, "WXAML0002", `prefixed dotted tag should be regular unknown type WXAML0002; got ${summary(only)}`);
    assert.ok(/SmokePage\.Foo/.test(only[0].message), `regular path should name whole local type SmokePage.Foo; got ${only[0].message}`);
  });

  it("prefixed dotted unknown local tag follows regular element path and reports the whole local name", async () => {
    await clearWxamlDiagnostics();
    const buffer = page("<Grid>\n    <local:Bogus.Foo />\n  </Grid>");
    const diags = await h.diagnosticsFor(buffer, () => false, 6000);
    const only = wxaml(diags);
    assert.strictEqual(only.length, 1, `expected exactly one regular-element diagnostic; got ${summary(only)}`);
    assert.strictEqual(only[0].code, "WXAML0002", `prefixed dotted tag should be regular unknown type WXAML0002; got ${summary(only)}`);
    assert.ok(/Bogus\.Foo/.test(only[0].message), `regular path should name whole local type Bogus.Foo; got ${only[0].message}`);
  });
});
