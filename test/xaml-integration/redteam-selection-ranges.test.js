"use strict";

// Selection-range nesting, boundaries, malformed markup, and determinism.

const assert = require("node:assert");
const vscode = require("vscode");
const h = require("./helper");

function dump(value) {
  return JSON.stringify(value);
}

function markerPositions(text) {
  const positions = [];
  let clean = "";
  let line = 0;
  let character = 0;
  for (const ch of text) {
    if (ch === "|") {
      positions.push(new vscode.Position(line, character));
      continue;
    }
    clean += ch;
    if (ch === "\n") {
      line++;
      character = 0;
    } else {
      character++;
    }
  }
  assert.ok(positions.length > 0, "probe must include at least one | marker");
  return { clean, positions };
}

function flattenSelectionRange(root) {
  const ranges = [];
  for (let cur = root; cur; cur = cur.parent) {
    ranges.push({
      start: { line: cur.range.start.line, character: cur.range.start.character },
      end: { line: cur.range.end.line, character: cur.range.end.character },
    });
  }
  return ranges;
}

function cmpPos(a, b) {
  return a.line === b.line ? a.character - b.character : a.line - b.line;
}

function contains(range, pos) {
  return cmpPos(range.start, pos) <= 0 && cmpPos(pos, range.end) <= 0;
}

function assertWellFormed(name, probe, caret, ranges) {
  const doc = h.getDoc();
  const docEnd = doc.positionAt(doc.getText().length);
  const evidence = () => `probe=${JSON.stringify(probe)} caret=${dump(caret)} ranges=${dump(ranges)}`;

  assert.ok(ranges.length >= 1, `${name}: expected at least one range; ${evidence()}`);
  for (const [i, r] of ranges.entries()) {
    assert.ok(r.start.line >= 0 && r.start.character >= 0, `${name}: negative start at level ${i}; ${evidence()}`);
    assert.ok(r.end.line >= 0 && r.end.character >= 0, `${name}: negative end at level ${i}; ${evidence()}`);
    assert.ok(cmpPos(r.start, r.end) <= 0, `${name}: inverted range at level ${i}; ${evidence()}`);
    assert.ok(contains(r, caret), `${name}: level ${i} does not contain caret; ${evidence()}`);
  }

  // VS Code's executeSelectionRangeProvider MERGES our provider's chain with its own built-in (word/bracket/indent) selection-range providers
  const deduped = [];
  for (const r of ranges) {
    const prev = deduped[deduped.length - 1];
    if (prev && cmpPos(prev.start, r.start) === 0 && cmpPos(prev.end, r.end) === 0) continue;
    deduped.push(r);
  }

  for (let i = 0; i + 1 < deduped.length; i++) {
    const child = deduped[i];
    const parent = deduped[i + 1];
    const containsChild = cmpPos(parent.start, child.start) <= 0 && cmpPos(child.end, parent.end) <= 0;
    const strict = cmpPos(parent.start, child.start) < 0 || cmpPos(child.end, parent.end) < 0;
    assert.ok(containsChild && strict, `${name}: level ${i + 1} must strictly contain level ${i}; ${evidence()}`);
  }

  const outer = ranges[ranges.length - 1];
  assert.deepStrictEqual(outer.start, { line: 0, character: 0 }, `${name}: outermost must start at document start; ${evidence()}`);
  assert.deepStrictEqual(
    outer.end,
    { line: docEnd.line, character: docEnd.character },
    `${name}: outermost must end at document end; docEnd=${dump(docEnd)} ${evidence()}`
  );
}

async function assertProbe(name, probe) {
  const result = await h.selectionRangesAt(probe);
  assertWellFormed(name, probe, result.caret, result.ranges);
  return result;
}

describe("WinUI XAML red-team 39 — selection range provider", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("keeps promised attribute-value granularity strictly nested on a single line", async () => {
    const probe = '<Grid Background="#FF|0000" />';
    const clean = probe.replace("|", "");
    const { caret, ranges } = await assertProbe("attribute value granularity", probe);
    const texts = ranges
      .filter((r) => r.start.line === 0 && r.end.line === 0)
      .map((r) => clean.slice(r.start.character, r.end.character));

    assert.ok(texts.includes("#FF0000"), `missing inner value text; caret=${dump(caret)} ranges=${dump(ranges)} texts=${dump(texts)}`);
    assert.ok(texts.includes('"#FF0000"'), `missing quoted value; caret=${dump(caret)} ranges=${dump(ranges)} texts=${dump(texts)}`);
    assert.ok(texts.includes('Background="#FF0000"'), `missing whole attribute; caret=${dump(caret)} ranges=${dump(ranges)} texts=${dump(texts)}`);
    assert.strictEqual(texts[texts.length - 1], clean, `outermost should cover whole one-line document; ranges=${dump(ranges)} texts=${dump(texts)}`);
  });

  it("contains carets on tag and attribute boundaries without equal parent levels", async () => {
    const probes = [
      { name: "opening angle at document start", text: '|<Grid Width="1" />' },
      { name: "open-tag closing angle", text: '<Grid Width="1"| />' },
      { name: "slash of self-closing tag", text: '<Grid Width="1" |/>' },
      { name: "between attributes", text: '<Grid Width="1" |Height="2" />' },
      { name: "attribute equals boundary", text: '<Grid Width|="1" Height="2" />' },
      { name: "opening quote boundary", text: '<Grid Width=|"1" />' },
      { name: "closing quote boundary", text: '<Grid Width="1|" />' },
      { name: "EOF after self-closing root", text: '<Grid Width="1" />|' },
    ];
    for (const p of probes) await assertProbe(p.name, p.text);
  });

  it("stays well-formed in whitespace, comments, CDATA, and XML declarations", async () => {
    const probes = [
      { name: "leading whitespace before root", text: '  \n|\n<Grid />' },
      { name: "trailing whitespace after root", text: '<Grid />\n  |  \n' },
      { name: "blank line between children", text: '<StackPanel>\n  <Button />\n  |\n  <TextBlock />\n</StackPanel>' },
      { name: "comment body", text: '<Grid>\n  <!-- user might select <Button Content="|x" /> here -->\n</Grid>' },
      { name: "CDATA body", text: '<TextBlock><![CDATA[ literal <Button Content="|x" /> ]]></TextBlock>' },
      { name: "XML declaration", text: '<?xml version="1.0" |encoding="utf-8"?>\n<Grid />' },
    ];
    for (const p of probes) await assertProbe(p.name, p.text);
  });

  it("dedupes self-closing/open-tag/property-element and markup-extension overlaps", async () => {
    const probes = [
      { name: "self-closing element value", text: '<Button Content="O|K" />' },
      { name: "single child content", text: '<Grid><Button Content="O|K" /></Grid>' },
      { name: "property element name", text: '<Grid><Grid.RowDef|initions><RowDefinition /></Grid.RowDefinitions></Grid>' },
      { name: "markup extension value", text: '<Rectangle Fill="{Static|Resource AccentBrush}" />' },
      { name: "qualified attached property attribute", text: '<Grid Grid.Row="|1" />' },
    ];
    for (const p of probes) await assertProbe(p.name, p.text);
  });

  it("survives malformed, mismatched, and token-hostile markup", async () => {
    const probes = [
      { name: "unterminated element", text: '<Grid><Button Content="x|"' },
      { name: "mismatched closing tag", text: '<Grid><Button Content="x|x"></Wrong>' },
      { name: "stray less-than in text", text: '<Grid> stray < | text </Grid>' },
      { name: "attribute with no value", text: '<Grid Foo=|/>' },
      { name: "duplicate attributes", text: '<Button Content="a" Content="|b" />' },
      { name: "unterminated quote", text: '<TextBlock Text="unter|minated />' },
    ];
    for (const p of probes) await assertProbe(p.name, p.text);
  });

  it("handles deep and large realistic documents without losing strict nesting", async () => {
    const depth = 36;
    const open = Array.from({ length: depth }, (_, i) => `${"  ".repeat(i)}<Border x:Name="B${i}">`).join("\n");
    const close = Array.from({ length: depth }, (_, i) => `${"  ".repeat(depth - i - 1)}</Border>`).join("\n");
    const deep = `${open}\n${"  ".repeat(depth)}<TextBlock Text="dee|p" />\n${close}`;
    const deepResult = await assertProbe("36 nested Borders", deep);
    assert.ok(deepResult.ranges.length >= 30, `deep nesting lost ancestor levels; result=${dump(deepResult)}`);

    const rows = Array.from({ length: 220 }, (_, i) => `  <Button x:Name="Button${i}" Content="Row ${i}" />`);
    rows[117] = '  <Button x:Name="Button117" Content="Row |117" />';
    await assertProbe("large StackPanel with 220 children", `<StackPanel>\n${rows.join("\n")}\n</StackPanel>`);
  });

  it("returns one independent well-formed chain for each multi-position request", async () => {
    const probe = [
      '<StackPanel>',
      '  <Button Content="A|lpha" />',
      '  <!-- |comment caret -->',
      '  <Rectangle Fill="{StaticResource |AccentBrush}" />',
      '</StackPanel>|',
    ].join("\n");
    const { clean, positions } = markerPositions(probe);
    await h.setBuffer(clean);
    const result = await vscode.commands.executeCommand(
      "vscode.executeSelectionRangeProvider",
      h.getDoc().uri,
      positions
    );
    assert.strictEqual(result.length, positions.length, `expected one result per position; result=${dump(result)}`);
    for (let i = 0; i < positions.length; i++) {
      const caret = { line: positions[i].line, character: positions[i].character };
      assertWellFormed(`multi-position index ${i}`, probe, caret, flattenSelectionRange(result[i]));
    }
  });

  it("is deterministic for repeated requests at the same caret", async () => {
    const probe = '<Grid><Rectangle Fill="{ThemeResource Accent|Brush}" /></Grid>';
    const first = await assertProbe("determinism first request", probe);
    const second = await assertProbe("determinism second request", probe);
    assert.deepStrictEqual(second, first, `selection range chains changed between identical requests; first=${dump(first)} second=${dump(second)}`);
  });
});
