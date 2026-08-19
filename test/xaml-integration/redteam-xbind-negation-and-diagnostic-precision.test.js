"use strict";

// x:Bind parsing, completion boundaries, diagnostics, and outline shape.

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

describe("WinUI XAML red-team 13 — x:Bind negation and path edges", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("hover strips a negation prefix even when whitespace follows the bang", async () => {
    const buffer = page('<TextBlock Text="{x:Bind ! Greeting|Text}" />');
    const md = await h.hoverAt(buffer);
    assert.ok(/GreetingText/.test(md), `negated whitespace hover should mention GreetingText; buffer=${buffer}; got: ${md}`);
    assert.ok(!/!/.test(md), `negation punctuation should not leak into hover; buffer=${buffer}; got: ${md}`);
  });

  it("F12 resolves a member after double negation without treating bangs as part of the name", async () => {
    const buffer = page('<TextBlock Text="{x:Bind !!Greeting|Text}" />');
    const defs = await h.definitionsAt(buffer);
    assert.ok(defs.length > 0, `double-negated x:Bind member should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), CS, `expected ${CS}; buffer=${buffer}; got ${defs[0].fsPath}`);
  });

  it("stays silent for a valid negated x:Bind path combined with Mode=OneWay", async () => {
    const buffer = page('<TextBlock Text="{x:Bind !Items, Mode=OneWay}" />');
    const diags = await h.diagnosticsFor(buffer, () => false, 3500);
    const bad = diags.find((x) => /^WXAML/.test(String(x.code || "")));
    assert.ok(!bad, `valid negated x:Bind with Mode should stay silent; buffer=${buffer}; got ${diagSummary(diags)}`);
  });

  it("F12 resolves an x:Bind function argument when the function is negated", async () => {
    const buffer = page('<TextBlock Text="{x:Bind !OnGo_Click(Greeting|Text)}" />');
    const defs = await h.definitionsAt(buffer);
    assert.ok(defs.length > 0, `negated function-argument member should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), CS, `expected ${CS}; buffer=${buffer}; got ${defs[0].fsPath}`);
  });

  it("hover resolves the member after an explicit Path= indexer segment", async () => {
    const buffer = page('<TextBlock Text="{x:Bind Path=Items[0].Len|gth}" />');
    const md = await h.hoverAt(buffer);
    assert.ok(/Length/.test(md), `Path= indexer member hover should mention Length; buffer=${buffer}; got: ${md}`);
    assert.ok(/int|Int32|System\.Int32/.test(md), `Path= indexer member hover should include integer type; buffer=${buffer}; got: ${md}`);
  });

  it("does not flag valid explicit Path= function and indexer bindings", async () => {
    const buffer = page([
      '<StackPanel>',
      '  <TextBlock Text="{x:Bind Path=OnGo_Click(GreetingText, Items[0])}" />',
      '  <TextBlock Text="{x:Bind Path=Items[0].Length, Mode=OneWay}" />',
      '</StackPanel>',
    ].join("\n  "));
    const diags = await h.diagnosticsFor(buffer, () => false, 3500);
    const bad = diags.find((x) => /^WXAML/.test(String(x.code || "")));
    assert.ok(!bad, `valid Path= function/indexer bindings should stay silent; buffer=${buffer}; got ${diagSummary(diags)}`);
  });

  it("resolves parenthesized cast x:Bind paths", async () => {
    // For cast x:Bind expressions, the member after the cast resolves against the cast target type.
    const buffer = page('<TextBlock Text="{x:Bind (local:SmokePage)Greeting|Text}" />');
    const defs = await h.definitionsAt(buffer);
    assert.ok(defs.length > 0, `cast x:Bind member should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
  });

  it("resolves x:Bind attached-property paths such as (Grid.Row)", async () => {
    // For attached-property paths, hover identifies the attached property on the owner type.
    const buffer = page('<TextBlock Text="{x:Bind (Grid.R|ow)}" />');
    const md = await h.hoverAt(buffer);
    assert.ok(/Grid\.Row|Grid.Row/.test(md), `attached-property path hover should identify Grid.Row; buffer=${buffer}; got: ${md}`);
  });
});

describe("WinUI XAML red-team 13 — diagnostics precision and completion boundaries", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("does not report WXAML diagnostics for x:Bind converter/fallback named arguments", async () => {
    const buffer = page([
      '<Page.Resources>',
      '  <SolidColorBrush x:Key="ProbeBrush13" Color="Red" />',
      '</Page.Resources>',
      '<TextBlock Text="{x:Bind GreetingText, Mode=OneWay, Converter={StaticResource ProbeBrush13}, ConverterParameter=abc, FallbackValue=fallback, TargetNullValue=missing}" />',
    ].join("\n  "));
    const diags = await h.diagnosticsFor(buffer, () => false, 3500);
    const bad = diags.find((x) => /^WXAML/.test(String(x.code || "")));
    assert.ok(!bad, `x:Bind converter/fallback args should not produce WXAML diagnostics; buffer=${buffer}; got ${diagSummary(diags)}`);
  });

  it("flags a mis-cased property element as an unknown member, not as an attribute problem", async () => {
    const buffer = page([
      '<Grid>',
      '  <Grid.rowDefinitions>',
      '    <RowDefinition />',
      '  </Grid.rowDefinitions>',
      '</Grid>',
    ].join("\n  "));
    const diags = await h.diagnosticsFor(buffer, (d) => d.some((x) => x.code === "WXAML0006"), 12000);
    assert.ok(diags.some((x) => x.code === "WXAML0006" && /rowDefinitions/.test(x.message)), `mis-cased property element should raise WXAML0006 naming rowDefinitions; buffer=${buffer}; got ${diagSummary(diags)}`);
    assert.ok(!diags.some((x) => x.code === "WXAML0003"), `mis-cased property element should not be reported as an attribute; buffer=${buffer}; got ${diagSummary(diags)}`);
  });

  it("completes attributes inside a self-closing tag before the slash", async () => {
    const buffer = page('<Button |/>');
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("Click"), `self-closing tag attribute context should complete Click; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("completes attributes between existing attributes and the self-closing slash", async () => {
    const buffer = page('<Button Content="Go" |/>');
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("Click"), `between-attributes context should complete Click; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("does not offer attribute names inside a closing tag", async () => {
    const buffer = page('<StackPanel><Button /></|StackPanel>');
    const items = await h.completionsAt(buffer);
    assert.ok(!items.includes("Click"), `closing-tag context must not offer Button.Click; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("completes resource keys inside nested Binding Source StaticResource markup", async () => {
    const buffer = page('<TextBlock Tag="{Binding Source={StaticResource |}}" />');
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("SmokeAccentBrush"), `nested StaticResource should complete app resource key; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("does not crash completion at the end of an unterminated attribute value", async () => {
    const buffer = page('<TextBlock Text="{x:Bind Items[0].|');
    const items = await h.completionsAt(buffer);
    assert.ok(Array.isArray(items), `unterminated value completion should return a list; buffer=${buffer}; got ${JSON.stringify(items)}`);
  });
});

describe("WinUI XAML red-team 13 — hover/F12, outline, and namespace boundaries", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("hover on a dotted x:Bind function argument resolves the terminal segment", async () => {
    const buffer = page('<TextBlock Text="{x:Bind OnGo_Click(GreetingText.Len|gth, Items[0])}" />');
    const md = await h.hoverAt(buffer);
    assert.ok(/Length/.test(md), `dotted function-arg hover should mention Length; buffer=${buffer}; got: ${md}`);
    assert.ok(/int|Int32|System\.Int32/.test(md), `dotted function-arg hover should include integer type; buffer=${buffer}; got: ${md}`);
    assert.ok(!/GreetingText/.test(md), `terminal segment hover should not describe the base GreetingText; buffer=${buffer}; got: ${md}`);
  });

  it("F12 on an x:Bind argument dotted base resolves the page member", async () => {
    const buffer = page('<TextBlock Text="{x:Bind OnGo_Click(Greeting|Text.Length)}" />');
    const defs = await h.definitionsAt(buffer);
    assert.ok(defs.length > 0, `dotted function-arg base should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), CS, `expected ${CS}; buffer=${buffer}; got ${defs[0].fsPath}`);
  });

  it("outline keeps styles, templates, data templates, comments, and CDATA correctly nested", async () => {
    const buffer = page([
      '<Page.Resources>',
      '  <!-- resource comment -->',
      '  <Style x:Key="Round13ButtonStyle" TargetType="Button">',
      '    <Setter Property="Template">',
      '      <Setter.Value>',
      '        <ControlTemplate TargetType="Button">',
      '          <Grid>',
      '            <![CDATA[ignored text]]>',
      '            <ContentPresenter />',
      '          </Grid>',
      '        </ControlTemplate>',
      '      </Setter.Value>',
      '    </Setter>',
      '  </Style>',
      '</Page.Resources>',
      '<ItemsRepeater ItemsSource="{x:Bind Items}">',
      '  <ItemsRepeater.ItemTemplate>',
      '    <DataTemplate x:DataType="x:String">',
      '      <StackPanel>',
      '        <TextBlock Text="{x:Bind}" />',
      '      </StackPanel>',
      '    </DataTemplate>',
      '  </ItemsRepeater.ItemTemplate>',
      '</ItemsRepeater>',
    ].join("\n  "));
    const names = flatten(await h.symbolsAt(buffer));
    for (const expected of ["Page.Resources", "Style", "Setter", "Setter.Value", "ControlTemplate", "ContentPresenter", "ItemsRepeater.ItemTemplate", "DataTemplate", "StackPanel", "TextBlock"]) {
      assert.ok(names.includes(expected), `outline should include ${expected}; buffer=${buffer}; got ${names.join(" > ")}`);
    }
  });

  it("F12 on a document-local resource still lands on the in-buffer x:Key after comments and CDATA", async () => {
    const buffer = page([
      '<Page.Resources>',
      '  <!-- before key -->',
      '  <SolidColorBrush x:Key="Round13Brush" Color="Red" />',
      '</Page.Resources>',
      '<Grid>',
      '  <![CDATA[some inert text]]>',
      '  <Border Background="{StaticResource Round13|Brush}" />',
      '</Grid>',
    ].join("\n  "));
    const defs = await h.definitionsAt(buffer);
    assert.ok(defs.length > 0, `document resource should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), XAML, `expected in-buffer XAML definition; buffer=${buffer}; got ${defs[0].fsPath}`);
    assert.strictEqual(defs[0].line, 9, `expected Round13Brush at 0-based line 9; buffer=${buffer}; got ${defs[0].line}`);
  });

  it("flags a framework element name written in the local namespace as unknown", async () => {
    const buffer = page("<local:Button />");
    const diags = await h.diagnosticsFor(buffer, (d) => d.some((x) => x.code === "WXAML0002"), 12000);
    const bad = diags.filter((x) => x.code === "WXAML0002");
    assert.strictEqual(bad.length, 1, `local:Button should raise exactly one WXAML0002; buffer=${buffer}; got ${diagSummary(diags)}`);
    assert.ok(/Button/.test(bad[0].message), `diagnostic should name local:Button/Button; buffer=${buffer}; got ${bad[0].message}`);
  });

  it("flags a mis-cased local custom element as unknown", async () => {
    const buffer = page("<local:page2 />");
    const diags = await h.diagnosticsFor(buffer, (d) => d.some((x) => x.code === "WXAML0002" && /page2/.test(x.message)), 12000);
    const bad = diags.filter((x) => x.code === "WXAML0002");
    assert.strictEqual(bad.length, 1, `local:page2 should raise exactly one WXAML0002; buffer=${buffer}; got ${diagSummary(diags)}`);
    assert.ok(/page2/.test(bad[0].message), `diagnostic should name local:page2/page2; buffer=${buffer}; got ${bad[0].message}`);
  });
});
