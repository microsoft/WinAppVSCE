"use strict";

// WXAML0001 custom-prefix "using:" inference.

const assert = require("assert");
const vscode = require("vscode");
const h = require("./helper");

const URI = {
  x: "http://schemas.microsoft.com/winfx/2006/xaml",
  d: "http://schemas.microsoft.com/expression/blend/2008",
  mc: "http://schemas.openxmlformats.org/markup-compatibility/2006",
};

const defaultNS = 'xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"';
const xNS = `xmlns:x="${URI.x}"`;
const minimalWithX = `${defaultNS} ${xNS}`;

const page = (inner) => `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage">
  ${inner}
</Page>`;

function dump(value) {
  return JSON.stringify(value);
}

function titles(r) {
  return r.actions.map((a) => a.title);
}

function addXmlnsActions(r) {
  return r.actions.filter((a) => /^Add xmlns/.test(a.title));
}

function usingActions(r) {
  return r.actions.filter((a) => /^Add xmlns:[^ ]+="using:/.test(a.title));
}

function changeActions(r) {
  return r.actions.filter((a) => /^Change /.test(a.title));
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

function findUsingFix(r, prefix, namespaceName = "SmokeFixture") {
  const title = `Add xmlns:${prefix}="using:${namespaceName}"`;
  const fix = r.actions.find((a) => a.title === title && a.kind === "quickfix");
  assert.ok(fix, `expected ${dump(title)} quickfix; diag=${dump(r.diagnostic)} actions=${dump(titles(r))}`);
  assert.strictEqual(fix.isPreferred, true, `${title} should be preferred for the single fixture namespace`);
  assert.strictEqual(fix.edits.length, 1, `${title} should have exactly one edit`);
  assert.match(
    fix.edits[0].newText,
    new RegExp(`^\\s+xmlns:${prefix}="using:${namespaceName}"$`),
    `${title} inserted text`
  );
  assertZeroWidth(fix.edits[0], `${title} edit`);
  return fix;
}

function findStandardFix(r, prefix) {
  const title = `Add xmlns:${prefix} declaration`;
  const fix = r.actions.find((a) => a.title === title && a.kind === "quickfix");
  assert.ok(fix, `expected ${dump(title)} quickfix; diag=${dump(r.diagnostic)} actions=${dump(titles(r))}`);
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

function assertNoAddXmlns(r, label) {
  assert.deepStrictEqual(addXmlnsActions(r), [], `${label}: Add xmlns actions ${dump(titles(r))}`);
}

async function diagnosticsAfterSettling(buffer, timeoutMs = 2500) {
  return h.diagnosticsFor(buffer, undefined, timeoutMs);
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

describe("WinUI XAML — red-team 49 (custom using: inference)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("offers the exact using fix for zzz:SmokePage", async () => {
    const buffer = page("<zzz:SmokePage />");
    const r = await h.codeActionsAt(buffer, "WXAML0001", "zzz");
    const edit = findUsingFix(r, "zzz").edits[0];
    assert.strictEqual(edit.newText.replaceAll("\r\n", "\n"), '\n    xmlns:zzz="using:SmokeFixture"');
    assert.ok(edit.line > 0, `expected insertion on a wrapped xmlns line; edit=${dump(edit)}`);
    assertEditAtOffset(buffer, edit, buffer.indexOf('xmlns:local="using:SmokeFixture"') + 'xmlns:local="using:SmokeFixture"'.length, "after local xmlns");
  });

  it("offers the exact using fix for zzz:App", async () => {
    findUsingFix(await h.codeActionsAt(page("<zzz:App />"), "WXAML0001", "zzz"), "zzz");
  });

  for (const prefix of ["ctl", "ns1", "myctls"]) {
    it(`uses the exact fresh prefix ${prefix} in the title and edit`, async () => {
      findUsingFix(await h.codeActionsAt(page(`<${prefix}:SmokePage />`), "WXAML0001", prefix), prefix);
    });
  }

  for (const typeName of ["Widget", "Foo", "NotAType"]) {
    it(`does not offer Add xmlns or Change actions for non-project custom type ${typeName}`, async () => {
      const r = await h.codeActionsAt(page(`<zzz:${typeName} />`), "WXAML0001", "zzz");
      assertNoAddXmlns(r, typeName);
      assert.deepStrictEqual(changeActions(r), [], `${typeName}: Change actions ${dump(titles(r))}`);
    });
  }

  for (const typeName of ["Button", "Grid", "TextBlock"]) {
    it(`does not infer using: for framework metadata type ${typeName}`, async () => {
      const r = await h.codeActionsAt(page(`<zzz:${typeName} />`), "WXAML0001", "zzz");
      assertNoAddXmlns(r, typeName);
    });
  }

  it("does not infer using: from a project-type name on a root attribute prefix", async () => {
    const buffer = `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage" zzz:SmokePage="x">
  <Grid/>
</Page>`;
    assertNoAddXmlns(await h.codeActionsAt(buffer, "WXAML0001", "zzz"), "root attribute");
  });

  it("does not infer using: from a project-type name on a child attribute prefix", async () => {
    assertNoAddXmlns(await h.codeActionsAt(page('<Grid zzz:App="1" />'), "WXAML0001", "zzz"), "child attribute");
  });

  it("keeps d as a standard well-known declaration even on a project-type element", async () => {
    const r = await h.codeActionsAt(`<Page ${minimalWithX}>\n  <d:SmokePage />\n</Page>`, "WXAML0001", "d");
    findStandardFix(r, "d");
    assert.deepStrictEqual(usingActions(r), [], `d should not become using: ${dump(titles(r))}`);
  });

  it("keeps mc as a standard well-known declaration", async () => {
    const r = await h.codeActionsAt(`<Page ${minimalWithX} mc:Ignorable="d">\n  <Grid />\n</Page>`, "WXAML0001", "mc");
    findStandardFix(r, "mc");
    assert.deepStrictEqual(usingActions(r), [], `mc should not become using: ${dump(titles(r))}`);
  });

  it("keeps x as a standard well-known declaration", async () => {
    const r = await h.codeActionsAt(`<Page ${defaultNS}>\n  <x:SmokePage />\n</Page>`, "WXAML0001", "x");
    findStandardFix(r, "x");
    assert.deepStrictEqual(usingActions(r), [], `x should not become using: ${dump(titles(r))}`);
  });

  it("dedupes repeated same-prefix project-type elements in a full-document request", async () => {
    const actions = await fullDocumentActions(page("<zzz:SmokePage />\n  <zzz:App />"), "WXAML0001", "zzz");
    assert.deepStrictEqual(
      actions.filter((a) => a.title === 'Add xmlns:zzz="using:SmokeFixture"').map((a) => a.title),
      ['Add xmlns:zzz="using:SmokeFixture"'],
      dump(actions)
    );
  });

  it("inserts after the last existing xmlns and before non-xmlns attributes", async () => {
    const buffer = page("<zzz:SmokePage />");
    const edit = findUsingFix(await h.codeActionsAt(buffer, "WXAML0001", "zzz"), "zzz").edits[0];
    const fixed = applySingleEdit(buffer, edit).replaceAll("\r\n", "\n");
    assert.ok(
      fixed.includes('xmlns:local="using:SmokeFixture"\n    xmlns:zzz="using:SmokeFixture"\n    mc:Ignorable="d"\n    x:Class='),
      fixed
    );
  });

  it("infers using: from the PROJECT for a source type even under a bogus default xmlns (inference is project-based, not xmlns-gated), yet stays source-only", async () => {
    // The harness binds every probe buffer to the SmokeFixture project, so SmokePage resolves as a project SOURCE type regardless of the document's own (bogus) default namespace — the using: fix fires, exactly as VS infers a using: target from project types. The default xmlns does not gate it.
    findUsingFix(await h.codeActionsAt(`<Page xmlns="http://x"><zzz:SmokePage/></Page>`, "WXAML0001", "zzz"), "zzz");
    // ...but a FRAMEWORK type in the same raw buffer still gets NO using: fix (the guard is source-only, not "anything in a raw buffer"): Button lives in referenced metadata, never the declaration table.
    assertNoAddXmlns(await h.codeActionsAt(`<Page xmlns="http://x"><zzz:Button/></Page>`, "WXAML0001", "zzz"), "framework type in raw buffer");
  });

  it("applied custom using edit clears the original zzz diagnostic without introducing a new zzz WXAML0001", async () => {
    const buffer = page("<zzz:SmokePage />");
    const fixed = applySingleEdit(buffer, findUsingFix(await h.codeActionsAt(buffer, "WXAML0001", "zzz"), "zzz").edits[0]);
    assert.ok(fixed.includes(' xmlns:zzz="using:SmokeFixture"'), fixed);
    const ds = await diagnosticsAfterSettling(fixed, 3000);
    assert.ok(
      !ds.some((d) => codeString(d.code) === "WXAML0001" && h.getDoc().getText(d.range) === "zzz"),
      `expected zzz WXAML0001 to clear; diagnostics=${dump(ds.map((d) => ({ code: codeString(d.code), message: d.message, text: h.getDoc().getText(d.range) })))}`
    );
  });

  it("does not throw on an unterminated source-type element and offers only the valid custom using fix", async () => {
    const buffer = page("<zzz:SmokePage");
    const result = await h.codeActionsAt(buffer, "WXAML0001", "zzz");
    const actions = titles(result);
    assert.deepStrictEqual(
      actions.filter((title) => /^Add xmlns:zzz=/.test(title)),
      ['Add xmlns:zzz="using:SmokeFixture"'],
      `${dump(buffer)} actions=${dump(actions)}`
    );
  });

  for (const [name, inner] of [
    ["missing local name with space", "<zzz: />"],
    ["missing local name without space", "<zzz:/>"],
    ["missing prefix", "<:SmokePage/>"],
    ["dotted local starts with dot", "<zzz:.SmokePage/>"],
    ["prefixed dotted property-element-shaped name", "<zzz:SmokePage.Something/>"],
  ]) {
    it(`does not throw or invent using fixes for malformed prefixed name: ${name}`, async () => {
      const buffer = page(inner);
      const actions = await directActionsAfterSettling(buffer);
      assert.ok(!actions.some((title) => /^Add xmlns:[^ ]+="using:/.test(title)), `${dump(buffer)} actions=${dump(actions)}`);
    });
  }

  it("offers the valid custom using fix for a standalone unterminated prefixed source-type element (no throw; matches the wrapped-child case)", async () => {
    // A mid-edit unterminated ROOT whose name is well-formed and whose prefix is genuinely undeclared correctly gets the fix: the tolerant parser yields a non-null root.Name
    findUsingFix(await h.codeActionsAt("<zzz:SmokePage", "WXAML0001", "zzz"), "zzz");
  });

  it("handles a deeply nested project-type element", async () => {
    findUsingFix(await h.codeActionsAt(page("<Grid><StackPanel><zzz:SmokePage/></StackPanel></Grid>"), "WXAML0001", "zzz"), "zzz");
  });

  it("handles a custom prefix on the root element itself", async () => {
    const buffer = `<zzz:SmokePage ${h.NS}
    x:Class="SmokeFixture.SmokePage">
  <Grid />
</zzz:SmokePage>`;
    findUsingFix(await h.codeActionsAt(buffer, "WXAML0001", "zzz"), "zzz");
  });

  it("does not report/fix prefixes hidden inside comments or CDATA", async () => {
    const buffer = page("<!-- <zzz:SmokePage /> -->\n  <![CDATA[ <ctl:App /> ]]>\n  <Grid />");
    const ds = await diagnosticsAfterSettling(buffer);
    const hidden = ds.filter((d) => codeString(d.code) === "WXAML0001" && ["zzz", "ctl"].includes(h.getDoc().getText(d.range)));
    assert.deepStrictEqual(hidden.map((d) => h.getDoc().getText(d.range)), [], dump(ds.map((d) => ({ code: codeString(d.code), text: h.getDoc().getText(d.range), message: d.message }))));
    const actions = await directActionsAfterSettling(buffer);
    assert.ok(!actions.some((title) => /^Add xmlns:(zzz|ctl)=/.test(title)), `hidden text actions=${dump(actions)}`);
  });

  it("offers independent fixes for two different undeclared custom prefixes with no cross-talk", async () => {
    const buffer = page("<zzz:SmokePage />\n  <ctl:App />");
    const zzzFix = findUsingFix(await h.codeActionsAt(buffer, "WXAML0001", "zzz"), "zzz");
    const ctlFix = findUsingFix(await h.codeActionsAt(buffer, "WXAML0001", "ctl"), "ctl");
    assert.strictEqual(zzzFix.edits[0].newText.replaceAll("\r\n", "\n"), '\n    xmlns:zzz="using:SmokeFixture"');
    assert.strictEqual(ctlFix.edits[0].newText.replaceAll("\r\n", "\n"), '\n    xmlns:ctl="using:SmokeFixture"');
  });

  it("is case-sensitive and does not fix lowercase smokepage", async () => {
    assertNoAddXmlns(await h.codeActionsAt(page("<zzz:smokepage/>"), "WXAML0001", "zzz"), "lowercase smokepage");
  });

  it("returns a deterministic title and edit for repeated requests", async () => {
    const buffer = page("<zzz:SmokePage />");
    const first = findUsingFix(await h.codeActionsAt(buffer, "WXAML0001", "zzz"), "zzz");
    const second = findUsingFix(await h.codeActionsAt(buffer, "WXAML0001", "zzz"), "zzz");
    assert.deepStrictEqual(
      { title: first.title, edit: first.edits[0] },
      { title: second.title, edit: second.edits[0] }
    );
  });
});
