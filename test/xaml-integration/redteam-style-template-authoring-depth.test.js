"use strict";

const assert = require("node:assert");
const path = require("node:path");
const vscode = require("vscode");
const h = require("./helper");

const XAML = "SmokePage.xaml";

function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
}

function caretPosition(text) {
  const i = text.indexOf("|");
  assert.ok(i >= 0, "probe text must contain a | caret marker");
  const before = text.slice(0, i);
  const nl = before.lastIndexOf("\n");
  const line = (before.match(/\n/g) || []).length;
  const character = before.length - (nl + 1);
  return {
    clean: text.slice(0, i) + text.slice(i + 1),
    position: new vscode.Position(line, character),
  };
}

async function definitionDetails(text) {
  const { clean, position } = caretPosition(text);
  await h.setBuffer(clean);
  const locs = await vscode.commands.executeCommand(
    "vscode.executeDefinitionProvider",
    h.getDoc().uri,
    position
  );
  return (locs || []).map((l) => {
    const uri = l.targetUri || l.uri;
    const range = l.targetSelectionRange || l.targetRange || l.range;
    return { uri, fsPath: uri.fsPath, range, line: range.start.line, character: range.start.character };
  });
}

function wxaml(diags) {
  return diags.filter((x) => /^WXAML/.test(String(x.code || "")));
}

function byCode(diags, code) {
  return wxaml(diags).filter((x) => x.code === code);
}

function summary(diags) {
  return wxaml(diags).map((d) => `${d.code}:${d.severity}:${d.message}`).join("; ");
}

function diagText(diag) {
  return h.getDoc().getText(diag.range);
}

async function expectOnlySentinel(buffer, code, sentinel, forbiddenTokens, note) {
  const diags = await h.diagnosticsFor(buffer, (d) =>
    byCode(d, code).some((x) => diagText(x) === sentinel || x.message.includes(sentinel)), 15000);
  assert.ok(byCode(diags, code).some((x) => diagText(x) === sentinel || x.message.includes(sentinel)),
    `${note}: sentinel ${code} did not fire; buffer=${buffer}; got ${summary(diags)}`);
  const forbidden = wxaml(diags).filter((x) =>
    forbiddenTokens.some((token) => diagText(x).includes(token) || x.message.includes(token)));
  assert.deepStrictEqual(forbidden.map((x) => `${x.code}:${diagText(x)}:${x.message}`), [],
    `${note}: valid style/template/VSM markup produced WXAML diagnostics; buffer=${buffer}; got ${summary(diags)}`);
}

describe("WinUI XAML red-team 31 — Style/ControlTemplate authoring depth", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("completes StaticResource brush keys in Setter.Value for a complex Background value", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <SolidColorBrush x:Key="SetterBrush31" Color="Tomato" />',
      '  <Style x:Key="BaseButton31" TargetType="Button" />',
      "</Page.Resources>",
      '<Style TargetType="Button" BasedOn="{StaticResource BaseButton31}">',
      '  <Setter Property="Background" Value="{StaticResource Setter|}" />',
      "</Style>",
    ].join("\n  "));
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("SetterBrush31"), `Setter.Value StaticResource should complete local brush key; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);

    const appBuffer = buffer.replace("{StaticResource Setter|}", "{StaticResource Smoke|}");
    const appItems = await h.completionsAt(appBuffer);
    assert.ok(appItems.includes("SmokeAccentBrush"), `Setter.Value StaticResource should include App.xaml brush keys; buffer=${appBuffer}; got ${appItems.slice(0, 120).join(", ")}`);
  });

  it("keeps Thickness Setter.Value completion graceful and does not leak enum/bool completions", async () => {
    const buffer = page([
      '<Style TargetType="Button">',
      '  <Setter Property="Padding" Value="|" />',
      "</Style>",
    ].join("\n  "));
    const items = await Promise.race([
      h.completionsAt(buffer),
      h.delay(5000).then(() => { throw new Error("Padding Setter.Value completion did not settle"); }),
    ]);
    assert.ok(Array.isArray(items), `Padding Setter.Value completion should return an array; buffer=${buffer}`);
    assert.ok(!items.includes("Center") && !items.includes("Stretch"), `Thickness value must not leak HorizontalAlignment enum values; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
    assert.ok(!items.includes("True") && !items.includes("False"), `Thickness value must not leak boolean values; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("completes inherited enum and boolean Setter.Value members without cross-contamination", async () => {
    const enumBuffer = page([
      '<Style TargetType="Button">',
      '  <Setter Property="HorizontalAlignment" Value="|" />',
      "</Style>",
    ].join("\n  "));
    const enumItems = await h.completionsAt(enumBuffer);
    assert.ok(enumItems.includes("Left"), `HorizontalAlignment Setter.Value should include Left; buffer=${enumBuffer}; got ${enumItems.slice(0, 120).join(", ")}`);
    assert.ok(enumItems.includes("Center"), `HorizontalAlignment Setter.Value should include Center; buffer=${enumBuffer}; got ${enumItems.slice(0, 120).join(", ")}`);
    assert.ok(enumItems.includes("Stretch"), `HorizontalAlignment Setter.Value should include Stretch; buffer=${enumBuffer}; got ${enumItems.slice(0, 120).join(", ")}`);
    assert.ok(!enumItems.includes("True") && !enumItems.includes("False"), `enum Setter.Value must not leak booleans; buffer=${enumBuffer}; got ${enumItems.slice(0, 120).join(", ")}`);

    const boolBuffer = page([
      '<Style TargetType="Button">',
      '  <Setter Property="IsEnabled" Value="|" />',
      "</Style>",
    ].join("\n  "));
    const boolItems = await h.completionsAt(boolBuffer);
    assert.ok(boolItems.includes("True"), `IsEnabled Setter.Value should include True; buffer=${boolBuffer}; got ${boolItems.slice(0, 120).join(", ")}`);
    assert.ok(boolItems.includes("False"), `IsEnabled Setter.Value should include False; buffer=${boolBuffer}; got ${boolItems.slice(0, 120).join(", ")}`);
    assert.ok(!boolItems.includes("Center") && !boolItems.includes("Stretch"), `boolean Setter.Value must not leak enum values; buffer=${boolBuffer}; got ${boolItems.slice(0, 120).join(", ")}`);
  });

  it("scopes Setter.Property completion to the Style TargetType and inherited Control members", async () => {
    const buffer = page([
      '<Style TargetType="Button">',
      '  <Setter Property="Con|" Value="Go" />',
      "</Style>",
    ].join("\n  "));
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("Content"), `Button Style Setter.Property should complete Content; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
    assert.ok(!items.includes("GreetingText"), `Setter.Property completion must not leak page x:Class members; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("scopes dotted Setter.Property attached completion to the requested owner", async () => {
    const buffer = page([
      '<Style TargetType="Button">',
      '  <Setter Property="Grid.|" Value="1" />',
      "</Style>",
    ].join("\n  "));
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("Grid.Row"), `Grid attached completion should include Grid.Row; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
    assert.ok(items.includes("Grid.Column"), `Grid attached completion should include Grid.Column; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
    assert.ok(!items.includes("Canvas.Left"), `Grid attached completion must not leak Canvas.Left; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("completes TemplateBinding from the nearest ControlTemplate TargetType inside a Style Setter", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <Style x:Key="ButtonTemplateStyle31" TargetType="Button">',
      '    <Setter Property="Template">',
      '      <Setter.Value>',
      '        <ControlTemplate TargetType="Button">',
      '          <ContentPresenter Content="{TemplateBinding Con|}" />',
      '        </ControlTemplate>',
      '      </Setter.Value>',
      '    </Setter>',
      '  </Style>',
      "</Page.Resources>",
      "<Grid />",
    ].join("\n  "));
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("Content"), `TemplateBinding should complete Button.Content; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
    assert.ok(!items.includes("GreetingText"), `TemplateBinding must not leak page members; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("uses the inner ControlTemplate TargetType rather than an outer Style TargetType for TemplateBinding", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <Style x:Key="OuterTextBlockStyle31" TargetType="TextBlock">',
      '    <Setter Property="Template">',
      '      <Setter.Value>',
      '        <ControlTemplate TargetType="Button">',
      '          <ContentPresenter Content="{TemplateBinding Con|}" />',
      '        </ControlTemplate>',
      '      </Setter.Value>',
      '    </Setter>',
      '  </Style>',
      "</Page.Resources>",
      "<Grid />",
    ].join("\n  "));
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("Content"), `inner Button ControlTemplate should complete Button.Content despite the outer TextBlock Style; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("completes RelativeSource TemplatedParent mode inside a ControlTemplate Binding without BindingMode leakage", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <ControlTemplate x:Key="RelativeSourceTemplate31" TargetType="Button">',
      '    <ContentPresenter Content="{Binding RelativeSource={RelativeSource Mode=|}, Path=Content}" />',
      '  </ControlTemplate>',
      "</Page.Resources>",
      "<Grid />",
    ].join("\n  "));
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("TemplatedParent"), `RelativeSource.Mode inside template should complete TemplatedParent; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
    assert.ok(items.includes("Self"), `RelativeSource.Mode should include Self; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
    assert.ok(!items.includes("OneWay") && !items.includes("TwoWay"), `RelativeSource.Mode must not leak BindingMode values; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("resolves Storyboard.TargetName inside a ControlTemplate to a x:Name'd template part", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <ControlTemplate x:Key="TemplateWithParts31" TargetType="Button">',
      '    <Grid x:Name="RootPart31">',
      '      <VisualStateManager.VisualStateGroups>',
      '        <VisualStateGroup>',
      '          <VisualState x:Name="PointerOver">',
      '            <Storyboard>',
      '              <DoubleAnimation Storyboard.TargetName="Root|Part31" Storyboard.TargetProperty="Opacity" To="0.8" Duration="0:0:0.1" />',
      '            </Storyboard>',
      '          </VisualState>',
      '        </VisualStateGroup>',
      '      </VisualStateManager.VisualStateGroups>',
      '    </Grid>',
      '  </ControlTemplate>',
      "</Page.Resources>",
      "<Grid />",
    ].join("\n  "));
    const defs = await definitionDetails(buffer);
    assert.ok(defs.length > 0, `Storyboard.TargetName in template should resolve to template part; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), XAML, `expected in-buffer XAML definition; buffer=${buffer}; got ${defs[0].fsPath}`);
    assert.strictEqual(h.getDoc().getText(defs[0].range), "RootPart31", `definition should select the x:Name value; buffer=${buffer}; got ${h.getDoc().getText(defs[0].range)}`);
  });

  it("hovers Storyboard.TargetName inside a ControlTemplate as the referenced template part", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <ControlTemplate x:Key="TemplateHoverParts31" TargetType="Button">',
      '    <Border x:Name="ChromePart31">',
      '      <VisualStateManager.VisualStateGroups>',
      '        <VisualStateGroup><VisualState>',
      '          <Storyboard>',
      '            <DoubleAnimation Storyboard.TargetName="Chrome|Part31" Storyboard.TargetProperty="Opacity" To="0.8" Duration="0:0:0.1" />',
      '          </Storyboard>',
      '        </VisualState></VisualStateGroup>',
      '      </VisualStateManager.VisualStateGroups>',
      '    </Border>',
      '  </ControlTemplate>',
      "</Page.Resources>",
      "<Grid />",
    ].join("\n  "));
    const md = await h.hoverAt(buffer);
    assert.match(md, /ChromePart31/, `TargetName hover should include template part name; buffer=${buffer}; got: ${md}`);
    assert.match(md, /Border/, `TargetName hover should include template part type; buffer=${buffer}; got: ${md}`);
  });

  it("keeps mixed property-element and child-content ControlTemplate markup WXAML-silent while a sentinel proves diagnostics flow", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <SolidColorBrush x:Key="TemplateChromeBrush31" Color="CornflowerBlue" />',
      '  <Style x:Key="ComplexButtonStyle31" TargetType="Button">',
      '    <Setter Property="Template">',
      '      <Setter.Value>',
      '        <ControlTemplate TargetType="Button">',
      '          <Grid x:Name="Root31" Background="{TemplateBinding Background}">',
      '            <Grid.RowDefinitions><RowDefinition Height="Auto" /></Grid.RowDefinitions>',
      '            <ContentPresenter Content="{TemplateBinding Content}" Padding="{TemplateBinding Padding}" />',
      '            <Border Background="{StaticResource TemplateChromeBrush31}" Grid.Row="0" />',
      '          </Grid>',
      '        </ControlTemplate>',
      '      </Setter.Value>',
      '    </Setter>',
      '  </Style>',
      "</Page.Resources>",
      '<StackPanel><Button Style="{StaticResource ComplexButtonStyle31}" /><TextBlock Text="{x:Bind __SentinelMissing31}" /></StackPanel>',
    ].join("\n  "));
    await expectOnlySentinel(buffer, "WXAML0005", "__SentinelMissing31",
      ["ComplexButtonStyle31", "TemplateChromeBrush31", "TemplateBinding", "ContentPresenter", "RowDefinition", "Grid.Row"],
      "valid mixed ControlTemplate markup");
  });

  it("completes, hovers, and resolves a chained BasedOn Style StaticResource", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <Style x:Key="BaseButton31" TargetType="Button"><Setter Property="Content" Value="Base" /></Style>',
      '  <Style x:Key="MidButton31" TargetType="Button" BasedOn="{StaticResource BaseButton31}" />',
      '  <Style x:Key="DerivedButton31" TargetType="Button" BasedOn="{StaticResource MidButton|31}" />',
      "</Page.Resources>",
      "<Grid />",
    ].join("\n  "));
    const itemsBuffer = buffer.replace("MidButton|31", "Mid|");
    const items = await h.completionsAt(itemsBuffer);
    assert.ok(items.includes("MidButton31"), `BasedOn should complete chained style key; buffer=${itemsBuffer}; got ${items.slice(0, 120).join(", ")}`);
    const defs = await definitionDetails(buffer);
    assert.ok(defs.length > 0, `BasedOn chained style key should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(h.getDoc().getText(defs[0].range), "MidButton31", `definition should select MidButton31 x:Key; buffer=${buffer}; got ${h.getDoc().getText(defs[0].range)}`);
    const md = await h.hoverAt(buffer);
    assert.match(md, /MidButton31/, `BasedOn hover should include chained style key; buffer=${buffer}; got: ${md}`);
    assert.match(md, /Style/, `BasedOn hover should include Style resource type; buffer=${buffer}; got: ${md}`);
  });

  it("reports the invalid forward reference without hanging on self and circular BasedOn resources", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <Style x:Key="SelfStyle31" TargetType="Button" BasedOn="{StaticResource SelfStyle31}" />',
      '  <Style x:Key="CircleA31" TargetType="Button" BasedOn="{StaticResource CircleB31}" />',
      '  <Style x:Key="CircleB31" TargetType="Button" BasedOn="{StaticResource CircleA31}" />',
      "</Page.Resources>",
      '<StackPanel><Button Style="{StaticResource SelfStyle31}" /><TextBlock Text="{x:Bind __SentinelMissing31}" /></StackPanel>',
    ].join("\n  "));
    const diags = await h.diagnosticsFor(buffer, (d) =>
      byCode(d, "WXAML0005").some((x) => x.message.includes("__SentinelMissing31")) &&
      byCode(d, "WXAML0013").some((x) => diagText(x) === "CircleB31"), 15000);
    assert.strictEqual(byCode(diags, "WXAML0005").length, 1, `expected only the sentinel x:Bind diagnostic; got ${summary(diags)}`);
    const resourceDiags = byCode(diags, "WXAML0013");
    assert.strictEqual(resourceDiags.length, 1, `expected one StaticResource forward-reference diagnostic; got ${summary(diags)}`);
    assert.strictEqual(diagText(resourceDiags[0]), "CircleB31", `expected the later CircleB31 reference; got ${summary(diags)}`);
  });

  it("completes VisualState Setter.Target from the referenced element and keeps the markup diagnostic-silent", async () => {
    const buffer = page([
      "<Grid>",
      '  <Button x:Name="VisualTarget31" Content="Go" />',
      '  <VisualStateManager.VisualStateGroups>',
      '    <VisualStateGroup x:Name="CommonStates31">',
      '      <VisualState x:Name="Wide31">',
      '        <VisualState.Setters>',
      '          <Setter Target="VisualTarget31.Opacity" Value="0.5" />',
      '          <Setter Target="VisualTarget31.IsEnabled" Value="False" />',
      '        </VisualState.Setters>',
      '      </VisualState>',
      '    </VisualStateGroup>',
      '  </VisualStateManager.VisualStateGroups>',
      '  <TextBlock Text="{x:Bind __SentinelMissing31}" />',
      "</Grid>",
    ].join("\n  "));
    await expectOnlySentinel(buffer, "WXAML0005", "__SentinelMissing31",
      ["VisualTarget31", "Opacity", "IsEnabled", "VisualState", "Setter"], "valid VSM Setter.Target markup");

    const completionBuffer = buffer.replace('Target="VisualTarget31.Opacity"', 'Target="VisualTarget31.|"');
    const items = await Promise.race([
      h.completionsAt(completionBuffer),
      h.delay(5000).then(() => { throw new Error("VSM Setter.Target completion did not settle"); }),
    ]);
    assert.ok(Array.isArray(items), `VSM Setter.Target completion should return an array; buffer=${completionBuffer}`);
    // Target scopes to the REFERENCED element's type (Button), not a Style TargetType — Button's own instance properties are offered (incl. inherited HorizontalAlignment), but NOT attached properties and NOT the page x:Class members.
    assert.ok(items.includes("Opacity") && items.includes("IsEnabled"), `VSM Setter.Target should complete the referenced Button's properties; buffer=${completionBuffer}; got ${items.slice(0, 120).join(", ")}`);
    assert.ok(!items.includes("Grid.Row"), `VSM Setter.Target must not offer attached properties; buffer=${completionBuffer}; got ${items.slice(0, 120).join(", ")}`);
    assert.ok(!items.includes("GreetingText"), `VSM Setter.Target must not leak page x:Class members; buffer=${completionBuffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("keeps Storyboard.TargetProperty completion graceful without unrelated enum/bool garbage", async () => {
    const buffer = page([
      "<Grid>",
      '  <Border x:Name="AnimatedBorder31" />',
      '  <VisualStateManager.VisualStateGroups><VisualStateGroup><VisualState><Storyboard>',
      '    <DoubleAnimation Storyboard.TargetName="AnimatedBorder31" Storyboard.TargetProperty="|" To="0.8" Duration="0:0:0.1" />',
      '  </Storyboard></VisualState></VisualStateGroup></VisualStateManager.VisualStateGroups>',
      "</Grid>",
    ].join("\n  "));
    const items = await Promise.race([
      h.completionsAt(buffer),
      h.delay(5000).then(() => { throw new Error("Storyboard.TargetProperty completion did not settle"); }),
    ]);
    assert.ok(Array.isArray(items), `Storyboard.TargetProperty completion should return an array; buffer=${buffer}`);
    assert.ok(!items.includes("True") && !items.includes("False") && !items.includes("Center"), `Storyboard.TargetProperty must not leak unrelated value completions; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });
});

describe("WinUI XAML red-team 31 — documented or acceptable gaps", function () {
  it.skip("GAP: TemplateBinding property hover/F12 is not implemented yet; framework metadata-as-source F12 remains unavailable", async () => {});
  it.skip("GAP: VSM Setter.Target and Storyboard.TargetProperty member completion shipped in round 32; parenthesized paths and animatable-only filtering remain out of scope", async () => {});
  it.skip("GAP: numeric/struct value synthesis such as Thickness completion is intentionally not implemented", async () => {});
});
