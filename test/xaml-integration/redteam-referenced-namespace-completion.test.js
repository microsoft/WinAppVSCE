"use strict";

// xmlns using: completion from source and referenced metadata.

const assert = require("node:assert");
const vscode = require("vscode");
const h = require("./helper");

const SOURCE_DETAIL = "CLR namespace";
const REFERENCED_DETAIL = "CLR namespace (referenced)";

const page = (inner) => `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage">
  ${inner}
</Page>`;

function labelOf(item) {
  return typeof item.label === "string" ? item.label : item.label.label;
}

function caretPosition(text) {
  const i = text.indexOf("|");
  assert.ok(i >= 0, "probe text must contain a | caret marker");
  const before = text.slice(0, i);
  const nl = before.lastIndexOf("\n");
  const line = (before.match(/\n/g) || []).length;
  const character = before.length - (nl + 1);
  const clean = text.slice(0, i) + text.slice(i + 1);
  return { clean, position: new vscode.Position(line, character) };
}

function rangeShape(range) {
  if (!range) return undefined;
  if (range.inserting && range.replacing) range = range.replacing;
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

async function completionItemsAt(text) {
  const { clean, position } = caretPosition(text);
  await h.setBuffer(clean);
  const list = await vscode.commands.executeCommand(
    "vscode.executeCompletionItemProvider",
    h.getDoc().uri,
    position
  );
  return {
    clean,
    items: (list && list.items ? list.items : []).map((item) => ({
      label: labelOf(item),
      detail: item.detail,
      kind: item.kind,
      sortText: item.sortText,
      newText: item.textEdit
        ? item.textEdit.newText
        : typeof item.insertText === "string"
          ? item.insertText
          : item.insertText && item.insertText.value !== undefined
            ? item.insertText.value
            : undefined,
      range: item.textEdit ? rangeShape(item.textEdit.range) : undefined,
    })),
  };
}

const source = (items) => items.filter((i) => i.detail === SOURCE_DETAIL);
const referenced = (items) => items.filter((i) => i.detail === REFERENCED_DETAIL);
const labels = (items) => items.map((i) => i.label).sort();

async function groupsAt(buffer) {
  const { clean, items } = await completionItemsAt(buffer);
  return { clean, items, source: source(items), referenced: referenced(items) };
}

function summarize(items) {
  return JSON.stringify(items.slice(0, 50));
}

function requireLabel(items, label, message) {
  const item = items.find((i) => i.label === label);
  assert.ok(item, `${message}; got ${items.length} items: ${summarize(items)}`);
  return item;
}

function requireNoLabel(items, label, message) {
  assert.ok(!items.some((i) => i.label === label), `${message}; got ${summarize(items)}`);
}

function assertNoServerUsing(items, label) {
  const got = items.filter((i) => i.detail === SOURCE_DETAIL || i.detail === REFERENCED_DETAIL);
  assert.deepStrictEqual(got, [], `${label}: expected no server using: namespace items; got ${JSON.stringify(got)}`);
}

function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function offsetOf(starts, text, line, character) {
  assert.ok(line < starts.length, `line ${line} should exist in probe text`);
  return Math.min(starts[line] + character, text.length);
}

function applySingleEdit(text, item) {
  assert.ok(item.range, `completion item should carry a textEdit range: ${JSON.stringify(item)}`);
  const starts = lineStartsOf(text);
  const start = offsetOf(starts, text, item.range.start.line, item.range.start.character);
  const end = offsetOf(starts, text, item.range.end.line, item.range.end.character);
  return text.slice(0, start) + item.newText + text.slice(end);
}

function normalized(items) {
  return items
    .map((i) => ({ label: i.label, detail: i.detail, kind: i.kind, sortText: i.sortText, newText: i.newText }))
    .sort((a, b) => `${a.detail}\0${a.label}`.localeCompare(`${b.detail}\0${b.label}`));
}

describe("WinUI XAML — red-team 60 (referenced using: namespace completion)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("groups source and referenced namespaces with disjoint labels and ranked sortText", async () => {
    const g = await groupsAt(page('<Grid xmlns:zzz="using:|" />'));

    const smoke = requireLabel(g.source, "SmokeFixture", "expected SmokeFixture in the source CLR namespace group");
    requireNoLabel(g.referenced, "SmokeFixture", "SmokeFixture must not appear in the referenced group");

    const controls = requireLabel(g.referenced, "Microsoft.UI.Xaml.Controls", "expected WinUI Controls in the referenced group");
    requireNoLabel(g.source, "Microsoft.UI.Xaml.Controls", "Microsoft.UI.Xaml.Controls must not appear in the source group");

    assert.ok((smoke.sortText || "").startsWith("0"), `source sortText should start with 0; got ${JSON.stringify(smoke)}`);
    assert.ok((controls.sortText || "").startsWith("1"), `referenced sortText should start with 1; got ${JSON.stringify(controls)}`);

    const sourceLabels = new Set(labels(g.source));
    const overlap = labels(g.referenced).filter((label) => sourceLabels.has(label));
    assert.deepStrictEqual(overlap, [], `source/referenced groups must be disjoint; overlap=${JSON.stringify(overlap)}`);
  });

  it("includes canonical referenced framework namespaces", async () => {
    const refs = (await groupsAt(page('<Grid xmlns:zzz="using:|" />'))).referenced;
    for (const ns of ["Microsoft.UI.Xaml", "Microsoft.UI.Xaml.Controls", "System"]) {
      requireLabel(refs, ns, `expected referenced namespace ${ns}`);
    }
  });

  it("filters referenced namespaces by whole dotted prefix, case-insensitively", async () => {
    let refs = (await groupsAt(page('<Grid xmlns:zzz="using:Microsoft.UI.Xaml.Cont|" />'))).referenced;
    requireLabel(refs, "Microsoft.UI.Xaml.Controls", "dotted prefix should match Microsoft.UI.Xaml.Controls");

    refs = (await groupsAt(page('<Grid xmlns:zzz="using:microsoft.ui.xaml.cont|" />'))).referenced;
    requireLabel(refs, "Microsoft.UI.Xaml.Controls", "lowercase prefix should still match OrdinalIgnoreCase");

    refs = (await groupsAt(page('<Grid xmlns:zzz="using:Windows.|" />'))).referenced;
    assert.ok(refs.length > 0, "Windows. should produce at least one referenced namespace on the WinAppSDK fixture");
    assert.deepStrictEqual(
      refs.filter((i) => !i.label.startsWith("Windows.")),
      [],
      `Windows. prefix must not leak non-Windows namespaces; got ${summarize(refs)}`
    );

    refs = (await groupsAt(page('<Grid xmlns:zzz="using:Zznope|" />'))).referenced;
    assert.deepStrictEqual(refs, [], `garbage prefix should produce no referenced namespaces; got ${JSON.stringify(refs)}`);
  });

  it("keeps source namespace prefix filtering intact", async () => {
    requireLabel((await groupsAt(page('<Grid xmlns:zzz="using:Smoke|" />'))).source, "SmokeFixture", "Smoke should match SmokeFixture");
    const miss = (await groupsAt(page('<Grid xmlns:zzz="using:Zzz|" />'))).source;
    requireNoLabel(miss, "SmokeFixture", "Zzz must not match SmokeFixture");
  });

  it("uses Module kind and namespace-only replacement text for every referenced item", async () => {
    const refs = (await groupsAt(page('<Grid xmlns:zzz="using:Microsoft.UI.Xaml.Cont|" />'))).referenced;
    assert.ok(refs.length > 0, "expected referenced items for Microsoft.UI.Xaml.Cont");
    for (const item of refs) {
      assert.strictEqual(item.kind, vscode.CompletionItemKind.Module, `referenced item should be Module: ${JSON.stringify(item)}`);
      assert.strictEqual(item.newText, item.label, `referenced item newText should equal label: ${JSON.stringify(item)}`);
      assert.ok((item.sortText || "").startsWith("1"), `referenced sortText should be group 1: ${JSON.stringify(item)}`);
    }
  });

  it("replaces the whole typed dotted token without duplicating prefixes", async () => {
    const probe = page('<Grid xmlns:zzz="using:Microsoft.UI.Xaml.Cont|" />');
    const g = await groupsAt(probe);
    const controls = requireLabel(g.referenced, "Microsoft.UI.Xaml.Controls", "expected Controls replacement probe");
    const fixed = applySingleEdit(g.clean, controls);
    assert.ok(fixed.includes('xmlns:zzz="using:Microsoft.UI.Xaml.Controls"'), fixed);
    assert.ok(!fixed.includes("Microsoft.UI.Xaml.ContMicrosoft.UI.Xaml.Controls"), fixed);
  });

  it("also completes both groups for the default xmlns declaration", async () => {
    const g = await groupsAt(page('<Grid xmlns="using:|" />'));
    requireLabel(g.source, "SmokeFixture", "default xmlns should include source namespaces");
    requireLabel(g.referenced, "Microsoft.UI.Xaml.Controls", "default xmlns should include referenced namespaces");
  });

  it("does not leak in non-xmlns attributes or plain attribute values", async () => {
    for (const [name, buffer] of [
      ["Tag", page('<Grid Tag="using:|" />')],
      ["Width", page('<Grid Width="using:|" />')],
      ["prefixed non-xmlns", page('<Grid local:Foo="using:|" />')],
      ["plain xmlns value without scheme", page('<Grid xmlns:zzz="Microsoft.UI.Xaml.|" />')],
    ]) {
      assertNoServerUsing((await completionItemsAt(buffer)).items, name);
    }
  });

  it("requires the exact lowercase using: scheme and caret after the colon", async () => {
    for (const [name, buffer] of [
      ["empty value", page('<Grid xmlns:zzz="|" />')],
      ["partial scheme", page('<Grid xmlns:zzz="usin|" />')],
      ["missing colon", page('<Grid xmlns:zzz="using|" />')],
      ["caret before colon", page('<Grid xmlns:zzz="using|:" />')],
      ["capitalized scheme", page('<Grid xmlns:zzz="Using:|" />')],
      ["misspelled scheme", page('<Grid xmlns:zzz="usin:|" />')],
    ]) {
      assertNoServerUsing((await completionItemsAt(buffer)).items, name);
    }
  });

  it("does not complete inside XML comments or CDATA", async () => {
    for (const [name, buffer] of [
      ["comment", page('<!-- <Grid xmlns:zzz="using:|" /> -->\n<Grid />')],
      ["CDATA", page('<Grid><![CDATA[ <Grid xmlns:zzz="using:|" /> ]]></Grid>')],
    ]) {
      assertNoServerUsing((await completionItemsAt(buffer)).items, name);
    }
  });

  it("returns deterministic source and referenced sets across repeated requests and cached filters", async () => {
    const probe = page('<Grid xmlns:zzz="using:|" />');
    const first = await groupsAt(probe);
    const second = await groupsAt(probe);
    assert.deepStrictEqual(normalized([...second.source, ...second.referenced]), normalized([...first.source, ...first.referenced]));

    requireLabel((await groupsAt(page('<Grid xmlns:zzz="using:Microsoft.UI.Xaml.Cont|" />'))).referenced, "Microsoft.UI.Xaml.Controls", "filter request should warm referenced cache");
    const third = await groupsAt(probe);
    assert.deepStrictEqual(normalized([...third.source, ...third.referenced]), normalized([...first.source, ...first.referenced]));
  });

  it("survives malformed, unterminated, EOF, multi-xmlns, and adjacent-attribute edit states", async () => {
    for (const [name, buffer] of [
      ["root Page xmlns", `<Page ${h.NS}
    xmlns:zzz="using:|"
    x:Class="SmokeFixture.SmokePage">
  <Grid />
</Page>`],
      ["deep child xmlns", page('<Grid><StackPanel><Border xmlns:zzz="using:|" /></StackPanel></Grid>')],
      ["multiple xmlns", page('<Grid xmlns:aaa="using:SmokeFixture" xmlns:zzz="using:|" />')],
      ["adjacent attributes", page('<Grid Width="10" xmlns:zzz="using:|" Height="20" />')],
      ["unterminated value", page('<Grid xmlns:zzz="using:|')],
      ["malformed tag", page('<Grid><Broken xmlns:zzz="using:|"')],
      ["using at EOF", `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage">
  <Grid xmlns:zzz="using:|`],
    ]) {
      const g = await groupsAt(buffer);
      requireLabel(g.source, "SmokeFixture", `${name} should still offer source namespace without throwing`);
      requireLabel(g.referenced, "Microsoft.UI.Xaml.Controls", `${name} should still offer referenced namespace without throwing`);
    }
  });

  it("best-effort non-class exclusion: System.Numerics structs do not make the namespace completable", async () => {
    const refs = (await groupsAt(page('<Grid xmlns:zzz="using:System.Numerics|" />'))).referenced;
    requireNoLabel(refs, "System.Numerics", "namespace with public structs but no direct public non-static class should be absent");
  });
});
