"use strict";

const assert = require("node:assert");
const h = require("./helper");

function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
}

function controlTemplate(inner, target = "Button", styleTarget = target) {
  const styleAttr = styleTarget ? ` TargetType="${styleTarget}"` : "";
  const templateAttr = target ? ` TargetType="${target}"` : "";
  return page(
    `<Page.Resources>\n` +
      `    <Style${styleAttr}>\n` +
      `      <Setter Property="Template">\n` +
      `        <Setter.Value>\n` +
      `          <ControlTemplate${templateAttr}>\n` +
      `            ${inner}\n` +
      `          </ControlTemplate>\n` +
      `        </Setter.Value>\n` +
      `      </Setter>\n` +
      `    </Style>\n` +
      `  </Page.Resources>`
  );
}

function looseTemplate(inner, targetAttr = "") {
  return page(`<Page.Resources>\n    <ControlTemplate${targetAttr}>\n      ${inner}\n    </ControlTemplate>\n  </Page.Resources>`);
}

function tb(markup, target = "Button", styleTarget = target) {
  return controlTemplate(markup, target, styleTarget);
}

function assertMemberHover(md, owner, property, why) {
  assert.ok(new RegExp(`\\b${owner}\\.${property}\\b`).test(md), `${why}: expected ${owner}.${property} signature; got ${JSON.stringify(md)}`);
  assert.ok(!/\(element\)/.test(md), `${why}: member hover must not be an element hover; got ${JSON.stringify(md)}`);
}

function assertNoMemberLeak(md, why) {
  assert.ok(!/\b(?:Control|ContentControl|TextBox|ButtonBase|UIElement)\.[A-Za-z_][A-Za-z0-9_]*\b/.test(md), `${why}: must not leak a member signature; got ${JSON.stringify(md)}`);
  assert.ok(!/\(element\)/.test(md), `${why}: must not fall through to an element hover; got ${JSON.stringify(md)}`);
}

async function assertSilent(buffer, why) {
  assert.strictEqual(await h.hoverAt(buffer), "", `${why}: expected no hover`);
  assert.deepStrictEqual(await h.definitionsAt(buffer), [], `${why}: expected no definitions`);
}

describe("WinUI XAML — red-team 82 TemplateBinding member navigation", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("resolves several inherited framework members on a Button template, not an element", async () => {
    for (const [property, owner, markup] of [
      ["Background", "Control", '<Border Tag="{TemplateBinding Back|ground}" />'],
      ["Content", "ContentControl", '<ContentPresenter Content="{TemplateBinding Con|tent}" />'],
      ["IsEnabled", "Control", '<Grid Tag="{TemplateBinding IsEna|bled}" />'],
      ["Foreground", "Control", '<TextBlock Foreground="{TemplateBinding Fore|ground}" />'],
    ]) {
      assertMemberHover(await h.hoverAt(tb(markup)), owner, property, property);
    }
  });

  it("returns empty F12 for framework members and never jumps to same-buffer names", async () => {
    const buffer = tb(
      `<Grid>\n` +
        `              <Border x:Name="Background" />\n` +
        `              <Border Tag="{TemplateBinding Back|ground}" />\n` +
        `            </Grid>`
    );
    assert.deepStrictEqual(await h.definitionsAt(buffer), [], "framework TemplateBinding member F12 must be metadata-boundary empty");
  });

  it("keeps extension-name hover as the TemplateBinding macro, never the member", async () => {
    const md = await h.hoverAt(tb('<Border Background="{Templ|ateBinding Background}" />'));
    assert.ok(/TemplateBinding/.test(md) && /templated (control|parent)/i.test(md), `expected macro description; got ${JSON.stringify(md)}`);
    assertNoMemberLeak(md, "extension name hover");
  });

  it("does not leak member hover from the opening brace or non-adjacent extension/member separator whitespace", async () => {
    for (const [label, buffer] of [
      ["opening brace", tb('<Border Background="|{TemplateBinding Background}" />')],
      ["space after name", tb('<Border Background="{TemplateBinding | Background}" />')],
    ]) {
      assertNoMemberLeak(await h.hoverAt(buffer), label);
      assert.deepStrictEqual(await h.definitionsAt(buffer), [], `${label}: must not define`);
    }
  });

  // Member boundaries are inclusive, but whitespace before the member remains outside.
  it("resolves at the member-start edge even with extra leading spaces (boundary-inclusive, like x:Static)", async () => {
    assertMemberHover(await h.hoverAt(tb('<Border Tag="{TemplateBinding  |Background}" />')), "Control", "Background", "two spaces then member-start caret");
  });

  it("is case-sensitive and silent for wrong-case property names", async () => {
    await assertSilent(tb('<Border Tag="{TemplateBinding back|ground}" />'), "lowercase background");
    await assertSilent(tb('<Border Tag="{TemplateBinding BACK|GROUND}" />'), "uppercase BACKGROUND");
  });

  it("is silent for properties absent from the TargetType and does not fall back to page members", async () => {
    await assertSilent(tb('<Border Tag="{TemplateBinding Zork|le}" />'), "unknown property");
    await assertSilent(tb('<Border Tag="{TemplateBinding Tex|t}" />'), "Button has no Text property");
  });

  it("is silent outside any ControlTemplate or Style TargetType", async () => {
    await assertSilent(page('<Grid><Border x:Name="Background" /><Border Tag="{TemplateBinding Back|ground}" /></Grid>'), "TemplateBinding outside template");
  });

  it("normalizes x:Type TargetType syntax before resolving members", async () => {
    assertMemberHover(
      await h.hoverAt(controlTemplate('<Border Tag="{TemplateBinding Back|ground}" />', "{x:Type Button}", "Button")),
      "Control",
      "Background",
      "x:Type Button TargetType"
    );
  });

  it("uses the nearest nested ControlTemplate TargetType", async () => {
    const buffer = tb(
      `<Grid>\n` +
        `              <Grid.Resources>\n` +
        `                <ControlTemplate TargetType="TextBox">\n` +
        `                  <Border Tag="{TemplateBinding Placeholder|Text}" />\n` +
        `                </ControlTemplate>\n` +
        `              </Grid.Resources>\n` +
        `            </Grid>`
    );
    assertMemberHover(await h.hoverAt(buffer), "TextBox", "PlaceholderText", "nested TextBox template");
  });

  it("lets a ControlTemplate TargetType override a different enclosing Style TargetType", async () => {
    const buffer = controlTemplate('<Border Tag="{TemplateBinding Placeholder|Text}" />', "TextBox", "Button");
    assertMemberHover(await h.hoverAt(buffer), "TextBox", "PlaceholderText", "ControlTemplate TargetType should beat Style TargetType");
  });

  it("honors member-span boundaries at the first and last character", async () => {
    assertMemberHover(await h.hoverAt(tb('<Border Tag="{TemplateBinding |Background}" />')), "Control", "Background", "first member char");
    assertMemberHover(await h.hoverAt(tb('<Border Tag="{TemplateBinding Backgroun|d}" />')), "Control", "Background", "last member char");
  });

  // The member's RIGHT edge is inclusive too (a caret immediately after the last character, before "}", resolves — the universal IDE convention, matching {x:Static}). But a caret PAST a trailing space, beyond the trimmed value span, is silent — proving the span boundary is exact, not greedy.
  it("is inclusive at the member-end edge yet silent once the caret is past the value span", async () => {
    assertMemberHover(await h.hoverAt(tb('<Border Tag="{TemplateBinding Background|}" />')), "Control", "Background", "caret at member-end edge before brace");
    await assertSilent(tb('<Border Tag="{TemplateBinding Background |}" />'), "caret past a trailing space is beyond the value span");
  });

  it("survives malformed and empty TemplateBinding forms without bogus resolution", async () => {
    for (const [label, buffer] of [
      ["extension only", tb('<Border Tag="{Template|Binding" />')],
      ["empty argument", tb('<Border Tag="{TemplateBinding |}" />')],
      ["no ControlTemplate TargetType", looseTemplate('<Border Tag="{TemplateBinding Back|ground}" />')],
      ["unresolvable ControlTemplate TargetType", looseTemplate('<Border Tag="{TemplateBinding Back|ground}" />', ' TargetType="local:NoSuchType"')],
    ]) {
      const md = await h.hoverAt(buffer);
      const defs = await h.definitionsAt(buffer);
      assert.ok(typeof md === "string", `${label}: hover must return a string`);
      assert.ok(Array.isArray(defs), `${label}: definitions must return an array`);
      if (!/extension only/.test(label)) {
        assert.strictEqual(md, "", `${label}: expected no hover, got ${JSON.stringify(md)}`);
        assert.deepStrictEqual(defs, [], `${label}: expected no definitions`);
      }
    }
  });

  // Mid-edit parsing resolves members in an unterminated extension.
  it("still resolves the member inside an unterminated (mid-type) TemplateBinding, like x:Static", async () => {
    assertMemberHover(await h.hoverAt(tb('<Border Tag="{TemplateBinding Back|ground" />')), "Control", "Background", "unterminated mid-type member");
  });

  it("is deterministic for repeated hover and definition probes", async () => {
    const buffer = tb('<Border Tag="{TemplateBinding Back|ground}" />');
    const h1 = await h.hoverAt(buffer);
    const h2 = await h.hoverAt(buffer);
    assert.strictEqual(h2, h1, `hover changed between identical requests: ${JSON.stringify({ h1, h2 })}`);
    const d1 = await h.definitionsAt(buffer);
    const d2 = await h.definitionsAt(buffer);
    assert.deepStrictEqual(d2, d1, `definitions changed between identical requests: ${JSON.stringify({ d1, d2 })}`);
  });

  it("defers attached-property-like and prefixed TemplateBinding arguments", async () => {
    await assertSilent(tb('<Border Tag="{TemplateBinding Grid.R|ow}" />'), "attached-property-like Grid.Row");
    await assertSilent(tb('<Border Tag="{TemplateBinding local:F|oo}" />'), "prefixed local:Foo");
  });

  it("does not perturb sibling x:Bind or StaticResource hover resolution in the same buffer", async () => {
    const buffer = controlTemplate(
      `<Grid>\n` +
        `              <SolidColorBrush x:Key="LocalBrush82" Color="Red" />\n` +
        `              <Border Tag="{TemplateBinding Background}" />\n` +
        `              <TextBlock Text="{x:Bind Greet|ingText}" Foreground="{StaticResource LocalBrush82}" />\n` +
        `            </Grid>`
    );
    const md = await h.hoverAt(buffer);
    assert.ok(/GreetingText/.test(md), `x:Bind hover should still resolve GreetingText; got ${JSON.stringify(md)}`);
    assertNoMemberLeak(md.replace(/GreetingText/g, ""), "x:Bind sibling interaction");
  });

  it("resolves TemplateBinding through realistic nested property-element markup", async () => {
    const buffer = tb(
      `<Border>\n` +
        `              <Border.Child>\n` +
        `                <ContentPresenter Content="{TemplateBinding Con|tent}" />\n` +
        `              </Border.Child>\n` +
        `            </Border>`
    );
    assertMemberHover(await h.hoverAt(buffer), "ContentControl", "Content", "property-element nested TemplateBinding");
  });
});
