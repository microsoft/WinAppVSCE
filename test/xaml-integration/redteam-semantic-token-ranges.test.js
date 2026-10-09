"use strict";

// Semantic-token defaultLibrary modifiers and range requests.

const assert = require("node:assert");
const h = require("./helper");

const LEGEND = ["namespace", "class", "property", "macro", "parameter"];
const DEFAULT_LIB = ["defaultLibrary"];
const PRESENTATION = "http://schemas.microsoft.com/winfx/2006/xaml/presentation";
const XAML = "http://schemas.microsoft.com/winfx/2006/xaml";

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

function posToOffset(starts, textLen, pos) {
  if (pos.line >= starts.length) return textLen;
  return Math.min(starts[pos.line] + pos.character, textLen);
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

function tokenInNeedle(buffer, needle, text, type, defaultLibrary = false, occurrence = 0) {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const needleAt = nthIndexOf(normalized, needle, occurrence);
  const tokenAtInNeedle = needle.indexOf(text);
  assert.ok(tokenAtInNeedle >= 0, `${dump(text)} is not inside expected fragment ${dump(needle)}`);
  const at = needleAt + tokenAtInNeedle;
  const pos = offsetToPos(lineStartsOf(normalized), at);
  return {
    line: pos.line,
    character: pos.character,
    length: text.length,
    type,
    text,
    modifiers: defaultLibrary ? 1 : 0,
    modifierNames: defaultLibrary ? DEFAULT_LIB : [],
  };
}

function tokensFromNeedles(buffer, specs) {
  return specs.map((s) => tokenInNeedle(buffer, s.needle, s.text, s.type, s.defaultLibrary, s.occurrence || 0));
}

function tokenShape(t) {
  return {
    line: t.line,
    character: t.character,
    length: t.length,
    type: t.type,
    text: t.text,
    modifiers: t.modifiers,
    modifierNames: t.modifierNames,
  };
}

function tokenShapes(tokens) {
  return tokens.map(tokenShape);
}

function tokenKey(t) {
  return `${t.line}:${t.character}:${t.length}:${t.type}:${t.text}:${t.modifiers}`;
}

function assertLegend(result) {
  assert.deepStrictEqual(result.legend.tokenTypes, LEGEND, `wrong token legend: ${dump(result.legend)}`);
  assert.deepStrictEqual(result.legend.tokenModifiers, DEFAULT_LIB, `token modifiers legend: ${dump(result.legend)}`);
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
    assert.ok((t.modifiers & ~1) === 0, `${label}: unexpected semantic-token modifier bits ${dump(t)}`);
    assert.deepStrictEqual(t.modifierNames, t.modifiers === 1 ? DEFAULT_LIB : [], `${label}: modifierNames drift ${dump(t)}`);
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

async function getRangeChecked(buffer, range, label) {
  const result = await h.semanticTokensRangeAt(buffer, range);
  assertInvariants(result, label);
  return result;
}

function tokenOverlapsRange(buffer, token, range) {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const starts = lineStartsOf(normalized);
  const textLen = normalized.length;
  const rangeStart = posToOffset(starts, textLen, range.start);
  const rangeEnd = posToOffset(starts, textLen, range.end);
  const tokenStart = posToOffset(starts, textLen, { line: token.line, character: token.character });
  const tokenEnd = tokenStart + token.length;
  return tokenStart < rangeEnd && tokenEnd > rangeStart;
}

async function assertRangeMatchesFull(buffer, range, label) {
  const full = await getChecked(buffer, `${label} full`);
  const ranged = await getRangeChecked(buffer, range, `${label} range`);
  const expected = full.tokens.filter((t) => tokenOverlapsRange(buffer, t, range)).map(tokenShape);
  assert.deepStrictEqual(tokenShapes(ranged.tokens), expected, `${label}: range tokens must equal overlapping full tokens`);
  const fullKeys = new Set(full.tokens.map(tokenKey));
  for (const t of ranged.tokens) {
    assert.ok(fullKeys.has(tokenKey(t)), `${label}: ranged token is not an identical full-token subset member ${dump(t)}`);
  }
  return { full, ranged };
}

describe("WinUI XAML — red-team 59 (semantic-token modifiers + range)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("marks framework elements from default presentation xmlns but not after default xmlns remaps to user code", async () => {
    const buffer =
      `<Page xmlns="${PRESENTATION}">\n` +
      "  <Grid><Button /></Grid>\n" +
      "</Page>\n" +
      '<Page xmlns="using:App">\n' +
      "  <Grid><Button /></Grid>\n" +
      "</Page>";
    const result = await getChecked(buffer, "default xmlns remap");
    assert.deepStrictEqual(tokenShapes(result.tokens), tokensFromNeedles(buffer, [
      { needle: "<Page", text: "Page", type: "class", defaultLibrary: true },
      { needle: "<Grid", text: "Grid", type: "class", defaultLibrary: true },
      { needle: "<Button", text: "Button", type: "class", defaultLibrary: true },
      { needle: "</Grid>", text: "Grid", type: "class", defaultLibrary: true },
      { needle: "</Page>", text: "Page", type: "class", defaultLibrary: true },
      { needle: '<Page xmlns="using:App">', text: "Page", type: "class" },
      { needle: "<Grid", text: "Grid", type: "class", occurrence: 1 },
      { needle: "<Button", text: "Button", type: "class", occurrence: 1 },
      { needle: "</Grid>", text: "Grid", type: "class", occurrence: 1 },
      { needle: "</Page>", text: "Page", type: "class", occurrence: 1 },
    ]));
  });

  it("marks both pieces of XAML-language x: directives and x-prefixed markup extensions", async () => {
    const buffer =
      `<Page xmlns="${PRESENTATION}" xmlns:x="${XAML}" x:Class="SmokeFixture.Page">\n` +
      '  <Grid x:Name="Root" x:Uid="RootUid" DataContext="{x:Bind ViewModel}" Tag="{x:Null}" />\n' +
      '  <ResourceDictionary><Style x:Key="K" /></ResourceDictionary>\n' +
      "</Page>";
    const result = await getChecked(buffer, "x directives");
    assert.deepStrictEqual(tokenShapes(result.tokens), tokensFromNeedles(buffer, [
      { needle: "<Page", text: "Page", type: "class", defaultLibrary: true },
      { needle: "x:Class", text: "x", type: "namespace", defaultLibrary: true },
      { needle: "x:Class", text: "Class", type: "property", defaultLibrary: true },
      { needle: "<Grid", text: "Grid", type: "class", defaultLibrary: true },
      { needle: "x:Name", text: "x", type: "namespace", defaultLibrary: true },
      { needle: "x:Name", text: "Name", type: "property", defaultLibrary: true },
      { needle: "x:Uid", text: "x", type: "namespace", defaultLibrary: true },
      { needle: "x:Uid", text: "Uid", type: "property", defaultLibrary: true },
      { needle: "DataContext", text: "DataContext", type: "property" },
      { needle: "{x:Bind", text: "x", type: "namespace", defaultLibrary: true },
      { needle: "{x:Bind", text: "Bind", type: "macro", defaultLibrary: true },
      { needle: "Tag=", text: "Tag", type: "property" },
      { needle: "{x:Null", text: "x", type: "namespace", defaultLibrary: true },
      { needle: "{x:Null", text: "Null", type: "macro", defaultLibrary: true },
      { needle: "<ResourceDictionary", text: "ResourceDictionary", type: "class", defaultLibrary: true },
      { needle: "<Style", text: "Style", type: "class", defaultLibrary: true },
      { needle: "x:Key", text: "x", type: "namespace", defaultLibrary: true },
      { needle: "x:Key", text: "Key", type: "property", defaultLibrary: true },
      { needle: "</ResourceDictionary>", text: "ResourceDictionary", type: "class", defaultLibrary: true },
      { needle: "</Page>", text: "Page", type: "class", defaultLibrary: true },
    ]));
  });

  it("keys modifiers by exact xmlns URI for custom framework prefixes while rejecting design-time and user prefixes", async () => {
    const buffer =
      `<root xmlns:w="${PRESENTATION}" xmlns:xl="${XAML}" ` +
      'xmlns:d="http://schemas.microsoft.com/expression/blend/2008" ' +
      'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:local="using:SmokeFixture">\n' +
      '  <w:Grid xl:Name="Root" xl:Key="RootKey" />\n' +
      "  <xl:String />\n" +
      "  <d:DesignData mc:Ignorable=\"d\" />\n" +
      "  <local:Thing local:Prop=\"1\" />\n" +
      "</root>";
    const result = await getChecked(buffer, "custom prefixes");
    assert.deepStrictEqual(tokenShapes(result.tokens), tokensFromNeedles(buffer, [
      { needle: "<root", text: "root", type: "class" },
      { needle: "<w:Grid", text: "w", type: "namespace", defaultLibrary: true },
      { needle: "<w:Grid", text: "Grid", type: "class", defaultLibrary: true },
      { needle: "xl:Name", text: "xl", type: "namespace", defaultLibrary: true },
      { needle: "xl:Name", text: "Name", type: "property", defaultLibrary: true },
      { needle: "xl:Key", text: "xl", type: "namespace", defaultLibrary: true },
      { needle: "xl:Key", text: "Key", type: "property", defaultLibrary: true },
      { needle: "<xl:String", text: "xl", type: "namespace", defaultLibrary: true },
      { needle: "<xl:String", text: "String", type: "class", defaultLibrary: true },
      { needle: "<d:DesignData", text: "d", type: "namespace" },
      { needle: "<d:DesignData", text: "DesignData", type: "class" },
      { needle: "mc:Ignorable", text: "mc", type: "namespace" },
      { needle: "mc:Ignorable", text: "Ignorable", type: "property" },
      { needle: "<local:Thing", text: "local", type: "namespace" },
      { needle: "<local:Thing", text: "Thing", type: "class" },
      { needle: "local:Prop", text: "local", type: "namespace" },
      { needle: "local:Prop", text: "Prop", type: "property" },
      { needle: "</root>", text: "root", type: "class" },
    ]));
  });

  it("does not mark unprefixed attributes, attached-property attribute tokens, or property elements from the default xmlns", async () => {
    const buffer =
      `<Page xmlns="${PRESENTATION}" xmlns:x="${XAML}">\n` +
      '  <Grid Background="{StaticResource Accent}" Grid.Row="1">\n' +
      "    <Grid.RowDefinitions><RowDefinition /></Grid.RowDefinitions>\n" +
      "  </Grid>\n" +
      "</Page>";
    const result = await getChecked(buffer, "attributes and property elements");
    assert.deepStrictEqual(tokenShapes(result.tokens), tokensFromNeedles(buffer, [
      { needle: "<Page", text: "Page", type: "class", defaultLibrary: true },
      { needle: "<Grid", text: "Grid", type: "class", defaultLibrary: true },
      { needle: "Background", text: "Background", type: "property" },
      { needle: "{StaticResource Accent", text: "StaticResource", type: "macro", defaultLibrary: true },
      { needle: "Grid.Row", text: "Grid.Row", type: "property" },
      { needle: "<Grid.RowDefinitions", text: "Grid.RowDefinitions", type: "property" },
      { needle: "<RowDefinition", text: "RowDefinition", type: "class", defaultLibrary: true },
      { needle: "</Grid.RowDefinitions>", text: "Grid.RowDefinitions", type: "property" },
      { needle: "</Grid>", text: "Grid", type: "class", defaultLibrary: true },
      { needle: "</Page>", text: "Page", type: "class", defaultLibrary: true },
    ]));
  });

  it("marks only xmlns-scoped markup-extension type names while leaving named args unmodified", async () => {
    const buffer =
      `<Page xmlns="${PRESENTATION}" xmlns:x="${XAML}" xmlns:local="using:SmokeFixture">\n` +
      '  <Grid Background="{StaticResource Accent}" Tag="{Binding Source={StaticResource A}, ElementName=Root, Path=Title, Mode=OneWay}"\n' +
      '        ToolTip="{local:MyExt Value}" DataContext="{x:Bind ViewModel, Mode=OneWay}" />\n' +
      "</Page>";
    const result = await getChecked(buffer, "markup extension modifiers");
    assert.deepStrictEqual(tokenShapes(result.tokens), tokensFromNeedles(buffer, [
      { needle: "<Page", text: "Page", type: "class", defaultLibrary: true },
      { needle: "<Grid", text: "Grid", type: "class", defaultLibrary: true },
      { needle: "Background", text: "Background", type: "property" },
      { needle: "StaticResource Accent", text: "StaticResource", type: "macro", defaultLibrary: true },
      { needle: "Tag=", text: "Tag", type: "property" },
      { needle: "{Binding Source", text: "Binding", type: "macro", defaultLibrary: true },
      { needle: "Source={StaticResource", text: "Source", type: "parameter" },
      { needle: "{StaticResource A}", text: "StaticResource", type: "macro", defaultLibrary: true },
      { needle: "ElementName=Root", text: "ElementName", type: "parameter" },
      { needle: "Path=Title", text: "Path", type: "parameter" },
      { needle: "Mode=OneWay", text: "Mode", type: "parameter" },
      { needle: "ToolTip=", text: "ToolTip", type: "property" },
      { needle: "{local:MyExt", text: "local", type: "namespace" },
      { needle: "{local:MyExt", text: "MyExt", type: "macro" },
      { needle: "DataContext", text: "DataContext", type: "property" },
      { needle: "{x:Bind", text: "x", type: "namespace", defaultLibrary: true },
      { needle: "{x:Bind", text: "Bind", type: "macro", defaultLibrary: true },
      { needle: ", Mode=OneWay", text: "Mode", type: "parameter", occurrence: 1 },
      { needle: "</Page>", text: "Page", type: "class", defaultLibrary: true },
    ]));
  });

  it("marks nothing as defaultLibrary when no xmlns declaration resolves any prefix", async () => {
    const buffer = '<Grid x:Name="Root"><Button Content="{StaticResource K}" /></Grid>';
    const result = await getChecked(buffer, "no xmlns");
    assert.deepStrictEqual(tokenShapes(result.tokens), tokensFromNeedles(buffer, [
      { needle: "<Grid", text: "Grid", type: "class" },
      { needle: "x:Name", text: "x", type: "namespace" },
      { needle: "x:Name", text: "Name", type: "property" },
      { needle: "<Button", text: "Button", type: "class" },
      { needle: "Content", text: "Content", type: "property" },
      { needle: "{StaticResource", text: "StaticResource", type: "macro" },
      { needle: "</Grid>", text: "Grid", type: "class" },
    ]));
    assert.ok(result.tokens.every((t) => t.modifiers === 0), `no-xmlns buffer must have no defaultLibrary bits: ${dump(result.tokens)}`);
  });

  it("requires ordinal-exact framework URI matches for prefixes and default xmlns", async () => {
    const buffer =
      `<root xmlns:a="${PRESENTATION}/" xmlns:b="HTTP://schemas.microsoft.com/winfx/2006/xaml/presentation" ` +
      `xmlns:c="${PRESENTATION}x" xmlns:x2="${XAML}/" xmlns="${PRESENTATION}x">\n` +
      "  <a:Grid /><b:Button /><c:Border /><x2:Null />\n" +
      "  <Grid Background=\"{StaticResource K}\" />\n" +
      "</root>";
    const result = await getChecked(buffer, "exact URI matching");
    assert.deepStrictEqual(tokenShapes(result.tokens), tokensFromNeedles(buffer, [
      { needle: "<root", text: "root", type: "class" },
      { needle: "<a:Grid", text: "a", type: "namespace" },
      { needle: "<a:Grid", text: "Grid", type: "class" },
      { needle: "<b:Button", text: "b", type: "namespace" },
      { needle: "<b:Button", text: "Button", type: "class" },
      { needle: "<c:Border", text: "c", type: "namespace" },
      { needle: "<c:Border", text: "Border", type: "class" },
      { needle: "<x2:Null", text: "x2", type: "namespace" },
      { needle: "<x2:Null", text: "Null", type: "class" },
      { needle: "<Grid", text: "Grid", type: "class" },
      { needle: "Background", text: "Background", type: "property" },
      { needle: "{StaticResource", text: "StaticResource", type: "macro" },
      { needle: "</root>", text: "root", type: "class" },
    ]));
  });

  it("returns exactly the requested single line's overlapping tokens for range requests", async () => {
    const buffer =
      `<Page xmlns="${PRESENTATION}" xmlns:x="${XAML}">\n` +
      '  <Grid x:Name="Root">\n' +
      '    <Button Content="{Binding Path=Title}" />\n' +
      "  </Grid>\n" +
      "</Page>";
    const { ranged } = await assertRangeMatchesFull(buffer, { start: { line: 2, character: 0 }, end: { line: 3, character: 0 } }, "single line range");
    assert.deepStrictEqual(ranged.tokens.map((t) => t.text), ["Button", "Content", "Binding", "Path"]);
  });

  it("includes tokens partially overlapped by a range whose start and end are inside token text", async () => {
    const buffer =
      `<Page xmlns="${PRESENTATION}">\n` +
      '  <Button Content="{Binding Path=Title}" />\n' +
      "</Page>";
    const range = { start: { line: 1, character: 4 }, end: { line: 1, character: 26 } };
    const { ranged } = await assertRangeMatchesFull(buffer, range, "partial overlap range");
    assert.deepStrictEqual(ranged.tokens.map((t) => t.text), ["Button", "Content", "Binding"]);
  });

  it("treats range edges as half-open when they exactly touch token starts or ends", async () => {
    const buffer =
      `<Page xmlns="${PRESENTATION}">\n` +
      '  <Button Content="{Binding}" />\n' +
      "</Page>";
    const full = await getChecked(buffer, "edge setup");
    const button = full.tokens.find((t) => t.text === "Button");
    const content = full.tokens.find((t) => t.text === "Content");
    assert.ok(button && content, `expected Button and Content tokens: ${dump(full.tokens)}`);

    const endsAtButtonStart = await getRangeChecked(buffer, {
      start: { line: button.line, character: 0 },
      end: { line: button.line, character: button.character },
    }, "end at token start");
    assert.deepStrictEqual(endsAtButtonStart.tokens, [], "range ending exactly at a token start must exclude that token");

    const startsAtButtonEnd = await getRangeChecked(buffer, {
      start: { line: button.line, character: button.character + button.length },
      end: { line: content.line, character: content.character },
    }, "start at token end");
    assert.deepStrictEqual(startsAtButtonEnd.tokens, [], "range starting exactly at token end and ending at next token start must exclude both");
  });

  it("handles empty ranges in whitespace and exactly at token positions deterministically", async () => {
    const buffer =
      `<Page xmlns="${PRESENTATION}">\n` +
      "  <Grid />\n" +
      "</Page>";
    const whitespace = await getRangeChecked(buffer, { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, "empty whitespace range");
    assert.deepStrictEqual(whitespace.tokens, [], "empty whitespace range should produce no tokens");
    const onToken = await getRangeChecked(buffer, { start: { line: 1, character: 3 }, end: { line: 1, character: 3 } }, "empty on-token range");
    assert.deepStrictEqual(onToken.tokens, [], `empty range exactly on token must be empty under half-open overlap semantics: ${dump(onToken.tokens)}`);
  });

  it("returns a strict identical subset for multi-line ranges spanning several element lines", async () => {
    const buffer =
      `<Page xmlns="${PRESENTATION}" xmlns:x="${XAML}">\n` +
      '  <Grid x:Name="Root">\n' +
      '    <Button Content="{StaticResource K}" />\n' +
      '    <TextBlock Text="{Binding Path=Title}" />\n' +
      "  </Grid>\n" +
      "</Page>";
    const { ranged } = await assertRangeMatchesFull(buffer, { start: { line: 1, character: 2 }, end: { line: 4, character: 9 } }, "multi line range");
    assert.deepStrictEqual(ranged.tokens.map((t) => t.text), [
      "Grid", "x", "Name", "Button", "Content", "StaticResource", "TextBlock", "Text", "Binding", "Path", "Grid",
    ]);
  });

  it("handles out-of-bounds ranges without crashing and returns the same sensible subset as full-token filtering", async () => {
    const buffer =
      `<Page xmlns="${PRESENTATION}">\n` +
      "  <Grid />\n" +
      "</Page>";
    const beyond = await getRangeChecked(buffer, { start: { line: 99, character: 500 }, end: { line: 120, character: 999 } }, "range beyond EOF");
    assert.deepStrictEqual(beyond.tokens, [], "range wholly beyond EOF should be empty");

    const hugeEnd = await assertRangeMatchesFull(buffer, { start: { line: 1, character: 4 }, end: { line: 99, character: 999 } }, "range huge end");
    assert.deepStrictEqual(hugeEnd.ranged.tokens.map((t) => t.text), ["Grid", "Page"]);
  });

  it("is deterministic for repeated identical range requests", async () => {
    const buffer =
      `<Page xmlns="${PRESENTATION}" xmlns:x="${XAML}">\n` +
      '  <Grid x:Name="Root" Background="{StaticResource Accent}" />\n' +
      "</Page>";
    const range = { start: { line: 1, character: 2 }, end: { line: 1, character: 56 } };
    const first = await getRangeChecked(buffer, range, "range determinism first");
    const second = await getRangeChecked(buffer, range, "range determinism second");
    assert.deepStrictEqual(first, second, "range semantic token result must be byte-for-byte deterministic");
  });

  it("keeps range request invariants on malformed unterminated markup", async () => {
    const buffer =
      `<Page xmlns="${PRESENTATION}" xmlns:x="${XAML}">\n` +
      '  <Grid x:Name="Root"\n' +
      '  <Button Content="{Binding Source={StaticResource K}"\n' +
      "</Page>";
    const range = { start: { line: 1, character: 0 }, end: { line: 3, character: 7 } };
    const { ranged } = await assertRangeMatchesFull(buffer, range, "malformed range");
    assert.ok(ranged.tokens.some((t) => t.text === "Grid"), `malformed range should still expose stable Grid token: ${dump(ranged.tokens)}`);
  });
});
