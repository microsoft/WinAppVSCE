"use strict";

// Round 34 red-team probes for Find All References (Shift+F12). These drive the
// REAL VS Code reference provider and target disambiguation, false positives,
// missed nested usages, range accuracy, ordering/deduping, and malformed input.

const assert = require("node:assert");
const h = require("./helper");

function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
}

function texts(refs) {
  return refs.map((r) => r.text);
}

function positions(refs) {
  return refs.map((r) => `${r.line}:${r.character}:${r.text}`);
}

function assertUnique(refs, why) {
  const seen = new Set();
  for (const r of refs) {
    const key = `${r.uri}:${r.line}:${r.character}:${r.text}`;
    assert.ok(!seen.has(key), `${why}: duplicate reference ${key}; got ${JSON.stringify(positions(refs))}`);
    seen.add(key);
  }
}

function assertSorted(refs, why) {
  const actual = positions(refs);
  const sorted = [...actual].sort((a, b) => {
    const [al, ac] = a.split(":").map(Number);
    const [bl, bc] = b.split(":").map(Number);
    return al - bl || ac - bc;
  });
  assert.deepStrictEqual(actual, sorted, `${why}: references should be sorted; got ${JSON.stringify(actual)}`);
}

function assertAllText(refs, expected, why) {
  assert.deepStrictEqual(texts(refs), expected, `${why}: got ${JSON.stringify(texts(refs))}`);
  assertUnique(refs, why);
  assertSorted(refs, why);
}

describe("WinUI XAML red-team 34 — references (Shift+F12)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("does not blend x:Name symbols that share a prefix", async () => {
    const refs = await h.referencesAt(page([
      "<StackPanel>",
      "  <Button x:Name=\"Go|Button\" Content=\"GoButton\" />",
      "  <Button x:Name=\"GoButton2\" />",
      "  <TextBlock Text=\"{Binding ElementName=GoButton}\" Tag=\"GoButton2\" />",
      "  <TextBlock Text=\"{Binding ElementName=GoButton2}\" />",
      "  <Storyboard>",
      "    <DoubleAnimation Storyboard.TargetName=\"GoButton\" Storyboard.TargetProperty=\"Opacity\" />",
      "    <DoubleAnimation Storyboard.TargetName=\"GoButton2\" Storyboard.TargetProperty=\"Opacity\" />",
      "  </Storyboard>",
      "</StackPanel>",
    ].join("\n  ")));
    assertAllText(refs, ["GoButton", "GoButton", "GoButton"], "GoButton should not include GoButton2 or plain strings");
  });

  it("finds bare Name declarations and multiple ElementName usages", async () => {
    const refs = await h.referencesAt(page([
      "<StackPanel>",
      "  <Grid Name=\"Bare|Panel\" />",
      "  <TextBlock Text=\"{Binding Path=ActualWidth, ElementName=BarePanel}\" />",
      "  <TextBlock Text=\"{Binding ElementName=BarePanel, Path=ActualHeight}\" />",
      "</StackPanel>",
    ].join("\n  ")));
    assertAllText(refs, ["BarePanel", "BarePanel", "BarePanel"], "bare Name declaration should be supported");
  });

  it("finds x:Name references from Storyboard.TargetName but not TargetProperty", async () => {
    const refs = await h.referencesAt(page([
      "<StackPanel>",
      "  <Button x:Name=\"GoButton\" />",
      "  <Storyboard>",
      "    <DoubleAnimation Storyboard.TargetName=\"Go|Button\" Storyboard.TargetProperty=\"GoButton\" />",
      "  </Storyboard>",
      "</StackPanel>",
    ].join("\n  ")));
    assertAllText(refs, ["GoButton", "GoButton"], "TargetName should resolve, TargetProperty string should not");
  });

  it("returns nothing from Storyboard.TargetProperty even when its value matches a name", async () => {
    const refs = await h.referencesAt(page([
      "<StackPanel>",
      "  <Button x:Name=\"GoButton\" />",
      "  <Storyboard>",
      "    <DoubleAnimation Storyboard.TargetName=\"GoButton\" Storyboard.TargetProperty=\"Go|Button\" />",
      "  </Storyboard>",
      "</StackPanel>",
    ].join("\n  ")));
    assert.strictEqual(refs.length, 0, `TargetProperty must not be a name reference; got ${JSON.stringify(texts(refs))}`);
  });

  it("finds ElementName inside a nested markup extension", async () => {
    const refs = await h.referencesAt(page([
      "<StackPanel>",
      "  <Page.Resources>",
      "    <SolidColorBrush x:Key=\"Brush1\" Color=\"Red\" />",
      "  </Page.Resources>",
      "  <Button x:Name=\"NestedButton\" />",
      "  <TextBlock Text=\"{Binding Source={StaticResource Brush1}, ElementName=Nested|Button, Path=Content}\" />",
      "</StackPanel>",
    ].join("\n  ")));
    assertAllText(refs, ["NestedButton", "NestedButton"], "nested Binding should still expose ElementName");
  });

  it("does not activate references from x: prefix, element type, or unrelated Content attribute", async () => {
    for (const [label, buffer] of [
      ["x prefix", page("<Button x|:Name=\"GoButton\" Content=\"GoButton\" />")],
      ["element type", page("<But|ton x:Name=\"GoButton\" Content=\"GoButton\" />")],
      ["Content value", page("<Button x:Name=\"GoButton\" Content=\"Go|Button\" />")],
    ]) {
      const refs = await h.referencesAt(buffer);
      assert.strictEqual(refs.length, 0, `${label} should not start a reference search; got ${JSON.stringify(texts(refs))}`);
    }
  });

  it("does not treat prefixed d:Name as a real x:Name or bare Name declaration", async () => {
    const refs = await h.referencesAt(page([
      "<StackPanel>",
      "  <Button d:Name=\"Design|Only\" />",
      "  <TextBlock Text=\"{Binding ElementName=DesignOnly}\" />",
      "</StackPanel>",
    ].join("\n  ")));
    assert.strictEqual(refs.length, 0, `d:Name is unsupported and must not resolve; got ${JSON.stringify(texts(refs))}`);
  });

  it("declaration-only x:Name returns exactly the declaration with includeDeclaration=true", async () => {
    const refs = await h.referencesAt(page("<Button x:Name=\"Lon|elyButton\" Content=\"no usages\" />"));
    assertAllText(refs, ["LonelyButton"], "declaration-only x:Name should return only itself");
  });

  it("empty and whitespace-only x:Name values are inert", async () => {
    for (const [label, buffer] of [
      ["empty", page("<Button x:Name=\"|\" />")],
      ["whitespace", page("<Button x:Name=\" |  \" />")],
    ]) {
      const refs = await h.referencesAt(buffer);
      assert.strictEqual(refs.length, 0, `${label} x:Name should not resolve; got ${JSON.stringify(texts(refs))}`);
    }
  });

  it("does not resolve when the caret is just outside a declaration value", async () => {
    for (const [label, buffer] of [
      ["before opening quote", page("<Button x:Name=|\"EdgeButton\" />")],
      ["after closing quote", page("<Button x:Name=\"EdgeButton\"| />")],
    ]) {
      const refs = await h.referencesAt(buffer);
      assert.strictEqual(refs.length, 0, `${label} should be outside the x:Name value; got ${JSON.stringify(texts(refs))}`);
    }
  });

  it("references do not blend resource keys that share a prefix", async () => {
    const refs = await h.referencesAt(page([
      "<Page.Resources>",
      "  <SolidColorBrush x:Key=\"Bru|sh1\" Color=\"Red\" />",
      "  <SolidColorBrush x:Key=\"Brush10\" Color=\"Blue\" />",
      "</Page.Resources>",
      "<StackPanel>",
      "  <Border Background=\"{StaticResource Brush1}\" Tag=\"Brush10\" />",
      "  <Border Background=\"{ThemeResource Brush10}\" />",
      "  <Border Background=\"{CustomResource Brush1}\" />",
      "</StackPanel>",
    ].join("\n  ")));
    assertAllText(refs, ["Brush1", "Brush1", "Brush1"], "Brush1 should not include Brush10 or plain strings");
  });

  it("finds resource keys from StaticResource, ThemeResource, CustomResource, and nested StaticResource", async () => {
    const refs = await h.referencesAt(page([
      "<Page.Resources>",
      "  <SolidColorBrush x:Key=\"Accent|Brush\" Color=\"Red\" />",
      "</Page.Resources>",
      "<StackPanel>",
      "  <Border Background=\"{StaticResource AccentBrush}\" />",
      "  <Border BorderBrush=\"{ThemeResource AccentBrush}\" />",
      "  <Border Tag=\"{CustomResource AccentBrush}\" />",
      "  <TextBlock Text=\"{Binding Source={StaticResource AccentBrush}, Path=Color}\" />",
      "</StackPanel>",
    ].join("\n  ")));
    assertAllText(refs, ["AccentBrush", "AccentBrush", "AccentBrush", "AccentBrush", "AccentBrush"], "all resource-family usages should be found");
  });

  it("finds a resource key from a nested StaticResource usage caret", async () => {
    const refs = await h.referencesAt(page([
      "<Page.Resources>",
      "  <SolidColorBrush x:Key=\"NestedBrush\" Color=\"Red\" />",
      "</Page.Resources>",
      "<TextBlock Text=\"{Binding Source={StaticResource Nested|Brush}, Path=Color}\" />",
    ].join("\n  ")));
    assertAllText(refs, ["NestedBrush", "NestedBrush"], "nested StaticResource caret should resolve to declaration and usage");
  });

  it("keeps x:Name and x:Key namespaces separated even when text matches", async () => {
    const refs = await h.referencesAt(page([
      "<Page.Resources>",
      "  <SolidColorBrush x:Key=\"Dup|Token\" Color=\"Red\" />",
      "</Page.Resources>",
      "<StackPanel>",
      "  <Button x:Name=\"DupToken\" />",
      "  <Border Background=\"{StaticResource DupToken}\" />",
      "  <TextBlock Text=\"{Binding ElementName=DupToken}\" />",
      "</StackPanel>",
    ].join("\n  ")));
    assertAllText(refs, ["DupToken", "DupToken"], "resource search should not include x:Name declaration/usages");
  });

  it("does not activate resource references from x:Key element type tag or markup extension name", async () => {
    for (const [label, buffer] of [
      ["resource element type", page([
        "<Page.Resources>",
        "  <Solid|ColorBrush x:Key=\"Brush1\" Color=\"Red\" />",
        "</Page.Resources>",
        "<Border Background=\"{StaticResource Brush1}\" />",
      ].join("\n  "))],
      ["extension name", page([
        "<Page.Resources>",
        "  <SolidColorBrush x:Key=\"Brush1\" Color=\"Red\" />",
        "</Page.Resources>",
        "<Border Background=\"{Static|Resource Brush1}\" />",
      ].join("\n  "))],
    ]) {
      const refs = await h.referencesAt(buffer);
      assert.strictEqual(refs.length, 0, `${label} should not resolve; got ${JSON.stringify(texts(refs))}`);
    }
  });

  it("x:Key markup-extension values such as x:Type are not treated as literal keys", async () => {
    const refs = await h.referencesAt(page([
      "<Page.Resources>",
      "  <Style x:Key=\"{x:Type But|ton}\" TargetType=\"Button\" />",
      "</Page.Resources>",
      "<Button Style=\"{StaticResource {x:Type Button}}\" />",
    ].join("\n  ")));
    assert.strictEqual(refs.length, 0, `markup-extension x:Key should not resolve; got ${JSON.stringify(texts(refs))}`);
  });

  it("resolves resource-key references across project files (App.xaml declaration + other pages)", async () => {
    // ROUND 79: resource keys are PROJECT-WIDE. A usage of SmokeAccentBrush (declared in App.xaml, used in
    // SmokePage + DiPage) resolves references across every project XAML file (read-only), not just the open
    // document — and must never surface a bin/obj build-output copy.
    const refs = await h.referencesAt(page([
      "<StackPanel>",
      "  <Border Background=\"{StaticResource SmokeAccent|Brush}\" />",
      "  <Border BorderBrush=\"{ThemeResource SmokeAccentBrush}\" />",
      "</StackPanel>",
    ].join("\n  ")));
    const endsWith = (needle) => refs.filter((r) => r.fsPath.toLowerCase().endsWith(needle)).length;
    assert.ok(
      !refs.some((r) => /[\\/]obj[\\/]/i.test(r.fsPath)),
      `references must exclude build-output (obj) copies; got ${JSON.stringify(refs.map((r) => r.fsPath))}`
    );
    assert.strictEqual(refs.length, 4, `expected 4 project-wide references (2 in-buffer + App.xaml decl + DiPage usage); got ${refs.length}: ${JSON.stringify(refs.map((r) => r.fsPath))}`);
    assert.strictEqual(endsWith("app.xaml"), 1, `expected the App.xaml declaration in scope; got ${JSON.stringify(refs.map((r) => r.fsPath))}`);
    assert.strictEqual(endsWith("dipage.xaml"), 1, `expected the DiPage usage in scope; got ${JSON.stringify(refs.map((r) => r.fsPath))}`);
    assert.strictEqual(
      refs.filter((r) => r.fsPath === h.getDoc().uri.fsPath).length, 2,
      `expected the 2 in-buffer usages; got ${JSON.stringify(refs.map((r) => r.fsPath))}`
    );
  });

  it("malformed or unterminated markup extensions do not crash or invent references", async () => {
    for (const [label, buffer] of [
      ["unterminated ElementName", page("<TextBlock Text=\"{Binding ElementName=G|o\" />")],
      ["unterminated StaticResource", page("<Border Background=\"{StaticResource Bru|sh1\" />")],
      ["no names or keys", page("<StackPanel><TextBlock Text=\"hel|lo\" /></StackPanel>")],
    ]) {
      const refs = await h.referencesAt(buffer);
      assert.strictEqual(refs.length, 0, `${label} should be graceful empty; got ${JSON.stringify(texts(refs))}`);
    }
  });
});
