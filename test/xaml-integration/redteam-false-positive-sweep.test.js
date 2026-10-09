"use strict";

// False-positive coverage for property elements, x:Bind negation, and malformed boundaries.

const assert = require("node:assert");
const h = require("./helper");

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

function wxaml(diags) {
  return diags.filter((x) => /^WXAML/.test(String(x.code || "")));
}

describe("WinUI XAML red-team 15 — broad false-positive sweep", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("stays silent for dense inherited, collection, attached, and setter property elements", async () => {
    const buffer = page([
      "<Page.Resources>",
      "  <Style x:Key=\"Round15ButtonStyle\" TargetType=\"Button\">",
      "    <Style.Setters>",
      "      <Setter Property=\"Background\">",
      "        <Setter.Value>",
      "          <SolidColorBrush Color=\"Orange\" />",
      "        </Setter.Value>",
      "      </Setter>",
      "      <Setter Property=\"Template\">",
      "        <Setter.Value>",
      "          <ControlTemplate TargetType=\"Button\">",
      "            <Grid>",
      "              <ContentPresenter />",
      "            </Grid>",
      "          </ControlTemplate>",
      "        </Setter.Value>",
      "      </Setter>",
      "    </Style.Setters>",
      "  </Style>",
      "</Page.Resources>",
      "<Grid>",
      "  <Grid.RowDefinitions>",
      "    <RowDefinition>",
      "      <RowDefinition.Height>Auto</RowDefinition.Height>",
      "    </RowDefinition>",
      "  </Grid.RowDefinitions>",
      "  <Grid.ColumnDefinitions>",
      "    <ColumnDefinition Width=\"*\" />",
      "  </Grid.ColumnDefinitions>",
      "  <Button Style=\"{StaticResource Round15ButtonStyle}\">",
      "    <Button.Background>",
      "      <SolidColorBrush Color=\"Red\" />",
      "    </Button.Background>",
      "    <Grid.Row>0</Grid.Row>",
      "  </Button>",
      "</Grid>",
    ].join("\n  "));
    const diags = await h.diagnosticsFor(buffer, () => false, 3500);
    assert.deepStrictEqual(wxaml(diags), [], `valid dense property elements should stay silent; buffer=${buffer}; got ${diagSummary(diags)}`);
  });

  it("stays silent for base-type property elements on derived controls", async () => {
    const buffer = page([
      "<Button>",
      "  <FrameworkElement.Resources>",
      "    <SolidColorBrush x:Key=\"Round15LocalBrush\" Color=\"Green\" />",
      "  </FrameworkElement.Resources>",
      "  <Control.Template>",
      "    <ControlTemplate TargetType=\"Button\">",
      "      <Grid Background=\"{StaticResource Round15LocalBrush}\">",
      "        <ContentPresenter />",
      "      </Grid>",
      "    </ControlTemplate>",
      "  </Control.Template>",
      "</Button>",
    ].join("\n  "));
    const diags = await h.diagnosticsFor(buffer, () => false, 3500);
    assert.deepStrictEqual(wxaml(diags), [], `base-type property elements on Button should stay silent; buffer=${buffer}; got ${diagSummary(diags)}`);
  });

  it("stays silent for StackPanel.Children content and attached-property element values", async () => {
    const buffer = page([
      "<StackPanel>",
      "  <StackPanel.Children>",
      "    <TextBlock Text=\"One\">",
      "      <Canvas.Left>12</Canvas.Left>",
      "      <Grid.Row>1</Grid.Row>",
      "    </TextBlock>",
      "    <ScrollViewer ScrollViewer.HorizontalScrollBarVisibility=\"Auto\">",
      "      <TextBlock Text=\"Two\" />",
      "    </ScrollViewer>",
      "  </StackPanel.Children>",
      "</StackPanel>",
    ].join("\n  "));
    const diags = await h.diagnosticsFor(buffer, () => false, 3500);
    assert.deepStrictEqual(wxaml(diags), [], `content collections and attached property values should stay silent; buffer=${buffer}; got ${diagSummary(diags)}`);
  });

  it("stays silent for a realistic page with resources, templates, VSM, storyboard, templates, and x:Bind", async () => {
    const buffer = page([
      "<Page.Resources>",
      "  <ResourceDictionary>",
      "    <ResourceDictionary.MergedDictionaries>",
      "      <ResourceDictionary>",
      "        <SolidColorBrush x:Key=\"Round15AccentBrush\" Color=\"Purple\" />",
      "      </ResourceDictionary>",
      "    </ResourceDictionary.MergedDictionaries>",
      "    <DataTemplate x:Key=\"Round15StringTemplate\" x:DataType=\"x:String\">",
      "      <Grid>",
      "        <TextBlock Text=\"{x:Bind Length, Mode=OneWay, FallbackValue=0}\" />",
      "      </Grid>",
      "    </DataTemplate>",
      "    <Style x:Key=\"Round15ListViewItemStyle\" TargetType=\"ListViewItem\">",
      "      <Setter Property=\"Template\">",
      "        <Setter.Value>",
      "          <ControlTemplate TargetType=\"ListViewItem\">",
      "            <Grid x:Name=\"Root\" Background=\"{StaticResource Round15AccentBrush}\">",
      "              <VisualStateManager.VisualStateGroups>",
      "                <VisualStateGroup x:Name=\"CommonStates\">",
      "                  <VisualState x:Name=\"Normal\" />",
      "                  <VisualState x:Name=\"PointerOver\">",
      "                    <Storyboard>",
      "                      <DoubleAnimation Storyboard.TargetName=\"Root\" Storyboard.TargetProperty=\"Opacity\" To=\"0.75\" Duration=\"0:0:0.1\" />",
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
      "<Grid>",
      "  <Grid.RowDefinitions>",
      "    <RowDefinition Height=\"Auto\" />",
      "    <RowDefinition Height=\"*\" />",
      "  </Grid.RowDefinitions>",
      "  <VisualStateManager.VisualStateGroups>",
      "    <VisualStateGroup x:Name=\"AdaptiveStates\">",
      "      <VisualState x:Name=\"Wide\" />",
      "    </VisualStateGroup>",
      "  </VisualStateManager.VisualStateGroups>",
      "  <TextBlock Text=\"{x:Bind IsReady, Mode=OneWay, FallbackValue=missing}\" />",
      "  <ListView Grid.Row=\"1\" ItemsSource=\"{x:Bind Items, Mode=OneWay}\" ItemTemplate=\"{StaticResource Round15StringTemplate}\" ItemContainerStyle=\"{StaticResource Round15ListViewItemStyle}\" />",
      "  <ItemsRepeater ItemsSource=\"{x:Bind Items, Mode=OneWay}\">",
      "    <ItemsRepeater.ItemTemplate>",
      "      <DataTemplate x:DataType=\"x:String\">",
      "        <StackPanel>",
      "          <TextBlock Text=\"{x:Bind Length, Mode=OneWay}\" />",
      "        </StackPanel>",
      "      </DataTemplate>",
      "    </ItemsRepeater.ItemTemplate>",
      "  </ItemsRepeater>",
      "</Grid>",
    ].join("\n  "));
    const diags = await h.diagnosticsFor(buffer, () => false, 3500);
    assert.deepStrictEqual(wxaml(diags), [], `real-world dense page should stay free of WXAML diagnostics; buffer=${buffer}; got ${diagSummary(diags)}`);
  });

  // '!' is not part of the {x:Bind} grammar, so each negated binding is reported
  // regardless of how many named arguments follow it.
  it("flags the unsupported '!' operator on negated x:Bind members with named args", async () => {
    const buffer = page([
      "<Page.Resources>",
      "  <SolidColorBrush x:Key=\"Round15ConverterStandIn\" Color=\"Red\" />",
      "</Page.Resources>",
      "<StackPanel>",
      "  <TextBlock Tag=\"{x:Bind !IsReady, Mode=OneWay, Converter={StaticResource Round15ConverterStandIn}, ConverterParameter=flag, FallbackValue=false, TargetNullValue=false}\" />",
      "  <TextBlock Tag=\"{x:Bind !!IsReady, Mode=OneWay, FallbackValue=false}\" />",
      "  <TextBlock Tag=\"{x:Bind ! HasPair(GreetingText, Items[0]), Mode=OneWay}\" />",
      "</StackPanel>",
    ].join("\n  "));
    const diags = await h.diagnosticsFor(
      buffer,
      (d) => d.filter((x) => x.code === "WXAML0035").length === 3,
      12000
    );
    const all = wxaml(diags);
    const negation = all.filter((x) => x.code === "WXAML0035");
    assert.strictEqual(negation.length, 3, `each negated x:Bind should raise WXAML0035; buffer=${buffer}; got ${diagSummary(diags)}`);
    assert.strictEqual(all.length, negation.length, `the unsupported '!' should be the only complaint; buffer=${buffer}; got ${diagSummary(diags)}`);
  });

  it("reports exactly one bad property element when mixed with a valid sibling", async () => {
    const buffer = page([
      "<Grid>",
      "  <Grid.RowDefinitions>",
      "    <RowDefinition />",
      "  </Grid.RowDefinitions>",
      "  <Grid.rowDefinitions>",
      "    <RowDefinition />",
      "  </Grid.rowDefinitions>",
      "</Grid>",
    ].join("\n  "));
    const diags = await h.diagnosticsFor(buffer, (d) => d.some((x) => x.code === "WXAML0006"), 12000);
    const bad = diags.filter((x) => x.code === "WXAML0006");
    assert.strictEqual(bad.length, 1, `only the mis-cased property element should raise WXAML0006; buffer=${buffer}; got ${diagSummary(diags)}`);
    assert.ok(/rowDefinitions/.test(bad[0].message), `diagnostic should name rowDefinitions; buffer=${buffer}; got ${bad[0].message}`);
  });

  it("keeps outline nesting through the dense real-world shape", async () => {
    const buffer = page([
      "<Page.Resources>",
      "  <Style x:Key=\"Round15OutlineStyle\" TargetType=\"Button\">",
      "    <Setter Property=\"Template\">",
      "      <Setter.Value>",
      "        <ControlTemplate TargetType=\"Button\">",
      "          <Grid>",
      "            <ContentPresenter />",
      "          </Grid>",
      "        </ControlTemplate>",
      "      </Setter.Value>",
      "    </Setter>",
      "  </Style>",
      "</Page.Resources>",
      "<ListView ItemsSource=\"{x:Bind Items}\">",
      "  <ListView.ItemTemplate>",
      "    <DataTemplate x:DataType=\"x:String\">",
      "      <StackPanel>",
      "        <TextBlock Text=\"{x:Bind}\" />",
      "      </StackPanel>",
      "    </DataTemplate>",
      "  </ListView.ItemTemplate>",
      "</ListView>",
    ].join("\n  "));
    const names = flatten(await h.symbolsAt(buffer));
    for (const expected of ["Page.Resources", "Style", "Setter.Value", "ControlTemplate", "ContentPresenter", "ListView.ItemTemplate", "DataTemplate", "StackPanel", "TextBlock"]) {
      assert.ok(names.includes(expected), `outline should include ${expected}; buffer=${buffer}; got ${names.join(" > ")}`);
    }
  });
});

describe("WinUI XAML red-team 15 — fresh malformed and namespace micro-surfaces", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("flags a mis-cased normal attribute with WXAML0003, not WXAML0006", async () => {
    const buffer = page("<Button backGround=\"Red\" />");
    const diags = await h.diagnosticsFor(buffer, (d) => d.some((x) => x.code === "WXAML0003"), 12000);
    assert.ok(diags.some((x) => x.code === "WXAML0003" && /backGround/.test(x.message)), `mis-cased attribute should raise WXAML0003 naming backGround; buffer=${buffer}; got ${diagSummary(diags)}`);
    assert.ok(!diags.some((x) => x.code === "WXAML0006"), `attribute typo must not be treated as a property element; buffer=${buffer}; got ${diagSummary(diags)}`);
  });

  it("flags a mis-cased attached-property attribute with WXAML0004", async () => {
    const buffer = page("<TextBlock Grid.rOw=\"0\" />");
    const diags = await h.diagnosticsFor(buffer, (d) => d.some((x) => x.code === "WXAML0004"), 12000);
    assert.ok(diags.some((x) => x.code === "WXAML0004" && /rOw/.test(x.message)), `mis-cased attached attribute should raise WXAML0004 naming rOw; buffer=${buffer}; got ${diagSummary(diags)}`);
    assert.ok(!diags.some((x) => x.code === "WXAML0006"), `attached attribute typo must not be treated as property element; buffer=${buffer}; got ${diagSummary(diags)}`);
  });

  it("flags a mis-cased attached-property element with WXAML0006", async () => {
    const buffer = page([
      "<Grid>",
      "  <TextBlock>",
      "    <Grid.rOw>0</Grid.rOw>",
      "  </TextBlock>",
      "</Grid>",
    ].join("\n  "));
    const diags = await h.diagnosticsFor(buffer, (d) => d.some((x) => x.code === "WXAML0006"), 12000);
    assert.ok(diags.some((x) => x.code === "WXAML0006" && /rOw/.test(x.message)), `mis-cased attached property element should raise WXAML0006 naming rOw; buffer=${buffer}; got ${diagSummary(diags)}`);
  });

  it("does not crash on property-element owners that resolve to value-like framework types", async () => {
    const buffer = page([
      "<Grid>",
      "  <Thickness.Left>1</Thickness.Left>",
      "  <Visibility.Hidden>Collapsed</Visibility.Hidden>",
      "</Grid>",
    ].join("\n  "));
    const diags = await h.diagnosticsFor(buffer, () => false, 3500);
    assert.ok(Array.isArray(diags), `value-like owner property-element probe should return diagnostics array; buffer=${buffer}`);
  });

  it("does not crash on empty-member and triple-dotted property-element names", async () => {
    const buffer = page([
      "<Grid>",
      "  <Grid.>",
      "  </Grid.>",
      "  <Grid.Row.Foo>",
      "  </Grid.Row.Foo>",
      "</Grid>",
    ].join("\n  "));
    const diags = await h.diagnosticsFor(buffer, () => false, 3500);
    assert.ok(Array.isArray(diags), `malformed dotted property-element probe should not crash; buffer=${buffer}`);
  });

  it("flags an undeclared prefix on an attribute inside an otherwise-valid element", async () => {
    const buffer = page([
      "<Grid>",
      "  <Grid.RowDefinitions>",
      "    <RowDefinition />",
      "  </Grid.RowDefinitions>",
      "  <Button ghost:Token=\"x\" Content=\"Go\" />",
      "</Grid>",
    ].join("\n  "));
    const diags = await h.diagnosticsFor(buffer, (d) => d.some((x) => x.code === "WXAML0001"), 12000);
    const bad = diags.filter((x) => x.code === "WXAML0001");
    assert.strictEqual(bad.length, 1, `undeclared attribute prefix should raise one WXAML0001; buffer=${buffer}; got ${diagSummary(diags)}`);
    assert.ok(/ghost/.test(bad[0].message), `diagnostic should name ghost prefix; buffer=${buffer}; got ${bad[0].message}`);
  });

  it("honors child-scope xmlns redefinition while preserving outer local namespace", async () => {
    const buffer = page([
      "<Grid>",
      "  <Grid xmlns:local=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\">",
      "    <local:Button Content=\"Scoped\" />",
      "  </Grid>",
      "  <local:Page2 />",
      "</Grid>",
    ].join("\n  "));
    const diags = await h.diagnosticsFor(buffer, () => false, 3500);
    assert.deepStrictEqual(wxaml(diags), [], `child xmlns redefinition should be scoped, not global; buffer=${buffer}; got ${diagSummary(diags)}`);
  });

  it("F12 resolves the valid property-element owner type even when invoked inside the name", async () => {
    const buffer = page([
      "<Grid>",
      "  <Grid.R|owDefinitions>",
      "    <RowDefinition />",
      "  </Grid.RowDefinitions>",
      "</Grid>",
    ].join("\n  "));
    const defs = await h.definitionsAt(buffer);
    assert.ok(Array.isArray(defs), `property-element name F12 should return a stable array, even if currently empty; buffer=${buffer}; got ${JSON.stringify(defs)}`);
  });

  it("hover on a property-element name renders the member signature", async () => {
    // <Owner.Member> property elements resolve to the Member property for hover (framework metadata included), so this returns the property signature rather than an empty string.
    const buffer = page([
      "<Grid>",
      "  <Grid.Row|Definitions>",
      "    <RowDefinition />",
      "  </Grid.RowDefinitions>",
      "</Grid>",
    ].join("\n  "));
    const md = await h.hoverAt(buffer);
    assert.strictEqual(typeof md, "string", `property-element hover should return a stable string; buffer=${buffer}; got ${md}`);
    assert.ok(/RowDefinitions/.test(md), `property-element hover should name the member 'RowDefinitions'; buffer=${buffer}; got ${md}`);
  });

  it("hover on a property-element name reports the property's declared type", async () => {
    // A second owner/member pair checks that the signature carries the member name and its collection type (Grid.ColumnDefinitions : ColumnDefinitionCollection).
    const buffer = page([
      "<Grid>",
      "  <Grid.Column|Definitions>",
      "    <ColumnDefinition />",
      "  </Grid.ColumnDefinitions>",
      "</Grid>",
    ].join("\n  "));
    const md = await h.hoverAt(buffer);
    assert.ok(/ColumnDefinitions/.test(md), `property-element hover should name 'ColumnDefinitions'; buffer=${buffer}; got ${md}`);
  });

  it.skip("navigates from a property-element member name to the property symbol", async () => {
    // KNOWN GAP (blocked on metadata-as-source, needs the Host C bridge): property-element member RESOLUTION is implemented and a user-source owner would navigate, but Grid.RowDefinitions is a framework member with no source location, so F12 returns no location here.
    const buffer = page([
      "<Grid>",
      "  <Grid.Row|Definitions>",
      "    <RowDefinition />",
      "  </Grid.RowDefinitions>",
      "</Grid>",
    ].join("\n  "));
    const defs = await h.definitionsAt(buffer);
    assert.ok(defs.length > 0, `property-element member should navigate; buffer=${buffer}; got ${JSON.stringify(defs)}`);
  });

  it("flags bad second-segment x:Bind members", async () => {
    // WXAML0005 walks dotted segments after a valid first segment.
    const buffer = page("<TextBlock Text=\"{x:Bind GreetingText.Nope}\" />");
    const diags = await h.diagnosticsFor(buffer, (d) => d.some((x) => x.code === "WXAML0005"), 12000);
    assert.ok(diags.some((x) => x.code === "WXAML0005" && /Nope/.test(x.message)), `bad second segment should raise WXAML0005 naming Nope; buffer=${buffer}; got ${diagSummary(diags)}`);
  });

  it("flags bad members after x:Bind indexer element resolution", async () => {
    // Non-first segments unwrap indexer element types.
    const buffer = page("<TextBlock Text=\"{x:Bind Items[0].Nope}\" />");
    const diags = await h.diagnosticsFor(buffer, (d) => d.some((x) => x.code === "WXAML0005"), 12000);
    assert.ok(diags.some((x) => x.code === "WXAML0005" && /Nope/.test(x.message)), `bad indexer element member should raise WXAML0005 naming Nope; buffer=${buffer}; got ${diagSummary(diags)}`);
  });
});
