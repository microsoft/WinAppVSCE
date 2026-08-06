"use strict";

// Round 6 red-team probes: DataTemplate x:DataType scoping to a distinct user type,
// x:Bind event-method authoring, hover/value edge cases, property-element child authoring,
// markup robustness, and outline coverage for templated content.

const assert = require("node:assert");
const path = require("node:path");
const h = require("./helper");

const CS = "SmokePage.xaml.cs";
const PAGE2_CS = "Page2.xaml.cs";
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

describe("WinUI XAML red-team 6 — DataTemplate x:DataType x:Bind scoping", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("completes x:Bind roots from DataTemplate x:DataType Page2, not the containing SmokePage", async () => {
    const items = await h.completionsAt(page([
      '<ItemsRepeater ItemsSource="{x:Bind Items}">',
      "  <ItemsRepeater.ItemTemplate>",
      '    <DataTemplate x:DataType="local:Page2">',
      '      <Button Click="{x:Bind |}" />',
      "    </DataTemplate>",
      "  </ItemsRepeater.ItemTemplate>",
      "</ItemsRepeater>",
    ].join("\n  ")));
    assert.ok(items.includes("OnBack_Click"), `expected Page2.OnBack_Click from typed DataTemplate; got ${items.slice(0, 100).join(", ")}`);
    assert.ok(!items.includes("GreetingText"), `did not expect containing SmokePage.GreetingText in Page2 DataTemplate; got ${items.slice(0, 100).join(", ")}`);
  });

  it("F12 on a DataTemplate x:Bind method path lands in Page2.xaml.cs", async () => {
    const defs = await h.definitionsAt(page([
      '<ItemsRepeater ItemsSource="{x:Bind Items}">',
      "  <ItemsRepeater.ItemTemplate>",
      '    <DataTemplate x:DataType="local:Page2">',
      '      <Button Click="{x:Bind OnBack|_Click}" />',
      "    </DataTemplate>",
      "  </ItemsRepeater.ItemTemplate>",
      "</ItemsRepeater>",
    ].join("\n  ")));
    assert.ok(defs.length > 0, `expected definition for Page2.OnBack_Click; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), PAGE2_CS, `expected ${PAGE2_CS}; got ${defs[0].fsPath}`);
    assert.strictEqual(defs[0].line, 25, `expected OnBack_Click at 0-based line 25; got ${defs[0].line}`);
  });
});

describe("WinUI XAML red-team 6 — x:Bind event-method authoring", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("completes code-behind methods inside x:Bind event attribute values", async () => {
    const items = await h.completionsAt(page('<Button Click="{x:Bind |}" />'));
    assert.ok(items.includes("OnGo_Click"), `expected SmokePage.OnGo_Click for x:Bind event binding; got ${items.slice(0, 100).join(", ")}`);
  });

  it("F12 on an x:Bind event method lands on the code-behind method", async () => {
    const defs = await h.definitionsAt(page('<Button Click="{x:Bind OnGo_Cl|ick}" />'));
    assert.ok(defs.length > 0, `expected definition for x:Bind OnGo_Click; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), CS, `expected ${CS}; got ${defs[0].fsPath}`);
    assert.strictEqual(defs[0].line, 26, `expected OnGo_Click at 0-based line 26; got ${defs[0].line}`);
  });
});

describe("WinUI XAML red-team 6 — nested x:Bind and property-element authoring", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("completes second-segment x:Bind members from the first segment CLR type", async () => {
    const items = await h.completionsAt(page('<TextBlock Text="{x:Bind GreetingText.|}" />'));
    assert.ok(items.includes("Length"), `expected String.Length after GreetingText.; got ${items.slice(0, 100).join(", ")}`);
  });

  it("completes attributes on RowDefinition inside Grid.RowDefinitions", async () => {
    const items = await h.completionsAt(page([
      "<Grid>",
      "  <Grid.RowDefinitions>",
      "    <RowDefinition | />",
      "  </Grid.RowDefinitions>",
      "</Grid>",
    ].join("\n  ")));
    assert.ok(items.includes("Height"), `expected RowDefinition.Height; got ${items.slice(0, 100).join(", ")}`);
    assert.ok(items.includes("MinHeight"), "expected RowDefinition.MinHeight");
  });

  it("completion settles for RowDefinition.Height GridLength values", async () => {
    const items = await settles(h.completionsAt(page([
      "<Grid>",
      "  <Grid.RowDefinitions>",
      '    <RowDefinition Height="|" />',
      "  </Grid.RowDefinitions>",
      "</Grid>",
    ].join("\n  "))), "completion for RowDefinition.Height");
    assert.ok(Array.isArray(items), "expected RowDefinition.Height completion to settle");
  });
});

describe("WinUI XAML red-team 6 — hover coverage", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("hover on an app StaticResource key still includes type and source", async () => {
    const md = await h.hoverAt(page('<Grid Background="{StaticResource Smoke|AccentBrush}" />'));
    assert.ok(/SmokeAccentBrush/.test(md), `expected key name in hover; got: ${md}`);
    assert.ok(/SolidColorBrush/.test(md), `expected resource type in hover; got: ${md}`);
    assert.ok(/App\.xaml/.test(md), `expected App.xaml source in hover; got: ${md}`);
  });

  it("hover on a markup-extension name settles without crashing", async () => {
    const md = await h.hoverAt(page('<TextBlock Text="{x:Bi|nd GreetingText}" />'));
    console.log("RT6 hover markup-extension x:Bind =", JSON.stringify(md));
    assert.strictEqual(typeof md, "string");
  });

  it("hover on an event-handler value settles without crashing", async () => {
    const md = await h.hoverAt(page('<Button Click="OnGo_Cl|ick" />'));
    console.log("RT6 hover event handler OnGo_Click =", JSON.stringify(md));
    assert.strictEqual(typeof md, "string");
  });

  it("hover on an enum value settles without crashing", async () => {
    const md = await h.hoverAt(page('<Button HorizontalAlignment="Cent|er" />'));
    console.log("RT6 hover enum HorizontalAlignment.Center =", JSON.stringify(md));
    assert.strictEqual(typeof md, "string");
  });
});

describe("WinUI XAML red-team 6 — x: directive values and diagnostics", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("completion in x:Name value does not offer code-behind or XAML member garbage", async () => {
    const items = await h.completionsAt(page('<Button x:Name="|" />'));
    assert.ok(!items.includes("GreetingText"), `did not expect x:Bind/code-behind members in x:Name value; got ${items.slice(0, 100).join(", ")}`);
    assert.ok(!items.includes("OnGo_Click"), "did not expect event handler names in x:Name value");
  });

  it("reports no false-positive diagnostics for duplicate x:Name beyond the conservative implemented rules", async () => {
    const diags = await h.diagnosticsFor(page([
      '<Grid x:Name="Duplicate">',
      '  <Button x:Name="Duplicate" />',
      "</Grid>",
    ].join("\n  ")), (d) => d.length === 0, 10000);
    assert.deepStrictEqual(diags.map((d) => `${d.code}:${d.message}`), [], `expected no conservative diagnostics for duplicate x:Name gap; got ${diagSummary(diags)}`);
  });
});

describe("WinUI XAML red-team 6 — markup robustness and outline", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("completion settles on deeply nested malformed markup extensions without hanging", async () => {
    await settles(h.completionsAt(page('<Border Tag="{Binding Source={StaticResource {x:Null}}, FallbackValue={x:Bind GreetingText, Mode=OneWay, Converter={StaticResource |}} trailing" />')), "completion for malformed nested markup");
  });

  it("reports a single diagnostic for unbalanced markup-extension text in an attribute value", async () => {
    const diags = await h.diagnosticsFor(page('<TextBlock Text="{x:Bind GreetingText, Mode=OneWay, FallbackValue={oops" />'), (d) => d.length === 0, 10000);
    assert.deepStrictEqual(diags.map((d) => `${d.code}:${d.message}`), ["XAML0005:Unterminated markup extension."], `expected one unterminated-markup diagnostic; got ${diagSummary(diags)}`);
  });

  it("document symbols include named elements inside DataTemplate and ControlTemplate content", async () => {
    const syms = await h.symbolsAt(page([
      "<Page.Resources>",
      '  <DataTemplate x:Key="ItemTemplate" x:DataType="local:Page2">',
      '    <StackPanel x:Name="TemplatePanel">',
      '      <Button x:Name="TemplateButton" />',
      "    </StackPanel>",
      "  </DataTemplate>",
      '  <ControlTemplate x:Key="ButtonTemplate" TargetType="Button">',
      '    <Grid x:Name="ChromeRoot" />',
      "  </ControlTemplate>",
      "</Page.Resources>",
      '<Button Template="{StaticResource ButtonTemplate}" />',
    ].join("\n  ")));
    const names = h.flattenSymbols(syms);
    assert.ok(names.some((n) => /DataTemplate/.test(n)), `expected DataTemplate symbol; got ${names.join(", ")}`);
    assert.ok(names.some((n) => /StackPanel/.test(n) && /TemplatePanel/.test(n)), `expected named DataTemplate child; got ${names.join(", ")}`);
    assert.ok(names.some((n) => /Button/.test(n) && /TemplateButton/.test(n)), `expected named DataTemplate button; got ${names.join(", ")}`);
    assert.ok(names.some((n) => /Grid/.test(n) && /ChromeRoot/.test(n)), `expected named ControlTemplate child; got ${names.join(", ")}`);
  });
});

describe("WinUI XAML red-team 6 — documented or acceptable gaps", function () {
  it.skip("GAP: RelativeSource FindAncestor AncestorType type-name completion is not implemented/validated for WinUI", async () => {});
});
