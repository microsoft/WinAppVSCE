"use strict";

// CompletionItem.documentation summaries.

const assert = require("node:assert");
const h = require("./helper");

function page(inner) {
  return `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage">
  ${inner}
</Page>`;
}

const docOf = (items, label, detailRe) => {
  const hits = items.filter((i) => i.label === label && (!detailRe || detailRe.test(i.detail || "")));
  const documented = hits.find((i) => i.documentation);
  return documented ? documented.documentation : hits.length ? hits[0].documentation : "";
};

const itemsOf = (items, label, detailRe) =>
  items.filter((i) => i.label === label && (!detailRe || detailRe.test(i.detail || "")));

function assertDocumented(items, label, detailRe, docRe, reason) {
  const d = docOf(items, label, detailRe);
  assert.ok(d.length > 0, `${reason}: expected documentation for ${label}; got ${JSON.stringify(itemsOf(items, label, detailRe))}`);
  assert.match(d, docRe, `${reason}: unexpected documentation for ${label}; got ${JSON.stringify(d)}`);
  assertNoCompletionDocLeak(d, reason);
  return d;
}

function assertNoCompletionDocLeak(d, reason) {
  assert.ok(!d.includes("```"), `${reason}: completion documentation must be summary prose only; got ${JSON.stringify(d)}`);
  assert.ok(!/(^|\n)\s*:::/m.test(d), `${reason}: DocFX moniker fence leaked; got ${JSON.stringify(d)}`);
  assert.ok(!/(^|\n)\s*>/.test(d), `${reason}: blockquote marker leaked; got ${JSON.stringify(d)}`);
  assert.ok(!/\[!(NOTE|IMPORTANT|CAUTION|TIP|WARNING)\]/i.test(d), `${reason}: DocFX alert label leaked; got ${JSON.stringify(d)}`);
  assert.ok(!/<\s*\/?\s*(img|br|sup)\b/i.test(d), `${reason}: escaped HTML tag leaked; got ${JSON.stringify(d)}`);
  assert.ok(!/(^|\s)[TPMFE]:|cref=|<\/?(?:summary|see|c|para|paramref|typeparamref)\b|`/.test(d), `${reason}: XML-doc residue leaked; got ${JSON.stringify(d)}`);
}

function assertServerNoDocs(items, label, detailRe, reason) {
  const hits = itemsOf(items, label, detailRe);
  if (hits.length === 0) {
    assert.fail(`${reason}: expected server completion ${label}; got ${JSON.stringify(items.slice(0, 40))}`);
  }
  for (const hit of hits) {
    if (hit.documentation !== "") {
      assert.fail(`${reason}: ${label} must be undocumented; got ${JSON.stringify(hit)}`);
    }
  }
}

const hoverSummary = (md) => (md.split("```")[2] || "").trim();

describe("WinUI XAML — red-team 67 (completion documentation)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("red-team 67 framework element-name Button carries type summary only", async () => {
    const items = await h.completionDocsAt(page("<But|"));
    assertDocumented(items, "Button", /Microsoft\.UI\.Xaml\.Controls/, /button/i, "Button element completion");
  });

  it("red-team 67 DocFX-heavy Expander element documentation is sanitized in completion", async () => {
    const items = await h.completionDocsAt(page("<Expan|"));
    assertDocumented(items, "Expander", /Microsoft\.UI\.Xaml\.Controls/, /expand|collaps/i, "Expander element completion");
  });

  it("red-team 67 framework attribute-name Content carries property summary without hover signature", async () => {
    const items = await h.completionDocsAt(page("<Button Cont|"));
    assertDocumented(items, "Content", undefined, /gets or sets|content/i, "Button.Content attribute completion");
  });

  it("red-team 67 framework enum value Visibility.Collapsed carries sanitized field summary", async () => {
    const items = await h.completionDocsAt(page('<Button Visibility="|" />'));
    assertDocumented(items, "Collapsed", /Visibility/, /display/i, "Visibility.Collapsed value completion");
  });

  it("red-team 67 markup named-argument enum value Mode=TwoWay carries BindingMode summary", async () => {
    const items = await h.completionDocsAt(page('<TextBlock Text="{x:Bind GreetingText, Mode=|}" />'));
    assertDocumented(items, "TwoWay", /BindingMode/, /two.?way|target|source/i, "x:Bind Mode= enum completion");
  });

  it("red-team 67 proactive Grid child attached-property Grid.Row carries getter summary", async () => {
    const items = await h.completionDocsAt(page("<Grid>\n    <Button |\n  </Grid>"));
    assertDocumented(items, "Grid.Row", /^attached property/, /gets the value|row/i, "proactive Grid.Row completion");
  });

  it("red-team 67 dotted attached-property Grid.Row carries getter summary after owner partial", async () => {
    const items = await h.completionDocsAt(page("<Grid>\n    <Button Grid.R|\n  </Grid>"));
    assertDocumented(items, "Grid.Row", /^attached property/, /gets the value|row/i, "dotted Grid.Row completion");
  });

  it("red-team 67 TargetType full framework type list still returns Button docs", async () => {
    const started = Date.now();
    const items = await h.completionDocsAt(page('<Style TargetType="|" />'));
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 30000, `TargetType large-list completion should return promptly; took ${elapsed}ms`);
    assertDocumented(items, "Button", /Microsoft\.UI\.Xaml\.Controls/, /button/i, "TargetType Button type completion");
  });

  it("red-team 67 x:Type type-name value carries Button docs", async () => {
    const items = await h.completionDocsAt(page('<Button Tag="{x:Type But|}" />'));
    assertDocumented(items, "Button", /Microsoft\.UI\.Xaml\.Controls/, /button/i, "{x:Type Button} completion");
  });

  it("red-team 67 x:Static enum member carries Visibility.Collapsed docs", async () => {
    const items = await h.completionDocsAt(page('<Button Tag="{x:Static Visibility.|}" />'));
    assertDocumented(items, "Collapsed", /Visibility/, /display/i, "{x:Static Visibility.Collapsed} completion");
  });

  it("red-team 67 user x:Bind member carries exact flattened source summary and no doc-id residue", async () => {
    const items = await h.completionDocsAt(page('<TextBlock Text="{x:Bind Gree|}" />'));
    const d = docOf(items, "GreetingText");
    assert.strictEqual(d, "Greeting sourced from the DI singleton IGreetingService.", `GreetingText summary mismatch; item=${JSON.stringify(itemsOf(items, "GreetingText"))}`);
    assertNoCompletionDocLeak(d, "GreetingText completion");
  });

  it("red-team 67 undocumented user event handler in Click value carries no documentation", async () => {
    const items = await h.completionDocsAt(page('<Button Click="|" />'));
    assertServerNoDocs(items, "OnGo_Click", /SmokePage/, "Click event handler completion");
  });

  it("red-team 67 synthetic boolean True and False carry no documentation", async () => {
    const items = await h.completionDocsAt(page('<Button IsEnabled="|" />'));
    assertServerNoDocs(items, "True", undefined, "IsEnabled=True completion");
    assertServerNoDocs(items, "False", undefined, "IsEnabled=False completion");
  });

  it("red-team 67 StaticResource key completion carries no documentation", async () => {
    const items = await h.completionDocsAt(page('<Grid Background="{StaticResource |}" />'));
    assertServerNoDocs(items, "SmokeAccentBrush", undefined, "StaticResource key completion");
  });

  it("red-team 67 xmlns URI/value and using: namespace completions carry no documentation", async () => {
    const xmlnsItems = await h.completionDocsAt(page('<Grid xmlns:zzz="|" />'));
    assertServerNoDocs(xmlnsItems, "using:", /namespace|reference/, "xmlns using: scheme completion");
    assertServerNoDocs(xmlnsItems, "http://schemas.microsoft.com/winfx/2006/xaml/presentation", /namespace/, "xmlns presentation URI completion");

    const usingItems = await h.completionDocsAt(page('<Grid xmlns:zzz="using:|" />'));
    assertServerNoDocs(usingItems, "SmokeFixture", /^CLR namespace$/, "source using: namespace completion");
    assertServerNoDocs(usingItems, "Microsoft.UI.Xaml.Controls", /^CLR namespace \(referenced\)$/, "referenced using: namespace completion");
  });

  it("red-team 67 mc:Ignorable prefix completion carries no documentation", async () => {
    const items = await h.completionDocsAt(page('<Grid xmlns:zzz="using:SmokeFixture" mc:Ignorable="|" />'));
    assertServerNoDocs(items, "d", /Ignorable .*prefix/, "mc:Ignorable existing design prefix completion");
  });

  it("red-team 67 close-tag completion carries no documentation", async () => {
    const items = await h.completionDocsAt(page("<Grid>\n    </|"));
    assertServerNoDocs(items, "Grid", /^Closing tag$/, "close-tag completion");
  });

  it("red-team 67 Binding ElementName reference does not leak the named Button type summary", async () => {
    const items = await h.completionDocsAt(page('<StackPanel><Button x:Name="GoButton" /><TextBlock Text="{Binding ElementName=|, Path=Content}" /></StackPanel>'));
    assertServerNoDocs(items, "GoButton", undefined, "Binding ElementName completion");
  });

  it("red-team 67 Storyboard.TargetName reference does not leak the named Button type summary", async () => {
    const items = await h.completionDocsAt(page('<Grid><Button x:Name="GoButton" /><Storyboard><DoubleAnimation Storyboard.TargetName="|" /></Storyboard></Grid>'));
    assertServerNoDocs(items, "GoButton", /^\(element\) Button/, "Storyboard.TargetName completion");
  });

  it("red-team 67 RelativePanel.RightOf reference does not leak named TextBox type summary", async () => {
    const items = await h.completionDocsAt(page('<RelativePanel><TextBox x:Name="InputBox" /><Button RelativePanel.RightOf="|" /></RelativePanel>'));
    assertServerNoDocs(items, "InputBox", /^\(element\) TextBox/, "RelativePanel.RightOf completion");
  });

  it("red-team 67 repeated identical completion request is deterministic for user-source documentation", async () => {
    const buffer = page('<TextBlock Text="{x:Bind Gree|}" />');
    const first = docOf(await h.completionDocsAt(buffer), "GreetingText");
    const second = docOf(await h.completionDocsAt(buffer), "GreetingText");
    assert.ok(first.length > 0, "determinism probe must exercise documented GreetingText completion");
    assert.strictEqual(first, second, `GreetingText completion docs changed across identical requests: first=${JSON.stringify(first)} second=${JSON.stringify(second)}`);
  });

  it("red-team 67 completion documentation equals hover summary for Button.Content", async () => {
    const completionDoc = docOf(await h.completionDocsAt(page("<Button Cont|")), "Content");
    const hoverDoc = hoverSummary(await h.hoverAt(page('<Button Cont|ent="x" />')));
    assert.ok(completionDoc.length > 0 && hoverDoc.length > 0, `expected both docs; completion=${JSON.stringify(completionDoc)} hover=${JSON.stringify(hoverDoc)}`);
    assert.strictEqual(completionDoc, hoverDoc, "completion docs should equal the summary portion of hover markdown");
  });

  it("red-team 67 malformed buffers remain stable and do not return stale or unsanitized documentation", async () => {
    const cases = [
      { buffer: page("<Button Cont|"), label: "Content", detail: undefined, doc: /gets or sets|content/i },
      { buffer: page('<TextBlock Text="{x:Bind Gree|'), label: "GreetingText", detail: undefined, doc: /Greeting sourced/ },
      { buffer: page('<Button Visibility="|'), label: "Collapsed", detail: /Visibility/, doc: /display/i },
    ];
    for (const c of cases) {
      const d = assertDocumented(await h.completionDocsAt(c.buffer), c.label, c.detail, c.doc, `malformed buffer ${c.label}`);
      assertNoCompletionDocLeak(d, `malformed buffer ${c.label}`);
    }
  });

  // Wired symbol-bearing builders that the smoke cases and the probes above don't otherwise reach — guards each remaining CompletionDoc(member.Symbol/type) call site against a silent mis-wire.
  it("red-team 67 Setter Property= item carries the settable-property summary", async () => {
    const items = await h.completionDocsAt(page('<Style TargetType="Button">\n    <Setter Property="Cont|" />\n  </Style>'));
    assertDocumented(items, "Content", /property/, /gets or sets/i, "Setter Property= completion");
  });

  it("red-team 67 TemplateBinding item carries the templated-parent property summary", async () => {
    const items = await h.completionDocsAt(page('<ControlTemplate TargetType="Button">\n    <Border Width="{TemplateBinding Wid|}" />\n  </ControlTemplate>'));
    assertDocumented(items, "Width", /property/, /gets or sets/i, "TemplateBinding completion");
  });

  it("red-team 67 Binding markup-argument NAME carries the Binding-property summary", async () => {
    // The server offers named-argument completion only after a positional/comma; the curated x:Bind arg names remain intentionally undocumented (they are hard-coded strings, not symbols).
    const items = await h.completionDocsAt(page('<TextBlock Text="{Binding Path=GreetingText, Conv|}" />'));
    assertDocumented(items, "Converter", /property/, /gets or sets/i, "Binding arg-name completion");
  });

  it("red-team 67 element XAML intrinsic x:String carries the System.String summary", async () => {
    // Object-typed content (Button.Content) keeps intrinsics offered as elements; a panel child position is UIElement-typed and correctly excludes them (context-aware element-type narrowing).
    const items = await h.completionDocsAt(page("<Button>\n    <x:Str|\n  </Button>"));
    assertDocumented(items, "String", /^System$/, /represents text/i, "element intrinsic x:String completion");
  });

  it("red-team 67 type-name intrinsic {x:Type x:String} carries the System.String summary", async () => {
    const items = await h.completionDocsAt(page('<Button Tag="{x:Type x:Str|}" />'));
    assertDocumented(items, "String", /^System$/, /represents text/i, "type-name intrinsic x:String completion");
  });
});
