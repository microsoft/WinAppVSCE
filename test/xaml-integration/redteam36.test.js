"use strict";

// Round 36 red-team probes for Format Document / Format Selection.
// These drive VS Code's real formatting providers and attack the safety contract:
// only leading indentation of safe structural lines may change; significant
// whitespace, malformed markup, wrapped attributes, CDATA, mixed content, and
// range boundaries must not be corrupted.

const assert = require("node:assert");
const vscode = require("vscode");
const h = require("./helper");

function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n${inner}\n</Page>`;
}

function stripLeadingWs(text) {
  return text.replace(/^[ \t]*/gm, "");
}

function sameExceptLeadingWs(a, b) {
  return stripLeadingWs(a) === stripLeadingWs(b);
}

function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function posToOffset(starts, textLen, line, character) {
  if (line >= starts.length) return textLen;
  return Math.min(starts[line] + character, textLen);
}

function lineText(text, line) {
  return text.split("\n")[line] ?? "";
}

function assertOnlyLeadingWhitespaceEdits(text, edits, label) {
  const seen = [];
  for (const edit of edits || []) {
    assert.strictEqual(edit.range.start.line, edit.range.end.line, `${label}: edit must stay on one line`);
    assert.match(edit.newText, /^[ \t]*$/, `${label}: edit newText must be only indentation`);

    const line = lineText(text, edit.range.start.line);
    const leading = (line.match(/^[ \t]*/) || [""])[0].length;
    assert.ok(
      edit.range.start.character <= leading &&
      edit.range.end.character <= leading,
      `${label}: edit range ${edit.range.start.line}:0-${edit.range.end.character} crosses non-leading whitespace in ${JSON.stringify(line)}`
    );
    assert.ok(
      edit.range.start.character <= edit.range.end.character,
      `${label}: edit range start must not be after end`
    );

    const key = `${edit.range.start.line}:${edit.range.start.character}-${edit.range.end.character}`;
    assert.ok(!seen.includes(key), `${label}: duplicate/overlapping edit ${key}`);
    seen.push(key);
  }
}

function applyEdits(text, edits) {
  const starts = lineStartsOf(text);
  const applied = (edits || [])
    .map((e) => ({
      start: posToOffset(starts, text.length, e.range.start.line, e.range.start.character),
      end: posToOffset(starts, text.length, e.range.end.line, e.range.end.character),
      newText: e.newText,
    }))
    .sort((a, b) => b.start - a.start);
  let out = text;
  let lastStart = text.length + 1;
  for (const e of applied) {
    assert.ok(e.end <= lastStart, `overlapping or unsorted edit at offsets ${e.start}-${e.end}`);
    out = out.slice(0, e.start) + e.newText + out.slice(e.end);
    lastStart = e.start;
  }
  return out;
}

async function rawDocumentEdits(text, options = { tabSize: 2, insertSpaces: true }) {
  await h.setBuffer(text);
  return (await vscode.commands.executeCommand(
    "vscode.executeFormatDocumentProvider",
    h.getDoc().uri,
    options
  )) || [];
}

async function rawRangeEdits(text, range, options = { tabSize: 2, insertSpaces: true }) {
  await h.setBuffer(text);
  return (await vscode.commands.executeCommand(
    "vscode.executeFormatRangeProvider",
    h.getDoc().uri,
    range,
    options
  )) || [];
}

async function assertSafeFormat(name, input, options = { tabSize: 2, insertSpaces: true }) {
  const edits = await rawDocumentEdits(input, options);
  assertOnlyLeadingWhitespaceEdits(input, edits, name);
  const formatted = applyEdits(input, edits);
  assert.ok(sameExceptLeadingWs(input, formatted), `${name}: non-indentation content changed\nINPUT:\n${input}\nACTUAL:\n${formatted}`);

  const second = await rawDocumentEdits(formatted, options);
  assertOnlyLeadingWhitespaceEdits(formatted, second, `${name} second pass`);
  assert.strictEqual(second.length, 0, `${name}: second format must be idempotent; got ${second.length} edits`);
  assert.strictEqual(applyEdits(formatted, second), formatted, `${name}: second format changed text`);
  return { formatted, editCount: edits.length };
}

async function assertExactFormat(name, input, expected, options = { tabSize: 2, insertSpaces: true }) {
  const { formatted } = await assertSafeFormat(name, input, options);
  assert.strictEqual(formatted, expected, `${name}: wrong formatted output\nINPUT:\n${input}\nACTUAL:\n${formatted}\nEXPECTED:\n${expected}`);
}

describe("WinUI XAML red-team 36 — format document/selection safety", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("leaves empty and whitespace-only documents byte-identical", async () => {
    for (const input of ["", "   \n\t \n"]) {
      const { formatted, editCount } = await assertSafeFormat("empty/whitespace-only", input);
      assert.strictEqual(editCount, 0, "non-XAML whitespace should not produce edits");
      assert.strictEqual(formatted, input, "whitespace-only document must be byte-identical");
    }
  });

  it("does not corrupt unterminated or malformed markup", async () => {
    for (const [name, input] of [
      ["unterminated open tag", "<Grid>\n                    <Button"],
      ["mismatched end tag", "<Grid>\n                    <Button />\n          </Wrong>"],
      ["stray less-than text", "<Grid>\n          <\n                    <Button />\n</Grid>"],
      ["space after less-than", "< Grid>\n                    <Button />\n</ Grid>"],
      ["attribute with no value", "<Grid>\n                    <Button Content />\n</Grid>"],
    ]) {
      await assertSafeFormat(name, input);
    }
  });

  it("preserves an unclosed attribute quote that spans lines", async () => {
    const input = "<Grid>\n                    <Button Content=\"line1\n      line2\n      <TextBlock />\n</Grid>";
    const { formatted } = await assertSafeFormat("unclosed attribute quote", input);
    assert.ok(formatted.includes("Content=\"line1\n      line2"), `attribute text changed:\n${formatted}`);
  });

  it("keeps xml:space preserve bodies byte-identical while allowing ancestor-safe open tags", async () => {
    const preserved = "<TextBlock xml:space=\"preserve\">\n\t  one\n    two\n\t\tthree\n      </TextBlock>";
    const input = page(`                    <StackPanel>\n        ${preserved}\n                    <Button />\n                    </StackPanel>`);
    const { formatted } = await assertSafeFormat("xml:space preserve", input);
    assert.ok(formatted.includes(preserved), `xml:space body/end-tag whitespace changed:\n${formatted}`);
  });

  it("does not reindent descendants of an xml:space preserve subtree", async () => {
    const preserved = "<StackPanel xml:space=\"preserve\">\n        <TextBlock Text=\"A\" />\n  <TextBlock Text=\"B\" />\n      </StackPanel>";
    const input = page(`                    <Grid>\n${preserved}\n                    </Grid>`);
    const { formatted } = await assertSafeFormat("xml:space subtree", input);
    assert.ok(formatted.includes(preserved), `xml:space subtree changed:\n${formatted}`);
  });

  it("preserves mixed inline text and embedded newline whitespace", async () => {
    const mixed = "<TextBlock>Hello  World\n   line two with   spaces\n\tline three</TextBlock>";
    const input = page(`                    <StackPanel>\n                    ${mixed}\n                    <Button />\n                    </StackPanel>`);
    const { formatted } = await assertSafeFormat("mixed text content", input);
    assert.ok(formatted.includes(mixed), `mixed text content changed:\n${formatted}`);
  });

  it("preserves adjacent inline Run content while formatting safe siblings", async () => {
    const runs = "<TextBlock><Run>a</Run><Run>  b  </Run></TextBlock>";
    const input = page(`                    <StackPanel>\n                    ${runs}\n                    <Button />\n                    </StackPanel>`);
    const { formatted } = await assertSafeFormat("inline runs", input);
    assert.ok(formatted.includes(runs), `inline Run content changed:\n${formatted}`);
  });

  it("preserves CDATA content byte-identically", async () => {
    const cdata = "<x><![CDATA[\n   raw <not> markup\n\t  keep me\n]]></x>";
    const input = page(`                    <Grid>\n                    ${cdata}\n                    <Button />\n                    </Grid>`);
    const { formatted } = await assertSafeFormat("CDATA", input);
    assert.ok(formatted.includes(cdata), `CDATA block changed:\n${formatted}`);
  });

  it("formats standalone comments but preserves inline and multi-line comment bodies", async () => {
    const input = page([
      "                    <Grid>",
      "                    <!-- standalone -->",
      "                    <Button /><!-- inline -->",
      "                    <!-- multi",
      "       inner stays put",
      "   -->",
      "                    </Grid>",
    ].join("\n"));
    const expected = page([
      "  <Grid>",
      "    <!-- standalone -->",
      "    <Button /><!-- inline -->",
      "    <!-- multi",
      "       inner stays put",
      "   -->",
      "  </Grid>",
    ].join("\n"));
    await assertExactFormat("comments", input, expected);
  });

  it("leaves XML declarations and processing instructions untouched", async () => {
    const input = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<?probe keep=\"yes\"?>\n                    <Page>\n                    <Grid />\n                    </Page>";
    const expected = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<?probe keep=\"yes\"?>\n<Page>\n  <Grid />\n</Page>";
    await assertExactFormat("processing instructions", input, expected);
  });

  it("does not reindent wrapped attribute continuation lines", async () => {
    const input = page([
      "                    <Grid>",
      "                    <Button",
      "        Content=\"x\"",
      "\tIsEnabled=\"True\"",
      "        />",
      "                    </Grid>",
    ].join("\n"));
    const expected = page([
      "  <Grid>",
      "    <Button",
      "        Content=\"x\"",
      "\tIsEnabled=\"True\"",
      "        />",
      "  </Grid>",
    ].join("\n"));
    await assertExactFormat("wrapped attributes", input, expected);
  });

  it("handles self-closing elements and property elements through deep nesting", async () => {
    const input = [
      "                    <Root>",
      "                    <A>",
      "                    <A.B>",
      "                    <C>",
      "                    <D>",
      "                    <E>",
      "                    <F>",
      "                    <G>",
      "                    <H>",
      "                    <I>",
      "                    <J />",
      "                    </I>",
      "                    </H>",
      "                    </G>",
      "                    </F>",
      "                    </E>",
      "                    </D>",
      "                    </C>",
      "                    </A.B>",
      "                    </A>",
      "                    </Root>",
    ].join("\n");
    const expected = [
      "<Root>",
      "  <A>",
      "    <A.B>",
      "      <C>",
      "        <D>",
      "          <E>",
      "            <F>",
      "              <G>",
      "                <H>",
      "                  <I>",
      "                    <J />",
      "                  </I>",
      "                </H>",
      "              </G>",
      "            </F>",
      "          </E>",
      "        </D>",
      "      </C>",
      "    </A.B>",
      "  </A>",
      "</Root>",
    ].join("\n");
    await assertExactFormat("deep property elements", input, expected);
  });

  it("converts tab indentation to spaces when insertSpaces is true", async () => {
    const input = "<Grid>\n\t\t<Button />\n\t</Grid>";
    const expected = "<Grid>\n    <Button />\n</Grid>";
    await assertExactFormat("tabs to spaces", input, expected, { tabSize: 4, insertSpaces: true });
  });

  it("converts spaces and mixed indentation to tabs when insertSpaces is false", async () => {
    const input = "<Grid>\n      <StackPanel>\n  \t   <Button />\n      </StackPanel>\n   </Grid>";
    const expected = "<Grid>\n\t<StackPanel>\n\t\t<Button />\n\t</StackPanel>\n</Grid>";
    await assertExactFormat("spaces to tabs", input, expected, { tabSize: 1, insertSpaces: false });
  });

  it("normalizes mixed tabs and spaces without touching trailing spaces", async () => {
    const input = "<Grid>  \n \t <StackPanel>  \n\t  <Button Content=\"x\" />  \n \t </StackPanel>  \n</Grid>  ";
    const expected = "<Grid>  \n  <StackPanel>  \n    <Button Content=\"x\" />  \n  </StackPanel>  \n</Grid>  ";
    await assertExactFormat("mixed indentation and trailing spaces", input, expected);
  });

  it("preserves leading/trailing blank lines and formats a single element tree", async () => {
    const input = "\n   \n                    <Grid>\n                    <Button />\n                    </Grid>\n\t\n";
    const expected = "\n   \n<Grid>\n  <Button />\n</Grid>\n\t\n";
    await assertExactFormat("blank lines around tree", input, expected);
  });

  it("formats an over-indented realistic page without changing non-indentation content", async () => {
    const input = page([
      "                    <Grid RowSpacing=\"8\" ColumnSpacing=\"12\">",
      "                    <Grid.RowDefinitions>",
      "                    <RowDefinition Height=\"Auto\" />",
      "                    <RowDefinition Height=\"*\" />",
      "                    </Grid.RowDefinitions>",
      "                    <Grid.ColumnDefinitions>",
      "                    <ColumnDefinition Width=\"2*\" />",
      "                    <ColumnDefinition Width=\"*\" />",
      "                    </Grid.ColumnDefinitions>",
      "                    <StackPanel Grid.Row=\"0\" Grid.ColumnSpan=\"2\" Orientation=\"Horizontal\">",
      "                    <Button Content=\"Save\" />",
      "                    <Button Content=\"Cancel\" />",
      "                    </StackPanel>",
      "                    <ListView Grid.Row=\"1\" ItemsSource=\"{x:Bind Items}\">",
      "                    <ListView.ItemTemplate>",
      "                    <DataTemplate>",
      "                    <StackPanel>",
      "                    <TextBlock Text=\"{Binding Title}\" />",
      "                    <TextBlock Text=\"{Binding Description}\" />",
      "                    </StackPanel>",
      "                    </DataTemplate>",
      "                    </ListView.ItemTemplate>",
      "                    </ListView>",
      "                    <Grid.Resources>",
      "                    <Style x:Key=\"PrimaryButtonStyle\" TargetType=\"Button\">",
      "                    <Setter Property=\"Padding\" Value=\"12,6\" />",
      "                    </Style>",
      "                    </Grid.Resources>",
      "                    </Grid>",
    ].join("\n"));
    const expected = page([
      "  <Grid RowSpacing=\"8\" ColumnSpacing=\"12\">",
      "    <Grid.RowDefinitions>",
      "      <RowDefinition Height=\"Auto\" />",
      "      <RowDefinition Height=\"*\" />",
      "    </Grid.RowDefinitions>",
      "    <Grid.ColumnDefinitions>",
      "      <ColumnDefinition Width=\"2*\" />",
      "      <ColumnDefinition Width=\"*\" />",
      "    </Grid.ColumnDefinitions>",
      "    <StackPanel Grid.Row=\"0\" Grid.ColumnSpan=\"2\" Orientation=\"Horizontal\">",
      "      <Button Content=\"Save\" />",
      "      <Button Content=\"Cancel\" />",
      "    </StackPanel>",
      "    <ListView Grid.Row=\"1\" ItemsSource=\"{x:Bind Items}\">",
      "      <ListView.ItemTemplate>",
      "        <DataTemplate>",
      "          <StackPanel>",
      "            <TextBlock Text=\"{Binding Title}\" />",
      "            <TextBlock Text=\"{Binding Description}\" />",
      "          </StackPanel>",
      "        </DataTemplate>",
      "      </ListView.ItemTemplate>",
      "    </ListView>",
      "    <Grid.Resources>",
      "      <Style x:Key=\"PrimaryButtonStyle\" TargetType=\"Button\">",
      "        <Setter Property=\"Padding\" Value=\"12,6\" />",
      "      </Style>",
      "    </Grid.Resources>",
      "  </Grid>",
    ].join("\n"));
    await assertExactFormat("realistic page", input, expected);
  });

  it("emits zero edits for an already-correctly-indented document", async () => {
    const input = page([
      "  <Grid>",
      "    <StackPanel>",
      "      <Button Content=\"OK\" />",
      "    </StackPanel>",
      "  </Grid>",
    ].join("\n"));
    const { formatted, editCount } = await assertSafeFormat("already formatted", input);
    assert.strictEqual(editCount, 0, "already formatted document should produce no edits");
    assert.strictEqual(formatted, input, "already formatted document should be unchanged");
  });

  it("range formatting only edits structural lines intersecting the requested range", async () => {
    const input = [
      "<Page>",
      "                    <Grid>",
      "                    <StackPanel>",
      "                    <Button />",
      "                    </StackPanel>",
      "                    </Grid>",
      "</Page>",
    ].join("\n");
    const range = new vscode.Range(new vscode.Position(2, 0), new vscode.Position(3, 100));
    const edits = await rawRangeEdits(input, range);
    assertOnlyLeadingWhitespaceEdits(input, edits, "range formatting");
    assert.deepStrictEqual(edits.map((e) => e.range.start.line), [2, 3], `range formatting edited wrong lines: ${JSON.stringify(edits)}`);
    const formatted = applyEdits(input, edits);
    const expected = [
      "<Page>",
      "                    <Grid>",
      "    <StackPanel>",
      "      <Button />",
      "                    </StackPanel>",
      "                    </Grid>",
      "</Page>",
    ].join("\n");
    assert.strictEqual(formatted, expected, `range formatting output mismatch\nACTUAL:\n${formatted}\nEXPECTED:\n${expected}`);
  });
});
