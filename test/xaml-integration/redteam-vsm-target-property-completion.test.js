"use strict";

const assert = require("node:assert");
const h = require("./helper");

function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
}

function vsm(inner, states) {
  return page([
    "<Grid>",
    inner,
    "  <VisualStateManager.VisualStateGroups>",
    "    <VisualStateGroup>",
    '      <VisualState x:Name="Wide32">',
    "        <VisualState.Setters>",
    states,
    "        </VisualState.Setters>",
    "      </VisualState>",
    "    </VisualStateGroup>",
    "  </VisualStateManager.VisualStateGroups>",
    "</Grid>",
  ].join("\n  "));
}

function storyboard(inner, animation) {
  return page([
    "<Grid>",
    inner,
    "  <VisualStateManager.VisualStateGroups>",
    "    <VisualStateGroup><VisualState><Storyboard>",
    `      ${animation}`,
    "    </Storyboard></VisualState></VisualStateGroup>",
    "  </VisualStateManager.VisualStateGroups>",
    "</Grid>",
  ].join("\n  "));
}

async function completions(buffer, note) {
  return Promise.race([
    h.completionsAt(buffer),
    h.delay(5000).then(() => { throw new Error(`${note} completion did not settle`); }),
  ]);
}

function hasAll(items, expected, note, buffer) {
  for (const label of expected) {
    assert.ok(items.includes(label), `${note} should include ${label}; buffer=${buffer}; got ${items.slice(0, 140).join(", ")}`);
  }
}

function hasNone(items, forbidden, note, buffer) {
  for (const label of forbidden) {
    assert.ok(!items.includes(label), `${note} must not include ${label}; buffer=${buffer}; got ${items.slice(0, 140).join(", ")}`);
  }
}

describe("WinUI XAML red-team 32 — VSM Setter.Target / Storyboard.TargetProperty completion", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("completes Setter.Target's first segment from x:Name and Name declarations only", async () => {
    const buffer = vsm([
      '  <Border x:Name="Chrome32" />',
      '  <Grid x:Name="Root32" />',
      '  <Button Name="PlainName32" />',
    ].join("\n  "), '          <Setter Target="|" Value="0.5" />');
    const items = await completions(buffer, "Setter.Target element segment");
    hasAll(items, ["Chrome32", "Root32", "PlainName32"], "Setter.Target element segment", buffer);
    hasNone(items, ["GreetingText", "Items", "Border", "Button", "Visible", "True"], "Setter.Target element segment", buffer);
  });

  it("filters Setter.Target's element segment by the partial already typed", async () => {
    const buffer = vsm([
      '  <Border x:Name="Chrome32" />',
      '  <Grid x:Name="Root32" />',
      '  <Button Name="PlainName32" />',
    ].join("\n  "), '          <Setter Target="Ch|" Value="0.5" />');
    const items = await completions(buffer, "Setter.Target partial element segment");
    hasAll(items, ["Chrome32"], "Setter.Target partial element segment", buffer);
    hasNone(items, ["Root32", "PlainName32", "GreetingText", "Border"], "Setter.Target partial element segment", buffer);
  });

  it("completes Setter.Target property segment from the named element's inherited properties", async () => {
    const buffer = vsm('  <Border x:Name="Chrome32" />', '          <Setter Target="Chrome32.|" Value="0.5" />');
    const items = await completions(buffer, "Setter.Target property segment");
    hasAll(items, ["Opacity", "Background", "Width"], "Setter.Target property segment", buffer);
    hasNone(items, ["GreetingText", "Items", "Chrome32", "True", "Visible"], "Setter.Target property segment", buffer);
  });

  it("filters Setter.Target property members by the partial after the dot", async () => {
    const buffer = vsm('  <Border x:Name="Chrome32" />', '          <Setter Target="Chrome32.Op|" Value="0.5" />');
    const items = await completions(buffer, "Setter.Target property partial");
    hasAll(items, ["Opacity"], "Setter.Target property partial", buffer);
    hasNone(items, ["Background", "Width", "GreetingText"], "Setter.Target property partial", buffer);
  });

  it("does not leak property, page, or value completions for an unknown Setter.Target element", async () => {
    const buffer = vsm('  <Border x:Name="Chrome32" />', '          <Setter Target="Nope32.|" Value="0.5" />');
    const items = await completions(buffer, "Setter.Target unknown element");
    hasNone(items, ["Opacity", "Background", "Width", "GreetingText", "Items", "Visible", "True"], "unknown Setter.Target element", buffer);
  });

  it("walks deeper Setter.Target property paths without falling back to the root element's members", async () => {
    const buffer = vsm('  <Border x:Name="Chrome32" />', '          <Setter Target="Chrome32.RenderTransform.|" Value="0.5" />');
    const items = await completions(buffer, "Setter.Target deeper property path");
    assert.ok(Array.isArray(items), `deeper Setter.Target path should complete or return empty; buffer=${buffer}`);
    hasNone(items, ["Background", "CornerRadius", "Child", "GreetingText"], "Setter.Target deeper property path", buffer);
  });

  it("keeps malformed Setter.Target values graceful and empty", async () => {
    for (const target of [".|", "Chrome32..Opacity|"]) {
      const buffer = vsm('  <Border x:Name="Chrome32" />', `          <Setter Target="${target}" Value="0.5" />`);
      const items = await completions(buffer, `malformed Setter.Target ${target}`);
      hasNone(items, ["Background", "Width", "GreetingText", "Items", "Visible", "True"], "malformed Setter.Target", buffer);
    }
  });

  it("does not hang on duplicate x:Name declarations and de-duplicates element-name completions", async () => {
    const buffer = vsm([
      '  <Border x:Name="Dup32" />',
      '  <Grid x:Name="Dup32" />',
      '  <Button x:Name="Other32" />',
    ].join("\n  "), '          <Setter Target="|" Value="0.5" />');
    const items = await completions(buffer, "duplicate x:Name Setter.Target");
    assert.strictEqual(items.filter((x) => x === "Dup32").length, 1, `duplicate names should be de-duplicated; buffer=${buffer}; got ${items.join(", ")}`);
    hasAll(items, ["Other32"], "duplicate x:Name Setter.Target", buffer);
  });

  it("finds named elements declared inside templates in the same XAML file", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <ControlTemplate x:Key="Template32" TargetType="Button">',
      '    <Grid x:Name="TemplateRoot32" />',
      "  </ControlTemplate>",
      "</Page.Resources>",
      "<Grid>",
      "  <VisualStateManager.VisualStateGroups><VisualStateGroup><VisualState><VisualState.Setters>",
      '    <Setter Target="Template|" Value="0.5" />',
      "  </VisualState.Setters></VisualState></VisualStateGroup></VisualStateManager.VisualStateGroups>",
      "</Grid>",
    ].join("\n  "));
    const items = await completions(buffer, "template name Setter.Target");
    hasAll(items, ["TemplateRoot32"], "template name Setter.Target", buffer);
  });

  it("completes Storyboard.TargetName as element names only", async () => {
    const buffer = storyboard([
      '  <Border x:Name="Chrome32" />',
      '  <Grid x:Name="Root32" />',
      '  <Button Name="PlainName32" />',
    ].join("\n  "), '<DoubleAnimation Storyboard.TargetName="|" Storyboard.TargetProperty="Opacity" To="0.8" Duration="0:0:0.1" />');
    const items = await completions(buffer, "Storyboard.TargetName");
    hasAll(items, ["Chrome32", "Root32", "PlainName32"], "Storyboard.TargetName", buffer);
    hasNone(items, ["Opacity", "Background", "GreetingText", "Border", "True"], "Storyboard.TargetName", buffer);
  });

  it("completes Storyboard.TargetProperty from the sibling TargetName element", async () => {
    const buffer = storyboard('  <Border x:Name="Chrome32" />',
      '<DoubleAnimation Storyboard.TargetName="Chrome32" Storyboard.TargetProperty="|" To="0.8" Duration="0:0:0.1" />');
    const items = await completions(buffer, "Storyboard.TargetProperty");
    hasAll(items, ["Opacity", "Background", "Width"], "Storyboard.TargetProperty", buffer);
    hasNone(items, ["GreetingText", "Chrome32", "True", "Visible"], "Storyboard.TargetProperty", buffer);
  });

  it("filters Storyboard.TargetProperty by the typed partial", async () => {
    const buffer = storyboard('  <Border x:Name="Chrome32" />',
      '<DoubleAnimation Storyboard.TargetName="Chrome32" Storyboard.TargetProperty="Op|" To="0.8" Duration="0:0:0.1" />');
    const items = await completions(buffer, "Storyboard.TargetProperty partial");
    hasAll(items, ["Opacity"], "Storyboard.TargetProperty partial", buffer);
    hasNone(items, ["Background", "Width", "GreetingText"], "Storyboard.TargetProperty partial", buffer);
  });

  it("does not leak property, page, or value completions without a usable Storyboard.TargetName", async () => {
    for (const animation of [
      '<DoubleAnimation Storyboard.TargetProperty="|" To="0.8" Duration="0:0:0.1" />',
      '<DoubleAnimation Storyboard.TargetName="" Storyboard.TargetProperty="|" To="0.8" Duration="0:0:0.1" />',
      '<DoubleAnimation Storyboard.TargetName="Missing32" Storyboard.TargetProperty="|" To="0.8" Duration="0:0:0.1" />',
    ]) {
      const buffer = storyboard('  <Border x:Name="Chrome32" />', animation);
      const items = await completions(buffer, `Storyboard.TargetProperty missing target for ${animation}`);
      hasNone(items, ["Opacity", "Background", "Width", "GreetingText", "Items", "Visible", "True"], "Storyboard.TargetProperty without a usable TargetName", buffer);
    }
  });

  it("keeps Style Setter.Property completion scoped to the style TargetType", async () => {
    const buffer = page([
      '<Style TargetType="Button">',
      '  <Setter Property="|" Value="Go" />',
      "</Style>",
    ].join("\n  "));
    const items = await completions(buffer, "Style Setter.Property");
    hasAll(items, ["Content", "IsEnabled"], "Style Setter.Property", buffer);
    hasNone(items, ["Chrome32", "GreetingText"], "Style Setter.Property", buffer);
  });

  it("keeps VSM Setter.Target completion out of Style Setter.Property logic", async () => {
    const buffer = vsm('  <Border x:Name="Chrome32" />', '          <Setter Target="|" Value="0.5" />');
    const items = await completions(buffer, "VSM Setter.Target disambiguation");
    hasAll(items, ["Chrome32"], "VSM Setter.Target disambiguation", buffer);
    hasNone(items, ["Content", "IsEnabled", "HorizontalAlignment", "GreetingText"], "VSM Setter.Target disambiguation", buffer);
  });
});

describe("WinUI XAML red-team 32 — documented or acceptable gaps", function () {
  it.skip("GAP: parenthesized Storyboard.TargetProperty paths such as (UIElement.Opacity) are intentionally not asserted", async () => {});
  it.skip("GAP: TargetProperty completion offers all properties rather than animatable-only properties", async () => {});
  it.skip("GAP: framework-symbol hover/F12 for VSM target values remains out of scope for this completion suite", async () => {});
});
