"use strict";

// Round 75 adversarial probes: resource-key completion in Setter.Value must infer the
// target type from Setter.Property + enclosing TargetType without hiding author keys.

const assert = require("node:assert");
const h = require("./helper");

function page(inner) {
  return `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage">
  ${inner}
</Page>`;
}

const BRUSH = "AccentFillColorDefaultBrush";
const TEXT_BRUSH = "TextFillColorPrimaryBrush";
const STYLE = "TitleTextBlockStyle";
const ACCENT_STYLE = "AccentButtonStyle";
const COLOR = "SystemAccentColor";
const COLOR_LIGHT = "SystemAccentColorLight1";
const CORNER = "ControlCornerRadius";
const OVERLAY_CORNER = "OverlayCornerRadius";
const APP_AUTHOR = "SmokeAccentBrush";
const LOCAL_BRUSH = "LocalRound75Brush";
const LOCAL_STYLE = "MyLocalRound75Style";

function styleSetter(targetType, setter, targetAttr = `TargetType="${targetType}"`) {
  return page(`<Page.Resources>
    <Style ${targetAttr}>
      ${setter}
    </Style>
  </Page.Resources>`);
}

function styleSettersSetter(targetType, setter) {
  return page(`<Page.Resources>
    <Style TargetType="${targetType}">
      <Style.Setters>
        ${setter}
      </Style.Setters>
    </Style>
  </Page.Resources>`);
}

function templateSetter(targetType, setter, targetAttr = `TargetType="${targetType}"`) {
  return page(`<Page.Resources>
    <ControlTemplate ${targetAttr}>
      ${setter}
    </ControlTemplate>
  </Page.Resources>`);
}

function withLocalResources(resourceChildren) {
  return page(`<Page.Resources>
    <SolidColorBrush x:Key="${LOCAL_BRUSH}" Color="Red" />
    <Style x:Key="${LOCAL_STYLE}" TargetType="Button" />
    ${resourceChildren}
  </Page.Resources>
  `);
}

async function resourceItemsAt(buffer) {
  return (await h.completionItemsAt(buffer)).filter((i) =>
    i.detail === "resource" || i.detail === "theme resource");
}

function labelsByDetail(items, detail) {
  return items.filter((i) => i.detail === detail).map((i) => i.label);
}

const themeLabels = (items) => labelsByDetail(items, "theme resource");
const authorLabels = (items) => labelsByDetail(items, "resource");
const summarize = (items) => JSON.stringify(items.map((i) => `${i.label}:${i.detail}`).slice(0, 160));

function assertHas(labels, want, note, items) {
  assert.ok(labels.includes(want), `${note}: expected ${want}; got ${items ? summarize(items) : JSON.stringify(labels)}`);
}

function assertLacks(labels, forbidden, note, items) {
  assert.ok(!labels.includes(forbidden), `${note}: must NOT offer ${forbidden}; got ${items ? summarize(items) : JSON.stringify(labels)}`);
}

async function assertThemeShape(buffer, note, present, absent = []) {
  const items = await resourceItemsAt(buffer);
  const labels = themeLabels(items);
  for (const want of present) assertHas(labels, want, note, items);
  for (const no of absent) assertLacks(labels, no, note, items);
  return items;
}

function assertAppAuthor(items, note) {
  assertHas(authorLabels(items), APP_AUTHOR, `${note}: App.xaml author key`, items);
}

describe("WinUI XAML red-team 75 — Setter.Value resource key completion", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("red-team 75 Foreground setter keeps Brush themes, hides Style/Color/CornerRadius themes, and keeps App author key", async () => {
    const items = await assertThemeShape(
      styleSetter("TextBlock", '<Setter Property="Foreground" Value="{StaticResource |}" />'),
      "TextBlock Setter Foreground",
      [BRUSH, TEXT_BRUSH],
      [STYLE, ACCENT_STYLE, COLOR, COLOR_LIGHT, CORNER, OVERLAY_CORNER]
    );
    assertAppAuthor(items, "TextBlock Setter Foreground");
  });

  it("red-team 75 CornerRadius setter keeps radius themes and rejects Brush/Style/Color themes", async () => {
    const items = await assertThemeShape(
      styleSetter("Border", '<Setter Property="CornerRadius" Value="{StaticResource |}" />'),
      "Border Setter CornerRadius",
      [CORNER, OVERLAY_CORNER],
      [BRUSH, TEXT_BRUSH, STYLE, ACCENT_STYLE, COLOR, COLOR_LIGHT]
    );
    assertAppAuthor(items, "Border Setter CornerRadius");
  });

  it("red-team 75 Style-property setter keeps Style themes and rejects Brush/Color/CornerRadius themes", async () => {
    const items = await assertThemeShape(
      styleSetter("Button", '<Setter Property="Style" Value="{StaticResource |}" />'),
      "Button Setter Style",
      [STYLE, ACCENT_STYLE],
      [BRUSH, TEXT_BRUSH, COLOR, COLOR_LIGHT, CORNER, OVERLAY_CORNER]
    );
    assertAppAuthor(items, "Button Setter Style");
  });

  it("red-team 75 document-local author keys are type-scoped by their declaring element type (round 78)", async () => {
    const buffer = withLocalResources(`
      <Style TargetType="TextBlock">
        <Setter Property="Foreground" Value="{StaticResource |}" />
      </Style>
    `);
    const items = await assertThemeShape(
      buffer,
      "local author keys under Brush-valued Setter",
      [BRUSH, TEXT_BRUSH],
      [STYLE, ACCENT_STYLE, COLOR, CORNER]
    );
    assertAppAuthor(items, "local author keys under Brush-valued Setter");
    // Round 78: the doc-local Brush key is Brush-compatible -> offered; the doc-local Style
    // key is type-incompatible with a Brush property -> hidden (App.xaml keys stay always-offered).
    const authors = authorLabels(items);
    assertHas(authors, LOCAL_BRUSH, "Brush-valued Setter: type-compatible local Brush author key", items);
    assertLacks(authors, LOCAL_STYLE, "Brush-valued Setter: type-incompatible local Style author key", items);
  });

  it("red-team 75 ThemeResource and CustomResource Setter.Value use the same type scoping as StaticResource", async () => {
    for (const ext of ["ThemeResource", "CustomResource"]) {
      const items = await assertThemeShape(
        styleSetter("TextBlock", `<Setter Property="Foreground" Value="{${ext} |}" />`),
        `${ext} TextBlock Setter Foreground`,
        [BRUSH, TEXT_BRUSH],
        [STYLE, COLOR, CORNER]
      );
      assertAppAuthor(items, `${ext} TextBlock Setter Foreground`);
    }
  });

  it("red-team 75 missing Setter.Property preserves offer-all fallback", async () => {
    await assertThemeShape(
      styleSetter("TextBlock", '<Setter Value="{StaticResource |}" />'),
      "Setter without Property",
      [BRUSH, TEXT_BRUSH, STYLE, ACCENT_STYLE, COLOR, COLOR_LIGHT, CORNER, OVERLAY_CORNER]
    );
  });

  it("red-team 75 bogus Setter.Property preserves offer-all fallback", async () => {
    await assertThemeShape(
      styleSetter("TextBlock", '<Setter Property="NoSuchProp" Value="{StaticResource |}" />'),
      "Setter with bogus Property",
      [BRUSH, TEXT_BRUSH, STYLE, ACCENT_STYLE, COLOR, COLOR_LIGHT, CORNER, OVERLAY_CORNER]
    );
  });

  it("red-team 75 unresolvable or absent TargetType preserves offer-all fallback", async () => {
    const probes = [
      ["bogus TargetType", styleSetter("local:Bogus", '<Setter Property="Foreground" Value="{StaticResource |}" />')],
      ["Setter outside Style", page('<Setter Property="Foreground" Value="{StaticResource |}" />')],
    ];
    for (const [name, buffer] of probes) {
      await assertThemeShape(buffer, name, [BRUSH, TEXT_BRUSH, STYLE, ACCENT_STYLE, COLOR, COLOR_LIGHT, CORNER, OVERLAY_CORNER]);
    }
  });

  it("red-team 75 Style.Setters nested Setter scopes identically to a direct Style child Setter", async () => {
    const items = await assertThemeShape(
      styleSettersSetter("TextBlock", '<Setter Property="Foreground" Value="{StaticResource |}" />'),
      "Style.Setters TextBlock Foreground",
      [BRUSH, TEXT_BRUSH],
      [STYLE, ACCENT_STYLE, COLOR, CORNER]
    );
    assertAppAuthor(items, "Style.Setters TextBlock Foreground");
  });

  it("red-team 75 ControlTemplate TargetType participates in Setter.Value type resolution", async () => {
    const items = await assertThemeShape(
      templateSetter("Button", '<Setter Property="Style" Value="{StaticResource |}" />'),
      "ControlTemplate Button Setter Style",
      [STYLE, ACCENT_STYLE],
      [BRUSH, TEXT_BRUSH, COLOR, CORNER]
    );
    assertAppAuthor(items, "ControlTemplate Button Setter Style");
  });

  it("red-team 75 TargetType x:Type wrapper resolves like bare TargetType", async () => {
    for (const [name, buffer] of [
      ["bare TargetType", styleSetter("TextBlock", '<Setter Property="Foreground" Value="{StaticResource |}" />')],
      ["x:Type TargetType", styleSetter("TextBlock", '<Setter Property="Foreground" Value="{StaticResource |}" />', 'TargetType="{x:Type TextBlock}"')],
    ]) {
      await assertThemeShape(buffer, name, [BRUSH, TEXT_BRUSH], [STYLE, ACCENT_STYLE, COLOR, CORNER]);
    }
  });

  it("red-team 75 dotted attached Grid.Row Setter.Value hides all typed framework themes and type-incompatible author keys but keeps App key", async () => {
    const items = await assertThemeShape(
      withLocalResources(`
        <Style TargetType="Button">
          <Setter Property="Grid.Row" Value="{StaticResource |}" />
        </Style>
      `),
      "attached Grid.Row Setter",
      [],
      [BRUSH, TEXT_BRUSH, STYLE, ACCENT_STYLE, COLOR, COLOR_LIGHT, CORNER, OVERLAY_CORNER]
    );
    assert.strictEqual(themeLabels(items).length, 0, `attached Grid.Row should hide all framework themes; got ${summarize(items)}`);
    assertAppAuthor(items, "attached Grid.Row Setter");
    // Round 78: Grid.Row is int; neither the doc-local Brush nor the doc-local Style key is
    // assignable to int, so both are hidden. Only the always-offered App.xaml key remains.
    const authors = authorLabels(items);
    assertLacks(authors, LOCAL_BRUSH, "attached Grid.Row Setter: type-incompatible local Brush author key", items);
    assertLacks(authors, LOCAL_STYLE, "attached Grid.Row Setter: type-incompatible local Style author key", items);
  });

  it("red-team 75 nested Binding Source StaticResource in Setter.Value is offer-all, not filtered by Setter target type", async () => {
    await assertThemeShape(
      styleSetter("TextBlock", '<Setter Property="Foreground" Value="{Binding Source={StaticResource |}}" />'),
      "nested StaticResource inside Binding Source",
      [BRUSH, TEXT_BRUSH, STYLE, ACCENT_STYLE, COLOR, COLOR_LIGHT, CORNER, OVERLAY_CORNER]
    );
  });

  it("red-team 75 non-Setter resource completion still type-scopes direct Brush attributes and offers all for Tag/nested Binding", async () => {
    await assertThemeShape(
      page('<Grid Background="{StaticResource |}" />'),
      "direct Grid.Background",
      [BRUSH, TEXT_BRUSH],
      [STYLE, ACCENT_STYLE, COLOR, CORNER]
    );
    await assertThemeShape(
      page('<Border Tag="{StaticResource |}" />'),
      "direct FrameworkElement.Tag",
      [BRUSH, TEXT_BRUSH, STYLE, ACCENT_STYLE, COLOR, COLOR_LIGHT, CORNER, OVERLAY_CORNER]
    );
    await assertThemeShape(
      page('<Grid Background="{Binding Source={StaticResource |}}" />'),
      "direct nested Binding.Source",
      [BRUSH, TEXT_BRUSH, STYLE, ACCENT_STYLE, COLOR, COLOR_LIGHT, CORNER, OVERLAY_CORNER]
    );
  });

  it("red-team 75 Setter.Value scalar, enum, and bool completions are not regressed", async () => {
    const align = await h.completionsAt(styleSetter("Button", '<Setter Property="HorizontalAlignment" Value="|" />'));
    assert.ok(align.includes("Center") && align.includes("Stretch"), `HorizontalAlignment Setter enum completion regressed; got ${JSON.stringify(align.slice(0, 80))}`);

    const enabled = await h.completionsAt(styleSetter("Button", '<Setter Property="IsEnabled" Value="|" />'));
    assert.ok(enabled.includes("True") && enabled.includes("False"), `IsEnabled Setter bool completion regressed; got ${JSON.stringify(enabled.slice(0, 80))}`);
  });

  it("red-team 75 partial filtering composes with Setter.Value type filtering", async () => {
    const accent = await assertThemeShape(
      styleSetter("TextBlock", '<Setter Property="Foreground" Value="{StaticResource Accent|}" />'),
      "Foreground Setter Accent partial",
      [BRUSH],
      [STYLE, COLOR, CORNER]
    );
    assertLacks(themeLabels(accent), ACCENT_STYLE, "Foreground Setter Accent partial must hide AccentButtonStyle", accent);

    const title = await assertThemeShape(
      styleSetter("TextBlock", '<Setter Property="Foreground" Value="{StaticResource Title|}" />'),
      "Foreground Setter Title partial",
      [],
      [STYLE]
    );
    assert.strictEqual(themeLabels(title).length, 0, `Title partial on Brush Setter should expose no framework themes; got ${summarize(title)}`);
  });

  it("red-team 75 identical Setter.Value requests are deterministic", async () => {
    const buffer = styleSetter("TextBlock", '<Setter Property="Foreground" Value="{StaticResource Accent|}" />');
    const shape = (items) => items.map((i) => [i.label, i.detail, i.newText]).sort();
    const first = shape(await resourceItemsAt(buffer));
    const second = shape(await resourceItemsAt(buffer));
    assert.deepStrictEqual(second, first, `Setter.Value resource completion should be deterministic; first=${JSON.stringify(first)} second=${JSON.stringify(second)}`);
  });

  it("red-team 75 malformed/unterminated Setter markup returns arrays and does not crash", async () => {
    const probes = [
      styleSetter("TextBlock", '<Setter Property="Foreground" Value="{StaticResource |"'),
      page(`<Page.Resources>
        <Style TargetType="TextBlock">
          <Setter Property="Foreground" Value="{StaticResource |}"
        </Style>
      </Page.Resources>`),
    ];
    for (const buffer of probes) {
      const items = await h.completionItemsAt(buffer);
      assert.ok(Array.isArray(items), `malformed Setter completion should return an array; got=${typeof items}`);
    }
  });
});
