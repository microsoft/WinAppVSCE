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

function pageNoClass(inner) {
  return `<Page ${h.NS}>\n  ${inner}\n</Page>`;
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

function flattenNodes(nodes, out = []) {
  for (const n of nodes || []) {
    out.push(n);
    if (n.children && n.children.length) flattenNodes(n.children, out);
  }
  return out;
}

function names(nodes) {
  return flattenNodes(nodes).map((n) => n.name);
}

async function diagnosticsWith(buffer, code, needle) {
  const diags = await h.diagnosticsFor(buffer, (d) =>
    byCode(d, code).some((x) => diagText(x).includes(needle) || x.message.includes(needle)), 15000);
  assert.ok(byCode(diags, code).some((x) => diagText(x).includes(needle) || x.message.includes(needle)),
    `expected ${code} for ${needle}; buffer=${buffer}; got ${summary(diags)}`);
  return diags;
}

describe("WinUI XAML red-team 30 — document outline", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("preserves hierarchy through comments, CDATA, property elements, self-closing and named nodes", async () => {
    const buffer = page([
      "<Grid x:Name=\"RootGrid30\">",
      "  <!-- <Button x:Name=\"CommentGhost30\" /> -->",
      "  <![CDATA[ <TextBlock x:Name=\"CDataGhost30\" /> ]]>",
      "  <Grid.RowDefinitions>",
      "    <RowDefinition Height=\"Auto\" />",
      "    <RowDefinition Height=\"*\" />",
      "  </Grid.RowDefinitions>",
      "  <StackPanel>",
      "    <Button x:Name=\"GoOutline30\" Content=\"Go\" />",
      "    <Border x:Name=\"OpenClose30\"></Border>",
      "  </StackPanel>",
      "</Grid>",
    ].join("\n  "));
    const syms = await h.symbolsAt(buffer);
    const flat = flattenNodes(syms);
    const got = flat.map((s) => `${s.name}:${s.kind}`).join(", ");
    assert.strictEqual(syms.length, 1, `expected one Page root; buffer=${buffer}; got ${got}`);
    assert.match(syms[0].name, /^Page/, `root should be Page; buffer=${buffer}; got ${got}`);
    const grid = syms[0].children?.find((s) => /Grid \(RootGrid30\)/.test(s.name));
    assert.ok(grid, `expected named Grid under Page; buffer=${buffer}; got ${got}`);
    const rowDefs = grid.children?.find((s) => s.name === "Grid.RowDefinitions");
    assert.ok(rowDefs, `expected Grid.RowDefinitions property node; buffer=${buffer}; got ${got}`);
    assert.strictEqual(rowDefs.kind, vscode.SymbolKind.Property, `Grid.RowDefinitions should be a Property symbol; buffer=${buffer}; got ${got}`);
    assert.strictEqual((rowDefs.children || []).filter((s) => s.name === "RowDefinition").length, 2, `expected two RowDefinition children; buffer=${buffer}; got ${got}`);
    assert.ok(flat.some((s) => /Button \(GoOutline30\)/.test(s.name)), `expected x:Name-labeled Button; buffer=${buffer}; got ${got}`);
    assert.ok(flat.some((s) => /Border \(OpenClose30\)/.test(s.name)), `expected open/close Border; buffer=${buffer}; got ${got}`);
    assert.ok(!names(syms).some((n) => /Ghost30/.test(n)), `comments/CDATA must not create symbols; buffer=${buffer}; got ${got}`);
  });

  it("keeps a sane partial tree when a child tag is left unclosed", async () => {
    const buffer = pageNoClass([
      "<Grid>",
      "  <StackPanel>",
      "    <Button x:Name=\"UnclosedButton30\" Content=\"Go\">",
      "  </StackPanel>",
      "  <TextBlock x:Name=\"SiblingAfterMalformed30\" />",
      "</Grid>",
    ].join("\n  "));
    const syms = await h.symbolsAt(buffer);
    const got = names(syms).join(", ");
    assert.ok(got.includes("Page"), `malformed outline should retain Page; buffer=${buffer}; got ${got}`);
    assert.ok(got.includes("Grid"), `malformed outline should retain Grid; buffer=${buffer}; got ${got}`);
    assert.ok(/Button \(UnclosedButton30\)/.test(got), `malformed outline should retain unclosed Button; buffer=${buffer}; got ${got}`);
    assert.ok(/TextBlock \(SiblingAfterMalformed30\)/.test(got), `malformed outline should retain sibling after malformed child; buffer=${buffer}; got ${got}`);
  });
});

describe("WinUI XAML red-team 30 — duplicate x:Name / x:Key diagnostics", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("flags duplicate x:Name inside one DataTemplate name scope", async () => {
    const buffer = page([
      "<ItemsRepeater>",
      "  <ItemsRepeater.ItemTemplate>",
      "    <DataTemplate x:DataType=\"x:String\">",
      "      <StackPanel>",
      "        <TextBlock x:Name=\"TemplateDup30\" />",
      "        <Button x:Name=\"TemplateDup30\" />",
      "      </StackPanel>",
      "    </DataTemplate>",
      "  </ItemsRepeater.ItemTemplate>",
      "</ItemsRepeater>",
    ].join("\n  "));
    const diags = await diagnosticsWith(buffer, "WXAML0007", "TemplateDup30");
    const hits = byCode(diags, "WXAML0007").filter((x) => diagText(x) === "TemplateDup30");
    assert.strictEqual(hits.length, 1, `expected exactly one duplicate-name error; buffer=${buffer}; got ${summary(diags)}`);
    assert.strictEqual(hits[0].severity, vscode.DiagnosticSeverity.Error, `WXAML0007 should be an error; buffer=${buffer}; got ${summary(diags)}`);
  });

  it("does not collide the same x:Name across sibling DataTemplates while a page-scope sentinel fires", async () => {
    const buffer = page([
      "<StackPanel>",
      "  <Button x:Name=\"PageScopeSentinel30\" />",
      "  <Button x:Name=\"PageScopeSentinel30\" />",
      "  <ItemsRepeater>",
      "    <ItemsRepeater.ItemTemplate>",
      "      <DataTemplate x:DataType=\"x:String\"><TextBlock x:Name=\"ItemRoot30\" /></DataTemplate>",
      "    </ItemsRepeater.ItemTemplate>",
      "  </ItemsRepeater>",
      "  <ListView>",
      "    <ListView.ItemTemplate>",
      "      <DataTemplate x:DataType=\"x:String\"><TextBlock x:Name=\"ItemRoot30\" /></DataTemplate>",
      "    </ListView.ItemTemplate>",
      "  </ListView>",
      "</StackPanel>",
    ].join("\n  "));
    const diags = await diagnosticsWith(buffer, "WXAML0007", "PageScopeSentinel30");
    const templateHits = byCode(diags, "WXAML0007").filter((x) => diagText(x).includes("ItemRoot30") || x.message.includes("ItemRoot30"));
    assert.deepStrictEqual(templateHits.map((x) => `${diagText(x)}:${x.message}`), [], `sibling DataTemplates must have independent name scopes; buffer=${buffer}; got ${summary(diags)}`);
  });

  it("does not collide x:Name inside a DataTemplate with the page name scope", async () => {
    const buffer = page([
      "<StackPanel>",
      "  <Button x:Name=\"OutsideTemplate30\" />",
      "  <ItemsRepeater>",
      "    <ItemsRepeater.ItemTemplate>",
      "      <DataTemplate x:DataType=\"x:String\"><TextBlock x:Name=\"OutsideTemplate30\" /></DataTemplate>",
      "    </ItemsRepeater.ItemTemplate>",
      "  </ItemsRepeater>",
      "  <TextBlock x:Name=\"PageNameSentinel30\" />",
      "  <Border x:Name=\"PageNameSentinel30\" />",
      "</StackPanel>",
    ].join("\n  "));
    const diags = await diagnosticsWith(buffer, "WXAML0007", "PageNameSentinel30");
    const crossScopeHits = byCode(diags, "WXAML0007").filter((x) => diagText(x).includes("OutsideTemplate30") || x.message.includes("OutsideTemplate30"));
    assert.deepStrictEqual(crossScopeHits.map((x) => `${diagText(x)}:${x.message}`), [], `template contents should not collide with page scope; buffer=${buffer}; got ${summary(diags)}`);
  });

  it("flags duplicate x:Key in the same ResourceDictionary scope", async () => {
    const buffer = page([
      "<Page.Resources>",
      "  <SolidColorBrush x:Key=\"SameDictKey30\" Color=\"Red\" />",
      "  <SolidColorBrush x:Key=\"SameDictKey30\" Color=\"Blue\" />",
      "</Page.Resources>",
      "<Grid />",
    ].join("\n  "));
    const diags = await diagnosticsWith(buffer, "WXAML0008", "SameDictKey30");
    const hits = byCode(diags, "WXAML0008").filter((x) => diagText(x) === "SameDictKey30");
    assert.strictEqual(hits.length, 1, `expected exactly one duplicate-key error; buffer=${buffer}; got ${summary(diags)}`);
    assert.strictEqual(hits[0].severity, vscode.DiagnosticSeverity.Error, `WXAML0008 should be an error; buffer=${buffer}; got ${summary(diags)}`);
  });

  it("does not collide duplicate x:Key values across Page.Resources and Grid.Resources", async () => {
    const buffer = page([
      "<Page.Resources>",
      "  <SolidColorBrush x:Key=\"ScopedBrush30\" Color=\"Red\" />",
      "</Page.Resources>",
      "<Grid>",
      "  <Grid.Resources>",
      "    <SolidColorBrush x:Key=\"ScopedBrush30\" Color=\"Blue\" />",
      "    <SolidColorBrush x:Key=\"KeySentinel30\" Color=\"Green\" />",
      "    <SolidColorBrush x:Key=\"KeySentinel30\" Color=\"Yellow\" />",
      "  </Grid.Resources>",
      "</Grid>",
    ].join("\n  "));
    const diags = await diagnosticsWith(buffer, "WXAML0008", "KeySentinel30");
    const scopedHits = byCode(diags, "WXAML0008").filter((x) => diagText(x).includes("ScopedBrush30") || x.message.includes("ScopedBrush30"));
    assert.deepStrictEqual(scopedHits.map((x) => `${diagText(x)}:${x.message}`), [], `separate resource dictionaries must not collide; buffer=${buffer}; got ${summary(diags)}`);
  });

  it("does not collide duplicate x:Key values across theme dictionaries", async () => {
    const buffer = page([
      "<Page.Resources>",
      "  <ResourceDictionary>",
      "    <ResourceDictionary.ThemeDictionaries>",
      "      <ResourceDictionary x:Key=\"Light\"><SolidColorBrush x:Key=\"ThemeScoped30\" Color=\"White\" /></ResourceDictionary>",
      "      <ResourceDictionary x:Key=\"Dark\"><SolidColorBrush x:Key=\"ThemeScoped30\" Color=\"Black\" /></ResourceDictionary>",
      "    </ResourceDictionary.ThemeDictionaries>",
      "    <SolidColorBrush x:Key=\"ThemeSentinel30\" Color=\"Red\" />",
      "    <SolidColorBrush x:Key=\"ThemeSentinel30\" Color=\"Blue\" />",
      "  </ResourceDictionary>",
      "</Page.Resources>",
      "<Grid />",
    ].join("\n  "));
    const diags = await diagnosticsWith(buffer, "WXAML0008", "ThemeSentinel30");
    const themeHits = byCode(diags, "WXAML0008").filter((x) => diagText(x).includes("ThemeScoped30") || x.message.includes("ThemeScoped30"));
    assert.deepStrictEqual(themeHits.map((x) => `${diagText(x)}:${x.message}`), [], `theme dictionaries must be separate key scopes; buffer=${buffer}; got ${summary(diags)}`);
  });

  it("flags duplicate x:Key expressed as an {x:Type ...} implicit-style key", async () => {
    const buffer = page([
      "<Page.Resources>",
      "  <Style x:Key=\"{x:Type Button}\" TargetType=\"Button\" />",
      "  <Style x:Key=\"{x:Type Button}\" TargetType=\"Button\" />",
      "  <Style x:Key=\"{x:Type TextBox}\" TargetType=\"TextBox\" />",
      "  <SolidColorBrush x:Key=\"Button\" Color=\"Red\" />",
      "</Page.Resources>",
      "<Grid />",
    ].join("\n  "));
    const diags = await diagnosticsWith(buffer, "WXAML0008", "Button");
    const typeHits = byCode(diags, "WXAML0008");
    assert.strictEqual(typeHits.length, 1, `duplicate {x:Type Button} should raise exactly one WXAML0008 (distinct {x:Type TextBox} and the same-text string key "Button" must not collide); buffer=${buffer}; got ${summary(diags)}`);
    assert.strictEqual(typeHits[0].severity, vscode.DiagnosticSeverity.Error, `WXAML0008 should be an error; buffer=${buffer}; got ${summary(diags)}`);
    assert.strictEqual(diagText(typeHits[0]), "Button", `duplicate-type-key span should select the type argument; buffer=${buffer}; got ${diagText(typeHits[0])}`);
  });
});

describe("WinUI XAML red-team 30 — event handler completion and navigation", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("completes code-behind handlers in empty and partial Click attributes", async () => {
    const empty = page('<Button Click="|" />');
    const emptyItems = await h.completionsAt(empty);
    assert.ok(emptyItems.includes("OnGo_Click"), `empty Click should offer OnGo_Click; buffer=${empty}; got ${emptyItems.slice(0, 80).join(", ")}`);
    const partial = page('<Button Click="OnGo_|" />');
    const partialItems = await h.completionsAt(partial);
    assert.ok(partialItems.includes("OnGo_Click"), `partial Click should offer OnGo_Click; buffer=${partial}; got ${partialItems.slice(0, 80).join(", ")}`);
  });

  it("completes handlers for Loaded but not for a non-event attribute", async () => {
    const loaded = page('<Button Loaded="|" />');
    const loadedItems = await h.completionsAt(loaded);
    assert.ok(loadedItems.includes("OnGo_Click"), `Loaded should offer RoutedEventHandler-compatible OnGo_Click; buffer=${loaded}; got ${loadedItems.slice(0, 80).join(", ")}`);
    const content = page('<Button Content="|" />');
    const contentItems = await h.completionsAt(content);
    assert.ok(!contentItems.includes("OnGo_Click"), `non-event Content must not offer event handlers; buffer=${content}; got ${contentItems.slice(0, 80).join(", ")}`);
  });

  it("F12 on a Loaded handler lands on the code-behind method", async () => {
    const buffer = page('<Button Loaded="OnGo_Cl|ick" />');
    const defs = await definitionDetails(buffer);
    assert.ok(defs.length > 0, `Loaded handler should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), CS, `expected ${CS}; buffer=${buffer}; got ${defs[0].fsPath}`);
  });
});

describe("WinUI XAML red-team 30 — xmlns prefix validation", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("flags undeclared prefixes on elements and attached-property attributes", async () => {
    const buffer = page([
      "<Grid>",
      "  <zzz:Widget />",
      "  <Button zzz:Foo.Bar=\"1\" />",
      "</Grid>",
    ].join("\n  "));
    const diags = await h.diagnosticsFor(buffer, (d) => byCode(d, "WXAML0001").length >= 2, 15000);
    const hits = byCode(diags, "WXAML0001");
    const clean = buffer.replace("|", "");
    const elementLine = clean.split("\n").findIndex((l) => l.includes("<zzz:Widget"));
    const attachedLine = clean.split("\n").findIndex((l) => l.includes("zzz:Foo.Bar"));
    assert.ok(hits.some((x) => diagText(x) === "zzz" && x.range.start.line === elementLine), `expected undeclared element prefix; buffer=${buffer}; got ${summary(diags)}`);
    assert.ok(hits.some((x) => diagText(x) === "zzz" && x.range.start.line === attachedLine), `expected undeclared attached-property prefix; buffer=${buffer}; got ${summary(diags)}`);
    assert.ok(hits.every((x) => x.severity === vscode.DiagnosticSeverity.Error), `WXAML0001 should be error severity; buffer=${buffer}; got ${summary(diags)}`);
  });

  it("keeps a declared-but-unused prefix silent while an undeclared-prefix sentinel fires", async () => {
    const buffer = `<Page ${h.NS}\n    xmlns:unused30="using:SmokeFixture"\n    x:Class="SmokeFixture.SmokePage">\n  <Grid>\n    <zzz:Widget />\n  </Grid>\n</Page>`;
    const diags = await diagnosticsWith(buffer, "WXAML0001", "zzz");
    const unusedHits = byCode(diags, "WXAML0001").filter((x) => diagText(x).includes("unused30") || x.message.includes("unused30"));
    assert.deepStrictEqual(unusedHits.map((x) => `${diagText(x)}:${x.message}`), [], `declared unused prefixes should stay silent; buffer=${buffer}; got ${summary(diags)}`);
  });
});

describe("WinUI XAML red-team 30 — nested markup-extension completion", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("completes resource keys inside Binding.Converter's nested StaticResource", async () => {
    const buffer = page([
      "<Page.Resources>",
      "  <SolidColorBrush x:Key=\"NestedConverterBrush30\" Color=\"Red\" />",
      "</Page.Resources>",
      '<Border Tag="{Binding Converter={StaticResource Nested|}}" />',
    ].join("\n  "));
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("NestedConverterBrush30"), `nested Binding Converter StaticResource should complete local key; buffer=${buffer}; got ${items.slice(0, 80).join(", ")}`);
  });

  it("completes resource keys inside x:Bind.Converter's nested StaticResource", async () => {
    const buffer = page([
      "<Page.Resources>",
      "  <SolidColorBrush x:Key=\"NestedXBindBrush30\" Color=\"Blue\" />",
      "</Page.Resources>",
      '<TextBlock Text="{x:Bind GreetingText, Converter={StaticResource NestedX|}}" />',
    ].join("\n  "));
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("NestedXBindBrush30"), `nested x:Bind Converter StaticResource should complete local key; buffer=${buffer}; got ${items.slice(0, 80).join(", ")}`);
  });

  it("completes RelativeSource.Mode values at nested markup depth", async () => {
    const buffer = page('<Border Tag="{Binding RelativeSource={RelativeSource Mode=|}}" />');
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("Self"), `nested RelativeSource Mode should include Self; buffer=${buffer}; got ${items.slice(0, 80).join(", ")}`);
    assert.ok(items.includes("TemplatedParent"), `nested RelativeSource Mode should include TemplatedParent; buffer=${buffer}; got ${items.slice(0, 80).join(", ")}`);
    assert.ok(!items.includes("OneWay"), `nested RelativeSource Mode must not use BindingMode values; buffer=${buffer}; got ${items.slice(0, 80).join(", ")}`);
  });

  it("completes TemplateBinding properties without being confused by outer ControlTemplate markup", async () => {
    const buffer = page([
      "<Page.Resources>",
      "  <ControlTemplate TargetType=\"Button\">",
      '    <ContentPresenter Content="{TemplateBinding Con|}" />',
      "  </ControlTemplate>",
      "</Page.Resources>",
      "<Grid />",
    ].join("\n  "));
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("Content"), `TemplateBinding partial should complete templated-parent Content; buffer=${buffer}; got ${items.slice(0, 80).join(", ")}`);
    assert.ok(!items.includes("SmokeAccentBrush"), `TemplateBinding property completion must not fall into resource-key completion; buffer=${buffer}; got ${items.slice(0, 80).join(", ")}`);
  });
});

