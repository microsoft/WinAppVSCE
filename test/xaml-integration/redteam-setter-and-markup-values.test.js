"use strict";

// Style and template semantics around TargetType and Setter.Property completion.

const assert = require("node:assert");
const path = require("node:path");
const h = require("./helper");

const CS = "SmokePage.xaml.cs";
const APP = "App.xaml";

function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
}

function diagSummary(diags) {
  return diags.map((d) => `${d.code}:${d.message}`).join("; ");
}

describe("WinUI XAML red-team 4 — Setter.Value typed completion", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("control: direct enum attribute value completion still offers HorizontalAlignment members", async () => {
    const items = await h.completionsAt(page('<Button HorizontalAlignment="|" />'));
    assert.ok(items.includes("Center"), `expected direct HorizontalAlignment enum completion; got ${items.slice(0, 80).join(", ")}`);
    assert.ok(items.includes("Stretch"), "expected Stretch for direct HorizontalAlignment completion");
  });

  it("completes enum values for Setter.Value using sibling Property and Style TargetType", async () => {
    const items = await h.completionsAt(page([
      "<Page.Resources>",
      '  <Style TargetType="Button">',
      '    <Setter Property="HorizontalAlignment" Value="|" />',
      "  </Style>",
      "</Page.Resources>",
    ].join("\n  ")));
    assert.ok(items.includes("Center"), `expected Setter.Value to complete HorizontalAlignment.Center; got ${items.slice(0, 80).join(", ")}`);
    assert.ok(items.includes("Stretch"), "expected Setter.Value to complete HorizontalAlignment.Stretch");
  });

  it("control: direct bool attribute value completion still offers True and False", async () => {
    const items = await h.completionsAt(page('<Button IsEnabled="|" />'));
    assert.ok(items.includes("True"), `expected direct bool completion; got ${items.slice(0, 80).join(", ")}`);
    assert.ok(items.includes("False"), "expected False for direct bool completion");
  });

  it("completes bool values for Setter.Value using sibling Property and Style TargetType", async () => {
    const items = await h.completionsAt(page([
      "<Page.Resources>",
      '  <Style TargetType="Button">',
      '    <Setter Property="IsEnabled" Value="|" />',
      "  </Style>",
      "</Page.Resources>",
    ].join("\n  ")));
    assert.ok(items.includes("True"), `expected Setter.Value to complete bool True; got ${items.slice(0, 80).join(", ")}`);
    assert.ok(items.includes("False"), "expected Setter.Value to complete bool False");
  });
});

describe("WinUI XAML red-team 4 — TargetType and Setter.Property value semantics", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("control: user element name F12 still navigates to code-behind", async () => {
    const defs = await h.definitionsAt(page("<local:Smoke|Page />"));
    assert.ok(defs.length > 0, "expected definition for local:SmokePage element");
    assert.strictEqual(path.basename(defs[0].fsPath), CS, `expected ${CS}; got ${defs[0].fsPath}`);
  });

  it("F12 on a user Style TargetType value navigates to the user type source", async () => {
    const defs = await h.definitionsAt(page([
      "<Page.Resources>",
      '  <Style TargetType="local:Smoke|Page">',
      '    <Setter Property="DataContext" Value="{x:Null}" />',
      "  </Style>",
      "</Page.Resources>",
    ].join("\n  ")));
    assert.ok(defs.length > 0, "expected definition for local:SmokePage inside Style.TargetType");
    assert.strictEqual(path.basename(defs[0].fsPath), CS, `expected ${CS}; got ${defs[0].fsPath}`);
  });

  it("hover on Setter.Property value describes the target type member, not the Setter.Property attribute", async () => {
    const md = await h.hoverAt(page([
      "<Page.Resources>",
      '  <Style TargetType="Button">',
      '    <Setter Property="Cont|ent" Value="Go" />',
      "  </Style>",
      "</Page.Resources>",
    ].join("\n  ")));
    assert.ok(/Content/.test(md), `expected hover to include Button.Content; got: ${md}`);
    assert.ok(/Button|ContentControl/.test(md), `expected hover to identify the target owner/type; got: ${md}`);
  });
});

describe("WinUI XAML red-team 4 — markup extensions beyond StaticResource", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("ThemeResource key completion matches StaticResource for app and framework keys", async () => {
    // Background offers app and framework Brush keys.
    const items = await h.completionsAt(page('<Grid Background="{ThemeResource |}" />'));
    assert.ok(items.includes("SmokeAccentBrush"), `expected app resource key in ThemeResource completion; got ${items.slice(0, 80).join(", ")}`);
    assert.ok(
      items.some((i) => i.includes("AccentFillColorDefaultBrush")),
      `expected framework theme brush key in ThemeResource completion; got ${items.slice(0, 80).join(", ")}`
    );
    // A Style-typed property offers the framework theme Style keys under ThemeResource too.
    const styleItems = await h.completionsAt(page('<Grid Style="{ThemeResource |}" />'));
    assert.ok(
      styleItems.some((i) => i.includes("TextBlockStyle")),
      `expected framework theme style key on a Style property; got ${styleItems.slice(0, 80).join(", ")}`
    );
  });

  it("ThemeResource F12 and hover resolve project resources like StaticResource", async () => {
    const text = page('<Grid Background="{ThemeResource SmokeAccent|Brush}" />');
    const defs = await h.definitionsAt(text);
    assert.ok(defs.length > 0, "expected ThemeResource key definition");
    assert.strictEqual(path.basename(defs[0].fsPath), APP, `expected ${APP}; got ${defs[0].fsPath}`);

    const md = await h.hoverAt(text);
    assert.ok(/SmokeAccentBrush/.test(md), `expected key name in ThemeResource hover; got: ${md}`);
    assert.ok(/SolidColorBrush/.test(md), `expected resource type in ThemeResource hover; got: ${md}`);
  });

  it("completes TemplateBinding properties from the enclosing ControlTemplate TargetType", async () => {
    const items = await h.completionsAt(page([
      "<Page.Resources>",
      '  <ControlTemplate TargetType="Button">',
      '    <ContentPresenter Content="{TemplateBinding |}" />',
      "  </ControlTemplate>",
      "</Page.Resources>",
    ].join("\n  ")));
    assert.ok(items.includes("Content"), `expected TemplateBinding to complete Button.Content; got ${items.slice(0, 80).join(", ")}`);
    assert.ok(items.includes("IsEnabled"), `expected TemplateBinding to complete inherited Button.IsEnabled; got ${items.slice(0, 80).join(", ")}`);
  });
});

describe("WinUI XAML red-team 4 — diagnostics on realistic template/resource markup", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("reports no diagnostics for valid template VisualState Setters and TemplateBinding", async () => {
    const diags = await h.diagnosticsFor(page([
      "<Page.Resources>",
      '  <Style x:Key="StatefulButtonStyle" TargetType="Button">',
      '    <Setter Property="Template">',
      "      <Setter.Value>",
      '        <ControlTemplate TargetType="Button">',
      "          <Grid>",
      "            <VisualStateManager.VisualStateGroups>",
      '              <VisualStateGroup x:Name="CommonStates">',
      '                <VisualState x:Name="PointerOver">',
      "                  <VisualState.Setters>",
      '                    <Setter Target="Root.Opacity" Value="0.8" />',
      "                  </VisualState.Setters>",
      "                </VisualState>",
      "              </VisualStateGroup>",
      "            </VisualStateManager.VisualStateGroups>",
      '            <Border x:Name="Root" Background="{ThemeResource SmokeAccentBrush}">',
      '              <ContentPresenter Content="{TemplateBinding Content}" />',
      "            </Border>",
      "          </Grid>",
      "        </ControlTemplate>",
      "      </Setter.Value>",
      "    </Setter>",
      "  </Style>",
      "</Page.Resources>",
      '<Button Style="{StaticResource StatefulButtonStyle}" />',
    ].join("\n  ")), (d) => d.length === 0, 10000);
    assert.deepStrictEqual(diags.map((d) => `${d.code}:${d.message}`), [], `expected zero diagnostics for valid VisualState template; got ${diagSummary(diags)}`);
  });

  it("reports no diagnostics for Grid RowDefinitions and ColumnDefinitions shorthand", async () => {
    const diags = await h.diagnosticsFor(page('<Grid RowDefinitions="Auto,*" ColumnDefinitions="Auto,2*">\n    <Button Grid.Row="1" Grid.Column="1" />\n  </Grid>'), (d) => d.length === 0, 10000);
    assert.deepStrictEqual(diags.map((d) => `${d.code}:${d.message}`), [], `expected zero diagnostics for valid Grid shorthand; got ${diagSummary(diags)}`);
  });
});

describe("WinUI XAML red-team 4 — documented gaps", function () {
  it.skip("GAP: F12 on framework TargetType values still needs metadata-as-source", async () => {});
});
