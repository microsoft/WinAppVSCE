"use strict";

// Additional red-team probes focused on nested markup extensions and diagnostic false positives in
// valid WinUI XAML patterns that real developers type in VS Code.

const assert = require("node:assert");
const path = require("node:path");
const h = require("./helper");

const APP = "App.xaml";
const XAML = "SmokePage.xaml";

function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
}

function diagSummary(diags) {
  return diags.map((d) => `${d.code}:${d.message}`).join("; ");
}

describe("WinUI XAML red-team 2 — nested markup extensions", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("completes resource keys inside a nested Binding Source StaticResource", async () => {
    const items = await h.completionsAt(page('<Border Tag="{Binding Source={StaticResource |}}" />'));
    assert.ok(items.includes("SmokeAccentBrush"), `expected app resource key in nested StaticResource; got ${items.slice(0, 80).join(", ")}`);
  });

  it("F12 on a nested Binding Source StaticResource key resolves to App.xaml", async () => {
    const defs = await h.definitionsAt(page('<Border Tag="{Binding Source={StaticResource SmokeAccent|Brush}}" />'));
    assert.ok(defs.length > 0, "expected a definition for nested StaticResource key");
    assert.strictEqual(path.basename(defs[0].fsPath), APP, `expected ${APP}; got ${defs[0].fsPath}`);
    assert.strictEqual(defs[0].line, 13, `expected SmokeAccentBrush at 0-based line 13; got ${defs[0].line}`);
  });

  it("hover on a nested Binding Source StaticResource key describes the resource", async () => {
    const md = await h.hoverAt(page('<Border Tag="{Binding Source={StaticResource SmokeAccent|Brush}}" />'));
    assert.ok(/SmokeAccentBrush/.test(md), `expected key name in nested StaticResource hover; got: ${md}`);
    assert.ok(/SolidColorBrush/.test(md), `expected resource type in nested StaticResource hover; got: ${md}`);
  });

  it("F12 targets the inner StaticResource key, not the outer Binding expression", async () => {
    const defs = await h.definitionsAt(page([
      '<Page.Resources>',
      '  <SolidColorBrush x:Key="LocalNestedBrush" Color="Red" />',
      '</Page.Resources>',
      '<Border Tag="{Binding Source={StaticResource LocalNested|Brush}}" />',
    ].join("\n  ")));
    assert.ok(defs.length > 0, "expected a definition for inner resource key");
    assert.strictEqual(path.basename(defs[0].fsPath), XAML, `expected inner resource to resolve to ${XAML}; got ${defs[0].fsPath}`);
  });
});

describe("WinUI XAML red-team 2 — completion contexts", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("completes RowDefinition inside Grid.RowDefinitions property element", async () => {
    const items = await h.completionsAt(page('<Grid>\n    <Grid.RowDefinitions>\n      <|\n    </Grid.RowDefinitions>\n  </Grid>'));
    assert.ok(items.includes("RowDefinition"), `expected RowDefinition child completion inside Grid.RowDefinitions; got ${items.slice(0, 80).join(", ")}`);
  });

  it("does not offer XAML element completions inside CDATA", async () => {
    const items = await h.completionsAt(page("<Grid>\n    <![CDATA[ <But| ]]>\n  </Grid>"));
    assert.ok(!items.includes("Button"), `did not expect Button completion inside CDATA; got ${items.slice(0, 80).join(", ")}`);
  });
});

describe("WinUI XAML red-team 2 — graceful no-result positions", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("F12 inside a comment returns no definitions without throwing", async () => {
    const defs = await h.definitionsAt(page("<Grid>\n    <!-- {StaticResource SmokeAccent|Brush} -->\n  </Grid>"));
    assert.deepStrictEqual(defs, [], `expected no definitions in comment; got ${JSON.stringify(defs)}`);
  });

  it("hover on an x: directive returns no crash and no bogus code-behind member", async () => {
    const md = await h.hoverAt(page('<Button x:Na|me="GoButton" />'));
    assert.ok(!/GreetingText|OnGo_Click/.test(md), `unexpected code-behind hover on x:Name directive: ${md}`);
  });
});

describe("WinUI XAML red-team 2 — diagnostics false positives", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("reports no diagnostics for valid Style and Setter resources", async () => {
    const diags = await h.diagnosticsFor(page([
      '<Page.Resources>',
      '  <Style x:Key="GoButtonStyle" TargetType="Button">',
      '    <Setter Property="Content" Value="Go" />',
      '    <Setter Property="HorizontalAlignment" Value="Center" />',
      '  </Style>',
      '</Page.Resources>',
      '<Button Style="{StaticResource GoButtonStyle}" />',
    ].join("\n  ")), (d) => d.length === 0, 10000);
    assert.deepStrictEqual(diags.map((d) => `${d.code}:${d.message}`), [], `expected zero diagnostics for valid Style/Setter; got ${diagSummary(diags)}`);
  });

  it("reports no diagnostics for valid ResourceDictionary MergedDictionaries", async () => {
    const diags = await h.diagnosticsFor(page([
      '<Page.Resources>',
      '  <ResourceDictionary>',
      '    <ResourceDictionary.MergedDictionaries>',
      '      <XamlControlsResources xmlns="using:Microsoft.UI.Xaml.Controls" />',
      '      <ResourceDictionary>',
      '        <SolidColorBrush x:Key="NestedBrush" Color="Red" />',
      '      </ResourceDictionary>',
      '    </ResourceDictionary.MergedDictionaries>',
      '  </ResourceDictionary>',
      '</Page.Resources>',
      '<Grid Background="{StaticResource NestedBrush}" />',
    ].join("\n  ")), (d) => d.length === 0, 10000);
    assert.deepStrictEqual(diags.map((d) => `${d.code}:${d.message}`), [], `expected zero diagnostics for valid merged dictionaries; got ${diagSummary(diags)}`);
  });

  it("reports no diagnostics for valid control templates and visual states", async () => {
    const diags = await h.diagnosticsFor(page([
      '<Page.Resources>',
      '  <Style x:Key="TemplatedButtonStyle" TargetType="Button">',
      '    <Setter Property="Template">',
      '      <Setter.Value>',
      '        <ControlTemplate TargetType="Button">',
      '          <Grid>',
      '            <VisualStateManager.VisualStateGroups>',
      '              <VisualStateGroup x:Name="CommonStates">',
      '                <VisualState x:Name="Normal" />',
      '                <VisualState x:Name="PointerOver" />',
      '              </VisualStateGroup>',
      '            </VisualStateManager.VisualStateGroups>',
      '            <ContentPresenter Content="{TemplateBinding Content}" />',
      '          </Grid>',
      '        </ControlTemplate>',
      '      </Setter.Value>',
      '    </Setter>',
      '  </Style>',
      '</Page.Resources>',
      '<Button Style="{StaticResource TemplatedButtonStyle}" />',
    ].join("\n  ")), (d) => d.length === 0, 10000);
    assert.deepStrictEqual(diags.map((d) => `${d.code}:${d.message}`), [], `expected zero diagnostics for valid template/VSM XAML; got ${diagSummary(diags)}`);
  });

  it("reports no diagnostics for common x: directives and event handlers", async () => {
    const diags = await h.diagnosticsFor(page('<Button x:Name="GoButton" x:Uid="GoButton" x:FieldModifier="public" Click="OnGo_Click" />'), (d) => d.length === 0, 10000);
    assert.deepStrictEqual(diags.map((d) => `${d.code}:${d.message}`), [], `expected zero diagnostics for valid x: directives and event handler; got ${diagSummary(diags)}`);
  });

  it("reports no diagnostics for a valid custom namespace element", async () => {
    const diags = await h.diagnosticsFor(page('<Grid>\n    <local:SmokePage />\n  </Grid>'), (d) => d.length === 0, 10000);
    assert.deepStrictEqual(diags.map((d) => `${d.code}:${d.message}`), [], `expected zero diagnostics for valid local:SmokePage element; got ${diagSummary(diags)}`);
  });
});
