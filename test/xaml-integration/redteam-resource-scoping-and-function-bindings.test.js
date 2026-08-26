"use strict";

const assert = require("node:assert");
const path = require("node:path");
const vscode = require("vscode");
const h = require("./helper");

const CS = "SmokePage.xaml.cs";
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

function targetLine(def) {
  return h.getDoc().lineAt(def.line).text;
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

async function expectWxaml0005(buffer, token, note) {
  const diags = await h.diagnosticsFor(buffer, (d) =>
    byCode(d, "WXAML0005").some((x) => diagText(x) === token || new RegExp(token).test(x.message)), 12000);
  const hit = byCode(diags, "WXAML0005").find((x) => diagText(x) === token || new RegExp(token).test(x.message));
  assert.ok(hit, `${note} should raise WXAML0005 for ${token}; buffer=${buffer}; got ${summary(diags)}`);
  assert.strictEqual(hit.severity, 1, `WXAML0005 should be a warning; buffer=${buffer}; got ${summary(diags)}`);
  return diags;
}

async function expectNoWxaml0005For(buffer, forbiddenTokens, note) {
  const diags = await h.diagnosticsFor(buffer, (d) =>
    byCode(d, "WXAML0005").some((x) => diagText(x) === "__SentinelMissing29" || /__SentinelMissing29/.test(x.message)), 12000);
  const hits = byCode(diags, "WXAML0005").filter((x) =>
    forbiddenTokens.some((token) => diagText(x).includes(token) || x.message.includes(token)));
  assert.deepStrictEqual(hits.map((x) => `${diagText(x)}:${x.message}`), [], `${note} must not raise WXAML0005 for ${forbiddenTokens.join(", ")}; buffer=${buffer}; got ${summary(diags)}`);
}

describe("WinUI XAML red-team 29 — resource navigation and scoping", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("F12 lands on an x:Key value even when x:Key is on a later line than the resource tag", async () => {
    const buffer = page([
      "<Page.Resources>",
      "  <SolidColorBrush",
      '      Color="Red"',
      '      x:Key="SplitLineBrush29" />',
      "</Page.Resources>",
      '<Border Background="{StaticResource SplitLine|Brush29}" />',
    ].join("\n  "));
    const defs = await definitionDetails(buffer);
    assert.ok(defs.length > 0, `split-line resource should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), XAML, `expected in-buffer XAML definition; buffer=${buffer}; got ${defs[0].fsPath}`);
    assert.strictEqual(h.getDoc().getText(defs[0].range), "SplitLineBrush29", `definition range should select the x:Key value; buffer=${buffer}; got ${h.getDoc().getText(defs[0].range)}`);
  });

  it("F12 resolves a key inside an explicit Page.Resources ResourceDictionary wrapper", async () => {
    const buffer = page([
      "<Page.Resources>",
      "  <ResourceDictionary>",
      '    <SolidColorBrush x:Key="WrappedBrush29" Color="Red" />',
      "  </ResourceDictionary>",
      "</Page.Resources>",
      '<Border Background="{StaticResource Wrapped|Brush29}" />',
    ].join("\n  "));
    const defs = await definitionDetails(buffer);
    assert.ok(defs.length > 0, `wrapped resource should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(h.getDoc().getText(defs[0].range), "WrappedBrush29", `definition should select wrapped x:Key; buffer=${buffer}; got ${h.getDoc().getText(defs[0].range)}`);
  });

  it("F12 resolves StaticResource nested under Binding.Source through an explicit dictionary wrapper", async () => {
    const buffer = page([
      "<Page.Resources>",
      "  <ResourceDictionary>",
      '    <x:String x:Key="NestedWrappedKey29">hello</x:String>',
      "  </ResourceDictionary>",
      "</Page.Resources>",
      '<Border Tag="{Binding Source={StaticResource NestedWrapped|Key29}}" />',
    ].join("\n  "));
    const defs = await definitionDetails(buffer);
    assert.ok(defs.length > 0, `nested wrapped Binding.Source key should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(h.getDoc().getText(defs[0].range), "NestedWrappedKey29", `definition should select nested wrapped x:Key; buffer=${buffer}; got ${h.getDoc().getText(defs[0].range)}`);
  });

  it("inner ResourceDictionary wrapper shadows a Page.Resources duplicate for references inside the owner", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <SolidColorBrush x:Key="WrappedShadow29" Color="Red" />',
      "</Page.Resources>",
      "<Grid>",
      "  <Grid.Resources>",
      "    <ResourceDictionary>",
      '      <SolidColorBrush x:Key="WrappedShadow29" Color="Blue" />',
      "    </ResourceDictionary>",
      "  </Grid.Resources>",
      '  <Border Background="{StaticResource Wrapped|Shadow29}" />',
      "</Grid>",
    ].join("\n  "));
    const defs = await definitionDetails(buffer);
    assert.ok(defs.length > 0, `wrapped inner shadow should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.match(targetLine(defs[0]), /Color="Blue"/, `inner wrapped resource should win; buffer=${buffer}; got line: ${targetLine(defs[0])}`);
  });

  it("a sibling after an inner ResourceDictionary wrapper resolves the outer duplicate key", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <SolidColorBrush x:Key="WrappedAfterScope29" Color="Red" />',
      "</Page.Resources>",
      "<StackPanel>",
      "  <Grid>",
      "    <Grid.Resources>",
      "      <ResourceDictionary>",
      '        <SolidColorBrush x:Key="WrappedAfterScope29" Color="Blue" />',
      "      </ResourceDictionary>",
      "    </Grid.Resources>",
      "  </Grid>",
      '  <Border Background="{StaticResource WrappedAfter|Scope29}" />',
      "</StackPanel>",
    ].join("\n  "));
    const defs = await definitionDetails(buffer);
    assert.ok(defs.length > 0, `post-inner-scope reference should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.match(targetLine(defs[0]), /Color="Red"/, `sibling reference should land on Page.Resources, not inner dictionary; buffer=${buffer}; got line: ${targetLine(defs[0])}`);
  });

  it("completion keeps an App.xaml key when an inaccessible page resource has the same name", async () => {
    const buffer = page([
      "<StackPanel>",
      "  <Grid>",
      "    <Grid.Resources>",
      '      <SolidColorBrush x:Key="SmokeAccentBrush" Color="Orange" />',
      "    </Grid.Resources>",
      "  </Grid>",
      '  <Border Background="{StaticResource SmokeAccent|}" />',
      "</StackPanel>",
    ].join("\n  "));
    const items = await h.completionItemsAt(buffer);
    assert.ok(
      items.some((item) => item.label === "SmokeAccentBrush" && item.detail === "resource"),
      `the distinct App.xaml SmokeAccentBrush must remain available outside the page-local resource scope; got ${JSON.stringify(items)}`
    );
  });

  it("completion exports root-visible App.xaml keys but not keyed-nested or child-scope keys", async () => {
    const items = await h.completionItemsAt(
      page('<Border Background="{StaticResource |}" />')
    );
    const resources = items
      .filter((item) => item.detail === "resource")
      .map((item) => item.label);
    assert.ok(resources.includes("SmokeAccentBrush"), `root-visible App key must be global; got ${JSON.stringify(resources)}`);
    assert.ok(resources.includes("AppNestedDictionary"), `keyed nested dictionary itself must remain root-visible; got ${JSON.stringify(resources)}`);
    assert.ok(resources.includes("AppScopedOwner"), `keyed root entry must remain root-visible; got ${JSON.stringify(resources)}`);
    assert.ok(!resources.includes("AppNestedOnlyBrush"), `resource inside keyed nested dictionary must not leak globally; got ${JSON.stringify(resources)}`);
    assert.ok(!resources.includes("AppChildOnlyBrush"), `resource inside child element scope must not leak globally; got ${JSON.stringify(resources)}`);
  });

  it("diagnostics use root-visible App.xaml keys but ignore nested-scope keys", async () => {
    const buffer = page([
      "<StackPanel>",
      '  <Border Background="{StaticResource SmokeAccentBrus}" />',
      '  <Border Background="{StaticResource AppNestedOnlyBrus}" />',
      "</StackPanel>",
    ].join("\n  "));
    const diagnostics = await h.diagnosticsFor(
      buffer,
      (items) => items.some((item) => item.message.includes("SmokeAccentBrus")),
      12000
    );
    assert.ok(
      diagnostics.some((item) => item.message.includes("SmokeAccentBrus")),
      `root-visible App key should make a close typo diagnosable; got ${JSON.stringify(diagnostics)}`
    );
    assert.ok(
      !diagnostics.some((item) => item.message.includes("AppNestedOnlyBrus")),
      `nested-scope App key must not make a close typo diagnosable cross-document; got ${JSON.stringify(diagnostics)}`
    );
  });

  it("ThemeResource F12 resolves an entry inside ResourceDictionary.ThemeDictionaries, not the Light dictionary key", async () => {
    const buffer = page([
      "<Page.Resources>",
      "  <ResourceDictionary>",
      "    <ResourceDictionary.ThemeDictionaries>",
      '      <ResourceDictionary x:Key="Light">',
      '        <SolidColorBrush x:Key="ThemeEntryBrush29" Color="White" />',
      "      </ResourceDictionary>",
      "    </ResourceDictionary.ThemeDictionaries>",
      "  </ResourceDictionary>",
      "</Page.Resources>",
      '<Border Background="{ThemeResource ThemeEntry|Brush29}" />',
    ].join("\n  "));
    const defs = await definitionDetails(buffer);
    assert.ok(defs.length > 0, `theme dictionary entry should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(h.getDoc().getText(defs[0].range), "ThemeEntryBrush29", `definition should select theme entry key, not Light; buffer=${buffer}; got ${h.getDoc().getText(defs[0].range)}`);
  });

  it("F12 on a StaticResource key does not misfire to an implicit x:Type style key", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <Style x:Key="{x:Type Button}" TargetType="Button" />',
      "</Page.Resources>",
      '<Button Style="{StaticResource But|ton}" />',
    ].join("\n  "));
    const defs = await h.definitionsAt(buffer);
    assert.ok(defs.length === 0 || defs.every((d) => path.basename(d.fsPath) !== XAML), `x:Type implicit-style key should not be treated as a string key; buffer=${buffer}; got ${JSON.stringify(defs)}`);
  });

  it("a local SmokeAccentBrush shadows the App.xaml resource of the same key", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <SolidColorBrush x:Key="SmokeAccentBrush" Color="Orange" />',
      "</Page.Resources>",
      '<Border Background="{StaticResource SmokeAccent|Brush}" />',
    ].join("\n  "));
    const defs = await definitionDetails(buffer);
    assert.ok(defs.length > 0, `local SmokeAccentBrush should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), XAML, `local page resource should beat App.xaml; buffer=${buffer}; got ${defs[0].fsPath}`);
    assert.match(targetLine(defs[0]), /Color="Orange"/, `definition should land on local Orange brush; buffer=${buffer}; got line: ${targetLine(defs[0])}`);
  });
});

describe("WinUI XAML red-team 29 — x:Bind function-argument diagnostics", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("WXAML0005 stays silent for literal, prefixed, nested markup, nested call, and cast function args while a sentinel fires", async () => {
    const buffer = page([
      '<StackPanel>',
      '  <TextBlock Text="{x:Bind OnGo_Click(\'{}{0}\', 42, x:Null, x:Static RedTeam29.StaticValue, {Binding GreetingText}, GreetingText.ToString(), (local:SmokePage)GreetingText)}" />',
      '  <TextBlock Text="{x:Bind OnGo_Click(__SentinelMissing29)}" />',
      '</StackPanel>',
    ].join("\n  "));
    await expectNoWxaml0005For(buffer, ["RedTeam29", "StaticValue", "ToString"], "skipped function-argument forms");
  });

  it("Path= function binding validates a good argument without false-positive WXAML0005 while a sentinel fires", async () => {
    const buffer = page([
      '<StackPanel>',
      '  <TextBlock Text="{x:Bind Path=OnGo_Click(GreetingText)}" />',
      '  <TextBlock Text="{x:Bind OnGo_Click(__SentinelMissing29)}" />',
      '</StackPanel>',
    ].join("\n  "));
    await expectNoWxaml0005For(buffer, ["GreetingText"], "Path= function-binding good argument");
  });

  it("negated function binding validates a good argument without false-positive WXAML0005 while a sentinel fires", async () => {
    const buffer = page([
      '<StackPanel>',
      '  <TextBlock Text="{x:Bind !OnGo_Click(GreetingText)}" />',
      '  <TextBlock Text="{x:Bind OnGo_Click(__SentinelMissing29)}" />',
      '</StackPanel>',
    ].join("\n  "));
    await expectNoWxaml0005For(buffer, ["GreetingText"], "negated function-binding good argument");
  });

  it("a bogus first-segment function argument raises WXAML0005", async () => {
    const buffer = page('<TextBlock Text="{x:Bind OnGo_Click(MissingFirstSegment29)}" />');
    await expectWxaml0005(buffer, "MissingFirstSegment29", "bogus first-segment function argument");
  });

  it("a bogus deep segment after an indexed function argument raises WXAML0005", async () => {
    const buffer = page('<TextBlock Text="{x:Bind OnGo_Click(Items[0].MissingDeepSegment29)}" />');
    await expectWxaml0005(buffer, "MissingDeepSegment29", "bogus deep function argument segment");
  });

  it("function arguments inside an x:String DataTemplate are validated against x:DataType and stay silent for Length", async () => {
    const buffer = page([
      '<StackPanel>',
      '  <ItemsRepeater ItemsSource="{x:Bind Items}">',
      '    <ItemsRepeater.ItemTemplate>',
      '      <DataTemplate x:DataType="x:String">',
      '        <TextBlock Text="{x:Bind ToString(Length)}" />',
      '      </DataTemplate>',
      '    </ItemsRepeater.ItemTemplate>',
      '  </ItemsRepeater>',
      '  <TextBlock Text="{x:Bind OnGo_Click(__SentinelMissing29)}" />',
      '</StackPanel>',
    ].join("\n  "));
    await expectNoWxaml0005For(buffer, ["Length", "ToString"], "x:DataType function argument");
  });
});

describe("WinUI XAML red-team 29 — x:Bind function-argument completion", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("completion in the first function argument offers page-root members", async () => {
    const buffer = page('<TextBlock Text="{x:Bind OnGo_Click(|)}" />');
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("GreetingText"), `first function-arg completion should include GreetingText; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
    assert.ok(items.includes("Items"), `first function-arg completion should include Items; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("completion after an indexed dotted function argument prefix offers String members, not page-root members", async () => {
    const buffer = page('<TextBlock Text="{x:Bind OnGo_Click(Items[0].|)}" />');
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("Length"), `Items[0]. function-arg completion should include String.Length; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
    assert.ok(!items.includes("GreetingText"), `Items[0]. function-arg completion should not reroot to page members; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("completion inside a nested function call does not escape to top-level markup arguments", async () => {
    const buffer = page('<TextBlock Text="{x:Bind OnGo_Click(GreetingText.ToString(|))}" />');
    const items = await h.completionsAt(buffer);
    assert.ok(!items.includes("Mode"), `nested function-call completion should not offer x:Bind markup args; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("Mode= completion after a top-level comma outside function parens offers BindingMode values, not root members", async () => {
    const buffer = page('<TextBlock Text="{x:Bind OnGo_Click(GreetingText), Mode=|}" />');
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("OneWay") || items.includes("TwoWay"), `Mode= completion after function binding should offer BindingMode values; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
    assert.ok(!items.includes("Items"), `Mode= completion should not be treated as a function-argument gap; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });
});
