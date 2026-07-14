"use strict";

// Round 19 red-team probes: adversarial property-element hover/F12 resolution
// for round-18 no-prefix <Owner.Member> support, plus a light regression sweep.

const assert = require("node:assert");
const path = require("node:path");
const h = require("./helper");

const APP = "App.xaml";

function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
}

function diagSummary(diags) {
  return diags.map((d) => `${d.code}:${d.message}`).join("; ");
}

function wxaml(diags) {
  return diags.filter((x) => /^WXAML/.test(String(x.code || "")));
}

function assertNoMemberSignature(md, member, buffer) {
  assert.strictEqual(typeof md, "string", `hover should return a stable string; buffer=${buffer}; got ${md}`);
  assert.ok(!new RegExp(`\\b${member}\\b`).test(md), `hover must not resolve bogus member ${member}; buffer=${buffer}; got ${md}`);
}

describe("WinUI XAML red-team 19 — property-element hover/F12 adversarial probes", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("hover resolves Grid.RowDefinitions from the open-tag member segment only", async () => {
    const buffer = page([
      "<Grid>",
      "  <Grid.RowDef|initions>",
      "    <RowDefinition />",
      "  </Grid.RowDefinitions>",
      "</Grid>",
    ].join("\n  "));
    const md = await h.hoverAt(buffer);
    assert.ok(/RowDefinitionCollection/.test(md), `hover should include the property type; buffer=${buffer}; got ${md}`);
    assert.ok(/Grid\.RowDefinitions/.test(md), `hover should include the Grid.RowDefinitions signature; buffer=${buffer}; got ${md}`);
  });

  it("hover resolves Grid.RowDefinitions from the end-tag member segment", async () => {
    const buffer = page([
      "<Grid>",
      "  <Grid.RowDefinitions>",
      "    <RowDefinition />",
      "  </Grid.RowDef|initions>",
      "</Grid>",
    ].join("\n  "));
    const md = await h.hoverAt(buffer);
    assert.ok(/RowDefinitionCollection/.test(md), `end-tag hover should include the property type; buffer=${buffer}; got ${md}`);
    assert.ok(/Grid\.RowDefinitions/.test(md), `end-tag hover should include the Grid.RowDefinitions signature; buffer=${buffer}; got ${md}`);
  });

  it("F12 on Grid.RowDefinitions open tag is stable and empty for framework metadata", async () => {
    const buffer = page([
      "<Grid>",
      "  <Grid.RowDef|initions>",
      "    <RowDefinition />",
      "  </Grid.RowDefinitions>",
      "</Grid>",
    ].join("\n  "));
    const defs = await h.definitionsAt(buffer);
    assert.ok(Array.isArray(defs), `property-element F12 should return an array; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(defs.length, 0, `framework property-element F12 should remain metadata-empty; buffer=${buffer}; got ${JSON.stringify(defs)}`);
  });

  it("F12 on Grid.RowDefinitions end tag is stable and empty for framework metadata", async () => {
    const buffer = page([
      "<Grid>",
      "  <Grid.RowDefinitions>",
      "    <RowDefinition />",
      "  </Grid.RowDef|initions>",
      "</Grid>",
    ].join("\n  "));
    const defs = await h.definitionsAt(buffer);
    assert.ok(Array.isArray(defs), `end-tag property-element F12 should return an array; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(defs.length, 0, `end-tag framework F12 should remain metadata-empty; buffer=${buffer}; got ${JSON.stringify(defs)}`);
  });

  it("does not resolve the property when the caret is on the owner segment", async () => {
    const buffer = page([
      "<Grid>",
      "  <Gr|id.RowDefinitions>",
      "    <RowDefinition />",
      "  </Grid.RowDefinitions>",
      "</Grid>",
    ].join("\n  "));
    const md = await h.hoverAt(buffer);
    assert.ok(!/Grid\.RowDefinitions/.test(md), `owner-segment hover must not masquerade as the RowDefinitions member; buffer=${buffer}; got ${md}`);
  });

  it("does not resolve the property when the caret is on the dot separator", async () => {
    const buffer = page([
      "<Grid>",
      "  <Grid|.RowDefinitions>",
      "    <RowDefinition />",
      "  </Grid.RowDefinitions>",
      "</Grid>",
    ].join("\n  "));
    const md = await h.hoverAt(buffer);
    assert.ok(!/Grid\.RowDefinitions/.test(md), `dot hover must not masquerade as the RowDefinitions member; buffer=${buffer}; got ${md}`);
  });

  it("still resolves on the first and last characters of the member segment", async () => {
    const first = page([
      "<Grid>",
      "  <Grid.|RowDefinitions>",
      "    <RowDefinition />",
      "  </Grid.RowDefinitions>",
      "</Grid>",
    ].join("\n  "));
    const last = page([
      "<Grid>",
      "  <Grid.RowDefinition|s>",
      "    <RowDefinition />",
      "  </Grid.RowDefinitions>",
      "</Grid>",
    ].join("\n  "));
    const mdFirst = await h.hoverAt(first);
    const mdLast = await h.hoverAt(last);
    assert.ok(/Grid\.RowDefinitions/.test(mdFirst), `first member char should resolve RowDefinitions; buffer=${first}; got ${mdFirst}`);
    assert.ok(/Grid\.RowDefinitions/.test(mdLast), `last member char should resolve RowDefinitions; buffer=${last}; got ${mdLast}`);
  });

  for (const probe of [
    { name: "empty member", member: "RowDefinitions", xaml: "<Grid>\n    <Grid|.>\n    </Grid.>\n  </Grid>" },
    { name: "empty owner", member: "RowDefinitions", xaml: "<Grid>\n    <.|RowDefinitions>\n    </.RowDefinitions>\n  </Grid>" },
    { name: "double dot", member: "RowDefinitions", xaml: "<Grid>\n    <Grid..RowDef|initions>\n    </Grid..RowDefinitions>\n  </Grid>" },
    { name: "multi-dot owner", member: "Extra", xaml: "<Grid>\n    <Grid.Row.Ex|tra>\n    </Grid.Row.Extra>\n  </Grid>" },
    { name: "whitespace after dot", member: "RowDefinitions", xaml: "<Grid>\n    <Grid.  RowDef|initions>\n    </Grid.  RowDefinitions>\n  </Grid>" },
    { name: "lone dotted owner", member: "RowDefinitions", xaml: "<Grid>\n    <Gri|d.>\n    </Grid.>\n  </Grid>" },
  ]) {
    it(`does not crash or hover a bogus member for malformed dotted name: ${probe.name}`, async () => {
      const buffer = page(probe.xaml);
      const md = await h.hoverAt(buffer);
      assertNoMemberSignature(md, probe.member, buffer);
      const defs = await h.definitionsAt(buffer);
      assert.ok(Array.isArray(defs), `malformed property-element F12 should return a stable array; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    });
  }

  it("does not treat a prefixed dotted local element as a property-element member", async () => {
    const buffer = page("<local:SmokePage.Greeting|Text>hello</local:SmokePage.GreetingText>");
    const md = await h.hoverAt(buffer);
    assert.ok(!/string\s+SmokePage\.GreetingText/.test(md), `prefixed dotted element must not hover as the GreetingText member; buffer=${buffer}; got ${md}`);
    const defs = await h.definitionsAt(buffer);
    assert.ok(Array.isArray(defs), `prefixed dotted element F12 should be stable; buffer=${buffer}; got ${JSON.stringify(defs)}`);
  });

  it("does not treat an x:-prefixed dotted element as a property-element member", async () => {
    const buffer = page("<x:Something.Dott|ed />");
    const md = await h.hoverAt(buffer);
    assert.ok(!/Something\.Dotted/.test(md), `x:-prefixed dotted element must not hover as a property member; buffer=${buffer}; got ${md}`);
    const defs = await h.definitionsAt(buffer);
    assert.ok(Array.isArray(defs), `x:-prefixed dotted element F12 should be stable; buffer=${buffer}; got ${JSON.stringify(defs)}`);
  });

  it("does not hover attached-property element syntax as Grid or Canvas instance members", async () => {
    const grid = page("<Button><Grid.R|ow>0</Grid.Row></Button>");
    const canvas = page("<Button><Canvas.L|eft>10</Canvas.Left></Button>");
    const mdGrid = await h.hoverAt(grid);
    const mdCanvas = await h.hoverAt(canvas);
    assert.ok(!/Grid\.Row/.test(mdGrid), `attached element-form Grid.Row must not resolve as an instance member; buffer=${grid}; got ${mdGrid}`);
    assert.ok(!/Canvas\.Left/.test(mdCanvas), `attached element-form Canvas.Left must not resolve as an instance member; buffer=${canvas}; got ${mdCanvas}`);
  });

  it.skip("KNOWN GAP: attached-property element-form hover should eventually resolve attached members", async () => {
    const buffer = page("<Button><Grid.R|ow>0</Grid.Row></Button>");
    const md = await h.hoverAt(buffer);
    assert.ok(/Grid\.Row/.test(md), `attached property element should eventually hover; buffer=${buffer}; got ${md}`);
  });

  it("keeps child element hover inside a property element on the child type, not the enclosing property", async () => {
    const buffer = page([
      "<Grid>",
      "  <Grid.RowDefinitions>",
      "    <RowDefinit|ion />",
      "  </Grid.RowDefinitions>",
      "</Grid>",
    ].join("\n  "));
    const md = await h.hoverAt(buffer);
    assert.ok(/class\s+.*RowDefinition/.test(md), `child hover should resolve the RowDefinition type; buffer=${buffer}; got ${md}`);
    assert.ok(!/Grid\.RowDefinitions/.test(md), `child hover must not be hijacked by the enclosing property element; buffer=${buffer}; got ${md}`);
  });

  it("keeps child F12 inside a property element on the child type path and stable", async () => {
    const buffer = page([
      "<Grid>",
      "  <Grid.RowDefinitions>",
      "    <RowDefinit|ion />",
      "  </Grid.RowDefinitions>",
      "</Grid>",
    ].join("\n  "));
    const defs = await h.definitionsAt(buffer);
    assert.ok(Array.isArray(defs), `child F12 inside property element should return a stable array; buffer=${buffer}; got ${JSON.stringify(defs)}`);
  });

  it("keeps sibling attribute hover working next to a property element", async () => {
    const buffer = page([
      "<Grid>",
      "  <Grid.RowDefinitions>",
      "    <RowDefinition />",
      "  </Grid.RowDefinitions>",
      "  <TextBlock Tex|t=\"hello\" />",
      "</Grid>",
    ].join("\n  "));
    const md = await h.hoverAt(buffer);
    assert.ok(/Text/.test(md), `sibling attribute hover should still resolve TextBlock.Text; buffer=${buffer}; got ${md}`);
    assert.ok(!/Grid\.RowDefinitions/.test(md), `sibling attribute hover must not leak RowDefinitions; buffer=${buffer}; got ${md}`);
  });

  it("does not crash on value-like owner types in property-element shape", async () => {
    const thickness = page([
      "<Grid>",
      "  <Thickness.L|eft>1</Thickness.Left>",
      "</Grid>",
    ].join("\n  "));
    const visibility = page([
      "<Grid>",
      "  <Visibility.H|idden>Collapsed</Visibility.Hidden>",
      "</Grid>",
    ].join("\n  "));
    const mdThickness = await h.hoverAt(thickness);
    const mdVisibility = await h.hoverAt(visibility);
    assert.strictEqual(typeof mdThickness, "string", `struct owner hover should return a stable string; buffer=${thickness}; got ${mdThickness}`);
    assert.strictEqual(typeof mdVisibility, "string", `enum owner hover should return a stable string; buffer=${visibility}; got ${mdVisibility}`);
    const defs = await h.definitionsAt(thickness);
    assert.ok(Array.isArray(defs), `value-like owner F12 should return a stable array; buffer=${thickness}; got ${JSON.stringify(defs)}`);
  });

  it("does not resolve no-prefix user-type-looking property elements through the default framework namespace", async () => {
    const buffer = page("<SmokePage.Greeting|Text>hello</SmokePage.GreetingText>");
    const md = await h.hoverAt(buffer);
    assert.ok(!/SmokePage\.GreetingText/.test(md), `no-prefix SmokePage should not resolve to the local user type; buffer=${buffer}; got ${md}`);
    const defs = await h.definitionsAt(buffer);
    assert.ok(Array.isArray(defs), `no-prefix user-looking property element F12 should be stable; buffer=${buffer}; got ${JSON.stringify(defs)}`);
  });

  it("resolves a deeply nested template property element without hijacking nested control hover", async () => {
    const buffer = page([
      "<Page.Resources>",
      "  <Style x:Key=\"Round19ButtonStyle\" TargetType=\"Button\">",
      "    <Style.Setters>",
      "      <Setter Property=\"Template\">",
      "        <Setter.Value>",
      "          <ControlTemplate TargetType=\"Button\">",
      "            <Grid>",
      "              <Grid.RowDef|initions>",
      "                <RowDefinition Height=\"Auto\" />",
      "              </Grid.RowDefinitions>",
      "              <ContentPresenter />",
      "            </Grid>",
      "          </ControlTemplate>",
      "        </Setter.Value>",
      "      </Setter>",
      "    </Style.Setters>",
      "  </Style>",
      "</Page.Resources>",
      "<Button Style=\"{StaticResource Round19ButtonStyle}\" />",
    ].join("\n  "));
    const md = await h.hoverAt(buffer);
    assert.ok(/Grid\.RowDefinitions/.test(md), `nested template property-element hover should resolve RowDefinitions; buffer=${buffer}; got ${md}`);
  });
});

describe("WinUI XAML red-team 19 — light secondary regression sweep", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("keeps valid non-first x:Bind chains silent and reports exactly one bad tail", async () => {
    const valid = page([
      "<StackPanel>",
      "  <TextBlock Text=\"{x:Bind GreetingText.Length}\" />",
      "  <TextBlock Text=\"{x:Bind Items[0].Length}\" />",
      "  <TextBlock Text=\"{x:Bind Items.Count}\" />",
      "</StackPanel>",
    ].join("\n  "));
    const validDiags = await h.diagnosticsFor(valid, () => false, 4000);
    assert.deepStrictEqual(validDiags.filter((x) => x.code === "WXAML0005"), [], `valid x:Bind chains should stay silent; buffer=${valid}; got ${diagSummary(validDiags)}`);

    const invalid = page("<TextBlock Text=\"{x:Bind GreetingText.NopeRound19}\" />");
    const invalidDiags = await h.diagnosticsFor(invalid, (d) => d.some((x) => x.code === "WXAML0005"), 12000);
    const bad = invalidDiags.filter((x) => x.code === "WXAML0005");
    assert.strictEqual(bad.length, 1, `bad x:Bind tail should raise exactly one WXAML0005; buffer=${invalid}; got ${diagSummary(invalidDiags)}`);
    assert.ok(/NopeRound19/.test(bad[0].message), `WXAML0005 should name NopeRound19; buffer=${invalid}; got ${bad[0].message}`);
  });

  it("keeps property-element validation on mis-cased members and event property-elements", async () => {
    const buffer = page([
      "<Grid>",
      "  <Grid.rowDefinitions>",
      "    <RowDefinition />",
      "  </Grid.rowDefinitions>",
      "  <Button>",
      "    <Button.Click>OnGo_Click</Button.Click>",
      "  </Button>",
      "</Grid>",
    ].join("\n  "));
    const diags = await h.diagnosticsFor(buffer, (d) => d.filter((x) => x.code === "WXAML0006").length >= 2, 12000);
    const bad = diags.filter((x) => x.code === "WXAML0006");
    assert.ok(bad.some((x) => /rowDefinitions/.test(x.message)), `WXAML0006 should name mis-cased rowDefinitions; buffer=${buffer}; got ${diagSummary(diags)}`);
    assert.ok(bad.some((x) => /Click/.test(x.message)), `WXAML0006 should name event property-element Click; buffer=${buffer}; got ${diagSummary(diags)}`);
  });

  it("keeps attached-property attribute hover separate from property-element hover", async () => {
    const buffer = page([
      "<Grid>",
      "  <Grid.RowDefinitions>",
      "    <RowDefinition />",
      "  </Grid.RowDefinitions>",
      "  <Button Grid.R|ow=\"1\" />",
      "</Grid>",
    ].join("\n  "));
    const md = await h.hoverAt(buffer);
    assert.ok(/Grid\.Row/.test(md), `attached-property attribute hover should still resolve Grid.Row; buffer=${buffer}; got ${md}`);
    assert.ok(!/RowDefinitionCollection/.test(md), `attached-property attribute hover must not leak RowDefinitions; buffer=${buffer}; got ${md}`);
  });

  it("keeps StaticResource hover and F12 working near property elements", async () => {
    const hoverBuffer = page([
      "<Grid Background=\"{StaticResource SmokeAccent|Brush}\">",
      "  <Grid.RowDefinitions>",
      "    <RowDefinition />",
      "  </Grid.RowDefinitions>",
      "</Grid>",
    ].join("\n  "));
    const md = await h.hoverAt(hoverBuffer);
    assert.ok(/SmokeAccentBrush/.test(md), `resource hover should name SmokeAccentBrush; buffer=${hoverBuffer}; got ${md}`);
    assert.ok(/SolidColorBrush/.test(md), `resource hover should include SolidColorBrush; buffer=${hoverBuffer}; got ${md}`);

    const defBuffer = hoverBuffer;
    const defs = await h.definitionsAt(defBuffer);
    assert.ok(defs.length > 0, `resource F12 should find App.xaml; buffer=${defBuffer}; got ${JSON.stringify(defs)}`);
    assert.ok(path.basename(defs[0].fsPath) === APP, `resource F12 should target ${APP}; buffer=${defBuffer}; got ${JSON.stringify(defs)}`);
  });

  it("keeps document outline stable for property elements nested in templates", async () => {
    const buffer = page([
      "<Page.Resources>",
      "  <DataTemplate x:Key=\"Round19Template\" x:DataType=\"x:String\">",
      "    <Grid>",
      "      <Grid.RowDefinitions>",
      "        <RowDefinition />",
      "      </Grid.RowDefinitions>",
      "      <TextBlock Text=\"{x:Bind Length}\" />",
      "    </Grid>",
      "  </DataTemplate>",
      "</Page.Resources>",
      "<ListView ItemsSource=\"{x:Bind Items}\" ItemTemplate=\"{StaticResource Round19Template}\" />",
    ].join("\n  "));
    const names = h.flattenSymbols(await h.symbolsAt(buffer));
    for (const expected of ["Page.Resources", "DataTemplate", "Grid", "Grid.RowDefinitions", "RowDefinition", "TextBlock", "ListView"]) {
      assert.ok(names.includes(expected), `outline should include ${expected}; buffer=${buffer}; got ${names.join(" > ")}`);
    }
  });
});
