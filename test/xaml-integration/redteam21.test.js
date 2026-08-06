"use strict";

// Round 21 red-team probes for {x:Type}/{x:Static}: caret-boundary resolution,
// malformed references, nested markup-extension usage, completion, and F12.

const assert = require("node:assert");
const path = require("node:path");
const h = require("./helper");

const CS = "SmokePage.xaml.cs";

function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
}

function assertHoverEmpty(md, buffer, reason) {
  assert.strictEqual(typeof md, "string", `${reason} should return a stable hover string; buffer=${buffer}; got ${md}`);
  assert.strictEqual(md, "", `${reason} should not resolve a symbol; buffer=${buffer}; got ${md}`);
}

function assertNoStaticMember(md, member, buffer, reason) {
  assert.strictEqual(typeof md, "string", `${reason} should return a stable hover string; buffer=${buffer}; got ${md}`);
  assert.ok(!new RegExp(`\\b${member}\\b`).test(md), `${reason} must not resolve ${member}; buffer=${buffer}; got ${md}`);
}

describe("WinUI XAML red-team 21 — {x:Type}/{x:Static} adversarial probes", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("x:Static hover resolves the owner enum on the owner segment", async () => {
    const buffer = page('<Button Tag="{x:Static Visi|bility.Collapsed}" />');
    const md = await h.hoverAt(buffer);
    assert.ok(/Visibility/.test(md), `owner-segment hover should name Visibility; buffer=${buffer}; got ${md}`);
    assert.ok(!/Collapsed/.test(md), `owner-segment hover must not resolve the Collapsed member; buffer=${buffer}; got ${md}`);
  });

  it("x:Static hover resolves the owner enum on the dot boundary", async () => {
    const buffer = page('<Button Tag="{x:Static Visibility|.Collapsed}" />');
    const md = await h.hoverAt(buffer);
    assert.ok(/Visibility/.test(md), `dot-boundary hover should name Visibility; buffer=${buffer}; got ${md}`);
    assert.ok(!/Collapsed/.test(md), `dot-boundary hover must not resolve the Collapsed member; buffer=${buffer}; got ${md}`);
  });

  it("x:Static hover resolves the member at the first member character", async () => {
    const buffer = page('<Button Tag="{x:Static Visibility.|Collapsed}" />');
    const md = await h.hoverAt(buffer);
    assert.ok(/Collapsed/.test(md), `first member char should resolve Collapsed; buffer=${buffer}; got ${md}`);
  });

  it("x:Static hover resolves the member inside the member segment", async () => {
    const buffer = page('<Button Tag="{x:Static Visibility.Collapse|d}" />');
    const md = await h.hoverAt(buffer);
    assert.ok(/Collapsed/.test(md), `member hover should resolve Collapsed; buffer=${buffer}; got ${md}`);
  });

  for (const probe of [
    { name: "empty x:Type argument", xaml: '<Button Tag="{x:Type |}" />' },
    { name: "dotted x:Type argument", xaml: '<Button Tag="{x:Type .|}" />' },
    { name: "empty local prefix x:Type argument", xaml: '<Button Tag="{x:Type local:|}" />' },
    { name: "x:Static without member", xaml: '<Button Tag="{x:Static Fo|o}" />' },
    { name: "x:Static with empty member", xaml: '<Button Tag="{x:Static Foo.|}" />' },
    { name: "x:Static with empty owner", xaml: '<Button Tag="{x:Static .|Bar}" />' },
    { name: "x:Static with multi-dot path", xaml: '<Button Tag="{x:Static A.B.C|}" />' },
  ]) {
    it(`does not crash or invent hover/definition for malformed refs: ${probe.name}`, async () => {
      const buffer = page(probe.xaml);
      const md = await h.hoverAt(buffer);
      assertHoverEmpty(md, buffer, probe.name);
      const defs = await h.definitionsAt(buffer);
      assert.ok(Array.isArray(defs), `malformed ${probe.name} F12 should return a stable array; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    });
  }

  for (const probe of [
    { name: "unknown framework-looking x:Type", xaml: '<Button Tag="{x:Type Bog|us}" />' },
    { name: "unknown local x:Type", xaml: '<Button Tag="{x:Type local:DoesNot|Exist}" />' },
    { name: "unknown enum member", xaml: '<Button Tag="{x:Static Visibility.No|pe}" />' },
    { name: "unknown owner", xaml: '<Button Tag="{x:Static Bogus.X|}" />' },
  ]) {
    it(`does not guess unknown refs: ${probe.name}`, async () => {
      const buffer = page(probe.xaml);
      const md = await h.hoverAt(buffer);
      assertHoverEmpty(md, buffer, probe.name);
      const defs = await h.definitionsAt(buffer);
      assert.ok(Array.isArray(defs), `unknown ${probe.name} F12 should return a stable array; buffer=${buffer}; got ${JSON.stringify(defs)}`);
      assert.strictEqual(defs.length, 0, `unknown ${probe.name} F12 should be empty; buffer=${buffer}; got ${JSON.stringify(defs)}`);
    });
  }

  // Unterminated refs (missing closing brace) resolve TOLERANTLY — identical to how {x:Bind} and every
  // other markup extension behaves in this tolerant parser (VS-parity "quick-info while typing"). The
  // parser recovers the extension node AND raises an XAML0005 "Unterminated markup extension." diagnostic,
  // so the user still gets nudged to close the brace. Asserting "" here would be anti-parity, so instead
  // we lock in that the symbol resolves and the diagnostic fires.
  it("unterminated x:Type still resolves the type (tolerant) and flags XAML0005", async () => {
    const buffer = page('<Button Tag="{x:Type Butt|on" />');
    const md = await h.hoverAt(buffer);
    assert.ok(/class\s+.*Button/.test(md), `unterminated x:Type should still resolve Button; buffer=${buffer}; got ${md}`);
    const diags = await h.diagnosticsFor(buffer, (d) => d.some((x) => /Unterminated/i.test(x.message)));
    assert.ok(diags.some((x) => /Unterminated/i.test(x.message)), `unterminated x:Type should raise the unterminated diagnostic; got ${diags.map((x) => `${x.code}:${x.message}`).join("; ")}`);
  });

  it("unterminated x:Static still resolves the member (tolerant) and flags XAML0005", async () => {
    const buffer = page('<Button Tag="{x:Static Visibility.Collap|sed" />');
    const md = await h.hoverAt(buffer);
    assert.ok(/Collapsed/.test(md), `unterminated x:Static should still resolve Collapsed; buffer=${buffer}; got ${md}`);
    const diags = await h.diagnosticsFor(buffer, (d) => d.some((x) => /Unterminated/i.test(x.message)));
    assert.ok(diags.some((x) => /Unterminated/i.test(x.message)), `unterminated x:Static should raise the unterminated diagnostic; got ${diags.map((x) => `${x.code}:${x.message}`).join("; ")}`);
  });

  it("x:Static does not resolve an instance property as a static member", async () => {
    const buffer = page('<Button Tag="{x:Static Button.Cont|ent}" />');
    const md = await h.hoverAt(buffer);
    assertNoStaticMember(md, "Content", buffer, "Button.Content instance property");
  });

  it("nested x:Type inside Binding Converter still resolves the local user type", async () => {
    const buffer = page('<TextBlock Text="{Binding Converter={x:Type local:Smoke|Page}}" />');
    const md = await h.hoverAt(buffer);
    assert.ok(/SmokePage/.test(md), `nested x:Type hover should resolve SmokePage; buffer=${buffer}; got ${md}`);
    const defs = await h.definitionsAt(buffer);
    assert.ok(defs.some((d) => path.basename(d.fsPath) === CS), `nested x:Type F12 should land in ${CS}; buffer=${buffer}; got ${JSON.stringify(defs)}`);
  });

  it("nested x:Static inside Binding Source still resolves the enum member", async () => {
    const buffer = page('<TextBlock Text="{Binding Source={x:Static Visibility.Collap|sed}}" />');
    const md = await h.hoverAt(buffer);
    assert.ok(/Collapsed/.test(md), `nested x:Static hover should resolve Collapsed; buffer=${buffer}; got ${md}`);
  });

  it("x:Type resolves inside Setter.Value placement", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <Style x:Key="Round21Style" TargetType="Button">',
      '    <Setter Property="Tag" Value="{x:Type Butt|on}" />',
      "  </Style>",
      "</Page.Resources>",
      '<Button Style="{StaticResource Round21Style}" />',
    ].join("\n  "));
    const md = await h.hoverAt(buffer);
    assert.ok(/Button/.test(md), `Setter Value x:Type hover should resolve Button; buffer=${buffer}; got ${md}`);
  });

  it("x:Static resolves inside a DataTemplate attribute", async () => {
    const buffer = page([
      "<Page.Resources>",
      '  <DataTemplate x:Key="Round21Template" x:DataType="x:String">',
      '    <TextBlock Tag="{x:Static Visibility.Vis|ible}" />',
      "  </DataTemplate>",
      "</Page.Resources>",
      '<ContentControl ContentTemplate="{StaticResource Round21Template}" />',
    ].join("\n  "));
    const md = await h.hoverAt(buffer);
    assert.ok(/Visible/.test(md), `DataTemplate x:Static hover should resolve Visible; buffer=${buffer}; got ${md}`);
  });

  it("completion offers x:Type and x:Static as markup-extension names", async () => {
    const typeItems = await h.completionsAt(page('<Button Tag="{x:Typ|}" />'));
    assert.ok(typeItems.includes("x:Type"), `markup-name completion should include x:Type; got ${typeItems.slice(0, 80).join(", ")}`);

    const staticItems = await h.completionsAt(page('<Button Tag="{x:Sta|}" />'));
    assert.ok(staticItems.includes("x:Static"), `markup-name completion should include x:Static; got ${staticItems.slice(0, 80).join(", ")}`);
  });

  it("x:Type completion offers framework type names in the argument", async () => {
    const buffer = page('<Button Tag="{x:Type Butt|}" />');
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("Button"), `x:Type argument completion should include Button; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("x:Static owner completion offers type names", async () => {
    const buffer = page('<Button Tag="{x:Static |}" />');
    const items = await h.completionsAt(buffer);
    const relevant = items.filter((i) => /^(Button|Visibility)$/.test(i)).join(", ") || "<none>";
    assert.ok(items.includes("Button"), `x:Static owner completion should include Button; buffer=${buffer}; relevant labels=${relevant}; got ${items.slice(0, 120).join(", ")}`);
    assert.ok(items.includes("Visibility"), `x:Static owner completion should include Visibility; buffer=${buffer}; relevant labels=${relevant}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("x:Static member completion offers static enum members", async () => {
    const buffer = page('<Button Tag="{x:Static Visibility.|}" />');
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("Collapsed"), `x:Static member completion should include Collapsed; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
    assert.ok(items.includes("Visible"), `x:Static member completion should include Visible; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("x:Static member completion respects the typed member prefix", async () => {
    const buffer = page('<Button Tag="{x:Static Visibility.Vis|}" />');
    const items = await h.completionsAt(buffer);
    assert.ok(items.includes("Visible"), `x:Static Vis prefix should include Visible; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
    assert.ok(!items.includes("Collapsed"), `x:Static Vis prefix should not include Collapsed; buffer=${buffer}; got ${items.slice(0, 120).join(", ")}`);
  });

  it("F12 on x:Type local user type lands in SmokePage.xaml.cs", async () => {
    const buffer = page('<Button Tag="{x:Type local:Smoke|Page}" />');
    const defs = await h.definitionsAt(buffer);
    assert.ok(defs.some((d) => path.basename(d.fsPath) === CS), `x:Type local SmokePage F12 should land in ${CS}; buffer=${buffer}; got ${JSON.stringify(defs)}`);
  });

  it("F12 on framework x:Type and x:Static refs is stable and metadata-empty", async () => {
    const typeDefs = await h.definitionsAt(page('<Button Tag="{x:Type Butt|on}" />'));
    assert.ok(Array.isArray(typeDefs), `framework x:Type F12 should return an array; got ${JSON.stringify(typeDefs)}`);
    assert.strictEqual(typeDefs.length, 0, `framework x:Type F12 should remain metadata-empty; got ${JSON.stringify(typeDefs)}`);

    const memberDefs = await h.definitionsAt(page('<Button Tag="{x:Static Visibility.Collap|sed}" />'));
    assert.ok(Array.isArray(memberDefs), `framework x:Static F12 should return an array; got ${JSON.stringify(memberDefs)}`);
    assert.strictEqual(memberDefs.length, 0, `framework x:Static F12 should remain metadata-empty; got ${JSON.stringify(memberDefs)}`);
  });

  it("regression sweep keeps x:Bind, StaticResource, and element hover working", async () => {
    const bindMd = await h.hoverAt(page('<TextBlock Text="{x:Bind Greeting|Text}" />'));
    assert.ok(/string\s+SmokePage\.GreetingText/.test(bindMd), `x:Bind hover should resolve GreetingText; got ${bindMd}`);

    const resourceMd = await h.hoverAt(page('<Grid Background="{StaticResource SmokeAccent|Brush}" />'));
    assert.ok(/SmokeAccentBrush/.test(resourceMd), `StaticResource hover should name SmokeAccentBrush; got ${resourceMd}`);
    assert.ok(/SolidColorBrush/.test(resourceMd), `StaticResource hover should include SolidColorBrush; got ${resourceMd}`);

    const elementMd = await h.hoverAt(page("<Butt|on />"));
    assert.ok(/class\s+.*Button/.test(elementMd), `element hover should resolve Button class; got ${elementMd}`);
  });

  it.skip("FUTURE GAP: x:Static on user-defined static members should navigate once the fixture has one", async () => {
    // SmokePage intentionally has no static members on disk today, so this is a placeholder for a
    // future fixture expansion rather than a valid Round 21 assertion.
  });
});
