"use strict";

// Style/resource authoring, x:Bind paths, whitespace, and value completion.

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

describe("WinUI XAML red-team 9 — style resource authoring", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("completes page-local Style keys in Style.BasedOn StaticResource", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <Style x:Key="BaseButtonStyle" TargetType="Button" />',
      "</Page.Resources>",
      '<Style TargetType="Button" BasedOn="{StaticResource |}" />',
    ].join("\n  "));
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("BaseButtonStyle"), `BasedOn should complete page-local style key; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("F12 on Style.BasedOn StaticResource lands on the local Style x:Key", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <Style x:Key="BaseButtonStyle" TargetType="Button" />',
      "</Page.Resources>",
      '<Style TargetType="Button" BasedOn="{StaticResource BaseButton|Style}" />',
    ].join("\n  "));
    const defs = await h.definitionsAt(buffer);
    assert.ok(defs.length > 0, `BasedOn StaticResource should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), XAML, `expected ${XAML}; buffer=${buffer}; got ${defs[0].fsPath}`);
    assert.strictEqual(defs[0].line, 8, `expected BaseButtonStyle x:Key at 0-based line 8; buffer=${buffer}; got ${defs[0].line}`);
  });

  it("hover on Style.BasedOn StaticResource identifies the Style resource", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <Style x:Key="BaseButtonStyle" TargetType="Button" />',
      "</Page.Resources>",
      '<Style TargetType="Button" BasedOn="{StaticResource BaseButton|Style}" />',
    ].join("\n  "));
    const md = await h.hoverAt(buffer);
    assert.ok(/BaseButtonStyle/.test(md), `BasedOn hover should include resource key; buffer=${buffer}; got: ${md}`);
    assert.ok(/Style/.test(md), `BasedOn hover should include resource type; buffer=${buffer}; got: ${md}`);
  });

  it("completes enum values for Setter.Value when Setter.Property targets an inherited property", async () => {
    const buffer = page([
      '<Style TargetType="Button">',
      '  <Setter Property="HorizontalAlignment" Value="|" />',
      "</Style>",
    ].join("\n  "));
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("Center"), `Setter.Value should complete HorizontalAlignment.Center; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
    assert.ok(items.includes("Stretch"), `Setter.Value should complete HorizontalAlignment.Stretch; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("completes attached properties inside Setter.Property", async () => {
    const buffer = page([
      '<Style TargetType="Button">',
      '  <Setter Property="Grid.|" Value="1" />',
      "</Style>",
    ].join("\n  "));
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("Grid.Row"), `Setter.Property should complete Grid.Row attached property; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
    assert.ok(items.includes("Grid.Column"), `Setter.Property should complete Grid.Column attached property; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });
});

describe("WinUI XAML red-team 9 — deeper resource dictionaries", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("completes keys declared inside ResourceDictionary.MergedDictionaries", async () => {
    const buffer = page([
      "<Page.Resources>",
      "  <ResourceDictionary>",
      "    <ResourceDictionary.MergedDictionaries>",
      "      <ResourceDictionary>",
      '        <SolidColorBrush x:Key="MergedBrush" Color="Orange" />',
      "      </ResourceDictionary>",
      "    </ResourceDictionary.MergedDictionaries>",
      "  </ResourceDictionary>",
      "</Page.Resources>",
      '<Border Background="{StaticResource |}" />',
    ].join("\n  "));
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("MergedBrush"), `StaticResource completion should include merged dictionary key; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("F12 resolves keys declared inside ResourceDictionary.MergedDictionaries", async () => {
    const buffer = page([
      "<Page.Resources>",
      "  <ResourceDictionary>",
      "    <ResourceDictionary.MergedDictionaries>",
      "      <ResourceDictionary>",
      '        <SolidColorBrush x:Key="MergedBrush" Color="Orange" />',
      "      </ResourceDictionary>",
      "    </ResourceDictionary.MergedDictionaries>",
      "  </ResourceDictionary>",
      "</Page.Resources>",
      '<Border Background="{StaticResource Merged|Brush}" />',
    ].join("\n  "));
    const defs = await h.definitionsAt(buffer);
    assert.ok(defs.length > 0, `merged dictionary StaticResource should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), XAML, `expected ${XAML}; buffer=${buffer}; got ${defs[0].fsPath}`);
    assert.strictEqual(defs[0].line, 11, `expected MergedBrush x:Key at 0-based line 11; buffer=${buffer}; got ${defs[0].line}`);
  });

  it("completes keys declared in ThemeDictionaries", async () => {
    const buffer = page([
      "<Page.Resources>",
      "  <ResourceDictionary>",
      "    <ResourceDictionary.ThemeDictionaries>",
      '      <ResourceDictionary x:Key="Default">',
      '        <SolidColorBrush x:Key="ThemeLocalBrush" Color="Green" />',
      "      </ResourceDictionary>",
      "    </ResourceDictionary.ThemeDictionaries>",
      "  </ResourceDictionary>",
      "</Page.Resources>",
      '<Border Background="{ThemeResource |}" />',
    ].join("\n  "));
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("ThemeLocalBrush"), `ThemeResource completion should include ThemeDictionaries key; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });
});

describe("WinUI XAML red-team 9 — x:Bind and authoring edge cases", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("completes String members after an x:Bind second segment", async () => {
    const buffer = page('<TextBlock Text="{x:Bind GreetingText.|}" />');
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("Length"), `x:Bind second-segment completion should include String.Length; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("hover on an x:Bind second segment identifies String.Length", async () => {
    const buffer = page('<TextBlock Text="{x:Bind GreetingText.Len|gth}" />');
    const md = await h.hoverAt(buffer);
    assert.ok(/Length/.test(md), `x:Bind second-segment hover should include Length; buffer=${buffer}; got: ${md}`);
    assert.ok(/int|Int32|System\.Int32/.test(md), `x:Bind second-segment hover should include the Length type; buffer=${buffer}; got: ${md}`);
  });

  it("F12 resolves event handler values with surrounding whitespace", async () => {
    const buffer = page('<Button Click="  OnGo_|Click  " />');
    const defs = await h.definitionsAt(buffer);
    assert.ok(defs.length > 0, `event handler with surrounding whitespace should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), CS, `expected ${CS}; buffer=${buffer}; got ${defs[0].fsPath}`);
    assert.strictEqual(defs[0].line, 26, `expected OnGo_Click at 0-based line 26; buffer=${buffer}; got ${defs[0].line}`);
  });

  it("does not offer enum or boolean value completions for integer Grid.Row", async () => {
    const buffer = page([
      "<Grid>",
      '  <Button Grid.Row="|" />',
      "</Grid>",
    ].join("\n  "));
    const items = await h.completionsAt(buffer);
    assert.ok(!items.includes("True") && !items.includes("False"), `Grid.Row should not get boolean value completions; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
    assert.ok(!items.includes("Center") && !items.includes("OneWay"), `Grid.Row should not get enum value completions from unrelated contexts; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("reports no XAML diagnostics for valid x:Uid and x:Name directives", async () => {
    const buffer = page('<Button x:Name="GoButton" x:Uid="GoButton" Content="Go" />');
    const diags = await h.diagnosticsFor(buffer, () => false, 10000);
    const bad = diags.find((x) => /^WXAML/.test(String(x.code || "")));
    assert.ok(!bad, `valid x:Uid/x:Name directives should stay silent; buffer=${buffer}; got ${diagSummary(diags)}`);
  });
});

describe("WinUI XAML red-team 9 — documented or acceptable gaps", function () {
  it.skip("GAP: classic Binding path completion still requires DataContext type inference", async () => {});
  it.skip("GAP: framework metadata-as-source F12 for Setter.Property framework members remains unavailable", async () => {});
});
