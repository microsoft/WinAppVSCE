"use strict";

// WinUI XAML language-feature edge cases driven through VS Code APIs.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const h = require("./helper");

const CS = "SmokePage.xaml.cs";
const APP = "App.xaml";
const XAML = "SmokePage.xaml";

function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
}

function lineOf(file, needle) {
  const text = fs.readFileSync(file, "utf8");
  const offset = text.indexOf(needle);
  assert.ok(offset >= 0, `expected ${needle} in ${file}`);
  return text.slice(0, offset).split(/\r?\n/).length - 1;
}

describe("WinUI XAML red-team — completion", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("does not offer XAML element completions inside XML comments", async () => {
    const items = await h.completionsAt(page("<Grid>\n    <!-- <But| -->\n  </Grid>"));
    assert.ok(!items.includes("Button"), `did not expect Button completion inside a comment; got ${items.slice(0, 60).join(", ")}`);
  });

  it("completes attached properties from Canvas owner", async () => {
    const items = await h.completionsAt(page("<Button Canvas.|/>"));
    assert.ok(items.includes("Canvas.Left"), `expected Canvas.Left; got ${items.slice(0, 60).join(", ")}`);
    assert.ok(items.includes("Canvas.Top"), "expected Canvas.Top");
  });

  it("completes attached properties from AutomationProperties owner", async () => {
    const items = await h.completionsAt(page("<Button AutomationProperties.|/>"));
    assert.ok(items.includes("AutomationProperties.Name"), `expected AutomationProperties.Name; got ${items.slice(0, 60).join(", ")}`);
    assert.ok(items.includes("AutomationProperties.HelpText"), "expected AutomationProperties.HelpText");
  });

  it("completes enum values for attached ScrollViewer properties", async () => {
    const items = await h.completionsAt(page('<ListView ScrollViewer.VerticalScrollBarVisibility="|" />'));
    assert.ok(items.includes("Auto"), `expected Auto; got ${items.slice(0, 60).join(", ")}`);
    assert.ok(items.includes("Disabled"), "expected Disabled");
    assert.ok(items.includes("Visible"), "expected Visible");
  });

  it("completes dotted x:Bind member paths after the first segment", async () => {
    const items = await h.completionsAt(page('<TextBlock Text="{x:Bind Items.|}" />'));
    assert.ok(items.includes("Count"), `expected Items.Count dotted x:Bind completion; got ${items.slice(0, 60).join(", ")}`);
  });

  it("completes x:Bind members from DataTemplate x:DataType", async () => {
    const items = await h.completionsAt(page([
      '<ListView ItemsSource="{x:Bind Items}">',
      '  <ListView.ItemTemplate>',
      '    <DataTemplate x:DataType="local:SmokePage">',
      '      <TextBlock Text="{x:Bind Gre|}" />',
      '    </DataTemplate>',
      '  </ListView.ItemTemplate>',
      '</ListView>',
    ].join("\n    ")));
    assert.ok(items.includes("GreetingText"), `expected GreetingText from DataTemplate x:DataType; got ${items.slice(0, 60).join(", ")}`);
  });

  it("completes x:Bind members in named Path argument", async () => {
    const items = await h.completionsAt(page('<TextBlock Text="{x:Bind Path=Gre|}" />'));
    assert.ok(items.includes("GreetingText"), `expected GreetingText for named x:Bind Path; got ${items.slice(0, 60).join(", ")}`);
  });

  it("completes x:Bind Mode values with whitespace around equals", async () => {
    const items = await h.completionsAt(page('<TextBlock Text="{x:Bind GreetingText, Mode = |}" />'));
    assert.ok(items.includes("OneTime"), `expected OneTime; got ${items.slice(0, 60).join(", ")}`);
    assert.ok(items.includes("TwoWay"), "expected TwoWay");
  });

  it("completes document-local x:Key resources before app resources", async () => {
    const items = await h.completionsAt(page([
      '<Page.Resources>',
      '  <SolidColorBrush x:Key="LocalAccentBrush" Color="Red" />',
      '</Page.Resources>',
      '<Grid Background="{StaticResource |}" />',
    ].join("\n  ")));
    assert.ok(items.includes("LocalAccentBrush"), `expected local key LocalAccentBrush; got ${items.slice(0, 80).join(", ")}`);
    assert.ok(items.includes("SmokeAccentBrush"), "expected app key SmokeAccentBrush");
  });

  it.skip("GAP: classic Binding path completion is not implemented", async () => {
    const items = await h.completionsAt(page('<TextBlock Text="{Binding Gre|}" />'));
    assert.ok(items.includes("GreetingText"));
  });
});

describe("WinUI XAML red-team — definition (F12)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("event handler definition lands on the exact code-behind method line", async () => {
    const defs = await h.definitionsAt(page('<Button Click="OnGo_Cl|ick" />'));
    assert.ok(defs.length > 0, "expected a definition");
    assert.strictEqual(path.basename(defs[0].fsPath), CS, `expected ${CS}; got ${defs[0].fsPath}`);
    assert.strictEqual(defs[0].line, 26, `expected OnGo_Click at 0-based line 26; got ${defs[0].line}`);
  });

  it("x:Bind definition still resolves when Mode is specified", async () => {
    const defs = await h.definitionsAt(page('<TextBlock Text="{x:Bind Greeting|Text, Mode=OneTime}" />'));
    assert.ok(defs.length > 0, "expected a definition");
    assert.strictEqual(path.basename(defs[0].fsPath), CS, `expected ${CS}; got ${defs[0].fsPath}`);
    assert.strictEqual(defs[0].line, 15, `expected GreetingText at 0-based line 15; got ${defs[0].line}`);
  });

  it("x:Bind definition resolves from named Path argument", async () => {
    const defs = await h.definitionsAt(page('<TextBlock Text="{x:Bind Path=Greeting|Text}" />'));
    assert.ok(defs.length > 0, "expected a definition");
    assert.strictEqual(path.basename(defs[0].fsPath), CS, `expected ${CS}; got ${defs[0].fsPath}`);
    assert.strictEqual(defs[0].line, 15, `expected GreetingText at 0-based line 15; got ${defs[0].line}`);
  });

  it("document-local StaticResource definition resolves to the same XAML buffer", async () => {
    const defs = await h.definitionsAt(page([
      '<Page.Resources>',
      '  <SolidColorBrush x:Key="LocalAccentBrush" Color="Red" />',
      '</Page.Resources>',
      '<Grid Background="{StaticResource LocalAccent|Brush}" />',
    ].join("\n  ")));
    assert.ok(defs.length > 0, "expected a definition");
    assert.strictEqual(path.basename(defs[0].fsPath), XAML, `expected ${XAML}; got ${defs[0].fsPath}`);
  });

  it("ThemeResource key definition resolves to App.xaml", async () => {
    const defs = await h.definitionsAt(page('<Grid Background="{ThemeResource SmokeAccent|Brush}" />'));
    assert.ok(defs.length > 0, "expected a definition");
    assert.strictEqual(path.basename(defs[0].fsPath), APP, `expected ${APP}; got ${defs[0].fsPath}`);
    const expectedLine = lineOf(defs[0].fsPath, 'x:Key="SmokeAccentBrush"');
    assert.strictEqual(defs[0].line, expectedLine, `expected SmokeAccentBrush at 0-based line ${expectedLine}; got ${defs[0].line}`);
  });

  it.skip("GAP: property-element F12 is not implemented", async () => {
    const defs = await h.definitionsAt(page('<Grid>\n    <Grid.RowDefi|nitions />\n  </Grid>'));
    assert.ok(defs.length > 0);
  });
});

describe("WinUI XAML red-team — hover", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("document-local StaticResource hover includes resource type and current XAML file", async () => {
    const md = await h.hoverAt(page([
      '<Page.Resources>',
      '  <SolidColorBrush x:Key="LocalAccentBrush" Color="Red" />',
      '</Page.Resources>',
      '<Grid Background="{StaticResource LocalAccent|Brush}" />',
    ].join("\n  ")));
    assert.ok(/LocalAccentBrush/.test(md), `expected local key in hover; got: ${md}`);
    assert.ok(/SolidColorBrush/.test(md), `expected SolidColorBrush in hover; got: ${md}`);
    assert.ok(/SmokePage\.xaml|Defined in this file/.test(md), `expected current-file declaration in hover; got: ${md}`);
  });
});

describe("WinUI XAML red-team — document symbols", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("includes property elements and named descendants in the outline", async () => {
    const syms = await h.symbolsAt(page([
      '<Grid x:Name="RootGrid">',
      '  <Grid.RowDefinitions>',
      '    <RowDefinition Height="Auto" />',
      '  </Grid.RowDefinitions>',
      '  <Button x:Name="GoButton" Grid.Row="0" />',
      '</Grid>',
    ].join("\n  ")));
    const names = h.flattenSymbols(syms);
    assert.ok(names.some((n) => /Grid/.test(n) && /RootGrid/.test(n)), `expected named RootGrid; got ${names.join(", ")}`);
    assert.ok(names.some((n) => /Grid\.RowDefinitions/.test(n)), `expected Grid.RowDefinitions property element; got ${names.join(", ")}`);
    assert.ok(names.some((n) => /RowDefinition/.test(n)), `expected RowDefinition child; got ${names.join(", ")}`);
    assert.ok(names.some((n) => /Button/.test(n) && /GoButton/.test(n)), `expected named GoButton; got ${names.join(", ")}`);
  });

  it("flattens children under malformed elements instead of dropping them", async () => {
    const syms = await h.symbolsAt(page("<Grid>\n    <StackPanel>\n      <Button x:Name=\"Survivor\" />\n  </Grid>"));
    const names = h.flattenSymbols(syms);
    assert.ok(names.some((n) => /Button/.test(n) && /Survivor/.test(n)), `expected malformed child Survivor to remain visible; got ${names.join(", ")}`);
  });
});

describe("WinUI XAML red-team — diagnostics", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("reports no diagnostics for valid mixed attached properties from multiple owners", async () => {
    const diags = await h.diagnosticsFor(page([
      '<Grid>',
      '  <Canvas>',
      '    <Button Grid.Row="0" Canvas.Left="12" Canvas.Top="8" />',
      '  </Canvas>',
      '  <ListView ScrollViewer.VerticalScrollBarVisibility="Auto" />',
      '</Grid>',
    ].join("\n  ")), (d) => d.length === 0, 10000);
    assert.deepStrictEqual(diags.map((d) => `${d.code}:${d.message}`), [], "expected zero diagnostics for valid attached properties");
  });

  it("reports no diagnostics for valid AutomationProperties attached attributes", async () => {
    const diags = await h.diagnosticsFor(page('<Button AutomationProperties.Name="Go" AutomationProperties.HelpText="Starts navigation" />'), (d) => d.length === 0, 10000);
    assert.deepStrictEqual(diags.map((d) => `${d.code}:${d.message}`), [], "expected zero diagnostics for valid AutomationProperties attached properties");
  });

  it("flags an unknown attached property on a resolved owner", async () => {
    const diags = await h.diagnosticsFor(
      page('<Button Canvas.NotARealProperty="1" />'),
      (d) => d.some((x) => x.code === "WXAML0004" || /NotARealProperty/.test(x.message)),
      10000
    );
    const hit = diags.find((x) => x.code === "WXAML0004" || /NotARealProperty/.test(x.message));
    assert.ok(hit, `expected WXAML0004 for Canvas.NotARealProperty; got ${JSON.stringify(diags.map((d) => `${d.code}:${d.message}`))}`);
  });

  it("reports no diagnostics for valid design-time d: attributes", async () => {
    const diags = await h.diagnosticsFor(page('<Grid d:DataContext="{d:DesignInstance Type=local:SmokePage}" d:DesignWidth="800" />'), (d) => d.length === 0, 10000);
    assert.deepStrictEqual(diags.map((d) => `${d.code}:${d.message}`), [], "expected no diagnostics for valid d: attributes");
  });

  it("does not crash or hang on an unterminated markup extension", async () => {
    const diags = await h.diagnosticsFor(page('<Grid Background="{StaticResource SmokeAccentBrush" />'), () => true, 8000);
    assert.ok(Array.isArray(diags), "expected diagnostics request to return without crashing");
  });
});
