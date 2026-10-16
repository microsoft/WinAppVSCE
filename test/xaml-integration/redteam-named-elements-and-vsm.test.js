"use strict";

// Named-element references, attached properties, x:Bind paths, and VSM behavior.

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

describe("WinUI XAML red-team 10 — named element references", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("completes x:Name values for classic Binding ElementName", async () => {
    const buffer = page([
      "<StackPanel>",
      '  <TextBox x:Name="InputBox" />',
      '  <TextBlock Text="{Binding ElementName=|, Path=Text}" />',
      "</StackPanel>",
    ].join("\n  "));
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("InputBox"), `ElementName completion should include x:Name in the document; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("F12 on classic Binding ElementName lands on the x:Name declaration", async () => {
    const buffer = page([
      "<StackPanel>",
      '  <TextBox x:Name="InputBox" />',
      '  <TextBlock Text="{Binding ElementName=Input|Box, Path=Text}" />',
      "</StackPanel>",
    ].join("\n  "));
    const defs = await h.definitionsAt(buffer);
    assert.ok(defs.length > 0, `ElementName reference should resolve to x:Name declaration; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), XAML, `expected ${XAML}; buffer=${buffer}; got ${defs[0].fsPath}`);
    assert.strictEqual(defs[0].line, 8, `expected InputBox x:Name at 0-based line 8; buffer=${buffer}; got ${defs[0].line}`);
  });

  it("hover on classic Binding ElementName identifies the named element", async () => {
    const buffer = page([
      "<StackPanel>",
      '  <TextBox x:Name="InputBox" />',
      '  <TextBlock Text="{Binding ElementName=Input|Box, Path=Text}" />',
      "</StackPanel>",
    ].join("\n  "));
    const md = await h.hoverAt(buffer);
    assert.ok(/InputBox/.test(md), `ElementName hover should include the referenced x:Name; buffer=${buffer}; got: ${md}`);
    assert.ok(/TextBox/.test(md), `ElementName hover should include the referenced element type; buffer=${buffer}; got: ${md}`);
  });

  it("F12 on Storyboard.TargetName lands on the x:Name declaration", async () => {
    const buffer = page([
      "<Grid>",
      '  <Button x:Name="GoButton" />',
      "  <VisualStateManager.VisualStateGroups>",
      "    <VisualStateGroup>",
      "      <VisualState>",
      "        <Storyboard>",
      '          <ObjectAnimationUsingKeyFrames Storyboard.TargetName="Go|Button" Storyboard.TargetProperty="Visibility" />',
      "        </Storyboard>",
      "      </VisualState>",
      "    </VisualStateGroup>",
      "  </VisualStateManager.VisualStateGroups>",
      "</Grid>",
    ].join("\n  "));
    const defs = await h.definitionsAt(buffer);
    assert.ok(defs.length > 0, `Storyboard.TargetName should resolve to x:Name declaration; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), XAML, `expected ${XAML}; buffer=${buffer}; got ${defs[0].fsPath}`);
    assert.strictEqual(defs[0].line, 8, `expected GoButton x:Name at 0-based line 8; buffer=${buffer}; got ${defs[0].line}`);
  });

  it("reports no WXAML diagnostics for valid ElementName binding and Storyboard.TargetName references", async () => {
    const buffer = page([
      "<Grid>",
      '  <TextBox x:Name="InputBox" />',
      '  <Button x:Name="GoButton" />',
      '  <TextBlock Text="{Binding ElementName=InputBox, Path=Text}" />',
      "  <VisualStateManager.VisualStateGroups>",
      "    <VisualStateGroup>",
      "      <VisualState>",
      "        <Storyboard>",
      '          <ObjectAnimationUsingKeyFrames Storyboard.TargetName="GoButton" Storyboard.TargetProperty="Visibility" />',
      "        </Storyboard>",
      "      </VisualState>",
      "    </VisualStateGroup>",
      "  </VisualStateManager.VisualStateGroups>",
      "</Grid>",
    ].join("\n  "));
    const diags = await h.diagnosticsFor(buffer, () => false, 10000);
    const bad = diags.find((x) => /^WXAML/.test(String(x.code || "")));
    assert.ok(!bad, `valid named-element references should stay silent; buffer=${buffer}; got ${diagSummary(diags)}`);
  });
});

describe("WinUI XAML red-team 10 — attached properties and x:Bind shapes", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("hover on Grid.Row attribute identifies the attached property", async () => {
    const buffer = page([
      "<Grid>",
      '  <Button Grid.R|ow="1" />',
      "</Grid>",
    ].join("\n  "));
    const md = await h.hoverAt(buffer);
    assert.ok(/Grid\.Row|Row/.test(md), `attached-property hover should identify Grid.Row; buffer=${buffer}; got: ${md}`);
    assert.ok(/int|Int32|System\.Int32/.test(md), `attached-property hover should include Row value type; buffer=${buffer}; got: ${md}`);
  });

  it("hover on Setter.Property=Grid.Row identifies the attached property", async () => {
    const buffer = page([
      '<Style TargetType="Button">',
      '  <Setter Property="Grid.R|ow" Value="1" />',
      "</Style>",
    ].join("\n  "));
    const md = await h.hoverAt(buffer);
    assert.ok(/Grid\.Row|Row/.test(md), `Setter.Property hover should identify Grid.Row; buffer=${buffer}; got: ${md}`);
    assert.ok(/int|Int32|System\.Int32/.test(md), `Setter.Property hover should include Row value type; buffer=${buffer}; got: ${md}`);
  });

});

describe("WinUI XAML red-team 10 — custom namespace and VSM robustness", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("F12 on local:SmokePage element lands on the user type source", async () => {
    const buffer = page("<Grid>\n    <local:Smoke|Page />\n  </Grid>");
    const defs = await h.definitionsAt(buffer);
    assert.ok(defs.length > 0, `local:SmokePage element should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), CS, `expected ${CS}; buffer=${buffer}; got ${defs[0].fsPath}`);
    assert.strictEqual(defs[0].line, 12, `expected SmokePage type at 0-based line 12; buffer=${buffer}; got ${defs[0].line}`);
  });

  it("reports WXAML0002 for an unknown type in a declared custom namespace", async () => {
    const buffer = page("<Grid>\n    <local:NoSuchControl />\n  </Grid>");
    const diags = await h.diagnosticsFor(buffer, (xs) => xs.some((d) => d.code === "WXAML0002" && /NoSuchControl/.test(d.message)), 15000);
    const hit = diags.find((d) => d.code === "WXAML0002" && /NoSuchControl/.test(d.message));
    assert.ok(hit, `unknown local type should report WXAML0002; buffer=${buffer}; got ${diagSummary(diags)}`);
  });

  it("reports no WXAML diagnostics for well-formed VisualStateManager Setters markup", async () => {
    const buffer = page([
      "<Grid>",
      '  <Button x:Name="GoButton" Content="Go" />',
      "  <VisualStateManager.VisualStateGroups>",
      "    <VisualStateGroup>",
      '      <VisualState x:Name="WideState">',
      "        <VisualState.Setters>",
      '          <Setter Target="GoButton.Visibility" Value="Visible" />',
      "        </VisualState.Setters>",
      "      </VisualState>",
      "    </VisualStateGroup>",
      "  </VisualStateManager.VisualStateGroups>",
      "</Grid>",
    ].join("\n  "));
    const diags = await h.diagnosticsFor(buffer, () => false, 10000);
    const bad = diags.find((x) => /^WXAML/.test(String(x.code || "")));
    assert.ok(!bad, `valid VSM setters should stay silent; buffer=${buffer}; got ${diagSummary(diags)}`);
  });
});

describe("WinUI XAML red-team 10 — documented or acceptable gaps", function () {
  it.skip("GAP: F12 for framework attached-property source such as Grid.Row remains unavailable", async () => {});
  it.skip("GAP: duplicate x:Name/x:Key consistency diagnostics are not part of the current diagnostic set", async () => {});
});
