"use strict";

const assert = require("node:assert");
const h = require("./helper");

function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n${inner}\n</Page>`;
}

function clean(text) {
  return text.replace("|", "");
}

function declLine(buffer, name) {
  return clean(buffer).split("\n").findIndex((l) => l.includes(`x:Name="${name}"`));
}

function setter(target) {
  return page(`  <Border x:Name="Chrome" />\n  <Setter Target="${target}" Value="0.5" />`);
}

function storyboard(targetProperty, targetName = 'Storyboard.TargetName="Chrome"') {
  return page(
    `  <StackPanel>\n` +
      `    <Border x:Name="Chrome" />\n` +
      `    <Storyboard>\n` +
      `      <DoubleAnimation ${targetName} Storyboard.TargetProperty="${targetProperty}" />\n` +
      `    </Storyboard>\n` +
      `  </StackPanel>`
  );
}

function assertPropertyHover(md, property, why) {
  assert.ok(new RegExp(property).test(md), `${why}: expected ${property} property hover; got ${JSON.stringify(md)}`);
  assert.ok(!/\(element\)/.test(md), `${why}: member hover must not resolve as an element; got ${JSON.stringify(md)}`);
}

function assertNoDecl(defs, buffer, name, why) {
  const line = declLine(buffer, name);
  assert.ok(!defs.some((d) => d.line === line), `${why}: must not navigate to x:Name="${name}" line ${line}; got ${JSON.stringify(defs)}`);
}

describe("WinUI XAML — red-team 81 VSM target-property member navigation", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("hovers Setter.Target post-dot member as the target element property, not the element", async () => {
    assertPropertyHover(await h.hoverAt(setter("Chrome.Opac|ity")), "Opacity", "Setter.Target member");
  });

  it("returns graceful empty F12 for framework Setter.Target members and never falls through to the x:Name", async () => {
    const buf = setter("Chrome.Opac|ity");
    const defs = await h.definitionsAt(buf);
    assert.deepStrictEqual(defs, [], `framework member F12 should be empty metadata-boundary result; got ${JSON.stringify(defs)}`);
    assertNoDecl(defs, buf, "Chrome", "Setter.Target member F12");
  });

  it("keeps exact dot-boundary precision: before the dot is the element, after the dot is the member", async () => {
    const before = setter("Chrome|.Opacity");
    assert.ok((await h.definitionsAt(before)).some((d) => d.line === declLine(before, "Chrome")), "caret just before dot must resolve the element");

    const after = setter("Chrome.|Opacity");
    const afterDefs = await h.definitionsAt(after);
    assertNoDecl(afterDefs, after, "Chrome", "caret just after dot");
    assertPropertyHover(await h.hoverAt(after), "Opacity", "caret just after dot");
  });

  it("does not treat a caret in the member segment as an element reference for references/highlights/rename", async () => {
    const buf = setter("Chrome.Opac|ity");
    assert.ok(!(await h.referencesAt(buf)).some((r) => r.text === "Chrome"), "member references must not include the element name");
    assert.ok(!(await h.highlightsAt(buf)).some((x) => x.text === "Chrome"), "member highlights must not include the element name");
    const res = await h.renameAt(buf, "Renamed");
    assert.ok((res.edits || []).length === 0, `member rename should not edit the element; got ${JSON.stringify(res)}`);
  });

  it("trims whitespace around Setter.Target element/member segments while still resolving the member", async () => {
    assertPropertyHover(await h.hoverAt(setter(" Chrome . Opac|ity ")), "Opacity", "spaced Setter.Target");
    const buf = setter(" Chrome . Opac|ity ");
    assertNoDecl(await h.definitionsAt(buf), buf, "Chrome", "spaced Setter.Target member F12");
  });

  it("treats dotless Setter.Target as the round-80 element reference, not a member", async () => {
    const buf = setter("Chr|ome");
    const defs = await h.definitionsAt(buf);
    assert.ok(defs.some((d) => d.line === declLine(buf, "Chrome")), `dotless Target should resolve element; got ${JSON.stringify(defs)}`);
    const md = await h.hoverAt(buf);
    assert.ok(/\(element\)/.test(md), `dotless Target hover should be an element hover, not a member; got ${JSON.stringify(md)}`);
  });

  it("defers multi-segment Setter.Target values with a second dot instead of resolving any member segment", async () => {
    const positive = setter("Chrome.Opac|ity");
    assertPropertyHover(await h.hoverAt(positive), "Opacity", "positive control");

    for (const [label, buf] of [
      ["caret in first member", setter("Chrome.Opac|ity.Sub")],
      ["caret in second member", setter("Chrome.Opacity.Su|b")],
    ]) {
      const md = await h.hoverAt(buf);
      assert.ok(!/Opacity/.test(md) && !/\(element\)/.test(md), `${label}: multi-segment Target must defer; got ${JSON.stringify(md)}`);
      assertNoDecl(await h.definitionsAt(buf), buf, "Chrome", label);
    }
  });

  it("ignores markup-extension Setter.Target values even when they contain a dotted-looking token", async () => {
    const positive = setter("Chrome.Opac|ity");
    assertPropertyHover(await h.hoverAt(positive), "Opacity", "positive control");

    const buf = page(`  <Border x:Name="Chrome" />\n  <Setter Target="{Binding Chrome.Opac|ity}" Value="0.5" />`);
    assert.strictEqual(await h.hoverAt(buf), "", "markup extension Target must not produce a member hover");
    assert.deepStrictEqual(await h.definitionsAt(buf), [], "markup extension Target must not define");
  });

  it("requires the unprefixed Setter owner and unprefixed Target attribute", async () => {
    const positive = setter("Chrome.Opac|ity");
    assertPropertyHover(await h.hoverAt(positive), "Opacity", "positive control");

    for (const [label, buf] of [
      ["non-Setter owner", page(`  <Border x:Name="Chrome" />\n  <Border Target="Chrome.Opac|ity" />`)],
      ["prefixed owner", page(`  <Border x:Name="Chrome" />\n  <local:Setter Target="Chrome.Opac|ity" Value="0.5" />`)],
      ["prefixed Target attr", page(`  <Border x:Name="Chrome" />\n  <Setter local:Target="Chrome.Opac|ity" Value="0.5" />`)],
    ]) {
      assert.strictEqual(await h.hoverAt(buf), "", `${label}: must not produce a member hover`);
      assert.deepStrictEqual(await h.definitionsAt(buf), [], `${label}: must not define`);
    }
  });

  it("hovers bare Storyboard.TargetProperty against the sibling Storyboard.TargetName element", async () => {
    assertPropertyHover(await h.hoverAt(storyboard("Opac|ity")), "Opacity", "Storyboard.TargetProperty bare member");
  });

  it("returns graceful empty F12 for framework Storyboard.TargetProperty members and never jumps to TargetName", async () => {
    const buf = storyboard("Opac|ity");
    const defs = await h.definitionsAt(buf);
    assert.deepStrictEqual(defs, [], `framework Storyboard.TargetProperty F12 should be empty; got ${JSON.stringify(defs)}`);
    assertNoDecl(defs, buf, "Chrome", "Storyboard.TargetProperty F12");
  });

  // Round 81 follow-up fix: a bare Storyboard.TargetProperty value is an animation target-property path
  // owned by ResolveVsmTargetMemberAsync, never a page-class member. Previously, when the target element
  // was unresolvable, the value leaked to the generic page-member fallback and a name that coincidentally
  // matched a UIElement member (Opacity, Width, ...) mis-hovered as the PAGE's member. Now it resolves
  // only through the sibling Storyboard.TargetName; with no (or an unresolvable) target it stays silent.
  it("requires a resolvable Storyboard.TargetName for bare Storyboard.TargetProperty member resolution", async () => {
    // Positive control: a real sibling target resolves the member (proves the assertion isn't vacuous).
    assertPropertyHover(await h.hoverAt(storyboard("Opac|ity")), "Opacity", "positive control");

    // No sibling Storyboard.TargetName at all -> no target -> no member hover/definition.
    const missing = storyboard("Opac|ity", "");
    assert.strictEqual(await h.hoverAt(missing), "", "missing TargetName must not resolve TargetProperty");
    assert.deepStrictEqual(await h.definitionsAt(missing), [], "missing TargetName must not define");

    // A sibling that names an element that does not exist is equally unresolvable -> also silent
    // (the leak fired here too, since the page fallback ignores the target entirely).
    const ghost = storyboard("Opac|ity", 'Storyboard.TargetName="Ghost"');
    assert.strictEqual(await h.hoverAt(ghost), "", "an unresolvable TargetName must not resolve TargetProperty");
    assert.deepStrictEqual(await h.definitionsAt(ghost), [], "an unresolvable TargetName must not define");
  });

  it("defers dotted paths but resolves parenthesized Storyboard.TargetProperty groups (round 83)", async () => {
    const positive = storyboard("Opac|ity");
    assertPropertyHover(await h.hoverAt(positive), "Opacity", "positive control");

    // A BARE dotted path (no parenthesized group) is still deferred — round 83 only resolves an
    // explicit (Owner.Property) qualifier, not a TargetName-rooted "Member.Sub" chain.
    const dotted = storyboard("Opacity.Fo|o");
    assert.ok(!/\(element\)/.test(await h.hoverAt(dotted)), `dotted: a bare dotted path must not resolve as an element; got ${JSON.stringify(await h.hoverAt(dotted))}`);
    assert.deepStrictEqual(await h.definitionsAt(dotted), [], "dotted: a bare dotted TargetProperty path must not define");

    // SUPERSEDED by round 83: a parenthesized (Owner.Property) group NOW resolves the member on the
    // EXPLICITLY named owner type (read-side counterpart of the round-77 qualified-group completion).
    assertPropertyHover(await h.hoverAt(storyboard("(UIElement.Opac|ity)")), "Opacity", "parenthesized owner");
    assertPropertyHover(await h.hoverAt(storyboard("(UIElement.RenderTransform).(CompositeTransform.Translate|X)")), "TranslateX", "parenthesized chain");
  });

  it("is case-sensitive for member names in Setter.Target and Storyboard.TargetProperty", async () => {
    assertPropertyHover(await h.hoverAt(setter("Chrome.Opac|ity")), "Opacity", "Setter positive control");
    assert.strictEqual(await h.hoverAt(setter("Chrome.opac|ity")), "", "wrong-case Setter.Target member must not hover");
    assert.deepStrictEqual(await h.definitionsAt(setter("Chrome.opac|ity")), [], "wrong-case Setter.Target member must not define");

    assertPropertyHover(await h.hoverAt(storyboard("Opac|ity")), "Opacity", "Storyboard positive control");
    assert.strictEqual(await h.hoverAt(storyboard("opac|ity")), "", "wrong-case TargetProperty member must not hover");
    assert.deepStrictEqual(await h.definitionsAt(storyboard("opac|ity")), [], "wrong-case TargetProperty member must not define");
  });

  it("is deterministic for repeated hover and definition requests on the same member probe", async () => {
    const buf = setter("Chrome.Opac|ity");
    const h1 = await h.hoverAt(buf);
    const h2 = await h.hoverAt(buf);
    assert.strictEqual(h2, h1, `hover changed between identical requests: ${JSON.stringify({ h1, h2 })}`);
    const d1 = await h.definitionsAt(buf);
    const d2 = await h.definitionsAt(buf);
    assert.deepStrictEqual(d2, d1, `definitions changed between identical requests: ${JSON.stringify({ d1, d2 })}`);
  });

  it("survives malformed target markup without throwing or bogus element navigation", async () => {
    for (const [label, buf] of [
      ["unterminated Setter", page(`  <Border x:Name="Chrome" />\n  <Setter Target="Chrome.Opac|ity" Value="0.5"`).replace("</Page>", "")],
      ["unterminated Storyboard", storyboard("Opac|ity").replace(` />\n    </Storyboard>`, "")],
      ["empty Setter.Target", setter("|")],
      ["dot-only Setter.Target", setter(".|")],
    ]) {
      const defs = await h.definitionsAt(buf);
      assert.ok(Array.isArray(defs), `${label}: definitions must return an array`);
      assertNoDecl(defs, buf, "Chrome", label);
      assert.ok(typeof (await h.hoverAt(buf)) === "string", `${label}: hover must return a string`);
    }
  });
});
