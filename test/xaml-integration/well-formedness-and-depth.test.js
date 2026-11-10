"use strict";

// Regressions for #356 (XML syntax errors) and #366 (deeply nested XAML) through the real client.

const assert = require("node:assert");
const vscode = require("vscode");
const h = require("./helper");

const codeOf = (d) => (typeof d.code === "object" ? String(d.code.value) : String(d.code));

describe("WinUI XAML: well-formedness and deep nesting", function () {
  this.timeout(180000);

  before(async () => {
    await h.warmUp();
  });

  after(async () => {
    await h.revertProbe();
  });

  for (const [label, body, code] of [
    ["a second root element", `</Page>\n<Grid/>`, "XAML0012"],
    ["a raw ampersand in an attribute", `  <Button Content="a & b"/>\n</Page>`, "XAML0015"],
    ["whitespace after '<'", `  < Button/>\n</Page>`, "XAML0018"],
  ]) {
    it(`reports ${label}`, async () => {
      const text = `<Page ${h.NS}>\n${body}`;
      const diagnostics = await h.diagnosticsFor(text, (all) => all.some((d) => codeOf(d) === code));
      assert.ok(
        diagnostics.some((d) => codeOf(d) === code),
        `expected ${code}; got ${diagnostics.map((d) => `${codeOf(d)} ${d.message}`).join(" | ")}`
      );
    });
  }

  it("answers the outline and reports nothing for 500 nested elements", async () => {
    const depth = 500;
    const text =
      `<Page ${h.NS}>\n` +
      "<StackPanel>".repeat(depth) +
      "<TextBlock/>" +
      "</StackPanel>".repeat(depth) +
      "\n</Page>";

    const started = Date.now();
    const symbols = await h.symbolsAt(text);
    const names = h.flattenSymbols(symbols);
    assert.ok(Date.now() - started < 10000, "documentSymbol must answer promptly");
    assert.ok(names.includes("TextBlock"), "the innermost element should be in the outline");
    assert.equal(names.filter((name) => name === "StackPanel").length, depth);

    const diagnostics = await h.diagnosticsFor(text);
    const parser = diagnostics.filter((d) => /^XAML00(0[1-9]|1\d)$/.test(codeOf(d)));
    assert.deepEqual(parser.map((d) => `${codeOf(d)} ${d.message}`), []);
  });
});
