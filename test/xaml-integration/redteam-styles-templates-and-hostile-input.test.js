"use strict";

// Style/template authoring, custom controls, x:Bind, and malformed input.

const assert = require("node:assert");
const path = require("node:path");
const h = require("./helper");

const CS = "SmokePage.xaml.cs";
const APP = "App.xaml";

function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
}

function diagSummary(diags) {
  return diags.map((d) => `${d.code}:${d.message}`).join("; ");
}

async function settles(promise, label) {
  const result = await Promise.race([
    promise,
    h.delay(5000).then(() => {
      throw new Error(`${label} did not settle within 5s`);
    }),
  ]);
  assert.ok(Array.isArray(result), `${label} should resolve to an array`);
  return result;
}

describe("WinUI XAML red-team 3 — style and template authoring", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("completes control types in Style TargetType", async () => {
    const items = await h.completionsAt(page([
      "<Page.Resources>",
      '  <Style TargetType="|">',
      "    <Setter Property=\"Content\" Value=\"Go\" />",
      "  </Style>",
      "</Page.Resources>",
    ].join("\n  ")));
    assert.ok(items.includes("Button"), `expected Button in Style.TargetType completion; got ${items.slice(0, 80).join(", ")}`);
    assert.ok(items.includes("TextBlock"), "expected TextBlock in Style.TargetType completion");
  });

  it("completes Setter.Property from the containing Style TargetType", async () => {
    const items = await h.completionsAt(page([
      "<Page.Resources>",
      '  <Style TargetType="Button">',
      '    <Setter Property="|" Value="Go" />',
      "  </Style>",
      "</Page.Resources>",
    ].join("\n  ")));
    assert.ok(items.includes("Content"), `expected Button.Content in Setter.Property completion; got ${items.slice(0, 80).join(", ")}`);
    assert.ok(items.includes("IsEnabled"), "expected Button.IsEnabled in Setter.Property completion");
  });

  it("completes control types in ControlTemplate TargetType", async () => {
    const items = await h.completionsAt(page([
      "<Page.Resources>",
      '  <ControlTemplate TargetType="|">',
      "    <Grid />",
      "  </ControlTemplate>",
      "</Page.Resources>",
    ].join("\n  ")));
    assert.ok(items.includes("Button"), `expected Button in ControlTemplate.TargetType completion; got ${items.slice(0, 80).join(", ")}`);
  });

  it("completes and resolves BasedOn StaticResource style keys", async () => {
    const text = page([
      "<Page.Resources>",
      '  <Style x:Key="BaseButtonStyle" TargetType="Button">',
      '    <Setter Property="HorizontalAlignment" Value="Center" />',
      "  </Style>",
      '  <Style x:Key="DerivedButtonStyle" TargetType="Button" BasedOn="{StaticResource BaseButton|Style}" />',
      "</Page.Resources>",
      '<Button Style="{StaticResource DerivedButtonStyle}" />',
    ].join("\n  "));
    const items = await h.completionsAt(text.replace("BaseButton|Style", "|"));
    assert.ok(items.includes("BaseButtonStyle"), `expected local style key in BasedOn completion; got ${items.slice(0, 80).join(", ")}`);

    const defs = await h.definitionsAt(text);
    assert.ok(defs.length > 0, "expected BasedOn key F12 to resolve");
    assert.strictEqual(path.basename(defs[0].fsPath), "SmokePage.xaml", `expected local style definition; got ${defs[0].fsPath}`);

    const md = await h.hoverAt(text);
    assert.ok(/BaseButtonStyle/.test(md), `expected BasedOn key hover to include key; got: ${md}`);
    assert.ok(/Style/.test(md), `expected BasedOn key hover to include resource type; got: ${md}`);
  });

  it("reports no diagnostics for valid DataTemplate resources", async () => {
    const diags = await h.diagnosticsFor(page([
      "<Page.Resources>",
      '  <DataTemplate x:Key="SmokeItemTemplate" x:DataType="local:SmokePage">',
      '    <TextBlock Text="{x:Bind GreetingText}" />',
      "  </DataTemplate>",
      "</Page.Resources>",
      '<ItemsRepeater ItemsSource="{x:Bind Items}" ItemTemplate="{StaticResource SmokeItemTemplate}" />',
    ].join("\n  ")), (d) => d.length === 0, 10000);
    assert.deepStrictEqual(diags.map((d) => `${d.code}:${d.message}`), [], `expected zero diagnostics for valid DataTemplate; got ${diagSummary(diags)}`);
  });
});

describe("WinUI XAML red-team 3 — hostile input robustness", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("completion settles on an unclosed attribute value containing a lone markup brace", async () => {
    const items = await settles(h.completionsAt(page('<Button Content="{|')), "completion for lone brace");
    assert.ok(items.includes("x:Bind") || items.length === 0, `expected sane markup-name completions or no completions; got ${items.slice(0, 40).join(", ")}`);
  });

  it("diagnostics settle on a document that is only a less-than sign", async () => {
    await settles(h.diagnosticsFor("<|", undefined, 1000), "diagnostics for lone <");
  });

  it("symbols settle on a very long single-line attribute value", async () => {
    const huge = "x".repeat(30000);
    await settles(h.symbolsAt(page(`<Button Content="${huge}" />`)), "symbols for huge single line");
  });
});

describe("WinUI XAML red-team 3 — awkward attribute completion positions", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("completes attributes between existing attributes in a start tag", async () => {
    const items = await h.completionsAt(page('<Button Content="x" | Click="OnGo_Click" />'));
    assert.ok(items.includes("IsEnabled"), `expected IsEnabled between existing attributes; got ${items.slice(0, 80).join(", ")}`);
    assert.ok(!items.includes("Content"), "did not expect duplicate Content suggestion");
    assert.ok(!items.includes("Click"), "did not expect duplicate Click suggestion");
  });

  it("completes attributes after a namespaced user-control element name", async () => {
    const items = await h.completionsAt(page("<local:SmokePage |/>"));
    assert.ok(items.includes("NavigationCacheMode"), `expected inherited Page property on local:SmokePage; got ${items.slice(0, 80).join(", ")}`);
    assert.ok(items.includes("DataContext"), "expected inherited FrameworkElement property on local:SmokePage");
  });
});

describe("WinUI XAML red-team 3 — custom namespace and x:DataType", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("completes user controls in a using: namespace", async () => {
    const items = await h.completionsAt(page("<local:|"));
    assert.ok(items.includes("SmokePage"), `expected SmokePage in local namespace completion; got ${items.slice(0, 80).join(", ")}`);
    assert.ok(items.includes("Page2"), "expected Page2 in local namespace completion");
  });

  it("F12 on a user-control element name navigates to its source", async () => {
    const defs = await h.definitionsAt(page("<local:Smoke|Page />"));
    assert.ok(defs.length > 0, "expected definition for local:SmokePage");
    assert.strictEqual(path.basename(defs[0].fsPath), CS, `expected ${CS}; got ${defs[0].fsPath}`);
  });

  it("completes x:Bind members inside a DataTemplate with user x:DataType", async () => {
    const items = await h.completionsAt(page([
      '<ItemsRepeater ItemsSource="{x:Bind Items}">',
      "  <ItemsRepeater.ItemTemplate>",
      '    <DataTemplate x:DataType="local:SmokePage">',
      '      <TextBlock Text="{x:Bind Gre|}" />',
      "    </DataTemplate>",
      "  </ItemsRepeater.ItemTemplate>",
      "</ItemsRepeater>",
    ].join("\n  ")));
    assert.ok(items.includes("GreetingText"), `expected SmokePage.GreetingText in typed DataTemplate x:Bind; got ${items.slice(0, 80).join(", ")}`);
  });
});

describe("WinUI XAML red-team 3 — documented gaps", function () {
  it.skip("GAP: classic Binding Path completion still needs DataContext inference", async () => {});
  it.skip("GAP: F12 on Grid.RowDefinitions property-element names is not implemented", async () => {});
});
