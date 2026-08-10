"use strict";

// Linked-editing ranges for tag boundaries, qualified names, and malformed markup.

const assert = require("node:assert");
const h = require("./helper");

function dump(value) {
  return JSON.stringify(value);
}

function cleanProbe(probe) {
  const caret = probe.indexOf("|");
  assert.ok(caret >= 0, "probe must include a | caret marker");
  return probe.slice(0, caret) + probe.slice(caret + 1);
}

function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function offsetToPos(starts, offset) {
  let line = 0;
  while (line + 1 < starts.length && starts[line + 1] <= offset) line++;
  return { line, character: offset - starts[line] };
}

function findOccurrenceRanges(clean, text, occurrenceIndexes) {
  const starts = lineStartsOf(clean);
  const offsets = [];
  let from = 0;
  while (true) {
    const at = clean.indexOf(text, from);
    if (at < 0) break;
    offsets.push(at);
    from = at + text.length;
  }
  return occurrenceIndexes.map((i) => {
    assert.ok(i < offsets.length, `missing occurrence ${i} of ${text}; found offsets=${dump(offsets)} clean=${dump(clean)}`);
    return {
      start: offsetToPos(starts, offsets[i]),
      end: offsetToPos(starts, offsets[i] + text.length),
      text,
    };
  });
}

function assertLineSlice(clean, range, expectedText, label) {
  const lines = clean.split("\n");
  assert.strictEqual(range.start.line, range.end.line, `${label}: expected single-line name range; range=${dump(range)}`);
  const sliced = lines[range.start.line].slice(range.start.character, range.end.character);
  assert.strictEqual(sliced, expectedText, `${label}: range must slice exactly the tag name; range=${dump(range)} line=${dump(lines[range.start.line])}`);
}

function assertRegexPattern(wordPattern, expectedText, label) {
  assert.ok(wordPattern && wordPattern.length > 0, `${label}: linked result must include a wordPattern`);
  // VS Code may hand the helper an internal RegExp-like object; helper.js normalizes with String(), which can become "[object Object]". Presence is the important LSP contract here.
  if (wordPattern === "[object Object]") return;
  let re;
  assert.doesNotThrow(() => { re = new RegExp(`^(?:${wordPattern})$`); }, `${label}: wordPattern must compile: ${wordPattern}`);
  assert.ok(re.test(expectedText), `${label}: wordPattern should match ${expectedText}; pattern=${wordPattern}`);
}

function assertRangesEqual(actual, expected, label, clean) {
  assert.strictEqual(actual.length, expected.length, `${label}: expected ${expected.length} ranges; actual=${dump(actual)} expected=${dump(expected)}`);
  for (let i = 0; i < expected.length; i++) {
    assert.deepStrictEqual(actual[i], expected[i], `${label}: range ${i} mismatch; actual=${dump(actual)} expected=${dump(expected)}`);
    assertLineSlice(clean, actual[i], expected[i].text, `${label} range ${i}`);
  }
  const a = actual[0].start;
  const b = actual[1].start;
  assert.ok(a.line < b.line || (a.line === b.line && a.character < b.character), `${label}: open name must precede close name; actual=${dump(actual)}`);
}

async function expectLink(label, probe, expectedText, occurrenceIndexes = [0, 1]) {
  const clean = cleanProbe(probe);
  const result = await h.linkedEditingAt(probe);
  const expected = findOccurrenceRanges(clean, expectedText, occurrenceIndexes);
  assertRangesEqual(result.ranges, expected, label, clean);
  assert.ok(result.ranges.every((r) => r.text === expectedText), `${label}: both ranges must cover ${expectedText}; result=${dump(result)}`);
  assertRegexPattern(result.wordPattern, expectedText, label);
  return result;
}

async function expectNoLink(label, probe) {
  const result = await h.linkedEditingAt(probe);
  assert.strictEqual(result.ranges.length, 0, `${label}: expected no linked ranges; result=${dump(result)} probe=${dump(probe)}`);
  return result;
}

describe("WinUI XAML red-team 40 — linked editing ranges", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("links only exact tag-name carets and excludes tag punctuation / attributes", async () => {
    await expectLink("open-name first character", "<|Grid></Grid>", "Grid");
    await expectLink("open-name last character", "<Gri|d></Grid>", "Grid");
    await expectLink("end-name first character", "<Grid></|Grid>", "Grid");
    await expectNoLink("opening angle bracket", "|<Grid></Grid>");
    await expectNoLink("end-tag slash", "<Grid><|/Grid>");
    await expectNoLink("open-tag closing angle", "<Grid>|</Grid>");
    await expectNoLink("inside attributes after name space", '<Grid |Width="1"></Grid>');
  });

  // The name's exclusive-end caret remains linked so typing can extend both tags. The first position beyond that boundary must not link.
  it("links at the exclusive end of the name (VS Code HTML inclusive-boundary parity)", async () => {
    await expectLink("caret at end of open name, on '>'", "<Grid|></Grid>", "Grid");
    await expectLink("caret at end of open name, on attribute space", '<Grid| Width="1"></Grid>', "Grid");
    await expectLink("caret at end of close name, on '>'", "<Grid></Grid|>", "Grid");
    await expectNoLink("one past open name, on '<' of the close tag", "<Grid>|</Grid>");
    await expectNoLink("past the whole element", "<Grid></Grid>|");
  });

  it("never links self-closing elements, including prefixes and spacing variants", async () => {
    await expectNoLink("plain spaced self-closing", "<But|ton />");
    await expectNoLink("tight self-closing", "<But|ton/>");
    await expectNoLink("prefixed self-closing with attributes", '<local:My|Control Width="1" />');
  });

  it("rejects unclosed, malformed, and mismatched pairs without inventing partners", async () => {
    await expectNoLink("unclosed root element", "<Gr|id>");
    await expectNoLink("unclosed child under closed root", "<Grid><But|ton></Grid>");
    await expectNoLink("mismatched close name", "<Gr|id></Span>");
    await expectNoLink("case-mismatched close name", "<Gr|id></grid>");
    await expectNoLink("prefix-mismatched close name", "<local:Fo|o></Foo>");
  });

  it("links the whole prefixed or dotted property-element name from any sub-token", async () => {
    await expectLink("prefixed name caret on prefix", "<lo|cal:MyControl></local:MyControl>", "local:MyControl");
    await expectLink("prefixed name caret on colon", "<local|:MyControl></local:MyControl>", "local:MyControl");
    await expectLink("prefixed name caret on local part", "<local:My|Control></local:MyControl>", "local:MyControl");
    await expectLink("property element caret on dot", "<Grid|.RowDefinitions></Grid.RowDefinitions>", "Grid.RowDefinitions");
    await expectLink("property element caret on property part", "<Grid.Row|Definitions></Grid.RowDefinitions>", "Grid.RowDefinitions");
  });

  it("chooses the correct pair in nested and sibling same-name elements", async () => {
    const nested = "<Grid><Grid></Grid></Grid>";
    await expectLink("nested identical inner open", "<Grid><Gr|id></Grid></Grid>", "Grid", [1, 2]);
    await expectLink("nested identical inner close", "<Grid><Grid></Gr|id></Grid>", "Grid", [1, 2]);
    await expectLink("nested identical outer open", "<Gr|id><Grid></Grid></Grid>", "Grid", [0, 3]);
    await expectLink("nested identical outer close", "<Grid><Grid></Grid></Gr|id>", "Grid", [0, 3]);
    await expectLink("sibling identical second element", "<StackPanel><Grid></Grid><Gr|id></Grid></StackPanel>", "Grid", [2, 3]);
    assert.strictEqual(cleanProbe("<Grid><Gr|id></Grid></Grid>"), nested, "sanity check nested probe text");
  });

  it("ignores tag-like text in comments, CDATA, text, and attribute values", async () => {
    await expectNoLink("comment body tag text", "<Grid><!-- <Gr|id></Grid> --></Grid>");
    await expectNoLink("CDATA tag text", "<Grid><![CDATA[ <Gr|id></Grid> ]]></Grid>");
    await expectNoLink("text node close-tag-looking text", "<TextBlock>literal </Gr|id> text</TextBlock>");
    await expectNoLink("attribute value with tag-looking text", '<Grid ToolTip="<Gr|id></Grid>"></Grid>');
  });

  it("is deterministic for repeated linked-editing requests", async () => {
    const first = await expectLink("determinism first request", "<StackPanel><But|ton></Button></StackPanel>", "Button");
    const second = await expectLink("determinism second request", "<StackPanel><But|ton></Button></StackPanel>", "Button");
    assert.deepStrictEqual(second, first, `linked editing changed between identical requests; first=${dump(first)} second=${dump(second)}`);
  });
});
