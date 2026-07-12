"use strict";

// Minimal end-to-end smoke test: proves the extension activates inside a real VS Code instance,
// connects to the .NET language server, and answers a live completion request. This is the
// "pipeline is alive" gate — richer feature coverage lives in features.test.js.

const assert = require("node:assert");
const h = require("./helper");

describe("WinUI XAML extension — pipeline smoke", function () {
  this.timeout(180000);

  before(async () => {
    await h.warmUp();
  });

  after(async () => {
    await h.revertProbe();
  });

  it("activates and completes element names through the LSP", async () => {
    const items = await h.completionsAt(`<Page ${h.NS}>\n  <But|\n</Page>`);
    assert.ok(items.includes("Button"), `expected Button element, got: ${items.slice(0, 40).join(", ")}`);
  });

  it("completes attribute names on a resolved element", async () => {
    const items = await h.completionsAt(`<Page ${h.NS}>\n  <Button |/>\n</Page>`);
    assert.ok(items.includes("Content"), "expected Content property");
    assert.ok(items.includes("Click"), "expected Click event");
  });
});
