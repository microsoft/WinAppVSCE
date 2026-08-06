"use strict";

// Round 66 adversarial probes for XML-doc <summary> enrichment in hover markdown.

const assert = require("node:assert");
const path = require("node:path");
const h = require("./helper");

const CS = "SmokePage.xaml.cs";

function page(inner) {
  return `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage">
  ${inner}
</Page>`;
}

const summaryOf = (md) => (md.split("```")[2] || "").trim();
const fenceOf = (md) => (md.split("```")[1] || "").trim();

function assertSummary(md, re, reason) {
  const summary = summaryOf(md);
  assert.ok(summary.length > 0, `${reason}: expected a summary below the code fence; got ${JSON.stringify(md)}`);
  assert.match(summary, re, `${reason}: unexpected summary; got ${JSON.stringify(md)}`);
}

function assertNoDocXmlLeak(md, reason) {
  const summary = summaryOf(md);
  assert.ok(!/(^|\s)[TPM!]:|cref=|<\/?(?:summary|see|c|para|paramref|typeparamref)\b/.test(summary), `${reason}: doc XML leaked into summary ${JSON.stringify(summary)} from ${JSON.stringify(md)}`);
}

function assertSignatureOnly(md, signatureRe, reason) {
  assert.match(fenceOf(md), signatureRe, `${reason}: expected signature fence; got ${JSON.stringify(md)}`);
  assert.strictEqual(summaryOf(md), "", `${reason}: no-summary symbol must not append an empty paragraph/trailing summary; got ${JSON.stringify(md)}`);
}

describe("WinUI XAML — red-team 66 (hover doc summaries)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("red-team 66 framework element type appends Button XML-doc summary below the signature", async () => {
    const md = await h.hoverAt(page("<Butt|on />"));
    assert.match(fenceOf(md), /^csharp\nclass .*Button$/s, `Button hover should keep a class signature; got ${JSON.stringify(md)}`);
    assertSummary(md, /button/i, "Button type hover");
    assertNoDocXmlLeak(md, "Button type hover");
  });

  it("red-team 66 framework property attribute appends Content XML-doc summary without changing the signature", async () => {
    const md = await h.hoverAt(page('<Button Cont|ent="x" />'));
    assert.match(fenceOf(md), /^csharp\n.*Content.*$/s, `Content hover should keep a member signature; got ${JSON.stringify(md)}`);
    assertSummary(md, /gets or sets|content/i, "Button.Content hover");
    assertNoDocXmlLeak(md, "Button.Content hover");
  });

  it("red-team 66 framework enum attribute value appends HorizontalAlignment.Center summary", async () => {
    const md = await h.hoverAt(page('<Button HorizontalAlignment="Cen|ter" />'));
    assert.match(fenceOf(md), /^csharp\n.*HorizontalAlignment\.Center$/s, `enum value signature should identify HorizontalAlignment.Center; got ${JSON.stringify(md)}`);
    assertSummary(md, /center|centre/i, "HorizontalAlignment.Center hover");
    assertNoDocXmlLeak(md, "HorizontalAlignment.Center hover");
  });

  it("red-team 66 x:Bind enum argument value appends BindingMode.OneWay summary", async () => {
    const md = await h.hoverAt(page('<TextBlock Text="{x:Bind GreetingText, Mode=One|Way}" />'));
    assert.match(fenceOf(md), /^csharp\n.*BindingMode\.OneWay$/s, `Mode enum hover should identify BindingMode.OneWay; got ${JSON.stringify(md)}`);
    assertSummary(md, /one.?way|updates the target/i, "BindingMode.OneWay hover");
    assertNoDocXmlLeak(md, "BindingMode.OneWay hover");
  });

  it("red-team 66 attached-property attribute hover uses the getter XML-doc summary", async () => {
    const md = await h.hoverAt(page('<Grid><Button Grid.Ro|w="0" /></Grid>'));
    assert.match(fenceOf(md), /^csharp\n\(attached property\) .* Grid\.Row$/s, `Grid.Row attribute hover should keep attached-property signature; got ${JSON.stringify(md)}`);
    assertSummary(md, /gets the value|row/i, "Grid.Row attribute hover");
    assertNoDocXmlLeak(md, "Grid.Row attribute hover");
  });

  it("red-team 66 x:Bind attached step hover also uses the getter XML-doc summary", async () => {
    const md = await h.hoverAt(page('<TextBlock Tag="{x:Bind (Grid.Ro|w)}" />'));
    assert.match(fenceOf(md), /^csharp\n\(attached property\) .* Grid\.Row$/s, `x:Bind Grid.Row hover should keep attached-property signature; got ${JSON.stringify(md)}`);
    assertSummary(md, /gets the value|row/i, "x:Bind Grid.Row hover");
    assertNoDocXmlLeak(md, "x:Bind Grid.Row hover");
  });

  it("red-team 66 user x:Bind property flattens see-cref to IGreetingService with no doc-id prefix", async () => {
    const md = await h.hoverAt(page('<TextBlock Text="{x:Bind Greet|ingText}" />'));
    assert.match(fenceOf(md), /^csharp\nstring SmokePage\.GreetingText$/s, `GreetingText signature changed; got ${JSON.stringify(md)}`);
    assert.strictEqual(summaryOf(md), "Greeting sourced from the DI singleton IGreetingService.", `GreetingText summary should be flattened; got ${JSON.stringify(md)}`);
    assertNoDocXmlLeak(md, "GreetingText hover");
  });

  it("red-team 66 user Items property flattens <c>Repeater</c> without markdown/code artifacts", async () => {
    const md = await h.hoverAt(page('<ItemsRepeater ItemsSource="{x:Bind Ite|ms}" />'));
    assert.match(fenceOf(md), /^csharp\nIReadOnlyList<string> SmokePage\.Items$/s, `Items signature changed; got ${JSON.stringify(md)}`);
    assert.strictEqual(summaryOf(md), "Backing collection for the Repeater compiled binding.", `Items summary should flatten <c>; got ${JSON.stringify(md)}`);
    assert.ok(!summaryOf(md).includes("`"), `Items summary should not add markdown code ticks; got ${JSON.stringify(md)}`);
    assertNoDocXmlLeak(md, "Items hover");
  });

  it("red-team 66 user type summary flattens multiple see-crefs to bare member/type names", async () => {
    const md = await h.hoverAt(page('<local:Smoke|Page />'));
    assert.match(fenceOf(md), /^csharp\nclass SmokeFixture\.SmokePage$/s, `SmokePage signature changed; got ${JSON.stringify(md)}`);
    assert.strictEqual(
      summaryOf(md),
      "The landing page navigated to on startup. Exposes the x:Bind targets GreetingText and Items, and wires GoButton to navigate the hosting Frame to Page2.",
      `SmokePage summary should flatten all <see cref> values; got ${JSON.stringify(md)}`
    );
    assertNoDocXmlLeak(md, "SmokePage type hover");
  });

  it("red-team 66 no-summary user event handler remains signature-only with no blank paragraph", async () => {
    const md = await h.hoverAt(page('<Button Click="OnGo_Cl|ick" />'));
    assertSignatureOnly(md, /^csharp\nvoid SmokePage\.OnGo_Click\(object sender, RoutedEventArgs e\)$/s, "OnGo_Click event handler hover");
  });

  it("red-team 66 resource-key synthetic hover stays byte-for-byte unchanged and has no appended summary", async () => {
    const md = await h.hoverAt(page('<Grid Background="{StaticResource SmokeAccent|Brush}" />'));
    assert.strictEqual(md, '```csharp\n(resource) SolidColorBrush "SmokeAccentBrush"\n```\nDefined in App.xaml');
  });

  it("red-team 66 ElementName synthetic hover stays byte-for-byte unchanged", async () => {
    const md = await h.hoverAt(page('<StackPanel><TextBox x:Name="InputBox" /><TextBlock Text="{Binding ElementName=Inp|utBox, Path=Text}" /></StackPanel>'));
    assert.strictEqual(md, '```csharp\n(element) TextBox "InputBox"\n```');
  });

  it("red-team 66 Storyboard.TargetName synthetic hover stays byte-for-byte unchanged", async () => {
    const md = await h.hoverAt(page('<Grid><Button x:Name="GoButton" /><Storyboard><DoubleAnimation Storyboard.TargetName="Go|Button" /></Storyboard></Grid>'));
    assert.strictEqual(md, '```csharp\n(element) Button "GoButton"\n```');
  });

  it("red-team 66 x:Bind markup-extension name synthetic hover stays curated and not symbol-enriched", async () => {
    const md = await h.hoverAt(page('<TextBlock Text="{x:Bi|nd GreetingText}" />'));
    assert.strictEqual(md, '```xaml\n{x:Bind}\n```\nCompiled binding — resolves a field, property, or method against the page\'s `x:Class` (or the enclosing `DataTemplate` `x:DataType`) at compile time.');
  });

  it("red-team 66 StaticResource markup-extension name synthetic hover stays curated and not symbol-enriched", async () => {
    const md = await h.hoverAt(page('<Grid Background="{StaticReso|urce SmokeAccentBrush}" />'));
    assert.strictEqual(md, '```xaml\n{StaticResource}\n```\nLooks up a resource by key from the merged resource dictionaries once, at load time.');
  });

  it("red-team 66 comment and CDATA caret contexts do not synthesize stale summary hovers", async () => {
    const cases = [
      page('<!-- <Butt|on /> -->'),
      page('<Grid><![CDATA[ <Button Cont|ent="x" /> ]]></Grid>'),
    ];
    for (const buffer of cases) {
      const md = await h.hoverAt(buffer);
      assert.strictEqual(md, "", `inert context should not return a stale hover; buffer=${buffer}; got ${JSON.stringify(md)}`);
    }
  });

  it("red-team 66 unterminated markup around the caret remains stable and returns the current attribute hover", async () => {
    const md = await h.hoverAt(`<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  <Button Cont|ent="unterminated\n</Page>`);
    assert.match(fenceOf(md), /^csharp\n.*Content.*$/s, `unterminated attribute hover should still identify Content; got ${JSON.stringify(md)}`);
    assertSummary(md, /gets or sets|content/i, "unterminated Content hover");
  });

  it("red-team 66 repeated identical user-symbol hover is deterministic", async () => {
    const buffer = page('<TextBlock Text="{x:Bind Greet|ingText}" />');
    const first = await h.hoverAt(buffer);
    const second = await h.hoverAt(buffer);
    assert.strictEqual(second, first);
  });

  it("red-team 66 F12 on enriched user symbols still lands on the original source declarations", async () => {
    const greeting = await h.definitionsAt(page('<TextBlock Text="{x:Bind Greet|ingText}" />'));
    assert.ok(greeting.length > 0, `expected GreetingText definition; got ${JSON.stringify(greeting)}`);
    assert.strictEqual(path.basename(greeting[0].fsPath), CS);
    assert.strictEqual(greeting[0].line, 15, `GreetingText should still land on source property line; got ${JSON.stringify(greeting)}`);

    const items = await h.definitionsAt(page('<ItemsRepeater ItemsSource="{x:Bind Ite|ms}" />'));
    assert.ok(items.length > 0, `expected Items definition; got ${JSON.stringify(items)}`);
    assert.strictEqual(path.basename(items[0].fsPath), CS);
    assert.strictEqual(items[0].line, 18, `Items should still land on source property line; got ${JSON.stringify(items)}`);
  });

  it("red-team 66 framework summary strips DocFX ::: moniker zone and [!CAUTION] noise to clean prose", async () => {
    const md = await h.hoverAt(page("<Expan|der />"));
    const s = summaryOf(md);
    assert.ok(s.length > 0, `Expander hover should carry a summary; got ${JSON.stringify(md)}`);
    for (const bad of [":::", "moniker", "[!", "<img", "<sup", "<br", ">"]) {
      assert.ok(!s.includes(bad), `Expander summary must be sanitized of ${JSON.stringify(bad)}; got ${JSON.stringify(s)}`);
    }
    assert.match(s, /displays a header/i, `Expander summary should surface the real prose; got ${JSON.stringify(s)}`);
  });

  it("red-team 66 framework enum-value summary strips escaped <img> to avoid a broken tooltip image", async () => {
    const md = await h.hoverAt(page('<Button XYFocusDownNavigationStrategy="Rectili|nearDistance" />'));
    const s = summaryOf(md);
    assert.ok(s.length > 0, `RectilinearDistance hover should carry a summary; got ${JSON.stringify(md)}`);
    for (const bad of ["<img", "src=", "<", ">"]) {
      assert.ok(!s.includes(bad), `RectilinearDistance summary must strip escaped HTML ${JSON.stringify(bad)}; got ${JSON.stringify(s)}`);
    }
    assert.match(s, /rectilinear|closest element/i, `RectilinearDistance summary should surface the real prose; got ${JSON.stringify(s)}`);
  });
});
