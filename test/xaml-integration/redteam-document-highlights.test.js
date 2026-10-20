"use strict";

// Document-highlight kinds, ranges, malformed markup, and false positives.

const assert = require("node:assert");
const h = require("./helper");

const READ = 1;
const WRITE = 2;

function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
}

function texts(hls) {
  return hls.map((x) => x.text);
}

function positions(hls) {
  return hls.map((x) => `${x.line}:${x.character}:${x.kind}:${x.text}`);
}

function spanKey(x) {
  return `${x.line}:${x.character}:${x.text}`;
}

function assertUnique(hls, why) {
  const seen = new Set();
  for (const x of hls) {
    const key = spanKey(x);
    assert.ok(!seen.has(key), `${why}: duplicate highlight ${key}; got ${JSON.stringify(positions(hls))}`);
    seen.add(key);
  }
}

function assertSorted(hls, why) {
  const actual = positions(hls);
  const sorted = [...actual].sort((a, b) => {
    const [al, ac] = a.split(":").map(Number);
    const [bl, bc] = b.split(":").map(Number);
    return al - bl || ac - bc;
  });
  assert.deepStrictEqual(actual, sorted, `${why}: highlights should be sorted; got ${JSON.stringify(actual)}`);
}

function assertKinds(hls, expectedWrites, expectedReads, why) {
  assert.strictEqual(
    hls.filter((x) => x.kind === WRITE).length,
    expectedWrites,
    `${why}: expected ${expectedWrites} Write highlights; got ${JSON.stringify(positions(hls))}`
  );
  assert.strictEqual(
    hls.filter((x) => x.kind === READ).length,
    expectedReads,
    `${why}: expected ${expectedReads} Read highlights; got ${JSON.stringify(positions(hls))}`
  );
  assert.ok(
    hls.every((x) => x.kind === WRITE || x.kind === READ),
    `${why}: server name/key highlights should only be Read/Write; got ${JSON.stringify(positions(hls))}`
  );
}

function assertTextsKinds(hls, expectedTexts, expectedKinds, why) {
  assert.deepStrictEqual(texts(hls), expectedTexts, `${why}: got texts ${JSON.stringify(texts(hls))}`);
  assert.deepStrictEqual(hls.map((x) => x.kind), expectedKinds, `${why}: got ${JSON.stringify(positions(hls))}`);
  assertUnique(hls, why);
  assertSorted(hls, why);
}

async function assertNoServerSymbolHighlight(buffer, forbiddenTexts, why) {
  const hls = await h.highlightsAt(buffer);
  const symbolHits = hls.filter((x) => x.kind === WRITE || (x.kind === READ && forbiddenTexts.includes(x.text)));
  assert.deepStrictEqual(
    symbolHits,
    [],
    `${why}: server should add no Read/Write symbol highlight; got ${JSON.stringify(positions(hls))}`
  );
}

describe("WinUI XAML red-team 35 — document highlights", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("keeps x:Name kind mapping stable from a declaration caret", async () => {
    const hls = await h.highlightsAt(page([
      "<StackPanel>",
      "  <Button x:Name=\"Go|Button\" Content=\"Go\" />",
      "  <TextBlock Text=\"{Binding ElementName=GoButton}\" />",
      "  <Storyboard>",
      "    <DoubleAnimation Storyboard.TargetName=\"GoButton\" Storyboard.TargetProperty=\"Opacity\" />",
      "  </Storyboard>",
      "</StackPanel>",
    ].join("\n  ")));
    assertTextsKinds(hls, ["GoButton", "GoButton", "GoButton"], [WRITE, READ, READ], "x:Name declaration caret");
    assertKinds(hls, 1, 2, "x:Name declaration caret");
  });

  it("returns the same x:Name spans and kinds from an ElementName usage caret", async () => {
    const body = [
      "<StackPanel>",
      "  <Button x:Name=\"GoButton\" Content=\"Go\" />",
      "  <TextBlock Text=\"{Binding ElementName=Go|Button}\" />",
      "  <Storyboard>",
      "    <DoubleAnimation Storyboard.TargetName=\"GoButton\" Storyboard.TargetProperty=\"Opacity\" />",
      "  </Storyboard>",
      "</StackPanel>",
    ].join("\n  ");
    const hls = await h.highlightsAt(page(body));
    assertTextsKinds(hls, ["GoButton", "GoButton", "GoButton"], [WRITE, READ, READ], "x:Name ElementName usage caret");
  });

  it("returns exactly one Write for a declaration-only x:Name", async () => {
    const hls = await h.highlightsAt(page("<Button x:Name=\"Lon|elyButton\" Content=\"no usages\" />"));
    assertTextsKinds(hls, ["LonelyButton"], [WRITE], "declaration-only x:Name");
  });

  it("returns a dangling ElementName usage as Read with no invented Write", async () => {
    const hls = await h.highlightsAt(page([
      "<StackPanel>",
      "  <TextBlock Text=\"{Binding ElementName=Gh|ost}\" />",
      "  <TextBlock Text=\"{Binding ElementName=Ghost}\" />",
      "</StackPanel>",
    ].join("\n  ")));
    assertTextsKinds(hls, ["Ghost", "Ghost"], [READ, READ], "dangling ElementName usage");
    assertKinds(hls, 0, 2, "dangling ElementName usage");
  });

  it("supports bare Name declarations with Write/Read kinds", async () => {
    const hls = await h.highlightsAt(page([
      "<StackPanel>",
      "  <Grid Name=\"Bare|Panel\" />",
      "  <TextBlock Text=\"{Binding Path=ActualWidth, ElementName=BarePanel}\" />",
      "  <TextBlock Text=\"{Binding ElementName=BarePanel, Path=ActualHeight}\" />",
      "</StackPanel>",
    ].join("\n  ")));
    assertTextsKinds(hls, ["BarePanel", "BarePanel", "BarePanel"], [WRITE, READ, READ], "bare Name declaration");
  });

  it("does not blend x:Name symbols that share a prefix or appear in plain strings", async () => {
    const hls = await h.highlightsAt(page([
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
    assertTextsKinds(hls, ["GoButton", "GoButton", "GoButton"], [WRITE, READ, READ], "prefix-sharing x:Name");
  });

  it("finds ElementName inside nested markup extensions without changing kinds", async () => {
    const hls = await h.highlightsAt(page([
      "<StackPanel>",
      "  <Button x:Name=\"NestedButton\" />",
      "  <TextBlock Text=\"{Binding Source={StaticResource MissingBrush}, ElementName=Nested|Button, Path=Content}\" />",
      "</StackPanel>",
    ].join("\n  ")));
    assertTextsKinds(hls, ["NestedButton", "NestedButton"], [WRITE, READ], "nested ElementName");
  });

  it("keeps x:Name and x:Key namespaces separated when the literal text matches", async () => {
    const nameHls = await h.highlightsAt(page([
      "<Page.Resources>",
      "  <SolidColorBrush x:Key=\"DupToken\" Color=\"Red\" />",
      "</Page.Resources>",
      "<StackPanel>",
      "  <Button x:Name=\"Dup|Token\" />",
      "  <Border Background=\"{StaticResource DupToken}\" />",
      "  <TextBlock Text=\"{Binding ElementName=DupToken}\" />",
      "</StackPanel>",
    ].join("\n  ")));
    assertTextsKinds(nameHls, ["DupToken", "DupToken"], [WRITE, READ], "same literal x:Name caret");

    const keyHls = await h.highlightsAt(page([
      "<Page.Resources>",
      "  <SolidColorBrush x:Key=\"Dup|Token\" Color=\"Red\" />",
      "</Page.Resources>",
      "<StackPanel>",
      "  <Button x:Name=\"DupToken\" />",
      "  <Border Background=\"{StaticResource DupToken}\" />",
      "  <TextBlock Text=\"{Binding ElementName=DupToken}\" />",
      "</StackPanel>",
    ].join("\n  ")));
    assertTextsKinds(keyHls, ["DupToken", "DupToken"], [WRITE, READ], "same literal x:Key caret");
  });

  it("treats Storyboard.TargetName as Read and Storyboard.TargetProperty as inert", async () => {
    const hls = await h.highlightsAt(page([
      "<StackPanel>",
      "  <Button x:Name=\"GoButton\" />",
      "  <Storyboard>",
      "    <DoubleAnimation Storyboard.TargetName=\"Go|Button\" Storyboard.TargetProperty=\"GoButton\" />",
      "  </Storyboard>",
      "</StackPanel>",
    ].join("\n  ")));
    assertTextsKinds(hls, ["GoButton", "GoButton"], [WRITE, READ], "Storyboard.TargetName");

    await assertNoServerSymbolHighlight(page([
      "<StackPanel>",
      "  <Button x:Name=\"GoButton\" />",
      "  <Storyboard>",
      "    <DoubleAnimation Storyboard.TargetName=\"GoButton\" Storyboard.TargetProperty=\"Go|Button\" />",
      "  </Storyboard>",
      "</StackPanel>",
    ].join("\n  ")), ["GoButton"], "Storyboard.TargetProperty");
  });

  it("does not resolve unrelated attribute values or include them in the real x:Name result", async () => {
    await assertNoServerSymbolHighlight(
      page("<StackPanel><Button x:Name=\"GoButton\" Content=\"Go|Button\" /></StackPanel>"),
      ["GoButton"],
      "Content attribute caret"
    );

    const hls = await h.highlightsAt(page([
      "<StackPanel>",
      "  <Button x:Name=\"Go|Button\" Content=\"GoButton\" />",
      "  <TextBlock Text=\"{Binding ElementName=GoButton}\" />",
      "</StackPanel>",
    ].join("\n  ")));
    assertTextsKinds(hls, ["GoButton", "GoButton"], [WRITE, READ], "x:Name should not include Content string");
  });

  it("does not treat d:Name as a real declaration", async () => {
    await assertNoServerSymbolHighlight(page([
      "<StackPanel>",
      "  <Button d:Name=\"Design|Only\" />",
      "  <TextBlock Text=\"{Binding ElementName=DesignOnly}\" />",
      "</StackPanel>",
    ].join("\n  ")), ["DesignOnly"], "design-time d:Name");
  });

  it("keeps resource key kind mapping stable from a declaration caret", async () => {
    const hls = await h.highlightsAt(page([
      "<Page.Resources>",
      "  <SolidColorBrush x:Key=\"Bru|sh1\" Color=\"Red\" />",
      "</Page.Resources>",
      "<StackPanel>",
      "  <Border Background=\"{StaticResource Brush1}\" />",
      "  <Border BorderBrush=\"{ThemeResource Brush1}\" />",
      "  <Border Tag=\"{CustomResource Brush1}\" />",
      "</StackPanel>",
    ].join("\n  ")));
    assertTextsKinds(hls, ["Brush1", "Brush1", "Brush1", "Brush1"], [WRITE, READ, READ, READ], "resource declaration caret");
  });

  it("returns the same resource spans and kinds from a usage caret", async () => {
    const hls = await h.highlightsAt(page([
      "<Page.Resources>",
      "  <SolidColorBrush x:Key=\"Brush1\" Color=\"Red\" />",
      "</Page.Resources>",
      "<StackPanel>",
      "  <Border Background=\"{StaticResource Bru|sh1}\" />",
      "  <Border BorderBrush=\"{ThemeResource Brush1}\" />",
      "  <Border Tag=\"{CustomResource Brush1}\" />",
      "</StackPanel>",
    ].join("\n  ")));
    assertTextsKinds(hls, ["Brush1", "Brush1", "Brush1", "Brush1"], [WRITE, READ, READ, READ], "resource usage caret");
  });

  it("highlights do not blend resource keys that share a prefix", async () => {
    const hls = await h.highlightsAt(page([
      "<Page.Resources>",
      "  <SolidColorBrush x:Key=\"Bru|sh1\" Color=\"Red\" />",
      "  <SolidColorBrush x:Key=\"Brush10\" Color=\"Blue\" />",
      "</Page.Resources>",
      "<StackPanel>",
      "  <Border Background=\"{StaticResource Brush1}\" Tag=\"Brush10\" />",
      "  <Border Background=\"{ThemeResource Brush10}\" />",
      "  <Border Tag=\"{CustomResource Brush1}\" />",
      "</StackPanel>",
    ].join("\n  ")));
    assertTextsKinds(hls, ["Brush1", "Brush1", "Brush1"], [WRITE, READ, READ], "prefix-sharing resource key");
  });

  it("finds nested StaticResource usages and preserves Read/Write kinds", async () => {
    const hls = await h.highlightsAt(page([
      "<Page.Resources>",
      "  <SolidColorBrush x:Key=\"AccentBrush\" Color=\"Red\" />",
      "</Page.Resources>",
      "<StackPanel>",
      "  <Border Background=\"{StaticResource AccentBrush}\" />",
      "  <TextBlock Text=\"{Binding Source={StaticResource Accent|Brush}, Path=Color}\" />",
      "</StackPanel>",
    ].join("\n  ")));
    assertTextsKinds(hls, ["AccentBrush", "AccentBrush", "AccentBrush"], [WRITE, READ, READ], "nested StaticResource");
  });

  it("returns a dangling resource usage as Read with no invented Write", async () => {
    const hls = await h.highlightsAt(page([
      "<StackPanel>",
      "  <Border Background=\"{StaticResource Gh|ostBrush}\" />",
      "  <Border BorderBrush=\"{ThemeResource GhostBrush}\" />",
      "</StackPanel>",
    ].join("\n  ")));
    assertTextsKinds(hls, ["GhostBrush", "GhostBrush"], [READ, READ], "dangling resource usage");
    assertKinds(hls, 0, 2, "dangling resource usage");
  });

  it("does not start a resource highlight from whitespace after the key token", async () => {
    await assertNoServerSymbolHighlight(page([
      "<Page.Resources>",
      "  <SolidColorBrush x:Key=\"Brush1\" Color=\"Red\" />",
      "</Page.Resources>",
      "<Border Background=\"{StaticResource Brush1 |}\" />",
    ].join("\n  ")), ["Brush1"], "whitespace after resource key");
  });

  it("prunes resource usages inside an unterminated outer extension", async () => {
    await assertNoServerSymbolHighlight(page([
      "<Page.Resources>",
      "  <SolidColorBrush x:Key=\"Brush1\" Color=\"Red\" />",
      "</Page.Resources>",
      "<StackPanel>",
      "  <Border Background=\"{StaticResource Brush1}\" />",
      "  <TextBlock Text=\"{Binding Source={StaticResource Bru|sh1}, Path=Color\" />",
      "</StackPanel>",
    ].join("\n  ")), ["Brush1"], "unterminated outer Binding around StaticResource");
  });

  it("keeps empty, whitespace, and markup x:Name/x:Key values inert", async () => {
    for (const [label, buffer, forbidden] of [
      ["empty x:Name", page("<Button x:Name=\"|\" />"), [""]],
      ["whitespace x:Name", page("<Button x:Name=\" |  \" />"), [" "]],
      ["empty x:Key", page("<Page.Resources><SolidColorBrush x:Key=\"|\" Color=\"Red\" /></Page.Resources>"), [""]],
      ["markup x:Key", page("<Page.Resources><Style x:Key=\"{x:Type But|ton}\" TargetType=\"Button\" /></Page.Resources>"), ["Button"]],
    ]) {
      await assertNoServerSymbolHighlight(buffer, forbidden, label);
    }
  });

  it("keeps highlight spans in parity with Find All References for a mixed nested case", async () => {
    const buffer = page([
      "<Page.Resources>",
      "  <SolidColorBrush x:Key=\"AccentBrush\" Color=\"Red\" />",
      "</Page.Resources>",
      "<StackPanel>",
      "  <Border Background=\"{StaticResource AccentBrush}\" />",
      "  <TextBlock Text=\"{Binding Source={StaticResource Accent|Brush}, Path=Color}\" />",
      "</StackPanel>",
    ].join("\n  "));
    const hls = await h.highlightsAt(buffer);
    const refs = await h.referencesAt(buffer);
    assert.deepStrictEqual(
      hls.map(spanKey),
      refs.map(spanKey),
      `highlight spans should match references; highlights=${JSON.stringify(positions(hls))} refs=${JSON.stringify(refs.map(spanKey))}`
    );
    assertKinds(hls, 1, 2, "reference parity mixed nested resource");
  });
});
