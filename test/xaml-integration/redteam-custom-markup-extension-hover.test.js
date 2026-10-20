"use strict";

const assert = require("node:assert");
const h = require("./helper");

function page(inner) {
  return `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage">
  ${inner}
</Page>`;
}

describe("WinUI XAML — SDK-derived markup-extension hover", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("shows the resolved custom markup-extension type", async () => {
    const markdown = await h.hoverAt(
      page('<Grid Tag="{local:Bad|ge Tone=Primary}" />'));
    assert.match(
      markdown,
      /class\s+(?:SmokeFixture\.)?BadgeExtension/,
      `custom extension hover should identify BadgeExtension; got ${JSON.stringify(markdown)}`);
  });

  it("shows enum hover for a custom markup-extension argument", async () => {
    const markdown = await h.hoverAt(
      page('<Grid Tag="{local:Badge Tone=Pri|mary}" />'));
    assert.match(
      markdown,
      /BadgeTone\.Primary/,
      `custom extension enum hover should identify BadgeTone.Primary; got ${JSON.stringify(markdown)}`);
  });

  it("does not treat a same-shaped lookalike as a markup extension", async () => {
    const markdown = await h.hoverAt(
      page('<Grid Tag="{local:BadgeLook|alike Tone=Primary}" />'));
    assert.doesNotMatch(
      markdown || "",
      /class\s+(?:SmokeFixture\.)?BadgeLookalike/,
      `lookalike hover must not claim a markup-extension type; got ${JSON.stringify(markdown)}`);
  });

  it("does not give a custom default-namespace Binding the built-in hover", async () => {
    const markdown = await h.hoverAt(
      `<Page xmlns="using:SmokeFixture"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        x:Class="SmokeFixture.SmokePage">
        <Grid Tag="{Bind|ing}" />
      </Page>`);
    assert.match(
      markdown,
      /class\s+(?:SmokeFixture\.)?Binding/,
      `custom Binding hover should identify SmokeFixture.Binding; got ${JSON.stringify(markdown)}`);
    assert.doesNotMatch(
      markdown,
      /Classic runtime binding/,
      `custom Binding hover must not use the built-in description; got ${JSON.stringify(markdown)}`);
  });

  it("does not give a custom default-namespace StaticResource the built-in hover", async () => {
    const markdown = await h.hoverAt(
      `<Page xmlns="using:SmokeFixture"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        x:Class="SmokeFixture.SmokePage">
        <Grid Tag="{StaticRes|ource}" />
      </Page>`);
    assert.match(
      markdown,
      /class\s+(?:SmokeFixture\.)?StaticResourceExtension/,
      `custom StaticResource hover should resolve its CLR type; got ${JSON.stringify(markdown)}`);
    assert.doesNotMatch(
      markdown,
      /Looks up a resource by key/,
      `custom StaticResource hover must not use the built-in description; got ${JSON.stringify(markdown)}`);
  });
});
