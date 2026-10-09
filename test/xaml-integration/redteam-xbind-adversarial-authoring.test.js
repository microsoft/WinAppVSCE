"use strict";

// x:Bind completion, navigation, diagnostics, and templated outlines.

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

describe("WinUI XAML red-team 7 — x:Bind adversarial authoring", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("F12 on function-style x:Bind event handler resolves the method before parentheses", async () => {
    const buffer = page('<Button Click="{x:Bind OnGo_Cl|ick()}" />');
    const defs = await h.definitionsAt(buffer);
    assert.ok(defs.length > 0, `function x:Bind event handler should resolve OnGo_Click before (); buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), CS, `expected ${CS} for function x:Bind; buffer=${buffer}; got ${defs[0].fsPath}`);
    assert.strictEqual(defs[0].line, 26, `expected OnGo_Click at 0-based line 26; buffer=${buffer}; got ${defs[0].line}`);
  });

  it("keeps x:Bind root completion focused on source members, not generated/framework noise", async () => {
    const buffer = page('<TextBlock Text="{x:Bind |}" />');
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("GreetingText"), `x:Bind root completion should include GreetingText; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
    assert.ok(items.includes("Items"), `x:Bind root completion should include Items; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
    assert.ok(!items.includes("InitializeComponent"), `x:Bind root completion should not leak generated InitializeComponent; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
    assert.ok(!items.includes("FindName"), `x:Bind root completion should not flood framework Page members like FindName; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("completes StaticResource keys inside x:Bind TargetNullValue nested markup", async () => {
    const buffer = page('<TextBlock Text="{x:Bind GreetingText, TargetNullValue={StaticResource |}}" />');
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("SmokeAccentBrush"), `nested TargetNullValue StaticResource should complete app keys; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("completes ThemeResource keys inside x:Bind Converter nested markup", async () => {
    const buffer = page('<TextBlock Text="{x:Bind GreetingText, Converter={ThemeResource |}}" />');
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("SmokeAccentBrush"), `nested x:Bind Converter ThemeResource should complete app keys; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });
});

describe("WinUI XAML red-team 7 — diagnostics false positives and misses", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("reports a diagnostic for an x:Bind path that does not exist on the x:Class type", async () => {
    const buffer = page('<TextBlock Text="{x:Bind DefinitelyMissingMember}" />');
    const diags = await h.diagnosticsFor(
      buffer,
      (d) => d.some((x) => /DefinitelyMissingMember|x:Bind|member/i.test(`${x.code}:${x.message}`)),
      12000
    );
    const hit = diags.find((x) => /DefinitelyMissingMember|x:Bind|member/i.test(`${x.code}:${x.message}`));
    assert.ok(hit, `invalid x:Bind path should be diagnosed; buffer=${buffer}; got ${diagSummary(diags)}`);
  });

  it("does not report diagnostics for valid x: directives x:Key, x:Load, and x:DefaultBindMode", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <SolidColorBrush x:Key="ProbeBrush" Color="Red" />',
      "</Page.Resources>",
      '<Grid x:Load="True" x:DefaultBindMode="OneWay">',
      '  <TextBlock Text="{x:Bind GreetingText}" />',
      "</Grid>",
    ].join("\n  "));
    const diags = await h.diagnosticsFor(buffer, (d) => d.length === 0, 10000);
    assert.deepStrictEqual(diags.map((d) => `${d.code}:${d.message}`), [], `valid x: directives should stay silent; buffer=${buffer}; got ${diagSummary(diags)}`);
  });

  it("does not report diagnostics for multi-line valid x:Bind with Mode and FallbackValue", async () => {
    const buffer = page('<TextBlock Text="{x:Bind\n    GreetingText,\n    Mode=OneWay,\n    FallbackValue=Hello}" />');
    const diags = await h.diagnosticsFor(buffer, (d) => d.length === 0, 10000);
    assert.deepStrictEqual(diags.map((d) => `${d.code}:${d.message}`), [], `valid multi-line x:Bind should stay silent; buffer=${buffer}; got ${diagSummary(diags)}`);
  });

  it("flags an unknown attribute on a resolved local user type", async () => {
    const buffer = page('<local:SmokePage NotARealLocalAttribute="1" />');
    const diags = await h.diagnosticsFor(
      buffer,
      (d) => d.some((x) => x.code === "WXAML0003" || /NotARealLocalAttribute/.test(x.message)),
      12000
    );
    const hit = diags.find((x) => x.code === "WXAML0003" || /NotARealLocalAttribute/.test(x.message));
    assert.ok(hit, `unknown attribute on local:SmokePage should be diagnosed; buffer=${buffer}; got ${diagSummary(diags)}`);
  });
});

describe("WinUI XAML red-team 7 — real-world completions and navigation", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("completes bool values at an unquoted attribute equals position", async () => {
    const buffer = page("<Button IsEnabled=| />");
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("True"), `unquoted bool value after equals should complete True; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
    assert.ok(items.includes("False"), `unquoted bool value after equals should complete False; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("completes MenuFlyoutItem authoring attributes inside MenuFlyout.Items", async () => {
    const buffer = page([
      "<Button>",
      "  <Button.Flyout>",
      "    <MenuFlyout>",
      "      <MenuFlyout.Items>",
      "        <MenuFlyoutItem | />",
      "      </MenuFlyout.Items>",
      "    </MenuFlyout>",
      "  </Button.Flyout>",
      "</Button>",
    ].join("\n  "));
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("Text"), `MenuFlyoutItem should complete Text; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
    assert.ok(items.includes("Click"), `MenuFlyoutItem should complete Click event; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("completes KeyboardAccelerator Key and Modifiers attributes", async () => {
    const buffer = page([
      "<Button>",
      "  <Button.KeyboardAccelerators>",
      "    <KeyboardAccelerator | />",
      "  </Button.KeyboardAccelerators>",
      "</Button>",
    ].join("\n  "));
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("Key"), `KeyboardAccelerator should complete Key; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
    assert.ok(items.includes("Modifiers"), `KeyboardAccelerator should complete Modifiers; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("F12 on ControlTemplate TargetType user type resolves to the code-behind type", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <ControlTemplate TargetType="local:Smoke|Page">',
      "    <Grid />",
      "  </ControlTemplate>",
      "</Page.Resources>",
    ].join("\n  "));
    const defs = await h.definitionsAt(buffer);
    assert.ok(defs.length > 0, `ControlTemplate TargetType local user type should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), CS, `expected ${CS}; buffer=${buffer}; got ${defs[0].fsPath}`);
  });
});

describe("WinUI XAML red-team 7 — outline and hostile positions", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("document symbols include named ItemsPanelTemplate descendants", async () => {
    const buffer = page([
      "<ItemsRepeater>",
      "  <ItemsRepeater.ItemsPanel>",
      "    <ItemsPanelTemplate>",
      '      <StackPanel x:Name="ItemsHost" Orientation="Vertical" />',
      "    </ItemsPanelTemplate>",
      "  </ItemsRepeater.ItemsPanel>",
      "</ItemsRepeater>",
    ].join("\n  "));
    const syms = await h.symbolsAt(buffer);
    const names = h.flattenSymbols(syms);
    assert.ok(names.some((n) => /ItemsPanelTemplate/.test(n)), `outline should include ItemsPanelTemplate; buffer=${buffer}; got ${names.join(", ")}`);
    assert.ok(names.some((n) => /StackPanel/.test(n) && /ItemsHost/.test(n)), `outline should include named ItemsPanelTemplate child; buffer=${buffer}; got ${names.join(", ")}`);
  });

  it("completion settles after a very large attribute value without treating it as markup", async () => {
    const huge = "x".repeat(6000);
    const buffer = page(`<TextBlock Text="${huge}" | />`);
    const items = await settles(h.completionsAt(buffer), "completion after huge Text attribute");
    assert.ok(items.includes("Foreground"), `attribute completion after huge attribute should remain useful; buffer=intent huge Text then attr caret; got ${items.slice(0, 120).join(", ")}`);
  });
});

describe("WinUI XAML red-team 7 — documented or acceptable gaps", function () {
  it.skip("GAP: hover on markup-extension names should eventually document x:Bind/StaticResource semantics", async () => {});
  it.skip("GAP: hover on enum values should eventually describe enum members", async () => {});
});
