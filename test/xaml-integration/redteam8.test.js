"use strict";

// Round 8 red-team probes: hover affordances on markup/enum values, nested template scoping,
// element-local resources, attached-property authoring, and x:Bind/Binding consistency edges.

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

describe("WinUI XAML red-team 8 — hover on authoring values", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("hover on x:Bind markup-extension name describes the extension", async () => {
    const buffer = page('<TextBlock Text="{x:Bi|nd GreetingText}" />');
    const md = await h.hoverAt(buffer);
    assert.ok(/x:Bind/i.test(md), `x:Bind extension-name hover should identify x:Bind; buffer=${buffer}; got: ${md}`);
    assert.ok(/bind|binding|compiled/i.test(md), `x:Bind extension-name hover should explain binding semantics; buffer=${buffer}; got: ${md}`);
  });

  it("hover on StaticResource markup-extension name describes resource lookup", async () => {
    const buffer = page('<Grid Background="{StaticR|esource SmokeAccentBrush}" />');
    const md = await h.hoverAt(buffer);
    assert.ok(/StaticResource/i.test(md), `StaticResource extension-name hover should identify StaticResource; buffer=${buffer}; got: ${md}`);
    assert.ok(/resource/i.test(md), `StaticResource extension-name hover should explain resource lookup; buffer=${buffer}; got: ${md}`);
  });

  it("hover on enum attribute value identifies the enum member", async () => {
    const buffer = page('<Button HorizontalAlignment="Cent|er" />');
    const md = await h.hoverAt(buffer);
    assert.ok(/HorizontalAlignment/i.test(md), `enum value hover should include the enum type; buffer=${buffer}; got: ${md}`);
    assert.ok(/Center/i.test(md), `enum value hover should include the selected enum member; buffer=${buffer}; got: ${md}`);
  });

  it("hover on x:Bind Mode enum value identifies BindingMode.OneWay", async () => {
    const buffer = page('<TextBlock Text="{x:Bind GreetingText, Mode=One|Way}" />');
    const md = await h.hoverAt(buffer);
    assert.ok(/BindingMode|Mode/i.test(md), `x:Bind Mode value hover should include BindingMode/Mode; buffer=${buffer}; got: ${md}`);
    assert.ok(/OneWay/i.test(md), `x:Bind Mode value hover should include OneWay; buffer=${buffer}; got: ${md}`);
  });
});

describe("WinUI XAML red-team 8 — nested DataTemplate scoping", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("inner DataTemplate x:DataType shadows the outer template for x:Bind completion", async () => {
    // Hermetic on purpose: no outer x:Bind mentions SmokePage members, so VS Code's word-based
    // suggestions can't surface "GreetingText" from the buffer text — the negative assertion then
    // reflects only the server's scoping (the inner x:String must shadow the outer SmokePage).
    const buffer = page([
      "<ListView>",
      "  <ListView.ItemTemplate>",
      '    <DataTemplate x:DataType="local:SmokePage">',
      "      <StackPanel>",
      "        <StackPanel.Resources>",
      '          <DataTemplate x:Key="StringTemplate" x:DataType="x:String">',
      '            <TextBlock Text="{x:Bind |}" />',
      "          </DataTemplate>",
      "        </StackPanel.Resources>",
      "      </StackPanel>",
      "    </DataTemplate>",
      "  </ListView.ItemTemplate>",
      "</ListView>",
    ].join("\n  "));
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("Length"), `inner x:String DataTemplate should complete String.Length; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
    assert.ok(!items.includes("GreetingText"), `inner x:String DataTemplate should not leak outer SmokePage.GreetingText; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("inner DataTemplate invalid x:Bind member is diagnosed against the inner x:DataType", async () => {
    const buffer = page([
      '<ListView ItemsSource="{x:Bind Items}">',
      "  <ListView.ItemTemplate>",
      '    <DataTemplate x:DataType="local:SmokePage">',
      "      <StackPanel>",
      '        <DataTemplate x:DataType="x:String">',
      '          <TextBlock Text="{x:Bind GreetingText}" />',
      "        </DataTemplate>",
      "      </StackPanel>",
      "    </DataTemplate>",
      "  </ListView.ItemTemplate>",
      "</ListView>",
    ].join("\n  "));
    const diags = await h.diagnosticsFor(
      buffer,
      (d) => d.some((x) => x.code === "WXAML0005" && /GreetingText/.test(x.message)),
      12000
    );
    const hit = diags.find((x) => x.code === "WXAML0005" && /GreetingText/.test(x.message));
    assert.ok(hit, `inner x:String template should diagnose GreetingText as missing; buffer=${buffer}; got ${diagSummary(diags)}`);
  });
});

describe("WinUI XAML red-team 8 — element-local resources", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("completes StaticResource keys declared in Grid.Resources", async () => {
    const buffer = page([
      "<Grid>",
      "  <Grid.Resources>",
      '    <SolidColorBrush x:Key="GridLocalBrush" Color="Purple" />',
      "  </Grid.Resources>",
      '  <Border Background="{StaticResource |}" />',
      "</Grid>",
    ].join("\n  "));
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("GridLocalBrush"), `StaticResource completion should include Grid.Resources key; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("F12 on a StaticResource key declared in Grid.Resources lands on the x:Key", async () => {
    const buffer = page([
      "<Grid>",
      "  <Grid.Resources>",
      '    <SolidColorBrush x:Key="GridLocalBrush" Color="Purple" />',
      "  </Grid.Resources>",
      '  <Border Background="{StaticResource GridLocal|Brush}" />',
      "</Grid>",
    ].join("\n  "));
    const defs = await h.definitionsAt(buffer);
    assert.ok(defs.length > 0, `Grid.Resources StaticResource should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), XAML, `expected ${XAML}; buffer=${buffer}; got ${defs[0].fsPath}`);
    assert.strictEqual(defs[0].line, 9, `expected GridLocalBrush x:Key at 0-based line 9; buffer=${buffer}; got ${defs[0].line}`);
  });

  it("hover on a StaticResource key declared in Grid.Resources includes type and current file", async () => {
    const buffer = page([
      "<Grid>",
      "  <Grid.Resources>",
      '    <SolidColorBrush x:Key="GridLocalBrush" Color="Purple" />',
      "  </Grid.Resources>",
      '  <Border Background="{StaticResource GridLocal|Brush}" />',
      "</Grid>",
    ].join("\n  "));
    const md = await h.hoverAt(buffer);
    assert.ok(/GridLocalBrush/.test(md), `Grid.Resources hover should include key name; buffer=${buffer}; got: ${md}`);
    assert.ok(/SolidColorBrush/.test(md), `Grid.Resources hover should include resource type; buffer=${buffer}; got: ${md}`);
    assert.ok(/SmokePage\.xaml|Defined in this file/.test(md), `Grid.Resources hover should include current-file source; buffer=${buffer}; got: ${md}`);
  });
});

describe("WinUI XAML red-team 8 — attached properties and x:Bind consistency", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("completes ToolTipService attached properties from the owner prefix", async () => {
    const buffer = page("<Button ToolTipService.|/>");
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("ToolTipService.ToolTip"), `expected ToolTipService.ToolTip completion; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
    assert.ok(items.includes("ToolTipService.Placement"), `expected ToolTipService.Placement completion; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("reports no diagnostics for valid ToolTipService and Grid.RowSpan attached attributes", async () => {
    const buffer = page([
      "<Grid>",
      '  <Button Grid.RowSpan="2" ToolTipService.ToolTip="Go" AutomationProperties.Name="Go button" />',
      "</Grid>",
    ].join("\n  "));
    const diags = await h.diagnosticsFor(buffer, (d) => d.length === 0, 10000);
    assert.deepStrictEqual(diags.map((d) => `${d.code}:${d.message}`), [], `valid attached attributes should stay silent; buffer=${buffer}; got ${diagSummary(diags)}`);
  });

  it("keeps x:Bind argument-name completion after Converter and ConverterParameter", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <SolidColorBrush x:Key="DummyConverter" Color="Red" />',
      "</Page.Resources>",
      '<TextBlock Text="{x:Bind GreetingText, Converter={StaticResource DummyConverter}, ConverterParameter=abc, |}" />',
    ].join("\n  "));
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("Mode"), `x:Bind named-arg completion should still include Mode after ConverterParameter; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
    assert.ok(items.includes("FallbackValue"), `x:Bind named-arg completion should still include FallbackValue after ConverterParameter; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
    assert.ok(items.includes("TargetNullValue"), `x:Bind named-arg completion should still include TargetNullValue after ConverterParameter; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("classic Binding missing path does not get x:Bind missing-member diagnostics", async () => {
    const buffer = page('<TextBlock Text="{Binding DefinitelyMissingMember}" />');
    const diags = await h.diagnosticsFor(buffer, () => false, 10000);
    const bad = diags.find((x) => x.code === "WXAML0005" || /x:Bind|DefinitelyMissingMember/.test(x.message));
    assert.ok(!bad, `classic Binding path should not be validated as x:Bind; buffer=${buffer}; got ${diagSummary(diags)}`);
  });

  it("x:Bind missing first segment is diagnosed even when named arguments follow", async () => {
    const buffer = page('<TextBlock Text="{x:Bind DefinitelyMissingMember, Mode=OneWay, FallbackValue=Fallback}" />');
    const diags = await h.diagnosticsFor(
      buffer,
      (d) => d.some((x) => x.code === "WXAML0005" && /DefinitelyMissingMember/.test(x.message)),
      12000
    );
    const hit = diags.find((x) => x.code === "WXAML0005" && /DefinitelyMissingMember/.test(x.message));
    assert.ok(hit, `x:Bind missing first segment should still be diagnosed with named args; buffer=${buffer}; got ${diagSummary(diags)}`);
  });
});

describe("WinUI XAML red-team 8 — documented or acceptable gaps", function () {
  it.skip("GAP: RelativeSource FindAncestor AncestorType type-name completion remains unimplemented for WinUI", async () => {});
  it.skip("GAP: framework metadata-as-source F12 for Grid/Button remains unavailable", async () => {});
});
