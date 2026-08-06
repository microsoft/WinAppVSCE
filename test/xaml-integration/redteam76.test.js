"use strict";

// Round 76 adversarial probes for classic {Binding ElementName=..., Path=...}
// member-path completion. Keep asserted member names out of probe buffers unless
// the assertion is intentionally about that word, because VS Code merges word
// suggestions with the language server's completion list.

const assert = require("node:assert");
const h = require("./helper");

function page(inner, attrs = "") {
  return `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage"${attrs ? "\n    " + attrs : ""}>
  ${inner}
</Page>`;
}

const smokeTemplate = (inner) =>
  page([
    "<ListView>",
    "  <ListView.ItemTemplate>",
    '    <DataTemplate x:DataType="local:SmokePage">',
    `      ${inner}`,
    "    </DataTemplate>",
    "  </ListView.ItemTemplate>",
    "</ListView>",
  ].join("\n  "));

const imageTemplate = (inner) =>
  page([
    "<ListView>",
    "  <ListView.ItemTemplate>",
    '    <DataTemplate x:DataType="Image">',
    `      ${inner}`,
    "    </DataTemplate>",
    "  </ListView.ItemTemplate>",
    "</ListView>",
  ].join("\n  "));

function labels(items) {
  return items.map((i) => i.label || i).slice(0, 160).join(", ");
}

function expectHas(items, label, note) {
  assert.ok(items.includes(label), `${note}: expected ${label}; got ${labels(items)}`);
}

function expectLacks(items, label, note) {
  assert.ok(!items.includes(label), `${note}: must NOT offer ${label}; got ${labels(items)}`);
}

async function completions(buffer) {
  return h.completionsAt(buffer);
}

async function expectTextBoxRoot(buffer, note) {
  const items = await completions(buffer);
  expectHas(items, "IsEnabled", `${note}: TextBox/framework member proves server path completion`);
  expectLacks(items, "GreetingText", `${note}: must not leak SmokePage/DataContext members`);
  return items;
}

async function expectDeclined(buffer, note) {
  const items = await completions(buffer);
  expectLacks(items, "IsEnabled", `${note}: redirect/unknown source should not offer named-element members`);
  expectLacks(items, "GreetingText", `${note}: redirect/unknown source should not offer DataContext members`);
  return items;
}

describe("WinUI XAML red-team 76 — ElementName Binding member paths", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("red-team 76 roots empty Path at the named TextBox at page scope", async () => {
    await expectTextBoxRoot(page([
      "<StackPanel>",
      '  <TextBox x:Name="BoxA" />',
      '  <TextBlock Text="{Binding ElementName=BoxA, Path=|}" />',
      "</StackPanel>",
    ].join("\n  ")), "empty Path with ElementName before Path");
  });

  it("red-team 76 roots filtered Path at the named TextBox", async () => {
    const items = await completions(page([
      "<StackPanel>",
      '  <TextBox x:Name="BoxB" />',
      '  <TextBlock Text="{Binding ElementName=BoxB, Path=IsE|}" />',
      "</StackPanel>",
    ].join("\n  ")));
    expectHas(items, "IsEnabled", "filtered ElementName path should complete TextBox.IsEnabled");
    expectLacks(items, "GreetingText", "filtered ElementName path must not leak SmokePage");
  });

  it("red-team 76 is order-independent when ElementName appears after Path", async () => {
    await expectTextBoxRoot(page([
      "<StackPanel>",
      '  <TextBox x:Name="BoxC" />',
      '  <TextBlock Text="{Binding Path=|, ElementName=BoxC}" />',
      "</StackPanel>",
    ].join("\n  ")), "Path before ElementName");
  });

  it("red-team 76 walks dotted paths from the named element into member types", async () => {
    const items = await completions(page([
      "<StackPanel>",
      '  <TextBox x:Name="BoxD" />',
      '  <TextBlock Text="{Binding ElementName=BoxD, Path=Text.Len|}" />',
      "</StackPanel>",
    ].join("\n  ")));
    expectHas(items, "Length", "TextBox.Text.Len should complete System.String.Length");
    expectLacks(items, "IsEnabled", "second segment should not jump back to the TextBox root");
    expectLacks(items, "GreetingText", "second segment must not leak SmokePage");
  });

  it("red-team 76 returns nothing useful for an unknown ElementName", async () => {
    await expectDeclined(page('<TextBlock Text="{Binding ElementName=MissingBox, Path=|}" />'), "unknown ElementName");
  });

  it("red-team 76 lets Source win over ElementName in both argument orders", async () => {
    for (const [name, binding] of [
      ["ElementName then Source", "{Binding ElementName=BoxE, Source={StaticResource Anything}, Path=|}"],
      ["Source then ElementName", "{Binding Source={StaticResource Anything}, ElementName=BoxE, Path=|}"],
      ["Path before Source", "{Binding Path=|, ElementName=BoxE, Source={StaticResource Anything}}"],
    ]) {
      await expectDeclined(page([
        "<StackPanel>",
        '  <TextBox x:Name="BoxE" />',
        `  <TextBlock Text="${binding}" />`,
        "</StackPanel>",
      ].join("\n  ")), name);
    }
  });

  it("red-team 76 lets RelativeSource win over ElementName in both argument orders", async () => {
    for (const [name, binding] of [
      ["ElementName then RelativeSource", "{Binding ElementName=BoxF, RelativeSource={RelativeSource Self}, Path=|}"],
      ["RelativeSource then ElementName", "{Binding RelativeSource={RelativeSource Self}, ElementName=BoxF, Path=|}"],
    ]) {
      await expectDeclined(page([
        "<StackPanel>",
        '  <TextBox x:Name="BoxF" />',
        `  <TextBlock Text="${binding}" />`,
        "</StackPanel>",
      ].join("\n  ")), name);
    }
  });

  it("red-team 76 keeps Source and RelativeSource alone as completion-declining redirectors", async () => {
    for (const [name, binding] of [
      ["Source only", "{Binding Source={StaticResource Anything}, Path=|}"],
      ["RelativeSource only", "{Binding RelativeSource={RelativeSource Self}, Path=|}"],
    ]) {
      await expectDeclined(smokeTemplate(`<TextBlock Text="${binding}" />`), name);
    }
  });

  it("red-team 76 treats bare positional Source as a path, not Source=", async () => {
    const items = await completions(imageTemplate('<TextBlock Text="{Binding Source|}" />'));
    expectHas(items, "Source", "bare positional Source should complete Image.Source");
  });

  it("red-team 76 still completes named elements inside the ElementName value itself", async () => {
    const items = await completions(page([
      "<StackPanel>",
      '  <TextBox x:Name="BoxG" />',
      '  <TextBlock Text="{Binding ElementName=Bo|, Path=Text}" />',
      "</StackPanel>",
    ].join("\n  ")));
    expectHas(items, "BoxG", "ElementName value completion should still offer x:Name values");
    expectLacks(items, "IsEnabled", "ElementName value completion must not switch to member completion");
  });

  it("red-team 76 ElementName wins over DataTemplate x:DataType", async () => {
    await expectTextBoxRoot(smokeTemplate([
      "<StackPanel>",
      '  <TextBox x:Name="BoxH" />',
      '  <TextBlock Text="{Binding ElementName=BoxH, Path=|}" />',
      "</StackPanel>",
    ].join("\n        ")), "ElementName inside SmokePage DataTemplate");
  });

  it("red-team 76 ElementName wins over page-level d:DataContext", async () => {
    await expectTextBoxRoot(page([
      '<Grid d:DataContext="{d:DesignInstance local:SmokePage}">',
      '  <TextBox x:Name="BoxI" />',
      '  <TextBlock Text="{Binding ElementName=BoxI, Path=|}" />',
      "</Grid>",
    ].join("\n  ")), "ElementName inside d:DataContext");
  });

  it("red-team 76 tolerates whitespace around named arguments", async () => {
    const items = await completions(page([
      "<StackPanel>",
      '  <TextBox x:Name="BoxJ" />',
      '  <TextBlock Text="{Binding ElementName = BoxJ , Path = IsE|}" />',
      "</StackPanel>",
    ].join("\n  ")));
    expectHas(items, "IsEnabled", "whitespace-separated ElementName/Path should still root at TextBox");
    expectLacks(items, "GreetingText", "whitespace-separated ElementName/Path must not leak SmokePage");
  });

  it("red-team 76 does not treat lowercase elementname as ElementName", async () => {
    const items = await completions(smokeTemplate([
      "<StackPanel>",
      '  <TextBox x:Name="BoxK" />',
      '  <TextBlock Text="{Binding elementname=BoxK, Path=|}" />',
      "</StackPanel>",
    ].join("\n        ")));
    expectHas(items, "GreetingText", "lowercase elementname should be an unknown named arg, leaving Path rooted at x:DataType");
    expectLacks(items, "PlaceholderText", "lowercase elementname must not root at the named TextBox");
  });

  it("red-team 76 duplicate x:Name does not crash and roots at a framework element", async () => {
    const items = await completions(page([
      "<StackPanel>",
      '  <TextBox x:Name="Dup76" />',
      '  <Button x:Name="Dup76" />',
      '  <TextBlock Text="{Binding ElementName=Dup76, Path=|}" />',
      "</StackPanel>",
    ].join("\n  ")));
    expectHas(items, "IsEnabled", "duplicate x:Name should still resolve to a plausible FrameworkElement member");
  });

  it("red-team 76 can root at a named user type", async () => {
    const items = await completions(page([
      "<StackPanel>",
      '  <local:SmokePage x:Name="NestedPage76" />',
      '  <TextBlock Text="{Binding ElementName=NestedPage76, Path=Gree|}" />',
      "</StackPanel>",
    ].join("\n  ")));
    expectHas(items, "GreetingText", "ElementName targeting a named local:SmokePage should expose SmokePage members");
  });

  it("red-team 76 malformed and unterminated ElementName bindings are crash-safe", async () => {
    for (const [name, buffer] of [
      ["unterminated empty Path", page('<StackPanel><TextBox x:Name="BoxL" /><TextBlock Text="{Binding ElementName=BoxL, Path=|" /></StackPanel>')],
      ["empty ElementName value", page('<TextBlock Text="{Binding ElementName=|" />')],
      ["trailing comma", page('<StackPanel><TextBox x:Name="BoxL" /><TextBlock Text="{Binding ElementName=BoxL, |" /></StackPanel>')],
      ["unterminated filtered Path", page('<StackPanel><TextBox x:Name="BoxL" /><TextBlock Text="{Binding ElementName=BoxL, Path=IsE|" /></StackPanel>')],
    ]) {
      const items = await completions(buffer);
      assert.ok(Array.isArray(items), `${name}: completion should return an array`);
    }
  });

  it("red-team 76 is crash-safe for an ElementName Binding nested in another Binding argument", async () => {
    const items = await completions(page([
      "<StackPanel>",
      '  <TextBox x:Name="BoxM" />',
      '  <TextBlock Tag="{Binding ConverterParameter={Binding ElementName=BoxM, Path=|}}" />',
      "</StackPanel>",
    ].join("\n  ")));
    assert.ok(Array.isArray(items), "nested Binding completion should return an array");
  });

  it("red-team 76 does not perturb page-root x:Bind member completion", async () => {
    const items = await completions(page('<TextBlock Text="{x:Bind Gree|}" />'));
    expectHas(items, "GreetingText", "x:Bind should still root at x:Class");
  });

  it("red-team 76 x:Bind with ElementName-looking text is crash-safe but not an ElementName redirect", async () => {
    const items = await completions(page([
      "<StackPanel>",
      '  <TextBox x:Name="BoxN" />',
      '  <TextBlock Text="{x:Bind ElementName=BoxN, |}" />',
      "</StackPanel>",
    ].join("\n  ")));
    assert.ok(Array.isArray(items), "x:Bind ElementName-looking input should return an array");
    expectLacks(items, "IsEnabled", "x:Bind must not use ElementName= as a source redirector");
  });

  it("red-team 76 is deterministic for identical ElementName path requests", async () => {
    const probe = page([
      "<StackPanel>",
      '  <TextBox x:Name="BoxO" />',
      '  <TextBlock Text="{Binding ElementName=BoxO, Path=|}" />',
      "</StackPanel>",
    ].join("\n  "));
    const first = (await completions(probe)).slice().sort();
    const second = (await completions(probe)).slice().sort();
    assert.deepStrictEqual(second, first, `ElementName path completion should be deterministic; first=${labels(first)} second=${labels(second)}`);
  });

  it("red-team 76 Mode and ConverterParameter do not block ElementName rooting", async () => {
    await expectTextBoxRoot(page([
      "<StackPanel>",
      '  <TextBox x:Name="BoxP" />',
      '  <TextBlock Text="{Binding ElementName=BoxP, Mode=OneWay, ConverterParameter=ignored, Path=|}" />',
      "</StackPanel>",
    ].join("\n  ")), "ElementName with non-source Binding arguments");
  });
});
