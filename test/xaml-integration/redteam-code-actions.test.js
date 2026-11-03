"use strict";

const assert = require("node:assert");
const vscode = require("vscode");
const h = require("./helper");

function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
}

const titles = (r) => JSON.stringify(r.actions.map((a) => a.title));
const changeActions = (r) => r.actions.filter((a) => a.kind === "quickfix" && /^Change /.test(a.title));

function findFix(r, title) {
  const fix = r.actions.find((a) => a.title === title && a.kind === "quickfix");
  assert.ok(fix, `expected ${JSON.stringify(title)} quickfix; got ${titles(r)} for ${JSON.stringify(r.diagnostic)}`);
  assert.ok(fix.edits[0], "the quickfix must carry a text edit");
  return fix;
}

function assertExactDiagnosticEdit(r, fix, text, newText) {
  const edit = fix.edits[0];
  const dr = r.diagnostic.range;
  assert.strictEqual(edit.line, dr.start.line, "edit start line must equal diagnostic start line");
  assert.strictEqual(edit.character, dr.start.character, "edit start character must equal diagnostic start character");
  assert.strictEqual(edit.endLine, dr.end.line, "edit end line must equal diagnostic end line");
  assert.strictEqual(edit.endCharacter, dr.end.character, "edit end character must equal diagnostic end character");
  assert.strictEqual(edit.text, text, `edit must replace exactly ${text}`);
  assert.strictEqual(edit.newText, newText, `edit must insert exactly ${newText}`);
}

function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function offsetOf(starts, text, line, character) {
  const start = starts[line];
  assert.notStrictEqual(start, undefined, `line ${line} should exist in probe text`);
  return Math.min(start + character, text.length);
}

function applySingleEdit(text, edit) {
  const starts = lineStartsOf(text);
  const s = offsetOf(starts, text, edit.line, edit.character);
  const e = offsetOf(starts, text, edit.endLine, edit.endCharacter);
  return text.slice(0, s) + edit.newText + text.slice(e);
}

async function codeActionsAtOnly(buffer, matchCode, matchText, onlyKind) {
  const codeOf = (d) => (typeof d.code === "string" ? d.code : d.code && d.code.value);
  // Match flagged span text to reject stale diagnostics with the same code and message.
  const byToken = (d) => codeOf(d) === matchCode && !!matchText && h.getDoc().getText(d.range) === matchText;
  const byMessage = (d) => codeOf(d) === matchCode && (!matchText || (d.message || "").includes(matchText));
  const diags = await h.diagnosticsFor(buffer, (ds) => (matchText ? ds.some(byToken) : ds.some(byMessage)));
  const diag = diags.find(byToken) || diags.find(byMessage);
  assert.ok(diag, `expected diagnostic ${matchCode} containing ${matchText}`);
  const raw = await vscode.commands.executeCommand(
    "vscode.executeCodeActionProvider",
    h.getDoc().uri,
    diag.range,
    typeof onlyKind === "string" ? onlyKind : onlyKind.value
  );
  return (raw || []).filter((a) => a && a.title).map((a) => ({
    title: a.title,
    kind: a.kind && a.kind.value ? a.kind.value : undefined,
    isPreferred: a.isPreferred === true,
  }));
}

describe("WinUI XAML — redteam44 code actions", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("ranks common element misspellings as preferred fixes", async () => {
    for (const [bad, good] of [["TextBlok", "TextBlock"], ["Bordr", "Border"], ["stackpanel", "StackPanel"]]) {
      const r = await h.codeActionsAt(page(`<${bad} />`), "WXAML0002", bad);
      const fix = findFix(r, `Change '${bad}' to '${good}'`);
      assert.strictEqual(fix.isPreferred, true, `${good} should be the preferred correction for ${bad}`);
      assertExactDiagnosticEdit(r, fix, bad, good);
    }
  });

  it("does not offer a spelling fix for far-garbage unknown element names", async () => {
    const r = await h.codeActionsAt(page("<Zzzqqx />"), "WXAML0002", "Zzzqqx");
    assert.deepStrictEqual(changeActions(r), [], `far garbage should be threshold-rejected; got ${titles(r)}`);
  });

  it("prefers case-only corrections for attributes", async () => {
    const r = await h.codeActionsAt(page('<Button background="Red" />'), "WXAML0003", "background");
    const fix = findFix(r, "Change 'background' to 'Background'");
    assert.strictEqual(fix.isPreferred, true, "case-only Background correction should be preferred");
    assertExactDiagnosticEdit(r, fix, "background", "Background");
  });

  it("keeps attribute edits inside the flagged token despite neighboring syntax", async () => {
    const buffer = page('<Button    Contnt = "Save" Grid.Row="0" />');
    const r = await h.codeActionsAt(buffer, "WXAML0003", "Contnt");
    const fix = findFix(r, "Change 'Contnt' to 'Content'");
    assertExactDiagnosticEdit(r, fix, "Contnt", "Content");
    const fixed = applySingleEdit(buffer, fix.edits[0]);
    assert.ok(fixed.includes('<Button    Content = "Save" Grid.Row="0" />'), fixed);
  });

  it("edits only the reported occurrence when the bad spelling appears elsewhere", async () => {
    const buffer = page('<StackPanel><Buton /><TextBlock Text="Buton" /></StackPanel>');
    const r = await h.codeActionsAt(buffer, "WXAML0002", "Buton");
    const fix = findFix(r, "Change 'Buton' to 'Button'");
    assertExactDiagnosticEdit(r, fix, "Buton", "Button");
    const fixed = applySingleEdit(buffer, fix.edits[0]);
    assert.ok(fixed.includes("<Button />"), fixed);
    assert.ok(fixed.includes('Text="Buton"'), "the text literal occurrence must not be edited");
  });

  it("produces LF/CRLF-stable non-zero-line ranges that replace the exact element token", async () => {
    const buffer = page("\n\n    <Grid>\n      <Buton />\n    </Grid>");
    const r = await h.codeActionsAt(buffer, "WXAML0002", "Buton");
    const fix = findFix(r, "Change 'Buton' to 'Button'");
    assert.ok(r.diagnostic.range.start.line > 0, "probe should exercise a non-zero line");
    assert.ok(r.diagnostic.range.start.character > 0, "probe should exercise a non-zero column");
    assertExactDiagnosticEdit(r, fix, "Buton", "Button");
  });

  it("replaces only the member segment for attached-property attributes", async () => {
    const buffer = page('<Button Grid.Roww="0" />');
    const r = await h.codeActionsAt(buffer, "WXAML0004", "Roww");
    const fix = findFix(r, "Change 'Roww' to 'Row'");
    assertExactDiagnosticEdit(r, fix, "Roww", "Row");
    const fixed = applySingleEdit(buffer, fix.edits[0]);
    assert.ok(fixed.includes('Grid.Row="0"'), fixed);
    assert.ok(!fixed.includes("Grid.Roww"), fixed);
  });

  it("replaces only the member segment for property-element members", async () => {
    const buffer = page("<Grid>\n    <Grid.RowDefinitionz><RowDefinition /></Grid.RowDefinitionz>\n  </Grid>");
    const r = await h.codeActionsAt(buffer, "WXAML0006", "RowDefinitionz");
    const fix = findFix(r, "Change 'RowDefinitionz' to 'RowDefinitions'");
    assertExactDiagnosticEdit(r, fix, "RowDefinitionz", "RowDefinitions");
    const fixed = applySingleEdit(buffer, fix.edits[0]);
    assert.ok(fixed.includes("<Grid.RowDefinitions><RowDefinition />"), fixed);
  });

  it("replaces only the owner segment for unknown property-element owners", async () => {
    const buffer = page("<Grd.RowDefinitions><RowDefinition /></Grd.RowDefinitions>");
    const r = await h.codeActionsAt(buffer, "WXAML0002", "Grd");
    const fix = findFix(r, "Change 'Grd' to 'Grid'");
    assertExactDiagnosticEdit(r, fix, "Grd", "Grid");
    const fixed = applySingleEdit(buffer, fix.edits[0]);
    assert.ok(fixed.includes("<Grid.RowDefinitions><RowDefinition />"), fixed);
    assert.ok(fixed.includes("</Grd.RowDefinitions>"), "the edit should not widen into the closing tag");
  });

  it("does not leak Change fixes for event property-element syntax", async () => {
    const r = await h.codeActionsAt(page("<Button.Click>OnGo_Click</Button.Click>"), "WXAML0006", "Click");
    assert.deepStrictEqual(changeActions(r), [], `event property elements intentionally carry no suggestions; got ${titles(r)}`);
  });

  it("now offers a Change fix for x:Bind path member diagnostics (WXAML0005, shipped round 45)", async () => {
    const r = await h.codeActionsAt(page('<TextBlock Text="{x:Bind GreetingTexx}" />'), "WXAML0005", "GreetingTexx");
    assert.deepStrictEqual(
      changeActions(r).map((a) => a.title),
      ["Change 'GreetingTexx' to 'GreetingText'"],
      `WXAML0005 now carries a bindable-member spelling fix; got ${titles(r)}`
    );
  });

  it("honors VS Code's quickfix/refactor only filter", async () => {
    const buffer = page("<Buton />");
    const quick = await codeActionsAtOnly(buffer, "WXAML0002", "Buton", vscode.CodeActionKind.QuickFix);
    assert.ok(quick.some((a) => a.title === "Change 'Buton' to 'Button'" && a.kind === "quickfix"), JSON.stringify(quick));

    const refactors = await codeActionsAtOnly(buffer, "WXAML0002", "Buton", vscode.CodeActionKind.Refactor);
    assert.ok(!refactors.some((a) => a.title === "Change 'Buton' to 'Button'"), JSON.stringify(refactors));
  });

  it("is deterministic across repeated requests for the same diagnostic", async () => {
    const buffer = page("<Buton />");
    const first = changeActions(await h.codeActionsAt(buffer, "WXAML0002", "Buton")).map((a) => ({
      title: a.title,
      preferred: a.isPreferred,
      text: a.edits[0] && a.edits[0].text,
      newText: a.edits[0] && a.edits[0].newText,
    }));
    const second = changeActions(await h.codeActionsAt(buffer, "WXAML0002", "Buton")).map((a) => ({
      title: a.title,
      preferred: a.isPreferred,
      text: a.edits[0] && a.edits[0].text,
      newText: a.edits[0] && a.edits[0].newText,
    }));
    assert.deepStrictEqual(second, first);
  });

  it("the representative element fix removes the original diagnostic when applied", async () => {
    const buffer = page("<Buton />");
    const r = await h.codeActionsAt(buffer, "WXAML0002", "Buton");
    const fix = findFix(r, "Change 'Buton' to 'Button'");
    const fixed = applySingleEdit(buffer, fix.edits[0]);
    const diags = await h.diagnosticsFor(fixed, undefined, 2500);
    assert.ok(!diags.some((d) => (typeof d.code === "string" ? d.code : d.code && d.code.value) === "WXAML0002" && (d.message || "").includes("Buton")));
  });
});
