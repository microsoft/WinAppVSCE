"use strict";

// Round 51 red-team probes for classic {Binding} member-path completion.
// These tests intentionally avoid placing full asserted member names in probe buffers unless the
// assertion is about a different member, so VS Code word-based suggestions do not mask LSP behavior.

const assert = require("node:assert");
const h = require("./helper");

function page(inner) {
  return `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage">
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

const stringTemplate = (inner) =>
  page([
    "<ListView>",
    "  <ListView.ItemTemplate>",
    '    <DataTemplate x:DataType="x:String">',
    `      ${inner}`,
    "    </DataTemplate>",
    "  </ListView.ItemTemplate>",
    "</ListView>",
  ].join("\n  "));

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

describe("WinUI XAML — red-team 51 (classic {Binding} member paths)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("roots positional classic Binding paths at DataTemplate x:DataType", async () => {
    const items = await labelsAt(smokeTemplate('<TextBlock Text="{Binding Gree|}" />'));
    expectHas(items, "GreetingText", "classic Binding inside typed DataTemplate should complete SmokePage.GreetingText");
  });

  it("roots Path= classic Binding paths at DataTemplate x:DataType", async () => {
    const items = await labelsAt(smokeTemplate('<TextBlock Text="{Binding Path=Gree|}" />'));
    expectHas(items, "GreetingText", "Path= should complete the same DataTemplate root as a positional path");
  });

  it("completes dotted member segments inside a typed template", async () => {
    const items = await labelsAt(smokeTemplate('<TextBlock Text="{Binding Items.C|}" />'));
    expectHas(items, "Count", "Items.C should complete IReadOnlyCollection/List Count");
    expectLacks(items, "GreetingText", "second segment should not jump back to the SmokePage root");
  });

  it("does not leak page x:Class members for page-root classic Binding", async () => {
    const items = await labelsAt(page('<TextBlock Text="{Binding Gree|}" />'));
    expectLacks(items, "GreetingText", "page-root classic Binding has unknown DataContext and must not offer x:Class members");
  });

  it("still roots page-root x:Bind at x:Class", async () => {
    const items = await labelsAt(page('<TextBlock Text="{x:Bind Gree|}" />'));
    expectHas(items, "GreetingText", "x:Bind page-root completion must keep using x:Class");
  });

  it("uses x:String template members only, with no SmokePage leakage", async () => {
    const items = await labelsAt(stringTemplate('<TextBlock Text="{Binding Len|}" />'));
    expectHas(items, "Length", "x:String DataTemplate should complete System.String.Length");
    expectLacks(items, "GreetingText", "x:String DataTemplate must not leak SmokePage members");
  });

  it("returns no typed members for an unresolvable template x:DataType", async () => {
    const items = await labelsAt(page([
      "<ListView>",
      "  <ListView.ItemTemplate>",
      '    <DataTemplate x:DataType="local:DoesNotExist">',
      '      <TextBlock Text="{Binding Gree|}" />',
      "    </DataTemplate>",
      "  </ListView.ItemTemplate>",
      "</ListView>",
    ].join("\n  ")));
    expectLacks(items, "GreetingText", "unresolvable x:DataType should not fall back to the page x:Class");
  });

  it("inner DataTemplate x:DataType shadows an outer template for classic Binding", async () => {
    const buffer = page([
      "<ListView>",
      "  <ListView.ItemTemplate>",
      '    <DataTemplate x:DataType="local:SmokePage">',
      "      <StackPanel>",
      '        <DataTemplate x:DataType="x:String">',
      '          <TextBlock Text="{Binding Len|}" />',
      "        </DataTemplate>",
      "      </StackPanel>",
      "    </DataTemplate>",
      "  </ListView.ItemTemplate>",
      "</ListView>",
    ].join("\n  "));
    const items = await labelsAt(buffer);
    expectHas(items, "Length", "inner x:String DataTemplate should win");
    expectLacks(items, "GreetingText", "inner template must not leak the outer SmokePage root");
  });

  it("roots the path at the named element when ElementName redirects before Path (round 76)", async () => {
    // Round 76: ElementName= roots the path at the named element's TYPE, so it completes that element's
    // members and does NOT leak the x:DataType's members. IsEnabled is a TextBox member the server returns
    // (never a literal buffer word); GreetingText (a SmokePage member) must be absent.
    const inner = [
      "<StackPanel>",
      '        <TextBox x:Name="Root" />',
      '        <TextBlock Text="{Binding ElementName=Root, Path=|}" />',
      "      </StackPanel>",
    ].join("\n");
    const items = await labelsAt(smokeTemplate(inner));
    expectHas(items, "IsEnabled", "ElementName= must root the path at the named TextBox and complete its members");
    expectLacks(items, "GreetingText", "ElementName= must not leak the DataTemplate x:DataType members");
  });

  it("declines completion when Source redirects the binding source after Path", async () => {
    const items = await labelsAt(smokeTemplate('<TextBlock Text="{Binding Path=Gree|, Source={StaticResource SomeKey}}" />'));
    expectLacks(items, "GreetingText", "Source= after the caret argument must still suppress DataContext member completion");
  });

  it("declines completion when RelativeSource redirects through nested markup", async () => {
    const items = await labelsAt(smokeTemplate('<TextBlock Text="{Binding Path=Gree|, RelativeSource={RelativeSource TemplatedParent}}" />'));
    expectLacks(items, "GreetingText", "RelativeSource with nested markup must suppress DataContext member completion");
  });

  it("declines completion for Source redirector before a positional path", async () => {
    const items = await labelsAt(smokeTemplate('<TextBlock Text="{Binding Source={StaticResource SomeKey}, Gree|}" />'));
    expectLacks(items, "GreetingText", "Source= before a positional path must suppress DataContext member completion");
  });

  it("does not mistake ordinary Path= values for source redirectors", async () => {
    const items = await labelsAt(smokeTemplate('<TextBlock Text="{Binding Path=It|}" />'));
    expectHas(items, "Items", "baseline path-value completion should still work when the argument name is Path");
    expectLacks(items, "GreetingText", "It prefix should not be satisfied by unrelated SmokePage members");
  });

  it("does not mistake a member named Source in Path= for a Source= redirector", async () => {
    const buffer = page([
      "<ListView>",
      "  <ListView.ItemTemplate>",
      '    <DataTemplate x:DataType="Image">',
      '      <TextBlock Text="{Binding Path=So|}" />',
      "    </DataTemplate>",
      "  </ListView.ItemTemplate>",
      "</ListView>",
    ].join("\n  "));
    const items = await labelsAt(buffer);
    expectHas(items, "Source", "Image.Source is a path member value and must not be treated as the Source= argument");
  });

  it("does not mistake a BARE POSITIONAL path equal to a redirector keyword for an argument", async () => {
    // A redirector is only ever a named "Source="/"ElementName=" argument; a bare positional first
    // argument is always the Path. So {Binding Source|} inside an Image template must still complete
    // Image.Source, and must not be declined as though "Source" were the Source= redirector argument.
    const buffer = page([
      "<ListView>",
      "  <ListView.ItemTemplate>",
      '    <DataTemplate x:DataType="Image">',
      '      <TextBlock Text="{Binding Source|}" />',
      "    </DataTemplate>",
      "  </ListView.ItemTemplate>",
      "</ListView>",
    ].join("\n  "));
    const items = await labelsAt(buffer);
    expectHas(items, "Source", "bare positional {Binding Source} must complete Image.Source, not be treated as the Source= redirector");
  });

  it("handles unterminated and malformed classic Binding inputs without throwing or leaking page members", async () => {
    for (const [name, buffer] of [
      ["unterminated name", page('<TextBlock Text="{Binding|" />')],
      ["unterminated page-root Path", page('<TextBlock Text="{Binding Path=|" />')],
      ["open paren", smokeTemplate('<TextBlock Text="{Binding (|" />')],
      ["closed empty binding", page('<TextBlock Text="{Binding }|" />')],
      ["empty attribute", page('<TextBlock Text="|" />')],
    ]) {
      const items = await labelsAt(buffer);
      assert.ok(Array.isArray(items), `${name}: completion should return an array`);
      expectLacks(items, "GreetingText", `${name}: malformed/page-root input should not leak page x:Class members`);
    }
  });

  it("allows an empty Path= inside a typed template to complete the template root", async () => {
    const items = await labelsAt(smokeTemplate('<TextBlock Text="{Binding Path=|" />'));
    expectHas(items, "GreetingText", "unterminated empty Path= in a typed template should be safe and use the template root");
  });

  it("does not offer DataContext members in a non-Path named argument", async () => {
    const items = await labelsAt(smokeTemplate('<TextBlock Text="{Binding Mode=Gree|}" />'));
    expectLacks(items, "GreetingText", "Mode= value must not be treated as a Binding path");
  });

  it("returns deterministic results for the same classic Binding probe", async () => {
    const probe = smokeTemplate('<TextBlock Text="{Binding Gree|}" />');
    const first = (await labelsAt(probe)).slice().sort();
    const second = (await labelsAt(probe)).slice().sort();
    assert.deepStrictEqual(second, first, "same probe should produce the same label set");
  });
});
