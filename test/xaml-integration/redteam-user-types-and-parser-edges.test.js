"use strict";

// User-type authoring and parser edge cases. Completion checks avoid VS Code word-suggestion conflicts.

const assert = require("node:assert");
const path = require("node:path");
const h = require("./helper");

const CS = "SmokePage.xaml.cs";
const PAGE2_CS = "Page2.xaml.cs";
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

describe("WinUI XAML red-team 12 — user types and validation edges", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("completes inherited Page attributes on a custom local element", async () => {
    const buffer = page("<local:Page2 | />");
    const items = await h.completionsAt(buffer);
    assert.ok(
      items.includes("NavigationCacheMode"),
      `local:Page2 should complete inherited Page.NavigationCacheMode; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`
    );
  });

  it("F12 on a custom local element resolves to the user type source", async () => {
    const buffer = page("<local:Pa|ge2 />");
    const defs = await h.definitionsAt(buffer);
    assert.ok(defs.length > 0, `local:Page2 element should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), PAGE2_CS, `expected ${PAGE2_CS}; buffer=${buffer}; got ${defs[0].fsPath}`);
  });

  it("hover on a custom local element identifies the user type", async () => {
    const buffer = page("<local:Pa|ge2 />");
    const md = await h.hoverAt(buffer);
    assert.ok(/Page2/.test(md), `local:Page2 hover should mention Page2; buffer=${buffer}; got: ${md}`);
    assert.ok(/SmokeFixture/.test(md), `local:Page2 hover should mention namespace; buffer=${buffer}; got: ${md}`);
  });

  it("flags an unknown attribute on a custom local element", async () => {
    const buffer = page('<local:Page2 DefinitelyNotARealPageProperty="x" />');
    const diags = await h.diagnosticsFor(buffer, (d) => d.some((x) => x.code === "WXAML0003"), 12000);
    const bad = diags.filter((x) => x.code === "WXAML0003");
    assert.strictEqual(bad.length, 1, `unknown local:Page2 attribute should raise exactly 1 WXAML0003; buffer=${buffer}; got ${diagSummary(diags)}`);
    assert.ok(/DefinitelyNotARealPageProperty/.test(bad[0].message), `diagnostic should name the unknown attribute; got ${bad[0].message}`);
  });

  it("flags a mis-cased framework element as unknown", async () => {
    const buffer = page("<button />");
    const diags = await h.diagnosticsFor(buffer, (d) => d.some((x) => x.code === "WXAML0002"), 12000);
    const bad = diags.filter((x) => x.code === "WXAML0002");
    assert.strictEqual(bad.length, 1, `mis-cased button element should raise exactly 1 WXAML0002; buffer=${buffer}; got ${diagSummary(diags)}`);
    assert.ok(/button/.test(bad[0].message), `diagnostic should name the mis-cased element; got ${bad[0].message}`);
  });

  it("flags a mis-cased framework attribute as unknown", async () => {
    const buffer = page('<Button content="Go" />');
    const diags = await h.diagnosticsFor(buffer, (d) => d.some((x) => x.code === "WXAML0003"), 12000);
    const bad = diags.filter((x) => x.code === "WXAML0003");
    assert.strictEqual(bad.length, 1, `mis-cased content attribute should raise exactly 1 WXAML0003; buffer=${buffer}; got ${diagSummary(diags)}`);
    assert.ok(/content/.test(bad[0].message), `diagnostic should name the mis-cased attribute; got ${bad[0].message}`);
  });

  it("does not treat the built-in xml prefix as an undeclared xmlns prefix", async () => {
    const buffer = page('<TextBlock xml:space="preserve" Text=" spaced " />');
    const diags = await h.diagnosticsFor(buffer, () => false, 10000);
    const bad = diags.find((x) => x.code === "WXAML0001");
    assert.ok(!bad, `xml:space should not raise undeclared-prefix WXAML0001; buffer=${buffer}; got ${diagSummary(diags)}`);
  });
});

describe("WinUI XAML red-team 12 — x:Bind parser edge cases", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("F12 resolves an x:Bind function argument when the path is supplied via Path=", async () => {
    const buffer = page('<TextBlock Text="{x:Bind Path=OnGo_Click(Greeting|Text)}" />');
    const defs = await h.definitionsAt(buffer);
    assert.ok(defs.length > 0, `Path= function argument should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), CS, `expected ${CS}; buffer=${buffer}; got ${defs[0].fsPath}`);
  });

  it("hover resolves an x:Bind function argument when the path is supplied via Path=", async () => {
    const buffer = page('<TextBlock Text="{x:Bind Path=OnGo_Click(Greeting|Text)}" />');
    const md = await h.hoverAt(buffer);
    assert.ok(/GreetingText/.test(md), `Path= function-arg hover should mention GreetingText; buffer=${buffer}; got: ${md}`);
    assert.ok(/string|String/.test(md), `Path= function-arg hover should include type; buffer=${buffer}; got: ${md}`);
  });

  it("completes element-type members after an indexer inside x:Bind Path=", async () => {
    const buffer = page('<TextBlock Text="{x:Bind Path=Items[0].|}" />');
    const items = await h.completionsAt(buffer);
    assert.ok(
      items.includes("Length"),
      `Path=Items[0]. should complete String.Length; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`
    );
  });

  it("hover on an x:Bind terminal indexer still identifies the indexed collection member", async () => {
    const buffer = page('<TextBlock Text="{x:Bind Item|s[0]}" />');
    const md = await h.hoverAt(buffer);
    assert.ok(/Items/.test(md), `terminal indexer hover should identify Items; buffer=${buffer}; got: ${md}`);
    assert.ok(/IReadOnlyList|IEnumerable|String|string/.test(md), `terminal indexer hover should include collection/string type info; buffer=${buffer}; got: ${md}`);
  });

  it("flags an unknown first segment when x:Bind is prefixed by boolean negation", async () => {
    const buffer = page('<TextBlock Text="{x:Bind !DefinitelyMissingNegatedMember}" />');
    const diags = await h.diagnosticsFor(buffer, (d) => d.some((x) => x.code === "WXAML0005"), 12000);
    const bad = diags.filter((x) => x.code === "WXAML0005");
    assert.strictEqual(bad.length, 1, `negated unknown member should raise exactly 1 WXAML0005; buffer=${buffer}; got ${diagSummary(diags)}`);
    assert.ok(/DefinitelyMissingNegatedMember/.test(bad[0].message), `diagnostic should name the unknown negated member; got ${bad[0].message}`);
  });

  it("nested DataTemplates re-root x:Bind completion to the innermost x:DataType", async () => {
    const buffer = page([
      '<ItemsRepeater ItemsSource="{x:Bind Items}">',
      '  <ItemsRepeater.ItemTemplate>',
      '    <DataTemplate x:DataType="local:SmokePage">',
      '      <ItemsRepeater ItemsSource="{x:Bind Items}">',
      '        <ItemsRepeater.ItemTemplate>',
      '          <DataTemplate x:DataType="x:String">',
      '            <TextBlock Text="{x:Bind |}" />',
      '          </DataTemplate>',
      '        </ItemsRepeater.ItemTemplate>',
      '      </ItemsRepeater>',
      '    </DataTemplate>',
      '  </ItemsRepeater.ItemTemplate>',
      '</ItemsRepeater>',
    ].join("\n  "));
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("Length"), `inner x:String DataTemplate should complete String.Length; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });
});

describe("WinUI XAML red-team 12 — resources, attached properties, and outline", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("F12 resolves ThemeResource keys declared inside ThemeDictionaries", async () => {
    const buffer = page([
      "<Page.Resources>",
      "  <ResourceDictionary>",
      "    <ResourceDictionary.ThemeDictionaries>",
      '      <ResourceDictionary x:Key="Default">',
      '        <SolidColorBrush x:Key="ThemeLaterBrush" Color="Red" />',
      "      </ResourceDictionary>",
      "    </ResourceDictionary.ThemeDictionaries>",
      "  </ResourceDictionary>",
      "</Page.Resources>",
      '<Border Background="{ThemeResource ThemeLater|Brush}" />',
    ].join("\n  "));
    const defs = await h.definitionsAt(buffer);
    assert.ok(defs.length > 0, `ThemeDictionaries ThemeResource should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), XAML, `expected in-buffer XAML definition; buffer=${buffer}; got ${defs[0].fsPath}`);
    assert.strictEqual(defs[0].line, 11, `expected ThemeLaterBrush at 0-based line 11; buffer=${buffer}; got ${defs[0].line}`);
  });

  it("completes attached-property members after AutomationProperties dot", async () => {
    const buffer = page('<Button AutomationProperties.| Content="Go" />');
    const items = await h.completionsAt(buffer);
    assert.ok(
      items.includes("AutomationProperties.AutomationId"),
      `AutomationProperties. should complete AutomationProperties.AutomationId; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`
    );
  });

  it("hover on AutomationProperties.AutomationId identifies the attached property", async () => {
    const buffer = page('<Button AutomationProperties.Automation|Id="ProbeButton" Content="Go" />');
    const md = await h.hoverAt(buffer);
    assert.ok(/AutomationId/.test(md), `AutomationProperties.AutomationId hover should mention property; buffer=${buffer}; got: ${md}`);
    assert.ok(/AutomationProperties/.test(md), `AutomationProperties.AutomationId hover should mention owner; buffer=${buffer}; got: ${md}`);
  });

  it("outline includes property elements as structural nodes inside templates", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <Style x:Key="ProbeStyle" TargetType="Button">',
      '    <Setter Property="Template">',
      "      <Setter.Value>",
      '        <ControlTemplate TargetType="Button">',
      "          <Grid>",
      '            <ContentPresenter Content="{TemplateBinding Content}" />',
      "          </Grid>",
      "        </ControlTemplate>",
      "      </Setter.Value>",
      "    </Setter>",
      "  </Style>",
      "</Page.Resources>",
      '<Button Style="{StaticResource ProbeStyle}" />',
    ].join("\n  "));
    const names = flatten(await h.symbolsAt(buffer));
    assert.ok(names.includes("Setter.Value"), `outline should include Setter.Value property element; buffer=${buffer}; got ${names.join(" > ")}`);
    assert.ok(names.includes("ControlTemplate"), `outline should include ControlTemplate object element; buffer=${buffer}; got ${names.join(" > ")}`);
    assert.ok(names.includes("ContentPresenter"), `outline should include template child element; buffer=${buffer}; got ${names.join(" > ")}`);
  });

  it.skip("completes TargetType values inside {x:Type ...} markup extensions", async () => {
    // GAP: {x:Static}/{x:Type} member/type completion is a documented gap.
    const buffer = page('<Style TargetType="{x:Type |}" />');
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("Button"), `x:Type should complete framework types; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });
});
