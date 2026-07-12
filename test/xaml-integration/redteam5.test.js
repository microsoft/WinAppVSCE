"use strict";

// Round 5 red-team probes: RelativeSource/value completion, event-handler authoring,
// template type navigation, and markup-extension robustness in realistic WinUI contexts.

const assert = require("node:assert");
const path = require("node:path");
const h = require("./helper");

const CS = "SmokePage.xaml.cs";

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

describe("WinUI XAML red-team 5 — RelativeSource authoring", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("completes RelativeSource named arguments", async () => {
    const items = await h.completionsAt(page('<Border Tag="{RelativeSource |}" />'));
    assert.ok(items.includes("Mode"), `expected RelativeSource argument Mode; got ${items.slice(0, 80).join(", ")}`);
  });

  it("completes RelativeSource Mode values", async () => {
    const items = await h.completionsAt(page('<Border Tag="{RelativeSource Mode=|}" />'));
    assert.ok(items.includes("Self"), `expected RelativeSourceMode.Self; got ${items.slice(0, 80).join(", ")}`);
    assert.ok(items.includes("TemplatedParent"), "expected RelativeSourceMode.TemplatedParent");
  });

  it("completes RelativeSource Mode values when nested inside Binding.RelativeSource", async () => {
    const items = await h.completionsAt(page('<Border Tag="{Binding RelativeSource={RelativeSource Mode=|}}" />'));
    assert.ok(items.includes("Self"), `expected nested RelativeSourceMode.Self; got ${items.slice(0, 80).join(", ")}`);
    assert.ok(items.includes("TemplatedParent"), "expected nested RelativeSourceMode.TemplatedParent");
  });
});

describe("WinUI XAML red-team 5 — high-value value completions", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("completes event handler method names in event attribute values", async () => {
    const items = await h.completionsAt(page('<Button Click="|" />'));
    assert.ok(items.includes("OnGo_Click"), `expected code-behind event handler OnGo_Click; got ${items.slice(0, 80).join(", ")}`);
  });

  it("completes StaticResource keys inside Setter.Value attributes", async () => {
    const items = await h.completionsAt(page([
      "<Page.Resources>",
      '  <Style TargetType="Button">',
      '    <Setter Property="Background" Value="{StaticResource |}" />',
      "  </Style>",
      "</Page.Resources>",
    ].join("\n  ")));
    assert.ok(items.includes("SmokeAccentBrush"), `expected app resource key in Setter.Value StaticResource; got ${items.slice(0, 80).join(", ")}`);
  });

  it("completes StaticResource keys inside x:Bind Converter markup", async () => {
    const items = await h.completionsAt(page('<TextBlock Text="{x:Bind GreetingText, Converter={StaticResource |}}" />'));
    assert.ok(items.includes("SmokeAccentBrush"), `expected app resource key inside x:Bind Converter StaticResource; got ${items.slice(0, 80).join(", ")}`);
  });
});

describe("WinUI XAML red-team 5 — DataTemplate type navigation", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("F12 on DataTemplate x:DataType navigates to the user type source", async () => {
    const defs = await h.definitionsAt(page([
      '<ItemsRepeater ItemsSource="{x:Bind Items}">',
      "  <ItemsRepeater.ItemTemplate>",
      '    <DataTemplate x:DataType="local:Smoke|Page">',
      '      <TextBlock Text="{x:Bind GreetingText}" />',
      "    </DataTemplate>",
      "  </ItemsRepeater.ItemTemplate>",
      "</ItemsRepeater>",
    ].join("\n  ")));
    assert.ok(defs.length > 0, "expected definition for local:SmokePage inside x:DataType");
    assert.strictEqual(path.basename(defs[0].fsPath), CS, `expected ${CS}; got ${defs[0].fsPath}`);
  });
});

describe("WinUI XAML red-team 5 — markup robustness and diagnostics", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("does not treat a XAML escape literal as a markup-extension completion context", async () => {
    const items = await h.completionsAt(page('<TextBlock Text="{}{not markup |}" />'));
    assert.ok(!items.includes("x:Bind"), `did not expect markup-extension names inside escaped literal; got ${items.slice(0, 80).join(", ")}`);
    assert.ok(!items.includes("StaticResource"), "did not expect StaticResource inside escaped literal");
  });

  it("completion settles on a multi-line markup extension", async () => {
    const items = await settles(h.completionsAt(page('<Grid Background="{StaticResource\n    |}" />')), "completion for multi-line StaticResource");
    assert.ok(items.includes("SmokeAccentBrush"), `expected app resource key in multi-line StaticResource; got ${items.slice(0, 80).join(", ")}`);
  });

  it("reports no diagnostics for implicit Style.Setters collection syntax", async () => {
    const diags = await h.diagnosticsFor(page([
      "<Page.Resources>",
      '  <Style TargetType="Button">',
      "    <Style.Setters>",
      '      <Setter Property="Content" Value="Go" />',
      '      <Setter Property="Background" Value="{StaticResource SmokeAccentBrush}" />',
      "    </Style.Setters>",
      "  </Style>",
      "</Page.Resources>",
      "<Button />",
    ].join("\n  ")), (d) => d.length === 0, 10000);
    assert.deepStrictEqual(diags.map((d) => `${d.code}:${d.message}`), [], `expected zero diagnostics for implicit Style.Setters; got ${diagSummary(diags)}`);
  });
});

describe("WinUI XAML red-team 5 — documented gaps", function () {
  it.skip("GAP: x:Static/x:Type member/type completion is not implemented yet", async () => {});
});
