"use strict";

// Parenthesized x:Bind paths, caret boundaries, casts, and attached properties.

const assert = require("node:assert");
const path = require("node:path");
const h = require("./helper");

const CS = "SmokePage.xaml.cs";

function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
}

function wxaml(diags) {
  return diags.filter((x) => /^WXAML/.test(String(x.code || "")));
}

function summary(diags) {
  return wxaml(diags).map((d) => `${d.code}:${d.message}`).join("; ");
}

describe("WinUI XAML red-team 27 — cast x:Bind resolution", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("F12 on the member after a user-type cast lands in the user type source", async () => {
    const buffer = page('<TextBlock Text="{x:Bind (local:SmokePage)Greeting|Text}" />');
    const defs = await h.definitionsAt(buffer);
    assert.ok(defs.length > 0, `cast member should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), CS, `cast member should resolve to ${CS}; buffer=${buffer}; got ${defs[0].fsPath}`);
  });

  it("hover on the member after a user-type cast describes the cast target member", async () => {
    const buffer = page('<TextBlock Text="{x:Bind (local:SmokePage)Greeting|Text}" />');
    const md = await h.hoverAt(buffer);
    assert.match(md, /string|String/, `cast member hover should include string type; buffer=${buffer}; got: ${md}`);
    assert.match(md, /SmokePage\.GreetingText|GreetingText/, `cast member hover should identify SmokePage.GreetingText; buffer=${buffer}; got: ${md}`);
  });

  it("completion after a user-type cast offers members from the cast target", async () => {
    const buffer = page('<TextBlock Text="{x:Bind (local:SmokePage)Greet|}" />');
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("GreetingText"), `cast completion should offer GreetingText from SmokePage; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("completion after an intrinsic cast re-roots to String and not the page root", async () => {
    const castBuffer = page('<TextBlock Text="{x:Bind (x:String)Len|}" />');
    const castItems = await h.completionsAt(castBuffer);
    assert.ok(castItems.includes("Length"), `x:String cast completion should offer Length; buffer=${castBuffer}; got ${castItems.slice(0, 120).join(", ")}`);

    const rootBuffer = page('<TextBlock Text="{x:Bind Len|}" />');
    const rootItems = await h.completionsAt(rootBuffer);
    assert.ok(!rootItems.includes("Length"), `root x:Bind completion should not offer String.Length; buffer=${rootBuffer}; got ${rootItems.slice(0, 120).join(", ")}`);
  });

  it("hover after an intrinsic cast identifies the terminal String member type", async () => {
    const buffer = page('<TextBlock Text="{x:Bind (x:String)Len|gth}" />');
    const md = await h.hoverAt(buffer);
    assert.match(md, /Length/, `x:String cast hover should mention Length; buffer=${buffer}; got: ${md}`);
    assert.match(md, /int|Int32|System\.Int32/, `x:String Length hover should include integer type; buffer=${buffer}; got: ${md}`);
    assert.ok(!/GreetingText/.test(md), `x:String cast hover must not leak page-root member info; buffer=${buffer}; got: ${md}`);
  });

  it("cast plus dotted tail resolves the terminal member against the cast-derived type", async () => {
    const buffer = page('<TextBlock Text="{x:Bind (local:SmokePage)GreetingText.Len|gth}" />');
    const md = await h.hoverAt(buffer);
    assert.match(md, /Length/, `cast dotted-tail hover should mention Length; buffer=${buffer}; got: ${md}`);
    assert.match(md, /int|Int32|System\.Int32/, `cast dotted-tail Length hover should include integer type; buffer=${buffer}; got: ${md}`);
    assert.ok(!/SmokePage\.GreetingText/.test(md), `terminal hover should not describe the base property; buffer=${buffer}; got: ${md}`);
  });

  it("cast plus indexer tail resolves the indexed element member", async () => {
    const buffer = page('<TextBlock Text="{x:Bind (local:SmokePage)Items[0].Len|gth}" />');
    const md = await h.hoverAt(buffer);
    assert.match(md, /Length/, `cast indexer-tail hover should mention Length; buffer=${buffer}; got: ${md}`);
    assert.match(md, /int|Int32|System\.Int32/, `cast indexer-tail Length hover should include integer type; buffer=${buffer}; got: ${md}`);
  });

  it("explicit Path= cast preserves F12 on the member after the cast", async () => {
    const buffer = page('<TextBlock Text="{x:Bind Path=(local:SmokePage)Greeting|Text}" />');
    const defs = await h.definitionsAt(buffer);
    assert.ok(defs.length > 0, `Path= cast member should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), CS, `Path= cast member should resolve to ${CS}; buffer=${buffer}; got ${defs[0].fsPath}`);
  });

  it("a cast inside a String DataTemplate overrides the template x:DataType root", async () => {
    const buffer = page([
      '<ItemsRepeater ItemsSource="{x:Bind Items}">',
      '  <ItemsRepeater.ItemTemplate>',
      '    <DataTemplate x:DataType="x:String">',
      '      <TextBlock Text="{x:Bind (local:SmokePage)Greeting|Text}" />',
      '    </DataTemplate>',
      '  </ItemsRepeater.ItemTemplate>',
      '</ItemsRepeater>',
    ].join("\n  "));
    const defs = await h.definitionsAt(buffer);
    assert.ok(defs.length > 0, `cast inside DataTemplate should resolve the cast target member; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), CS, `cast inside DataTemplate should land in ${CS}; buffer=${buffer}; got ${defs[0].fsPath}`);
  });

  it("caret inside cast parentheses does not incorrectly resolve the trailing member", async () => {
    const buffer = page('<TextBlock Text="{x:Bind (local:Smoke|Page)GreetingText}" />');
    const md = await h.hoverAt(buffer);
    assert.ok(!/GreetingText/.test(md), `hover inside cast type must not describe trailing GreetingText; buffer=${buffer}; got: ${md}`);
  });

  it("caret on the closing cast parenthesis does not incorrectly resolve the trailing member", async () => {
    const buffer = page('<TextBlock Text="{x:Bind (local:SmokePage|)GreetingText}" />');
    const md = await h.hoverAt(buffer);
    assert.ok(!/GreetingText/.test(md), `hover on cast ')' boundary must not describe trailing GreetingText; buffer=${buffer}; got: ${md}`);
  });

  it("unresolved or malformed casts stay silent and do not crash diagnostics", async () => {
    const buffer = page([
      '<StackPanel>',
      '  <TextBlock Text="{x:Bind (local:Unknown)Member}" />',
      '  <TextBlock Text="{x:Bind ()Member}" />',
      '  <TextBlock Text="{x:Bind ((local:SmokePage)Member}" />',
      '  <TextBlock Text="{x:Bind (local:SmokePage)}" />',
      '</StackPanel>',
    ].join("\n  "));
    const diags = await h.diagnosticsFor(buffer, () => false, 3500);
    assert.strictEqual(wxaml(diags).length, 0, `malformed/unknown cast paths should stay WXAML-silent; buffer=${buffer}; got ${summary(diags)}`);
  });
});

describe("WinUI XAML red-team 27 — attached-property x:Bind resolution", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("hover on Grid.Row identifies the attached property and value type", async () => {
    const buffer = page('<TextBlock Text="{x:Bind (Grid.R|ow)}" />');
    const md = await h.hoverAt(buffer);
    assert.match(md, /attached property/i, `Grid.Row hover should say attached property; buffer=${buffer}; got: ${md}`);
    assert.match(md, /int|Int32|System\.Int32/, `Grid.Row hover should include integer type; buffer=${buffer}; got: ${md}`);
    assert.match(md, /Grid\.Row/, `Grid.Row hover should identify owner.member; buffer=${buffer}; got: ${md}`);
  });

  it("hover on Canvas.Left identifies a non-Grid attached property", async () => {
    const buffer = page('<TextBlock Text="{x:Bind (Canvas.L|eft)}" />');
    const md = await h.hoverAt(buffer);
    assert.match(md, /attached property/i, `Canvas.Left hover should say attached property; buffer=${buffer}; got: ${md}`);
    assert.match(md, /Canvas\.Left/, `Canvas.Left hover should identify owner.member; buffer=${buffer}; got: ${md}`);
    assert.match(md, /double|Double|System\.Double/, `Canvas.Left hover should include double type; buffer=${buffer}; got: ${md}`);
  });

  it("caret on attached-property owner does not resolve as the attached member", async () => {
    const ownerBuffer = page('<TextBlock Text="{x:Bind (G|rid.Row)}" />');
    const ownerMd = await h.hoverAt(ownerBuffer);
    assert.ok(!/attached property/i.test(ownerMd), `hover on attached-property owner must not describe Grid.Row; buffer=${ownerBuffer}; got: ${ownerMd}`);
  });

  it("caret on attached-property dot does not resolve as the attached member", async () => {
    const dotBuffer = page('<TextBlock Text="{x:Bind (Grid|.Row)}" />');
    const dotMd = await h.hoverAt(dotBuffer);
    assert.ok(!/attached property/i.test(dotMd), `hover before attached-property dot must not describe Grid.Row; buffer=${dotBuffer}; got: ${dotMd}`);
  });

  it("unknown attached-property owners stay silent and do not crash diagnostics", async () => {
    const buffer = page('<TextBlock Text="{x:Bind (Bogus.Foo)}" />');
    const diags = await h.diagnosticsFor(buffer, () => false, 3500);
    assert.strictEqual(wxaml(diags).length, 0, `unknown attached-property x:Bind should stay WXAML-silent; buffer=${buffer}; got ${summary(diags)}`);
  });
});
