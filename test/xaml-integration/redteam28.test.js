"use strict";

// Round 28 red-team probes: resource-key precision, nested markup-extension depth,
// x:Bind function arguments, and markup argument splitting.

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

function summary(diags) {
  return wxaml(diags).map((d) => `${d.code}:${d.severity}:${d.message}`).join("; ");
}

describe("WinUI XAML red-team 28 — resource-key precision", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("StaticResource partial key completion filters project resources out of a distinctive local prefix", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <SolidColorBrush x:Key="Round28AlphaBrush" Color="Red" />',
      "</Page.Resources>",
      '<Border Background="{StaticResource Round28Al|}" />',
    ].join("\n  "));
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("Round28AlphaBrush"), `local partial key should complete; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
    assert.ok(!items.includes("SmokeAccentBrush"), `partial prefix should filter unrelated App.xaml key; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("F12 on a Page.Resources StaticResource key lands on the x:Key value span", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <SolidColorBrush x:Key="PageBrush28" Color="Red" />',
      "</Page.Resources>",
      '<Border Background="{StaticResource Page|Brush28}" />',
    ].join("\n  "));
    const defs = await definitionDetails(buffer);
    assert.ok(defs.length > 0, `Page.Resources StaticResource should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), XAML, `expected in-buffer XAML definition; buffer=${buffer}; got ${defs[0].fsPath}`);
    assert.strictEqual(h.getDoc().getText(defs[0].range), "PageBrush28", `definition range should select only the x:Key value; buffer=${buffer}; got ${h.getDoc().getText(defs[0].range)}`);
  });

  it("hover on a ThemeResource key has StaticResource parity for local resources", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <SolidColorBrush x:Key="ThemeParityBrush28" Color="Green" />',
      "</Page.Resources>",
      '<Border Background="{ThemeResource ThemeParity|Brush28}" />',
    ].join("\n  "));
    const md = await h.hoverAt(buffer);
    assert.match(md, /ThemeParityBrush28/, `ThemeResource hover should include key name; buffer=${buffer}; got: ${md}`);
    assert.match(md, /SolidColorBrush/, `ThemeResource hover should include resource type; buffer=${buffer}; got: ${md}`);
  });

  it("F12 on the StaticResource extension name does not jump to its key", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <SolidColorBrush x:Key="NameCaretBrush28" Color="Red" />',
      "</Page.Resources>",
      '<Border Background="{StaticR|esource NameCaretBrush28}" />',
    ].join("\n  "));
    const defs = await h.definitionsAt(buffer);
    assert.ok(defs.length === 0 || defs.every((d) => path.basename(d.fsPath) !== XAML), `extension-name caret must not resolve as resource key; buffer=${buffer}; got ${JSON.stringify(defs)}`);
  });

  it("inner Grid.Resources key shadows an outer Page.Resources key for F12", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <SolidColorBrush x:Key="ShadowBrush28" Color="Red" />',
      "</Page.Resources>",
      "<Grid>",
      "  <Grid.Resources>",
      '    <SolidColorBrush x:Key="ShadowBrush28" Color="Blue" />',
      "  </Grid.Resources>",
      '  <Border Background="{StaticResource Shadow|Brush28}" />',
      "</Grid>",
    ].join("\n  "));
    const defs = await definitionDetails(buffer);
    assert.ok(defs.length > 0, `shadowed inner resource should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.match(targetLine(defs[0]), /Color="Blue"/, `inner reference should land on the Grid.Resources key, not Page.Resources; buffer=${buffer}; got line: ${targetLine(defs[0])}`);
  });

  it("a resource reference after the inner scope resolves the outer duplicate key", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <SolidColorBrush x:Key="AfterScopeBrush28" Color="Red" />',
      "</Page.Resources>",
      "<StackPanel>",
      "  <Grid>",
      "    <Grid.Resources>",
      '      <SolidColorBrush x:Key="AfterScopeBrush28" Color="Blue" />',
      "    </Grid.Resources>",
      "  </Grid>",
      '  <Border Background="{StaticResource AfterScope|Brush28}" />',
      "</StackPanel>",
    ].join("\n  "));
    const defs = await definitionDetails(buffer);
    assert.ok(defs.length > 0, `post-scope resource should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.match(targetLine(defs[0]), /Color="Red"/, `reference after Grid scope should land on Page.Resources, not the nested dictionary; buffer=${buffer}; got line: ${targetLine(defs[0])}`);
  });

  it("unknown StaticResource key stays diagnostic-silent and returns no definition", async () => {
    const buffer = page('<Border Background="{StaticResource MissingResourceKey28|}" />');
    const defs = await h.definitionsAt(buffer);
    assert.strictEqual(defs.length, 0, `unknown StaticResource should not resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    const diags = await h.diagnosticsFor(buffer, () => false, 3500);
    assert.strictEqual(wxaml(diags).length, 0, `current unknown StaticResource behavior should be WXAML-silent; buffer=${buffer}; got ${summary(diags)}`);
  });
});

describe("WinUI XAML red-team 28 — nested markup extensions", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("F12 resolves the inner StaticResource inside Binding.Source", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <x:String x:Key="BindingSourceKey28">hello</x:String>',
      "</Page.Resources>",
      '<Border Tag="{Binding Source={StaticResource BindingSource|Key28}}" />',
    ].join("\n  "));
    const defs = await definitionDetails(buffer);
    assert.ok(defs.length > 0, `inner Binding.Source StaticResource should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(h.getDoc().getText(defs[0].range), "BindingSourceKey28", `definition should select the inner x:Key value; buffer=${buffer}; got ${h.getDoc().getText(defs[0].range)}`);
  });

  it("caret on the outer Binding name does not swallow the inner resource key", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <x:String x:Key="OuterNameKey28">hello</x:String>',
      "</Page.Resources>",
      '<Border Tag="{Bin|ding Source={StaticResource OuterNameKey28}}" />',
    ].join("\n  "));
    const defs = await h.definitionsAt(buffer);
    assert.strictEqual(defs.length, 0, `outer Binding-name caret should not resolve the nested resource; buffer=${buffer}; got ${JSON.stringify(defs)}`);
  });

  it("x:Bind Converter nested StaticResource still resolves the inner key", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <SolidColorBrush x:Key="NestedConverterKey28" Color="Purple" />',
      "</Page.Resources>",
      '<TextBlock Text="{x:Bind GreetingText, Converter={StaticResource NestedConverter|Key28}}" />',
    ].join("\n  "));
    const md = await h.hoverAt(buffer);
    assert.match(md, /NestedConverterKey28/, `nested Converter resource hover should include key; buffer=${buffer}; got: ${md}`);
    assert.match(md, /SolidColorBrush/, `nested Converter resource hover should include type; buffer=${buffer}; got: ${md}`);
  });

  it("unbalanced nested resource braces do not crash completion", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <x:String x:Key="UnbalancedKey28">hello</x:String>',
      "</Page.Resources>",
      '<Border Tag="{Binding Source={StaticResource Unbalanced|Key28" />',
    ].join("\n  "));
    const items = await Promise.race([
      h.completionsAt(buffer),
      h.delay(5000).then(() => { throw new Error("completion did not settle for unbalanced nested resource"); }),
    ]);
    assert.ok(Array.isArray(items), `unbalanced nested resource completion should return an array; buffer=${buffer}`);
  });
});

describe("WinUI XAML red-team 28 — x:Bind function binding arguments", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("F12 on a multi-argument x:Bind function name lands on the method", async () => {
    const buffer = page('<TextBlock Text="{x:Bind OnGo_Cl|ick(GreetingText, Items[0])}" />');
    const defs = await h.definitionsAt(buffer);
    assert.ok(defs.length > 0, `function name should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), CS, `function name should land in ${CS}; buffer=${buffer}; got ${defs[0].fsPath}`);
    assert.strictEqual(defs[0].line, 26, `function name should land on OnGo_Click line; buffer=${buffer}; got ${defs[0].line}`);
  });

  it("F12 on the first function argument resolves that argument, not the function", async () => {
    const buffer = page('<TextBlock Text="{x:Bind OnGo_Click(Greeting|Text, Items[0])}" />');
    const defs = await h.definitionsAt(buffer);
    assert.ok(defs.length > 0, `first function argument should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), CS, `argument should land in ${CS}; buffer=${buffer}; got ${defs[0].fsPath}`);
    assert.notStrictEqual(defs[0].line, 26, `argument caret must not land on OnGo_Click; buffer=${buffer}; got ${defs[0].line}`);
  });

  it("hover on a dotted/indexed function argument resolves the terminal member", async () => {
    const buffer = page('<TextBlock Text="{x:Bind OnGo_Click(GreetingText, Items[0].Len|gth)}" />');
    const md = await h.hoverAt(buffer);
    assert.match(md, /Length/, `terminal argument hover should identify Length; buffer=${buffer}; got: ${md}`);
    assert.match(md, /int|Int32|System\.Int32/, `terminal argument hover should include integer type; buffer=${buffer}; got: ${md}`);
    assert.ok(!/IReadOnlyList/.test(md), `terminal argument hover should not describe Items collection; buffer=${buffer}; got: ${md}`);
  });

  it("F12 on a whitespace-padded later function argument still resolves independently", async () => {
    const buffer = page('<TextBlock Text="{x:Bind OnGo_Click( GreetingText , Item|s[0] )}" />');
    const defs = await h.definitionsAt(buffer);
    assert.ok(defs.length > 0, `later whitespace-padded argument should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), CS, `later argument should land in ${CS}; buffer=${buffer}; got ${defs[0].fsPath}`);
    assert.notStrictEqual(defs[0].line, 26, `later argument caret must not land on OnGo_Click; buffer=${buffer}; got ${defs[0].line}`);
  });

  it("bogus function argument member produces the same WXAML0005 as a bogus root x:Bind path", async () => {
    const buffer = page('<TextBlock Text="{x:Bind OnGo_Click(GreetingText, DefinitelyMissingArg28)}" />');
    const diags = await h.diagnosticsFor(buffer, (d) =>
      d.some((x) => x.code === "WXAML0005" && /DefinitelyMissingArg28/.test(x.message)), 12000);
    const hit = diags.find((x) => x.code === "WXAML0005" && /DefinitelyMissingArg28/.test(x.message));
    assert.ok(hit, `bogus function argument should be diagnosed as WXAML0005; buffer=${buffer}; got ${summary(diags)}`);
  });
});

describe("WinUI XAML red-team 28 — markup-extension argument mechanics", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("argument-name completion survives mixed positional, nested StaticResource, and trailing comma", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <SolidColorBrush x:Key="ArgBrush28" Color="Red" />',
      "</Page.Resources>",
      '<TextBlock Text="{x:Bind GreetingText, Converter={StaticResource ArgBrush28}, |}" />',
    ].join("\n  "));
    const items = await h.completionsAt(buffer);
    for (const want of ["Mode", "FallbackValue", "TargetNullValue"]) {
      assert.ok(items.includes(want), `x:Bind arg-name completion after nested resource should include ${want}; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
    }
  });

  it("Mode= completion still works after an empty positional argument", async () => {
    const buffer = page('<TextBlock Text="{x:Bind , Mode=Tw|}" />');
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("TwoWay"), `Mode=Tw should complete TwoWay after an empty positional arg; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("caret between x:Bind function arguments offers page members for the next argument", async () => {
    const buffer = page('<TextBlock Text="{x:Bind OnGo_Click(GreetingText, |)}" />');
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("GreetingText"), `function-argument gap should complete GreetingText; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
    assert.ok(items.includes("Items"), `function-argument gap should complete Items; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });
});
