"use strict";

// Round 52 red-team probes for page-level classic {Binding} rooting from d:DataContext.
// Positive probes use partial member names so VS Code word-based suggestions cannot fake success.

const assert = require("node:assert");
const h = require("./helper");

function page(inner) {
  return `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage">
  ${inner}
</Page>`;
}

function rootPage(attrs, inner) {
  return `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage"
    ${attrs}>
  ${inner}
</Page>`;
}

function summarize(items) {
  return items.slice(0, 120).join(", ");
}

function expectHas(items, label, message) {
  assert.ok(items.includes(label), `${message}; got ${summarize(items)}`);
}

function expectLacks(items, label, message) {
  assert.ok(!items.includes(label), `${message}; got ${summarize(items)}`);
}

async function labelsAt(buffer) {
  return h.completionsAt(buffer);
}

describe("WinUI XAML — red-team 52 (design-time {Binding} rooting)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("roots classic Binding at positional d:DesignInstance on an inner element", async () => {
    const items = await labelsAt(page([
      '<Grid d:DataContext="{d:DesignInstance local:SmokePage}">',
      '  <TextBlock Text="{Binding Gree|}" />',
      "</Grid>",
    ].join("\n  ")));
    expectHas(items, "GreetingText", "positional d:DesignInstance should root classic Binding at SmokePage");
  });

  it("supports Type= DesignInstance forms with trailing named arguments and whitespace", async () => {
    for (const [name, value] of [
      ["Type only", "{d:DesignInstance Type=local:SmokePage}"],
      ["Type with trailing named arg", "{d:DesignInstance Type=local:SmokePage, IsDesignTimeCreatable=True}"],
      ["whitespace", "{ d:DesignInstance   Type = local:SmokePage , IsDesignTimeCreatable = True }"],
    ]) {
      const items = await labelsAt(page(`<Grid d:DataContext="${value}">
    <TextBlock Text="{Binding Gree|}" />
  </Grid>`));
      expectHas(items, "GreetingText", `${name}: Type= form should root at SmokePage`);
    }
  });

  it("supports wrapped x:Type and prefers Type= over an earlier positional token", async () => {
    for (const [name, value] of [
      ["wrapped positional", "{d:DesignInstance {x:Type local:SmokePage}}"],
      ["wrapped Type=", "{d:DesignInstance Type={x:Type local:SmokePage}, IsDesignTimeCreatable=True}"],
      ["Type beats bad positional", "{d:DesignInstance local:DoesNotExist, Type=local:SmokePage}"],
    ]) {
      const items = await labelsAt(page(`<Grid d:DataContext="${value}">
    <TextBlock Text="{Binding Gree|}" />
  </Grid>`));
      expectHas(items, "GreetingText", `${name}: should resolve SmokePage`);
    }
  });

  it("lets a nearer DataTemplate x:DataType shadow an outer d:DataContext", async () => {
    const items = await labelsAt(page([
      '<Grid d:DataContext="{d:DesignInstance local:SmokePage}">',
      "  <ListView>",
      "    <ListView.ItemTemplate>",
      '      <DataTemplate x:DataType="x:String">',
      '        <TextBlock Text="{Binding Len|}" />',
      "      </DataTemplate>",
      "    </ListView.ItemTemplate>",
      "  </ListView>",
      "</Grid>",
    ].join("\n  ")));
    expectHas(items, "Length", "nearer x:String template should offer String.Length");
    expectLacks(items, "GreetingText", "nearer template must not leak outer SmokePage d:DataContext");
  });

  it("lets DataTemplate x:DataType win over d:DataContext on the same DataTemplate element", async () => {
    const items = await labelsAt(page([
      "<ListView>",
      "  <ListView.ItemTemplate>",
      '    <DataTemplate x:DataType="x:String" d:DataContext="{d:DesignInstance local:SmokePage}">',
      '      <TextBlock Text="{Binding Len|}" />',
      "    </DataTemplate>",
      "  </ListView.ItemTemplate>",
      "</ListView>",
    ].join("\n  ")));
    expectHas(items, "Length", "DataTemplate x:DataType should be terminal before same-element d:DataContext");
    expectLacks(items, "GreetingText", "same-element d:DataContext must not override DataTemplate x:DataType");
  });

  it("lets a nearer inner d:DataContext shadow a root Page d:DataContext", async () => {
    const items = await labelsAt(rootPage('d:DataContext="{d:DesignInstance x:String}"', [
      '<Grid d:DataContext="{d:DesignInstance local:SmokePage}">',
      '  <TextBlock Text="{Binding Gree|}" />',
      "</Grid>",
    ].join("\n  ")));
    expectHas(items, "GreetingText", "inner SmokePage d:DataContext should win over Page x:String");
    expectLacks(items, "Length", "inner d:DataContext should shadow the root Page d:DataContext");
  });

  it("inherits the nearest ancestor d:DataContext through deeply nested children", async () => {
    const items = await labelsAt(page([
      '<Grid d:DataContext="{d:DesignInstance local:SmokePage}">',
      "  <Border>",
      "    <StackPanel>",
      "      <Grid>",
      '        <TextBlock Text="{Binding It|}" />',
      "      </Grid>",
      "    </StackPanel>",
      "  </Border>",
      "</Grid>",
    ].join("\n  ")));
    expectHas(items, "Items", "deep child should inherit nearest ancestor design DataContext");
  });

  it("does not leak x:Class or outer scopes for unresolved and non-DesignInstance hints", async () => {
    for (const [name, value] of [
      ["unresolved type", "{d:DesignInstance local:DoesNotExist}"],
      ["empty Type", "{d:DesignInstance Type=}"],
      ["StaticResource", "{StaticResource Foo}"],
      ["Binding extension", "{Binding}"],
      ["plain string", "local:SmokePage"],
    ]) {
      const items = await labelsAt(page(`<Grid d:DataContext="${value}">
    <TextBlock Text="{Binding Gree|}" />
  </Grid>`));
      assert.ok(Array.isArray(items), `${name}: completion should return an array`);
      expectLacks(items, "GreetingText", `${name}: invalid hint must not fall back to x:Class`);
    }
  });

  it("stops at an invalid nearer d:DataContext instead of leaking an outer valid hint", async () => {
    const items = await labelsAt(rootPage('d:DataContext="{d:DesignInstance local:SmokePage}"', [
      '<Grid d:DataContext="{StaticResource Foo}">',
      '  <TextBlock Text="{Binding Gree|}" />',
      "</Grid>",
    ].join("\n  ")));
    expectLacks(items, "GreetingText", "invalid nearer hint must be terminal and suppress the outer Page hint");
  });

  it("does not let d:DataContext drive x:Bind completion", async () => {
    const buffer = page([
      '<Grid d:DataContext="{d:DesignInstance x:String}">',
      '  <TextBlock Text="{x:Bind Gree|}" />',
      "</Grid>",
    ].join("\n  "));
    const items = await labelsAt(buffer);
    expectHas(items, "GreetingText", "x:Bind should still root at the page x:Class");

    const stringItems = await labelsAt(page([
      '<Grid d:DataContext="{d:DesignInstance x:String}">',
      '  <TextBlock Text="{x:Bind Len|}" />',
      "</Grid>",
    ].join("\n  ")));
    expectLacks(stringItems, "Length", "x:Bind must not root at d:DataContext x:String");
  });

  it("still roots page-level x:Bind at x:Class without any d:DataContext", async () => {
    const items = await labelsAt(page('<TextBlock Text="{x:Bind Gree|}" />'));
    expectHas(items, "GreetingText", "page-level x:Bind should keep using x:Class");
  });

  it("offers no members for classic page-root Binding without d:DataContext", async () => {
    const items = await labelsAt(page('<TextBlock Text="{Binding Gree|}" />'));
    expectLacks(items, "GreetingText", "classic Binding without design DataContext must not leak x:Class");
  });

  it("declines DataContext members when a classic Binding has a named source redirector", async () => {
    for (const [name, binding] of [
      ["ElementName before Path", "{Binding ElementName=Foo, Path=Gree|}"],
      ["Source after Path", "{Binding Path=Gree|, Source={StaticResource Foo}}"],
      ["RelativeSource nested", "{Binding Path=Gree|, RelativeSource={RelativeSource Self}}"],
    ]) {
      const items = await labelsAt(page(`<Grid x:Name="Foo" d:DataContext="{d:DesignInstance local:SmokePage}">
    <TextBlock Text="${binding}" />
  </Grid>`));
      expectLacks(items, "GreetingText", `${name}: redirected Binding should not complete DataContext members`);
    }
  });

  it("does not mistake a bare positional path that names Source for the Source= redirector", async () => {
    const items = await labelsAt(page([
      '<Grid d:DataContext="{d:DesignInstance Image}">',
      '  <TextBlock Text="{Binding So|}" />',
      "</Grid>",
    ].join("\n  ")));
    expectHas(items, "Source", "bare positional Source path should complete Image.Source");
  });

  it("handles malformed d:DataContext values without throwing or leaking members", async () => {
    for (const [name, value] of [
      ["unterminated extension", "{d:DesignInstance"],
      ["empty positional", "{d:DesignInstance }"],
      ["empty Type", "{d:DesignInstance Type=}"],
      ["unterminated x:Type", "{d:DesignInstance {x:Type}"],
      ["empty attribute", ""],
      ["nested-brace garbage", "{d:DesignInstance Type={x:Type }}"],
      ["garbage before Type", "{d:DesignInstance {{garbage}}, Type=}"],
    ]) {
      const items = await labelsAt(page(`<Grid d:DataContext="${value}">
    <TextBlock Text="{Binding Gree|}" />
  </Grid>`));
      assert.ok(Array.isArray(items), `${name}: completion should return an array`);
      expectLacks(items, "GreetingText", `${name}: malformed hint must not leak SmokePage members`);
    }
  });

  it("uses d:DataContext on the same self-closing element as the binding target", async () => {
    const items = await labelsAt(page('<TextBlock d:DataContext="{d:DesignInstance local:SmokePage}" Text="{Binding Gree|}" />'));
    expectHas(items, "GreetingText", "self-closing element should be considered in the ancestor walk");
  });

  it("supports custom design namespace prefixes and the 2006 blend URI", async () => {
    const buffer = `<Page ${h.NS}
    xmlns:dt="http://schemas.microsoft.com/expression/blend/2006"
    x:Class="SmokeFixture.SmokePage">
  <Grid dt:DataContext="{dt:DesignInstance Type=local:SmokePage}">
    <TextBlock Text="{Binding Gree|}" />
  </Grid>
</Page>`;
    const items = await labelsAt(buffer);
    expectHas(items, "GreetingText", "custom prefix mapped to the 2006 blend URI should be recognized");
  });

  it("ignores d:DataContext attributes whose prefix is not mapped to a design namespace", async () => {
    const buffer = `<Page ${h.NS}
    xmlns:fake="using:SmokeFixture"
    x:Class="SmokeFixture.SmokePage">
  <Grid fake:DataContext="{d:DesignInstance local:SmokePage}">
    <TextBlock Text="{Binding Gree|}" />
  </Grid>
</Page>`;
    const items = await labelsAt(buffer);
    expectLacks(items, "GreetingText", "non-design DataContext prefix must not root classic Binding");
  });

  // Regression (round 52 red-team): the d:DataContext attribute prefix was resolved, but the
  // DesignInstance markup-extension prefix inside the value was matched by local name only, so an
  // undeclared {zzz:DesignInstance …} incorrectly rooted the Binding at SmokePage. Now the extension
  // prefix must also resolve to a design-time namespace.
  it("does not accept an undeclared prefix on the DesignInstance markup extension", async () => {
    const items = await labelsAt(page([
      '<Grid d:DataContext="{zzz:DesignInstance local:SmokePage}">',
      '  <TextBlock Text="{Binding Gree|}" />',
      "</Grid>",
    ].join("\n  ")));
    expectLacks(items, "GreetingText", "undeclared DesignInstance prefix should make the hint unusable");
  });

  it("rejects a DesignInstance extension whose prefix is declared but not design-time", async () => {
    for (const [name, ext] of [
      // x resolves to the XAML namespace (declared, not design-time) — {x:DesignInstance …} is not the hint.
      ["non-design declared prefix", "{x:DesignInstance local:SmokePage}"],
      // A bare, unprefixed extension resolves against the default (presentation) namespace, not design-time.
      ["bare unprefixed extension", "{DesignInstance local:SmokePage}"],
    ]) {
      const items = await labelsAt(page(`<Grid d:DataContext="${ext}">
    <TextBlock Text="{Binding Gree|}" />
  </Grid>`));
      expectLacks(items, "GreetingText", `${name}: only a design-time-prefixed DesignInstance should root the binding`);
    }
  });

  it("uses d:DataContext placed on the root Page element", async () => {
    const items = await labelsAt(rootPage('d:DataContext="{d:DesignInstance local:SmokePage}"', '<TextBlock Text="{Binding Gree|}" />'));
    expectHas(items, "GreetingText", "root Page d:DataContext should root a direct page-level Binding child");
  });

  it("returns deterministic results for the same d:DataContext probe", async () => {
    const probe = page([
      '<Grid d:DataContext="{d:DesignInstance local:SmokePage}">',
      '  <TextBlock Text="{Binding Gree|}" />',
      "</Grid>",
    ].join("\n  "));
    const first = (await labelsAt(probe)).slice().sort();
    const second = (await labelsAt(probe)).slice().sort();
    assert.deepStrictEqual(second, first, "same probe should produce the same label set");
  });
});
