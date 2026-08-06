"use strict";

// Round 37 red-team probes for Folding Ranges (textDocument/foldingRange).
// These drive VS Code's real folding range provider through the integration harness and
// attack line-range correctness, kind mapping, conservative no-fold choices, marker pairing,
// unterminated markup, malformed input, and the end > start invariant.

const assert = require("node:assert");
const h = require("./helper");

const VALID_KINDS = new Set(["comment", "region", "imports", undefined]);

function rangeKey(r) {
  return `${r.start}-${r.end}-${r.kind === undefined ? "structural" : r.kind}`;
}

function dump(ranges) {
  return JSON.stringify(ranges.map(rangeKey));
}

function assertSaneRanges(name, input, ranges) {
  assert.ok(
    ranges.every((r) => Number.isInteger(r.start) && Number.isInteger(r.end) && r.end > r.start),
    `${name}: every folding range must be non-degenerate and forward; input:\n${input}\nranges=${dump(ranges)}`
  );
  assert.ok(
    ranges.every((r) => VALID_KINDS.has(r.kind)),
    `${name}: unexpected folding kind; input:\n${input}\nranges=${dump(ranges)}`
  );
}

async function rangesFor(name, input) {
  const ranges = await h.foldingRangesAt(input);
  assertSaneRanges(name, input, ranges);
  return ranges;
}

function hasRange(ranges, start, end, kind) {
  return ranges.some((r) => r.start === start && r.end === end && r.kind === kind);
}

function assertHas(name, input, ranges, start, end, kind) {
  if (!hasRange(ranges, start, end, kind)) {
    assert.fail(`${name}: expected range ${start}-${end}-${kind === undefined ? "structural" : kind}; input:\n${input}\nranges=${dump(ranges)}`);
  }
}

function assertNotHas(name, input, ranges, start, end, kind) {
  if (hasRange(ranges, start, end, kind)) {
    assert.fail(`${name}: forbidden range ${start}-${end}-${kind === undefined ? "structural" : kind}; input:\n${input}\nranges=${dump(ranges)}`);
  }
}

function assertNoKind(name, input, ranges, kind) {
  if (!ranges.every((r) => r.kind !== kind)) {
    assert.fail(`${name}: did not expect any ${kind} range; input:\n${input}\nranges=${dump(ranges)}`);
  }
}

describe("WinUI XAML red-team 37 — folding ranges", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("does not fold single-line elements or single-line property elements", async () => {
    const input = "<Grid><Button /></Grid>\n<Grid.RowDefinitions><RowDefinition /></Grid.RowDefinitions>";
    const ranges = await rangesFor("single-line elements", input);
    assertNotHas("single-line elements", input, ranges, 0, 0, undefined);
    assertNotHas("single-line property element", input, ranges, 1, 1, undefined);
  });

  it("folds ordinary multi-line elements from open tag to end tag", async () => {
    const input = "<Grid>\n  <Button />\n</Grid>";
    const ranges = await rangesFor("multi-line element", input);
    assertHas("multi-line element", input, ranges, 0, 2, undefined);
  });

  it("folds an empty two-line element as the minimal valid non-degenerate range", async () => {
    const input = "<Grid>\n</Grid>";
    const ranges = await rangesFor("two-line empty element", input);
    assertHas("two-line empty element", input, ranges, 0, 1, undefined);
  });

  it("folds when element content and end tag share the second line", async () => {
    const input = "<Grid>\n  <Button /></Grid>";
    const ranges = await rangesFor("content and end tag share line", input);
    assertHas("content and end tag share line", input, ranges, 0, 1, undefined);
  });

  it("folds wrapped-open-tag elements from the first open-tag line to the end-tag line", async () => {
    const input = "<Grid\n  RowSpacing=\"4\">\n  <Button />\n</Grid>";
    const ranges = await rangesFor("wrapped open tag with body", input);
    assertHas("wrapped open tag with body", input, ranges, 0, 3, undefined);
  });

  it("never folds self-closing tags, including wrapped attributes", async () => {
    const input = "<Grid>\n  <Button\n    Content=\"Wrapped\"\n    />\n</Grid>";
    const ranges = await rangesFor("wrapped self-closing tag", input);
    assertHas("wrapped self-closing parent", input, ranges, 0, 4, undefined);
    assertNotHas("wrapped self-closing tag", input, ranges, 1, 3, undefined);
  });

  it("folds multi-line property elements but not single-line property elements", async () => {
    const input = [
      "<Grid>",
      "  <Grid.RowDefinitions>",
      "    <RowDefinition Height=\"Auto\" />",
      "  </Grid.RowDefinitions>",
      "  <Grid.ColumnDefinitions><ColumnDefinition /></Grid.ColumnDefinitions>",
      "</Grid>",
    ].join("\n");
    const ranges = await rangesFor("property elements", input);
    assertHas("multi-line property element", input, ranges, 1, 3, undefined);
    assertNotHas("single-line property element", input, ranges, 4, 4, undefined);
  });

  it("handles deep nesting without inverted ranges and emits representative ancestor/descendant folds", async () => {
    const lines = ["<A>"];
    for (let i = 0; i < 12; i++) lines.push(`  <N${i}>`);
    lines.push("    <Leaf />");
    for (let i = 11; i >= 0; i--) lines.push(`  </N${i}>`);
    lines.push("</A>");
    const input = lines.join("\n");
    const ranges = await rangesFor("deep nesting", input);
    assertHas("deep nesting root", input, ranges, 0, 26, undefined);
    assertHas("deep nesting innermost", input, ranges, 12, 14, undefined);
  });

  it("folds multi-line comments with comment kind and ignores markup-looking comment text", async () => {
    const input = "<Grid>\n<!--\n  <Button></Button>\n  <![CDATA[x]]>\n-->\n</Grid>";
    const ranges = await rangesFor("multi-line comment", input);
    assertHas("multi-line comment", input, ranges, 1, 4, "comment");
  });

  it("does not fold single-line comments", async () => {
    const input = "<Grid>\n  <!-- one line -->\n</Grid>";
    const ranges = await rangesFor("single-line comment", input);
    assertHas("single-line comment parent", input, ranges, 0, 2, undefined);
    assertNotHas("single-line comment", input, ranges, 1, 1, "comment");
  });

  it("folds comments whose open and close share lines with surrounding markup", async () => {
    const input = "<Grid><!--\n  comment body\n--></Grid>";
    const ranges = await rangesFor("inline-boundary comment", input);
    assertHas("inline-boundary comment", input, ranges, 0, 2, "comment");
  });

  it("folds multi-line CDATA structurally and does not classify region-looking CDATA as a region", async () => {
    const input = "<x><![CDATA[\n<!-- #region fake -->\n</x>\n<!-- #endregion fake -->\n]]></x>";
    const ranges = await rangesFor("multi-line CDATA", input);
    assertHas("multi-line CDATA", input, ranges, 0, 4, undefined);
    assertNoKind("CDATA region text", input, ranges, "region");
  });

  it("does not fold single-line CDATA", async () => {
    const input = "<x><![CDATA[one line]]></x>";
    const ranges = await rangesFor("single-line CDATA", input);
    assertNotHas("single-line CDATA", input, ranges, 0, 0, undefined);
  });

  it("folds basic labeled regions with region kind", async () => {
    const input = "<!-- #region  Foo Bar -->\n<Grid />\n<!-- #endregion Foo Bar -->";
    const ranges = await rangesFor("basic labeled region", input);
    assertHas("basic labeled region", input, ranges, 0, 2, "region");
  });

  it("pairs nested regions innermost-first without crossing", async () => {
    const input = [
      "<!-- #region outer -->",
      "<Grid>",
      "<!-- #region inner -->",
      "<Button />",
      "<!-- #endregion inner -->",
      "</Grid>",
      "<!-- #endregion outer -->",
    ].join("\n");
    const ranges = await rangesFor("nested regions", input);
    assertHas("inner region", input, ranges, 2, 4, "region");
    assertHas("outer region", input, ranges, 0, 6, "region");
    assertNotHas("mis-paired nested region", input, ranges, 0, 4, "region");
    assertNotHas("mis-paired nested region", input, ranges, 2, 6, "region");
  });

  it("ignores unbalanced and stray region markers", async () => {
    const input = [
      "<!-- #endregion stray -->",
      "<Grid>",
      "<!-- #region orphan -->",
      "<Button />",
      "</Grid>",
    ].join("\n");
    const ranges = await rangesFor("unbalanced regions", input);
    assertNoKind("unbalanced regions", input, ranges, "region");
  });

  it("rejects region marker prefixes that are not exact markers or whitespace-labeled markers", async () => {
    const input = "<!-- #regionalize nope -->\n<Grid />\n<!-- #endregionx nope -->";
    const ranges = await rangesFor("region marker prefixes", input);
    assertNoKind("region marker prefixes", input, ranges, "region");
  });

  it("handles no-space region markers and adjacent two-line regions", async () => {
    const input = "<!--#region-->\n<!--#endregion-->\n<!-- #region next -->\n<!-- #endregion next -->";
    const ranges = await rangesFor("compact adjacent regions", input);
    assertHas("compact adjacent first region", input, ranges, 0, 1, "region");
    assertHas("compact adjacent second region", input, ranges, 2, 3, "region");
  });

  it("does not emit a degenerate region when start and end markers are on the same line", async () => {
    const input = "<!-- #region --><!-- #endregion -->\n<Grid />";
    const ranges = await rangesFor("same-line region markers", input);
    assertNoKind("same-line region markers", input, ranges, "region");
  });

  it("keeps region folds independent of interleaved element boundaries", async () => {
    const input = [
      "<Grid>",
      "  <!-- #region inside grid -->",
      "  <StackPanel>",
      "  </StackPanel>",
      "  <!-- #endregion inside grid -->",
      "</Grid>",
    ].join("\n");
    const ranges = await rangesFor("interleaved region and element folds", input);
    assertHas("interleaved element fold", input, ranges, 0, 5, undefined);
    assertHas("interleaved region fold", input, ranges, 1, 4, "region");
    assertHas("interleaved child element fold", input, ranges, 2, 3, undefined);
  });

  it("backs unterminated elements off a consumed trailing newline", async () => {
    const input = "<Grid>\n  <Button />\n";
    const ranges = await rangesFor("unterminated trailing newline", input);
    assertHas("unterminated trailing newline", input, ranges, 0, 1, undefined);
    assertNotHas("unterminated trailing newline over-fold", input, ranges, 0, 2, undefined);
  });

  it("folds unterminated elements to the last content line when there is no trailing newline", async () => {
    const input = "<Grid>\n  <Button />";
    const ranges = await rangesFor("unterminated no trailing newline", input);
    assertHas("unterminated no trailing newline", input, ranges, 0, 1, undefined);
  });

  it("keeps malformed and mismatched markup crash-safe without bad ranges", async () => {
    for (const [name, input] of [
      ["mismatched end tag", "<Grid>\n  <Button />\n</Wrong>"],
      ["stray less-than", "<Grid>\n  <\n  <Button />\n</Grid>"],
      ["space after less-than", "< Grid>\n  <Button />\n</ Grid>"],
      ["attribute without value", "<Grid>\n  <Button Content />\n</Grid>"],
      ["unclosed quote spanning lines", "<Grid>\n  <Button Content=\"line1\nline2\n  <TextBlock />\n</Grid>"],
    ]) {
      await rangesFor(`malformed: ${name}`, input);
    }
  });

  it("leaves empty, whitespace-only, and blank-padded documents crash-safe", async () => {
    for (const [name, input] of [
      ["empty", ""],
      ["whitespace-only", "  \n\t\n"],
      ["blank-padded", "\n\n<Grid>\n\n  <Button />\n\n</Grid>\n\n"],
    ]) {
      const ranges = await rangesFor(`whitespace: ${name}`, input);
      if (name === "empty" || name === "whitespace-only") {
        assert.deepStrictEqual(ranges, [], `${name}: expected no ranges; got ${dump(ranges)}`);
      } else {
        assertHas("blank-padded element", input, ranges, 2, 6, undefined);
      }
    }
  });
});
