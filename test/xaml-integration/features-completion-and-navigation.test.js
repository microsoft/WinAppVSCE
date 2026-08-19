"use strict";

// Language features driven through VS Code's completion, navigation, and diagnostics APIs. Prefer presence checks because VS Code merges word suggestions into completion results.

const assert = require("node:assert");
const path = require("node:path");
const vscode = require("vscode");
const h = require("./helper");

const CS = "SmokePage.xaml.cs";
const APP = "App.xaml";
const MERGED_RESOURCES = "MergedResources.xaml";

// A <Page> header with x:Class so the server resolves the real SmokeFixture project (types, x:Bind targets, event handlers, App.xaml resources).
function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
}

describe("WinUI XAML — completion", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("element names", async () => {
    const items = await h.completionsAt(page("<But|"));
    assert.ok(items.includes("Button"), `expected Button; got ${items.join(", ")}`);
  });

  it("attribute names (properties + events)", async () => {
    const items = await h.completionsAt(page("<Button |/>"));
    assert.ok(items.includes("Content"), "expected Content property");
    assert.ok(items.includes("Click"), "expected Click event");
    assert.ok(items.includes("IsEnabled"), "expected IsEnabled property");
  });

  it("attached properties", async () => {
    const items = await h.completionsAt(page("<Button Grid.|/>"));
    assert.ok(items.includes("Grid.Row"), `expected Grid.Row; got ${items.join(", ")}`);
    assert.ok(items.includes("Grid.Column"), "expected Grid.Column");
  });

  it("enum values", async () => {
    const items = await h.completionsAt(page('<Button HorizontalAlignment="|" />'));
    assert.ok(items.includes("Center"), `expected Center; got ${items.join(", ")}`);
    assert.ok(items.includes("Stretch"), "expected Stretch");
  });

  it("boolean values", async () => {
    const items = await h.completionsAt(page('<Button IsEnabled="|" />'));
    assert.ok(items.includes("True"), "expected True");
    assert.ok(items.includes("False"), "expected False");
  });

  it("x:Bind member paths", async () => {
    const items = await h.completionsAt(page('<TextBlock Text="{x:Bind Gre|}" />'));
    assert.ok(items.includes("GreetingText"), `expected GreetingText; got ${items.join(", ")}`);
  });

  it("markup extension names", async () => {
    const items = await h.completionsAt(page('<TextBlock Text="{|}" />'));
    assert.ok(items.includes("x:Bind"), "expected x:Bind");
    assert.ok(items.includes("StaticResource"), "expected StaticResource");
  });

  it("markup named-argument (Mode=) values", async () => {
    const items = await h.completionsAt(page('<TextBlock Text="{x:Bind GreetingText, Mode=|}" />'));
    assert.ok(items.includes("TwoWay"), `expected TwoWay; got ${items.join(", ")}`);
    assert.ok(items.includes("OneWay"), "expected OneWay");
  });

  it("x:Bind UpdateSourceTrigger= enum values (compiled binding has no reflectable extension type)", async () => {
    // Server enum detail excludes word suggestions; UpdateSourceTrigger uses the curated fallback.
    const ust = (await h.completionItemsAt(page('<TextBox Text="{x:Bind GreetingText, Mode=TwoWay, UpdateSourceTrigger=|}" />')))
      .filter((i) => i.detail === "UpdateSourceTrigger")
      .map((i) => i.label);
    for (const want of ["Default", "PropertyChanged", "Explicit", "LostFocus"]) {
      assert.ok(ust.includes(want), `expected UpdateSourceTrigger.${want}; got ${JSON.stringify(ust)}`);
    }
  });

  it("filters x:Bind UpdateSourceTrigger= on the typed partial", async () => {
    const ust = (await h.completionItemsAt(page('<TextBox Text="{x:Bind GreetingText, UpdateSourceTrigger=Prop|}" />')))
      .filter((i) => i.detail === "UpdateSourceTrigger")
      .map((i) => i.label);
    assert.ok(ust.includes("PropertyChanged"), `'Prop' should offer PropertyChanged; got ${JSON.stringify(ust)}`);
    assert.ok(!ust.includes("Default"), `'Prop' must not offer Default; got ${JSON.stringify(ust)}`);
  });

  it("does not leak the curated bind enums into a non-binding markup extension", async () => {
    // The fallback is gated to compiled-binding extensions; a bogus same-named argument on a non-binding extension must not borrow BindingMode/UpdateSourceTrigger. Filter on the enum-type detail (server-only).
    for (const ext of ["StaticResource", "TemplateBinding"]) {
      for (const arg of ["Mode", "UpdateSourceTrigger"]) {
        const leaked = (await h.completionItemsAt(page(`<TextBlock Text="{${ext} ${arg}=|}" />`)))
          .filter((i) => i.detail === "BindingMode" || i.detail === "UpdateSourceTrigger")
          .map((i) => i.label);
        assert.strictEqual(leaked.length, 0, `{${ext} ${arg}=} must not leak binding enum values; got ${JSON.stringify(leaked)}`);
      }
    }
  });

  it("resource keys are type-scoped to the target property (round 74)", async () => {
    // Background is a Brush: the project's own App.xaml key is always offered, a framework theme BRUSH key is offered, and a framework Style key (TitleTextBlockStyle) is filtered out by type.
    const brushItems = await h.completionsAt(page('<Grid Background="{StaticResource |}" />'));
    assert.ok(brushItems.includes("SmokeAccentBrush"), "expected project key SmokeAccentBrush from App.xaml");
    assert.ok(brushItems.includes("MergedAccentBrush"), "expected project key from App.xaml merged dictionaries");
    assert.ok(
      brushItems.some((i) => i.includes("AccentFillColorDefaultBrush")),
      `expected a framework theme brush key; got ${brushItems.slice(0, 20).join(", ")}`
    );
    assert.ok(
      !brushItems.some((i) => i === "TitleTextBlockStyle"),
      "a framework Style key must NOT be offered on a Brush property"
    );

    // Style is a Style-typed property: the framework Style key IS offered there.
    const styleItems = await h.completionsAt(page('<Grid Style="{StaticResource |}" />'));
    assert.ok(
      styleItems.some((i) => i.includes("TitleTextBlockStyle")),
      `expected a framework theme style key on a Style property; got ${styleItems.slice(0, 20).join(", ")}`
    );
  });

  it("navigates to and describes resources from App.xaml merged dictionaries", async () => {
    const defs = await h.definitionsAt(page('<Grid Background="{StaticResource MergedAccent|Brush}" />'));
    assert.ok(defs.length > 0, "expected a definition for the merged resource");
    assert.strictEqual(path.basename(defs[0].fsPath), MERGED_RESOURCES);

    const md = await h.hoverAt(page('<Grid Background="{StaticResource MergedAccent|Brush}" />'));
    assert.match(md, /SolidColorBrush/);
    assert.match(md, /MergedResources\.xaml/);
  });

  it("uses unsaved merged-dictionary contents", async () => {
    const smokeDoc = h.getDoc();
    const mergedDoc = await vscode.workspace.openTextDocument(
      vscode.Uri.file(path.join(h.FIXTURE_DIR, MERGED_RESOURCES))
    );
    const originalText = mergedDoc.getText();
    const mergedEditor = await vscode.window.showTextDocument(mergedDoc, { preview: false });
    const original = "MergedAccentBrush";
    const offset = mergedDoc.getText().indexOf(original);
    assert.ok(offset >= 0, "merged resource fixture should contain the original key");
    const changed = await mergedEditor.edit((builder) =>
      builder.replace(
        new vscode.Range(mergedDoc.positionAt(offset), mergedDoc.positionAt(offset + original.length)),
        "UnsavedAccentBrush"
      )
    );
    assert.ok(changed, "expected unsaved merged resource edit to apply");

    try {
      await vscode.window.showTextDocument(smokeDoc, { preview: false });
      const items = await h.completionsAt(page('<Grid Background="{StaticResource |}" />'));
      assert.ok(items.includes("UnsavedAccentBrush"), "expected the unsaved merged resource key");
      assert.ok(!items.includes(original), "stale on-disk key should not remain in completion");
    } finally {
      const cleanupEditor = await vscode.window.showTextDocument(mergedDoc, { preview: false });
      const cleaned = await cleanupEditor.edit((builder) =>
        builder.replace(
          new vscode.Range(mergedDoc.positionAt(0), mergedDoc.positionAt(mergedDoc.getText().length)),
          originalText
        )
      );
      assert.ok(cleaned, "expected merged resource fixture cleanup to apply");
      await vscode.window.showTextDocument(smokeDoc, { preview: false });
    }
  });

  it("Storyboard.TargetProperty parenthesized (Owner.Property) qualifiers complete the explicit owner's members (round 77)", async () => {
    // An explicit (Type.Property) qualifier overrides Storyboard.TargetName.
    const sb = (tp) => page([
      '<StackPanel>',
      '  <Border x:Name="Probe" />',
      '  <Storyboard>',
      `    <DoubleAnimation Storyboard.TargetName="Probe" Storyboard.TargetProperty="${tp}" />`,
      '  </Storyboard>',
      '</StackPanel>',
    ].join("\n  "));
    const inst = await h.completionsAt(sb("(UIElement.Opac|"));
    assert.ok(inst.includes("Opacity"), `(UIElement.Opac should complete instance DP Opacity; got ${inst.slice(0, 20).join(", ")}`);
    const attached = await h.completionsAt(sb("(Canvas.|"));
    assert.ok(attached.includes("Top"), `(Canvas. should complete attached property Top; got ${attached.slice(0, 20).join(", ")}`);
    const chained = await h.completionsAt(sb("(UIElement.RenderTransform).(CompositeTransform.Trans|"));
    assert.ok(chained.includes("TranslateX"), `chained (…).(CompositeTransform.Trans should complete TranslateX; got ${chained.slice(0, 20).join(", ")}`);
  });

  it("type-scopes document-local author resource keys by their declaring element type (round 78)", async () => {
    // Server-only detail distinguishes resource items from VS Code word suggestions.
    const res = [
      '<Page.Resources>',
      '  <SolidColorBrush x:Key="MyDocBrush" Color="Red" />',
      '  <Style x:Key="MyDocStyle" TargetType="Button" />',
      '</Page.Resources>',
    ].join("\n  ");
    const authorKeys = async (attr) =>
      (await h.completionItemsAt(page(`${res}\n  <Grid ${attr} />`)))
        .filter((i) => i.detail === "resource")
        .map((i) => i.label);
    // Brush property: the author Brush is a server "resource" item; the author Style is type-scoped away.
    const onBrush = await authorKeys('Background="{StaticResource |}"');
    assert.ok(onBrush.includes("MyDocBrush"), `author Brush key should be a server 'resource' item on a Brush property; got ${onBrush.join(", ")}`);
    assert.ok(!onBrush.includes("MyDocStyle"), `author Style key must be type-scoped away from a Brush property; got ${onBrush.join(", ")}`);
    assert.ok(onBrush.includes("SmokeAccentBrush"), `App.xaml key must always be offered (never type-scoped); got ${onBrush.join(", ")}`);
    // Style property: the author Style is a server "resource" item; the author Brush is type-scoped away.
    const onStyle = await authorKeys('Style="{StaticResource |}"');
    assert.ok(onStyle.includes("MyDocStyle"), `author Style key should be a server 'resource' item on a Style property; got ${onStyle.join(", ")}`);
    assert.ok(!onStyle.includes("MyDocBrush"), `author Brush key must be type-scoped away from a Style property; got ${onStyle.join(", ")}`);
    assert.ok(onStyle.includes("SmokeAccentBrush"), `App.xaml key must always be offered on a Style property too; got ${onStyle.join(", ")}`);
  });

  it("scopes Setter.Value resource keys to the property named by the sibling Property= (round 75)", async () => {
    // A <Setter Value="{StaticResource |}"> is declared 'object' but VS scopes it to the property the sibling Property= names on the enclosing TargetType — so a Foreground setter offers theme BRUSH keys, hides a theme Style key, and still always offers the project's own App.xaml key.
    const brushSetter = await h.completionsAt(page([
      '<Page.Resources>',
      '  <Style TargetType="TextBlock">',
      '    <Setter Property="Foreground" Value="{StaticResource |}" />',
      '  </Style>',
      '</Page.Resources>',
    ].join("\n  ")));
    assert.ok(brushSetter.includes("SmokeAccentBrush"), "Setter.Value(Foreground) must always offer the App.xaml author key");
    assert.ok(
      brushSetter.some((i) => i.includes("AccentFillColorDefaultBrush")),
      `expected a framework theme brush key in Setter.Value(Foreground); got ${brushSetter.slice(0, 20).join(", ")}`
    );
    assert.ok(
      !brushSetter.some((i) => i === "TitleTextBlockStyle"),
      "a framework Style key must NOT be offered in Setter.Value for a Brush property"
    );

    // Without a resolvable Property, the setter conservatively offers every theme key.
    const noProp = await h.completionsAt(page([
      '<Page.Resources>',
      '  <Style TargetType="Button">',
      '    <Setter Value="{StaticResource |}" />',
      '  </Style>',
      '</Page.Resources>',
    ].join("\n  ")));
    assert.ok(
      noProp.some((i) => i === "AccentButtonStyle") && noProp.some((i) => i.includes("AccentFillColorDefaultBrush")),
      `Setter.Value with no Property must offer ALL theme keys; got ${noProp.slice(0, 20).join(", ")}`
    );
  });
});

describe("WinUI XAML — closing-tag completion", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  // Our close-tag item is uniquely identified by detail === "Closing tag", so VS Code's built-in word-based suggestions (which can also surface "Grid") never confound these assertions.
  const closeTag = (items) => items.filter((i) => i.detail === "Closing tag");

  it("offers the innermost unclosed element name after '</'", async () => {
    const items = closeTag(await h.completionItemsAt(page("<Grid>\n    </|")));
    assert.strictEqual(items.length, 1, `expected exactly one closing-tag item; got ${JSON.stringify(items)}`);
    assert.strictEqual(items[0].label, "Grid");
    assert.strictEqual(items[0].newText, "Grid>", "should append '>' when none follows the caret");
  });

  it("reuses an existing '>' from VS Code's auto-closed '</>' pair", async () => {
    const items = closeTag(await h.completionItemsAt(page("<Grid>\n    </|>")));
    assert.strictEqual(items.length, 1, `expected one item; got ${JSON.stringify(items)}`);
    assert.strictEqual(items[0].label, "Grid");
    assert.strictEqual(items[0].newText, "Grid", "should NOT append '>' when one already follows");
  });

  it("completes a dotted property-element name", async () => {
    const items = closeTag(await h.completionItemsAt(
      page("<Grid>\n    <Grid.RowDefinitions>\n      <RowDefinition />\n      </|\n  </Grid>")
    ));
    assert.strictEqual(items.length, 1, `expected one item; got ${JSON.stringify(items)}`);
    assert.strictEqual(items[0].label, "Grid.RowDefinitions");
  });

  it("offers nothing when every enclosing element is already closed", async () => {
    const items = closeTag(await h.completionItemsAt(page("<Grid>\n    <Button />\n  </Grid>\n  </|")));
    assert.strictEqual(items.length, 0, `expected no closing-tag suggestion; got ${JSON.stringify(items)}`);
  });
});

describe("WinUI XAML — using: namespace completion", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  // Namespace detail distinguishes source, referenced, and VS Code word suggestions.
  const clr = (items) => items.filter((i) => i.detail === "CLR namespace");
  const clrRef = (items) => items.filter((i) => i.detail === "CLR namespace (referenced)");

  it("offers the project's own namespace inside an xmlns \"using:\" value", async () => {
    const items = clr(await h.completionItemsAt(page('<Grid xmlns:zzz="using:|" />')));
    const smoke = items.find((i) => i.label === "SmokeFixture");
    assert.ok(smoke, `expected the project namespace 'SmokeFixture'; got ${JSON.stringify(items)}`);
    assert.strictEqual(smoke.newText, "SmokeFixture", "the whole namespace token replaces the typed text");
  });

  it("the source group is source-only — no framework/library namespaces", async () => {
    const items = clr(await h.completionItemsAt(page('<Grid xmlns:zzz="using:|" />')));
    const framework = items.filter(
      (i) => /^(Microsoft\.UI|Windows\.|System\.)/.test(i.label)
    );
    assert.strictEqual(framework.length, 0, `the source group must not include framework namespaces; got ${JSON.stringify(framework)}`);
  });

  it("also offers referenced framework/library namespaces (a library reached only via using:)", async () => {
    const referenced = clrRef(await h.completionItemsAt(page('<Grid xmlns:zzz="using:|" />'))).map((i) => i.label);
    assert.ok(
      referenced.includes("Microsoft.UI.Xaml.Controls"),
      `expected 'Microsoft.UI.Xaml.Controls' in the referenced group; got ${referenced.length} referenced items`
    );
    // Disjoint: the project's own namespace is source, never referenced.
    assert.ok(!referenced.includes("SmokeFixture"), "SmokeFixture must not appear in the referenced group");
  });

  it("filters on the whole dotted token", async () => {
    const match = clr(await h.completionItemsAt(page('<Grid xmlns:zzz="using:Smoke|" />')));
    assert.ok(match.some((i) => i.label === "SmokeFixture"), `'Smoke' should match 'SmokeFixture'; got ${JSON.stringify(match)}`);

    const miss = clr(await h.completionItemsAt(page('<Grid xmlns:zzz="using:Zzz|" />')));
    assert.ok(!miss.some((i) => i.label === "SmokeFixture"), `'Zzz' must not match 'SmokeFixture'; got ${JSON.stringify(miss)}`);
  });

  it("filters the referenced group on the whole dotted token", async () => {
    const match = clrRef(await h.completionItemsAt(page('<Grid xmlns:zzz="using:Microsoft.UI.Xaml.Cont|" />'))).map((i) => i.label);
    assert.ok(
      match.includes("Microsoft.UI.Xaml.Controls"),
      `dotted 'Microsoft.UI.Xaml.Cont' should match the referenced 'Microsoft.UI.Xaml.Controls'; got ${JSON.stringify(match)}`
    );
  });
});

describe("WinUI XAML — xmlns value completion", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  // Each xmlns-value item carries a distinctive server detail; filtering by that set isolates the server's suggestions from VS Code's built-in word-based ones (though the URIs, containing "://", are already word-merge-safe). A fresh prefix (zzz) avoids colliding with h.NS-declared 'local'.
  const PRES = "http://schemas.microsoft.com/winfx/2006/xaml/presentation";
  const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
  const XMLNS_DETAILS = new Set([
    "WinUI presentation namespace",
    "XAML language namespace (x:)",
    "Design-time namespace (d:)",
    "Markup compatibility namespace (mc:)",
    "CLR namespace reference",
  ]);
  const xv = (items) => items.filter((i) => XMLNS_DETAILS.has(i.detail));

  it("offers the framework presentation URI in an empty xmlns value, replacing the whole value", async () => {
    const items = xv(await h.completionItemsAt(page('<Grid xmlns:zzz="|" />')));
    const pres = items.find((i) => i.label === PRES);
    assert.ok(pres, `expected the WinUI presentation URI; got ${JSON.stringify(items.map((i) => i.label))}`);
    assert.strictEqual(pres.detail, "WinUI presentation namespace");
    assert.strictEqual(pres.newText, PRES, "the whole value is replaced with the URI");
  });

  it("offers the using: scheme (handoff to CLR-namespace completion) in an empty xmlns value", async () => {
    const items = xv(await h.completionItemsAt(page('<Grid xmlns:zzz="|" />')));
    const using = items.find((i) => i.label === "using:");
    assert.ok(using, `expected the using: scheme; got ${JSON.stringify(items.map((i) => i.label))}`);
    assert.strictEqual(using.newText, "using:", "the using: scheme replaces the whole value");
  });

  it("still offers the using: scheme while the scheme word is being typed", async () => {
    const items = xv(await h.completionItemsAt(page('<Grid xmlns:zzz="usin|" />')));
    assert.ok(items.some((i) => i.label === "using:"), `'usin' should still offer the using: scheme; got ${JSON.stringify(items.map((i) => i.label))}`);
  });

  it("filters on the whole value — a winfx prefix matches the WinUI URIs but not the mc URI", async () => {
    const labels = xv(await h.completionItemsAt(page('<Grid xmlns:zzz="http://schemas.microsoft.com/winfx|" />'))).map((i) => i.label);
    assert.ok(labels.some((l) => l === PRES), `expected the WinUI presentation URI; got ${JSON.stringify(labels)}`);
    assert.ok(!labels.some((l) => l === MC), `the openxmlformats mc URI must not match a winfx prefix; got ${JSON.stringify(labels)}`);
  });

  it("does not offer xmlns values on a non-xmlns attribute", async () => {
    const items = xv(await h.completionItemsAt(page('<Grid Tag="|" />')));
    assert.strictEqual(items.length, 0, `a non-xmlns attribute must not get xmlns-value suggestions; got ${JSON.stringify(items.map((i) => i.label))}`);
  });
});

describe("WinUI XAML — RelativePanel alignment completion", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  // Element-name items carry a server detail beginning "(element)". VS Code also word-suggests the names (they are literally in the buffer), so every assertion filters on that detail to isolate server output.
  const el = (items) => items.filter((i) => i.detail && i.detail.startsWith("(element)"));
  const rp = (attr) => page(`<RelativePanel>\n    <TextBox x:Name="AlphaBox" />\n    <TextBox x:Name="BetaBox" />\n    <Button ${attr} />\n  </RelativePanel>`);

  it("offers the in-scope x:Names for RelativePanel.RightOf, replacing the whole value", async () => {
    const items = el(await h.completionItemsAt(rp('RelativePanel.RightOf="|"')));
    const labels = items.map((i) => i.label);
    assert.ok(labels.includes("AlphaBox") && labels.includes("BetaBox"), `expected the sibling names; got ${JSON.stringify(labels)}`);
    const alpha = items.find((i) => i.label === "AlphaBox");
    assert.strictEqual(alpha.newText, "AlphaBox", "the whole value is replaced with the name");
  });

  it("filters RelativePanel.RightOf on the typed partial", async () => {
    const labels = el(await h.completionItemsAt(rp('RelativePanel.RightOf="Alph|"'))).map((i) => i.label);
    assert.ok(labels.includes("AlphaBox"), `'Alph' should match AlphaBox; got ${JSON.stringify(labels)}`);
    assert.ok(!labels.includes("BetaBox"), `'Alph' must not match BetaBox; got ${JSON.stringify(labels)}`);
  });

  it("offers names for the other alignment properties too (AlignTopWith)", async () => {
    const labels = el(await h.completionItemsAt(rp('RelativePanel.AlignTopWith="|"'))).map((i) => i.label);
    assert.ok(labels.includes("AlphaBox"), `AlignTopWith should also offer names; got ${JSON.stringify(labels)}`);
  });

  it("does not offer element names for the boolean *WithPanel variant", async () => {
    const items = el(await h.completionItemsAt(rp('RelativePanel.AlignLeftWithPanel="|"')));
    assert.strictEqual(items.length, 0, `the boolean *WithPanel variant must not get element-name suggestions; got ${JSON.stringify(items.map((i) => i.label))}`);
  });
});

describe("WinUI XAML — container attached-property completion", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  // Container attached-property items carry a server detail beginning "attached property". Full dotted labels (Grid.Row) are not a single VS Code word, but we still filter on the server detail to isolate server output.
  const ap = (items) => items.filter((i) =>
    i.detail &&
    i.detail.startsWith("attached property") &&
    !i.label.startsWith("AutomationProperties."));
  const inGrid = (attr) => page(`<Grid>\n    <Button ${attr} />\n  </Grid>`);

  it("offers the immediate Grid container's attached properties on a child, replacing the whole name", async () => {
    const items = ap(await h.completionItemsAt(inGrid("|")));
    const labels = items.map((i) => i.label);
    for (const want of ["Grid.Row", "Grid.Column", "Grid.RowSpan", "Grid.ColumnSpan"]) {
      assert.ok(labels.includes(want), `expected the container's attached property '${want}'; got ${JSON.stringify(labels)}`);
    }
    const row = items.find((i) => i.label === "Grid.Row");
    assert.strictEqual(row.newText, 'Grid.Row="$0"', "the whole (qualified) attached-property name is inserted with a =\"$0\" value snippet (VS parity)");
  });

  it("still offers the element's own members alongside the attached properties (additive)", async () => {
    const items = await h.completionItemsAt(inGrid("|"));
    const own = items.filter((i) => i.label === "IsEnabled" && (!i.detail || !i.detail.startsWith("attached property")));
    assert.ok(own.length >= 1, `the child's own members (IsEnabled) must still be offered; got ${JSON.stringify(items.slice(0, 20).map((i) => i.label))}`);
  });

  it("filters attached properties on the typed member-name partial", async () => {
    const labels = ap(await h.completionItemsAt(inGrid("Ro|"))).map((i) => i.label);
    assert.ok(labels.includes("Grid.Row") && labels.includes("Grid.RowSpan"), `'Ro' should match Grid.Row/Grid.RowSpan; got ${JSON.stringify(labels)}`);
    assert.ok(!labels.includes("Grid.Column"), `'Ro' must not surface Grid.Column; got ${JSON.stringify(labels)}`);
  });

  it("offers the immediate Canvas container's attached properties (not the Grid's)", async () => {
    const labels = ap(await h.completionItemsAt(page(`<Canvas>\n    <Button |/>\n  </Canvas>`))).map((i) => i.label);
    assert.ok(labels.includes("Canvas.Left") && labels.includes("Canvas.Top"), `expected Canvas.Left/Top; got ${JSON.stringify(labels)}`);
    assert.ok(!labels.includes("Grid.Row"), `a Canvas child must not offer Grid.Row; got ${JSON.stringify(labels)}`);
  });

  it("scopes to the IMMEDIATE container: a StackPanel child (inside a Grid) offers no attached properties", async () => {
    const items = ap(await h.completionItemsAt(page(`<Grid>\n    <StackPanel>\n      <Button |/>\n    </StackPanel>\n  </Grid>`)));
    assert.strictEqual(items.length, 0, `StackPanel has no attached properties and is the immediate container; Grid.Row must not leak; got ${JSON.stringify(items.map((i) => i.label))}`);
  });
});

describe("WinUI XAML — context-aware element types (#1)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  // Concrete content types restrict completion to assignable children. Asserted names stay out of the buffer to exclude VS Code word suggestions.
  it("narrows a Grid child position to UIElement-derived types", async () => {
    const items = await h.completionsAt(page("<Grid>\n    <|\n  </Grid>"));
    assert.ok(items.includes("Button"), `a Grid child should offer Button; got ${items.length} items`);
    assert.ok(items.includes("TextBlock"), `a Grid child should offer TextBlock; got ${items.length} items`);
    assert.ok(!items.includes("VisualStateManager"), `a Grid child must not offer VisualStateManager (not a UIElement); got ${items.length} items`);
    assert.ok(!items.includes("RoutedEventArgs"), `a Grid child must not offer RoutedEventArgs; got ${items.length} items`);
    assert.ok(!items.includes("DataTemplate"), `a Grid child must not offer DataTemplate; got ${items.length} items`);
  });

  it("narrows a Border child (single UIElement Child) the same way", async () => {
    const items = await h.completionsAt(page("<Border>\n    <|\n  </Border>"));
    assert.ok(items.includes("Button"), `a Border child should offer Button; got ${items.length} items`);
    assert.ok(!items.includes("VisualStateManager"), `a Border child must not offer VisualStateManager; got ${items.length} items`);
  });

  it("does NOT narrow object-typed content (a Button's Content) — the full type list stays available", async () => {
    const items = await h.completionsAt(page("<Button>\n    <|\n  </Button>"));
    assert.ok(items.includes("Button"), `Button content should still offer Button; got ${items.length} items`);
    assert.ok(items.includes("VisualStateManager"), `object-typed content must keep the full list (VisualStateManager present); got ${items.length} items`);
  });
});

describe("WinUI XAML — attribute-name value snippet (#2)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  // Snippet insertText is exposed through helper.completionItemsAt as newText. Server detail excludes word suggestions when the attribute name is already in the buffer.
  const server = (items, label) => items.find((i) => i.label === label && i.detail);

  it("appends a =\"$0\" snippet to an event-handler name (Click)", async () => {
    const items = await h.completionItemsAt(page("<Button Cli|>"));
    const click = server(items, "Click");
    assert.ok(click, `expected the Click event; got ${JSON.stringify(items.slice(0, 20).map((i) => i.label))}`);
    assert.strictEqual(click.newText, 'Click="$0"', `Click should insert the value snippet; got ${JSON.stringify(click.newText)}`);
  });

  it("appends a =\"$0\" snippet to a property name (Content)", async () => {
    const items = await h.completionItemsAt(page("<Button Con|>"));
    const content = server(items, "Content");
    assert.ok(content, `expected Content; got ${JSON.stringify(items.slice(0, 20).map((i) => i.label))}`);
    assert.strictEqual(content.newText, 'Content="$0"', `Content should insert the value snippet; got ${JSON.stringify(content.newText)}`);
  });

  it("does NOT append a snippet when the name is already followed by '=' (stays bare)", async () => {
    const items = await h.completionItemsAt(page('<Button Click|="x" />'));
    const click = server(items, "Click");
    assert.ok(click, `expected the server Click item; got ${JSON.stringify(items.slice(0, 20).map((i) => i.label))}`);
    assert.strictEqual(click.newText, "Click", `an existing '=' means no snippet is appended; got ${JSON.stringify(click.newText)}`);
  });
});

describe("WinUI XAML — unquoted attribute-value quoting (#2 follow-on)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  // Unquoted value completions add quotes; server detail excludes word suggestions.
  const server = (items, label) => items.find((i) => i.label === label && i.detail);

  it("wraps an event handler in quotes at an unquoted value position", async () => {
    const items = await h.completionItemsAt(page("<Button Click=On|>"));
    const handler = server(items, "OnGo_Click");
    assert.ok(handler, `expected the OnGo_Click handler; got ${JSON.stringify(items.slice(0, 20).map((i) => i.label))}`);
    assert.strictEqual(handler.newText, '"OnGo_Click"', `an unquoted Click= must insert quoted text; got ${JSON.stringify(handler.newText)}`);
  });

  it("wraps an enum member in quotes at an unquoted value position", async () => {
    const items = await h.completionItemsAt(page("<Button Visibility=Coll|>"));
    const value = server(items, "Collapsed");
    assert.ok(value, `expected the Collapsed enum member; got ${JSON.stringify(items.slice(0, 20).map((i) => i.label))}`);
    assert.strictEqual(value.newText, '"Collapsed"', `an unquoted enum value must be quoted; got ${JSON.stringify(value.newText)}`);
  });

  it("wraps a boolean in quotes at an unquoted value position", async () => {
    const items = await h.completionItemsAt(page("<Button IsEnabled=Tr|>"));
    const value = server(items, "True");
    assert.ok(value, `expected the True boolean; got ${JSON.stringify(items.slice(0, 20).map((i) => i.label))}`);
    assert.strictEqual(value.newText, '"True"', `an unquoted bool value must be quoted; got ${JSON.stringify(value.newText)}`);
  });

  it("consumes a mid-token suffix so the whole value token is replaced", async () => {
    const items = await h.completionItemsAt(page("<Button Click=On|Xyz>"));
    const handler = server(items, "OnGo_Click");
    assert.ok(handler, `expected the OnGo_Click handler; got ${JSON.stringify(items.slice(0, 20).map((i) => i.label))}`);
    assert.strictEqual(handler.newText, '"OnGo_Click"', `a mid-token accept must replace the whole token with quoted text; got ${JSON.stringify(handler.newText)}`);
  });

  it("stays bare when the value already has surrounding quotes (no double-quoting)", async () => {
    const items = await h.completionItemsAt(page('<Button Click="On|">'));
    const handler = server(items, "OnGo_Click");
    assert.ok(handler, `expected the OnGo_Click handler; got ${JSON.stringify(items.slice(0, 20).map((i) => i.label))}`);
    assert.strictEqual(handler.newText, "OnGo_Click", `a quoted value must not get extra quotes; got ${JSON.stringify(handler.newText)}`);
  });
});

describe("WinUI XAML — generate event handler (#3)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  const generate = (actions) => actions.find((a) => a.title && a.title.startsWith("Generate event handler"));

  it("offers a Generate-handler quick fix for a missing Click handler and stubs the user code-behind", async () => {
    const actions = await h.codeActionsAtCaret(page('<Button Click="Foo|_Click" Content="Hi" />'));
    const gen = generate(actions);
    assert.ok(gen, `expected a Generate event handler action; got ${JSON.stringify(actions.map((a) => a.title))}`);
    assert.strictEqual(gen.title, "Generate event handler 'Foo_Click'");
    assert.strictEqual(gen.kind, "quickfix", "the generate action must be a quickfix");
    assert.strictEqual(gen.isPreferred, true, "the generate action must be preferred (lightbulb default)");
    // The edit lands in the USER code-behind partial, never a generated .g.cs, with the delegate signature.
    const csEdit = gen.edits.find((e) => /SmokePage\.xaml\.cs$/i.test(e.fsPath));
    assert.ok(csEdit, `edit should target SmokePage.xaml.cs; got ${JSON.stringify(gen.edits.map((e) => e.fsPath))}`);
    assert.ok(
      !gen.edits.some((e) => /\.g\.i?\.cs$/i.test(e.fsPath)),
      `must not write to a generated .g.cs partial; got ${JSON.stringify(gen.edits.map((e) => e.fsPath))}`
    );
    assert.ok(
      csEdit.newText.includes("private void Foo_Click(object sender, RoutedEventArgs e)"),
      `stub should carry the delegate signature; got ${JSON.stringify(csEdit.newText)}`
    );
  });

  it("also fires when the caret is on the event attribute NAME (not just the value)", async () => {
    const actions = await h.codeActionsAtCaret(page('<Button Cli|ck="Bar_Click" Content="Hi" />'));
    const gen = generate(actions);
    assert.ok(gen, `a caret on the attribute name should still offer the fix; got ${JSON.stringify(actions.map((a) => a.title))}`);
    assert.strictEqual(gen.title, "Generate event handler 'Bar_Click'");
  });

  it("offers NO generate action when the handler already exists in the code-behind", async () => {
    const actions = await h.codeActionsAtCaret(page('<Button Click="OnGo|_Click" Content="Hi" />'));
    assert.ok(!generate(actions), `an existing handler must not be regenerated; got ${JSON.stringify(actions.map((a) => a.title))}`);
  });

  it("offers NO generate action on a non-event attribute", async () => {
    const actions = await h.codeActionsAtCaret(page('<Button Foreground="Nope|_Handler" Content="Hi" />'));
    assert.ok(!generate(actions), `a non-event attribute must not offer the fix; got ${JSON.stringify(actions.map((a) => a.title))}`);
  });

  it("offers NO generate action on a markup-extension value", async () => {
    const actions = await h.codeActionsAtCaret(page('<Button Click="{x:Bind Ghost|_Click}" Content="Hi" />'));
    assert.ok(!generate(actions), `a markup-extension value is not a handler name; got ${JSON.stringify(actions.map((a) => a.title))}`);
  });
});

describe("WinUI XAML — mc:Ignorable value completion", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  // The offered prefixes (d, dd) are bare tokens that also appear as xmlns prefixes in the buffer, so VS Code word-merges them
  const D2006 = "http://schemas.microsoft.com/expression/blend/2006";
  const dt = (items) => items.filter((i) => i.detail === "Ignorable design-time prefix");
  const grid = (attrs) => page(`<Grid xmlns:dd="${D2006}" ${attrs} />`);

  it("offers the declared design-time prefixes for an empty mc:Ignorable value, replacing the whole token", async () => {
    const items = dt(await h.completionItemsAt(grid('mc:Ignorable="|"')));
    const labels = items.map((i) => i.label);
    assert.ok(labels.includes("d") && labels.includes("dd"), `expected the design-time prefixes d + dd; got ${JSON.stringify(labels)}`);
    assert.ok(!labels.includes("mc") && !labels.includes("x") && !labels.includes("local"), `only design-time prefixes may be offered; got ${JSON.stringify(labels)}`);
    assert.strictEqual(items.find((i) => i.label === "d").newText, "d", "the whole prefix token is inserted");
  });

  it("filters the design-time prefixes on the typed partial", async () => {
    const labels = dt(await h.completionItemsAt(grid('mc:Ignorable="d|"'))).map((i) => i.label);
    assert.ok(labels.includes("d") && labels.includes("dd"), `'d' matches both d and dd (StartsWith); got ${JSON.stringify(labels)}`);
    const none = dt(await h.completionItemsAt(grid('mc:Ignorable="z|"')));
    assert.strictEqual(none.length, 0, `'z' matches no design-time prefix; got ${JSON.stringify(none.map((i) => i.label))}`);
  });

  it("is space-separated aware: excludes an already-listed prefix and replaces only the current token", async () => {
    const items = dt(await h.completionItemsAt(grid('mc:Ignorable="d |"')));
    const labels = items.map((i) => i.label);
    assert.ok(labels.includes("dd"), `the remaining design-time prefix dd must be offered; got ${JSON.stringify(labels)}`);
    assert.ok(!labels.includes("d"), `the already-listed prefix d must not be re-offered; got ${JSON.stringify(labels)}`);
    assert.strictEqual(items.find((i) => i.label === "dd").newText, "dd", "only the current (second) token is replaced");
  });

  it("gates by the RESOLVED markup-compatibility URI (a custom prefix mapped to it works)", async () => {
    const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
    const labels = dt(await h.completionItemsAt(page(`<Grid xmlns:compat="${MC}" compat:Ignorable="|" />`))).map((i) => i.label);
    assert.ok(labels.includes("d"), `compat:Ignorable (custom prefix on the mc URI) must offer d; got ${JSON.stringify(labels)}`);
  });

  it("does not treat a design-time-prefixed 'Ignorable' (wrong URI) as mc:Ignorable", async () => {
    const items = dt(await h.completionItemsAt(page('<Grid d:Ignorable="|" />')));
    assert.strictEqual(items.length, 0, `d:Ignorable resolves to the blend namespace, not markup-compatibility; got ${JSON.stringify(items.map((i) => i.label))}`);
  });
});

describe("WinUI XAML — classic {Binding} member paths", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  // DataTemplate Binding roots at x:DataType; asserted names stay out of the buffer.
  const template = (inner) =>
    page(`<ListView>\n  <ListView.ItemTemplate>\n    <DataTemplate x:DataType="local:SmokePage">\n      ${inner}\n    </DataTemplate>\n  </ListView.ItemTemplate>\n</ListView>`);

  it("completes x:DataType members inside a DataTemplate", async () => {
    const items = await h.completionsAt(template('<TextBlock Text="{Binding Gree|}" />'));
    assert.ok(items.includes("GreetingText"), `expected GreetingText; got ${items.join(", ")}`);
  });

  it("completes a Path= named argument the same as the positional path", async () => {
    const items = await h.completionsAt(template('<TextBlock Text="{Binding Path=Gree|}" />'));
    assert.ok(items.includes("GreetingText"), `expected GreetingText; got ${items.join(", ")}`);
  });

  it("does not leak x:Class members at the page root (DataContext unknown)", async () => {
    const items = await h.completionsAt(page('<TextBlock Text="{Binding Gree|}" />'));
    assert.ok(!items.includes("GreetingText"), `page-root {Binding} must not offer x:Class members; got ${items.join(", ")}`);
  });

  it("roots the path at a named element (ElementName= wins over x:DataType)", async () => {
    // ElementName roots the path at the named element rather than x:DataType.
    const inner = '<StackPanel>\n        <TextBox x:Name="Root" />\n        <TextBlock Text="{Binding ElementName=Root, Path=|}" />\n      </StackPanel>';
    const items = await h.completionsAt(template(inner));
    assert.ok(items.includes("IsEnabled"), `expected the named TextBox member IsEnabled; got ${items.join(", ")}`);
    assert.ok(!items.includes("GreetingText"), `ElementName must root at the named element, not the template x:DataType; got ${items.join(", ")}`);
  });

  it("completes a named element's members via ElementName= at the page root", async () => {
    // ElementName supplies a root even when the page DataContext type is unknown.
    const inner = '<StackPanel>\n    <TextBox x:Name="Box1" />\n    <TextBlock Text="{Binding ElementName=Box1, Path=|}" />\n  </StackPanel>';
    const items = await h.completionsAt(page(inner));
    assert.ok(items.includes("IsEnabled"), `expected the named TextBox member IsEnabled; got ${items.join(", ")}`);
    assert.ok(!items.includes("GreetingText"), `page-level ElementName must not leak x:Class members; got ${items.join(", ")}`);
  });
});

describe("WinUI XAML — design-time {Binding} rooting", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  // An ancestor's d:DataContext="{d:DesignInstance ...}" is a design-time hint (stripped at runtime by mc:Ignorable="d") that tells the editor the page-level DataContext type, so a classic {Binding} completes that type's members even outside a DataTemplate. h.NS already declares the d + local prefixes.
  it("roots a page-level {Binding} at a d:DataContext DesignInstance type", async () => {
    const items = await h.completionsAt(page('<Grid d:DataContext="{d:DesignInstance local:SmokePage}">\n    <TextBlock Text="{Binding Gree|}" />\n  </Grid>'));
    assert.ok(items.includes("GreetingText"), `expected GreetingText; got ${items.join(", ")}`);
  });

  it("supports the Type= named DesignInstance form", async () => {
    const items = await h.completionsAt(page('<Grid d:DataContext="{d:DesignInstance Type=local:SmokePage, IsDesignTimeCreatable=True}">\n    <TextBlock Text="{Binding Gree|}" />\n  </Grid>'));
    assert.ok(items.includes("GreetingText"), `expected GreetingText; got ${items.join(", ")}`);
  });

  it("lets a nearer DataTemplate x:DataType shadow the design DataContext", async () => {
    const items = await h.completionsAt(page('<Grid d:DataContext="{d:DesignInstance local:SmokePage}">\n    <ListView><ListView.ItemTemplate><DataTemplate x:DataType="x:String"><TextBlock Text="{Binding Gree|}" /></DataTemplate></ListView.ItemTemplate></ListView>\n  </Grid>'));
    assert.ok(!items.includes("GreetingText"), `inner x:String template must shadow the outer d:DataContext; got ${items.join(", ")}`);
  });

  it("requires the DesignInstance extension prefix to be a design-time namespace", async () => {
    const items = await h.completionsAt(page('<Grid d:DataContext="{zzz:DesignInstance local:SmokePage}">\n    <TextBlock Text="{Binding Gree|}" />\n  </Grid>'));
    assert.ok(!items.includes("GreetingText"), `a foreign DesignInstance extension prefix must not root the binding; got ${items.join(", ")}`);
  });

  it("recognizes x:DataType only under the reserved x prefix", async () => {
    const ok = await h.completionsAt(page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="local:SmokePage"><TextBlock Text="{x:Bind Gree|}" /></DataTemplate></ListView.ItemTemplate></ListView>'));
    assert.ok(ok.includes("GreetingText"), `x:DataType should root x:Bind at SmokePage; got ${ok.join(", ")}`);
    const foreign = await h.completionsAt(page('<ListView><ListView.ItemTemplate><DataTemplate zzz:DataType="local:SmokePage"><TextBlock Text="{x:Bind Gree|}" /></DataTemplate></ListView.ItemTemplate></ListView>'));
    assert.ok(!foreign.includes("GreetingText"), `a foreign-prefix DataType must not be treated as x:DataType; got ${foreign.join(", ")}`);
  });

  // Server newText and detail distinguish x:DataType results from the "SmokePage" buffer word.
  it("completes project types in an x:DataType value", async () => {
    const items = await h.completionItemsAt(page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="local:Smo|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>'));
    const ours = items.filter((i) => i.newText === "local:SmokePage" && i.detail === "SmokeFixture");
    assert.ok(ours.length >= 1, `expected an x:DataType type item local:SmokePage (SmokeFixture); got ${JSON.stringify(items)}`);
  });

  it("completes default-namespace framework types in an x:DataType value", async () => {
    const items = await h.completionItemsAt(page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="Butt|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>'));
    const button = items.find((i) => i.label === "Button" && (i.detail || "").includes("Microsoft.UI.Xaml.Controls"));
    assert.ok(button, `expected a Button type item from the default namespace; got ${JSON.stringify(items.slice(0, 20))}`);
  });

  it("does not offer type completion for a non-x:DataType directive value", async () => {
    const items = await h.completionItemsAt(page('<ListView><ListView.ItemTemplate><DataTemplate x:Name="local:Smo|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>'));
    const ours = items.filter((i) => i.newText === "local:SmokePage" && i.detail === "SmokeFixture");
    assert.strictEqual(ours.length, 0, `only x:DataType gets type completion, not x:Name; got ${JSON.stringify(ours)}`);
  });
});

describe("WinUI XAML — {d:DesignInstance} type-argument completion", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  // Server newText and detail distinguish DesignInstance types from the "SmokePage" buffer word.
  const isSmokePageType = (i) => i.newText === "local:SmokePage" && i.detail === "SmokeFixture";

  it("completes project types in a positional DesignInstance type argument", async () => {
    const items = await h.completionItemsAt(page('<Grid d:DataContext="{d:DesignInstance local:Smo|}" />'));
    assert.ok(items.some(isSmokePageType), `expected a local:SmokePage type item; got ${JSON.stringify(items.slice(0, 20))}`);
  });

  it("completes project types in a Type= DesignInstance argument", async () => {
    const items = await h.completionItemsAt(page('<Grid d:DataContext="{d:DesignInstance Type=local:Smo|}" />'));
    assert.ok(items.some(isSmokePageType), `expected a local:SmokePage type item via Type=; got ${JSON.stringify(items.slice(0, 20))}`);
  });

  it("finds the Type= argument after another named argument", async () => {
    const items = await h.completionItemsAt(page('<Grid d:DataContext="{d:DesignInstance IsDesignTimeCreatable=True, Type=local:Smo|}" />'));
    assert.ok(items.some(isSmokePageType), `expected a local:SmokePage type item after IsDesignTimeCreatable; got ${JSON.stringify(items.slice(0, 20))}`);
  });

  it("completes default-namespace framework types in a DesignInstance type argument", async () => {
    const items = await h.completionItemsAt(page('<Grid d:DataContext="{d:DesignInstance Butt|}" />'));
    const button = items.find((i) => i.label === "Button" && (i.detail || "").includes("Microsoft.UI.Xaml.Controls"));
    assert.ok(button, `expected a Button type item from the default namespace; got ${JSON.stringify(items.slice(0, 20))}`);
  });

  it("offers nothing when the DesignInstance extension prefix is not a design-time namespace", async () => {
    const items = await h.completionItemsAt(page('<Grid d:DataContext="{zzz:DesignInstance local:Smo|}" />'));
    assert.ok(!items.some(isSmokePageType), `a foreign DesignInstance extension prefix must not complete types; got ${JSON.stringify(items.filter(isSmokePageType))}`);
  });

  it("does not treat a second positional argument as a type", async () => {
    const items = await h.completionItemsAt(page('<Grid d:DataContext="{d:DesignInstance local:SmokePage, local:Smo|}" />'));
    assert.ok(!items.some(isSmokePageType), `only the first positional argument is the type; got ${JSON.stringify(items.filter(isSmokePageType))}`);
  });
});

describe("WinUI XAML — XAML intrinsic type completion", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  // A type reference whose prefix resolves to the XAML language namespace offers the intrinsic aliases (x:String, x:Boolean, …). Discriminate on server-only fields: newText is prefix-qualified ("x:String") and detail is the System namespace — VS Code's word-based provider produces neither.
  it("offers prefix-qualified intrinsic aliases in an x:DataType value", async () => {
    const items = await h.completionItemsAt(page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="x:|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>'));
    for (const alias of ["String", "Boolean", "Int32"]) {
      const hit = items.find((i) => i.label === alias && i.newText === `x:${alias}` && i.detail === "System");
      assert.ok(hit, `expected intrinsic ${alias} (newText x:${alias}, detail System); got ${JSON.stringify(items.slice(0, 30))}`);
    }
  });

  it("filters intrinsic aliases by the typed partial", async () => {
    const items = await h.completionItemsAt(page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="x:Str|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>'));
    assert.ok(items.find((i) => i.label === "String" && i.newText === "x:String"), `x:Str| should offer String; got ${JSON.stringify(items.slice(0, 20))}`);
    assert.ok(!items.some((i) => i.label === "Boolean" && i.detail === "System"), `x:Str| must not offer Boolean; got ${JSON.stringify(items.slice(0, 20))}`);
  });

  it("kind-filters TargetType intrinsics to reference types (round 56)", async () => {
    const items = await h.completionItemsAt(page('<Style TargetType="x:|" />'));
    for (const refAlias of ["String", "Object", "Type"]) {
      assert.ok(items.find((i) => i.label === refAlias && i.newText === `x:${refAlias}` && i.detail === "System"), `TargetType="x:|" (class-only) should offer the reference-type intrinsic ${refAlias}; got ${JSON.stringify(items.slice(0, 20))}`);
    }
    for (const valAlias of ["Int32", "Boolean"]) {
      assert.ok(!items.some((i) => i.label === valAlias && i.detail === "System"), `TargetType="x:|" (class-only) must NOT offer the value-type intrinsic ${valAlias}; got ${JSON.stringify(items.slice(0, 20))}`);
    }
  });

  it("keeps value-type intrinsics in kind-permissive sites like {x:Type x:|} (round 56)", async () => {
    const items = await h.completionItemsAt(page('<Button Tag="{x:Type x:|}" />'));
    for (const alias of ["String", "Int32", "Boolean"]) {
      assert.ok(items.find((i) => i.label === alias && i.newText === `x:${alias}` && i.detail === "System"), `{x:Type x:|} (all kinds) must still offer the intrinsic ${alias} incl. value types; got ${JSON.stringify(items.slice(0, 20))}`);
    }
  });

  it("resolves intrinsics by the XAML URI, not the literal x prefix", async () => {
    const buffer = `<Page ${h.NS}\n    xmlns:sys="http://schemas.microsoft.com/winfx/2006/xaml"\n    x:Class="SmokeFixture.SmokePage">\n  <ListView><ListView.ItemTemplate><DataTemplate x:DataType="sys:Str|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>\n</Page>`;
    const items = await h.completionItemsAt(buffer);
    assert.ok(items.find((i) => i.label === "String" && i.newText === "sys:String" && i.detail === "System"), `a custom prefix mapped to the XAML URI should offer sys:String; got ${JSON.stringify(items.slice(0, 20))}`);
  });

  it("does not offer intrinsics under a prefix that does not resolve to the XAML URI", async () => {
    const items = await h.completionItemsAt(page('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="Str|"><TextBlock /></DataTemplate></ListView.ItemTemplate></ListView>'));
    assert.ok(!items.some((i) => i.label === "String" && i.detail === "System"), `an unprefixed (default-namespace) partial must not surface x: intrinsics; got ${JSON.stringify(items.slice(0, 20))}`);
  });
});

describe("WinUI XAML — XAML intrinsic element completion", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  // XAML namespace prefixes offer all intrinsic element aliases. Server newText and detail exclude VS Code word suggestions.
  const res = (inner) => page(`<Page.Resources>\n    ${inner}\n  </Page.Resources>`);
  const isIntrinsic = (i, alias, prefix = "x") => i.label === alias && i.newText === `${prefix}:${alias}` && i.detail === "System";

  it("offers value- and reference-type intrinsic elements under x:", async () => {
    const items = await h.completionItemsAt(res("<x:|"));
    for (const alias of ["String", "Double", "Boolean", "Int32", "Object"]) {
      assert.ok(items.some((i) => isIntrinsic(i, alias)), `expected intrinsic element ${alias} (newText x:${alias}, detail System); got ${JSON.stringify(items.slice(0, 30))}`);
    }
  });

  it("filters intrinsic elements by the typed partial", async () => {
    const items = await h.completionItemsAt(res("<x:Dou|"));
    assert.ok(items.some((i) => isIntrinsic(i, "Double")), `<x:Dou| should offer Double; got ${JSON.stringify(items.slice(0, 20))}`);
    assert.ok(!items.some((i) => i.label === "Int32" && i.detail === "System"), `<x:Dou| must not offer Int32; got ${JSON.stringify(items.slice(0, 20))}`);
  });

  it("resolves intrinsic elements by the XAML URI, not the literal x prefix", async () => {
    const buffer = `<Page ${h.NS}\n    xmlns:sys="http://schemas.microsoft.com/winfx/2006/xaml"\n    x:Class="SmokeFixture.SmokePage">\n  <Page.Resources>\n    <sys:Str|\n  </Page.Resources>\n</Page>`;
    const items = await h.completionItemsAt(buffer);
    assert.ok(items.some((i) => isIntrinsic(i, "String", "sys")), `a custom prefix mapped to the XAML URI should offer sys:String as an element; got ${JSON.stringify(items.slice(0, 20))}`);
  });

  it("does not offer intrinsic elements at an unprefixed (default-namespace) position", async () => {
    const items = await h.completionItemsAt(page("<|"));
    assert.ok(!items.some((i) => i.detail === "System" && ["String", "Int32", "Double", "Boolean"].includes(i.label)), `unprefixed <| must not surface x: intrinsic elements; got ${JSON.stringify(items.slice(0, 30))}`);
  });

  it("filters intrinsic elements out of a typed collection property element by assignability", async () => {
    const items = await h.completionItemsAt(page('<Grid>\n    <Grid.RowDefinitions>\n      <x:|\n    </Grid.RowDefinitions>\n  </Grid>'));
    assert.ok(!items.some((i) => i.detail === "System" && ["String", "Int32", "Double", "Boolean"].includes(i.label)), `<Grid.RowDefinitions><x:| must not offer non-assignable intrinsic elements; got ${JSON.stringify(items.slice(0, 30))}`);
  });
});

describe("WinUI XAML — completion documentation", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  // completionDocsAt reads server-only XML summary documentation, excluding word suggestions.
  const docOf = (items, label) => {
    const it = items.find((i) => i.label === label);
    return it ? it.documentation : "";
  };

  it("framework element item carries the type <summary>", async () => {
    const items = await h.completionDocsAt(page("<But|"));
    const d = docOf(items, "Button");
    assert.ok(d.length > 0, `expected Button item to carry documentation; got ${JSON.stringify(items.find((i) => i.label === "Button"))}`);
    assert.ok(/button/i.test(d), `expected framework <summary> in Button documentation; got ${JSON.stringify(d)}`);
  });

  it("framework property item carries 'Gets or sets' <summary>", async () => {
    const items = await h.completionDocsAt(page("<Button |"));
    assert.ok(/gets or sets/i.test(docOf(items, "Content")), `expected 'Gets or sets ...' in Content documentation; got ${JSON.stringify(docOf(items, "Content"))}`);
  });

  it("framework enum-value item carries the field <summary>, sanitized", async () => {
    const items = await h.completionDocsAt(page('<Button Visibility="|" />'));
    const d = docOf(items, "Collapsed");
    assert.ok(d.length > 0, `expected Visibility.Collapsed item to carry documentation; got ${JSON.stringify(items.find((i) => i.label === "Collapsed"))}`);
    assert.ok(/display/i.test(d), `expected the enum <summary> prose; got ${JSON.stringify(d)}`);
    for (const bad of [":::", "<img", "[!"]) assert.ok(!d.includes(bad), `enum documentation must be sanitized of '${bad}'; got ${JSON.stringify(d)}`);
  });

  it("user source member item carries the source <summary> with simplified see-cref", async () => {
    const items = await h.completionDocsAt(page('<TextBlock Text="{x:Bind Gree|}" />'));
    assert.ok(
      /Greeting sourced from the DI singleton IGreetingService/.test(docOf(items, "GreetingText")),
      `expected user <summary> with <see cref> simplified; got ${JSON.stringify(docOf(items, "GreetingText"))}`
    );
  });

  it("container attached-property item carries the getter <summary>", async () => {
    const items = await h.completionDocsAt(page("<Grid>\n    <Button Grid.|\n  </Grid>"));
    assert.ok(/gets the value/i.test(docOf(items, "Grid.Row")), `expected the attached getter <summary>; got ${JSON.stringify(docOf(items, "Grid.Row"))}`);
  });

  it("synthetic boolean items carry no documentation (purely additive)", async () => {
    const items = await h.completionDocsAt(page('<Button IsEnabled="|" />'));
    // True/False are synthesized, not symbol-bearing, so they are deliberately left undocumented.
    assert.strictEqual(docOf(items, "True"), "", `synthetic True item should have no documentation; got ${JSON.stringify(docOf(items, "True"))}`);
    assert.strictEqual(docOf(items, "False"), "", `synthetic False item should have no documentation; got ${JSON.stringify(docOf(items, "False"))}`);
  });
});

describe("WinUI XAML — x:Bind argument-name documentation", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  // x:Bind arguments reuse Binding property documentation; BindBack uses curated documentation. The server-only documentation field excludes word suggestions.
  const docOf = (items, label) => {
    const it = items.find((i) => i.label === label);
    return it ? it.documentation : "";
  };

  it("x:Bind argument name carries the borrowed Binding property <summary>", async () => {
    const items = await h.completionDocsAt(page('<TextBlock Text="{x:Bind GreetingText, |}" />'));
    assert.ok(/gets or sets/i.test(docOf(items, "Mode")), `expected Binding.Mode <summary> on the x:Bind Mode arg; got ${JSON.stringify(docOf(items, "Mode"))}`);
    assert.ok(/gets or sets/i.test(docOf(items, "Converter")), `expected Binding.Converter <summary> on the x:Bind Converter arg; got ${JSON.stringify(docOf(items, "Converter"))}`);
  });

  it("x:Bind BindBack carries a curated doc (no Binding property to borrow), sanitized", async () => {
    const items = await h.completionDocsAt(page('<TextBlock Text="{x:Bind GreetingText, |}" />'));
    const d = docOf(items, "BindBack");
    assert.ok(d.length > 0 && /back/i.test(d), `expected the curated x:Bind-only BindBack doc; got ${JSON.stringify(d)}`);
    for (const bad of [":::", "<img", "[!", "```"]) assert.ok(!d.includes(bad), `BindBack doc must be clean of '${bad}'; got ${JSON.stringify(d)}`);
  });

  it("x:Bind Mode documentation equals classic Binding Mode documentation (consistency)", async () => {
    const xb = await h.completionDocsAt(page('<TextBlock Text="{x:Bind GreetingText, |}" />'));
    const bn = await h.completionDocsAt(page('<TextBlock Text="{Binding Path=GreetingText, |}" />'));
    const dX = docOf(xb, "Mode");
    const dB = docOf(bn, "Mode");
    assert.ok(dB.length > 0, `classic Binding Mode arg should carry documentation (round 67); got ${JSON.stringify(bn.map((i) => i.label))}`);
    assert.strictEqual(dX, dB, `x:Bind Mode doc must equal classic Binding Mode doc;\n  x:Bind=${JSON.stringify(dX)}\n  Binding=${JSON.stringify(dB)}`);
  });

  it("BindBack is offered for x:Bind but not for classic Binding", async () => {
    const xb = await h.completionDocsAt(page('<TextBlock Text="{x:Bind GreetingText, |}" />'));
    const bn = await h.completionDocsAt(page('<TextBlock Text="{Binding Path=GreetingText, |}" />'));
    assert.ok(xb.some((i) => i.label === "BindBack"), `x:Bind arg names must include BindBack`);
    assert.ok(!bn.some((i) => i.label === "BindBack"), `classic Binding must not offer BindBack (x:Bind-only); got ${JSON.stringify(bn.map((i) => i.label))}`);
  });
});

describe("WinUI XAML — x:Bind argument-name Detail parity", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  // x:Bind arguments reuse Binding property detail; BindBack uses curated method detail.
  const detailOf = (items, label) => { const it = items.find((i) => i.label === label); return it ? (it.detail || "") : ""; };
  const docOf = (items, label) => { const it = items.find((i) => i.label === label); return it ? it.documentation : ""; };

  it("x:Bind arg Detail equals classic Binding arg Detail for every overlapping name", async () => {
    const xb = await h.completionDocsAt(page('<TextBlock Text="{x:Bind GreetingText, |}" />'));
    const bn = await h.completionDocsAt(page('<TextBlock Text="{Binding Path=GreetingText, |}" />'));
    for (const label of ["Mode", "Converter", "ConverterParameter", "ConverterLanguage", "FallbackValue", "TargetNullValue", "UpdateSourceTrigger"]) {
      const db = detailOf(bn, label);
      assert.ok(db.length > 0, `classic Binding ${label} should carry a Detail; got ${JSON.stringify(bn.find((i) => i.label === label))}`);
      assert.strictEqual(detailOf(xb, label), db, `x:Bind ${label} Detail must equal classic Binding; x=${JSON.stringify(detailOf(xb, label))} b=${JSON.stringify(db)}`);
    }
  });

  it("x:Bind Mode Detail reads 'property : <Type>'", async () => {
    const xb = await h.completionDocsAt(page('<TextBlock Text="{x:Bind GreetingText, |}" />'));
    assert.match(detailOf(xb, "Mode"), /property\s*:/i, `expected 'property : <Type>' Detail; got ${JSON.stringify(detailOf(xb, "Mode"))}`);
  });

  it("BindBack carries the curated 'method' Detail (no Binding property to borrow)", async () => {
    const xb = await h.completionDocsAt(page('<TextBlock Text="{x:Bind GreetingText, |}" />'));
    assert.strictEqual(detailOf(xb, "BindBack"), "method", `expected curated BindBack Detail; got ${JSON.stringify(detailOf(xb, "BindBack"))}`);
  });

  it("adding Detail does not drop the round-68 documentation", async () => {
    const xb = await h.completionDocsAt(page('<TextBlock Text="{x:Bind GreetingText, |}" />'));
    assert.ok(/gets or sets/i.test(docOf(xb, "Mode")), `Mode documentation must remain; got ${JSON.stringify(docOf(xb, "Mode"))}`);
    assert.ok(/back/i.test(docOf(xb, "BindBack")), `BindBack documentation must remain; got ${JSON.stringify(docOf(xb, "BindBack"))}`);
  });
});

describe("WinUI XAML — definition (F12)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("event handler -> code-behind method", async () => {
    const defs = await h.definitionsAt(page('<Button Click="OnGo_Cl|ick" />'));
    assert.ok(defs.length > 0, "expected a definition");
    assert.ok(path.basename(defs[0].fsPath) === CS, `expected ${CS}; got ${defs[0].fsPath}`);
  });

  it("x:Bind path first segment -> code-behind member", async () => {
    const defs = await h.definitionsAt(page('<TextBlock Text="{x:Bind Greeting|Text}" />'));
    assert.ok(defs.length > 0, "expected a definition");
    assert.ok(path.basename(defs[0].fsPath) === CS, `expected ${CS}; got ${defs[0].fsPath}`);
  });

  it("StaticResource key -> x:Key declaration in App.xaml", async () => {
    const defs = await h.definitionsAt(page('<Grid Background="{StaticResource SmokeAccent|Brush}" />'));
    assert.ok(defs.length > 0, "expected a definition");
    assert.ok(path.basename(defs[0].fsPath) === APP, `expected ${APP}; got ${defs[0].fsPath}`);
  });
});

// GridLength values offer Auto and *, while double values do not. Server detail distinguishes Auto from VS Code word suggestions.
describe("WinUI XAML — GridLength value completion", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  const gridLen = (items) => items.filter((i) => (i.detail || "").startsWith("GridLength")).map((i) => i.label).sort();

  it("RowDefinition.Height offers Auto and *", async () => {
    const items = await h.completionItemsAt(page('<Grid>\n    <Grid.RowDefinitions>\n      <RowDefinition Height="|" />\n    </Grid.RowDefinitions>\n  </Grid>'));
    assert.deepStrictEqual(gridLen(items), ["*", "Auto"], `expected Auto and * for GridLength; got: ${JSON.stringify(items.map((i) => i.label))}`);
    const auto = items.find((i) => i.label === "Auto" && (i.detail || "").startsWith("GridLength"));
    assert.strictEqual(auto.newText, "Auto", `Auto should carry a whole-token TextEdit; got: ${JSON.stringify(auto)}`);
  });

  it("ColumnDefinition.Width offers Auto and *", async () => {
    const items = await h.completionItemsAt(page('<Grid>\n    <Grid.ColumnDefinitions>\n      <ColumnDefinition Width="|" />\n    </Grid.ColumnDefinitions>\n  </Grid>'));
    assert.deepStrictEqual(gridLen(items), ["*", "Auto"], `expected Auto and * for GridLength; got: ${JSON.stringify(items.map((i) => i.label))}`);
  });

  it("prefix 'A' filters to Auto only", async () => {
    const items = await h.completionItemsAt(page('<Grid>\n    <Grid.RowDefinitions>\n      <RowDefinition Height="A|" />\n    </Grid.RowDefinitions>\n  </Grid>'));
    assert.deepStrictEqual(gridLen(items), ["Auto"], `expected only Auto; got: ${JSON.stringify(items.map((i) => i.label))}`);
  });

  it("a double Width (FrameworkElement) offers no GridLength keywords", async () => {
    const items = await h.completionItemsAt(page('<Button Width="|" />'));
    assert.deepStrictEqual(gridLen(items), [], `a double Width must not offer GridLength keywords; got: ${JSON.stringify(items.map((i) => i.label))}`);
  });
});

describe("WinUI XAML — named-color value completion", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  const isNamedColor = (d) => d === "named color";
  const colorLabels = (items) => items.filter((i) => isNamedColor(i.detail)).map((i) => i.label);

  it("Foreground (Brush) offers the WinUI named colors with hex swatches", async () => {
    const items = await h.completionItemsAt(page('<TextBlock Foreground="|" />'));
    const labels = colorLabels(items);
    assert.ok(labels.length >= 100, `expected the full named-color set; got ${labels.length}`);
    for (const want of ["Red", "CornflowerBlue", "Transparent"]) {
      assert.ok(labels.includes(want), `named colors should include ${want}; got ${labels.length} items`);
    }
    const cfb = items.find((i) => i.label === "CornflowerBlue" && isNamedColor(i.detail));
    assert.strictEqual(cfb.detail, "named color");
    assert.strictEqual(cfb.newText, "CornflowerBlue", `CornflowerBlue should carry a whole-token TextEdit; got ${JSON.stringify(cfb.newText)}`);
    const tr = items.find((i) => i.label === "Transparent" && isNamedColor(i.detail));
    assert.strictEqual(tr.detail, "named color");
  });

  it("prefix 'Corn' filters to CornflowerBlue + Cornsilk", async () => {
    const items = await h.completionItemsAt(page('<TextBlock Foreground="Corn|" />'));
    assert.deepStrictEqual(colorLabels(items).sort(), ["CornflowerBlue", "Cornsilk"], `expected Cornflower*/Cornsilk; got: ${JSON.stringify(colorLabels(items))}`);
  });

  it("Background (Brush) offers named colors too", async () => {
    const items = await h.completionItemsAt(page('<Grid Background="|" />'));
    assert.ok(colorLabels(items).includes("Red"), `Background (Brush) should offer named colors incl. Red`);
  });

  it("SolidColorBrush.Color (Windows.UI.Color) offers named colors via IsColor", async () => {
    const items = await h.completionItemsAt(page('<Grid>\n    <Grid.Background>\n      <SolidColorBrush Color="|" />\n    </Grid.Background>\n  </Grid>'));
    assert.ok(colorLabels(items).includes("CornflowerBlue"), `SolidColorBrush.Color should offer named colors incl. CornflowerBlue`);
  });

  it("a double Width and an enum Visibility offer no named colors", async () => {
    const dbl = await h.completionItemsAt(page('<Button Width="|" />'));
    assert.deepStrictEqual(colorLabels(dbl), [], `a double Width must not offer named colors; got: ${JSON.stringify(colorLabels(dbl))}`);
    const en = await h.completionItemsAt(page('<Button Visibility="|" />'));
    assert.deepStrictEqual(colorLabels(en), [], `an enum Visibility must not leak named colors; got: ${JSON.stringify(colorLabels(en))}`);
  });
});

describe("WinUI XAML — FontWeight value completion", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  const isWeight = (d) => d === "font weight";
  const weightLabels = (items) => items.filter((i) => isWeight(i.detail)).map((i) => i.label);

  it("TextBlock.FontWeight offers the WinUI named weights with weight-number details", async () => {
    const items = await h.completionItemsAt(page('<TextBlock FontWeight="|" />'));
    const labels = weightLabels(items).sort();
    const want = ["Black", "Bold", "ExtraBlack", "ExtraBold", "ExtraLight", "Light", "Medium", "Normal", "SemiBold", "SemiLight", "Thin"];
    assert.deepStrictEqual(labels, want, `expected exactly the 11 named weights; got ${JSON.stringify(labels)}`);
    const bold = items.find((i) => i.label === "Bold" && isWeight(i.detail));
    assert.strictEqual(bold.detail, "font weight");
    assert.strictEqual(bold.newText, "Bold", `Bold should carry a whole-token TextEdit; got ${JSON.stringify(bold.newText)}`);
    const sl = items.find((i) => i.label === "SemiLight" && isWeight(i.detail));
    assert.strictEqual(sl.detail, "font weight");
  });

  it("prefix 'Ex' filters to the three Extra* weights", async () => {
    const items = await h.completionItemsAt(page('<TextBlock FontWeight="Ex|" />'));
    assert.deepStrictEqual(weightLabels(items).sort(), ["ExtraBlack", "ExtraBold", "ExtraLight"], `expected the Extra* weights; got: ${JSON.stringify(weightLabels(items))}`);
  });

  it("Button.FontWeight (Control base property) offers named weights too", async () => {
    const items = await h.completionItemsAt(page('<Button FontWeight="|" />'));
    assert.ok(weightLabels(items).includes("SemiBold"), `Button.FontWeight should offer named weights incl. SemiBold`);
  });

  it("a double Width and an enum Visibility offer no named weights", async () => {
    const dbl = await h.completionItemsAt(page('<Button Width="|" />'));
    assert.deepStrictEqual(weightLabels(dbl), [], `a double Width must not offer named weights; got: ${JSON.stringify(weightLabels(dbl))}`);
    const en = await h.completionItemsAt(page('<Button Visibility="|" />'));
    assert.deepStrictEqual(weightLabels(en), [], `an enum Visibility must not leak named weights; got: ${JSON.stringify(weightLabels(en))}`);
  });

  it("Style Setter.Value completes FontWeight like a direct attribute", async () => {
    // A Style setter typed by its sibling Property= completes the value identically to setting it directly.
    const styleBuf = (setter) =>
      `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  <Page.Resources>\n    <Style TargetType="TextBlock">\n      ${setter}\n    </Style>\n  </Page.Resources>\n</Page>`;
    const items = await h.completionItemsAt(styleBuf('<Setter Property="FontWeight" Value="|" />'));
    const labels = weightLabels(items);
    assert.ok(labels.includes("Bold") && labels.includes("SemiBold"), `Setter.Value FontWeight should offer named weights incl. Bold/SemiBold; got ${JSON.stringify(labels)}`);
    const bold = items.find((i) => i.label === "Bold" && isWeight(i.detail));
    assert.strictEqual(bold.detail, "font weight");
    const dbl = await h.completionItemsAt(styleBuf('<Setter Property="Opacity" Value="|" />'));
    assert.deepStrictEqual(weightLabels(dbl), [], `a double Setter.Value must not offer named weights; got ${JSON.stringify(weightLabels(dbl))}`);
  });
});

describe("WinUI XAML — hover", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("element name -> type", async () => {
    const md = await h.hoverAt(page("<Butt|on />"));
    assert.ok(/Button/.test(md), `expected Button in hover; got: ${md}`);
  });

  it("attribute name -> member", async () => {
    const md = await h.hoverAt(page('<Button Cont|ent="x" />'));
    assert.ok(/Content/.test(md), `expected Content in hover; got: ${md}`);
  });

  for (const [directive, description] of [
    ["Class", /CLR class/i],
    ["Name", /namescope/i],
    ["Key", /resource dictionary/i],
    ["DataType", /compile bindings/i],
    ["Load", /visual tree/i],
  ]) {
    it(`x:${directive} has directive quick info`, async () => {
      const md = await h.hoverAt(
        `<Page xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"\n` +
        `      xmlns:language="http://schemas.microsoft.com/winfx/2006/xaml"\n` +
        `      language:${directive.slice(0, 2)}|${directive.slice(2)}="value" />`
      );
      assert.match(md, description);
    });
  }

  it("mc:Ignorable resolves through an alternate prefix", async () => {
    const md = await h.hoverAt(
      `<Page xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"\n` +
      `      xmlns:compat="http://schemas.openxmlformats.org/markup-compatibility/2006"\n` +
      `      compat:Ign|orable="design" />`
    );
    assert.match(md, /mc:Ignorable[\s\S]+namespace prefixes/i);
  });

  it("resource reference -> type + source", async () => {
    const md = await h.hoverMatchingAt(
      page('<Grid Background="{StaticResource SmokeAccent|Brush}" />'),
      (value) => /SolidColorBrush/.test(value) && /App\.xaml/.test(value)
    );
    assert.ok(/SmokeAccentBrush/.test(md), "expected the key name");
    assert.ok(/SolidColorBrush/.test(md), "expected the resource type");
    assert.ok(/App\.xaml/.test(md), "expected the declaring file");
  });

  // summaryOf isolates XML summary text after the signature fence.
  const summaryOf = (md) => (md.split("```")[2] || "").trim();

  it("element type hover carries the framework <summary>", async () => {
    const md = await h.hoverMatchingAt(page("<Butt|on />"), (value) => /class/.test(value));
    assert.ok(/class/.test(md), `expected a class signature; got: ${md}`);
    assert.ok(/button/i.test(summaryOf(md)), `expected framework <summary> below the fence; got: ${md}`);
  });

  it("property hover carries the framework <summary>", async () => {
    const md = await h.hoverMatchingAt(
      page('<Button Cont|ent="x" />'),
      (value) => /gets or sets/i.test(summaryOf(value))
    );
    assert.ok(/gets or sets/i.test(summaryOf(md)), `expected 'Gets or sets ...' <summary>; got: ${md}`);
  });

  it("user member hover carries the source <summary> with simplified see-cref", async () => {
    const md = await h.hoverMatchingAt(
      page('<TextBlock Text="{x:Bind Greet|ingText}" />'),
      (value) => /Greeting sourced from the DI singleton IGreetingService/.test(summaryOf(value))
    );
    assert.ok(/GreetingText/.test(md), `expected the member signature; got: ${md}`);
    assert.ok(
      /Greeting sourced from the DI singleton IGreetingService/.test(summaryOf(md)),
      `expected the user <summary> with <see cref> simplified to 'IGreetingService'; got: ${md}`
    );
  });

  it("attached-property hover carries the getter <summary>", async () => {
    const md = await h.hoverMatchingAt(
      page("<Grid><Button Grid.Ro|w=\"0\" /></Grid>"),
      (value) => /\(attached property\)/.test(value)
    );
    assert.ok(/\(attached property\)/.test(md), `expected the attached-property signature; got: ${md}`);
    assert.ok(/gets the value/i.test(summaryOf(md)), `expected the getter <summary>; got: ${md}`);
  });
});

// Method hovers include returns and parameters; other symbols remain summary-only.
describe("WinUI XAML — method hover returns/params", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("framework method hover shows Returns and Parameters", async () => {
    const md = await h.hoverAt(page('<TextBlock Text="{x:Bind Find|Name}" />'));
    assert.ok(/FrameworkElement\.FindName\(string name\)/.test(md), `expected the method signature; got: ${md}`);
    assert.ok(/\*\*Returns:\*\*/.test(md), `expected a Returns section; got: ${md}`);
    assert.ok(/\*\*Parameters:\*\*/.test(md), `expected a Parameters section; got: ${md}`);
    assert.ok(/`name`/.test(md), `expected the 'name' param documented; got: ${md}`);
  });

  it("framework member method (string segment) is enriched too", async () => {
    const md = await h.hoverAt(page('<TextBlock Text="{x:Bind GreetingText.Subs|tring}" />'));
    assert.ok(/string\.Substring\(int startIndex\)/.test(md), `expected the method signature; got: ${md}`);
    assert.ok(/\*\*Returns:\*\*/.test(md), `expected a Returns section; got: ${md}`);
    assert.ok(/`startIndex`/.test(md), `expected the 'startIndex' param documented; got: ${md}`);
  });

  it("undocumented user method gets a deterministic metadata description", async () => {
    const md = await h.hoverAt(page('<TextBlock Text="{x:Bind OnGo_C|lick()}" />'));
    assert.ok(/OnGo_Click\(object sender, RoutedEventArgs e\)/.test(md), `expected the method signature; got: ${md}`);
    assert.ok(/Method `OnGo_Click` declared by/.test(md), `expected the metadata fallback; got: ${md}`);
    assert.ok(!/\*\*Returns:\*\*/.test(md), `undocumented method must NOT carry Returns; got: ${md}`);
    assert.ok(!/\*\*Parameters:\*\*/.test(md), `undocumented method must NOT carry Parameters; got: ${md}`);
  });

  it("attached-property hover is not enriched with getter method details", async () => {
    const md = await h.hoverAt(page("<Grid><Button Grid.Ro|w=\"1\" /></Grid>"));
    assert.ok(/\(attached property\)/.test(md), `expected the attached-property signature; got: ${md}`);
    assert.ok(!/\*\*Returns:\*\*/.test(md), `attached-property hover must NOT carry Returns; got: ${md}`);
    assert.ok(!/\*\*Parameters:\*\*/.test(md), `attached-property hover must NOT carry Parameters; got: ${md}`);
  });
});
