"use strict";

// Round 42 red-team probes for WinUI XAML rename.
// These exercise exact edit sets, symbol classification, validation, malformed input, and determinism.

const assert = require("node:assert");
const h = require("./helper");

function dump(value) {
  return JSON.stringify(value);
}

function clean(buffer) {
  return buffer.replace("|", "");
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

function tokenRangeInFragment(bufferWithCaret, fragment, token) {
  const text = clean(bufferWithCaret);
  const fragmentAt = text.indexOf(fragment);
  assert.ok(fragmentAt >= 0, `missing fragment ${fragment} in ${dump(text)}`);
  const tokenAt = text.indexOf(token, fragmentAt);
  assert.ok(tokenAt >= 0 && tokenAt < fragmentAt + fragment.length, `missing token ${token} in fragment ${fragment}`);
  const starts = lineStartsOf(text);
  const start = offsetToPos(starts, tokenAt);
  return { line: start.line, character: start.character, endCharacter: start.character + token.length };
}

function editShape(e) {
  return { line: e.line, character: e.character, endCharacter: e.endCharacter, text: e.text, newText: e.newText };
}

async function expectEdits(label, buffer, newName, expected) {
  const res = await h.renameAt(buffer, newName);
  assert.ok(!res.error, `${label}: rename should succeed; got ${dump(res)}`);
  assert.deepStrictEqual(
    res.edits.map(editShape),
    expected,
    `${label}: wrong edit set; got ${dump(res.edits)}`
  );
  return res.edits;
}

async function expectNotRenamed(label, buffer, newName = "Renamed") {
  const res = await h.renameAt(buffer, newName);
  if (!res.error && (res.edits || []).length !== 0) {
    assert.fail(`${label}: expected no rename; got ${dump(res)}`);
  }
  return res;
}

function ranges(buffer, token, fragments, newText) {
  return fragments.map((fragment) => ({ ...tokenRangeInFragment(buffer, fragment, token), text: token, newText }));
}

describe("WinUI XAML — red-team 42 (rename)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("renames every x:Name occurrence and ignores same-spelled literals, keys, and substrings", async () => {
    const buffer =
      "<Page>\n" +
      "  <Page.Resources>\n" +
      '    <SolidColorBrush x:Key="Root" Color="Red" />\n' +
      "  </Page.Resources>\n" +
      '  <Grid x:Name="Ro|ot" Tag="Root">\n' +
      '    <TextBox Text="{Binding ElementName=Root}" />\n' +
      '    <TextBlock Text="{Binding Source={Binding ElementName=Root}, Path=Text}" />\n' +
      '    <DoubleAnimation Storyboard.TargetName="Root" To="1" />\n' +
      '    <Border x:Name="Root2" Tag="RootBar" />\n' +
      "  </Grid>\n" +
      "</Page>";
    await expectEdits("x:Name completeness/precision", buffer, "Panel", ranges(buffer, "Root", [
      'x:Name="Root"',
      "ElementName=Root}",
      "ElementName=Root}, Path",
      'Storyboard.TargetName="Root"',
    ], "Panel"));
  });

  it("renames the same x:Name set when invoked from an ElementName usage", async () => {
    const buffer =
      '<Grid x:Name="Root">\n' +
      '  <TextBox Text="{Binding ElementName=Ro|ot}" />\n' +
      '  <DoubleAnimation Storyboard.TargetName="Root" />\n' +
      "</Grid>";
    await expectEdits("usage caret x:Name", buffer, "Panel", ranges(buffer, "Root", [
      'x:Name="Root"',
      "ElementName=Root}",
      'Storyboard.TargetName="Root"',
    ], "Panel"));
  });

  it("renames a bare Name declaration like x:Name", async () => {
    const buffer =
      '<StackPanel Name="Ro|ot">\n' +
      '  <TextBox Text="{Binding ElementName=Root}" />\n' +
      "</StackPanel>";
    await expectEdits("bare Name", buffer, "Panel", ranges(buffer, "Root", [
      'Name="Root"',
      "ElementName=Root}",
    ], "Panel"));
  });

  it("does not rename d:Name or other-prefixed Name declarations", async () => {
    await expectNotRenamed("d:Name is design-time only", '<Grid d:Name="Ro|ot" />');
    await expectNotRenamed("local:Name is not x:Name", '<Grid local:Name="Ro|ot" />');
  });

  it("renames all x:Key resource occurrences including nested resource extensions", async () => {
    const buffer =
      "<Page>\n" +
      "  <Page.Resources>\n" +
      '    <SolidColorBrush x:Key="Ac|cent" Color="Red" />\n' +
      "  </Page.Resources>\n" +
      '  <Grid x:Name="Accent" Tag="Accent" Background="{StaticResource Accent}">\n' +
      '    <Border BorderBrush="{ThemeResource Accent}" />\n' +
      '    <TextBlock Foreground="{CustomResource Accent}" />\n' +
      '    <ContentControl Content="{Binding Source={StaticResource Accent}}" />\n' +
      "  </Grid>\n" +
      "</Page>";
    await expectEdits("x:Key completeness/precision", buffer, "Brand", ranges(buffer, "Accent", [
      'x:Key="Accent"',
      "StaticResource Accent}",
      "ThemeResource Accent}",
      "CustomResource Accent}",
      "StaticResource Accent}}",
    ], "Brand"));
  });

  it("renames the same x:Key set when invoked from a resource usage", async () => {
    const buffer =
      "<Page>\n" +
      "  <Page.Resources>\n" +
      '    <SolidColorBrush x:Key="Accent" Color="Red" />\n' +
      "  </Page.Resources>\n" +
      '  <Grid Background="{StaticResource Ac|cent}" />\n' +
      '  <Border BorderBrush="{ThemeResource Accent}" />\n' +
      "</Page>";
    await expectEdits("resource usage caret", buffer, "Brand", ranges(buffer, "Accent", [
      'x:Key="Accent"',
      "StaticResource Accent}",
      "ThemeResource Accent}",
    ], "Brand"));
  });

  it("does not treat prefixed resource extensions, Key, or local:Key as x:Key symbols", async () => {
    await expectNotRenamed("prefixed StaticResource is out of scope",
      '<Page><Page.Resources><SolidColorBrush x:Key="Accent" /></Page.Resources><Grid Background="{local:StaticResource Ac|cent}" /></Page>');
    await expectNotRenamed("bare Key is not x:Key", '<SolidColorBrush Key="Ac|cent" />');
    await expectNotRenamed("local:Key is not x:Key", '<SolidColorBrush local:Key="Ac|cent" />');
  });

  it("accepts carets at the start, middle, and end of the token", async () => {
    for (const [label, buffer] of [
      ["start", '<Grid x:Name="|Root"><TextBox Text="{Binding ElementName=Root}" /></Grid>'],
      ["middle", '<Grid x:Name="Ro|ot"><TextBox Text="{Binding ElementName=Root}" /></Grid>'],
      ["end", '<Grid x:Name="Root|"><TextBox Text="{Binding ElementName=Root}" /></Grid>'],
    ]) {
      const res = await h.renameAt(buffer, "Panel");
      assert.ok(!res.error, `${label}: rename should succeed; got ${dump(res)}`);
      assert.strictEqual(res.edits.length, 2, `${label}: expected decl + usage; got ${dump(res.edits)}`);
      assert.ok(res.edits.every((e) => e.text === "Root" && e.newText === "Panel"), `${label}: got ${dump(res.edits)}`);
    }
  });

  it("does not rename from carets on the quote or equals sign", async () => {
    await expectNotRenamed("opening quote outside name", '<Grid x:Name=|"Root" />');
    await expectNotRenamed("equals sign outside name", '<Grid x:Name|="Root" />');
  });

  // Round-42 caret precision (was a skipped defect repro). Two genuine bugs were fixed in the shared
  // occurrence engine: (1) a padded attribute value like x:Name="Root " produced an edit/highlight range
  // that swallowed the surrounding whitespace, and (2) rename did not re-check caret containment, so a
  // direct invocation (which skips prepareRename) could rename from out in the padding. Correct contract:
  // a caret at the token's END boundary renames (VS Code between-characters), but the range covers only the
  // identifier; a caret past the token, out in the padding, is not renameable.
  it("keeps rename ranges off surrounding whitespace and rejects carets out in the padding", async () => {
    // Caret at the end boundary of a padded declaration value: renames decl + usage, tokens only.
    const boundary = await h.renameAt('<Grid x:Name="Root| "><TextBox Text="{Binding ElementName=Root}" /></Grid>', "Panel");
    assert.ok(!boundary.error, `end-boundary rename should succeed; got ${dump(boundary)}`);
    assert.strictEqual(boundary.edits.length, 2, `expected decl + usage; got ${dump(boundary.edits)}`);
    assert.ok(boundary.edits.every((e) => e.text === "Root" && e.newText === "Panel"),
      `edits must cover the token only, never the padding; got ${dump(boundary.edits)}`);

    // Leading + trailing padding on the declaration: still trimmed to the exact token.
    const padded = await h.renameAt('<Grid x:Name=" Ro|ot "><TextBox Text="{Binding ElementName=Root}" /></Grid>', "Panel");
    assert.ok(!padded.error, `padded rename should succeed; got ${dump(padded)}`);
    assert.strictEqual(padded.edits.length, 2, `expected decl + usage; got ${dump(padded.edits)}`);
    assert.ok(padded.edits.every((e) => e.text === "Root"),
      `edits must cover the trimmed token; got ${dump(padded.edits)}`);

    // Caret out in the trailing whitespace, past the token: not renameable.
    await expectNotRenamed("caret past the token in trailing padding", '<Grid x:Name="Root |" />');
  });

  it("trims surrounding whitespace from a valid x:Name new name", async () => {
    const buffer = '<Grid x:Name="Ro|ot"><TextBox Text="{Binding ElementName=Root}" /></Grid>';
    const res = await h.renameAt(buffer, "  _Panel42  ");
    assert.ok(!res.error, `trimmed valid identifier should succeed; got ${dump(res)}`);
    assert.strictEqual(res.edits.length, 2, `expected decl + usage; got ${dump(res.edits)}`);
    assert.ok(res.edits.every((e) => e.newText === "_Panel42" && e.text === "Root"), `got ${dump(res.edits)}`);
  });

  it("rejects invalid x:Name new names", async () => {
    for (const bad of ["", "   ", "1Bad", "My Panel", "Panel!", "local:Panel", "Panel.Child"]) {
      const res = await h.renameAt('<Grid x:Name="Ro|ot" />', bad);
      assert.ok(res.error || (res.edits || []).length === 0, `x:Name ${dump(bad)} must be rejected; got ${dump(res)}`);
    }
  });

  it("rejects x:Key names that would break XML or markup extensions", async () => {
    for (const bad of ["", "   ", 'Bad"Key', "Bad'Key", "Bad<Key", "Bad>Key", "Bad&Key", "Bad{Key", "Bad}Key"]) {
      const res = await h.renameAt('<SolidColorBrush x:Key="Ac|cent" />', bad);
      assert.ok(res.error || (res.edits || []).length === 0, `x:Key ${dump(bad)} must be rejected; got ${dump(res)}`);
    }
  });

  it("allows permissive x:Key names with dots, hyphens, digits, and internal spaces", async () => {
    const buffer =
      '<Page><Page.Resources><SolidColorBrush x:Key="Ac|cent" /></Page.Resources>' +
      '<Grid Background="{StaticResource Accent}" /></Page>';
    const res = await h.renameAt(buffer, "Brand.Key-1 2");
    assert.ok(!res.error, `permissive key should succeed; got ${dump(res)}`);
    assert.strictEqual(res.edits.length, 2, `expected key decl + usage; got ${dump(res.edits)}`);
    assert.ok(res.edits.every((e) => e.newText === "Brand.Key-1 2" && e.text === "Accent"), `got ${dump(res.edits)}`);
  });

  it("pins same-name rename behavior as edits that replace the token with itself", async () => {
    const buffer = '<Grid x:Name="Ro|ot"><TextBox Text="{Binding ElementName=Root}" /></Grid>';
    const res = await h.renameAt(buffer, "Root");
    assert.ok(!res.error, `same-name rename should not reject; got ${dump(res)}`);
    assert.strictEqual(res.edits.length, 2, `expected self-replacement edits for decl + usage; got ${dump(res.edits)}`);
    assert.ok(res.edits.every((e) => e.text === "Root" && e.newText === "Root"), `got ${dump(res.edits)}`);
  });

  it("stays silent inside an unterminated markup extension instead of inventing resource edits", async () => {
    await expectNotRenamed("unterminated StaticResource", '<Grid Background="{StaticResource Ac|cent" />', "Brand");
  });

  it("does not crash on malformed unclosed tags and only accepts well-resolved symbols", async () => {
    const res = await h.renameAt('<Grid x:Name="Ro|ot">\n  <TextBox Text="{Binding ElementName=Root}"', "Panel");
    assert.ok(!res.error || /rename/i.test(res.error) || /not/i.test(res.error), `malformed input should return cleanly; got ${dump(res)}`);
    if (res.edits) {
      assert.ok(res.edits.every((e) => e.text === "Root" && e.newText === "Panel"), `malformed input must not corrupt ranges; got ${dump(res.edits)}`);
    }
  });

  it("is deterministic for repeated identical rename requests", async () => {
    const buffer =
      '<Grid x:Name="Ro|ot">\n' +
      '  <TextBox Text="{Binding ElementName=Root}" />\n' +
      '  <DoubleAnimation Storyboard.TargetName="Root" />\n' +
      "</Grid>";
    const first = await h.renameAt(buffer, "Panel");
    const second = await h.renameAt(buffer, "Panel");
    assert.ok(!first.error && !second.error, `both runs should succeed; got ${dump({ first, second })}`);
    assert.deepStrictEqual(first.edits.map(editShape), second.edits.map(editShape), `edit set must be deterministic`);
  });

  it("renames duplicate same-named x:Name declarations and their usages consistently", async () => {
    const buffer =
      '<StackPanel>\n' +
      '  <Grid x:Name="Ro|ot" />\n' +
      '  <Border x:Name="Root" />\n' +
      '  <TextBox Text="{Binding ElementName=Root}" />\n' +
      "</StackPanel>";
    await expectEdits("duplicate names", buffer, "Panel", ranges(buffer, "Root", [
      'x:Name="Root" />',
      'x:Name="Root" />\n  <TextBox',
      "ElementName=Root}",
    ], "Panel"));
  });
});
