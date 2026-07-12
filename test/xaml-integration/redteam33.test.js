"use strict";

// Round 33 red-team probes for cast-path x:Bind typo diagnostics. These target
// false positives, false negatives, diagnostic quality, and cast vs attached-property
// disambiguation through the real VS Code integration harness.

const assert = require("node:assert");
const h = require("./helper");

function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
}

function wxaml(diags) {
  return diags.filter((x) => /^WXAML/.test(String(x.code || "")));
}

function wxaml0005(diags) {
  return wxaml(diags).filter((x) => x.code === "WXAML0005");
}

function summary(diags) {
  return wxaml(diags).map((d) => {
    const r = d.range ? `${d.range.start.line}:${d.range.start.character}-${d.range.end.line}:${d.range.end.character}` : "?:?";
    return `${d.code}:${d.message}@${r}`;
  }).join("; ");
}

function diagText(diag) {
  return h.getDoc().getText(diag.range);
}

async function assertNoWxaml0005(buffer, why) {
  const diags = await h.diagnosticsFor(buffer, () => false, 4500);
  assert.deepStrictEqual(wxaml0005(diags), [], `${why}; buffer=${buffer}; got ${summary(diags)}`);
}

async function assertOneWxaml0005(buffer, memberName, why) {
  const diags = await h.diagnosticsFor(
    buffer,
    (d) => wxaml0005(d).some((x) => x.message.includes(memberName) || diagText(x) === memberName),
    12000
  );
  const allWxaml = wxaml(diags);
  const hits = wxaml0005(diags);
  assert.strictEqual(allWxaml.length, 1, `${why}: should raise exactly one WXAML diagnostic; buffer=${buffer}; got ${summary(diags)}`);
  assert.strictEqual(hits.length, 1, `${why}: should raise exactly one WXAML0005; buffer=${buffer}; got ${summary(diags)}`);
  assert.ok(hits[0].message.includes(memberName), `${why}: diagnostic should name ${memberName}; buffer=${buffer}; got ${hits[0].message}`);
  return hits[0];
}

async function assertOneWxaml0005OnToken(buffer, memberName, why) {
  const hit = await assertOneWxaml0005(buffer, memberName, why);
  assert.strictEqual(diagText(hit), memberName, `${why}: range should underline only ${memberName}; buffer=${buffer}; got text=${JSON.stringify(diagText(hit))}; diag=${summary([hit])}`);
  const line = h.getDoc().lineAt(hit.range.start.line).text;
  assert.strictEqual(
    line.slice(hit.range.start.character, hit.range.end.character),
    memberName,
    `${why}: range characters should slice the offending token; line=${line}; diag=${summary([hit])}`
  );
}

describe("WinUI XAML red-team 33 — cast-path x:Bind typo diagnostics", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("stays silent for valid cast chains through strings, collections, structs, enums, and primitives", async () => {
    const buffer = page([
      "<StackPanel>",
      "  <TextBlock Text=\"{x:Bind (local:SmokePage)GreetingText.Length.ToString, Mode=OneWay}\" />",
      "  <TextBlock Tag=\"{x:Bind (local:SmokePage)Items[0].Length, Mode=OneWay}\" />",
      "  <TextBlock Tag=\"{x:Bind (local:SmokePage)ActualWidth.ToString, Mode=OneWay}\" />",
      "  <TextBlock Tag=\"{x:Bind (local:SmokePage)Margin.Left.ToString, Mode=OneWay}\" />",
      "  <TextBlock Tag=\"{x:Bind (local:SmokePage)FlowDirection.ToString, Mode=OneWay}\" />",
      "</StackPanel>",
    ].join("\n  "));
    await assertNoWxaml0005(buffer, "valid cast chains over known framework and fixture members should stay silent");
  });

  it("stays silent for intrinsic x:String casts and a bare indexed collection element", async () => {
    const buffer = page([
      "<StackPanel>",
      "  <TextBlock Text=\"{x:Bind (x:String)Length.ToString, Mode=OneWay}\" />",
      "  <TextBlock Tag=\"{x:Bind (x:String)ToString.Length, Mode=OneWay}\" />",
      "  <TextBlock Content=\"{x:Bind (local:SmokePage)Items[0], Mode=OneWay}\" />",
      "</StackPanel>",
    ].join("\n  "));
    await assertNoWxaml0005(buffer, "valid intrinsic casts and indexer-only cast tails should not raise WXAML0005");
  });

  it("stays silent for valid casts across DataTemplate scopes and different target attributes", async () => {
    const buffer = page([
      "<ItemsRepeater ItemsSource=\"{x:Bind Items}\">",
      "  <ItemsRepeater.ItemTemplate>",
      "    <DataTemplate x:DataType=\"x:String\">",
      "      <StackPanel>",
      "        <TextBlock Text=\"{x:Bind (local:SmokePage)GreetingText.Length, Mode=OneWay}\" />",
      "        <TextBlock Tag=\"{x:Bind (local:SmokePage)Items[0].Length, Mode=OneWay}\" />",
      "        <Button Content=\"{x:Bind (x:String)Length.ToString, Mode=OneWay}\" />",
      "        <TextBlock Visibility=\"{x:Bind (local:SmokePage)FlowDirection.ToString, Mode=OneWay}\" />",
      "      </StackPanel>",
      "    </DataTemplate>",
      "  </ItemsRepeater.ItemTemplate>",
      "</ItemsRepeater>",
    ].join("\n  "));
    await assertNoWxaml0005(buffer, "valid cast roots should override x:DataType and stay silent in varied attributes");
  });

  it("does not mistake attached-property steps for casts, even beside a real cast typo", async () => {
    const buffer = page([
      "<StackPanel>",
      "  <TextBlock Text=\"{x:Bind (Grid.Row)}\" />",
      "  <TextBlock Tag=\"{x:Bind (Canvas.Left)}\" />",
      "  <Button Content=\"{x:Bind (local:SmokePage)TotallyBogus33}\" />",
      "</StackPanel>",
    ].join("\n  "));
    await assertOneWxaml0005OnToken(buffer, "TotallyBogus33", "only the real cast member typo should be diagnosed");
  });

  it("keeps attached-property-shaped paths with dotted tails silent", async () => {
    const buffer = page([
      "<StackPanel>",
      "  <TextBlock Text=\"{x:Bind (Grid.Row).NopeShouldNotBeCast33}\" />",
      "  <TextBlock Tag=\"{x:Bind (Canvas.Left).NopeShouldNotBeCast33}\" />",
      "</StackPanel>",
    ].join("\n  "));
    await assertNoWxaml0005(buffer, "attached-property-shaped parenthesized steps must not be treated as casts");
  });

  it("keeps unresolved and malformed cast shapes silent", async () => {
    const buffer = page([
      "<StackPanel>",
      "  <TextBlock Text=\"{x:Bind (local:Unknown33)GreetingText}\" />",
      "  <TextBlock Text=\"{x:Bind (zzz:SmokePage)GreetingText}\" />",
      "  <TextBlock Text=\"{x:Bind ()GreetingText}\" />",
      "  <TextBlock Text=\"{x:Bind (   )GreetingText}\" />",
      "  <TextBlock Text=\"{x:Bind ((local:SmokePage)GreetingText}\" />",
      "  <TextBlock Text=\"{x:Bind (local:SmokePage}\" />",
      "  <TextBlock Text=\"{x:Bind (local:SmokePage)}\" />",
      "</StackPanel>",
    ].join("\n  "));
    await assertNoWxaml0005(buffer, "unresolved, empty, unterminated, nested, and no-member casts should stay silent");
  });

  it("keeps non-identifier/function-call-shaped cast tails silent", async () => {
    const buffer = page([
      "<StackPanel>",
      "  <TextBlock Text=\"{x:Bind (local:SmokePage)Method() }\" />",
      "  <TextBlock Text=\"{x:Bind (local:SmokePage)GreetingText.ToString().NopeAfterCall33}\" />",
      "</StackPanel>",
    ].join("\n  "));
    await assertNoWxaml0005(buffer, "function-call-shaped segments after casts should not produce WXAML0005 false positives");
  });

  it("accepts whitespace around the cast without false positives", async () => {
    const buffer = page([
      "<StackPanel>",
      "  <TextBlock Text=\"{x:Bind    ( local:SmokePage ) GreetingText.Length , Mode=OneWay}\" />",
      "  <TextBlock Tag=\"{x:Bind !( local:SmokePage ) Items[0].Length, Mode=OneWay}\" />",
      "</StackPanel>",
    ].join("\n  "));
    await assertNoWxaml0005(buffer, "whitespace around a valid cast should preserve member validation and span accounting");
  });

  it("flags a bad tail after a valid user-type cast member and underlines only the bad token", async () => {
    const buffer = page("<TextBlock Tag=\"{x:Bind (local:SmokePage)GreetingText.NopeTail33, Mode=OneWay}\" />");
    await assertOneWxaml0005OnToken(buffer, "NopeTail33", "bad tail after cast-derived string");
  });

  it("flags a bad first member against the user-type cast target", async () => {
    const buffer = page("<TextBlock Tag=\"{x:Bind (local:SmokePage)DefinitelyMissingFirst33, Mode=OneWay}\" />");
    await assertOneWxaml0005OnToken(buffer, "DefinitelyMissingFirst33", "bad first member after local:SmokePage cast");
  });

  it("flags a bad first member against an intrinsic x:String cast target", async () => {
    const buffer = page("<TextBlock Tag=\"{x:Bind (x:String)NotAStringMember33, Mode=OneWay}\" />");
    await assertOneWxaml0005OnToken(buffer, "NotAStringMember33", "bad first member after x:String cast");
  });

  it("flags a bad deep member after an indexed collection element cast chain", async () => {
    const buffer = page("<TextBlock Tag=\"{x:Bind (local:SmokePage)Items[0].NopeIndexed33, Mode=OneWay}\" />");
    await assertOneWxaml0005OnToken(buffer, "NopeIndexed33", "bad member after cast Items[0] should be checked against string");
  });

  it("flags an explicit Path= cast typo and keeps the range on the member token", async () => {
    const buffer = page("<TextBlock Text=\"{x:Bind Path=(local:SmokePage)GreetingText.NopePath33, Mode=OneWay, FallbackValue=missing}\" />");
    await assertOneWxaml0005OnToken(buffer, "NopePath33", "explicit Path= cast typo should be validated");
  });

  it("flags negation plus a cast typo", async () => {
    const buffer = page("<TextBlock Tag=\"{x:Bind !(local:SmokePage)BogusNegated33, Mode=OneWay}\" />");
    await assertOneWxaml0005OnToken(buffer, "BogusNegated33", "leading ! before cast should still validate the cast target member");
  });

  it("flags a cast typo inside a conflicting x:DataType template against the cast target", async () => {
    const buffer = page([
      "<ItemsRepeater ItemsSource=\"{x:Bind Items}\">",
      "  <ItemsRepeater.ItemTemplate>",
      "    <DataTemplate x:DataType=\"x:String\">",
      "      <TextBlock Text=\"{x:Bind (local:SmokePage)BogusTemplate33, Mode=OneWay}\" />",
      "    </DataTemplate>",
      "  </ItemsRepeater.ItemTemplate>",
      "</ItemsRepeater>",
    ].join("\n  "));
    const hit = await assertOneWxaml0005(buffer, "BogusTemplate33", "cast typo inside x:String DataTemplate should validate against SmokePage");
    assert.match(hit.message, /SmokePage/, `diagnostic should name the cast target type; buffer=${buffer}; got ${hit.message}`);
    assert.strictEqual(diagText(hit), "BogusTemplate33", `diagnostic range should underline the template typo token; got ${summary([hit])}`);
  });

  it("does not double-report a single cast typo or emit unrelated WXAML codes", async () => {
    const buffer = page("<TextBlock Text=\"{x:Bind (local:SmokePage)GreetingText.NopeSingleReport33}\" />");
    const hit = await assertOneWxaml0005(buffer, "NopeSingleReport33", "single cast typo");
    assert.strictEqual(hit.code, "WXAML0005", `single cast typo should only produce WXAML0005; got ${summary([hit])}`);
    assert.strictEqual(diagText(hit), "NopeSingleReport33", `single cast typo range should be exact; got ${summary([hit])}`);
  });
});
