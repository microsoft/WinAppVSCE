"use strict";

// Structural duplicate x:Name/x:Key diagnostics and scoping.

const assert = require("node:assert");
const fs = require("node:fs");
const h = require("./helper");

function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
}

function pageWithResources(resources, body) {
  return page(`<Page.Resources>\n    ${resources}\n  </Page.Resources>\n  ${body}`);
}

function wxaml(diags) {
  return diags.filter((x) => /^WXAML/.test(String(x.code || "")));
}

function byCode(diags, code) {
  return wxaml(diags).filter((x) => x.code === code);
}

function countByCode(diags, code) {
  return byCode(diags, code).length;
}

function summary(diags) {
  return wxaml(diags).map((d) => `${d.code}:${d.severity}:${d.message}`).join("; ");
}

function diagText(diag) {
  return h.getDoc().getText(diag.range);
}

function hasDiagnosticText(diags, code, text) {
  return byCode(diags, code).some((d) => diagText(d) === text);
}

const duplicateKeySentinel = '<SolidColorBrush x:Key="__SentinelKey25" Color="Red" />\n    <SolidColorBrush x:Key="__SentinelKey25" Color="Blue" />';
const duplicateNameSentinel = '<Button x:Name="__SentinelName25" />\n    <Button x:Name="__SentinelName25" />';

async function expectNoDuplicateName(buffer, note) {
  const diags = await h.diagnosticsFor(buffer, (d) =>
    countByCode(d, "WXAML0008") === 1 &&
    hasDiagnosticText(d, "WXAML0008", "__SentinelKey25") &&
    countByCode(d, "WXAML0007") === 0);
  assert.strictEqual(countByCode(diags, "WXAML0008"), 1, `sentinel key should fire exactly once for ${note}; got ${summary(diags)}`);
  assert.strictEqual(countByCode(diags, "WXAML0007"), 0, `${note} must not raise duplicate-name diagnostics; got ${summary(diags)}`);
  return diags;
}

async function expectNoDuplicateKey(buffer, note) {
  const diags = await h.diagnosticsFor(buffer, (d) =>
    countByCode(d, "WXAML0007") === 1 &&
    hasDiagnosticText(d, "WXAML0007", "__SentinelName25") &&
    countByCode(d, "WXAML0008") === 0);
  assert.strictEqual(countByCode(diags, "WXAML0007"), 1, `sentinel name should fire exactly once for ${note}; got ${summary(diags)}`);
  assert.strictEqual(countByCode(diags, "WXAML0008"), 0, `${note} must not raise duplicate-key diagnostics; got ${summary(diags)}`);
  return diags;
}

describe("WinUI XAML red-team 25 — duplicate x:Name/x:Key structural diagnostics", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("empirically confirms VS Code severity mapping for new errors and an older warning", async () => {
    const buffer = pageWithResources(
      `${duplicateKeySentinel}`,
      `<StackPanel>\n    <Bogus.Foo />\n    <Button x:Name="SeverityProbe25" />\n    <TextBlock x:Name="SeverityProbe25" />\n  </StackPanel>`
    );
    const diags = await h.diagnosticsFor(buffer, (d) =>
      countByCode(d, "WXAML0002") >= 1 &&
      hasDiagnosticText(d, "WXAML0007", "SeverityProbe25") &&
      hasDiagnosticText(d, "WXAML0008", "__SentinelKey25"));
    assert.strictEqual(byCode(diags, "WXAML0002")[0].severity, 1, `WXAML0002 should be VS Code warning=1; got ${summary(diags)}`);
    assert.strictEqual(byCode(diags, "WXAML0007")[0].severity, 0, `WXAML0007 should be VS Code error=0; got ${summary(diags)}`);
    assert.strictEqual(byCode(diags, "WXAML0008")[0].severity, 0, `WXAML0008 should be VS Code error=0; got ${summary(diags)}`);
  });

  it("real fixture markup stays free of duplicate-name false positives", async () => {
    const fixture = fs.readFileSync(h.XAML_PATH, "utf8").replace(/<\/Page>\s*$/, `  <Page.Resources>\n    ${duplicateKeySentinel}\n  </Page.Resources>\n</Page>`);
    await expectNoDuplicateName(fixture, "the smoke fixture's real markup");
  });

  it("single and many distinct x:Name values stay silent", async () => {
    const buffer = pageWithResources(
      duplicateKeySentinel,
      `<StackPanel>\n    <Button x:Name="GoButton25" />\n    <TextBlock x:Name="TitleText25" />\n    <Border x:Name="ShellBorder25" />\n    <Grid x:Name="LayoutRoot25" />\n  </StackPanel>`
    );
    await expectNoDuplicateName(buffer, "unique page-scope names");
  });

  it("reusing the same x:Name across separate DataTemplates stays silent", async () => {
    const buffer = pageWithResources(
      duplicateKeySentinel,
      `<StackPanel>\n    <ContentControl>\n      <ContentControl.ContentTemplate>\n        <DataTemplate><TextBlock x:Name="TemplateLabel25" Text="One" /></DataTemplate>\n      </ContentControl.ContentTemplate>\n    </ContentControl>\n    <ContentControl>\n      <ContentControl.ContentTemplate>\n        <DataTemplate><TextBlock x:Name="TemplateLabel25" Text="Two" /></DataTemplate>\n      </ContentControl.ContentTemplate>\n    </ContentControl>\n  </StackPanel>`
    );
    await expectNoDuplicateName(buffer, "same name in separate DataTemplate instances");
  });

  it("template content may reuse a page-scope name without colliding", async () => {
    const buffer = pageWithResources(
      duplicateKeySentinel,
      `<StackPanel>\n    <TextBlock x:Name="ReusableInsideTemplate25" />\n    <ContentControl>\n      <ContentControl.ContentTemplate>\n        <DataTemplate><TextBlock x:Name="ReusableInsideTemplate25" /></DataTemplate>\n      </ContentControl.ContentTemplate>\n    </ContentControl>\n  </StackPanel>`
    );
    await expectNoDuplicateName(buffer, "same name in page body and DataTemplate content");
  });

  it("ControlTemplate and ItemsPanelTemplate content each get independent name scopes", async () => {
    const buffer = pageWithResources(
      `${duplicateKeySentinel}\n    <ControlTemplate x:Key="TemplateA25" TargetType="Button">\n      <Grid x:Name="TemplatePart25" />\n    </ControlTemplate>\n    <ItemsPanelTemplate x:Key="TemplateB25">\n      <StackPanel x:Name="TemplatePart25" />\n    </ItemsPanelTemplate>`,
      `<Grid />`
    );
    await expectNoDuplicateName(buffer, "ControlTemplate and ItemsPanelTemplate duplicate content names");
  });

  it("a named template object and an inner child may share a name because only content is re-scoped", async () => {
    const buffer = pageWithResources(
      duplicateKeySentinel,
      `<ContentControl>\n    <ContentControl.ContentTemplate>\n      <DataTemplate x:Name="TemplateOwnName25">\n        <TextBlock x:Name="TemplateOwnName25" />\n      </DataTemplate>\n    </ContentControl.ContentTemplate>\n  </ContentControl>`
    );
    await expectNoDuplicateName(buffer, "template object name reused by its child content");
  });

  it("empty whitespace markup-extension and design-time names are ignored", async () => {
    const buffer = pageWithResources(
      duplicateKeySentinel,
      `<StackPanel>\n    <Button x:Name="   " />\n    <TextBlock x:Name="   " />\n    <Border x:Name="{x:Bind GreetingText}" />\n    <Grid x:Name="{x:Bind GreetingText}" />\n    <Button d:Name="DesignerOnly25" />\n    <TextBlock d:Name="DesignerOnly25" />\n  </StackPanel>`
    );
    await expectNoDuplicateName(buffer, "ignored non-static/design-time names");
  });

  it("genuine duplicate x:Name at page scope fires once on the second value only", async () => {
    const buffer = page(`<StackPanel>\n    <Button x:Name="DupPageName25" />\n    <TextBlock x:Name="DupPageName25" />\n  </StackPanel>`);
    const diags = await h.diagnosticsFor(buffer, (d) =>
      countByCode(d, "WXAML0007") === 1 && hasDiagnosticText(d, "WXAML0007", "DupPageName25"));
    const dupes = byCode(diags, "WXAML0007");
    assert.strictEqual(dupes.length, 1, `expected one duplicate-name diagnostic; got ${summary(diags)}`);
    assert.strictEqual(dupes[0].severity, 0, `duplicate name should be an error; got ${summary(diags)}`);
    assert.match(dupes[0].message, /DupPageName25/, `message should name duplicate value; got ${dupes[0].message}`);
    assert.strictEqual(diagText(dupes[0]), "DupPageName25", `diagnostic should underline the duplicate name value; got ${diagText(dupes[0])}`);
  });

  it("Name and x:Name are unified when checking duplicate page-scope names", async () => {
    const buffer = page(`<StackPanel>\n    <Button Name="UnifiedName25" />\n    <TextBlock x:Name="UnifiedName25" />\n  </StackPanel>`);
    const diags = await h.diagnosticsFor(buffer, (d) =>
      countByCode(d, "WXAML0007") === 1 && hasDiagnosticText(d, "WXAML0007", "UnifiedName25"));
    const dupes = byCode(diags, "WXAML0007");
    assert.strictEqual(dupes.length, 1, `expected one duplicate-name diagnostic; got ${summary(diags)}`);
    assert.strictEqual(diagText(dupes[0]), "UnifiedName25", `diagnostic should be on second value; got ${diagText(dupes[0])}`);
  });

  it("three identical names produce diagnostics on the second and third occurrences", async () => {
    const buffer = page(`<StackPanel>\n    <Button x:Name="TripleName25" />\n    <TextBlock x:Name="TripleName25" />\n    <Border x:Name="TripleName25" />\n  </StackPanel>`);
    const diags = await h.diagnosticsFor(buffer, (d) =>
      countByCode(d, "WXAML0007") === 2 &&
      byCode(d, "WXAML0007").every((x) => diagText(x) === "TripleName25"));
    const dupes = byCode(diags, "WXAML0007");
    assert.strictEqual(dupes.length, 2, `expected second and third duplicate-name diagnostics; got ${summary(diags)}`);
    assert.deepStrictEqual(dupes.map(diagText), ["TripleName25", "TripleName25"]);
  });

  it("genuine duplicate inside one DataTemplate scope fires once", async () => {
    const buffer = page(`<ContentControl>\n    <ContentControl.ContentTemplate>\n      <DataTemplate>\n        <StackPanel>\n          <TextBlock x:Name="DupInsideTemplate25" />\n          <Border x:Name="DupInsideTemplate25" />\n        </StackPanel>\n      </DataTemplate>\n    </ContentControl.ContentTemplate>\n  </ContentControl>`);
    const diags = await h.diagnosticsFor(buffer, (d) =>
      countByCode(d, "WXAML0007") === 1 && hasDiagnosticText(d, "WXAML0007", "DupInsideTemplate25"));
    const dupes = byCode(diags, "WXAML0007");
    assert.strictEqual(dupes.length, 1, `expected one duplicate-name diagnostic in template scope; got ${summary(diags)}`);
    assert.strictEqual(diagText(dupes[0]), "DupInsideTemplate25");
  });

  it("same x:Key across Page.Resources and nested element Resources stays silent", async () => {
    const buffer = pageWithResources(
      `<SolidColorBrush x:Key="ScopedBrush25" Color="Red" />`,
      `<StackPanel>\n    ${duplicateNameSentinel}\n    <Grid>\n      <Grid.Resources>\n        <SolidColorBrush x:Key="ScopedBrush25" Color="Blue" />\n      </Grid.Resources>\n    </Grid>\n  </StackPanel>`
    );
    await expectNoDuplicateKey(buffer, "same key in Page.Resources and Grid.Resources");
  });

  it("same x:Key across merged dictionaries stays silent", async () => {
    const buffer = pageWithResources(
      `<ResourceDictionary>\n      <ResourceDictionary.MergedDictionaries>\n        <ResourceDictionary>\n          <SolidColorBrush x:Key="MergedRepeat25" Color="Red" />\n        </ResourceDictionary>\n        <ResourceDictionary>\n          <SolidColorBrush x:Key="MergedRepeat25" Color="Blue" />\n        </ResourceDictionary>\n      </ResourceDictionary.MergedDictionaries>\n    </ResourceDictionary>`,
      `<StackPanel>\n    ${duplicateNameSentinel}\n  </StackPanel>`
    );
    await expectNoDuplicateKey(buffer, "same key in separate merged ResourceDictionaries");
  });

  it("same x:Key across Light and Dark theme dictionaries stays silent", async () => {
    const buffer = pageWithResources(
      `<ResourceDictionary>\n      <ResourceDictionary.ThemeDictionaries>\n        <ResourceDictionary x:Key="Light">\n          <SolidColorBrush x:Key="ThemeBrush25" Color="White" />\n        </ResourceDictionary>\n        <ResourceDictionary x:Key="Dark">\n          <SolidColorBrush x:Key="ThemeBrush25" Color="Black" />\n        </ResourceDictionary>\n      </ResourceDictionary.ThemeDictionaries>\n    </ResourceDictionary>`,
      `<StackPanel>\n    ${duplicateNameSentinel}\n  </StackPanel>`
    );
    await expectNoDuplicateKey(buffer, "same key in separate theme dictionaries");
  });

  it("flags repeated markup-extension x:Key values such as duplicate implicit style keys", async () => {
    const buffer = pageWithResources(
      `<Style x:Key="{x:Type Button}" TargetType="Button" />\n    <Style x:Key="{x:Type Button}" TargetType="Button" />\n    <Style x:Key="{x:Type TextBox}" TargetType="TextBox" />`,
      `<StackPanel>\n    ${duplicateNameSentinel}\n  </StackPanel>`
    );
    const diags = await h.diagnosticsFor(buffer, (d) =>
      countByCode(d, "WXAML0008") === 1 &&
      countByCode(d, "WXAML0007") === 1 &&
      hasDiagnosticText(d, "WXAML0007", "__SentinelName25"));
    assert.strictEqual(countByCode(diags, "WXAML0008"), 1, `duplicate {x:Type Button} should raise exactly one WXAML0008 (distinct {x:Type TextBox} must not collide); got ${summary(diags)}`);
    assert.strictEqual(diagText(byCode(diags, "WXAML0008")[0]), "Button", `duplicate-type-key span should select the type argument; got ${summary(diags)}`);
  });

  it("a keyed resource and a nested subtree resource may use the same x:Key", async () => {
    const buffer = pageWithResources(
      `<Border x:Key="NestedResourceOwner25">\n      <Border.Resources>\n        <SolidColorBrush x:Key="NestedResourceOwner25" Color="Blue" />\n      </Border.Resources>\n    </Border>`,
      `<StackPanel>\n    ${duplicateNameSentinel}\n  </StackPanel>`
    );
    await expectNoDuplicateKey(buffer, "same key on resource entry and its nested Resources subtree");
  });

  it("empty whitespace and markup-extension x:Key values are ignored", async () => {
    const buffer = pageWithResources(
      `<SolidColorBrush x:Key="   " Color="Red" />\n    <SolidColorBrush x:Key="   " Color="Blue" />\n    <SolidColorBrush x:Key="{x:Bind GreetingText}" Color="Green" />\n    <SolidColorBrush x:Key="{x:Bind GreetingText}" Color="Yellow" />`,
      `<StackPanel>\n    ${duplicateNameSentinel}\n  </StackPanel>`
    );
    await expectNoDuplicateKey(buffer, "ignored non-static resource keys");
  });

  it("genuine duplicate x:Key in implicit Page.Resources fires once on the second value", async () => {
    const buffer = pageWithResources(
      `<SolidColorBrush x:Key="DupBrush25" Color="Red" />\n    <SolidColorBrush x:Key="DupBrush25" Color="Blue" />`,
      `<Grid />`
    );
    const diags = await h.diagnosticsFor(buffer, (d) =>
      countByCode(d, "WXAML0008") === 1 && hasDiagnosticText(d, "WXAML0008", "DupBrush25"));
    const dupes = byCode(diags, "WXAML0008");
    assert.strictEqual(dupes.length, 1, `expected one duplicate-key diagnostic; got ${summary(diags)}`);
    assert.strictEqual(dupes[0].severity, 0, `duplicate key should be an error; got ${summary(diags)}`);
    assert.match(dupes[0].message, /same key/, `message should be duplicate-key text; got ${dupes[0].message}`);
    assert.strictEqual(diagText(dupes[0]), "DupBrush25", `diagnostic should underline second key value; got ${diagText(dupes[0])}`);
  });

  it("genuine duplicate x:Key in an explicit ResourceDictionary fires once", async () => {
    const buffer = pageWithResources(
      `<ResourceDictionary>\n      <SolidColorBrush x:Key="ExplicitDupBrush25" Color="Red" />\n      <SolidColorBrush x:Key="ExplicitDupBrush25" Color="Blue" />\n    </ResourceDictionary>`,
      `<Grid />`
    );
    const diags = await h.diagnosticsFor(buffer, (d) =>
      countByCode(d, "WXAML0008") === 1 && hasDiagnosticText(d, "WXAML0008", "ExplicitDupBrush25"));
    const dupes = byCode(diags, "WXAML0008");
    assert.strictEqual(dupes.length, 1, `expected one duplicate-key diagnostic in explicit dictionary; got ${summary(diags)}`);
    assert.strictEqual(diagText(dupes[0]), "ExplicitDupBrush25");
  });

  it("duplicate keys in implicit and explicit dictionaries are reported independently", async () => {
    const buffer = pageWithResources(
      `<SolidColorBrush x:Key="ImplicitDup25" Color="Red" />\n    <SolidColorBrush x:Key="ImplicitDup25" Color="Blue" />\n    <ResourceDictionary>\n      <SolidColorBrush x:Key="ExplicitDup25" Color="Green" />\n      <SolidColorBrush x:Key="ExplicitDup25" Color="Yellow" />\n    </ResourceDictionary>`,
      `<Grid />`
    );
    const diags = await h.diagnosticsFor(buffer, (d) =>
      countByCode(d, "WXAML0008") === 2 &&
      hasDiagnosticText(d, "WXAML0008", "ImplicitDup25") &&
      hasDiagnosticText(d, "WXAML0008", "ExplicitDup25"));
    const dupes = byCode(diags, "WXAML0008");
    assert.strictEqual(dupes.length, 2, `expected one duplicate from each dictionary scope; got ${summary(diags)}`);
    assert.deepStrictEqual(dupes.map(diagText).sort(), ["ExplicitDup25", "ImplicitDup25"]);
  });

  it("duplicate key inside one merged dictionary fires in that nested scope only", async () => {
    const buffer = pageWithResources(
      `<ResourceDictionary>\n      <ResourceDictionary.MergedDictionaries>\n        <ResourceDictionary>\n          <SolidColorBrush x:Key="MergedDup25" Color="Red" />\n          <SolidColorBrush x:Key="MergedDup25" Color="Blue" />\n        </ResourceDictionary>\n        <ResourceDictionary>\n          <SolidColorBrush x:Key="MergedDup25" Color="Green" />\n        </ResourceDictionary>\n      </ResourceDictionary.MergedDictionaries>\n    </ResourceDictionary>`,
      `<Grid />`
    );
    const diags = await h.diagnosticsFor(buffer, (d) =>
      countByCode(d, "WXAML0008") === 1 && hasDiagnosticText(d, "WXAML0008", "MergedDup25"));
    const dupes = byCode(diags, "WXAML0008");
    assert.strictEqual(dupes.length, 1, `expected only the duplicate inside one merged dictionary; got ${summary(diags)}`);
    assert.strictEqual(diagText(dupes[0]), "MergedDup25");
  });

  it("mixed buffer keeps duplicate name key and x:Bind diagnostics independent", async () => {
    const buffer = pageWithResources(
      `<SolidColorBrush x:Key="MixedKey25" Color="Red" />\n    <SolidColorBrush x:Key="MixedKey25" Color="Blue" />`,
      `<StackPanel>\n    <Button x:Name="MixedName25" />\n    <TextBlock x:Name="MixedName25" Text="{x:Bind GreetingText.NopeRound25}" />\n  </StackPanel>`
    );
    const diags = await h.diagnosticsFor(buffer, (d) =>
      hasDiagnosticText(d, "WXAML0007", "MixedName25") &&
      hasDiagnosticText(d, "WXAML0008", "MixedKey25") &&
      countByCode(d, "WXAML0005") >= 1);
    assert.strictEqual(countByCode(diags, "WXAML0007"), 1, `expected one duplicate-name diagnostic; got ${summary(diags)}`);
    assert.strictEqual(countByCode(diags, "WXAML0008"), 1, `expected one duplicate-key diagnostic; got ${summary(diags)}`);
    assert.strictEqual(countByCode(diags, "WXAML0005"), 1, `expected one x:Bind diagnostic; got ${summary(diags)}`);
  });
});
