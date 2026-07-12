"use strict";

// Round 17 red-team probes: adversarial false-positive hunting for the round-16
// non-first-segment WXAML0005 x:Bind validator, plus a small regression sweep.

const assert = require("node:assert");
const h = require("./helper");

function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
}

function diagSummary(diags) {
  return diags.map((d) => `${d.code}:${d.message}`).join("; ");
}

function wxaml(diags) {
  return diags.filter((x) => /^WXAML/.test(String(x.code || "")));
}

function wxaml0005(diags) {
  return diags.filter((x) => x.code === "WXAML0005");
}

async function assertNoWxaml0005(buffer, why) {
  const diags = await h.diagnosticsFor(buffer, () => false, 4000);
  assert.deepStrictEqual(wxaml0005(diags), [], `${why}; buffer=${buffer}; got ${diagSummary(diags)}`);
}

async function assertOneWxaml0005(buffer, memberName, why) {
  const diags = await h.diagnosticsFor(
    buffer,
    (d) => d.some((x) => x.code === "WXAML0005" && new RegExp(memberName).test(x.message)),
    12000
  );
  const bad = wxaml(diags);
  assert.strictEqual(bad.length, 1, `${why}: should raise exactly one WXAML diagnostic; buffer=${buffer}; got ${diagSummary(diags)}`);
  assert.strictEqual(bad[0].code, "WXAML0005", `${why}: diagnostic should be WXAML0005; buffer=${buffer}; got ${diagSummary(diags)}`);
  assert.ok(new RegExp(memberName).test(bad[0].message), `${why}: diagnostic should name ${memberName}; buffer=${buffer}; got ${bad[0].message}`);
}

describe("WinUI XAML red-team 17 — x:Bind non-first diagnostics false-positive hunt", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("stays silent for string and primitive deep member chains", async () => {
    const buffer = page([
      "<StackPanel>",
      "  <TextBlock Text=\"{x:Bind GreetingText.Length}\" />",
      "  <TextBlock Text=\"{x:Bind GreetingText.ToString.Length}\" />",
      "  <TextBlock Text=\"{x:Bind GreetingText.Length.ToString}\" />",
      "</StackPanel>",
    ].join("\n  "));
    await assertNoWxaml0005(buffer, "valid string/int member chains should not raise WXAML0005");
  });

  it("stays silent for IReadOnlyList interface members and inherited enumerator methods", async () => {
    const buffer = page([
      "<StackPanel>",
      "  <TextBlock Text=\"{x:Bind Items.Count}\" />",
      "  <TextBlock Text=\"{x:Bind Items.GetEnumerator}\" />",
      "</StackPanel>",
    ].join("\n  "));
    await assertNoWxaml0005(buffer, "valid collection/interface member chains should not raise WXAML0005");
  });

  it.skip("known accepted edge: object-only member after interface-return method", async () => {
    // KNOWN-ACCEPTED-EDGE: the shared bindable-member oracle intentionally excludes
    // System.Object-declared members on interface return types.
    const buffer = page("<TextBlock Text=\"{x:Bind Items.GetEnumerator.ToString}\" />");
    await assertNoWxaml0005(buffer, "object-only ToString on IEnumerator is valid XAML but intentionally excluded today");
  });

  it("stays silent for indexer element chains on IReadOnlyList string elements", async () => {
    const buffer = page([
      "<StackPanel>",
      "  <TextBlock Text=\"{x:Bind Items[0].Length}\" />",
      "  <TextBlock Text=\"{x:Bind Items[0].ToString.Length}\" />",
      "  <TextBlock Text=\"{x:Bind Items[0].Length.ToString}\" />",
      "</StackPanel>",
    ].join("\n  "));
    await assertNoWxaml0005(buffer, "valid indexer element member chains should not raise WXAML0005");
  });

  it("stays silent for named Path= x:Bind paths followed by Mode and Converter args", async () => {
    const buffer = page([
      "<Page.Resources>",
      "  <SolidColorBrush x:Key=\"Round17ConverterStandIn\" Color=\"Red\" />",
      "</Page.Resources>",
      "<StackPanel>",
      "  <TextBlock Text=\"{x:Bind Path=GreetingText.Length, Mode=OneWay}\" />",
      "  <TextBlock Tag=\"{x:Bind Path=Items[0].Length, Mode=OneWay, Converter={StaticResource Round17ConverterStandIn}, ConverterParameter=probe}\" />",
      "</StackPanel>",
    ].join("\n  "));
    await assertNoWxaml0005(buffer, "valid named Path= chains with trailing named args should not raise WXAML0005");
  });

  it("stays silent when leading boolean negation precedes valid dotted paths", async () => {
    const buffer = page([
      "<StackPanel>",
      "  <TextBlock Tag=\"{x:Bind !GreetingText.Length, Mode=OneWay}\" />",
      "  <TextBlock Tag=\"{x:Bind !! Items.Count, Mode=OneWay}\" />",
      "  <TextBlock Tag=\"{x:Bind ! Items[0].Length, Mode=OneWay}\" />",
      "</StackPanel>",
    ].join("\n  "));
    await assertNoWxaml0005(buffer, "leading ! negation should be stripped before the dotted-path walk");
  });

  it("stays silent for DataTemplate x:DataType rerooting to SmokePage", async () => {
    const buffer = page([
      "<ListView ItemsSource=\"{x:Bind Items}\">",
      "  <ListView.ItemTemplate>",
      "    <DataTemplate x:DataType=\"local:SmokePage\">",
      "      <StackPanel>",
      "        <TextBlock Text=\"{x:Bind GreetingText.Length}\" />",
      "        <TextBlock Text=\"{x:Bind Items[0].Length}\" />",
      "      </StackPanel>",
      "    </DataTemplate>",
      "  </ListView.ItemTemplate>",
      "</ListView>",
    ].join("\n  "));
    await assertNoWxaml0005(buffer, "x:DataType=local:SmokePage should reroot valid x:Bind chains");
  });

  it("stays silent for DataTemplate x:DataType rerooting to x:String", async () => {
    const buffer = page([
      "<ItemsRepeater ItemsSource=\"{x:Bind Items}\">",
      "  <ItemsRepeater.ItemTemplate>",
      "    <DataTemplate x:DataType=\"x:String\">",
      "      <StackPanel>",
      "        <TextBlock Text=\"{x:Bind Length}\" />",
      "        <TextBlock Text=\"{x:Bind Length.ToString}\" />",
      "        <TextBlock Text=\"{x:Bind ToString.Length}\" />",
      "      </StackPanel>",
      "    </DataTemplate>",
      "  </ItemsRepeater.ItemTemplate>",
      "</ItemsRepeater>",
    ].join("\n  "));
    await assertNoWxaml0005(buffer, "x:DataType=x:String should allow valid string member chains");
  });

  it("stays silent for inherited Page base-class, struct, enum, and primitive members", async () => {
    const buffer = page([
      "<StackPanel>",
      "  <TextBlock Text=\"{x:Bind ActualWidth.ToString}\" />",
      "  <TextBlock Text=\"{x:Bind Margin.Left}\" />",
      "  <TextBlock Text=\"{x:Bind FlowDirection.ToString}\" />",
      "</StackPanel>",
    ].join("\n  "));
    await assertNoWxaml0005(buffer, "valid inherited Page member chains through double, Thickness, and enum should stay silent");
  });

  it("does not flag valid function-binding argument member chains", async () => {
    // Round 28 (#4) made function-binding ARGUMENTS validatable member paths (VS-parity: the XAML
    // compiler validates argument paths). This guard proves VALID argument chains stay silent — a bad
    // argument member is covered as a true-positive by redteam28 + the stdio smoke suite.
    const buffer = page([
      "<StackPanel>",
      "  <Button Content=\"{x:Bind OnGo_Click(GreetingText.Length), Mode=OneWay}\" />",
      "  <Button Tag=\"{x:Bind OnGo_Click(Items[0].Length), Mode=OneWay}\" />",
      "</StackPanel>",
    ].join("\n  "));
    await assertNoWxaml0005(buffer, "valid function binding argument paths should stay silent");
  });

  it("validates member chains after a cast against the cast target type (round 33)", async () => {
    // Round 33 (VS-parity): a C#-style cast ((ns:Type)Member) rebinds the x:Bind root to the cast TARGET
    // type, and the member chain after it is validated against that type — VS's XAML compiler checks these
    // too. This supersedes the round-16/26 conservative no-op that skipped cast-shaped paths entirely.
    // A bad TAIL member after a valid cast member is flagged, naming the tail member (Nope on string).
    await assertOneWxaml0005(
      page("<TextBlock Tag=\"{x:Bind (local:SmokePage)GreetingText.Nope, Mode=OneWay}\" />"),
      "Nope",
      "a bad member after (local:SmokePage)GreetingText should be flagged against string");
    // A bad FIRST member checked directly against the cast target fires (String has no Items member).
    await assertOneWxaml0005(
      page("<TextBlock Tag=\"{x:Bind (x:String)Items[0].Nope, Mode=OneWay}\" />"),
      "Items",
      "Items is not a member of the (x:String) cast target and should be flagged");
    // False-positive guard: a VALID member chain after a cast stays silent.
    await assertNoWxaml0005(
      page("<TextBlock Tag=\"{x:Bind (local:SmokePage)GreetingText.Length, Mode=OneWay}\" />"),
      "a valid member chain after a cast should stay silent");
  });

  it("stays silent for a dense realistic page mixing valid non-first paths across scopes", async () => {
    const buffer = page([
      "<Page.Resources>",
      "  <DataTemplate x:Key=\"Round17StringTemplate\" x:DataType=\"x:String\">",
      "    <TextBlock Text=\"{x:Bind Length.ToString, Mode=OneWay}\" />",
      "  </DataTemplate>",
      "</Page.Resources>",
      "<Grid>",
      "  <Grid.RowDefinitions>",
      "    <RowDefinition Height=\"Auto\" />",
      "    <RowDefinition Height=\"*\" />",
      "  </Grid.RowDefinitions>",
      "  <TextBlock Text=\"{x:Bind Path=GreetingText.Length, Mode=OneWay}\" />",
      "  <TextBlock Grid.Row=\"1\" Text=\"{x:Bind Items[0].Length.ToString, Mode=OneWay}\" />",
      "  <ListView Grid.Row=\"1\" ItemsSource=\"{x:Bind Items}\" ItemTemplate=\"{StaticResource Round17StringTemplate}\" />",
      "</Grid>",
    ].join("\n  "));
    await assertNoWxaml0005(buffer, "dense valid page should not produce WXAML0005 false positives");
  });

  it("reports exactly one bad second segment on a string path", async () => {
    const buffer = page("<TextBlock Text=\"{x:Bind GreetingText.NopeSecond17}\" />");
    await assertOneWxaml0005(buffer, "NopeSecond17", "bad string second segment");
  });

  it("reports exactly one bad second segment after indexer element resolution", async () => {
    const buffer = page("<TextBlock Text=\"{x:Bind Items[0].NopeIndexer17}\" />");
    await assertOneWxaml0005(buffer, "NopeIndexer17", "bad indexer element second segment");
  });

  it("reports exactly one bad third segment and names the actual offending member", async () => {
    const buffer = page("<TextBlock Text=\"{x:Bind GreetingText.Length.NopeThird17}\" />");
    await assertOneWxaml0005(buffer, "NopeThird17", "bad third segment after string.Length");
  });

  it("reports exactly one bad deep segment after indexer then valid member", async () => {
    const buffer = page("<TextBlock Text=\"{x:Bind Items[0].Length.NopeDeepIndexer17}\" />");
    await assertOneWxaml0005(buffer, "NopeDeepIndexer17", "bad deep segment after Items[0].Length");
  });

  it("reports exactly one bad named Path= tail member with following named args", async () => {
    const buffer = page("<TextBlock Text=\"{x:Bind Path=GreetingText.Length.NopeNamed17, Mode=OneWay, FallbackValue=missing}\" />");
    await assertOneWxaml0005(buffer, "NopeNamed17", "bad named Path= tail segment");
  });

  it("reports exactly one bad non-first interface-chain member", async () => {
    const buffer = page("<TextBlock Text=\"{x:Bind Items.Count.NopeCount17}\" />");
    await assertOneWxaml0005(buffer, "NopeCount17", "bad member after IReadOnlyList.Count");
  });
});

describe("WinUI XAML red-team 17 — light secondary regression sweep", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("keeps valid property elements silent while x:Bind tail validation is active", async () => {
    const buffer = page([
      "<Grid>",
      "  <Grid.RowDefinitions>",
      "    <RowDefinition>",
      "      <RowDefinition.Height>Auto</RowDefinition.Height>",
      "    </RowDefinition>",
      "  </Grid.RowDefinitions>",
      "  <TextBlock Text=\"{x:Bind GreetingText.Length}\" />",
      "</Grid>",
    ].join("\n  "));
    const diags = await h.diagnosticsFor(buffer, () => false, 4000);
    assert.deepStrictEqual(wxaml(diags), [], `valid property elements plus valid x:Bind should stay silent; buffer=${buffer}; got ${diagSummary(diags)}`);
  });

  it("flags one unknown normal attribute with WXAML0003", async () => {
    const buffer = page("<Button Round17BogusAttribute=\"x\" />");
    const diags = await h.diagnosticsFor(buffer, (d) => d.some((x) => x.code === "WXAML0003"), 12000);
    const bad = wxaml(diags);
    assert.strictEqual(bad.length, 1, `unknown normal attribute should raise exactly one WXAML diagnostic; buffer=${buffer}; got ${diagSummary(diags)}`);
    assert.strictEqual(bad[0].code, "WXAML0003", `unknown normal attribute should raise WXAML0003; buffer=${buffer}; got ${diagSummary(diags)}`);
    assert.ok(/Round17BogusAttribute/.test(bad[0].message), `diagnostic should name Round17BogusAttribute; buffer=${buffer}; got ${bad[0].message}`);
  });

  it("flags one unknown attached-property attribute with WXAML0004", async () => {
    const buffer = page("<TextBlock Grid.Round17Bogus=\"0\" />");
    const diags = await h.diagnosticsFor(buffer, (d) => d.some((x) => x.code === "WXAML0004"), 12000);
    const bad = wxaml(diags);
    assert.strictEqual(bad.length, 1, `unknown attached property should raise exactly one WXAML diagnostic; buffer=${buffer}; got ${diagSummary(diags)}`);
    assert.strictEqual(bad[0].code, "WXAML0004", `unknown attached property should raise WXAML0004; buffer=${buffer}; got ${diagSummary(diags)}`);
    assert.ok(/Round17Bogus/.test(bad[0].message), `diagnostic should name Round17Bogus; buffer=${buffer}; got ${bad[0].message}`);
  });

  it("flags one unknown element with WXAML0002", async () => {
    const buffer = page("<local:Round17MissingControl />");
    const diags = await h.diagnosticsFor(buffer, (d) => d.some((x) => x.code === "WXAML0002"), 12000);
    const bad = wxaml(diags);
    assert.strictEqual(bad.length, 1, `unknown local element should raise exactly one WXAML diagnostic; buffer=${buffer}; got ${diagSummary(diags)}`);
    assert.strictEqual(bad[0].code, "WXAML0002", `unknown local element should raise WXAML0002; buffer=${buffer}; got ${diagSummary(diags)}`);
    assert.ok(/Round17MissingControl/.test(bad[0].message), `diagnostic should name Round17MissingControl; buffer=${buffer}; got ${bad[0].message}`);
  });

  it("hover still resolves a valid non-first x:Bind segment", async () => {
    const buffer = page("<TextBlock Text=\"{x:Bind Items[0].Len|gth}\" />");
    const md = await h.hoverAt(buffer);
    assert.ok(/Length/.test(md), `hover should mention Length; buffer=${buffer}; got ${md}`);
    assert.ok(/int|Int32|System\.Int32/.test(md), `hover should include integer type; buffer=${buffer}; got ${md}`);
  });
});
