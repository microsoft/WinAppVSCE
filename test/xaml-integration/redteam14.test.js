"use strict";

// Round 14 red-team probes: attack newly shipped property-element diagnostics,
// realistic no-false-positive pages, tricky navigation/hover contexts, completion boundaries,
// outline resilience, and namespace scoping edges.

const assert = require("node:assert");
const path = require("node:path");
const h = require("./helper");

const CS = "SmokePage.xaml.cs";
const XAML = "SmokePage.xaml";

function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
}

function diagSummary(diags) {
  return diags.map((d) => `${d.code}:${d.message}`).join("; ");
}

function flatten(nodes, out = []) {
  for (const n of nodes || []) {
    out.push(n.name);
    if (n.children && n.children.length) flatten(n.children, out);
  }
  return out;
}

describe("WinUI XAML red-team 14 — property elements, realistic pages, and edge language features", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("flags a mis-cased attached-property element member with WXAML0006", async () => {
    const buffer = page([
      "<Grid>",
      "  <Grid.rW>0</Grid.rW>",
      "</Grid>",
    ].join("\n  "));
    const diags = await h.diagnosticsFor(buffer, (d) => d.some((x) => x.code === "WXAML0006" && /rW/.test(x.message)), 12000);
    assert.ok(diags.some((x) => x.code === "WXAML0006" && /rW/.test(x.message)), `mis-cased attached property element should raise WXAML0006 naming rW; buffer=${buffer}; got ${diagSummary(diags)}`);
  });

  it("flags an event used as a property element with WXAML0006", async () => {
    await h.diagnosticsFor(page("<Grid />"), (d) => !d.some((x) => /^WXAML/.test(String(x.code || ""))), 5000);
    const buffer = page([
      "<Button>",
      "  <Button.Click>OnGo_Click</Button.Click>",
      "</Button>",
    ].join("\n  "));
    const diags = await h.diagnosticsFor(buffer, (d) => d.some((x) => x.code === "WXAML0006" && /Click/.test(x.message)), 12000);
    assert.ok(diags.some((x) => x.code === "WXAML0006" && /Click/.test(x.message)), `event property-element syntax should raise WXAML0006 naming Click; buffer=${buffer}; got ${diagSummary(diags)}`);
  });

  it("does not treat a prefixed custom dotted element as a WXAML0006 property element", async () => {
    const buffer = page("<local:SmokePage.Foo />");
    const diags = await h.diagnosticsFor(buffer, () => false, 3500);
    assert.ok(!diags.some((x) => x.code === "WXAML0006"), `prefixed dotted custom element should not be a property-element diagnostic; buffer=${buffer}; got ${diagSummary(diags)}`);
  });

  it("does not flag nested valid property elements such as RowDefinition.Height", async () => {
    const buffer = page([
      "<Grid>",
      "  <Grid.RowDefinitions>",
      "    <RowDefinition>",
      "      <RowDefinition.Height>Auto</RowDefinition.Height>",
      "    </RowDefinition>",
      "  </Grid.RowDefinitions>",
      "</Grid>",
    ].join("\n  "));
    const diags = await h.diagnosticsFor(buffer, () => false, 3500);
    assert.ok(!diags.some((x) => /^WXAML/.test(String(x.code || ""))), `valid nested property elements should stay silent; buffer=${buffer}; got ${diagSummary(diags)}`);
  });

  it("does not flag an inherited property element such as Button.Background", async () => {
    const buffer = page([
      "<Button>",
      "  <Button.Background>",
      "    <SolidColorBrush Color=\"Red\" />",
      "  </Button.Background>",
      "</Button>",
    ].join("\n  "));
    const diags = await h.diagnosticsFor(buffer, () => false, 3500);
    assert.ok(!diags.some((x) => /^WXAML/.test(String(x.code || ""))), `inherited Button.Background property element should stay silent; buffer=${buffer}; got ${diagSummary(diags)}`);
  });

  it("does not flag valid inherited and attached property-element forms across controls", async () => {
    const buffer = page([
      "<Grid>",
      "  <TextBlock>",
      "    <TextBlock.Foreground>",
      "      <SolidColorBrush Color=\"Blue\" />",
      "    </TextBlock.Foreground>",
      "    <Grid.Row>0</Grid.Row>",
      "  </TextBlock>",
      "  <Border>",
      "    <Border.Background>",
      "      <SolidColorBrush Color=\"Green\" />",
      "    </Border.Background>",
      "  </Border>",
      "</Grid>",
    ].join("\n  "));
    const diags = await h.diagnosticsFor(buffer, () => false, 3500);
    assert.ok(!diags.some((x) => /^WXAML/.test(String(x.code || ""))), `valid inherited/attached property elements should stay silent; buffer=${buffer}; got ${diagSummary(diags)}`);
  });

  it("reports no WXAML diagnostics for a realistic template page with VSM, animations, and merged dictionaries", async () => {
    const buffer = page([
      "<Page.Resources>",
      "  <ResourceDictionary>",
      "    <ResourceDictionary.MergedDictionaries>",
      "      <ResourceDictionary>",
      "        <SolidColorBrush x:Key=\"Round14AccentBrush\" Color=\"Red\" />",
      "      </ResourceDictionary>",
      "    </ResourceDictionary.MergedDictionaries>",
      "    <Style x:Key=\"Round14ButtonStyle\" TargetType=\"Button\">",
      "      <Setter Property=\"Template\">",
      "        <Setter.Value>",
      "          <ControlTemplate TargetType=\"Button\">",
      "            <Grid x:Name=\"Root\" Background=\"{TemplateBinding Background}\">",
      "              <VisualStateManager.VisualStateGroups>",
      "                <VisualStateGroup x:Name=\"CommonStates\">",
      "                  <VisualState x:Name=\"Normal\" />",
      "                  <VisualState x:Name=\"PointerOver\">",
      "                    <Storyboard>",
      "                      <DoubleAnimation Storyboard.TargetName=\"Root\" Storyboard.TargetProperty=\"Opacity\" To=\"0.9\" Duration=\"0:0:0.1\" />",
      "                    </Storyboard>",
      "                  </VisualState>",
      "                </VisualStateGroup>",
      "              </VisualStateManager.VisualStateGroups>",
      "              <ContentPresenter />",
      "            </Grid>",
      "          </ControlTemplate>",
      "        </Setter.Value>",
      "      </Setter>",
      "    </Style>",
      "  </ResourceDictionary>",
      "</Page.Resources>",
      "<StackPanel>",
      "  <Button Style=\"{StaticResource Round14ButtonStyle}\" Background=\"{StaticResource Round14AccentBrush}\" Content=\"Go\" Click=\"OnGo_Click\" />",
      "</StackPanel>",
    ].join("\n  "));
    const diags = await h.diagnosticsFor(buffer, () => false, 3500);
    assert.ok(!diags.some((x) => /^WXAML/.test(String(x.code || ""))), `realistic template/VSM page should stay free of WXAML diagnostics; buffer=${buffer}; got ${diagSummary(diags)}`);
  });

  it("hover resolves the middle segment of a three-segment x:Bind path", async () => {
    const buffer = page("<TextBlock Text=\"{x:Bind GreetingText.Len|gth.ToString}\" />");
    const md = await h.hoverAt(buffer);
    assert.ok(/Length/.test(md), `middle dotted x:Bind hover should mention Length; buffer=${buffer}; got: ${md}`);
    assert.ok(/int|Int32|System\.Int32/.test(md), `middle dotted x:Bind hover should include integer type; buffer=${buffer}; got: ${md}`);
    assert.ok(!/ToString/.test(md), `middle segment hover should not describe the following segment; buffer=${buffer}; got: ${md}`);
  });

  it("F12 on the base of a dotted x:Bind path resolves the page member", async () => {
    const buffer = page("<TextBlock Text=\"{x:Bind Greeting|Text.Length}\" />");
    const defs = await h.definitionsAt(buffer);
    assert.ok(defs.length > 0, `dotted x:Bind base should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), CS, `expected ${CS}; buffer=${buffer}; got ${defs[0].fsPath}`);
  });

  it("hover on an attached-property attribute works on a custom local element", async () => {
    const buffer = page("<local:Page2 Grid.R|ow=\"0\" />");
    const md = await h.hoverAt(buffer);
    assert.ok(/Grid\.Row|Grid.Row/.test(md), `attached property hover on a custom element should identify Grid.Row; buffer=${buffer}; got: ${md}`);
    assert.ok(/attached property|attached/i.test(md), `attached property hover should mention attached-property semantics; buffer=${buffer}; got: ${md}`);
  });

  it("F12 resolves a resource key defined inside nested merged dictionaries", async () => {
    const buffer = page([
      "<Page.Resources>",
      "  <ResourceDictionary>",
      "    <ResourceDictionary.MergedDictionaries>",
      "      <ResourceDictionary>",
      "        <SolidColorBrush x:Key=\"NestedRound14Brush\" Color=\"Red\" />",
      "      </ResourceDictionary>",
      "    </ResourceDictionary.MergedDictionaries>",
      "  </ResourceDictionary>",
      "</Page.Resources>",
      "<Border Background=\"{StaticResource NestedRound14|Brush}\" />",
    ].join("\n  "));
    const defs = await h.definitionsAt(buffer);
    assert.ok(defs.length > 0, `nested merged-dictionary resource should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), XAML, `expected in-buffer XAML definition; buffer=${buffer}; got ${defs[0].fsPath}`);
    assert.strictEqual(defs[0].line, 11, `expected NestedRound14Brush at 0-based line 11; buffer=${buffer}; got ${defs[0].line}`);
  });

  it("completes custom local element names immediately after a namespace prefix colon", async () => {
    const buffer = page("<local:|");
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("Page2"), `local-prefix element completion should include Page2; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
    assert.ok(!items.includes("Button"), `local-prefix element completion should not offer framework Button; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("does not offer language-server semantic completions inside a plain string attribute value", async () => {
    const buffer = page("<Button Content=\"plain | text\" />");
    const items = await h.completionsAt(buffer);
    for (const forbidden of ["OnGo_Click", "GreetingText", "Click", "StaticResource", "x:Bind"]) {
      assert.ok(!items.includes(forbidden), `plain string value should not offer ${forbidden}; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
    }
  });

  it("completes a concrete child object inside a single-item property element", async () => {
    const buffer = page([
      "<Button>",
      "  <Button.Flyout>",
      "    <|",
      "  </Button.Flyout>",
      "</Button>",
    ].join("\n  "));
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("MenuFlyout"), `single-item Button.Flyout child completion should include MenuFlyout; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("outline remains usable for malformed unclosed tags", async () => {
    const buffer = page([
      "<Grid>",
      "  <StackPanel>",
      "    <Button x:Name=\"DanglingButton\"",
    ].join("\n  "));
    const names = flatten(await h.symbolsAt(buffer));
    assert.ok(names.includes("Grid"), `malformed outline should still include Grid; buffer=${buffer}; got ${names.join(" > ")}`);
    assert.ok(names.includes("StackPanel"), `malformed outline should still include StackPanel; buffer=${buffer}; got ${names.join(" > ")}`);
    assert.ok(names.some((n) => /Button/.test(n)), `malformed outline should retain the dangling Button node; buffer=${buffer}; got ${names.join(" > ")}`);
  });

  it("outline tolerates mixed text and duplicate attributes without throwing", async () => {
    const buffer = page([
      "<StackPanel>",
      "  leading text",
      "  <Button x:Name=\"DupButton\" x:Name=\"DupButtonAgain\" Content=\"Go\" />",
      "  trailing text",
      "</StackPanel>",
    ].join("\n  "));
    const names = flatten(await h.symbolsAt(buffer));
    assert.ok(names.includes("StackPanel"), `mixed-content outline should include StackPanel; buffer=${buffer}; got ${names.join(" > ")}`);
    assert.ok(names.some((n) => /Button/.test(n)), `duplicate-attribute outline should include Button; buffer=${buffer}; got ${names.join(" > ")}`);
  });

  it("flags an unknown type through a declared project namespace prefix", async () => {
    const buffer = page("<local:DefinitelyMissingControl />");
    const diags = await h.diagnosticsFor(buffer, (d) => d.some((x) => x.code === "WXAML0002"), 12000);
    const bad = diags.filter((x) => x.code === "WXAML0002");
    assert.strictEqual(bad.length, 1, `unknown local type should raise exactly one WXAML0002; buffer=${buffer}; got ${diagSummary(diags)}`);
    assert.ok(/DefinitelyMissingControl/.test(bad[0].message), `diagnostic should name the unknown local type; buffer=${buffer}; got ${bad[0].message}`);
  });

  it("flags an undeclared attribute prefix with WXAML0001", async () => {
    const buffer = page("<Button ghost:Token=\"x\" />");
    const diags = await h.diagnosticsFor(buffer, (d) => d.some((x) => x.code === "WXAML0001"), 12000);
    const bad = diags.filter((x) => x.code === "WXAML0001");
    assert.strictEqual(bad.length, 1, `undeclared attribute prefix should raise exactly one WXAML0001; buffer=${buffer}; got ${diagSummary(diags)}`);
    assert.ok(/ghost/.test(bad[0].message), `diagnostic should name the undeclared prefix; buffer=${buffer}; got ${bad[0].message}`);
  });

  it("honors child-scope xmlns redefinition for element resolution", async () => {
    const buffer = page([
      "<Grid>",
      "  <Grid xmlns:local=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\">",
      "    <local:Button Content=\"Scoped\" />",
      "  </Grid>",
      "</Grid>",
    ].join("\n  "));
    const diags = await h.diagnosticsFor(buffer, () => false, 3500);
    assert.ok(!diags.some((x) => /^WXAML/.test(String(x.code || ""))), `child xmlns redefinition should resolve local:Button as presentation Button; buffer=${buffer}; got ${diagSummary(diags)}`);
  });

  it("flags bad second-segment x:Bind members", async () => {
    // Round 16: WXAML0005 now walks dotted segments, so a bad member after a valid first segment is flagged.
    const buffer = page("<TextBlock Text=\"{x:Bind GreetingText.Nope}\" />");
    const diags = await h.diagnosticsFor(buffer, (d) => d.some((x) => x.code === "WXAML0005"), 12000);
    assert.ok(diags.some((x) => x.code === "WXAML0005" && /Nope/.test(x.message)), `bad second segment should raise WXAML0005 naming Nope; buffer=${buffer}; got ${diagSummary(diags)}`);
  });

  it("flags bad members after x:Bind indexer element resolution", async () => {
    // Round 16: the non-first walk unwraps indexer element types, so a bad tail member is flagged.
    const buffer = page("<TextBlock Text=\"{x:Bind Items[0].Nope}\" />");
    const diags = await h.diagnosticsFor(buffer, (d) => d.some((x) => x.code === "WXAML0005"), 12000);
    assert.ok(diags.some((x) => x.code === "WXAML0005" && /Nope/.test(x.message)), `bad indexer element member should raise WXAML0005 naming Nope; buffer=${buffer}; got ${diagSummary(diags)}`);
  });
});
