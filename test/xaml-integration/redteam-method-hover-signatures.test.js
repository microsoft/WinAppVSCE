"use strict";

const assert = require("node:assert");
const h = require("./helper");

function page(inner) {
  return `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage">
  ${inner}
</Page>`;
}

function caretOffset(buffer) {
  return buffer.indexOf("|");
}

const summaryOf = (md) => (md.split("```")[2] || "").trim();

function assertNoMethodDetails(md, reason) {
  assert.doesNotMatch(md, /\*\*Returns:\*\*/, `${reason}: must not carry Returns; got: ${md}`);
  assert.doesNotMatch(md, /\*\*Parameters:\*\*/, `${reason}: must not carry Parameters; got: ${md}`);
}

function assertEnrichedMethod(md, signature, params, reason) {
  assert.match(md, signature, `${reason}: expected method signature; got: ${md}`);
  assert.match(md, /\*\*Returns:\*\* \S/, `${reason}: expected a non-empty Returns section; got: ${md}`);
  assert.match(md, /\*\*Parameters:\*\*/, `${reason}: expected a Parameters section; got: ${md}`);
  for (const p of params) {
    assert.match(md, new RegExp(`- \`${p}\`: \\S`), `${reason}: expected documented param ${p}; got: ${md}`);
  }
}

describe("WinUI XAML red-team 70 (method hover returns/params adversarial)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("red-team 70 inherited FrameworkElement.FindName has returns and documented name param", async () => {
    const buffer = page('<TextBlock Text="{x:Bind Find|Name}" />');
    const md = await h.hoverAt(buffer);
    assertEnrichedMethod(md, /object FrameworkElement\.FindName\(string name\)/, ["name"], `buffer=${JSON.stringify(buffer)} caret=${caretOffset(buffer)}`);
  });

  it("red-team 70 string.Substring dotted segment has returns and startIndex param", async () => {
    const buffer = page('<TextBlock Text="{x:Bind GreetingText.Subs|tring}" />');
    const md = await h.hoverAt(buffer);
    assertEnrichedMethod(md, /string\.Substring\(int startIndex\)/, ["startIndex"], `buffer=${JSON.stringify(buffer)} caret=${caretOffset(buffer)}`);
  });

  it("red-team 70 string.StartsWith dotted segment has returns and value param", async () => {
    const buffer = page('<TextBlock Text="{x:Bind GreetingText.Starts|With}" />');
    const md = await h.hoverAt(buffer);
    assertEnrichedMethod(md, /bool string\.StartsWith\((string|char) value\)/, ["value"], `buffer=${JSON.stringify(buffer)} caret=${caretOffset(buffer)}`);
  });

  it("red-team 70 string.Replace multi-parameter overload lists multiple documented params", async () => {
    const buffer = page('<TextBlock Text="{x:Bind GreetingText.Repl|ace}" />');
    const md = await h.hoverAt(buffer);
    assert.match(md, /string\.Replace\(/, `expected Replace signature; got: ${md}`);
    assert.match(md, /\*\*Returns:\*\* \S/, `expected Returns section; got: ${md}`);
    assert.match(md, /\*\*Parameters:\*\*/, `expected Parameters section; got: ${md}`);
    const bullets = (md.match(/^- `[^`]+`: \S/gm) || []);
    assert.ok(bullets.length >= 2, `expected at least two documented params for multi-param Replace; got: ${md}`);
  });

  it("red-team 70 cast-form method resolution is enriched", async () => {
    const buffer = page('<TextBlock Text="{x:Bind (local:SmokePage)Find|Name}" />');
    const md = await h.hoverAt(buffer);
    assertEnrichedMethod(md, /object FrameworkElement\.FindName\(string name\)/, ["name"], `buffer=${JSON.stringify(buffer)} caret=${caretOffset(buffer)}`);
  });

  it("red-team 70 negated method path still enriches the method segment", async () => {
    const buffer = page('<TextBlock Text="{x:Bind !GreetingText.Starts|With}" />');
    const md = await h.hoverAt(buffer);
    assertEnrichedMethod(md, /bool string\.StartsWith\((string|char) value\)/, ["value"], `buffer=${JSON.stringify(buffer)} caret=${caretOffset(buffer)}`);
  });

  it("red-team 70 indexer path to ToString shows Returns but no empty Parameters header", async () => {
    const buffer = page('<TextBlock Text="{x:Bind Items[0].ToStr|ing}" />');
    const md = await h.hoverAt(buffer);
    assert.match(md, /string\.(Object\.)?ToString\(\)/, `expected ToString signature; got: ${md}`);
    assert.match(md, /\*\*Returns:\*\* \S/, `expected Returns section; got: ${md}`);
    assert.doesNotMatch(md, /\*\*Parameters:\*\*/, `parameterless method must not carry empty Parameters header; got: ${md}`);
  });

  it("red-team 70 enriched method markdown has exactly one blank line between appended sections", async () => {
    const buffer = page('<TextBlock Text="{x:Bind Find|Name}" />');
    const md = await h.hoverAt(buffer);
    assert.match(md, /\n\n\*\*Returns:\*\* [^\n]+\n\n\*\*Parameters:\*\*\n- `name`: /, `expected exact section spacing; got: ${md}`);
    assert.doesNotMatch(md, /\n\n\n\*\*(Returns|Parameters):\*\*/, `must not have extra blank lines before sections; got: ${md}`);
  });

  it("red-team 70 user property GreetingText remains summary-only", async () => {
    const buffer = page('<TextBlock Text="{x:Bind Greet|ingText}" />');
    const md = await h.hoverAt(buffer);
    assert.match(md, /string SmokePage\.GreetingText/, `expected property signature; got: ${md}`);
    assert.match(summaryOf(md), /Greeting sourced from the DI singleton IGreetingService/, `expected property summary; got: ${md}`);
    assertNoMethodDetails(md, `buffer=${JSON.stringify(buffer)} caret=${caretOffset(buffer)}`);
  });

  it("red-team 70 element type Button remains summary-only", async () => {
    const buffer = page("<Butt|on />");
    const md = await h.hoverAt(buffer);
    assert.match(md, /class .*Button/, `expected Button type signature; got: ${md}`);
    assert.match(summaryOf(md), /button/i, `expected Button summary; got: ${md}`);
    assertNoMethodDetails(md, `buffer=${JSON.stringify(buffer)} caret=${caretOffset(buffer)}`);
  });

  it("red-team 70 enum value Center remains summary-only", async () => {
    const buffer = page('<Grid HorizontalAlignment="Cent|er" />');
    const md = await h.hoverAt(buffer);
    assert.match(md, /Center/, `expected enum value hover; got: ${md}`);
    assertNoMethodDetails(md, `buffer=${JSON.stringify(buffer)} caret=${caretOffset(buffer)}`);
  });

  it("red-team 70 event hover remains summary-only and never borrows handler params", async () => {
    const buffer = page('<Button Cli|ck="OnGo_Click" />');
    const md = await h.hoverAt(buffer);
    assert.match(md, /Click/, `expected event hover; got: ${md}`);
    assertNoMethodDetails(md, `buffer=${JSON.stringify(buffer)} caret=${caretOffset(buffer)}`);
  });

  it("red-team 70 undocumented user handler has deterministic metadata prose", async () => {
    const buffer = page('<TextBlock Text="{x:Bind OnGo_C|lick()}" />');
    const md = await h.hoverAt(buffer);
    assert.strictEqual(
      md,
      "```csharp\nvoid SmokePage.OnGo_Click(object sender, RoutedEventArgs e)\n```\n\nMethod `OnGo_Click` declared by `SmokeFixture.SmokePage`.",
      `undocumented method hover must use deterministic metadata prose; buffer=${JSON.stringify(buffer)} caret=${caretOffset(buffer)}`
    );
  });

  it("red-team 70 attached Grid.Row attribute hover stays attached-property summary-only", async () => {
    const buffer = page('<Grid><Button Grid.Ro|w="1" /></Grid>');
    const md = await h.hoverAt(buffer);
    assert.match(md, /\(attached property\)/, `expected attached-property signature; got: ${md}`);
    assert.match(summaryOf(md), /gets the value/i, `expected getter summary; got: ${md}`);
    assertNoMethodDetails(md, `buffer=${JSON.stringify(buffer)} caret=${caretOffset(buffer)}`);
  });

  it("red-team 70 attached Grid.Row x:Bind form does not expose getter method details", async () => {
    const buffer = page('<TextBlock Text="{x:Bind (Grid.Ro|w)}" />');
    const md = await h.hoverAt(buffer);
    if (md.length > 0) {
      assert.match(md, /\(attached property\)|Grid\.Row/, `expected attached-property-ish hover if resolved; got: ${md}`);
    }
    assertNoMethodDetails(md, `buffer=${JSON.stringify(buffer)} caret=${caretOffset(buffer)}`);
  });

  it("red-team 70 unresolved method path returns no hover instead of throwing or fabricating details", async () => {
    const buffer = page('<TextBlock Text="{x:Bind MissingThing.NoSuchMeth|od}" />');
    const md = await h.hoverAt(buffer);
    assert.strictEqual(md, "", `unresolved method path should have no hover; buffer=${JSON.stringify(buffer)} caret=${caretOffset(buffer)} got: ${md}`);
  });

  it("red-team 70 malformed unterminated markup near a method hover is robust", async () => {
    const buffer = page('<TextBlock Text="{x:Bind GreetingText.Subs|tring');
    const md = await h.hoverAt(buffer);
    assert.strictEqual(typeof md, "string", `hoverAt should return a string for malformed buffer at caret=${caretOffset(buffer)}`);
    if (md.length > 0) {
      assert.match(md, /Substring/, `malformed hover should either be empty or still target Substring; got: ${md}`);
    }
  });

  it("red-team 70 repeated identical hover is deterministic", async () => {
    const buffer = page('<TextBlock Text="{x:Bind GreetingText.Subs|tring}" />');
    const first = await h.hoverAt(buffer);
    const second = await h.hoverAt(buffer);
    assert.strictEqual(first, second, `identical hover requests must be byte-identical; first=${first} second=${second}`);
  });

  it("red-team 70 resource-key hover remains resource-only and un-enriched", async () => {
    const buffer = page('<Grid Background="{StaticResource SmokeAccent|Brush}" />');
    const md = await h.hoverAt(buffer);
    assert.match(md, /\(resource\)|SmokeAccentBrush/, `expected resource key hover; got: ${md}`);
    assertNoMethodDetails(md, `buffer=${JSON.stringify(buffer)} caret=${caretOffset(buffer)}`);
  });

  it("red-team 70 markup-extension name hover is not method-enriched", async () => {
    const buffer = page('<Grid Background="{Static|Resource SmokeAccentBrush}" />');
    const md = await h.hoverAt(buffer);
    assertNoMethodDetails(md, `buffer=${JSON.stringify(buffer)} caret=${caretOffset(buffer)}`);
  });

  it("red-team 70 void method (documented params, no returns) shows Parameters WITHOUT a Returns section", async () => {
    const buffer = page('<TextBlock Text="{x:Bind GreetingText.Copy|To}" />');
    const md = await h.hoverAt(buffer);
    assert.match(md, /void string\.CopyTo\(/, `expected the void CopyTo signature; got: ${md}`);
    assert.match(md, /\*\*Parameters:\*\*/, `void method with documented params must carry Parameters; got: ${md}`);
    const bullets = (md.match(/^- `[^`]+`: \S/gm) || []);
    assert.ok(bullets.length >= 1, `expected at least one documented param bullet; got: ${md}`);
    assert.doesNotMatch(md, /\*\*Returns:\*\*/, `a void method (no <returns>) must NOT emit a Returns section; got: ${md}`);
  });

  it("red-team 70 event-handler VALUE hover uses deterministic metadata prose", async () => {
    // Distinct resolution path from the {x:Bind ...()} function binding: the handler ATTRIBUTE VALUE resolves to the OnGo_Click method directly.
    const buffer = page('<Button Click="OnGo_C|lick" />');
    const md = await h.hoverAt(buffer);
    assert.strictEqual(
      md,
      "```csharp\nvoid SmokePage.OnGo_Click(object sender, RoutedEventArgs e)\n```\n\nMethod `OnGo_Click` declared by `SmokeFixture.SmokePage`.",
      `undocumented event-handler value hover must use deterministic metadata prose; buffer=${JSON.stringify(buffer)} caret=${caretOffset(buffer)}`
    );
  });

  it("red-team 70 function binding with arguments still enriches the method-name segment", async () => {
    const buffer = page('<TextBlock Text="{x:Bind Find|Name(\'x\')}" />');
    const md = await h.hoverAt(buffer);
    assertEnrichedMethod(md, /object FrameworkElement\.FindName\(string name\)/, ["name"], `buffer=${JSON.stringify(buffer)} caret=${caretOffset(buffer)}`);
  });
});
