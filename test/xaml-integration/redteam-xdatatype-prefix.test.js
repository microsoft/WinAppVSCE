"use strict";

// Prefix-sensitive completion rooted at DataTemplate x:DataType. Partial names distinguish server results from VS Code word suggestions.

const assert = require("node:assert");
const h = require("./helper");

function page(inner) {
  return `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage">
  ${inner}
</Page>`;
}

function pageWith(extraNs, inner) {
  return `<Page ${h.NS}
    ${extraNs}
    x:Class="SmokeFixture.SmokePage">
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

describe("WinUI XAML — red-team 53 (x:DataType prefix)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("roots x:Bind at SmokePage for literal x:DataType", async () => {
    const items = await labelsAt(page([
      "<ListView>",
      "  <ListView.ItemTemplate>",
      '    <DataTemplate x:DataType="local:SmokePage">',
      '      <TextBlock Text="{x:Bind Gree|}" />',
      "    </DataTemplate>",
      "  </ListView.ItemTemplate>",
      "</ListView>",
    ].join("\n  ")));
    expectHas(items, "GreetingText", "literal x:DataType should root x:Bind at SmokePage");
  });

  it("roots classic Binding at SmokePage for literal x:DataType", async () => {
    const items = await labelsAt(page([
      "<ListView>",
      "  <ListView.ItemTemplate>",
      '    <DataTemplate x:DataType="local:SmokePage">',
      '      <TextBlock Text="{Binding Gree|}" />',
      "    </DataTemplate>",
      "  </ListView.ItemTemplate>",
      "</ListView>",
    ].join("\n  ")));
    expectHas(items, "GreetingText", "literal x:DataType should root classic Binding at SmokePage");
  });

  it("roots x:Bind at System.String for literal x:DataType x:String", async () => {
    const items = await labelsAt(page([
      "<ListView>",
      "  <ListView.ItemTemplate>",
      '    <DataTemplate x:DataType="x:String">',
      '      <TextBlock Text="{x:Bind Len|}" />',
      "    </DataTemplate>",
      "  </ListView.ItemTemplate>",
      "</ListView>",
    ].join("\n  ")));
    expectHas(items, "Length", "x:DataType=x:String should offer String.Length");
  });

  it("does not recognize undeclared foreign-prefix DataType for x:Bind", async () => {
    const items = await labelsAt(page([
      "<ListView>",
      "  <ListView.ItemTemplate>",
      '    <DataTemplate zzz:DataType="local:SmokePage">',
      '      <TextBlock Text="{x:Bind Gree|}" />',
      "    </DataTemplate>",
      "  </ListView.ItemTemplate>",
      "</ListView>",
    ].join("\n  ")));
    expectLacks(items, "GreetingText", "undeclared zzz:DataType must not root x:Bind at SmokePage");
  });

  it("does not recognize undeclared foreign-prefix DataType for classic Binding", async () => {
    const items = await labelsAt(page([
      "<ListView>",
      "  <ListView.ItemTemplate>",
      '    <DataTemplate zzz:DataType="local:SmokePage">',
      '      <TextBlock Text="{Binding Gree|}" />',
      "    </DataTemplate>",
      "  </ListView.ItemTemplate>",
      "</ListView>",
    ].join("\n  ")));
    expectLacks(items, "GreetingText", "undeclared zzz:DataType must not root classic Binding at SmokePage");
  });

  it("does not recognize a non-x prefix even when it maps to the XAML namespace", async () => {
    const items = await labelsAt(pageWith('xmlns:xx="http://schemas.microsoft.com/winfx/2006/xaml"', [
      "<ListView>",
      "  <ListView.ItemTemplate>",
      '    <DataTemplate xx:DataType="local:SmokePage">',
      '      <TextBlock Text="{x:Bind Gree|}" />',
      "    </DataTemplate>",
      "  </ListView.ItemTemplate>",
      "</ListView>",
    ].join("\n  ")));
    expectLacks(items, "GreetingText", "xx:DataType mapped to XAML URI must not root completion");
  });

  it("does not recognize a non-x prefix mapped to the fixture namespace", async () => {
    const items = await labelsAt(pageWith('xmlns:foo="using:SmokeFixture"', [
      "<ListView>",
      "  <ListView.ItemTemplate>",
      '    <DataTemplate foo:DataType="local:SmokePage">',
      '      <TextBlock Text="{Binding Gree|}" />',
      "    </DataTemplate>",
      "  </ListView.ItemTemplate>",
      "</ListView>",
    ].join("\n  ")));
    expectLacks(items, "GreetingText", "foo:DataType mapped to SmokeFixture must not root completion");
  });

  it("treats a foreign-prefix DataTemplate as terminal over outer d:DataContext", async () => {
    const items = await labelsAt(page([
      '<Grid d:DataContext="{d:DesignInstance local:SmokePage}">',
      "  <ListView>",
      "    <ListView.ItemTemplate>",
      '      <DataTemplate zzz:DataType="x:String">',
      '        <TextBlock Text="{Binding Gree|}" />',
      "      </DataTemplate>",
      "    </ListView.ItemTemplate>",
      "  </ListView>",
      "</Grid>",
    ].join("\n  ")));
    expectLacks(items, "GreetingText", "foreign-prefix DataTemplate must not fall through to outer d:DataContext");
    expectLacks(items, "Length", "foreign-prefix DataType must not root at String either");
  });

  it("keeps page-level x:Bind rooted at x:Class outside templates", async () => {
    const items = await labelsAt(page('<TextBlock Text="{x:Bind Gree|}" />'));
    expectHas(items, "GreetingText", "page-level x:Bind should still root at x:Class");
  });

  it("lets a valid inner x:DataType shadow a valid outer x:DataType", async () => {
    const items = await labelsAt(page([
      "<ListView>",
      "  <ListView.ItemTemplate>",
      '    <DataTemplate x:DataType="local:SmokePage">',
      "      <ListView>",
      "        <ListView.ItemTemplate>",
      '          <DataTemplate x:DataType="x:String">',
      '            <TextBlock Text="{x:Bind Len|}" />',
      "          </DataTemplate>",
      "        </ListView.ItemTemplate>",
      "      </ListView>",
      "    </DataTemplate>",
      "  </ListView.ItemTemplate>",
      "</ListView>",
    ].join("\n  ")));
    expectHas(items, "Length", "inner x:String template should win");
    expectLacks(items, "GreetingText", "inner valid template must shadow outer SmokePage template");
  });

  it("does not leak an outer valid template into an inner foreign-prefix DataTemplate", async () => {
    const items = await labelsAt(page([
      "<ListView>",
      "  <ListView.ItemTemplate>",
      '    <DataTemplate x:DataType="local:SmokePage">',
      "      <ListView>",
      "        <ListView.ItemTemplate>",
      '          <DataTemplate zzz:DataType="x:String">',
      '            <TextBlock Text="{x:Bind Gree|}" />',
      "          </DataTemplate>",
      "        </ListView.ItemTemplate>",
      "      </ListView>",
      "    </DataTemplate>",
      "  </ListView.ItemTemplate>",
      "</ListView>",
    ].join("\n  ")));
    expectLacks(items, "GreetingText", "inner foreign-prefix DataTemplate must be terminal over outer SmokePage template");
    expectLacks(items, "Length", "inner foreign-prefix DataType must not root at String");
  });

  it("matches the x prefix case-sensitively", async () => {
    const items = await labelsAt(pageWith('xmlns:X="http://schemas.microsoft.com/winfx/2006/xaml"', [
      "<ListView>",
      "  <ListView.ItemTemplate>",
      '    <DataTemplate X:DataType="local:SmokePage">',
      '      <TextBlock Text="{x:Bind Gree|}" />',
      "    </DataTemplate>",
      "  </ListView.ItemTemplate>",
      "</ListView>",
    ].join("\n  ")));
    expectLacks(items, "GreetingText", "capital X:DataType must not be recognized as literal x:DataType");
  });

  it("matches the DataType local name case-sensitively", async () => {
    const items = await labelsAt(page([
      "<ListView>",
      "  <ListView.ItemTemplate>",
      '    <DataTemplate x:datatype="local:SmokePage">',
      '      <TextBlock Text="{Binding Gree|}" />',
      "    </DataTemplate>",
      "  </ListView.ItemTemplate>",
      "</ListView>",
    ].join("\n  ")));
    expectLacks(items, "GreetingText", "x:datatype must not be recognized as x:DataType");
  });

  it("roots with x:DataType among other attributes and x:Key", async () => {
    const items = await labelsAt(page([
      "<Page.Resources>",
      '  <DataTemplate x:Key="Round53Template" x:DataType="local:SmokePage">',
      '    <TextBlock Text="{Binding It|}" />',
      "  </DataTemplate>",
      "</Page.Resources>",
    ].join("\n  ")));
    expectHas(items, "Items", "x:Key plus x:DataType should still root classic Binding");
  });

  it("offers no members for an empty x:DataType", async () => {
    const items = await labelsAt(page([
      "<ListView>",
      "  <ListView.ItemTemplate>",
      '    <DataTemplate x:DataType="">',
      '      <TextBlock Text="{x:Bind Gree|}" />',
      "    </DataTemplate>",
      "  </ListView.ItemTemplate>",
      "</ListView>",
    ].join("\n  ")));
    expectLacks(items, "GreetingText", "empty x:DataType must not fall back to x:Class");
  });

  it("offers no members for a DataTemplate with no DataType", async () => {
    const items = await labelsAt(page([
      "<ListView>",
      "  <ListView.ItemTemplate>",
      "    <DataTemplate>",
      '      <TextBlock Text="{Binding Gree|}" />',
      "    </DataTemplate>",
      "  </ListView.ItemTemplate>",
      "</ListView>",
    ].join("\n  ")));
    expectLacks(items, "GreetingText", "DataTemplate with no x:DataType must not offer SmokePage members");
  });

  it("returns an array for malformed unterminated template input", async () => {
    const items = await labelsAt(page([
      "<ListView>",
      "  <ListView.ItemTemplate>",
      '    <DataTemplate x:DataType="local:SmokePage">',
      '      <TextBlock Text="{x:Bind Gree|}"',
    ].join("\n  ")));
    assert.ok(Array.isArray(items), "malformed template completion should return an array");
  });

  it("returns deterministic results for the same foreign-prefix probe", async () => {
    const probe = page([
      "<ListView>",
      "  <ListView.ItemTemplate>",
      '    <DataTemplate zzz:DataType="local:SmokePage">',
      '      <TextBlock Text="{Binding Gree|}" />',
      "    </DataTemplate>",
      "  </ListView.ItemTemplate>",
      "</ListView>",
    ].join("\n  "));
    const first = (await labelsAt(probe)).slice().sort();
    const second = (await labelsAt(probe)).slice().sort();
    assert.deepStrictEqual(second, first, "same foreign-prefix probe should produce the same label set");
  });
});
