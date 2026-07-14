"use strict";

// Comprehensive feature coverage driven through the REAL VS Code language APIs (completion,
// definition, hover, document symbols, diagnostics). Mirrors the stdio smoke test but exercises the
// full client↔server round trip a user hits while editing. Assertions favor presence/absence over
// exact counts because VS Code merges in word-based suggestions.

const assert = require("node:assert");
const path = require("node:path");
const h = require("./helper");

const CS = "SmokePage.xaml.cs";
const APP = "App.xaml";

// A <Page> header with x:Class so the server resolves the real SmokeFixture project (types,
// x:Bind targets, event handlers, App.xaml resources).
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
    // The enum type name is the server item detail; filtering on it isolates the server's enum members
    // from any VS Code word-based suggestions. UpdateSourceTrigger has no reflectable x:Bind extension type,
    // so this exercises the curated enum fallback map (sibling of the Mode= fallback).
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
    // The fallback is gated to compiled-binding extensions; a bogus same-named argument on a non-binding
    // extension must not borrow BindingMode/UpdateSourceTrigger. Filter on the enum-type detail (server-only).
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
    // Background is a Brush: the project's own App.xaml key is always offered, a framework theme BRUSH
    // key is offered, and a framework Style key (TitleTextBlockStyle) is filtered out by type.
    const brushItems = await h.completionsAt(page('<Grid Background="{StaticResource |}" />'));
    assert.ok(brushItems.includes("SmokeAccentBrush"), "expected project key SmokeAccentBrush from App.xaml");
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

  it("Storyboard.TargetProperty parenthesized (Owner.Property) qualifiers complete the explicit owner's members (round 77)", async () => {
    // A parenthesized (Type.Property) qualifier names its owner type EXPLICITLY, so completion roots at
    // that type (instance DP + attached), independently of Storyboard.TargetName — VS parity.
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
    // The HIDDEN key's name is literally in the buffer, so VS Code word-merges a label for it regardless —
    // discriminate on the SERVER-ONLY detail "resource" to prove the server actually offered (or hid) it.
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
    // A <Setter Value="{StaticResource |}"> is declared 'object' but VS scopes it to the property the
    // sibling Property= names on the enclosing TargetType — so a Foreground setter offers theme BRUSH
    // keys, hides a theme Style key, and still always offers the project's own App.xaml key.
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

    // A Setter with NO resolvable Property= still offers every theme key (round-74 offer-all preserved).
    const noProp = await h.completionsAt(page([
      '<Page.Resources>',
      '  <Style TargetType="Button">',
      '    <Setter Value="{StaticResource |}" />',
      '  </Style>',
      '</Page.Resources>',
    ].join("\n  ")));
    assert.ok(
      noProp.some((i) => i === "TitleTextBlockStyle") && noProp.some((i) => i.includes("AccentFillColorDefaultBrush")),
      `Setter.Value with no Property must offer ALL theme keys; got ${noProp.slice(0, 20).join(", ")}`
    );
  });
});

describe("WinUI XAML — closing-tag completion", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  // Our close-tag item is uniquely identified by detail === "Closing tag", so VS Code's built-in
  // word-based suggestions (which can also surface "Grid") never confound these assertions.
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

  // Source namespaces carry detail "CLR namespace"; referenced-assembly namespaces detail
  // "CLR namespace (referenced)". Filtering by detail isolates each group from VS Code's built-in
  // word-based suggestions. A fresh prefix (zzz) is used so it does not collide with h.NS-declared 'local'.
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

  // Each xmlns-value item carries a distinctive server detail; filtering by that set isolates the
  // server's suggestions from VS Code's built-in word-based ones (though the URIs, containing "://",
  // are already word-merge-safe). A fresh prefix (zzz) avoids colliding with h.NS-declared 'local'.
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

  // Element-name items carry a server detail beginning "(element)". VS Code also word-suggests the names
  // (they are literally in the buffer), so every assertion filters on that detail to isolate server output.
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

  // Container attached-property items carry a server detail beginning "attached property". Full dotted labels
  // (Grid.Row) are not a single VS Code word, but we still filter on the server detail to isolate server output.
  const ap = (items) => items.filter((i) => i.detail && i.detail.startsWith("attached property"));
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

  // A container whose content type is a known concrete class narrows the element-name completion to
  // assignable children (VS parity): a Grid/Border child position offers only UIElement-derived types and
  // filters out non-UI types (VisualStateManager, RoutedEventArgs, DataTemplate, Style). None of the asserted
  // type names appear literally in the probe buffer, so a present/absent assertion reflects the server alone
  // (VS Code word-based suggestions can only surface words already in the document).
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

  // Accepting an attribute name that is NOT already followed by '=' appends a ="$0" snippet so the caret lands
  // inside fresh quotes (VS parity). VS Code exposes the snippet as insertText.value; helper.completionItemsAt
  // reads it into newText. Discriminate on the server-set detail so a word-based item (no detail) can never mask
  // the server's newText — critical for the "already has '=' " case where the name is literally in the buffer.
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

  // When the user types `Click=OnGo` WITHOUT quotes and accepts a value completion, the inserted value must
  // be wrapped in quotes to be valid XAML (Click="OnGo_Click", not Click=OnGo_Click). This applies uniformly
  // to every value type at an unquoted position (event handlers, enums, bools, colors, type names, …). The
  // wrapping quotes are unforgeable by VS Code word-based suggestions, so the quoted newText is itself a
  // reliable server discriminator; we still find the item by its server-set detail for clarity.
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

  // The offered prefixes (d, dd) are bare tokens that also appear as xmlns prefixes in the buffer, so VS Code
  // word-merges them — filter on the distinctive server detail to isolate the server's suggestions. h.NS already
  // declares d (blend/2008) + mc on the page root; a second design-time prefix (dd -> blend/2006) is declared on
  // the child Grid so the already-listed / multi-token behavior can be exercised.
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

  // Inside a DataTemplate the design-time DataContext is the template's x:DataType, so a classic
  // {Binding} completes THAT type's members (exactly like x:Bind does inside a template). "GreetingText"
  // is never a literal word in these buffers, so VS Code's word-based suggestions cannot confound it.
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
    // Round 76: an ElementName redirect roots the path at the NAMED element's type, so it completes that
    // element's members — overriding the template's x:DataType. GreetingText (a SmokePage member) is never a
    // literal word here, so its absence proves the root is the TextBox, not the x:DataType.
    const inner = '<StackPanel>\n        <TextBox x:Name="Root" />\n        <TextBlock Text="{Binding ElementName=Root, Path=|}" />\n      </StackPanel>';
    const items = await h.completionsAt(template(inner));
    assert.ok(items.includes("IsEnabled"), `expected the named TextBox member IsEnabled; got ${items.join(", ")}`);
    assert.ok(!items.includes("GreetingText"), `ElementName must root at the named element, not the template x:DataType; got ${items.join(", ")}`);
  });

  it("completes a named element's members via ElementName= at the page root", async () => {
    // At the page root a classic {Binding} normally offers nothing (DataContext type unknown), but an
    // ElementName redirect roots it at the named element's type — the core round-76 win.
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

  // An ancestor's d:DataContext="{d:DesignInstance ...}" is a design-time hint (stripped at runtime by
  // mc:Ignorable="d") that tells the editor the page-level DataContext type, so a classic {Binding}
  // completes that type's members even outside a DataTemplate. h.NS already declares the d + local prefixes.
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

  // Round 54: authoring the x:DataType value itself gets type-name completion (like TargetType).
  // "SmokePage" appears literally in the buffer (x:Class), so a word-based suggestion could match its
  // label — discriminate on our item's newText (the prefix-qualified "local:SmokePage" insert) / detail
  // (the containing namespace), which VS Code's word-based provider never produces.
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

  // Authoring counterpart to the design-time {Binding} rooting above: the {d:DesignInstance …} TYPE
  // argument (positional or Type=) gets type-name completion. "SmokePage" appears literally in the buffer
  // (x:Class), so — like the x:DataType probes — discriminate on our item's newText (the prefix-qualified
  // "local:SmokePage" insert) / detail (the namespace), which VS Code's word-based provider never produces.
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

  // A type reference whose prefix resolves to the XAML language namespace offers the intrinsic aliases
  // (x:String, x:Boolean, …). Discriminate on server-only fields: newText is prefix-qualified ("x:String")
  // and detail is the System namespace — VS Code's word-based provider produces neither.
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

  // The element-name counterpart to the type-reference intrinsics above: a start tag whose prefix resolves
  // to the XAML language namespace offers the intrinsic aliases as ELEMENTS (<x:String>, <x:Double>, …).
  // Unlike the class-only CLR element list, ALL 14 are offered — XAML instantiates the value-type
  // intrinsics as elements. Discriminate on server-only fields: newText is prefix-qualified ("x:String")
  // and detail is System, neither of which VS Code's word-based provider produces.
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

  // Round 67: symbol-bearing completion items now carry the member's XML-doc <summary> as their
  // Documentation flyout (VS parity — the details pane beside the popup), reusing the round-66
  // XmlDocSummary engine (summary PROSE only, no signature fence). Assertions read the SERVER-ONLY
  // documentation field via completionDocsAt so buffer word-based suggestions can never confound them.
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

  // Round 68: the curated {x:Bind} named-argument list (Mode/Converter/.../UpdateSourceTrigger + BindBack)
  // previously carried NO documentation, while the classic {Binding} arg names ARE documented (round 67).
  // Round 68 resolves each curated name to its Microsoft.UI.Xaml.Data.Binding property symbol and reuses
  // CompletionDoc, so x:Bind arg names read IDENTICALLY to classic Binding; BindBack (x:Bind-only) gets a
  // curated doc. Assertions read the SERVER-ONLY documentation field so word-based suggestions never confound.
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

  // Round 69 (follow-on to round 68): the curated {x:Bind} arg names now ALSO carry the same Detail (the
  // dimmed "property : Type" type-hint header) that the classic {Binding} arg name shows, off the SAME
  // resolved Binding member — so both the popup header (Detail) and body (Documentation) reach parity.
  // BindBack (x:Bind-only) gets a small curated "method" detail. Assertions read the server-only detail field.
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

// Round 71: a GridLength-typed attribute value (RowDefinition.Height, ColumnDefinition.Width) offers the two
// keyword sizings VS/Blend surface — Auto and *. A 'double' Width/Height (FrameworkElement) offers neither.
// Tests discriminate on the SERVER `detail` (startsWith "GridLength") so VS Code word-based suggestions can't
// confound the assertions (the bare "Auto" token in particular).
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

  // Discriminate on the hex `detail` (a swatch like #6495ED) — color NAMES like "Red" can also come
  // from VS Code's buffer word-based suggestions, so the hex detail is the reliable server marker.
  const isHex = (d) => /^#[0-9A-Fa-f]{6,8}$/.test(d || "");
  const colorLabels = (items) => items.filter((i) => isHex(i.detail)).map((i) => i.label);

  it("Foreground (Brush) offers the WinUI named colors with hex swatches", async () => {
    const items = await h.completionItemsAt(page('<TextBlock Foreground="|" />'));
    const labels = colorLabels(items);
    assert.ok(labels.length >= 100, `expected the full named-color set; got ${labels.length}`);
    for (const want of ["Red", "CornflowerBlue", "Transparent"]) {
      assert.ok(labels.includes(want), `named colors should include ${want}; got ${labels.length} items`);
    }
    const cfb = items.find((i) => i.label === "CornflowerBlue" && isHex(i.detail));
    assert.strictEqual(cfb.detail, "#6495ED", `CornflowerBlue detail should be its hex swatch; got ${JSON.stringify(cfb.detail)}`);
    assert.strictEqual(cfb.newText, "CornflowerBlue", `CornflowerBlue should carry a whole-token TextEdit; got ${JSON.stringify(cfb.newText)}`);
    const tr = items.find((i) => i.label === "Transparent" && isHex(i.detail));
    assert.strictEqual(tr.detail, "#FFFFFF00", `Transparent detail should be CSS alpha-last #FFFFFF00; got ${JSON.stringify(tr.detail)}`);
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

  // Discriminate on the numeric weight `detail` (e.g. "700") — weight NAMES like "Bold"/"Normal" can also
  // come from VS Code's buffer word-based suggestions, so the number detail is the reliable server marker.
  const isWeight = (d) => /^\d{2,3}$/.test(d || "");
  const weightLabels = (items) => items.filter((i) => isWeight(i.detail)).map((i) => i.label);

  it("TextBlock.FontWeight offers the WinUI named weights with weight-number details", async () => {
    const items = await h.completionItemsAt(page('<TextBlock FontWeight="|" />'));
    const labels = weightLabels(items).sort();
    const want = ["Black", "Bold", "ExtraBlack", "ExtraBold", "ExtraLight", "Light", "Medium", "Normal", "SemiBold", "SemiLight", "Thin"];
    assert.deepStrictEqual(labels, want, `expected exactly the 11 named weights; got ${JSON.stringify(labels)}`);
    const bold = items.find((i) => i.label === "Bold" && isWeight(i.detail));
    assert.strictEqual(bold.detail, "700", `Bold detail should be its weight number 700; got ${JSON.stringify(bold.detail)}`);
    assert.strictEqual(bold.newText, "Bold", `Bold should carry a whole-token TextEdit; got ${JSON.stringify(bold.newText)}`);
    const sl = items.find((i) => i.label === "SemiLight" && isWeight(i.detail));
    assert.strictEqual(sl.detail, "350", `SemiLight detail should be 350; got ${JSON.stringify(sl.detail)}`);
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
    assert.strictEqual(bold.detail, "700", `Setter.Value Bold detail should be 700; got ${JSON.stringify(bold.detail)}`);
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

  it("resource reference -> type + source", async () => {
    const md = await h.hoverAt(page('<Grid Background="{StaticResource SmokeAccent|Brush}" />'));
    assert.ok(/SmokeAccentBrush/.test(md), "expected the key name");
    assert.ok(/SolidColorBrush/.test(md), "expected the resource type");
    assert.ok(/App\.xaml/.test(md), "expected the declaring file");
  });

  // Round 66: symbol-based hovers append the member's XML-doc <summary> as quick-info. summaryOf isolates
  // the text AFTER the signature code fence, so each assertion proves the SUMMARY (not the signature) landed.
  const summaryOf = (md) => (md.split("```")[2] || "").trim();

  it("element type hover carries the framework <summary>", async () => {
    const md = await h.hoverAt(page("<Butt|on />"));
    assert.ok(/class/.test(md), `expected a class signature; got: ${md}`);
    assert.ok(/button/i.test(summaryOf(md)), `expected framework <summary> below the fence; got: ${md}`);
  });

  it("property hover carries the framework <summary>", async () => {
    const md = await h.hoverAt(page('<Button Cont|ent="x" />'));
    assert.ok(/gets or sets/i.test(summaryOf(md)), `expected 'Gets or sets ...' <summary>; got: ${md}`);
  });

  it("user member hover carries the source <summary> with simplified see-cref", async () => {
    const md = await h.hoverAt(page('<TextBlock Text="{x:Bind Greet|ingText}" />'));
    assert.ok(/GreetingText/.test(md), `expected the member signature; got: ${md}`);
    assert.ok(
      /Greeting sourced from the DI singleton IGreetingService/.test(summaryOf(md)),
      `expected the user <summary> with <see cref> simplified to 'IGreetingService'; got: ${md}`
    );
  });

  it("attached-property hover carries the getter <summary>", async () => {
    const md = await h.hoverAt(page("<Grid><Button Grid.Ro|w=\"0\" /></Grid>"));
    assert.ok(/\(attached property\)/.test(md), `expected the attached-property signature; got: ${md}`);
    assert.ok(/gets the value/i.test(summaryOf(md)), `expected the getter <summary>; got: ${md}`);
  });
});

// Round 70: a hover on a METHOD symbol appends the member's <returns> and documented <param>s below the
// summary (VS quick-info parity). Gated to IMethodSymbol, so properties/types/enums stay summary-only; and
// attached-property getters (presented AS a property, methodDetails:false) are NOT enriched.
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

  it("undocumented user method stays signature-only (no phantom sections)", async () => {
    const md = await h.hoverAt(page('<TextBlock Text="{x:Bind OnGo_C|lick()}" />'));
    assert.ok(/OnGo_Click\(object sender, RoutedEventArgs e\)/.test(md), `expected the method signature; got: ${md}`);
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

describe("WinUI XAML — document symbols", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("returns the element tree with x:Name annotations", async () => {
    const syms = await h.symbolsAt(page('<Grid>\n    <Button x:Name="GoButton" />\n  </Grid>'));
    const names = h.flattenSymbols(syms);
    assert.ok(names.some((n) => /Page/.test(n)), `expected Page; got ${names.join(", ")}`);
    assert.ok(names.some((n) => /Grid/.test(n)), "expected Grid");
    assert.ok(names.some((n) => /Button/.test(n) && /GoButton/.test(n)), `expected Button (GoButton); got ${names.join(", ")}`);
  });
});

describe("WinUI XAML — diagnostics", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("flags an unknown element in a known namespace", async () => {
    const diags = await h.diagnosticsFor(
      page("<Buton />"),
      (d) => d.some((x) => /Buton/.test(x.message))
    );
    const hit = diags.find((x) => /Buton/.test(x.message));
    assert.ok(hit, `expected a diagnostic mentioning Buton; got ${JSON.stringify(diags.map((d) => d.message))}`);
  });

  it("reports no diagnostics for valid markup", async () => {
    // Wait for the server to (re)publish an empty set — the previous probe's diagnostics linger
    // until this buffer's didChange is processed.
    const diags = await h.diagnosticsFor(page('<Button Content="Hi" />'), (d) => d.length === 0, 8000);
    assert.deepStrictEqual(
      diags.map((d) => `${d.code}:${d.message}`),
      [],
      "expected zero diagnostics for valid markup"
    );
  });
});

describe("WinUI XAML — references (Shift+F12)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  // A self-contained page: one x:Name declaration + an ElementName usage + a Storyboard.TargetName usage.
  function namePage(caretMarkup) {
    return (
      `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n` +
      `  <StackPanel>\n` +
      `    <Button ${caretMarkup} Content="Go" />\n` +
      `    <TextBlock Text="{Binding ElementName=GoButton}" />\n` +
      `    <Storyboard>\n` +
      `      <DoubleAnimation Storyboard.TargetName="GoButton" Storyboard.TargetProperty="Opacity" />\n` +
      `    </Storyboard>\n` +
      `  </StackPanel>\n</Page>`
    );
  }

  it("finds all x:Name references from the declaration (declaration + usages)", async () => {
    const refs = await h.referencesAt(namePage('x:Name="Go|Button"'));
    assert.strictEqual(refs.length, 3, `expected 3 references; got ${refs.length}: ${JSON.stringify(refs.map((r) => r.text))}`);
    assert.ok(refs.every((r) => r.text === "GoButton"), `all refs should read 'GoButton'; got ${JSON.stringify(refs.map((r) => r.text))}`);
  });

  it("finds all x:Name references from an ElementName usage", async () => {
    const refs = await h.referencesAt(
      namePage('x:Name="GoButton"').replace("ElementName=GoButton}", "ElementName=GoBut|ton}")
    );
    assert.ok(refs.length >= 2, `expected at least the 2 usages; got ${refs.length}`);
    assert.ok(refs.every((r) => r.text === "GoButton"), `all refs should read 'GoButton'; got ${JSON.stringify(refs.map((r) => r.text))}`);
  });

  it("finds all resource-key references from the x:Key declaration", async () => {
    const buf =
      `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n` +
      `  <Page.Resources>\n` +
      `    <SolidColorBrush x:Key="Bru|sh1" Color="Red" />\n` +
      `  </Page.Resources>\n` +
      `  <StackPanel>\n` +
      `    <Border Background="{StaticResource Brush1}" />\n` +
      `    <Border Background="{ThemeResource Brush1}" />\n` +
      `  </StackPanel>\n</Page>`;
    const refs = await h.referencesAt(buf);
    assert.strictEqual(refs.length, 3, `expected 3 references; got ${refs.length}: ${JSON.stringify(refs.map((r) => r.text))}`);
    assert.ok(refs.every((r) => r.text === "Brush1"), `all refs should read 'Brush1'; got ${JSON.stringify(refs.map((r) => r.text))}`);
  });

  it("returns nothing when the caret is not on a reference", async () => {
    const refs = await h.referencesAt(namePage('x:Name="GoButton"').replace("<StackPanel>", "<StackPa|nel>"));
    assert.strictEqual(refs.length, 0, `expected 0 references on a plain element tag; got ${JSON.stringify(refs.map((r) => r.text))}`);
  });

  it("finds resource-key references across project files (App.xaml declaration + other pages)", async () => {
    // SmokeAccentBrush is DECLARED in App.xaml and USED in SmokePage + DiPage. A single usage in the open
    // buffer must resolve to references project-wide (read-only), spanning three files, with no bin/obj copy.
    const buf =
      `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n` +
      `  <StackPanel>\n` +
      `    <Border Background="{StaticResource Smoke|AccentBrush}" />\n` +
      `  </StackPanel>\n</Page>`;
    const refs = await h.referencesAt(buf);
    const endsWith = (needle) => refs.filter((r) => r.fsPath.toLowerCase().endsWith(needle)).length;
    assert.ok(
      !refs.some((r) => /[\\/]obj[\\/]/i.test(r.fsPath)),
      `references must not include build-output (obj) copies; got ${JSON.stringify(refs.map((r) => r.fsPath))}`
    );
    assert.strictEqual(refs.length, 3, `expected 3 cross-file references; got ${refs.length}: ${JSON.stringify(refs.map((r) => r.fsPath))}`);
    assert.strictEqual(endsWith("app.xaml"), 1, `expected the App.xaml declaration; got ${JSON.stringify(refs.map((r) => r.fsPath))}`);
    assert.strictEqual(endsWith("dipage.xaml"), 1, `expected the DiPage usage; got ${JSON.stringify(refs.map((r) => r.fsPath))}`);
    assert.strictEqual(endsWith("smokepage.xaml"), 1, `expected the open-buffer usage; got ${JSON.stringify(refs.map((r) => r.fsPath))}`);
  });
});

describe("WinUI XAML — RelativePanel + Setter.Target element references", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  // Round 80: F12 / references / rename now recognize RelativePanel alignment attached properties (bare-name,
  // like Storyboard.TargetName) AND VSM <Setter Target="Element.Property"> (only the pre-dot element segment)
  // as x:Name references — so renaming an x:Name no longer silently leaves these dangling.

  it("navigates F12 from a RelativePanel.RightOf value to the x:Name declaration", async () => {
    const buf =
      `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n` +
      `  <RelativePanel>\n` +
      `    <TextBox x:Name="Anchor" />\n` +
      `    <Button RelativePanel.RightOf="An|chor" />\n` +
      `  </RelativePanel>\n</Page>`;
    // The multi-line h.NS header shifts line numbers, so locate the declaration line dynamically.
    const declLine = buf.replaceAll("|", "").split("\n").findIndex((l) => l.includes('x:Name="Anchor"'));
    const defs = await h.definitionsAt(buf);
    assert.ok(defs.some((d) => d.line === declLine), `expected the x:Name="Anchor" decl on line ${declLine}; got ${JSON.stringify(defs)}`);
  });

  it("finds all RelativePanel alignment references from the x:Name declaration", async () => {
    const buf =
      `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n` +
      `  <RelativePanel>\n` +
      `    <TextBox x:Name="An|chor" />\n` +
      `    <Button RelativePanel.RightOf="Anchor" RelativePanel.AlignTopWith="Anchor" />\n` +
      `  </RelativePanel>\n</Page>`;
    const refs = await h.referencesAt(buf);
    assert.strictEqual(refs.length, 3, `expected 3 (decl + RightOf + AlignTopWith); got ${refs.length}: ${JSON.stringify(refs.map((r) => r.text))}`);
    assert.ok(refs.every((r) => r.text === "Anchor"), `all refs should read 'Anchor'; got ${JSON.stringify(refs.map((r) => r.text))}`);
  });

  it("renames the Setter.Target element segment only, preserving the .Property tail", async () => {
    const buf =
      `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n` +
      `  <Border x:Name="He|ro" />\n` +
      `  <Setter Target="Hero.Background" Value="Red" />\n</Page>`;
    const { edits, error } = await h.renameAt(buf, "Banner");
    assert.ok(!error, `rename should not error; got ${error}`);
    assert.strictEqual(edits.length, 2, `expected 2 edits (decl + Setter.Target element); got ${edits.length}: ${JSON.stringify(edits)}`);
    assert.ok(edits.every((e) => e.newText === "Banner"), `every edit must set 'Banner'; got ${JSON.stringify(edits.map((e) => e.newText))}`);
    // THE RAZOR: each edit covers exactly "Hero", never "Hero.Background".
    assert.ok(edits.every((e) => e.text === "Hero"), `every edit must cover exactly "Hero" (not "Hero.Background"); got ${JSON.stringify(edits.map((e) => e.text))}`);
  });

  it("does not treat the Setter.Target .Property tail as a reference", async () => {
    // A caret on ".Background" is a member on Hero, not the element name -> no element-name references.
    const buf =
      `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n` +
      `  <Border x:Name="Hero" />\n` +
      `  <Setter Target="Hero.Backgr|ound" Value="Red" />\n</Page>`;
    const refs = await h.referencesAt(buf);
    assert.ok(!refs.some((r) => r.text === "Hero"), `the .Property tail must not resolve Hero references; got ${JSON.stringify(refs.map((r) => r.text))}`);
  });
});

describe("WinUI XAML — VSM Setter.Target / Storyboard.TargetProperty member navigation", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  // Round 81: F12 + hover on the MEMBER segment of a VSM <Setter Target="Element.Property"> value and a bare
  // Storyboard.TargetProperty="Property" value resolve the property on the target element's type — symmetric
  // with <Setter Property="...">. Round 80 shipped the pre-dot ELEMENT reference nav/rename; round 81 resolves
  // the post-dot MEMBER. Framework members resolve for HOVER but have no source location, so F12 returns null
  // there (the documented metadata boundary) — and a member caret must NOT fall through to the round-80
  // element F12 that would wrongly navigate to the x:Name declaration.

  const setterTarget = (target) =>
    `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n` +
    `  <Border x:Name="Chrome" />\n` +
    `  <Setter Target="${target}" Value="0.5" />\n</Page>`;

  it("hovers the Setter.Target member as the property on the target element's type", async () => {
    const md = await h.hoverAt(setterTarget("Chrome.Opac|ity"));
    assert.ok(/Opacity/.test(md), `expected the Opacity property; got: ${md}`);
    assert.ok(!/\(element\)/.test(md), `the member segment must resolve the property, not the element; got: ${md}`);
  });

  it("F12 on the Setter.Target member does not navigate to the x:Name declaration (framework member, graceful)", async () => {
    const buf = setterTarget("Chrome.Opac|ity");
    const declLine = buf.replaceAll("|", "").split("\n").findIndex((l) => l.includes('x:Name="Chrome"'));
    const defs = await h.definitionsAt(buf);
    assert.ok(!defs.some((d) => d.line === declLine), `the member caret must not resolve the element decl; got ${JSON.stringify(defs)}`);
  });

  it("F12 on the Setter.Target element segment still navigates to the x:Name declaration (round-80 intact)", async () => {
    const buf = setterTarget("Chr|ome.Opacity");
    const declLine = buf.replaceAll("|", "").split("\n").findIndex((l) => l.includes('x:Name="Chrome"'));
    const defs = await h.definitionsAt(buf);
    assert.ok(defs.some((d) => d.line === declLine), `expected the x:Name="Chrome" decl on line ${declLine}; got ${JSON.stringify(defs)}`);
  });

  it("hovers a bare Storyboard.TargetProperty member against the sibling Storyboard.TargetName element", async () => {
    const buf =
      `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n` +
      `  <StackPanel>\n` +
      `    <Border x:Name="Chrome" />\n` +
      `    <Storyboard>\n` +
      `      <DoubleAnimation Storyboard.TargetName="Chrome" Storyboard.TargetProperty="Opac|ity" />\n` +
      `    </Storyboard>\n` +
      `  </StackPanel>\n</Page>`;
    const md = await h.hoverAt(buf);
    assert.ok(/Opacity/.test(md), `expected the Opacity property; got: ${md}`);
    assert.ok(!/\(element\)/.test(md), `the TargetProperty member must resolve the property, not an element; got: ${md}`);
  });
});

describe("WinUI XAML — TemplateBinding property member navigation", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  // Round 82: F12 + hover on the PROPERTY argument of {TemplateBinding Property} inside a ControlTemplate
  // resolve the member on the template's TargetType (the templated parent) — symmetric with the TemplateBinding
  // COMPLETION (both reuse ResolveStyleTargetType). Framework members resolve for HOVER but have no source
  // location, so F12 returns nothing (the documented metadata boundary). The extension NAME hover (the
  // "TemplateBinding" macro description) is handled earlier by the value-hover path and must be unchanged.

  const tb = (inner) =>
    `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n` +
    `  <Page.Resources>\n` +
    `    <Style TargetType="Button">\n` +
    `      <Setter Property="Template">\n` +
    `        <Setter.Value>\n` +
    `          <ControlTemplate TargetType="Button">\n` +
    `            ${inner}\n` +
    `          </ControlTemplate>\n` +
    `        </Setter.Value>\n` +
    `      </Setter>\n` +
    `    </Style>\n` +
    `  </Page.Resources>\n</Page>`;

  it("hovers the TemplateBinding property as the member on the template's TargetType", async () => {
    const md = await h.hoverAt(tb('<Border Background="{TemplateBinding Back|ground}" />'));
    assert.ok(/Background/.test(md), `expected the Background property; got: ${md}`);
    assert.ok(!/\(element\)/.test(md), `the TemplateBinding property must resolve a member, not an element; got: ${md}`);
  });

  it("F12 on the TemplateBinding member returns nothing for a framework property (graceful metadata boundary)", async () => {
    const defs = await h.definitionsAt(tb('<Border Background="{TemplateBinding Back|ground}" />'));
    assert.strictEqual(defs.length, 0, `a framework member has no source; expected no definitions, got ${JSON.stringify(defs)}`);
  });

  it("caret on the TemplateBinding extension name still shows the macro description, not a member", async () => {
    const md = await h.hoverAt(tb('<Border Background="{Templ|ateBinding Background}" />'));
    assert.ok(/TemplateBinding/.test(md) && /templated (control|parent)/i.test(md), `expected the macro description; got: ${md}`);
  });

  it("a property not on the TargetType resolves nothing (no leak)", async () => {
    const md = await h.hoverAt(tb('<Border Background="{TemplateBinding Zork|le}" />'));
    assert.strictEqual(md, "", `an unknown member on the TargetType should not hover; got: ${md}`);
  });
});

describe("WinUI XAML — Storyboard.TargetProperty parenthesized (Owner.Property) member navigation", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  // Round 83: F12 + hover on the MEMBER (or owner type) of a parenthesized (Owner.Property) qualifier inside
  // Storyboard.TargetProperty — the read-side counterpart of the round-77 qualified-group COMPLETION (both
  // resolve the EXPLICITLY named owner type, independently of Storyboard.TargetName). A member caret resolves an
  // INSTANCE property or an ATTACHED property of the owner; an owner caret resolves the owner TYPE. Framework
  // members/types have no source, so F12 returns nothing (the documented metadata boundary).

  const sb = (tp) =>
    `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n` +
    `  <StackPanel>\n` +
    `    <Border x:Name="AttachedProbe" />\n` +
    `    <Storyboard>\n` +
    `      <DoubleAnimation Storyboard.TargetName="AttachedProbe" Storyboard.TargetProperty="${tp}" />\n` +
    `    </Storyboard>\n` +
    `  </StackPanel>\n</Page>`;

  it("hovers an instance member of the explicitly named owner type", async () => {
    const md = await h.hoverAt(sb("(UIElement.Opac|ity)"));
    assert.ok(/Opacity/.test(md) && /UIElement/.test(md), `expected UIElement.Opacity; got: ${md}`);
    assert.ok(!/\(element\)/.test(md), `must resolve a member, not an element; got: ${md}`);
  });

  it("hovers an attached member with the attached-property framing", async () => {
    const md = await h.hoverAt(sb("(Canvas.Le|ft)"));
    assert.ok(/attached property/.test(md) && /Canvas\.Left/.test(md), `expected the attached-property framing; got: ${md}`);
  });

  it("a caret on the owner segment resolves the owner TYPE, not the member", async () => {
    const md = await h.hoverAt(sb("(UIEle|ment.Opacity)"));
    assert.ok(/class/.test(md) && /UIElement/.test(md), `expected the UIElement type; got: ${md}`);
    assert.ok(!/attached property/.test(md), `an owner caret must not render the attached-property framing; got: ${md}`);
  });

  it("resolves the member of the SECOND group in a chained qualifier", async () => {
    const md = await h.hoverAt(sb("(UIElement.RenderTransform).(CompositeTransform.Trans|lateX)"));
    assert.ok(/TranslateX/.test(md) && /CompositeTransform/.test(md), `expected CompositeTransform.TranslateX; got: ${md}`);
  });

  it("F12 on a framework member returns nothing (graceful metadata boundary)", async () => {
    const defs = await h.definitionsAt(sb("(UIElement.Opac|ity)"));
    assert.strictEqual(defs.length, 0, `a framework member has no source; expected no definitions, got ${JSON.stringify(defs)}`);
  });
});

describe("WinUI XAML — document highlights", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  // vscode.DocumentHighlightKind client enum: Text=0, Read=1, Write=2 (the language client maps the LSP
  // wire kinds 1/2/3 down by one). So the declaration is Write=2 and usages are Read=1 here.
  function namePage(caretMarkup) {
    return (
      `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n` +
      `  <StackPanel>\n` +
      `    <Button ${caretMarkup} Content="Go" />\n` +
      `    <TextBlock Text="{Binding ElementName=GoButton}" />\n` +
      `    <Storyboard>\n` +
      `      <DoubleAnimation Storyboard.TargetName="GoButton" Storyboard.TargetProperty="Opacity" />\n` +
      `    </Storyboard>\n` +
      `  </StackPanel>\n</Page>`
    );
  }

  it("highlights the x:Name declaration (Write) and all usages (Read)", async () => {
    const hls = await h.highlightsAt(namePage('x:Name="Go|Button"'));
    assert.strictEqual(hls.length, 3, `expected 3 highlights; got ${hls.length}: ${JSON.stringify(hls.map((x) => x.text))}`);
    assert.ok(hls.every((x) => x.text === "GoButton"), `all highlights should read 'GoButton'; got ${JSON.stringify(hls.map((x) => x.text))}`);
    assert.strictEqual(hls.filter((x) => x.kind === 2).length, 1, `expected exactly 1 Write (declaration) highlight; got kinds ${JSON.stringify(hls.map((x) => x.kind))}`);
    assert.strictEqual(hls.filter((x) => x.kind === 1).length, 2, `expected 2 Read (usage) highlights; got kinds ${JSON.stringify(hls.map((x) => x.kind))}`);
  });

  it("highlights resource-key occurrences from a usage", async () => {
    const buf =
      `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n` +
      `  <Page.Resources>\n` +
      `    <SolidColorBrush x:Key="Brush1" Color="Red" />\n` +
      `  </Page.Resources>\n` +
      `  <StackPanel>\n` +
      `    <Border Background="{StaticResource Bru|sh1}" />\n` +
      `    <Border Background="{ThemeResource Brush1}" />\n` +
      `  </StackPanel>\n</Page>`;
    const hls = await h.highlightsAt(buf);
    assert.strictEqual(hls.length, 3, `expected 3 highlights; got ${hls.length}: ${JSON.stringify(hls.map((x) => x.text))}`);
    assert.ok(hls.every((x) => x.text === "Brush1"), `all highlights should read 'Brush1'; got ${JSON.stringify(hls.map((x) => x.text))}`);
    assert.strictEqual(hls.filter((x) => x.kind === 2).length, 1, `expected exactly 1 Write (declaration) highlight; got kinds ${JSON.stringify(hls.map((x) => x.kind))}`);
  });

  it("does not contribute name/key highlights when the caret is on a plain element tag", async () => {
    const hls = await h.highlightsAt(namePage('x:Name="GoButton"').replace("<StackPanel>", "<StackPa|nel>"));
    // vscode.executeDocumentHighlights merges VS Code's built-in XML tag-match highlighter (it highlights
    // the <StackPanel>/</StackPanel> pair). Our server must not add any x:Name/x:Key highlight here — so no
    // highlight may read 'GoButton'. (The server-level "exactly 0" guarantee is covered by the stdio smoke.)
    assert.ok(
      hls.every((x) => x.text !== "GoButton"),
      `server must not resolve a name from a plain element tag; got ${JSON.stringify(hls.map((x) => x.text))}`
    );
  });
});

describe("WinUI XAML — document formatting", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("reindents nested elements to the configured indent (2 spaces)", async () => {
    const messy = "<Page>\n<Grid>\n<Button />\n</Grid>\n</Page>";
    const { formatted } = await h.formatDoc(messy, { tabSize: 2, insertSpaces: true });
    assert.strictEqual(formatted, "<Page>\n  <Grid>\n    <Button />\n  </Grid>\n</Page>");
  });

  it("honors tabSize / insertSpaces (4-space indent)", async () => {
    const messy = "<Page>\n<Grid>\n<Button />\n</Grid>\n</Page>";
    const { formatted } = await h.formatDoc(messy, { tabSize: 4, insertSpaces: true });
    assert.strictEqual(formatted, "<Page>\n    <Grid>\n        <Button />\n    </Grid>\n</Page>");
  });

  it('preserves xml:space="preserve" content byte-for-byte while reindenting its tag', async () => {
    const src = '<Page>\n<TextBlock xml:space="preserve">\n      keep  this\n   text</TextBlock>\n</Page>';
    const { formatted } = await h.formatDoc(src);
    assert.ok(
      formatted.includes("\n      keep  this\n   text</TextBlock>"),
      `significant whitespace changed: ${JSON.stringify(formatted)}`
    );
    assert.ok(
      formatted.includes('  <TextBlock xml:space="preserve">'),
      `open tag not reindented: ${JSON.stringify(formatted)}`
    );
  });

  it("does not alter significant inline text content", async () => {
    const src = "<Page>\n<TextBlock>Hello  World</TextBlock>\n</Page>";
    const { formatted } = await h.formatDoc(src);
    assert.ok(
      formatted.includes("<TextBlock>Hello  World</TextBlock>"),
      `inline text changed: ${JSON.stringify(formatted)}`
    );
  });

  it("leaves an already-formatted document unchanged (idempotent, zero edits)", async () => {
    const clean = "<Page>\n  <Grid>\n    <Button />\n  </Grid>\n</Page>";
    const { formatted, editCount } = await h.formatDoc(clean);
    assert.strictEqual(editCount, 0, `expected no edits on an already-formatted doc; got ${editCount}`);
    assert.strictEqual(formatted, clean);
  });
});

describe("WinUI XAML — folding ranges", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("folds a multi-line element from its open tag to its end tag", async () => {
    const ranges = await h.foldingRangesAt("<Grid>\n  <Button />\n</Grid>");
    assert.ok(
      ranges.some((r) => r.start === 0 && r.end === 2),
      `expected a [0,2] element fold; got ${JSON.stringify(ranges)}`
    );
  });

  it("does not fold a single-line element", async () => {
    const ranges = await h.foldingRangesAt("<Grid><Button /></Grid>");
    assert.ok(
      !ranges.some((r) => r.start === 0),
      `single-line element should not fold; got ${JSON.stringify(ranges)}`
    );
  });

  it("tags a multi-line comment as a comment fold", async () => {
    const ranges = await h.foldingRangesAt("<!-- line one\n     line two\n     line three -->");
    assert.ok(
      ranges.some((r) => r.start === 0 && r.kind === "comment"),
      `expected a comment fold at line 0; got ${JSON.stringify(ranges)}`
    );
  });

  it("pairs #region / #endregion comments as a region fold", async () => {
    const ranges = await h.foldingRangesAt(
      "<Grid>\n  <!-- #region Buttons -->\n  <Button />\n  <!-- #endregion -->\n</Grid>"
    );
    assert.ok(
      ranges.some((r) => r.kind === "region" && r.start === 1 && r.end === 3),
      `expected a [1,3] region fold; got ${JSON.stringify(ranges)}`
    );
  });

  it("never emits an inverted or degenerate range, even on malformed markup", async () => {
    const ranges = await h.foldingRangesAt("<Grid>\n  <Button />\n</Wrong>");
    assert.ok(
      ranges.every((r) => r.end > r.start),
      `every fold must span >=2 lines; got ${JSON.stringify(ranges)}`
    );
  });
});

describe("WinUI XAML — document color", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("emits a swatch for a full-value hex attribute with the right channels", async () => {
    const colors = await h.documentColorsAt('<Rectangle Fill="#FF0000" />');
    const swatch = colors.find((c) => c.text === "#FF0000");
    assert.ok(swatch, `expected a #FF0000 swatch; got ${JSON.stringify(colors)}`);
    assert.ok(Math.abs(swatch.color.red - 1) < 0.01, "red channel");
    assert.ok(Math.abs(swatch.color.green) < 0.01, "green channel");
    assert.ok(Math.abs(swatch.color.blue) < 0.01, "blue channel");
    assert.ok(Math.abs(swatch.color.alpha - 1) < 0.01, "alpha channel");
  });

  it("does not emit a swatch for a non-color value or an embedded hex substring", async () => {
    const plain = await h.documentColorsAt('<TextBlock Text="hello world" />');
    assert.strictEqual(plain.length, 0, `non-color value should have no swatch; got ${JSON.stringify(plain)}`);
    const embedded = await h.documentColorsAt('<TextBlock Text="#FF0000 is red" />');
    assert.strictEqual(embedded.length, 0, `embedded hex is not a color value; got ${JSON.stringify(embedded)}`);
  });

  it("skips markup-extension values", async () => {
    const colors = await h.documentColorsAt('<Rectangle Fill="{StaticResource Brush1}" />');
    assert.strictEqual(colors.length, 0, `markup extension should have no swatch; got ${JSON.stringify(colors)}`);
  });

  it("detects short hex and 8-digit ARGB with alpha", async () => {
    const short = await h.documentColorsAt('<Rectangle Fill="#f00" />');
    const s = short.find((c) => c.text === "#f00");
    assert.ok(s && Math.abs(s.color.red - 1) < 0.01 && Math.abs(s.color.green) < 0.01, `#f00 -> red; got ${JSON.stringify(short)}`);

    const argb = await h.documentColorsAt('<Rectangle Fill="#80FF0000" />');
    const a = argb.find((c) => c.text === "#80FF0000");
    assert.ok(a, `expected #80FF0000 swatch; got ${JSON.stringify(argb)}`);
    assert.ok(Math.abs(a.color.alpha - 0x80 / 255) < 0.01, `alpha ~0x80; got ${a.color.alpha}`);
    assert.ok(Math.abs(a.color.red - 1) < 0.01, "red full");
  });

  it("offers bounded hex write-backs for a picked opaque color", async () => {
    const buffer = '<Rectangle Fill="#FF0000" />';
    const colors = await h.documentColorsAt(buffer);
    const swatch = colors.find((c) => c.text === "#FF0000");
    assert.ok(swatch, "swatch present");
    const presentations = await h.colorPresentationsAt(
      buffer,
      { red: 0x3b / 255, green: 0x82 / 255, blue: 0xf6 / 255, alpha: 1 },
      swatch.range
    );
    const labels = presentations.map((p) => p.label);
    assert.ok(labels.includes("#3B82F6"), `expected #3B82F6; got ${labels.join(",")}`);
    assert.ok(labels.includes("#FF3B82F6"), `expected #FF3B82F6; got ${labels.join(",")}`);
    for (const p of presentations) {
      assert.ok(p.editRange, `presentation '${p.label}' must carry a textEdit`);
      assert.strictEqual(p.editRange.start.character, swatch.range.start.character, "edit start == literal start");
      assert.strictEqual(p.editRange.end.character, swatch.range.end.character, "edit end == literal end");
      assert.strictEqual(p.newText, p.label, "write-back text equals the label");
    }
  });

  it("offers #AARRGGBB first for a translucent picked color", async () => {
    const buffer = '<Rectangle Fill="#FF0000" />';
    const colors = await h.documentColorsAt(buffer);
    const swatch = colors.find((c) => c.text === "#FF0000");
    const presentations = await h.colorPresentationsAt(
      buffer,
      { red: 1, green: 0, blue: 0, alpha: 0x80 / 255 },
      swatch.range
    );
    assert.strictEqual(presentations[0].label, "#80FF0000", `expected #80FF0000 first; got ${JSON.stringify(presentations.map((p) => p.label))}`);
  });
});

describe("WinUI XAML — selection ranges", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  function assertWellFormed(caret, ranges) {
    assert.ok(ranges.length >= 1, `expected at least one selection range; got ${JSON.stringify(ranges)}`);
    // innermost contains the caret
    const inner = ranges[0];
    const containsCaret =
      (caret.line > inner.start.line || (caret.line === inner.start.line && caret.character >= inner.start.character)) &&
      (caret.line < inner.end.line || (caret.line === inner.end.line && caret.character <= inner.end.character));
    assert.ok(containsCaret, `innermost range must contain the caret; caret=${JSON.stringify(caret)} inner=${JSON.stringify(inner)}`);
    // VS Code merges our provider's chain with its built-in selection-range providers, which can emit
    // equal consecutive ranges (benign editor artifact — our provider's chain is strictly nested, pinned
    // by the .NET XamlSelectionRangeTests). Collapse consecutive-equal ranges, then assert strict growth
    // on the deduped chain so real inversions/overlaps are still caught.
    const chain = [];
    for (const r of ranges) {
      const p = chain[chain.length - 1];
      if (p && p.start.line === r.start.line && p.start.character === r.start.character &&
        p.end.line === r.end.line && p.end.character === r.end.character) continue;
      chain.push(r);
    }
    // strict containment up the chain
    for (let i = 0; i + 1 < chain.length; i++) {
      const a = chain[i];
      const b = chain[i + 1];
      const startOk = b.start.line < a.start.line || (b.start.line === a.start.line && b.start.character <= a.start.character);
      const endOk = b.end.line > a.end.line || (b.end.line === a.end.line && b.end.character >= a.end.character);
      const strict = (b.start.line !== a.start.line || b.start.character !== a.start.character) ||
        (b.end.line !== a.end.line || b.end.character !== a.end.character);
      assert.ok(startOk && endOk && strict, `level ${i + 1} must strictly contain level ${i}: ${JSON.stringify({ a, b })}`);
    }
    // outermost is the whole document
    const outer = ranges[ranges.length - 1];
    assert.strictEqual(outer.start.line, 0, `outermost must start at line 0; got ${JSON.stringify(outer)}`);
    assert.strictEqual(outer.start.character, 0, `outermost must start at character 0; got ${JSON.stringify(outer)}`);
  }

  it("expands from an attribute value into strictly nested ranges ending at the document", async () => {
    const { caret, ranges } = await h.selectionRangesAt('<Grid Background="#FF00|00" />');
    assertWellFormed(caret, ranges);
    assert.ok(ranges.length >= 3, `expected several nested levels; got ${ranges.length}`);
  });

  it("produces ancestor element levels for a deeply nested caret", async () => {
    const { caret, ranges } = await h.selectionRangesAt(
      "<Page>\n  <Grid>\n    <Button Content=\"H|i\" />\n  </Grid>\n</Page>"
    );
    assertWellFormed(caret, ranges);
    // value text -> quoted value -> attribute -> Button open/element -> Grid -> Page -> document
    assert.ok(ranges.length >= 5, `expected ancestor levels; got ${ranges.length}: ${JSON.stringify(ranges)}`);
  });

  it("stays well-formed on malformed / unterminated markup", async () => {
    const { caret, ranges } = await h.selectionRangesAt('<Grid><Button Content="x|x"');
    assertWellFormed(caret, ranges);
  });
});

describe("WinUI XAML — linked editing", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("returns both tag-name ranges from the open tag name", async () => {
    const { ranges } = await h.linkedEditingAt("<Sta|ckPanel>\n  <Button />\n</StackPanel>");
    assert.strictEqual(ranges.length, 2, `expected 2 linked ranges; got ${JSON.stringify(ranges)}`);
    assert.ok(ranges.every((r) => r.text === "StackPanel"), `both ranges must cover 'StackPanel'; got ${JSON.stringify(ranges.map((r) => r.text))}`);
    // open name (line 0) precedes the end name (line 2)
    assert.ok(ranges[0].start.line < ranges[1].start.line, `open name must precede end name; got ${JSON.stringify(ranges)}`);
  });

  it("returns both tag-name ranges from the end tag name", async () => {
    const { ranges } = await h.linkedEditingAt("<StackPanel>\n  <Button />\n</Stack|Panel>");
    assert.strictEqual(ranges.length, 2, `expected 2 linked ranges; got ${JSON.stringify(ranges)}`);
    assert.ok(ranges.every((r) => r.text === "StackPanel"), `both ranges must cover 'StackPanel'; got ${JSON.stringify(ranges.map((r) => r.text))}`);
  });

  it("links a prefixed element over its whole qualified name", async () => {
    const { ranges } = await h.linkedEditingAt('<Page xmlns:local="using:App">\n  <local:MyCtl|></local:MyCtl>\n</Page>');
    assert.strictEqual(ranges.length, 2, `expected 2 linked ranges; got ${JSON.stringify(ranges)}`);
    assert.ok(ranges.every((r) => r.text === "local:MyCtl"), `both ranges must cover 'local:MyCtl'; got ${JSON.stringify(ranges.map((r) => r.text))}`);
  });

  it("does not link a self-closing element", async () => {
    const { ranges } = await h.linkedEditingAt("<StackPanel>\n  <But|ton />\n</StackPanel>");
    assert.strictEqual(ranges.length, 0, `self-closing element must not link; got ${JSON.stringify(ranges)}`);
  });

  it("does not link when the caret is on an attribute", async () => {
    const { ranges } = await h.linkedEditingAt('<Grid Wid|th="1"></Grid>');
    assert.strictEqual(ranges.length, 0, `caret on an attribute must not link; got ${JSON.stringify(ranges)}`);
  });
});

describe("WinUI XAML — document links", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  // Resolved target ends with "/name" (case-insensitive, path-separator-agnostic). The fixture keeps
  // App.xaml and Page2.xaml beside SmokePage.xaml, so a relative Source resolves. Only schemeless paths
  // are used here so VS Code's built-in URL link detector (which matches only scheme'd URIs) can't
  // contribute extra links; ms-appx / app-root resolution is covered by the unit + smoke suites.
  const endsWith = (p, name) => !!p && p.replace(/\\/g, "/").toLowerCase().endsWith("/" + name.toLowerCase());

  it("links a ResourceDictionary Source that exists on disk", async () => {
    const links = await h.documentLinksAt('<ResourceDictionary Source="App.xaml" />');
    const mine = links.filter((l) => l.text === "App.xaml");
    assert.strictEqual(mine.length, 1, `expected 1 link over App.xaml; got ${JSON.stringify(links)}`);
    assert.ok(endsWith(mine[0].target, "App.xaml"), `target must resolve to App.xaml on disk; got ${JSON.stringify(mine[0])}`);
  });

  it("does not link a ResourceDictionary Source that is missing on disk", async () => {
    const links = await h.documentLinksAt('<ResourceDictionary Source="DoesNotExist.xaml" />');
    assert.strictEqual(links.filter((l) => l.text.endsWith(".xaml")).length, 0, `a missing target must not link; got ${JSON.stringify(links)}`);
  });

  it("links each existing Source under MergedDictionaries", async () => {
    const buffer =
      "<ResourceDictionary>\n" +
      "  <ResourceDictionary.MergedDictionaries>\n" +
      '    <ResourceDictionary Source="App.xaml" />\n' +
      '    <ResourceDictionary Source="Page2.xaml" />\n' +
      "  </ResourceDictionary.MergedDictionaries>\n" +
      "</ResourceDictionary>";
    const links = await h.documentLinksAt(buffer);
    const covered = links.map((l) => l.text).sort();
    assert.deepStrictEqual(covered, ["App.xaml", "Page2.xaml"], `expected links over both dictionary sources; got ${JSON.stringify(links)}`);
    assert.ok(links.every((l) => endsWith(l.target, l.text)), `each target must resolve to its file; got ${JSON.stringify(links)}`);
  });

  it("links an Image Source asset that exists on disk (app-root relative)", async () => {
    // Round 46 shipped asset links: Image Source="Assets/…" resolves from the app package root to a real
    // file under the fixture's Assets folder. (Schemeless so VS Code's URL detector can't add extra links.)
    const links = await h.documentLinksAt('<Image Source="Assets/StoreLogo.png" />');
    const mine = links.filter((l) => l.text === "Assets/StoreLogo.png");
    assert.strictEqual(mine.length, 1, `expected 1 link over the asset path; got ${JSON.stringify(links)}`);
    assert.ok(endsWith(mine[0].target, "Assets/StoreLogo.png"), `target must resolve to the real asset; got ${JSON.stringify(mine[0])}`);
  });

  it("links a BitmapImage UriSource asset that exists on disk", async () => {
    const links = await h.documentLinksAt('<BitmapImage UriSource="Assets/StoreLogo.png" />');
    const mine = links.filter((l) => l.text === "Assets/StoreLogo.png");
    assert.strictEqual(mine.length, 1, `expected 1 link over the UriSource path; got ${JSON.stringify(links)}`);
    assert.ok(endsWith(mine[0].target, "Assets/StoreLogo.png"), `target must resolve to the real asset; got ${JSON.stringify(mine[0])}`);
  });

  it("does not link a missing Image Source asset", async () => {
    const links = await h.documentLinksAt('<Image Source="Assets/DoesNotExist.png" />');
    assert.strictEqual(links.filter((l) => l.text.endsWith(".png")).length, 0, `a missing asset must not link; got ${JSON.stringify(links)}`);
  });

  it("does not link an Image Source bound by a markup extension", async () => {
    const links = await h.documentLinksAt('<Image Source="{x:Bind LogoUri}" />');
    assert.strictEqual(links.filter((l) => /Logo/.test(l.text)).length, 0, `a bound Source must not link; got ${JSON.stringify(links)}`);
  });
});

describe("WinUI XAML — rename", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("renames an x:Name declaration and its ElementName usage", async () => {
    const buffer =
      '<Grid x:Name="Ro|ot">\n' +
      '  <TextBox Text="{Binding ElementName=Root}" />\n' +
      "</Grid>";
    const res = await h.renameAt(buffer, "Panel");
    assert.ok(!res.error, `rename should succeed; got ${JSON.stringify(res)}`);
    assert.strictEqual(res.edits.length, 2, `expected 2 edits (decl + usage); got ${JSON.stringify(res.edits)}`);
    assert.ok(res.edits.every((e) => e.newText === "Panel"), `every edit must set "Panel"; got ${JSON.stringify(res.edits)}`);
    assert.ok(res.edits.every((e) => e.text === "Root"), `every edit must cover the old name "Root"; got ${JSON.stringify(res.edits)}`);
  });

  it("renames from a usage caret and rewrites the same set", async () => {
    const buffer =
      '<Grid x:Name="Root">\n' +
      '  <TextBox Text="{Binding ElementName=Ro|ot}" />\n' +
      "</Grid>";
    const res = await h.renameAt(buffer, "Panel");
    assert.ok(!res.error, `rename should succeed; got ${JSON.stringify(res)}`);
    assert.strictEqual(res.edits.length, 2, `expected 2 edits; got ${JSON.stringify(res.edits)}`);
    assert.ok(res.edits.every((e) => e.newText === "Panel" && e.text === "Root"), `got ${JSON.stringify(res.edits)}`);
  });

  it("renames an x:Key and its StaticResource usages", async () => {
    const buffer =
      "<Page>\n" +
      "  <Page.Resources>\n" +
      '    <SolidColorBrush x:Key="Acc|ent" Color="Red" />\n' +
      "  </Page.Resources>\n" +
      '  <Grid Background="{StaticResource Accent}" />\n' +
      "</Page>";
    const res = await h.renameAt(buffer, "Brand");
    assert.ok(!res.error, `rename should succeed; got ${JSON.stringify(res)}`);
    assert.strictEqual(res.edits.length, 2, `expected 2 edits (x:Key decl + StaticResource); got ${JSON.stringify(res.edits)}`);
    assert.ok(res.edits.every((e) => e.newText === "Brand" && e.text === "Accent"), `got ${JSON.stringify(res.edits)}`);
  });

  it("rejects an invalid x:Name and applies no edit", async () => {
    const buffer = '<Grid x:Name="Ro|ot" />';
    const res = await h.renameAt(buffer, "1Bad Name");
    assert.ok(res.error || (res.edits || []).length === 0, `an invalid name must not be applied; got ${JSON.stringify(res)}`);
  });

  it("does not offer rename on a non-symbol", async () => {
    const res = await h.renameAt('<Gr|id x:Name="Root" />', "Panel");
    assert.ok((res.edits || []).length === 0, `a caret on the element name must not rename; got ${JSON.stringify(res)}`);
  });
});

describe("WinUI XAML — semantic tokens", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  const has = (tokens, text, type) =>
    tokens.some((t) => t.text === text && t.type === type);
  const dump = (tokens) => JSON.stringify(tokens.map((t) => `${t.type}:'${t.text}'`));

  it("advertises the expected legend and classifies element types + attribute members", async () => {
    const { legend, tokens } = await h.semanticTokensAt('<Grid Background="Red" x:Name="Root" />');
    assert.deepStrictEqual(
      legend.tokenTypes,
      ["namespace", "class", "property", "macro", "parameter"],
      `unexpected legend ${JSON.stringify(legend.tokenTypes)}`
    );
    assert.ok(has(tokens, "Grid", "class"), `Grid should be a class; ${dump(tokens)}`);
    assert.ok(has(tokens, "Background", "property"), `Background should be a property; ${dump(tokens)}`);
  });

  it("splits prefixed element + attribute names into a namespace prefix and a local role", async () => {
    const { tokens } = await h.semanticTokensAt('<local:Foo x:Name="Root" />');
    assert.ok(has(tokens, "local", "namespace"), `local: prefix should be a namespace; ${dump(tokens)}`);
    assert.ok(has(tokens, "Foo", "class"), `Foo should be a class; ${dump(tokens)}`);
    assert.ok(has(tokens, "x", "namespace"), `x: prefix should be a namespace; ${dump(tokens)}`);
    assert.ok(has(tokens, "Name", "property"), `Name should be a property; ${dump(tokens)}`);
    // the x:Name VALUE is intentionally NOT tokenized (names only, not values)
    assert.ok(!tokens.some((t) => t.text === "Root"), `the x:Name value "Root" must not be tokenized; ${dump(tokens)}`);
  });

  it("colors markup-extension names as macros and named arguments as parameters (incl. nested)", async () => {
    const { tokens } = await h.semanticTokensAt('<TextBox Text="{Binding Source={StaticResource Accent}, Path=Text}" />');
    assert.ok(has(tokens, "Binding", "macro"), `Binding should be a macro; ${dump(tokens)}`);
    assert.ok(has(tokens, "Source", "parameter"), `Source should be a parameter; ${dump(tokens)}`);
    assert.ok(has(tokens, "StaticResource", "macro"), `nested StaticResource should be a macro; ${dump(tokens)}`);
    assert.ok(has(tokens, "Path", "parameter"), `Path should be a parameter; ${dump(tokens)}`);
  });

  it("treats property elements and attached properties as members", async () => {
    const buffer =
      "<Grid>\n" +
      "  <Grid.RowDefinitions>\n" +
      '    <RowDefinition Height="Auto" />\n' +
      "  </Grid.RowDefinitions>\n" +
      '  <Border Grid.Row="0" />\n' +
      "</Grid>";
    const { tokens } = await h.semanticTokensAt(buffer);
    assert.ok(has(tokens, "Grid.RowDefinitions", "property"), `property element should be a property; ${dump(tokens)}`);
    assert.ok(has(tokens, "RowDefinition", "class"), `RowDefinition should be a class; ${dump(tokens)}`);
    assert.ok(has(tokens, "Grid.Row", "property"), `attached Grid.Row should be a property; ${dump(tokens)}`);
  });

  it("skips xmlns declarations and returns sorted, single-line, non-overlapping tokens", async () => {
    const buffer =
      '<Page xmlns="http://x" xmlns:local="using:App">\n' +
      '  <Grid x:Name="Root"><Button /></Grid>\n' +
      "</Page>";
    const { tokens } = await h.semanticTokensAt(buffer);
    // xmlns / xmlns:local are structural — no namespace/property token for them.
    assert.ok(!tokens.some((t) => t.text === "xmlns"), `xmlns must not be tokenized; ${dump(tokens)}`);
    assert.ok(has(tokens, "Page", "class"), `Page should be a class; ${dump(tokens)}`);
    assert.ok(has(tokens, "Button", "class"), `Button should be a class; ${dump(tokens)}`);
    for (let i = 1; i < tokens.length; i++) {
      const prev = tokens[i - 1];
      const cur = tokens[i];
      const ordered = cur.line > prev.line || (cur.line === prev.line && cur.character >= prev.character + prev.length);
      assert.ok(ordered, `token ${i} ('${cur.text}') overlaps/precedes previous ('${prev.text}'); ${dump(tokens)}`);
    }
  });

  const dumpMod = (tokens) =>
    JSON.stringify(tokens.map((t) => `${t.type}:'${t.text}'${t.modifierNames.includes("defaultLibrary") ? "*" : ""}`));

  it("marks framework names with defaultLibrary and leaves user names unmarked", async () => {
    const buffer =
      `<Page ${h.NS}>\n` +
      '  <Grid x:Name="Root" Background="{StaticResource Accent}">\n' +
      '    <local:Foo Tag="{local:MyExt}" />\n' +
      "  </Grid>\n" +
      "</Page>";
    const { legend, tokens } = await h.semanticTokensAt(buffer);
    assert.ok(legend.tokenModifiers.includes("defaultLibrary"), `legend should advertise defaultLibrary; ${JSON.stringify(legend.tokenModifiers)}`);
    const isFw = (text, type) => tokens.some((t) => t.text === text && t.type === type && t.modifierNames.includes("defaultLibrary"));
    const notFw = (text) => tokens.filter((t) => t.text === text).every((t) => !t.modifierNames.includes("defaultLibrary"));
    // Framework: default-ns element (presentation), Page, the x: directive prefix + name, framework markup ext.
    assert.ok(isFw("Page", "class"), `Page should be defaultLibrary; ${dumpMod(tokens)}`);
    assert.ok(isFw("Grid", "class"), `Grid should be defaultLibrary; ${dumpMod(tokens)}`);
    assert.ok(isFw("x", "namespace"), `x prefix should be defaultLibrary; ${dumpMod(tokens)}`);
    assert.ok(isFw("Name", "property"), `Name should be defaultLibrary; ${dumpMod(tokens)}`);
    assert.ok(isFw("StaticResource", "macro"), `StaticResource should be defaultLibrary; ${dumpMod(tokens)}`);
    // User: the local: prefix + its element name + user markup ext; an unprefixed member is never marked.
    assert.ok(notFw("local"), `local prefix must NOT be defaultLibrary; ${dumpMod(tokens)}`);
    assert.ok(notFw("Foo"), `Foo must NOT be defaultLibrary; ${dumpMod(tokens)}`);
    assert.ok(notFw("MyExt"), `MyExt must NOT be defaultLibrary; ${dumpMod(tokens)}`);
    assert.ok(notFw("Background"), `unprefixed Background must NOT be defaultLibrary; ${dumpMod(tokens)}`);
  });

  it("without xmlns declarations, no token carries defaultLibrary", async () => {
    const { tokens } = await h.semanticTokensAt('<Grid x:Name="Root"><Button /></Grid>');
    assert.ok(tokens.every((t) => !t.modifierNames.includes("defaultLibrary")), `no prefix resolves, so nothing is framework; ${dumpMod(tokens)}`);
  });

  it("semanticTokens/range returns only tokens overlapping the requested range", async () => {
    const buffer = "<Grid>\n  <Button />\n  <TextBox />\n</Grid>";
    const range = { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } };
    const { tokens } = await h.semanticTokensRangeAt(buffer, range);
    assert.ok(has(tokens, "Button", "class"), `range should include the line-1 Button; ${dump(tokens)}`);
    assert.ok(!tokens.some((t) => t.text === "TextBox"), `TextBox (line 2) is out of range; ${dump(tokens)}`);
    assert.ok(!tokens.some((t) => t.text === "Grid"), `Grid open/end tags (lines 0,3) are out of range; ${dump(tokens)}`);
  });

  it("range tokens are a subset of the full set with identical decoding", async () => {
    const buffer = `<Page ${h.NS}>\n  <Grid x:Name="Root" />\n  <local:Foo />\n</Page>`;
    const { tokens: full } = await h.semanticTokensAt(buffer);
    const { tokens: ranged } = await h.semanticTokensRangeAt(buffer, { start: { line: 1, character: 0 }, end: { line: 1, character: 100 } });
    const line1 = full.filter((t) => t.line === 1).map((t) => `${t.type}:${t.character}:${t.length}:${t.modifiers}:${t.text}`);
    const rangedKeys = ranged.map((t) => `${t.type}:${t.character}:${t.length}:${t.modifiers}:${t.text}`);
    assert.deepStrictEqual(rangedKeys, line1, `ranged tokens should equal the full line-1 subset; ranged=${dump(ranged)} full-line1=${JSON.stringify(line1)}`);
  });
});

describe("WinUI XAML — code actions", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  const titles = (r) => JSON.stringify(r.actions.map((a) => a.title));

  it("offers a 'Did you mean?' fix for an unknown element type", async () => {
    const r = await h.codeActionsAt(page("<Buton />"), "WXAML0002", "Buton");
    const fix = r.actions.find((a) => a.title === "Change 'Buton' to 'Button'");
    assert.ok(fix, `expected a "Change 'Buton' to 'Button'" quick fix; got ${titles(r)}`);
    assert.strictEqual(fix.kind, "quickfix", `fix kind should be quickfix; got ${fix.kind}`);
    assert.strictEqual(fix.isPreferred, true, "the top suggestion should be preferred");
  });

  it("replaces exactly the flagged span with the chosen name", async () => {
    const r = await h.codeActionsAt(page("<Buton />"), "WXAML0002", "Buton");
    const fix = r.actions.find((a) => a.title === "Change 'Buton' to 'Button'");
    assert.ok(fix, `expected the Button fix; got ${titles(r)}`);
    const edit = fix.edits[0];
    assert.ok(edit, "the fix must carry an edit");
    assert.strictEqual(edit.newText, "Button", `edit should insert Button; got ${edit.newText}`);
    // The edit must cover EXACTLY the diagnostic's span — never widen into surrounding markup.
    const dr = r.diagnostic.range;
    assert.strictEqual(edit.line, dr.start.line, "edit start line must equal the diagnostic range");
    assert.strictEqual(edit.character, dr.start.character, "edit start char must equal the diagnostic range");
    assert.strictEqual(edit.endLine, dr.end.line, "edit end line must equal the diagnostic range");
    assert.strictEqual(edit.endCharacter, dr.end.character, "edit end char must equal the diagnostic range");
    assert.strictEqual(edit.text, "Buton", `the replaced text should be the flagged token; got ${edit.text}`);
  });

  it("treats a case-only slip as the top fix (XAML is case-sensitive)", async () => {
    const r = await h.codeActionsAt(page("<grid />"), "WXAML0002", "grid");
    const fix = r.actions.find((a) => a.title === "Change 'grid' to 'Grid'");
    assert.ok(fix, `expected a "Change 'grid' to 'Grid'" fix; got ${titles(r)}`);
    assert.strictEqual(fix.isPreferred, true, "the exact-casing correction should be preferred");
  });

  it("offers a fix for an unknown attribute member", async () => {
    const r = await h.codeActionsAt(page('<Button Contnt="Hi" />'), "WXAML0003", "Contnt");
    const fix = r.actions.find((a) => a.title === "Change 'Contnt' to 'Content'");
    assert.ok(fix, `expected a "Change 'Contnt' to 'Content'" fix; got ${titles(r)}`);
    assert.strictEqual(fix.edits[0].newText, "Content", "the attribute fix should insert Content");
  });

  it("offers no fix for an undeclared CUSTOM prefix naming a NON-project type", async () => {
    // 'zzz' is undeclared and 'Widget' is not one of the project's own source types, so there is no
    // using: namespace to infer (and never a "Change …" spelling fix for an undeclared prefix).
    const buffer = `<Page ${h.NS}>\n  <zzz:Widget x:Name="w" />\n</Page>`;
    const r = await h.codeActionsAt(buffer, "WXAML0001", "zzz");
    assert.ok(
      !r.actions.some((a) => /^Change '/.test(a.title)),
      `an undeclared-prefix error must not carry a "Change …" quick fix; got ${titles(r)}`
    );
    assert.ok(
      !r.actions.some((a) => /^Add xmlns/.test(a.title)),
      `a custom prefix naming a non-project type must not get an "Add xmlns" fix; got ${titles(r)}`
    );
  });

  it('offers \'Add xmlns:PREFIX="using:…"\' for an undeclared CUSTOM prefix naming a PROJECT type', async () => {
    // 'zzz' is undeclared and names the fixture's own SmokeFixture.SmokePage, so the fix infers the
    // using: namespace from the project's type system and declares it on the root.
    const r = await h.codeActionsAt(page("<zzz:SmokePage />"), "WXAML0001", "zzz");
    const fix = r.actions.find((a) => a.title === 'Add xmlns:zzz="using:SmokeFixture"');
    assert.ok(fix, `expected an 'Add xmlns:zzz="using:SmokeFixture"' quick fix; diag=${JSON.stringify(r.diagnostic)} actions=${titles(r)}`);
    assert.strictEqual(fix.kind, "quickfix", `fix kind should be quickfix; got ${fix.kind}`);
    assert.strictEqual(fix.isPreferred, true, "a single inferred namespace should be preferred");
    const edit = fix.edits[0];
    assert.ok(edit, "the fix must carry an edit");
    assert.strictEqual(edit.newText, ' xmlns:zzz="using:SmokeFixture"', `edit should declare the inferred using: namespace; got ${edit.newText}`);
    // A pure zero-width insertion grouped onto the root's xmlns block.
    assert.strictEqual(edit.line, edit.endLine, "insertion must be zero-width (same line)");
    assert.strictEqual(edit.character, edit.endCharacter, "insertion must be zero-width (same char)");
    assert.strictEqual(edit.text, "", "insertion must not replace any existing text");
    const targetLine = page("<zzz:SmokePage />").split("\n")[edit.line];
    assert.ok(/xmlns:/.test(targetLine), `declaration should group onto an xmlns line; got line ${edit.line} = ${JSON.stringify(targetLine)}`);
  });

  it("offers 'Add xmlns:d declaration' for an undeclared WELL-KNOWN prefix", async () => {
    // h.NS declares d/mc, so use a minimal header (default + x only) to leave 'd' genuinely undeclared.
    const minimalNS =
      'xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" ' +
      'xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"';
    const buffer = `<Page ${minimalNS}>\n  <d:Foo />\n</Page>`;
    const r = await h.codeActionsAt(buffer, "WXAML0001", "d");
    const fix = r.actions.find((a) => a.title === "Add xmlns:d declaration");
    assert.ok(fix, `expected an "Add xmlns:d declaration" quick fix; diag=${JSON.stringify(r.diagnostic)} actions=${titles(r)}`);
    assert.strictEqual(fix.kind, "quickfix", `fix kind should be quickfix; got ${fix.kind}`);
    assert.strictEqual(fix.isPreferred, true, "the add-xmlns fix should be preferred");
    const edit = fix.edits[0];
    assert.ok(edit, "the fix must carry an edit");
    assert.strictEqual(
      edit.newText,
      ' xmlns:d="http://schemas.microsoft.com/expression/blend/2008"',
      `edit should insert the standard blend namespace; got ${edit.newText}`
    );
    // A pure insertion on the root's open-tag line: zero-width range, replacing no existing text.
    assert.strictEqual(edit.line, edit.endLine, "insertion must be zero-width (same line)");
    assert.strictEqual(edit.character, edit.endCharacter, "insertion must be zero-width (same char)");
    assert.strictEqual(edit.text, "", "insertion must not replace any existing text");
    assert.strictEqual(edit.line, 0, "declaration groups with the existing xmlns on the root's line");
  });

  it("offers a 'Did you mean?' fix for a misspelled x:Bind path member", async () => {
    const r = await h.codeActionsAt(page('<TextBlock Text="{x:Bind GreetingTexx}" />'), "WXAML0005", "GreetingTexx");
    const fix = r.actions.find((a) => a.title === "Change 'GreetingTexx' to 'GreetingText'");
    assert.ok(fix, `expected a "Change 'GreetingTexx' to 'GreetingText'" quick fix; got ${titles(r)}`);
    assert.strictEqual(fix.kind, "quickfix", `fix kind should be quickfix; got ${fix.kind}`);
    assert.strictEqual(fix.isPreferred, true, "the top bindable-member suggestion should be preferred");
    const edit = fix.edits[0];
    assert.strictEqual(edit.newText, "GreetingText", `edit should insert GreetingText; got ${edit.newText}`);
    // Single-segment path: the diagnostic span IS the token, so the edit replaces it exactly.
    assert.strictEqual(edit.text, "GreetingTexx", `the replaced text should be the flagged token; got ${edit.text}`);
  });

  it("narrows a dotted x:Bind fix to the bad first segment (keeps the trailing path)", async () => {
    // The first-segment diagnostic underlines the WHOLE value; matchText is that span, while the fix
    // targets just the bad segment so ".Length" is preserved.
    const r = await h.codeActionsAt(page('<TextBlock Text="{x:Bind GreetingTexx.Length}" />'), "WXAML0005", "GreetingTexx.Length");
    const fix = r.actions.find((a) => a.title === "Change 'GreetingTexx' to 'GreetingText'");
    assert.ok(fix, `expected the dotted-path quick fix; got ${titles(r)}`);
    const edit = fix.edits[0];
    assert.strictEqual(edit.newText, "GreetingText", `edit should insert GreetingText; got ${edit.newText}`);
    const dr = r.diagnostic.range;
    // Edit starts at the value start but covers only "GreetingTexx" (12 chars), never the ".Length" tail.
    assert.strictEqual(edit.line, dr.start.line, "edit must start on the diagnostic's line");
    assert.strictEqual(edit.character, dr.start.character, "edit must start at the value start");
    assert.strictEqual(edit.endCharacter, dr.start.character + 12, "edit must cover exactly 'GreetingTexx'");
    assert.ok(edit.endCharacter < dr.end.character, "edit must be narrower than the whole-value span so '.Length' survives");
    assert.strictEqual(edit.text, "GreetingTexx", `the replaced text should be just the bad segment; got ${edit.text}`);
  });
});

// ---------------------------------------------------------------------------------------------------
// Gap #4 (ux-thirdparty-xmlns): NuGet control-library elements in element completion + auto xmlns.
// A referenced control library that registers no XmlnsDefinitionAttribute (the Windows Community
// Toolkit's SettingsControls, reachable only via using:CommunityToolkit.WinUI.Controls) is offered in
// element-name completion; accepting one inserts a prefixed name AND auto-declares the xmlns on the
// root via AdditionalTextEdits — exactly what Visual Studio does. Assertions discriminate on
// SERVER-ONLY fields (newText = "controls:SettingsCard", detail "(adds xmlns:controls)",
// additionalTextEdits) so VS Code's buffer word-based suggestions never confound them.
// ---------------------------------------------------------------------------------------------------
describe("WinUI XAML — third-party control completion (gap #4)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  const TOOLKIT_NS = "CommunityToolkit.WinUI.Controls";
  const XMLNS_EDIT = ` xmlns:controls="using:${TOOLKIT_NS}"`;

  // A <Page> with an EXTRA xmlns already declared on the root (for the prefix-reuse probe).
  function pageWith(extraXmlns, inner) {
    return `<Page ${h.NS}\n    ${extraXmlns}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
  }

  it("offers a toolkit control and injects its xmlns on the root", async () => {
    const items = await h.completionEditsAt(page("<Grid><Sett|</Grid>"));
    const card = items.find((i) => i.newText === "controls:SettingsCard");
    assert.ok(card, `expected controls:SettingsCard; got ${JSON.stringify(items.map((i) => i.newText))}`);
    assert.ok(
      /CommunityToolkit\.WinUI\.Controls \(adds xmlns:controls\)/.test(card.detail || ""),
      `detail should name the namespace + the injected xmlns; got ${card.detail}`
    );
    assert.strictEqual(card.additionalTextEdits.length, 1, "exactly one additional edit (the xmlns injection)");
    const edit = card.additionalTextEdits[0];
    assert.strictEqual(edit.newText, XMLNS_EDIT, `the injected xmlns declaration; got ${edit.newText}`);
    // Pure zero-width insertion (never overwrites existing text).
    assert.deepStrictEqual(edit.range.start, edit.range.end, "the xmlns injection is a zero-width insertion");
  });

  it("also offers SettingsExpander with the same xmlns injection", async () => {
    const items = await h.completionEditsAt(page("<Grid><Sett|</Grid>"));
    const exp = items.find((i) => i.newText === "controls:SettingsExpander");
    assert.ok(exp, `expected controls:SettingsExpander; got ${JSON.stringify(items.map((i) => i.newText))}`);
    assert.strictEqual(exp.additionalTextEdits.length, 1, "SettingsExpander also injects the xmlns");
    assert.strictEqual(exp.additionalTextEdits[0].newText, XMLNS_EDIT);
  });

  it("filters third-party controls by the typed partial", async () => {
    const items = await h.completionEditsAt(page("<Grid><SettingsC|</Grid>"));
    const names = items.map((i) => i.newText).filter((t) => /^controls:/.test(t || ""));
    assert.ok(names.includes("controls:SettingsCard"), `SettingsC should match SettingsCard; got ${JSON.stringify(names)}`);
    assert.ok(!names.includes("controls:SettingsExpander"), `SettingsC must not match SettingsExpander; got ${JSON.stringify(names)}`);
  });

  it("reuses an already-declared prefix and injects NOTHING", async () => {
    const buf = pageWith(`xmlns:toolkit="using:${TOOLKIT_NS}"`, "<Grid><Sett|</Grid>");
    const items = await h.completionEditsAt(buf);
    const card = items.find((i) => i.newText === "toolkit:SettingsCard");
    assert.ok(card, `expected the declared prefix reused as toolkit:SettingsCard; got ${JSON.stringify(items.map((i) => i.newText))}`);
    assert.strictEqual(card.additionalTextEdits.length, 0, "a declared prefix needs NO xmlns injection");
    assert.strictEqual(card.detail, TOOLKIT_NS, `detail should be the bare namespace (no '(adds …)'); got ${card.detail}`);
    // And it must NOT ALSO offer a controls:-generated duplicate for the same type.
    assert.ok(!items.some((i) => i.newText === "controls:SettingsCard"), "must not double-offer a generated prefix when one is declared");
  });

  it("excludes non-DependencyObject referenced types (DI services stay out)", async () => {
    // "Serv" would match Microsoft.Extensions.DependencyInjection.ServiceCollection/ServiceProvider/…
    // if the DependencyObject-assignability filter were absent — a sharp, non-vacuous negative.
    const items = await h.completionEditsAt(page("<Grid><Serv|</Grid>"));
    const di = items.filter(
      (i) => /Service(Collection|Provider|Descriptor)/.test(i.newText || "") || /DependencyInjection/.test(i.detail || "")
    );
    assert.strictEqual(di.length, 0, `DI service types must never be offered as elements; got ${JSON.stringify(di)}`);
  });
});
