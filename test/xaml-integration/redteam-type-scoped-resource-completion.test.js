"use strict";

// Type-scoped resource completion without hiding valid keys.

const assert = require("node:assert");
const h = require("./helper");

function page(inner) {
  return `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage">
  ${inner}
</Page>`;
}

const BRUSH = "AccentFillColorDefaultBrush";
const TEXT_BRUSH = "AccentTextFillColorPrimaryBrush";
const STYLE = "AccentButtonStyle";
const ACCENT_STYLE = "AlternateCloseButtonStyle";
const TITLE_STYLE = "TitleTextBlockStyle";
const COLOR = "ControlFillColorDefault";
const COLOR_LIGHT = "ControlFillColorSecondary";
const CORNER = "ControlCornerRadius";
const OVERLAY_CORNER = "OverlayCornerRadius";
const APP_AUTHOR = "SmokeAccentBrush";
const LOCAL_AUTHOR = "LocalRound74Brush";
const ACCENT_AUTHOR = "AccentLocalRound74Brush";

function byDetail(items, detail) {
  return items.filter((i) => i.detail === detail).map((i) => i.label);
}

function themeLabels(items) {
  return byDetail(items, "theme resource");
}

function authorLabels(items) {
  return byDetail(items, "resource");
}

function summarize(items) {
  return JSON.stringify(items.map((i) => `${i.label}:${i.detail}`).slice(0, 120));
}

async function resourceItemsAt(buffer) {
  return (await h.completionItemsAt(buffer)).filter((i) =>
    i.detail === "resource" || i.detail === "theme resource");
}

function assertHas(labels, want, note, items) {
  if (!labels.includes(want)) {
    assert.fail(`${note}: expected ${want}; got ${items ? summarize(items) : JSON.stringify(labels)}`);
  }
}

function assertLacks(labels, forbidden, note, items) {
  if (labels.includes(forbidden)) {
    assert.fail(`${note}: must NOT offer ${forbidden}; got ${items ? summarize(items) : JSON.stringify(labels)}`);
  }
}

async function assertThemeShape(buffer, note, present, absent = []) {
  const items = await resourceItemsAt(buffer);
  const labels = themeLabels(items);
  for (const want of present) assertHas(labels, want, note, items);
  for (const no of absent) assertLacks(labels, no, note, items);
  return items;
}

function withLocalResource(use) {
  return page([
    "<Page.Resources>",
    `  <SolidColorBrush x:Key="${LOCAL_AUTHOR}" Color="Red" />`,
    `  <SolidColorBrush x:Key="${ACCENT_AUTHOR}" Color="Blue" />`,
    "</Page.Resources>",
    use,
  ].join("\n  "));
}

describe("WinUI XAML red-team 74 — type-scoped resource key completion", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("red-team 74 Brush properties keep framework Brush keys and reject non-Brush theme keys", async () => {
    const probes = [
      ["TextBlock.Foreground", '<TextBlock Foreground="{StaticResource |}" />'],
      ["Grid.Background", '<Grid Background="{StaticResource |}" />'],
      ["Border.BorderBrush", '<Border BorderBrush="{StaticResource |}" />'],
      ["Rectangle.Fill", '<Rectangle Fill="{StaticResource |}" />'],
      ["Rectangle.Stroke", '<Rectangle Stroke="{StaticResource |}" />'],
      ["Control.Foreground", '<Button Foreground="{StaticResource |}" />'],
    ];
    for (const [name, inner] of probes) {
      await assertThemeShape(page(inner), name, [BRUSH, TEXT_BRUSH, COLOR], [STYLE, CORNER]);
    }
  });

  it("red-team 74 Style properties keep framework Style keys and reject Brush/Color/CornerRadius keys", async () => {
    await assertThemeShape(
      page('<Grid Style="{StaticResource |}" />'),
      "FrameworkElement.Style",
      [STYLE, ACCENT_STYLE],
      [BRUSH, TEXT_BRUSH, CORNER]
    );
  });

  it("red-team 74 Color properties keep framework Color keys and reject Brush/Style/CornerRadius keys", async () => {
    const probes = [
      ["SolidColorBrush.Color", '<Grid><Grid.Background><SolidColorBrush Color="{StaticResource |}" /></Grid.Background></Grid>'],
      ["GradientStop.Color", '<LinearGradientBrush><GradientStop Offset="0" Color="{StaticResource |}" /></LinearGradientBrush>'],
    ];
    for (const [name, inner] of probes) {
      await assertThemeShape(page(inner), name, [COLOR, COLOR_LIGHT], [BRUSH, TEXT_BRUSH, STYLE, CORNER]);
    }
  });

  it("red-team 74 CornerRadius properties keep framework radius keys and reject Brush/Style/Color keys", async () => {
    await assertThemeShape(
      page('<Border CornerRadius="{StaticResource |}" />'),
      "Border.CornerRadius",
      [CORNER, OVERLAY_CORNER],
      [BRUSH, TEXT_BRUSH, STYLE]
    );
  });

  it("red-team 74 unrelated GridLength targets hide typed framework keys and type-incompatible author keys but keep the App key", async () => {
    const probes = [
      ["RowDefinition.Height", '<Grid><Grid.RowDefinitions><RowDefinition Height="{StaticResource |}" /></Grid.RowDefinitions></Grid>'],
      ["ColumnDefinition.Width", '<Grid><Grid.ColumnDefinitions><ColumnDefinition Width="{StaticResource |}" /></Grid.ColumnDefinitions></Grid>'],
    ];
    for (const [name, inner] of probes) {
      const items = await assertThemeShape(withLocalResource(inner), name, [COLOR], [BRUSH, TEXT_BRUSH, STYLE, ACCENT_STYLE, CORNER, OVERLAY_CORNER]);
      assertHas(authorLabels(items), APP_AUTHOR, `${name}: App author key must still be conservative`, items);
      // The document-local Brush key is not assignable to GridLength.
      assertLacks(authorLabels(items), LOCAL_AUTHOR, `${name}: type-incompatible local Brush author key`, items);
    }
  });

  it("red-team 74 document-local author keys are type-scoped by declaring element type; App keys stay conservative (round 78)", async () => {
    // The two doc-local author keys are both <SolidColorBrush> (Brush) -> offered on a Brush target, hidden on incompatible Style/Color/CornerRadius targets. The App.xaml key is NEVER type-scoped (arrives as a bare string with no declaring element).
    const probes = [
      ["Brush target", '<TextBlock Foreground="{StaticResource |}" />', true],
      ["Style target", '<Grid Style="{StaticResource |}" />', false],
      ["Color target", '<SolidColorBrush Color="{StaticResource |}" />', false],
      ["CornerRadius target", '<Border CornerRadius="{StaticResource |}" />', false],
    ];
    for (const [name, inner, brushCompatible] of probes) {
      const items = await resourceItemsAt(withLocalResource(inner));
      const authors = authorLabels(items);
      assertHas(authors, APP_AUTHOR, `${name}: App.xaml author key must always be offered`, items);
      if (brushCompatible) {
        assertHas(authors, LOCAL_AUTHOR, `${name}: type-compatible local Brush author key`, items);
        assertHas(authors, ACCENT_AUTHOR, `${name}: second type-compatible local Brush author key`, items);
      } else {
        assertLacks(authors, LOCAL_AUTHOR, `${name}: type-incompatible local Brush author key`, items);
        assertLacks(authors, ACCENT_AUTHOR, `${name}: second type-incompatible local Brush author key`, items);
      }
    }
  });

  it("red-team 74 partial filtering composes with the type filter and keeps matching author keys", async () => {
    const accent = await assertThemeShape(
      withLocalResource('<TextBlock Foreground="{StaticResource Accent|}" />'),
      "Brush target with Accent partial",
      [BRUSH],
      [STYLE, CORNER]
    );
    assertHas(authorLabels(accent), ACCENT_AUTHOR, "Accent partial should still include matching local author key", accent);
    assertLacks(authorLabels(accent), APP_AUTHOR, "Accent partial should filter nonmatching App author key", accent);
    assertLacks(authorLabels(accent), LOCAL_AUTHOR, "Accent partial should filter nonmatching local author key", accent);

    const styleOnBrush = await assertThemeShape(
      withLocalResource('<TextBlock Foreground="{StaticResource Local|}" />'),
      "Brush target with Local partial",
      [],
      [STYLE, ACCENT_STYLE]
    );
    assertHas(authorLabels(styleOnBrush), LOCAL_AUTHOR, "Type-compatible local Brush author key survives partial + type filtering on a Brush target", styleOnBrush);

    const noTheme = await assertThemeShape(
      withLocalResource('<TextBlock Foreground="{StaticResource Title|}" />'),
      "Brush target with Style partial",
      [],
      [TITLE_STYLE]
    );
    assertLacks(themeLabels(noTheme), TITLE_STYLE, "Title partial should hide the incompatible Style", noTheme);
  });

  it("red-team 74 ThemeResource and CustomResource use the same type-scoped key rules as StaticResource", async () => {
    for (const ext of ["ThemeResource", "CustomResource"]) {
      await assertThemeShape(
        page(`<TextBlock Foreground="{${ext} |}" />`),
        `${ext} Brush target`,
        [BRUSH, TEXT_BRUSH, COLOR],
        [STYLE, CORNER]
      );
      await assertThemeShape(
        page(`<Grid Style="{${ext} |}" />`),
        `${ext} Style target`,
        [STYLE, ACCENT_STYLE, COLOR],
        [BRUSH, CORNER]
      );
    }
  });

  it("red-team 74 object-typed Tag and untyped Setter.Value offer every framework theme key", async () => {
    const probes = [
      ["FrameworkElement.Tag", '<Border Tag="{StaticResource |}" />'],
      ["Setter.Value without resolvable Property", '<Page.Resources><Style TargetType="Button"><Setter Value="{StaticResource |}" /></Style></Page.Resources>'],
    ];
    for (const [name, inner] of probes) {
      await assertThemeShape(page(inner), name, [BRUSH, TEXT_BRUSH, STYLE, ACCENT_STYLE, COLOR, COLOR_LIGHT, CORNER, OVERLAY_CORNER]);
    }
  });

  it("red-team 74 nested resource inside Binding.Source is not filtered by the outer attribute type", async () => {
    await assertThemeShape(
      page('<TextBlock Foreground="{Binding Source={StaticResource |}}" />'),
      "nested Binding.Source resource under Brush-valued Foreground",
      [BRUSH, TEXT_BRUSH, STYLE, ACCENT_STYLE, COLOR, COLOR_LIGHT, CORNER, OVERLAY_CORNER]
    );
  });

  it("red-team 74 unresolved, prefixed directive, and malformed targets offer all framework theme keys", async () => {
    const probes = [
      ["unknown element", '<DefinitelyMissing74 Background="{StaticResource |}" />'],
      ["unknown attribute", '<Grid DefinitelyMissing74="{StaticResource |}" />'],
      ["x:directive attribute", '<Grid x:Name="{StaticResource |}" />'],
      ["malformed unknown element", '<DefinitelyMissing74 Background="{StaticResource |}"'],
    ];
    for (const [name, inner] of probes) {
      await assertThemeShape(page(inner), name, [BRUSH, TEXT_BRUSH, STYLE, ACCENT_STYLE, COLOR, COLOR_LIGHT, CORNER, OVERLAY_CORNER]);
    }
  });

  it("red-team 74 repeated identical requests are deterministic", async () => {
    const buffer = page('<TextBlock Foreground="{StaticResource Accent|}" />');
    const shape = (items) => items.map((i) => [i.label, i.detail, i.newText]).sort();
    const first = shape(await resourceItemsAt(buffer));
    const second = shape(await resourceItemsAt(buffer));
    assert.deepStrictEqual(second, first, `completion should be deterministic; first=${JSON.stringify(first)} second=${JSON.stringify(second)}`);
  });

  it("red-team 74 non-resource completion surfaces are not disturbed", async () => {
    const bind = await h.completionsAt(page('<TextBlock Text="{x:Bind Gre|}" />'));
    assert.ok(bind.includes("GreetingText"), `x:Bind member completion regressed; got ${bind.slice(0, 80).join(", ")}`);

    const enumItems = await h.completionsAt(page('<Button HorizontalAlignment="|" />'));
    assert.ok(enumItems.includes("Center") && enumItems.includes("Stretch"), `enum completion regressed; got ${enumItems.slice(0, 80).join(", ")}`);

    const boolItems = await h.completionsAt(page('<Button IsEnabled="|" />'));
    assert.ok(boolItems.includes("True") && boolItems.includes("False"), `bool completion regressed; got ${boolItems.slice(0, 80).join(", ")}`);

    const colorItems = (await h.completionItemsAt(page('<TextBlock Foreground="Corn|" />'))).filter((i) => i.detail === "named color");
    const colorLabels = colorItems.map((i) => i.label);
    assert.ok(colorLabels.includes("CornflowerBlue") && colorLabels.includes("Cornsilk"), `named-color completion regressed; got ${JSON.stringify(colorItems)}`);
  });
});
