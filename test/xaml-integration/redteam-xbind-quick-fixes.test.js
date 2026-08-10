"use strict";

const assert = require("node:assert");
const vscode = require("vscode");
const h = require("./helper");

function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
}

const codeOf = (d) => (typeof d.code === "string" ? d.code : d.code && d.code.value);
const titles = (r) => JSON.stringify(r.actions.map((a) => a.title));
const changeActions = (r) => r.actions.filter((a) => a.kind === "quickfix" && /^Change /.test(a.title));

function findFix(r, title) {
  const fix = r.actions.find((a) => a.title === title && a.kind === "quickfix");
  assert.ok(fix, `expected ${JSON.stringify(title)} quickfix; got ${titles(r)} for ${JSON.stringify(r.diagnostic)}`);
  assert.ok(fix.edits[0], "the quickfix must carry a text edit");
  return fix;
}

function assertEdit(fix, text, newText) {
  const edit = fix.edits[0];
  assert.strictEqual(edit.text, text, `edit must replace exactly ${JSON.stringify(text)}`);
  assert.strictEqual(edit.newText, newText, `edit must insert exactly ${JSON.stringify(newText)}`);
}

function assertDiagnosticEdit(r, fix, text, newText) {
  const edit = fix.edits[0];
  const dr = r.diagnostic.range;
  assert.strictEqual(edit.line, dr.start.line, "edit start line must equal diagnostic start line");
  assert.strictEqual(edit.character, dr.start.character, "edit start character must equal diagnostic start character");
  assert.strictEqual(edit.endLine, dr.end.line, "edit end line must equal diagnostic end line");
  assert.strictEqual(edit.endCharacter, dr.end.character, "edit end character must equal diagnostic end character");
  assertEdit(fix, text, newText);
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

function assertNarrowedFirstSegmentEdit(r, fix, bad, good) {
  const edit = fix.edits[0];
  const dr = r.diagnostic.range;
  const span = h.getDoc().getText(new vscode.Range(dr.start.line, dr.start.character, dr.end.line, dr.end.character));
  const tokenOffset = span.indexOf(bad);
  assert.ok(tokenOffset >= 0, `wide diagnostic span ${JSON.stringify(span)} must contain bad token ${JSON.stringify(bad)}`);
  assert.strictEqual(edit.line, dr.start.line, "first-segment edit must stay on diagnostic line");
  assert.strictEqual(edit.character, dr.start.character + tokenOffset, "edit must start at the bad token inside the wide span");
  assert.strictEqual(edit.endLine, edit.line, "single-line x:Bind path edit expected");
  assert.strictEqual(edit.endCharacter, edit.character + bad.length, "edit must cover exactly the bad token");
  assertEdit(fix, bad, good);
}

async function assertNoWxaml0005(buffer, forbiddenText) {
  const diags = await h.diagnosticsFor(buffer, undefined, 2500);
  const hits = diags.filter((d) => codeOf(d) === "WXAML0005" && (!forbiddenText || h.getDoc().getText(d.range) === forbiddenText || (d.message || "").includes(forbiddenText)));
  assert.deepStrictEqual(hits.map((d) => `${h.getDoc().getText(d.range)}:${d.message}`), [], `expected no WXAML0005 for ${forbiddenText || "buffer"}`);
}

async function codeActionsAtOnly(buffer, matchCode, matchText, onlyKind) {
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

async function optionalWhitespaceNegationProbe() {
  const buffer = page('<TextBlock Text="{x:Bind ! GreetingTexx}" />');
  const diags = await h.diagnosticsFor(
    buffer,
    (ds) => ds.some((d) => codeOf(d) === "WXAML0005" && (h.getDoc().getText(d.range) === "! GreetingTexx" || h.getDoc().getText(d.range) === "GreetingTexx")),
    5000
  );
  const diag = diags.find((d) => codeOf(d) === "WXAML0005" && (h.getDoc().getText(d.range) === "! GreetingTexx" || h.getDoc().getText(d.range) === "GreetingTexx"));
  if (!diag) return { tolerated: false };
  const raw = await vscode.commands.executeCommand("vscode.executeCodeActionProvider", h.getDoc().uri, diag.range);
  const actions = (raw || []).filter((a) => a && a.title).map((a) => ({
    title: a.title,
    kind: a.kind && a.kind.value ? a.kind.value : undefined,
    isPreferred: a.isPreferred === true,
    edits: a.edit && typeof a.edit.entries === "function"
      ? Array.from(a.edit.entries()).flatMap(([, tes]) => tes.map((te) => ({
          line: te.range.start.line,
          character: te.range.start.character,
          endLine: te.range.end.line,
          endCharacter: te.range.end.character,
          newText: te.newText,
          text: h.getDoc().getText(te.range),
        })))
      : [],
  }));
  return { tolerated: true, diagnostic: { text: h.getDoc().getText(diag.range) }, actions };
}

describe("WinUI XAML — red-team 45 (x:Bind path quick fixes)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("single-segment misspelling offers a preferred narrow quickfix", async () => {
    const r = await h.codeActionsAt(page('<TextBlock Text="{x:Bind GreetingTexx}" />'), "WXAML0005", "GreetingTexx");
    const fix = findFix(r, "Change 'GreetingTexx' to 'GreetingText'");
    assert.strictEqual(fix.isPreferred, true, "top correction should be preferred");
    assertDiagnosticEdit(r, fix, "GreetingTexx", "GreetingText");
  });

  it("dotted first-segment misspelling narrows the edit and preserves the tail", async () => {
    const buffer = page('<TextBlock Text="{x:Bind GreetingTexx.Length}" />');
    const r = await h.codeActionsAt(buffer, "WXAML0005", "GreetingTexx.Length");
    const fix = findFix(r, "Change 'GreetingTexx' to 'GreetingText'");
    assertNarrowedFirstSegmentEdit(r, fix, "GreetingTexx", "GreetingText");
    const fixed = applySingleEdit(buffer, fix.edits[0]);
    assert.ok(fixed.includes("{x:Bind GreetingText.Length}"), fixed);
  });

  it("leading negation preserves the bang for a single-segment path", async () => {
    const buffer = page('<TextBlock Text="{x:Bind !GreetingTexx}" />');
    const r = await h.codeActionsAt(buffer, "WXAML0005", "!GreetingTexx");
    const fix = findFix(r, "Change 'GreetingTexx' to 'GreetingText'");
    assertNarrowedFirstSegmentEdit(r, fix, "GreetingTexx", "GreetingText");
    assert.ok(applySingleEdit(buffer, fix.edits[0]).includes("{x:Bind !GreetingText}"));
  });

  it("leading negation preserves both bang and dotted tail", async () => {
    const buffer = page('<TextBlock Text="{x:Bind !GreetingTexx.Length}" />');
    const r = await h.codeActionsAt(buffer, "WXAML0005", "!GreetingTexx.Length");
    const fix = findFix(r, "Change 'GreetingTexx' to 'GreetingText'");
    assertNarrowedFirstSegmentEdit(r, fix, "GreetingTexx", "GreetingText");
    assert.ok(applySingleEdit(buffer, fix.edits[0]).includes("{x:Bind !GreetingText.Length}"));
  });

  it("whitespace after negation either stays unsupported or fixes only the member token", async () => {
    const probe = await optionalWhitespaceNegationProbe();
    if (!probe.tolerated) return;
    const fix = probe.actions.find((a) => a.title === "Change 'GreetingTexx' to 'GreetingText'" && a.kind === "quickfix");
    assert.ok(fix, `negation-with-space diagnostic should carry the member fix; got ${JSON.stringify(probe.actions.map((a) => a.title))}`);
    assertEdit(fix, "GreetingTexx", "GreetingText");
  });

  it("non-first string segment uses a tight diagnostic/edit span", async () => {
    const buffer = page('<TextBlock Text="{x:Bind GreetingText.Lengthh}" />');
    const r = await h.codeActionsAt(buffer, "WXAML0005", "Lengthh");
    const fix = findFix(r, "Change 'Lengthh' to 'Length'");
    assertDiagnosticEdit(r, fix, "Lengthh", "Length");
    assert.ok(applySingleEdit(buffer, fix.edits[0]).includes("{x:Bind GreetingText.Length}"));
  });

  it("indexer element chain bad member uses a tight diagnostic/edit span", async () => {
    const buffer = page('<TextBlock Text="{x:Bind Items[0].Lengthh}" />');
    const r = await h.codeActionsAt(buffer, "WXAML0005", "Lengthh");
    const fix = findFix(r, "Change 'Lengthh' to 'Length'");
    assertDiagnosticEdit(r, fix, "Lengthh", "Length");
    assert.ok(applySingleEdit(buffer, fix.edits[0]).includes("{x:Bind Items[0].Length}"));
  });

  it("function-binding argument misspelling fixes only the argument", async () => {
    const buffer = page('<Button Click="{x:Bind OnGo_Click(GreetingTexx)}" />');
    const r = await h.codeActionsAt(buffer, "WXAML0005", "GreetingTexx");
    const fix = findFix(r, "Change 'GreetingTexx' to 'GreetingText'");
    assertDiagnosticEdit(r, fix, "GreetingTexx", "GreetingText");
    assert.ok(applySingleEdit(buffer, fix.edits[0]).includes("{x:Bind OnGo_Click(GreetingText)}"));
  });

  it("cast-prefix first-segment misspelling preserves the cast", async () => {
    const buffer = page('<TextBlock Text="{x:Bind (local:SmokePage)GreetingTexx}" />');
    const r = await h.codeActionsAt(buffer, "WXAML0005", "GreetingTexx");
    const fix = findFix(r, "Change 'GreetingTexx' to 'GreetingText'");
    assertDiagnosticEdit(r, fix, "GreetingTexx", "GreetingText");
    assert.ok(applySingleEdit(buffer, fix.edits[0]).includes("{x:Bind (local:SmokePage)GreetingText}"));
  });

  it("cast-prefix first-segment misspelling preserves a dotted tail", async () => {
    const buffer = page('<TextBlock Text="{x:Bind (local:SmokePage)GreetingTexx.Length}" />');
    const r = await h.codeActionsAt(buffer, "WXAML0005", "GreetingTexx");
    const fix = findFix(r, "Change 'GreetingTexx' to 'GreetingText'");
    assertDiagnosticEdit(r, fix, "GreetingTexx", "GreetingText");
    assert.ok(applySingleEdit(buffer, fix.edits[0]).includes("{x:Bind (local:SmokePage)GreetingText.Length}"));
  });

  it("cast-prefix valid first segment with bad second segment stays tight", async () => {
    const buffer = page('<TextBlock Text="{x:Bind (local:SmokePage)GreetingText.Lengthh}" />');
    const r = await h.codeActionsAt(buffer, "WXAML0005", "Lengthh");
    const fix = findFix(r, "Change 'Lengthh' to 'Length'");
    assertDiagnosticEdit(r, fix, "Lengthh", "Length");
  });

  it("DataTemplate x:String rerooting suggests String.Length", async () => {
    const buffer = page([
      "<ContentControl>",
      "  <ContentControl.ContentTemplate>",
      '    <DataTemplate x:DataType="x:String">',
      '      <TextBlock Text="{x:Bind Lenght}" />',
      "    </DataTemplate>",
      "  </ContentControl.ContentTemplate>",
      "</ContentControl>",
    ].join("\n"));
    const r = await h.codeActionsAt(buffer, "WXAML0005", "Lenght");
    const fix = findFix(r, "Change 'Lenght' to 'Length'");
    assert.strictEqual(fix.isPreferred, true, "String.Length correction should be preferred");
    assertDiagnosticEdit(r, fix, "Lenght", "Length");
  });

  it("casing-only x:Bind slip ranks first and preferred", async () => {
    const r = await h.codeActionsAt(page('<TextBlock Text="{x:Bind greetingtext}" />'), "WXAML0005", "greetingtext");
    const fixes = changeActions(r);
    assert.strictEqual(fixes[0] && fixes[0].title, "Change 'greetingtext' to 'GreetingText'", `case-only fix should be first; got ${titles(r)}`);
    assert.strictEqual(fixes[0].isPreferred, true, "case-only correction should be preferred");
  });

  it("far garbage is threshold-rejected while the diagnostic remains", async () => {
    const r = await h.codeActionsAt(page('<TextBlock Text="{x:Bind Zzzzzzzzzz}" />'), "WXAML0005", "Zzzzzzzzzz");
    assert.ok(r.diagnostic, "expected WXAML0005 diagnostic for far garbage");
    assert.deepStrictEqual(changeActions(r), [], `far garbage should not get Change fixes; got ${titles(r)}`);
  });

  it("caps suggestions at three and marks only the first as preferred", async () => {
    const r = await h.codeActionsAt(page('<TextBlock Text="{x:Bind GreetingTex}" />'), "WXAML0005", "GreetingTex");
    const fixes = changeActions(r);
    assert.ok(fixes.length >= 1, `expected at least one correction; got ${titles(r)}`);
    assert.ok(fixes.length <= 3, `expected at most three corrections; got ${titles(r)}`);
    assert.strictEqual(fixes.filter((a) => a.isPreferred).length, 1, `only the top suggestion should be preferred; got ${JSON.stringify(fixes)}`);
    assert.strictEqual(fixes[0].isPreferred, true, `first suggestion should be preferred; got ${JSON.stringify(fixes)}`);
  });

  it("repeated requests are deterministic for titles and edits", async () => {
    const buffer = page('<TextBlock Text="{x:Bind GreetingTexx.Length}" />');
    const shape = (a) => ({ title: a.title, preferred: a.isPreferred, edit: a.edits[0] });
    const first = changeActions(await h.codeActionsAt(buffer, "WXAML0005", "GreetingTexx.Length")).map(shape);
    const second = changeActions(await h.codeActionsAt(buffer, "WXAML0005", "GreetingTexx.Length")).map(shape);
    assert.deepStrictEqual(second, first);
  });

  it("does not duplicate the same Change quickfix on one diagnostic", async () => {
    const r = await h.codeActionsAt(page('<TextBlock Text="{x:Bind GreetingTexx}" />'), "WXAML0005", "GreetingTexx");
    const dupes = changeActions(r).filter((a) => a.title === "Change 'GreetingTexx' to 'GreetingText'");
    assert.strictEqual(dupes.length, 1, `expected exactly one matching Change fix; got ${JSON.stringify(changeActions(r))}`);
  });

  it("quickfix-only includes the bind fix and refactor-only excludes it", async () => {
    const buffer = page('<TextBlock Text="{x:Bind GreetingTexx}" />');
    const quick = await codeActionsAtOnly(buffer, "WXAML0005", "GreetingTexx", vscode.CodeActionKind.QuickFix);
    assert.ok(quick.some((a) => a.title === "Change 'GreetingTexx' to 'GreetingText'" && a.kind === "quickfix"), JSON.stringify(quick));
    const refactors = await codeActionsAtOnly(buffer, "WXAML0005", "GreetingTexx", vscode.CodeActionKind.Refactor);
    assert.ok(!refactors.some((a) => /^Change /.test(a.title)), JSON.stringify(refactors));
  });

  it("applying the representative fix removes WXAML0005 for that path", async () => {
    const buffer = page('<TextBlock Text="{x:Bind GreetingTexx.Length}" />');
    const r = await h.codeActionsAt(buffer, "WXAML0005", "GreetingTexx.Length");
    const fixed = applySingleEdit(buffer, findFix(r, "Change 'GreetingTexx' to 'GreetingText'").edits[0]);
    await assertNoWxaml0005(fixed, "GreetingTexx");
  });

  it("valid x:Bind first segment produces no WXAML0005 or Change fix", async () => {
    await assertNoWxaml0005(page('<TextBlock Text="{x:Bind GreetingText.Length}" />'), "GreetingText.Length");
  });

  it("multiple x:Bind typos each get their own non-crossed fix", async () => {
    const buffer = page([
      "<StackPanel>",
      '  <TextBlock Text="{x:Bind GreetingTexx}" />',
      '  <TextBlock Tag="{x:Bind Items[0].Lengthh}" />',
      "</StackPanel>",
    ].join("\n"));
    const root = await h.codeActionsAt(buffer, "WXAML0005", "GreetingTexx");
    assertEdit(findFix(root, "Change 'GreetingTexx' to 'GreetingText'"), "GreetingTexx", "GreetingText");
    const tail = await h.codeActionsAt(buffer, "WXAML0005", "Lengthh");
    assertEdit(findFix(tail, "Change 'Lengthh' to 'Length'"), "Lengthh", "Length");
  });
});
