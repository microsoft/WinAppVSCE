"use strict";

// Round 43 red-team probes for WinUI XAML semantic tokens.
// These focus on LSP stream invariants, exact source coverage, prefix splitting, markup extensions,
// malformed input, and deterministic whole-document tokenization.

const assert = require("node:assert");
const h = require("./helper");

const LEGEND = ["namespace", "class", "property", "macro", "parameter"];

function dump(value) {
  return JSON.stringify(value);
}

function lineStartsOf(text) {
  const normalized = text.replace(/\r\n/g, "\n");
  const starts = [0];
  for (let i = 0; i < normalized.length; i++) if (normalized[i] === "\n") starts.push(i + 1);
  return starts;
}

function offsetToPos(starts, offset) {
  let line = 0;
  while (line + 1 < starts.length && starts[line + 1] <= offset) line++;
  return { line, character: offset - starts[line] };
}

function nthIndexOf(text, needle, occurrence = 0) {
  let from = 0;
  for (let i = 0; i <= occurrence; i++) {
    const at = text.indexOf(needle, from);
    assert.ok(at >= 0, `missing occurrence ${occurrence} of ${dump(needle)} in ${dump(text)}`);
    if (i === occurrence) return at;
    from = at + needle.length;
  }
  throw new Error("unreachable");
}

function tokenInNeedle(buffer, needle, text, type, occurrence = 0) {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const needleAt = nthIndexOf(normalized, needle, occurrence);
  const tokenAtInNeedle = needle.indexOf(text);
  assert.ok(tokenAtInNeedle >= 0, `${dump(text)} is not inside expected fragment ${dump(needle)}`);
  const at = needleAt + tokenAtInNeedle;
  const pos = offsetToPos(lineStartsOf(normalized), at);
  return { line: pos.line, character: pos.character, length: text.length, type, text };
}

function tokensFromNeedles(buffer, specs) {
  return specs.map((s) => tokenInNeedle(buffer, s.needle, s.text, s.type, s.occurrence || 0));
}

function shapes(tokens) {
  return tokens.map((t) => ({ line: t.line, character: t.character, length: t.length, type: t.type, text: t.text }));
}

function assertLegend(result) {
  assert.deepStrictEqual(result.legend.tokenTypes, LEGEND, `wrong token legend: ${dump(result.legend)}`);
  // Round 59 added the defaultLibrary modifier (framework-vs-user marking); the legend advertises it.
  assert.deepStrictEqual(result.legend.tokenModifiers, ["defaultLibrary"], `token modifiers legend: ${dump(result.legend)}`);
}

function assertInvariants(result, label) {
  assertLegend(result);
  let prev;
  for (const t of result.tokens) {
    assert.ok(Number.isInteger(t.line) && Number.isInteger(t.character), `${label}: non-integer position ${dump(t)}`);
    assert.ok(t.length > 0, `${label}: token length must be positive ${dump(t)}`);
    assert.ok(LEGEND.includes(t.type), `${label}: token type must be in range ${dump(t)}`);
    assert.strictEqual(t.text.length, t.length, `${label}: decoded text/length drift ${dump(t)}`);
    assert.ok(!t.text.includes("\n") && !t.text.includes("\r"), `${label}: token must be single-line ${dump(t)}`);
    if (prev) {
      const sorted = t.line > prev.line || (t.line === prev.line && t.character >= prev.character + prev.length);
      assert.ok(sorted, `${label}: tokens must be sorted and non-overlapping: prev=${dump(prev)} cur=${dump(t)}`);
    }
    prev = t;
  }
}

async function getChecked(buffer, label) {
  const result = await h.semanticTokensAt(buffer);
  assertInvariants(result, label);
  return result;
}

describe("WinUI XAML — red-team 43 (semantic tokens)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("advertises the exact legend and classifies a dense realistic page with exact positions", async () => {
    const buffer =
      "<Page\n" +
      "    xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\"\n" +
      "    xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\"\n" +
      "    xmlns:local=\"using:SmokeFixture\"\n" +
      "    x:Class=\"SmokeFixture.SmokePage\">\n" +
      "  <Grid x:Name=\"Root\" Grid.Row=\"0\" Background=\"{StaticResource Accent}\">\n" +
      "    <TextBlock Text=\"{Binding ElementName=Root, Path=Title, Mode=OneWay}\" />\n" +
      "  </Grid>\n" +
      "</Page>";
    const result = await getChecked(buffer, "dense page");
    assert.deepStrictEqual(shapes(result.tokens), tokensFromNeedles(buffer, [
      { needle: "<Page", text: "Page", type: "class" },
      { needle: "x:Class", text: "x", type: "namespace" }, { needle: "x:Class", text: "Class", type: "property" },
      { needle: "<Grid", text: "Grid", type: "class" }, { needle: "x:Name", text: "x", type: "namespace" },
      { needle: "x:Name", text: "Name", type: "property" }, { needle: "Grid.Row", text: "Grid.Row", type: "property" },
      { needle: "Background", text: "Background", type: "property" }, { needle: "StaticResource Accent", text: "StaticResource", type: "macro" },
      { needle: "<TextBlock", text: "TextBlock", type: "class" }, { needle: " Text=\"{Binding", text: "Text", type: "property" },
      { needle: "{Binding", text: "Binding", type: "macro" }, { needle: "ElementName=Root", text: "ElementName", type: "parameter" },
      { needle: "Path=Title", text: "Path", type: "parameter" }, { needle: "Mode=OneWay", text: "Mode", type: "parameter" },
      { needle: "</Grid>", text: "Grid", type: "class" },
      { needle: "</Page>", text: "Page", type: "class" },
    ]));
  });

  it("keeps delta positions correct across CRLF, tabs, blank lines, column-zero tags, and many same-line tokens", async () => {
    const lf =
      "\n" +
      "<Grid>\n" +
      "\t<Button x:Name=\"Go\" Content=\"OK\"/><Border Grid.Column=\"1\"/>\n" +
      "<StackPanel Orientation=\"Horizontal\"><TextBox Text=\"{Binding Path=Name}\"/></StackPanel>\n" +
      "</Grid>";
    const buffer = lf.replace(/\n/g, "\r\n");
    const result = await getChecked(buffer, "CRLF/tab delta");
    assert.deepStrictEqual(shapes(result.tokens), tokensFromNeedles(lf, [
      { needle: "<Grid>", text: "Grid", type: "class" },
      { needle: "<Button", text: "Button", type: "class" }, { needle: "x:Name", text: "x", type: "namespace" },
      { needle: "x:Name", text: "Name", type: "property" }, { needle: "Content", text: "Content", type: "property" },
      { needle: "<Border", text: "Border", type: "class" }, { needle: "Grid.Column", text: "Grid.Column", type: "property" },
      { needle: "<StackPanel", text: "StackPanel", type: "class" }, { needle: "Orientation", text: "Orientation", type: "property" },
      { needle: "<TextBox", text: "TextBox", type: "class" }, { needle: " Text=\"{Binding", text: "Text", type: "property" },
      { needle: "{Binding", text: "Binding", type: "macro" }, { needle: "Path=Name", text: "Path", type: "parameter" },
      { needle: "</StackPanel>", text: "StackPanel", type: "class" },
      { needle: "</Grid>", text: "Grid", type: "class" },
    ]));
  });

  it("splits prefixes while keeping dotted local names whole for elements, attributes, and property elements", async () => {
    const buffer =
      "<local:My.Thing local:Attached.Prop=\"1\" x:Key=\"ThingKey\">\n" +
      "  <local:My.Thing.Bar>\n" +
      "    <Grid.RowDefinitions><RowDefinition /></Grid.RowDefinitions>\n" +
      "    <Grid.Row>0</Grid.Row>\n" +
      "  </local:My.Thing.Bar>\n" +
      "</local:My.Thing>";
    const result = await getChecked(buffer, "prefix and dotted names");
    assert.deepStrictEqual(shapes(result.tokens), tokensFromNeedles(buffer, [
      { needle: "<local:My.Thing", text: "local", type: "namespace" }, { needle: "<local:My.Thing", text: "My.Thing", type: "class" },
      { needle: "local:Attached.Prop", text: "local", type: "namespace" }, { needle: "local:Attached.Prop", text: "Attached.Prop", type: "property" },
      { needle: "x:Key", text: "x", type: "namespace" }, { needle: "x:Key", text: "Key", type: "property" },
      { needle: "<local:My.Thing.Bar", text: "local", type: "namespace" }, { needle: "<local:My.Thing.Bar", text: "My.Thing.Bar", type: "class" },
      { needle: "<Grid.RowDefinitions", text: "Grid.RowDefinitions", type: "property" },
      { needle: "<RowDefinition", text: "RowDefinition", type: "class" },
      { needle: "</Grid.RowDefinitions>", text: "Grid.RowDefinitions", type: "property" },
      { needle: "<Grid.Row>", text: "Grid.Row", type: "property" }, { needle: "</Grid.Row>", text: "Grid.Row", type: "property" },
      { needle: "</local:My.Thing.Bar>", text: "local", type: "namespace" }, { needle: "</local:My.Thing.Bar>", text: "My.Thing.Bar", type: "class" },
      { needle: "</local:My.Thing>", text: "local", type: "namespace" }, { needle: "</local:My.Thing>", text: "My.Thing", type: "class" },
    ]));
  });

  it("classifies nested markup extensions but skips values, positional args, x:Name values, and x:Key values", async () => {
    const buffer =
      "<Grid x:Name=\"Root\" x:Key=\"PanelKey\"\n" +
      "      Background=\"{StaticResource Accent}\"\n" +
      "      Tag=\"{Binding Source={StaticResource Accent}, Path=Title, Mode=OneWay}\"\n" +
      "      DataContext=\"{x:Bind ViewModel.SelectedItem, Mode=OneWay}\"\n" +
      "      ToolTipService.ToolTip=\"{}\" />";
    const result = await getChecked(buffer, "markup extensions");
    assert.deepStrictEqual(shapes(result.tokens), tokensFromNeedles(buffer, [
      { needle: "<Grid", text: "Grid", type: "class" }, { needle: "x:Name", text: "x", type: "namespace" },
      { needle: "x:Name", text: "Name", type: "property" }, { needle: "x:Key", text: "x", type: "namespace" },
      { needle: "x:Key", text: "Key", type: "property" },
      { needle: "Background", text: "Background", type: "property" }, { needle: "StaticResource Accent", text: "StaticResource", type: "macro" },
      { needle: "Tag=", text: "Tag", type: "property" }, { needle: "{Binding Source", text: "Binding", type: "macro" },
      { needle: "Source={StaticResource", text: "Source", type: "parameter" }, { needle: "{StaticResource Accent}", text: "StaticResource", type: "macro", occurrence: 1 },
      { needle: "Path=Title", text: "Path", type: "parameter" }, { needle: "Mode=OneWay}", text: "Mode", type: "parameter" },
      { needle: "DataContext", text: "DataContext", type: "property" }, { needle: "{x:Bind", text: "x", type: "namespace" },
      { needle: "{x:Bind", text: "Bind", type: "macro" }, { needle: ", Mode=OneWay", text: "Mode", type: "parameter", occurrence: 1 },
      { needle: "ToolTipService.ToolTip", text: "ToolTipService.ToolTip", type: "property" },
    ]));
    const texts = result.tokens.map((t) => t.text);
    for (const skipped of ["Root", "PanelKey", "Accent", "Title", "OneWay", "ViewModel.SelectedItem"]) {
      assert.ok(!texts.includes(skipped), `semantic tokens must skip value/positional text ${skipped}: ${dump(result.tokens)}`);
    }
  });

  it("does not tokenize xmlns declarations, comments, CDATA, XML declarations, processing instructions, or escaped literals", async () => {
    const buffer =
      "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n" +
      "<?tool <Button/> ?>\n" +
      "<Page xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\" xmlns:local=\"using:SmokeFixture\">\n" +
      "  <!-- <Button x:Name=\"Commented\" Content=\"Nope\"/> -->\n" +
      "  <![CDATA[<Border Background=\"{StaticResource Accent}\"/>]]>\n" +
      "  <TextBlock Text=\"{}{NotAMarkupExtension}\" />\n" +
      "</Page>";
    const result = await getChecked(buffer, "skipped trivia");
    assert.deepStrictEqual(shapes(result.tokens), tokensFromNeedles(buffer, [
      { needle: "<Page", text: "Page", type: "class" },
      { needle: "<TextBlock", text: "TextBlock", type: "class" },
      { needle: " Text=\"{}{NotAMarkupExtension}", text: "Text", type: "property" },
      { needle: "</Page>", text: "Page", type: "class" },
    ]));
  });

  it("survives hostile malformed input and still returns well-formed sorted token streams", async () => {
    const buffer =
      "<Grid\n" +
      "  <<>>\n" +
      "  <Button x:Name=\"Root Content=\"unterminated\" Background=\"{StaticResource Accent\"\n" +
      "  <A></B>\n" +
      "  <TextBlock Text=\"{Binding Path=Name, Source={StaticResource K}\" />\n" +
      "</Grid>";
    const result = await getChecked(buffer, "hostile malformed");
    assert.ok(result.tokens.some((t) => t.type === "class" && t.text === "Grid"), `expected at least stable Grid tokens: ${dump(result.tokens)}`);
  });

  it("is deterministic for repeated identical whole-document requests", async () => {
    const buffer =
      "<Grid x:Name=\"Root\">\n" +
      "  <Button Content=\"{Binding ElementName=Root, Path=Text}\" />\n" +
      "  <Border Background=\"{StaticResource Accent}\" />\n" +
      "</Grid>";
    const first = await getChecked(buffer, "determinism first");
    const second = await getChecked(buffer, "determinism second");
    assert.deepStrictEqual(first, second, "semantic token result must be byte-for-byte deterministic");
  });

  it("handles a large realistic tree without throwing, overlap, or drift", async () => {
    const rows = [];
    for (let i = 0; i < 220; i++) {
      rows.push(`  <Button x:Name="Item${i}" Grid.Row="${i}" Content="{Binding Path=Items[${i}].Title}" />`);
    }
    const buffer = "<Grid>\n" + rows.join("\n") + "\n</Grid>";
    const result = await getChecked(buffer, "large document");
    assert.strictEqual(result.tokens.length, 1 + 220 * 7 + 1, `unexpected large-tree token count: ${dump(result.tokens.slice(0, 20))}`);
    assert.deepStrictEqual(shapes(result.tokens.slice(0, 8)), tokensFromNeedles(buffer, [
      { needle: "<Grid>", text: "Grid", type: "class" }, { needle: "<Button", text: "Button", type: "class" },
      { needle: "x:Name", text: "x", type: "namespace" }, { needle: "x:Name", text: "Name", type: "property" },
      { needle: "Grid.Row", text: "Grid.Row", type: "property" }, { needle: "Content", text: "Content", type: "property" },
      { needle: "{Binding", text: "Binding", type: "macro" }, { needle: "Path=Items", text: "Path", type: "parameter" },
    ]));
    assert.deepStrictEqual(shapes(result.tokens.slice(-8)), [
      tokenInNeedle(buffer, "<Button", "Button", "class", 219),
      tokenInNeedle(buffer, "x:Name", "x", "namespace", 219),
      tokenInNeedle(buffer, "x:Name", "Name", "property", 219),
      tokenInNeedle(buffer, "Grid.Row", "Grid.Row", "property", 219),
      tokenInNeedle(buffer, "Content", "Content", "property", 219),
      tokenInNeedle(buffer, "{Binding", "Binding", "macro", 219),
      tokenInNeedle(buffer, "Path=Items", "Path", "parameter", 219),
      tokenInNeedle(buffer, "</Grid>", "Grid", "class"),
    ]);
  });
});
