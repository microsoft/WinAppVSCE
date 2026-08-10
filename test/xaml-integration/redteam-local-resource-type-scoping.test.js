"use strict";

// Type-scoped document-local resource keys.

const assert = require("node:assert");
const h = require("./helper");

function page(inner, extraNs = "") {
  return `<Page ${h.NS}${extraNs ? "\n    " + extraNs : ""}
    x:Class="SmokeFixture.SmokePage">
  ${inner}
</Page>`;
}

const APP_AUTHOR = "SmokeAccentBrush";
const BRUSH = "AccentFillColorDefaultBrush";
const TEXT_BRUSH = "TextFillColorPrimaryBrush";
const STYLE = "TitleTextBlockStyle";
const ACCENT_STYLE = "AccentButtonStyle";
const COLOR = "SystemAccentColor";
const CORNER = "ControlCornerRadius";

const LOCAL_BRUSH = "R78LocalBrush";
const LOCAL_STYLE = "R78LocalStyle";
const LOCAL_DOUBLE = "R78LocalDouble";
const LOCAL_STRING = "R78LocalString";
const LOCAL_UNKNOWN = "R78UnknownThing";
const LOCAL_PREFIXED_BRUSH = "R78PrefixedBrush";
const LOCAL_BOGUS_STYLE = "R78BogusTargetStyle";

function resources(extra = "") {
  return `<Page.Resources>
    <SolidColorBrush x:Key="${LOCAL_BRUSH}" Color="Red" />
    <Style x:Key="${LOCAL_STYLE}" TargetType="Button" />
    <x:Double x:Key="${LOCAL_DOUBLE}">42</x:Double>
    <x:String x:Key="${LOCAL_STRING}">hello</x:String>
    ${extra}
  </Page.Resources>`;
}

function withResources(use, extra = "", extraNs = "") {
  return page(`${resources(extra)}
  ${use}`, extraNs);
}

async function resourceItemsAt(buffer) {
  return (await h.completionItemsAt(buffer)).filter((i) =>
    i.detail === "resource" || i.detail === "theme resource");
}

function byDetail(items, detail) {
  return items.filter((i) => i.detail === detail).map((i) => i.label);
}

const authorLabels = (items) => byDetail(items, "resource");
const themeLabels = (items) => byDetail(items, "theme resource");
const shape = (items) => items.map((i) => ({ label: i.label, detail: i.detail })).slice(0, 200);

function fail(note, items, buffer, more = "") {
  assert.fail(`${note}${more}\nSERVER RESOURCE ITEMS=${JSON.stringify(shape(items))}\nBUFFER:\n${buffer}`);
}

function assertHas(labels, want, note, items, buffer) {
  if (!labels.includes(want)) fail(note, items, buffer, `\nexpected ${want}`);
}

function assertLacks(labels, forbidden, note, items, buffer) {
  if (labels.includes(forbidden)) fail(note, items, buffer, `\nforbidden ${forbidden}`);
}

async function itemsAndAuthors(buffer) {
  const items = await resourceItemsAt(buffer);
  return { items, authors: authorLabels(items), themes: themeLabels(items) };
}

function assertAppBoundary(authors, note, items, buffer) {
  assertHas(authors, APP_AUTHOR, `${note}: App.xaml key must remain untyped and offered`, items, buffer);
}

describe("WinUI XAML red-team 78 — document-local author-key type-scoping", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("red-team 78 offers doc-local SolidColorBrush on Brush targets and hides incompatible local keys", async () => {
    const buffer = withResources('<TextBlock Foreground="{StaticResource |}" />');
    const { items, authors } = await itemsAndAuthors(buffer);
    assertAppBoundary(authors, "Brush target", items, buffer);
    assertHas(authors, LOCAL_BRUSH, "Brush target must not false-hide local SolidColorBrush", items, buffer);
    assertLacks(authors, LOCAL_STYLE, "Brush target must hide local Style", items, buffer);
    assertLacks(authors, LOCAL_DOUBLE, "Brush target must hide local x:Double", items, buffer);
    assertLacks(authors, LOCAL_STRING, "Brush target must hide local x:String", items, buffer);
  });

  it("red-team 78 hides local Brush on Style, Color, CornerRadius, GridLength, and int targets without losing App key", async () => {
    const probes = [
      ["Style", '<Grid Style="{StaticResource |}" />', LOCAL_STYLE],
      ["Color", '<SolidColorBrush Color="{StaticResource |}" />', null],
      ["CornerRadius", '<Border CornerRadius="{StaticResource |}" />', null],
      ["GridLength", '<Grid><Grid.RowDefinitions><RowDefinition Height="{StaticResource |}" /></Grid.RowDefinitions></Grid>', null],
      ["int attached", '<Grid><Button Grid.Row="{StaticResource |}" /></Grid>', null],
    ];
    for (const [name, use, compatible] of probes) {
      const buffer = withResources(use);
      const { items, authors } = await itemsAndAuthors(buffer);
      assertAppBoundary(authors, name, items, buffer);
      assertLacks(authors, LOCAL_BRUSH, `${name}: incompatible local Brush must be hidden`, items, buffer);
      if (compatible) assertHas(authors, compatible, `${name}: compatible local key proves result is not globally empty`, items, buffer);
    }
  });

  it("red-team 78 scopes doc-local author keys identically for ThemeResource and CustomResource", async () => {
    for (const ext of ["ThemeResource", "CustomResource"]) {
      const buffer = withResources(`<TextBlock Foreground="{${ext} |}" />`);
      const { items, authors } = await itemsAndAuthors(buffer);
      assertAppBoundary(authors, ext, items, buffer);
      assertHas(authors, LOCAL_BRUSH, `${ext}: local Brush must be offered on Brush target`, items, buffer);
      assertLacks(authors, LOCAL_STYLE, `${ext}: local Style must be hidden on Brush target`, items, buffer);
    }
  });

  it("red-team 78 resolves x:Double and x:String intrinsic declaring element types", async () => {
    const width = withResources('<Button Width="{StaticResource |}" />');
    let r = await itemsAndAuthors(width);
    assertAppBoundary(r.authors, "Width double target", r.items, width);
    assertHas(r.authors, LOCAL_DOUBLE, "Width must offer local x:Double", r.items, width);
    assertLacks(r.authors, LOCAL_BRUSH, "Width must hide local Brush", r.items, width);
    assertLacks(r.authors, LOCAL_STRING, "Width must hide local x:String", r.items, width);

    const text = withResources('<TextBlock Text="{StaticResource |}" />');
    r = await itemsAndAuthors(text);
    assertAppBoundary(r.authors, "Text string target", r.items, text);
    assertHas(r.authors, LOCAL_STRING, "Text must offer local x:String", r.items, text);
    assertLacks(r.authors, LOCAL_DOUBLE, "Text must hide local x:Double", r.items, text);

    const brush = withResources('<TextBlock Foreground="{StaticResource |}" />');
    r = await itemsAndAuthors(brush);
    assertLacks(r.authors, LOCAL_DOUBLE, "Brush target must hide local x:Double", r.items, brush);
    assertLacks(r.authors, LOCAL_STRING, "Brush target must hide local x:String", r.items, brush);
    assertHas(r.authors, LOCAL_BRUSH, "Brush target paired presence", r.items, brush);
  });

  it("red-team 78 never type-scopes the App.xaml author key, even on incompatible targets", async () => {
    for (const [name, use] of [
      ["Style", '<Grid Style="{StaticResource |}" />'],
      ["Color", '<SolidColorBrush Color="{StaticResource |}" />'],
      ["CornerRadius", '<Border CornerRadius="{StaticResource |}" />'],
      ["int", '<Grid><Button Grid.Row="{StaticResource |}" /></Grid>'],
    ]) {
      const buffer = withResources(use);
      const { items, authors } = await itemsAndAuthors(buffer);
      assertHas(authors, APP_AUTHOR, `${name}: SmokeAccentBrush from App.xaml must be offered despite incompatible type`, items, buffer);
    }
  });

  it("red-team 78 offer-all fallback for object Tag keeps every doc-local author key", async () => {
    const buffer = withResources('<Border Tag="{StaticResource |}" />');
    const { items, authors } = await itemsAndAuthors(buffer);
    for (const key of [APP_AUTHOR, LOCAL_BRUSH, LOCAL_STYLE, LOCAL_DOUBLE, LOCAL_STRING]) {
      assertHas(authors, key, `Tag object target must offer ${key}`, items, buffer);
    }
  });

  it("red-team 78 offer-all fallback for unresolved Setter.Value and nested Binding Source keeps doc-local keys", async () => {
    for (const [name, buffer] of [
      ["Setter.Value without Property", withResources('<Style TargetType="TextBlock"><Setter Value="{StaticResource |}" /></Style>')],
      ["nested Binding Source", withResources('<TextBlock Foreground="{Binding Source={StaticResource |}}" />')],
    ]) {
      const { items, authors } = await itemsAndAuthors(buffer);
      for (const key of [APP_AUTHOR, LOCAL_BRUSH, LOCAL_STYLE, LOCAL_DOUBLE, LOCAL_STRING]) {
        assertHas(authors, key, `${name}: fallback must offer ${key}`, items, buffer);
      }
    }
  });

  it("red-team 78 preserves theme-key suppression when same-named doc-local author key is type-hidden", async () => {
    const buffer = withResources(
      '<TextBlock Foreground="{StaticResource Title|}" />',
      `<Style x:Key="${STYLE}" TargetType="TextBlock" />`
    );
    const { items, authors, themes } = await itemsAndAuthors(buffer);
    assertLacks(authors, STYLE, "same-named local Style should be hidden on Brush target", items, buffer);
    assertLacks(themes, STYLE, "framework theme key must stay suppressed by hidden same-named local author key", items, buffer);

    const control = withResources('<TextBlock Foreground="{StaticResource R78Local|}" />');
    const c = await itemsAndAuthors(control);
    assertHas(c.authors, LOCAL_BRUSH, "control proves Brush author completions are not globally empty", c.items, control);
    assertLacks(c.authors, LOCAL_STYLE, "control local Style hidden on Brush target", c.items, control);
  });

  it("red-team 78 Setter.Value scopes through Setter.Property to Brush and keeps App.xaml boundary", async () => {
    const buffer = withResources(`<Style TargetType="TextBlock">
    <Setter Property="Foreground" Value="{StaticResource |}" />
  </Style>`);
    const { items, authors, themes } = await itemsAndAuthors(buffer);
    assertHas(themes, BRUSH, "Setter Foreground should include Brush theme key", items, buffer);
    assertLacks(themes, STYLE, "Setter Foreground should hide Style theme key", items, buffer);
    assertAppBoundary(authors, "Setter Foreground", items, buffer);
    assertHas(authors, LOCAL_BRUSH, "Setter Foreground must offer local Brush", items, buffer);
    assertLacks(authors, LOCAL_STYLE, "Setter Foreground must hide local Style", items, buffer);
  });

  it("red-team 78 prefixed declaring element types resolve, and unknown declaring types are conservatively offered", async () => {
    const buffer = withResources(
      '<TextBlock Foreground="{StaticResource |}" />',
      `<m:SolidColorBrush x:Key="${LOCAL_PREFIXED_BRUSH}" Color="Green" />
    <missing:NoSuchType x:Key="${LOCAL_UNKNOWN}" />`,
      'xmlns:m="using:Microsoft.UI.Xaml.Media"\n    xmlns:missing="using:Definitely.Missing.Round78"'
    );
    const { items, authors } = await itemsAndAuthors(buffer);
    assertHas(authors, LOCAL_BRUSH, "control Brush key must be offered", items, buffer);
    assertHas(authors, LOCAL_PREFIXED_BRUSH, "prefixed Microsoft.UI.Xaml.Media.SolidColorBrush must be offered on Brush target", items, buffer);
    assertHas(authors, LOCAL_UNKNOWN, "unknown declaring element must be offered on doubt", items, buffer);
    assertLacks(authors, LOCAL_STYLE, "known local Style remains hidden on Brush target", items, buffer);
  });

  it("red-team 78 value-type Setter.Property (FontSize double) offers x:Double and hides Brush/Style", async () => {
    // The Brush Setter path is covered above; this pins the VALUE-TYPE Setter.Property branch so a compatible x:Double is never false-hidden when the target resolves through Setter.Property.
    const buffer = withResources(`<Style TargetType="TextBlock">
    <Setter Property="FontSize" Value="{StaticResource |}" />
  </Style>`);
    const { items, authors, themes } = await itemsAndAuthors(buffer);
    assertAppBoundary(authors, "Setter FontSize", items, buffer);
    assertHas(authors, LOCAL_DOUBLE, "Setter FontSize(double) must offer local x:Double", items, buffer);
    assertLacks(authors, LOCAL_BRUSH, "Setter FontSize(double) must hide local Brush", items, buffer);
    assertLacks(authors, LOCAL_STYLE, "Setter FontSize(double) must hide local Style", items, buffer);
    assertLacks(themes, BRUSH, "Setter FontSize(double) must hide Brush theme key", items, buffer);
  });

  it("red-team 78 control-instance key is offered on a base-typed property and hidden on a Brush property", async () => {
    // A <Button> resource used on Border.Child (typed UIElement) must be offered via real control-hierarchy bidirectional assignability — the worst outcome would be false-hiding a valid control resource.
    const extra = '<Button x:Key="R78LocalControl" />';
    const child = withResources('<Border Child="{StaticResource |}" />', extra);
    let r = await itemsAndAuthors(child);
    assertAppBoundary(r.authors, "Border.Child", r.items, child);
    assertHas(r.authors, "R78LocalControl", "Button (IS-A UIElement) must be offered on Border.Child", r.items, child);
    assertLacks(r.authors, LOCAL_BRUSH, "Brush must be hidden on UIElement Child target", r.items, child);
    assertLacks(r.authors, LOCAL_STYLE, "Style must be hidden on UIElement Child target", r.items, child);

    const brush = withResources('<TextBlock Foreground="{StaticResource |}" />', extra);
    r = await itemsAndAuthors(brush);
    assertLacks(r.authors, "R78LocalControl", "control Button must be hidden on a Brush property", r.items, brush);
    assertHas(r.authors, LOCAL_BRUSH, "Brush property paired presence", r.items, brush);
  });

  it("red-team 78 Style with bogus TargetType is still a Style resource, not an unresolved target fallback", async () => {
    const extra = `<Style x:Key="${LOCAL_BOGUS_STYLE}" TargetType="local:NoSuchRound78Type" />`;
    const brush = withResources('<TextBlock Foreground="{StaticResource |}" />', extra);
    let r = await itemsAndAuthors(brush);
    assertHas(r.authors, LOCAL_BRUSH, "Brush control key must be offered", r.items, brush);
    assertLacks(r.authors, LOCAL_BOGUS_STYLE, "Style with bogus TargetType must be hidden on Brush target", r.items, brush);

    const style = withResources('<Grid Style="{StaticResource |}" />', extra);
    r = await itemsAndAuthors(style);
    assertHas(r.authors, LOCAL_STYLE, "Style target must offer normal local Style", r.items, style);
    assertHas(r.authors, LOCAL_BOGUS_STYLE, "Style target must offer Style even with bogus TargetType", r.items, style);
  });

  it("red-team 78 unresolved target property falls back to offering all doc-local keys", async () => {
    const buffer = withResources('<Grid DefinitelyMissingRound78="{StaticResource |}" />');
    const { items, authors } = await itemsAndAuthors(buffer);
    for (const key of [APP_AUTHOR, LOCAL_BRUSH, LOCAL_STYLE, LOCAL_DOUBLE, LOCAL_STRING]) {
      assertHas(authors, key, `unresolved target property must offer ${key}`, items, buffer);
    }
  });

  it("red-team 78 framework theme keys still type-scope alongside doc-local author keys", async () => {
    const brush = withResources('<TextBlock Foreground="{StaticResource |}" />');
    let r = await itemsAndAuthors(brush);
    assertHas(r.themes, BRUSH, "Brush target should include Brush theme", r.items, brush);
    assertHas(r.themes, TEXT_BRUSH, "Brush target should include Text Brush theme", r.items, brush);
    assertLacks(r.themes, STYLE, "Brush target should hide Style theme", r.items, brush);
    assertLacks(r.themes, COLOR, "Brush target should hide Color theme", r.items, brush);
    assertHas(r.authors, LOCAL_BRUSH, "paired local Brush presence", r.items, brush);

    const style = withResources('<Grid Style="{StaticResource |}" />');
    r = await itemsAndAuthors(style);
    assertHas(r.themes, STYLE, "Style target should include Style theme", r.items, style);
    assertHas(r.themes, ACCENT_STYLE, "Style target should include Accent Style theme", r.items, style);
    assertLacks(r.themes, BRUSH, "Style target should hide Brush theme", r.items, style);
    assertHas(r.authors, LOCAL_STYLE, "paired local Style presence", r.items, style);
  });

  it("red-team 78 repeated identical buffers are deterministic for server resource items", async () => {
    const buffer = withResources('<TextBlock Foreground="{StaticResource R78|}" />');
    const normalize = (items) => items.map((i) => [i.label, i.detail, i.newText]).sort();
    const first = normalize(await resourceItemsAt(buffer));
    const second = normalize(await resourceItemsAt(buffer));
    assert.deepStrictEqual(second, first, `resource completions should be deterministic; first=${JSON.stringify(first)} second=${JSON.stringify(second)}\nBUFFER:\n${buffer}`);
  });

  it("red-team 78 malformed and unterminated markup returns arrays and does not crash", async () => {
    for (const [name, buffer] of [
      ["unterminated StaticResource", withResources('<TextBlock Foreground="{StaticResource |" />')],
      ["unterminated resource element", page(`<Page.Resources>
    <SolidColorBrush x:Key="${LOCAL_BRUSH}" Color="Red"
  </Page.Resources>
  <TextBlock Foreground="{StaticResource |}" />`)],
      ["unknown prefixed resource element", page(`<Page.Resources>
    <missing:NoSuchType x:Key="${LOCAL_UNKNOWN}" />
  </Page.Resources>
  <TextBlock Foreground="{StaticResource |}" />`, 'xmlns:missing="using:Definitely.Missing.Round78"')],
    ]) {
      const items = await h.completionItemsAt(buffer);
      assert.ok(Array.isArray(items), `${name}: completion should return an array\nBUFFER:\n${buffer}`);
    }
  });
});
