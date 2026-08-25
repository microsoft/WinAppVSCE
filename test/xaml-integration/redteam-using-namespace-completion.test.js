"use strict";

// xmlns using: CLR-namespace completion.

const assert = require("node:assert");
const vscode = require("vscode");
const h = require("./helper");

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

function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function offsetOf(starts, text, line, character) {
  assert.ok(line < starts.length, `line ${line} should exist in ${JSON.stringify(text)}`);
  return Math.min(starts[line] + character, text.length);
}

function applySingleEdit(text, edit) {
  const starts = lineStartsOf(text);
  const start = offsetOf(starts, text, edit.range.start.line, edit.range.start.character);
  const end = offsetOf(starts, text, edit.range.end.line, edit.range.end.character);
  return text.slice(0, start) + edit.newText + text.slice(end);
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
  return (list && list.items ? list.items : []).map((item) => ({
    label: labelOf(item),
    detail: item.detail,
    kind: item.kind,
    newText: item.textEdit
      ? item.textEdit.newText
      : typeof item.insertText === "string"
        ? item.insertText
        : item.insertText && item.insertText.value !== undefined
          ? item.insertText.value
          : undefined,
    range: item.textEdit ? rangeShape(item.textEdit.range) : undefined,
  }));
}

function clr(items) {
  return items.filter((i) => i.detail === "CLR namespace");
}

async function clrAt(buffer) {
  return clr(await completionItemsAt(buffer));
}

function labels(items) {
  return items.map((i) => i.label).sort();
}

function findSmoke(items, message) {
  const smoke = items.find((i) => i.label === "SmokeFixture");
  assert.ok(smoke, `${message}; got ${JSON.stringify(items)}`);
  assert.strictEqual(smoke.detail, "CLR namespace");
  assert.strictEqual(smoke.kind, vscode.CompletionItemKind.Module, "CLR namespace items should be Module kind");
  assert.strictEqual(smoke.newText, "SmokeFixture", "the namespace token replacement should be the namespace only");
  return smoke;
}

function assertNoClr(items, label) {
  assert.deepStrictEqual(clr(items), [], `${label}: expected no CLR namespace items; got ${JSON.stringify(clr(items))}`);
}

function assertNoFrameworkLeak(items) {
  const leaked = items.filter((i) => /^(Microsoft\.UI|Microsoft\.|Windows\.|System\.)/.test(i.label));
  assert.deepStrictEqual(leaked, [], `using: must be source-only; leaked ${JSON.stringify(leaked)}`);
}

function codeActionTitles(result) {
  return result.actions.map((a) => a.title);
}

describe("WinUI XAML — red-team 50 (using: namespace completion)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("offers the project namespace with Module kind and a token-only replacement", async () => {
    const items = await clrAt(page('<Grid xmlns:zzz="using:|" />'));
    console.log(`red-team 50 observed CLR namespace labels: ${labels(items).join(", ")}`);
    findSmoke(items, "expected the project namespace 'SmokeFixture'");
  });

  it("is source-only and never leaks framework/library namespaces", async () => {
    assertNoFrameworkLeak(await clrAt(page('<Grid xmlns:zzz="using:|" />')));
  });

  it("also fires for a default xmlns using: value", async () => {
    findSmoke(await clrAt(page('<Grid xmlns="using:|" />')), "expected SmokeFixture for default xmlns");
  });

  it("does not offer before the exact lowercase using: scheme is fully typed", async () => {
    for (const [name, buffer] of [
      ["empty value", page('<Grid xmlns:zzz="|" />')],
      ["partial scheme", page('<Grid xmlns:zzz="usin|" />')],
      ["missing colon", page('<Grid xmlns:zzz="using|" />')],
      ["caret before colon", page('<Grid xmlns:zzz="using|:" />')],
    ]) {
      assertNoClr(await completionItemsAt(buffer), name);
    }
  });

  it("treats the using: scheme as ordinal lowercase", async () => {
    for (const [name, buffer] of [
      ["capitalized", page('<Grid xmlns:zzz="Using:|" />')],
      ["uppercase", page('<Grid xmlns:zzz="USING:|" />')],
    ]) {
      assertNoClr(await completionItemsAt(buffer), name);
    }
  });

  it("filters on the whole typed namespace token", async () => {
    findSmoke(await clrAt(page('<Grid xmlns:zzz="using:Smoke|" />')), "'Smoke' should match SmokeFixture");
    findSmoke(await clrAt(page('<Grid xmlns:zzz="using:SmokeFixture|" />')), "fully typed SmokeFixture should still match itself");

    const miss = await clrAt(page('<Grid xmlns:zzz="using:Zzz|" />'));
    assert.ok(!miss.some((i) => i.label === "SmokeFixture"), `'Zzz' must not match SmokeFixture; got ${JSON.stringify(miss)}`);
  });

  it("uses a replacement range starting after using: and covering the whole namespace token", async () => {
    const probe = page('<Grid xmlns:zzz="using:Smo|" />');
    const smoke = findSmoke(await clrAt(probe), "expected SmokeFixture for Smo");
    assert.strictEqual(smoke.range && smoke.range.start.character < smoke.range.end.character, true, `expected a replacement range; got ${JSON.stringify(smoke)}`);
    const fixed = applySingleEdit(probe.replace("|", ""), smoke);
    assert.ok(fixed.includes('xmlns:zzz="using:SmokeFixture"'), fixed);
    assert.ok(!fixed.includes("SmoSmokeFixture"), fixed);
  });

  it("handles caret positions after the colon, in the middle, and at the end", async () => {
    findSmoke(await clrAt(page('<Grid xmlns:zzz="using:|" />')), "empty partial after colon should offer SmokeFixture");
    findSmoke(await clrAt(page('<Grid xmlns:zzz="using:Smoke|Fixture" />')), "mid-token caret should offer SmokeFixture");
    findSmoke(await clrAt(page('<Grid xmlns:zzz="using:SmokeFixture|" />')), "end-token caret should offer SmokeFixture");
  });

  it("does not treat non-xmlns attributes as namespace-completion contexts", async () => {
    for (const [name, buffer] of [
      ["Tag", page('<Grid Tag="using:|" />')],
      ["Width", page('<Grid Width="using:|" />')],
      ["prefixed non-xmlns", page('<Grid local:Foo="using:|" />')],
    ]) {
      assertNoClr(await completionItemsAt(buffer), name);
    }
  });

  it("is robust in root, nested, multi-xmlns, adjacent-attribute, and malformed edit states", async () => {
    for (const [name, buffer] of [
      ["root Page xmlns", `<Page ${h.NS}
    xmlns:zzz="using:|"
    x:Class="SmokeFixture.SmokePage">
  <Grid />
</Page>`],
      ["deep child xmlns", page('<Grid><StackPanel><Border xmlns:zzz="using:|" /></StackPanel></Grid>')],
      ["multiple using xmlns attributes", page('<Grid xmlns:aaa="using:SmokeFixture" xmlns:zzz="using:|" />')],
      ["adjacent ordinary attributes", page('<Grid Width="10" xmlns:zzz="using:|" Height="20" />')],
      ["unterminated value", page('<Grid xmlns:zzz="using:|')],
      ["malformed tag", page('<Grid><Broken xmlns:zzz="using:|"')],
    ]) {
      findSmoke(await clrAt(buffer), `${name} should offer SmokeFixture without crashing`);
    }
  });

  it("returns deterministic CLR namespace completions for the same probe", async () => {
    const probe = page('<Grid xmlns:zzz="using:|" />');
    const first = await clrAt(probe);
    const second = await clrAt(probe);
    assert.deepStrictEqual(second, first);
  });

  it("covers observed dotted namespace filtering when the fixture exposes a dotted source namespace", async () => {
    const all = await clrAt(page('<Grid xmlns:zzz="using:|" />'));
    const dotted = labels(all).find((label) => label.includes("."));
    if (!dotted) {
      assert.deepStrictEqual(labels(all).filter((label) => label.includes(".")), [], `fixture unexpectedly exposed dotted namespaces: ${JSON.stringify(labels(all))}`);
      return;
    }

    const prefix = dotted.slice(0, dotted.lastIndexOf(".") + 2);
    const items = await clrAt(page(`<Grid xmlns:zzz="using:${prefix}|" />`));
    assert.ok(items.some((i) => i.label === dotted), `${prefix} should match dotted namespace ${dotted}; got ${JSON.stringify(items)}`);
  });

  it("does not regress the round-49 Add xmlns using: quick fix for undeclared custom prefixes", async () => {
    const r = await h.codeActionsAt(page("<zzz:SmokePage />"), "WXAML0001", "zzz");
    const fix = r.actions.find((a) => a.title === 'Add xmlns:zzz="using:SmokeFixture"');
    assert.ok(fix, `expected using quickfix; diag=${JSON.stringify(r.diagnostic)} actions=${JSON.stringify(codeActionTitles(r))}`);
    assert.strictEqual(fix.kind, "quickfix");
    assert.strictEqual(fix.isPreferred, true);
    assert.strictEqual(fix.edits.length, 1, `expected one edit; got ${JSON.stringify(fix.edits)}`);
    assert.strictEqual(fix.edits[0].newText.replaceAll("\r\n", "\n"), '\n    xmlns:zzz="using:SmokeFixture"');
  });
});
