"use strict";

const assert = require("node:assert");
const h = require("./helper");

function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n${inner}\n</Page>`;
}

function storyboard(targetProperty, targetName = 'Storyboard.TargetName="AttachedProbe"') {
  return page(
    `  <StackPanel>\n` +
      `    <Border x:Name="AttachedProbe" />\n` +
      `    <Storyboard>\n` +
      `      <DoubleAnimation ${targetName} Storyboard.TargetProperty="${targetProperty}" />\n` +
      `    </Storyboard>\n` +
      `  </StackPanel>`
  );
}

function setter(target) {
  return page(`  <Border x:Name="Chrome" />\n  <Setter Target="${target}" Value="0.5" />`);
}

function assertMemberHover(md, owner, member, why) {
  assert.ok(new RegExp(`\\b${owner}\\.${member}\\b`).test(md), `${why}: expected ${owner}.${member}; got ${JSON.stringify(md)}`);
  assert.ok(!/\(element\)/.test(md), `${why}: member hover must not be an element hover; got ${JSON.stringify(md)}`);
}

function assertAttachedHover(md, owner, member, why) {
  assert.ok(/\(attached property\)/.test(md), `${why}: expected attached-property framing; got ${JSON.stringify(md)}`);
  assertMemberHover(md, owner, member, why);
}

function assertOwnerHover(md, owner, why) {
  assert.ok(new RegExp(`\\bclass\\s+Microsoft\\.UI\\.Xaml\\.${owner}\\b`).test(md), `${why}: expected owner type hover; got ${JSON.stringify(md)}`);
  assert.ok(!/\bUIElement\.Opacity\b/.test(md), `${why}: owner hover must not be the member; got ${JSON.stringify(md)}`);
  assert.ok(!/\(element\)/.test(md), `${why}: owner hover must not be an element hover; got ${JSON.stringify(md)}`);
}

async function assertSilent(buffer, why) {
  assert.strictEqual(await h.hoverAt(buffer), "", `${why}: expected no hover`);
  assert.deepStrictEqual(await h.definitionsAt(buffer), [], `${why}: expected no definitions`);
}

async function assertFrameworkF12Null(buffer, why) {
  const defs = await h.definitionsAt(buffer);
  assert.deepStrictEqual(defs, [], `${why}: framework metadata should not navigate; got ${JSON.stringify(defs)}`);
}

describe("WinUI XAML — red-team 83 parenthesized Storyboard.TargetProperty member navigation", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("hovers an instance member on the explicit owner without needing Storyboard.TargetName", async () => {
    const buffer = storyboard("(UIElement.Opac|ity)", "");
    assertMemberHover(await h.hoverAt(buffer), "UIElement", "Opacity", "explicit UIElement member");
    await assertFrameworkF12Null(buffer, "explicit UIElement member F12");
  });

  it("hovers an attached member with attached-property framing", async () => {
    const buffer = storyboard("(Canvas.Le|ft)");
    assertAttachedHover(await h.hoverAt(buffer), "Canvas", "Left", "Canvas.Left");
    await assertFrameworkF12Null(buffer, "Canvas.Left F12");
  });

  it("resolves the owner segment to the owner type, not to the member", async () => {
    const buffer = storyboard("(UIEle|ment.Opacity)");
    assertOwnerHover(await h.hoverAt(buffer), "UIElement", "owner segment");
    await assertFrameworkF12Null(buffer, "owner segment F12");
  });

  it("keeps the dot boundary precise inside a group", async () => {
    assertOwnerHover(await h.hoverAt(storyboard("(UIElement|.Opacity)")), "UIElement", "caret exactly on owner-side dot boundary");
    assertMemberHover(await h.hoverAt(storyboard("(UIElement.|Opacity)")), "UIElement", "Opacity", "caret exactly at first member char");
  });

  it("resolves a second chained group against its own explicit owner", async () => {
    const md = await h.hoverAt(storyboard("(UIElement.RenderTransform).(CompositeTransform.Translate|X)"));
    assertMemberHover(md, "CompositeTransform", "TranslateX", "second chained group");
    assert.ok(!/\bUIElement\.TranslateX\b/.test(md), `second group must not resolve against the first owner; got ${JSON.stringify(md)}`);
  });

  it("resolves the first group independently when the caret is in the first group of a chain", async () => {
    const md = await h.hoverAt(storyboard("(UIElement.Render|Transform).(CompositeTransform.TranslateX)"));
    assertMemberHover(md, "UIElement", "RenderTransform", "first chained group");
    assert.ok(!/\bCompositeTransform\.RenderTransform\b/.test(md), `first group must not resolve against the second owner; got ${JSON.stringify(md)}`);
  });

  it("returns null F12 for framework owner and member hovers even though both render hover markdown", async () => {
    const owner = storyboard("(UIEle|ment.Opacity)");
    assertOwnerHover(await h.hoverAt(owner), "UIElement", "framework owner hover");
    await assertFrameworkF12Null(owner, "framework owner F12");

    const member = storyboard("(UIElement.Opac|ity)");
    assertMemberHover(await h.hoverAt(member), "UIElement", "Opacity", "framework member hover");
    await assertFrameworkF12Null(member, "framework member F12");
  });

  it("is silent for an unknown owner and proves the same shape positive resolves", async () => {
    assertMemberHover(await h.hoverAt(storyboard("(UIElement.Opac|ity)")), "UIElement", "Opacity", "positive control");
    await assertSilent(storyboard("(NoSuchOwner.F|oo)"), "unknown owner");
  });

  it("is silent for unknown and mis-cased members and proves the same owner positive resolves", async () => {
    assertMemberHover(await h.hoverAt(storyboard("(UIElement.Opac|ity)")), "UIElement", "Opacity", "positive control");
    await assertSilent(storyboard("(UIElement.Zo|rk)"), "unknown member");
    await assertSilent(storyboard("(UIElement.opac|ity)"), "mis-cased member");
  });

  it("is silent for interior whitespace before the owner and proves the unspaced positive resolves", async () => {
    assertMemberHover(await h.hoverAt(storyboard("(UIElement.Opac|ity)")), "UIElement", "Opacity", "positive control");
    await assertSilent(storyboard("(| UIElement.Opacity)"), "interior whitespace before owner");
  });

  it("is silent on the opening paren and proves an in-group caret resolves", async () => {
    assertMemberHover(await h.hoverAt(storyboard("(UIElement.Opac|ity)")), "UIElement", "Opacity", "positive control");
    await assertSilent(storyboard("|(UIElement.Opacity)"), "opening paren");
  });

  // The member's exclusive-end caret remains inside; a caret after ')' is outside.
  it("resolves the member when the caret touches the trailing close paren (inclusive end-of-token)", async () => {
    assertMemberHover(await h.hoverAt(storyboard("(UIElement.Opac|ity)")), "UIElement", "Opacity", "positive control");
    assertMemberHover(await h.hoverAt(storyboard("(UIElement.Opacity|)")), "UIElement", "Opacity", "caret touching close paren");
    await assertFrameworkF12Null(storyboard("(UIElement.Opacity|)"), "close-paren-boundary F12");
  });

  it("is silent between two groups and on the joining dot", async () => {
    assertMemberHover(
      await h.hoverAt(storyboard("(UIElement.RenderTransform).(CompositeTransform.Translate|X)")),
      "CompositeTransform",
      "TranslateX",
      "positive control"
    );
    await assertSilent(storyboard("(UIElement.RenderTransform)|.(CompositeTransform.TranslateX)"), "between groups before joining dot");
    await assertSilent(storyboard("(UIElement.RenderTransform).|(CompositeTransform.TranslateX)"), "joining dot");
  });

  // Unterminated owner groups resolve members during mid-edit parsing.
  it("resolves an unterminated group mid-type and stays crash-safe", async () => {
    assertMemberHover(await h.hoverAt(storyboard("(UIElement.Opac|ity)")), "UIElement", "Opacity", "closed positive control");
    assertMemberHover(await h.hoverAt(storyboard("(UIElement.Opac|ity")), "UIElement", "Opacity", "unterminated group resolves what is typed");
    await assertFrameworkF12Null(storyboard("(UIElement.Opac|ity"), "unterminated-group F12");
  });

  it("is silent for an empty group and proves the populated positive resolves", async () => {
    assertMemberHover(await h.hoverAt(storyboard("(UIElement.Opac|ity)")), "UIElement", "Opacity", "positive control");
    await assertSilent(storyboard("(|)"), "empty group");
  });

  it("resolves a prefixed local owner and can find inherited framework members", async () => {
    const md = await h.hoverAt(storyboard("(local:SmokePage.Opac|ity)"));
    assertMemberHover(md, "UIElement", "Opacity", "local SmokePage inherited Opacity");
    await assertFrameworkF12Null(storyboard("(local:SmokePage.Opac|ity)"), "inherited framework member F12");
  });

  it("does not let TargetName affect an explicit parenthesized owner", async () => {
    const md = await h.hoverAt(storyboard("(CompositeTransform.Translate|X)", 'Storyboard.TargetName="AttachedProbe"'));
    assertMemberHover(md, "CompositeTransform", "TranslateX", "explicit owner with unrelated TargetName");
    assert.ok(!/\bBorder\.TranslateX\b/.test(md), `explicit owner must not be rooted at TargetName element; got ${JSON.stringify(md)}`);
  });

  it("does not interfere with simple non-parenthesized Storyboard.TargetProperty rooting at TargetName", async () => {
    const buffer = storyboard("Opac|ity");
    assertMemberHover(await h.hoverAt(buffer), "UIElement", "Opacity", "bare TargetProperty");
    await assertFrameworkF12Null(buffer, "bare TargetProperty F12");
  });

  it("does not interfere with VSM Setter.Target member navigation", async () => {
    const buffer = setter("Chrome.Opac|ity");
    assertMemberHover(await h.hoverAt(buffer), "UIElement", "Opacity", "Setter.Target");
    await assertFrameworkF12Null(buffer, "Setter.Target F12");
  });

  it("is deterministic for repeated hover and definition calls on the same qualified group", async () => {
    const buffer = storyboard("(Canvas.Le|ft)");
    const h1 = await h.hoverAt(buffer);
    const h2 = await h.hoverAt(buffer);
    assert.strictEqual(h2, h1, `hover changed between identical requests: ${JSON.stringify({ h1, h2 })}`);
    const d1 = await h.definitionsAt(buffer);
    const d2 = await h.definitionsAt(buffer);
    assert.deepStrictEqual(d2, d1, `definitions changed between identical requests: ${JSON.stringify({ d1, d2 })}`);
  });
});
