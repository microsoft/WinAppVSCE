"use strict";

// Round 11 red-team probes: x:Bind path SHAPES beyond dotted segments —
//   (a) indexer paths (Items[0].Member): completion, hover, and first-segment diagnostics unwrap
//       the collection element type (IReadOnlyList<string> -> string);
//   (b) function-binding arguments (Method(arg)): F12/hover resolve the identifier under the caret
//       inside the parentheses against the bind root.
//
// These promote the round-10 `it.skip` "NEXT" probes to live regressions. Assertions are hermetic:
// the expected member names (Length, GreetingText) are NOT present as bare words in the buffer, so a
// pass reflects the language server rather than VS Code's word-based suggestions.

const assert = require("node:assert");
const path = require("node:path");
const h = require("./helper");

const CS = "SmokePage.xaml.cs";
const XAML = "SmokePage.xaml";

function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
}

function diagSummary(diags) {
  return diags.map((d) => `${d.code}:${d.message}`).join("; ");
}

describe("WinUI XAML red-team 11 — x:Bind indexer paths", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("completes element-type members after an x:Bind indexer into IReadOnlyList<string>", async () => {
    const buffer = page('<TextBlock Text="{x:Bind Items[0].|}" />');
    const items = await h.completionsAt(buffer);
    assert.ok(
      items.includes("Length"),
      `x:Bind 'Items[0].' should complete String.Length; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`
    );
  });

  it("hover on the member after an x:Bind indexer identifies String.Length", async () => {
    const buffer = page('<TextBlock Text="{x:Bind Items[0].Len|gth}" />');
    const md = await h.hoverAt(buffer);
    assert.ok(/Length/.test(md), `indexer member hover should mention Length; buffer=${buffer}; got: ${md}`);
    assert.ok(/int|Int32|System\.Int32/.test(md), `indexer member hover should include the Length type; buffer=${buffer}; got: ${md}`);
    assert.ok(!/Items/.test(md), `indexer member hover should describe Length, not the Items collection; buffer=${buffer}; got: ${md}`);
  });

  it("hover on the indexer base identifies the collection member itself", async () => {
    const buffer = page('<TextBlock Text="{x:Bind Item|s[0].Length}" />');
    const md = await h.hoverAt(buffer);
    assert.ok(/Items/.test(md), `indexer base hover should identify the Items member; buffer=${buffer}; got: ${md}`);
  });

  it("flags a bogus indexer first-segment base with WXAML0005", async () => {
    const buffer = page('<TextBlock Text="{x:Bind Bogus[0].Length}" />');
    const diags = await h.diagnosticsFor(buffer, (d) => d.some((x) => x.code === "WXAML0005"), 12000);
    const bad = diags.filter((x) => x.code === "WXAML0005");
    assert.strictEqual(bad.length, 1, `bogus indexer base should raise exactly 1 WXAML0005; buffer=${buffer}; got ${diagSummary(diags)}`);
    assert.ok(/Bogus/.test(bad[0].message), `WXAML0005 should name the bogus base 'Bogus'; got ${bad[0].message}`);
  });

  it("stays silent for a valid indexer first-segment base (Items[0])", async () => {
    const buffer = page('<TextBlock Text="{x:Bind Items[0].Length}" />');
    const diags = await h.diagnosticsFor(buffer, () => false, 10000);
    const bad = diags.find((x) => /^WXAML/.test(String(x.code || "")));
    assert.ok(!bad, `valid indexer path should stay silent; buffer=${buffer}; got ${diagSummary(diags)}`);
  });
});

describe("WinUI XAML red-team 11 — x:Bind function-binding arguments", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("F12 resolves an x:Bind member used as a function argument", async () => {
    const buffer = page('<TextBlock Text="{x:Bind OnGo_Click(Greeting|Text)}" />');
    const defs = await h.definitionsAt(buffer);
    assert.ok(defs.length > 0, `x:Bind argument member should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), CS, `expected ${CS}; buffer=${buffer}; got ${defs[0].fsPath}`);
  });

  it("hover on an x:Bind function argument identifies the member and its type", async () => {
    const buffer = page('<TextBlock Text="{x:Bind OnGo_Click(Greeting|Text)}" />');
    const md = await h.hoverAt(buffer);
    assert.ok(/GreetingText/.test(md), `function-arg hover should mention GreetingText; buffer=${buffer}; got: ${md}`);
    assert.ok(/string|String/.test(md), `function-arg hover should include the GreetingText type; buffer=${buffer}; got: ${md}`);
  });

  it("resolves a later argument in a multi-argument function binding", async () => {
    const buffer = page('<TextBlock Text="{x:Bind OnGo_Click(GreetingText, Greeting|Text)}" />');
    const defs = await h.definitionsAt(buffer);
    assert.ok(defs.length > 0, `later function-arg member should resolve; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    assert.strictEqual(path.basename(defs[0].fsPath), CS, `expected ${CS}; buffer=${buffer}; got ${defs[0].fsPath}`);
  });

  it("hover on a dotted path inside a function argument resolves the caret segment", async () => {
    const buffer = page('<TextBlock Text="{x:Bind OnGo_Click(GreetingText.Len|gth)}" />');
    const md = await h.hoverAt(buffer);
    assert.ok(/Length/.test(md), `dotted function-arg hover should mention Length; buffer=${buffer}; got: ${md}`);
    assert.ok(/int|Int32|System\.Int32/.test(md), `dotted function-arg hover should include the Length type; buffer=${buffer}; got: ${md}`);
  });

  it("does not crash or mis-resolve when the caret sits inside empty indexer brackets", async () => {
    const buffer = page('<TextBlock Text="{x:Bind Items[|]}" />');
    const items = await h.completionsAt(buffer);
    // No members can be offered inside the index expression itself — just assert the server responded.
    assert.ok(Array.isArray(items), `completion inside indexer brackets should return a list; buffer=${buffer}; got ${JSON.stringify(items)}`);
  });
});
