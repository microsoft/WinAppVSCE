"use strict";

// WXAML0001 "Add xmlns:…" quick fixes. Most probes avoid h.NS because it already declares x, d, and mc.

const assert = require("node:assert");
const vscode = require("vscode");
const h = require("./helper");

const URI = {
  x: "http://schemas.microsoft.com/winfx/2006/xaml",
  d: "http://schemas.microsoft.com/expression/blend/2008",
  mc: "http://schemas.openxmlformats.org/markup-compatibility/2006",
};

const defaultNS = 'xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"';
const xNS = `xmlns:x="${URI.x}"`;
const dNS = `xmlns:d="${URI.d}"`;
const mcNS = `xmlns:mc="${URI.mc}"`;
const minimalWithX = `${defaultNS} ${xNS}`;

function dump(value) {
  return JSON.stringify(value);
}

function titles(r) {
  return r.actions.map((a) => a.title);
}

function addXmlnsActions(r) {
  return r.actions.filter((a) => /^Add xmlns:/.test(a.title));
}

function changeActions(r) {
  return r.actions.filter((a) => /^Change /.test(a.title));
}

function findAddXmlnsFix(r, prefix) {
  const title = `Add xmlns:${prefix} declaration`;
  const fix = r.actions.find((a) => a.title === title && a.kind === "quickfix");
  assert.ok(fix, `expected ${dump(title)} quickfix; diag=${dump(r.diagnostic)} actions=${dump(titles(r))}`);
  assert.strictEqual(fix.kind, "quickfix", `${title} kind`);
  assert.strictEqual(fix.isPreferred, true, `${title} should be preferred`);
  assert.strictEqual(fix.edits.length, 1, `${title} should have exactly one edit`);
  assert.match(
    fix.edits[0].newText,
    new RegExp(`^\\s+xmlns:${prefix}="${URI[prefix]}"$`),
    `${title} inserted URI`
  );
  assertZeroWidth(fix.edits[0], `${title} edit`);
  return fix;
}

function assertZeroWidth(edit, label) {
  assert.strictEqual(edit.line, edit.endLine, `${label}: insertion start/end line`);
  assert.strictEqual(edit.character, edit.endCharacter, `${label}: insertion start/end character`);
  assert.strictEqual(edit.text, "", `${label}: insertion must not replace existing text`);
}

function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function offsetOf(starts, text, line, character) {
  assert.ok(line < starts.length, `line ${line} should exist in ${dump(text)}`);
  return Math.min(starts[line] + character, text.length);
}

function positionAt(text, offset) {
  const before = text.slice(0, offset);
  const line = (before.match(/\n/g) || []).length;
  const lastNl = before.lastIndexOf("\n");
  return { line, character: before.length - lastNl - 1 };
}

function applySingleEdit(text, edit) {
  const starts = lineStartsOf(text);
  const start = offsetOf(starts, text, edit.line, edit.character);
  const end = offsetOf(starts, text, edit.endLine, edit.endCharacter);
  return text.slice(0, start) + edit.newText + text.slice(end);
}

function assertEditAtOffset(buffer, edit, expectedOffset, label) {
  const expected = positionAt(buffer, expectedOffset);
  assert.strictEqual(edit.line, expected.line, `${label}: line`);
  assert.strictEqual(edit.character, expected.character, `${label}: character`);
}

function codeString(code) {
  return code == null ? "" : typeof code === "object" && "value" in code ? String(code.value) : String(code);
}

async function diagnosticsAfterSettling(buffer, timeoutMs = 2000) {
  return h.diagnosticsFor(buffer, undefined, timeoutMs);
}

async function assertNoWxaml0001(buffer, label) {
  const ds = await diagnosticsAfterSettling(buffer);
  const wx = ds.filter((d) => codeString(d.code) === "WXAML0001");
  assert.deepStrictEqual(
    wx.map((d) => ({ message: d.message, text: h.getDoc().getText(d.range) })),
    [],
    `${label}: expected no WXAML0001 diagnostics`
  );
}

async function fullDocumentActions(buffer, waitCode, waitText) {
  const ds = await h.diagnosticsFor(
    buffer,
    (diags) => diags.some((d) => codeString(d.code) === waitCode && h.getDoc().getText(d.range) === waitText)
  );
  assert.ok(ds.some((d) => codeString(d.code) === waitCode && h.getDoc().getText(d.range) === waitText), "expected probe diagnostic");
  const doc = h.getDoc();
  const raw = await vscode.commands.executeCommand(
    "vscode.executeCodeActionProvider",
    doc.uri,
    new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length))
  );
  return (raw || []).filter((a) => a && a.title).map((a) => ({
    title: a.title,
    kind: a.kind && a.kind.value ? a.kind.value : undefined,
    isPreferred: a.isPreferred === true,
  }));
}

async function directActionsAfterSettling(buffer) {
  await diagnosticsAfterSettling(buffer, 1000);
  const doc = h.getDoc();
  const raw = await vscode.commands.executeCommand(
    "vscode.executeCodeActionProvider",
    doc.uri,
    new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length))
  );
  return (raw || []).filter((a) => a && a.title).map((a) => a.title);
}

describe("WinUI XAML — red-team 48 (Add xmlns quick fix)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("offers the exact x namespace fix for an undeclared x element prefix", async () => {
    const buffer = `<Page ${defaultNS}>\n  <x:String>Hi</x:String>\n</Page>`;
    const r = await h.codeActionsAt(buffer, "WXAML0001", "x");
    findAddXmlnsFix(r, "x");
    assert.strictEqual(h.getDoc().getText(new vscode.Range(r.diagnostic.range.start.line, r.diagnostic.range.start.character, r.diagnostic.range.end.line, r.diagnostic.range.end.character)), "x");
  });

  it("offers the exact d namespace fix for an undeclared d element prefix", async () => {
    const buffer = `<Page ${minimalWithX}>\n  <d:Foo />\n</Page>`;
    findAddXmlnsFix(await h.codeActionsAt(buffer, "WXAML0001", "d"), "d");
  });

  it("offers the exact mc namespace fix for an undeclared mc attribute prefix", async () => {
    const buffer = `<Page ${defaultNS} ${xNS} mc:Ignorable="d">\n  <Grid />\n</Page>`;
    findAddXmlnsFix(await h.codeActionsAt(buffer, "WXAML0001", "mc"), "mc");
  });

  it("inserts after the last root xmlns and before non-xmlns root attributes", async () => {
    const buffer = `<Page ${defaultNS} ${xNS} Tag="keep" d:IsHidden="True">\n  <Grid />\n</Page>`;
    const r = await h.codeActionsAt(buffer, "WXAML0001", "d");
    const edit = findAddXmlnsFix(r, "d").edits[0];
    assert.strictEqual(edit.newText, ` xmlns:d="${URI.d}"`);
    assertEditAtOffset(buffer, edit, buffer.indexOf(xNS) + xNS.length, "insertion after last xmlns");
    const fixed = applySingleEdit(buffer, edit).replaceAll("\r\n", "\n");
    assert.ok(fixed.includes(`${xNS} xmlns:d="${URI.d}" Tag="keep"`), fixed);
  });

  it("inserts on a wrapped root after the final multi-line xmlns declaration", async () => {
    const buffer = `<Page\n  ${defaultNS}\n  Tag="keep"\n  ${xNS}\n  d:IsHidden="True">\n  <Grid />\n</Page>`;
    const r = await h.codeActionsAt(buffer, "WXAML0001", "d");
    const edit = findAddXmlnsFix(r, "d").edits[0];
    assert.strictEqual(edit.newText.replaceAll("\r\n", "\n"), `\n  xmlns:d="${URI.d}"`);
    assertEditAtOffset(buffer, edit, buffer.indexOf(xNS) + xNS.length, "wrapped insertion after x xmlns");
    const fixed = applySingleEdit(buffer, edit).replaceAll("\r\n", "\n");
    assert.ok(fixed.includes(`${xNS}\n  xmlns:d="${URI.d}"\n  d:IsHidden`), fixed);
  });

  it("inserts after the root element name when the root has no xmlns declarations", async () => {
    const buffer = `<Page d:IsHidden="True">\n  <Grid />\n</Page>`;
    const r = await h.codeActionsAt(buffer, "WXAML0001", "d");
    const edit = findAddXmlnsFix(r, "d").edits[0];
    assertEditAtOffset(buffer, edit, "<Page".length, "insertion after root name");
    assert.ok(applySingleEdit(buffer, edit).startsWith(`<Page xmlns:d="${URI.d}" d:IsHidden`));
  });

  it("offers the d fix when the undeclared prefix is used only on a child attribute", async () => {
    const buffer = `<Page ${minimalWithX}>\n  <Grid d:IsHidden="True" />\n</Page>`;
    const r = await h.codeActionsAt(buffer, "WXAML0001", "d");
    assert.strictEqual(h.getDoc().getText(new vscode.Range(r.diagnostic.range.start.line, r.diagnostic.range.start.character, r.diagnostic.range.end.line, r.diagnostic.range.end.character)), "d");
    findAddXmlnsFix(r, "d");
  });

  it("offers the d fix when the undeclared prefix is on the root element itself", async () => {
    const buffer = `<d:Page ${defaultNS} ${xNS}>\n  <Grid />\n</d:Page>`;
    const r = await h.codeActionsAt(buffer, "WXAML0001", "d");
    const edit = findAddXmlnsFix(r, "d").edits[0];
    assertEditAtOffset(buffer, edit, buffer.indexOf(xNS) + xNS.length, "root-prefixed insertion after existing xmlns declarations");
    assert.ok(applySingleEdit(buffer, edit).startsWith(`<d:Page ${defaultNS} ${xNS} xmlns:d="${URI.d}"`));
  });

  it("offers the d fix when the undeclared prefix is on a root attribute", async () => {
    const buffer = `<Page ${defaultNS} ${xNS} d:DataContext="{x:Null}">\n  <Grid />\n</Page>`;
    findAddXmlnsFix(await h.codeActionsAt(buffer, "WXAML0001", "d"), "d");
  });

  for (const prefix of ["local", "zzz", "blend"]) {
    it(`does not offer Add xmlns or Change actions for custom prefix ${prefix}`, async () => {
      const buffer = `<Page ${minimalWithX}>\n  <${prefix}:Widget />\n</Page>`;
      const r = await h.codeActionsAt(buffer, "WXAML0001", prefix);
      assert.deepStrictEqual(addXmlnsActions(r), [], `${prefix}: Add xmlns actions ${dump(titles(r))}`);
      assert.deepStrictEqual(changeActions(r), [], `${prefix}: Change actions ${dump(titles(r))}`);
    });
  }

  it("does not report WXAML0001 for reserved xml or xmlns prefixes", async () => {
    const buffer = `<Page ${minimalWithX} xml:lang="en-US" xmlns:foo="using:SmokeFixture">\n  <Grid />\n</Page>`;
    await assertNoWxaml0001(buffer, "reserved prefixes");
  });

  it("dedupes repeated undeclared d uses to one Add xmlns:d action in a full-document request", async () => {
    const buffer = `<Page ${minimalWithX}>\n  <d:Foo />\n  <Grid d:IsHidden="True" />\n  <d:Bar />\n</Page>`;
    const actions = await fullDocumentActions(buffer, "WXAML0001", "d");
    assert.deepStrictEqual(actions.filter((a) => a.title === "Add xmlns:d declaration").map((a) => a.title), ["Add xmlns:d declaration"], dump(actions));
  });

  it("offers independent fixes for multiple different undeclared well-known prefixes", async () => {
    const buffer = `<Page ${minimalWithX} mc:Ignorable="d">\n  <d:Foo />\n</Page>`;
    const dFix = findAddXmlnsFix(await h.codeActionsAt(buffer, "WXAML0001", "d"), "d");
    const mcFix = findAddXmlnsFix(await h.codeActionsAt(buffer, "WXAML0001", "mc"), "mc");
    assert.notStrictEqual(dFix.edits[0].newText, mcFix.edits[0].newText);
  });

  it("applied d edit is a pure insertion that clears the original undeclared-prefix diagnostic", async () => {
    const buffer = `<Page ${minimalWithX}>\n  <Grid d:IsHidden="True" />\n</Page>`;
    const r = await h.codeActionsAt(buffer, "WXAML0001", "d");
    const fixed = applySingleEdit(buffer, findAddXmlnsFix(r, "d").edits[0]);
    assert.ok(fixed.includes(` xmlns:d="${URI.d}"`), fixed);
    const ds = await diagnosticsAfterSettling(fixed, 2500);
    assert.ok(
      !ds.some((d) => codeString(d.code) === "WXAML0001" && h.getDoc().getText(d.range) === "d"),
      `expected d WXAML0001 to clear after edit; diagnostics=${dump(ds.map((d) => ({ code: codeString(d.code), message: d.message, text: h.getDoc().getText(d.range) })))}`
    );
  });

  it("handles a deeply nested undeclared well-known prefix", async () => {
    const buffer = `<Page ${minimalWithX}>\n  <Grid>\n    <StackPanel>\n      <Border>\n        <d:Foo />\n      </Border>\n    </StackPanel>\n  </Grid>\n</Page>`;
    findAddXmlnsFix(await h.codeActionsAt(buffer, "WXAML0001", "d"), "d");
  });

  it("does not report prefixes hidden inside comments or CDATA", async () => {
    const buffer = `<Page ${minimalWithX}>\n  <!-- <d:Foo /> -->\n  <![CDATA[ <mc:Bar /> ]]>\n  <Grid />\n</Page>`;
    await assertNoWxaml0001(buffer, "comment/cdata");
  });

  it("does not throw or invent Add xmlns actions for empty and comment-only rootless documents", async () => {
    for (const buffer of ["", "   \n  ", "<!-- <d:Foo /> -->"]) {
      const actions = await directActionsAfterSettling(buffer);
      assert.ok(!actions.some((title) => /^Add xmlns:/.test(title)), `rootless ${dump(buffer)} actions=${dump(actions)}`);
    }
  });

  it("still offers a correct Add xmlns fix on the valid root when a trailing child is unterminated", async () => {
    // An unterminated child is a mid-edit state, not a rootless document. Only a missing root suppresses the namespace fix.
    for (const buffer of [
      `<Page ${minimalWithX}><d:Foo`,
      `<Page ${minimalWithX}>\n  <Grid>\n    <d:Foo`,
    ]) {
      const r = await h.codeActionsAt(buffer, "WXAML0001", "d");
      const edit = findAddXmlnsFix(r, "d").edits[0]; // asserts zero-width, exact URI, preferred, quickfix
      const fixed = applySingleEdit(buffer, edit);
      assert.ok(
        fixed.includes(`${xNS} xmlns:d="${URI.d}"`),
        `unterminated-child fix should declare xmlns:d on the root, grouped after xmlns:x: ${dump(fixed)}`
      );
    }
  });

  it("keeps the Add xmlns action as a quickfix under VS Code's quickfix-only request", async () => {
    const buffer = `<Page ${minimalWithX}>\n  <d:Foo />\n</Page>`;
    const r = await h.codeActionsAt(buffer, "WXAML0001", "d");
    const fix = findAddXmlnsFix(r, "d");
    assert.strictEqual(fix.kind, "quickfix");
  });
});
