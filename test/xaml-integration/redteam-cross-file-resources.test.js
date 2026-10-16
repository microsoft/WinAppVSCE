"use strict";

// Cross-file resource-key references. Check file identities and counts because helper.js reads ranges from the current buffer.

const assert = require("node:assert");
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");
const h = require("./helper");

const KEY = "SmokeAccentBrush";
const APP = path.join(h.FIXTURE_DIR, "App.xaml");
const DIPAGE = path.join(h.FIXTURE_DIR, "DiPage.xaml");
const SMOKEPAGE = path.join(h.FIXTURE_DIR, "SmokePage.xaml");
const MALFORMED = path.join(h.FIXTURE_DIR, "ZZRedteam79Malformed.xaml");

function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
}

function caretPosition(text) {
  const i = text.indexOf("|");
  assert.ok(i >= 0, "probe text must contain a | caret marker");
  const before = text.slice(0, i);
  const nl = before.lastIndexOf("\n");
  return {
    clean: text.slice(0, i) + text.slice(i + 1),
    position: new vscode.Position((before.match(/\n/g) || []).length, before.length - (nl + 1)),
  };
}

async function referencesAt(text, includeDeclaration) {
  const { clean, position } = caretPosition(text);
  await h.setBuffer(clean);
  const doc = h.getDoc();
  const args = [doc.uri, position];
  if (includeDeclaration !== undefined) args.push({ includeDeclaration });
  const locs = await vscode.commands.executeCommand("vscode.executeReferenceProvider", ...args);
  return (locs || []).map((l) => ({
    uri: l.uri.toString(),
    fsPath: l.uri.fsPath,
    line: l.range.start.line,
    character: l.range.start.character,
    endLine: l.range.end.line,
    endCharacter: l.range.end.character,
    text: l.uri.fsPath === doc.uri.fsPath ? doc.getText(l.range) : undefined,
  }));
}

async function lspReferencesAt(text, includeDeclaration, warmProject = true) {
  const { clean, position } = caretPosition(text);
  const serverPath =
    process.env.WINUI_XAML_TEST_SERVER_PATH ||
    process.env.WINUI_XAML_SERVER_PATH;
  assert.ok(serverPath && fs.existsSync(serverPath), `A test server must exist; got ${serverPath}`);
  const isDll = serverPath.toLowerCase().endsWith(".dll");
  const child = cp.spawn(isDll ? "dotnet" : serverPath, isDll ? [serverPath] : [], {
    cwd: path.dirname(serverPath),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let nextId = 1;
  let buffer = Buffer.alloc(0);
  const pending = new Map();

  function send(method, params, isNotification = false) {
    const msg = isNotification ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: nextId++, method, params };
    const json = JSON.stringify(msg);
    child.stdin.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
    if (isNotification) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      pending.set(msg.id, { resolve, reject });
      setTimeout(() => {
        if (pending.delete(msg.id)) reject(new Error(`${method} timed out`));
      }, 90000);
    });
  }

  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = buffer.slice(0, headerEnd).toString("ascii");
      const match = /^Content-Length:\s*(\d+)/im.exec(header);
      if (!match) throw new Error(`bad LSP header: ${header}`);
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) return;
      const body = buffer.slice(bodyStart, bodyStart + length).toString("utf8");
      buffer = buffer.slice(bodyStart + length);
      const msg = JSON.parse(body);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      }
    }
  });

  child.stderr.on("data", () => { /* server diagnostics are not test assertions */ });

  try {
    const uri = vscode.Uri.file(SMOKEPAGE).toString();
    const rootUri = vscode.Uri.file(h.FIXTURE_DIR).toString();
    await send("initialize", {
      processId: process.pid,
      rootUri,
      capabilities: { textDocument: { references: { dynamicRegistration: false } } },
    });
    await send("initialized", {}, true);
    await send("textDocument/didOpen", {
      textDocument: { uri, languageId: "xaml", version: 1, text: clean },
    }, true);
    if (warmProject) {
      await send("textDocument/completion", {
        textDocument: { uri },
        position: { line: 0, character: 1 },
        context: { triggerKind: 1 },
      });
    }
    const locs = await send("textDocument/references", {
      textDocument: { uri },
      position: { line: position.line, character: position.character },
      context: { includeDeclaration },
    });
    return (locs || []).map((l) => ({
      uri: l.uri,
      fsPath: vscode.Uri.parse(l.uri).fsPath,
      line: l.range.start.line,
      character: l.range.start.character,
      endLine: l.range.end.line,
      endCharacter: l.range.end.character,
    }));
  } finally {
    try { await send("shutdown", null); } catch { /* best effort */ }
    try { await send("exit", null, true); } catch { /* best effort */ }
    child.kill();
  }
}

function norm(p) {
  return p.toLowerCase();
}

function basenameOf(r) {
  return path.basename(r.fsPath).toLowerCase();
}

function countBase(refs, base) {
  return refs.filter((r) => basenameOf(r) === base.toLowerCase()).length;
}

function currentRefs(refs) {
  const cur = norm(h.getDoc().uri.fsPath);
  return refs.filter((r) => norm(r.fsPath) === cur);
}

function assertNoBuildOutput(refs, why) {
  assert.ok(
    !refs.some((r) => /[\\/]obj[\\/]|[\\/]bin[\\/]/i.test(r.fsPath)),
    `${why}: build-output paths leaked: ${JSON.stringify(refs.map((r) => r.fsPath))}`
  );
}

function assertPositiveCrossFileShape(refs, currentCount, why) {
  assert.strictEqual(countBase(refs, "App.xaml"), 1, `${why}: expected App.xaml declaration`);
  assert.strictEqual(countBase(refs, "DiPage.xaml"), 1, `${why}: expected DiPage.xaml usage`);
  assert.strictEqual(currentRefs(refs).length, currentCount, `${why}: wrong current-buffer count`);
  assertNoBuildOutput(refs, why);
}

// A key declared in <Page.Resources> is a distinct resource that merely shares a spelling with the App-level one, so nothing outside this buffer may appear.
function assertDocumentPrivateShape(refs, currentCount, why) {
  assert.strictEqual(countBase(refs, "App.xaml"), 0, `${why}: page-local key must not reach App.xaml`);
  assert.strictEqual(countBase(refs, "DiPage.xaml"), 0, `${why}: page-local key must not reach DiPage.xaml`);
  assert.strictEqual(currentRefs(refs).length, currentCount, `${why}: wrong current-buffer count`);
  assertNoBuildOutput(refs, why);
}

function sortedSignature(refs) {
  return refs
    .map((r) => `${norm(r.fsPath)}:${r.line}:${r.character}:${r.endLine}:${r.endCharacter}`)
    .sort();
}

function sliceDiskRange(file, ref) {
  const lines = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n").split("\n");
  assert.strictEqual(ref.line, ref.endLine, "probe only expects single-line resource ranges");
  return lines[ref.line].slice(ref.character, ref.endCharacter);
}

describe("WinUI XAML — red-team 79 (cross-file resource references)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => {
    try { if (fs.existsSync(MALFORMED)) fs.unlinkSync(MALFORMED); } catch { /* best effort */ }
    await h.revertProbe();
  });

  it("exact-key matching rejects substrings and made-up keys without passing vacuously", async () => {
    const positive = await referencesAt(page(`<Border Background="{StaticResource SmokeAccent|Brush}" />`));
    assert.strictEqual(positive.length, 3, `positive control should find buffer + App + DiPage; got ${JSON.stringify(positive)}`);
    assertPositiveCrossFileShape(positive, 1, "positive exact-key control");

    const substring = await referencesAt(page(`<Border Background="{StaticResource Smoke|Accent}" />`));
    assert.deepStrictEqual(substring.map((r) => r.text), ["SmokeAccent"], `substring key must find only its current-buffer usage`);
    assert.strictEqual(countBase(substring, "App.xaml"), 0, "substring key must not cross-match App.xaml SmokeAccentBrush");
    assert.strictEqual(countBase(substring, "DiPage.xaml"), 0, "substring key must not cross-match DiPage SmokeAccentBrush");

    const madeUp = await referencesAt(page(`<Border Background="{StaticResource NeverShipped|Key}" />`));
    assert.deepStrictEqual(madeUp.map((r) => r.text), ["NeverShippedKey"], `made-up key should still have the current usage as a positive control`);
    assert.strictEqual(countBase(madeUp, "App.xaml"), 0, "made-up key must not invent App.xaml hits");
    assert.strictEqual(countBase(madeUp, "DiPage.xaml"), 0, "made-up key must not invent DiPage hits");
  });

  it("matches resource keys case-sensitively (Ordinal), never folding a wrong-case key cross-file", async () => {
    // Positive control: exact casing resolves cross-file.
    const exact = await referencesAt(page(`<Border Background="{StaticResource SmokeAccent|Brush}" />`));
    assert.strictEqual(exact.length, 3, `exact-case control should find buffer + App + DiPage; got ${JSON.stringify(exact)}`);
    assertPositiveCrossFileShape(exact, 1, "case-sensitivity positive control");

    // Wrong casing must stay purely local: it still has its own buffer occurrence (positive), but must not fold into App.xaml/DiPage's SmokeAccentBrush, proving matching is Ordinal and not case-insensitive.
    const wrong = await referencesAt(page(`<Border Background="{StaticResource smokeaccent|brush}" />`));
    assert.deepStrictEqual(wrong.map((r) => r.text), ["smokeaccentbrush"], `wrong-case key must keep only its own buffer usage; got ${JSON.stringify(wrong)}`);
    assert.strictEqual(countBase(wrong, "App.xaml"), 0, "wrong-case key must not fold into App.xaml SmokeAccentBrush");
    assert.strictEqual(countBase(wrong, "DiPage.xaml"), 0, "wrong-case key must not fold into DiPage SmokeAccentBrush");
    assertNoBuildOutput(wrong, "wrong-case key");
  });

  it("excludes bin/obj build-output copies from multiple caret sites", async () => {
    for (const [label, buffer, currentCount, total] of [
      ["StaticResource usage", page(`<Border Background="{StaticResource SmokeAccent|Brush}" />`), 1, 3],
      ["ThemeResource usage", page(`<Border Background="{ThemeResource SmokeAccent|Brush}" />`), 1, 3],
    ]) {
      const refs = await referencesAt(buffer);
      assert.strictEqual(refs.length, total, `${label}: wrong total; got ${JSON.stringify(refs)}`);
      assertPositiveCrossFileShape(refs, currentCount, label);
    }

    // A page-local declaration shadows the App-level key, so this caret is document-private and must stay off disk copies too.
    const shadowed = await referencesAt(page([
      "<Page.Resources>",
      `  <SolidColorBrush x:Key="SmokeAccent|Brush" Color="Red" />`,
      "</Page.Resources>",
      `<Border Background="{StaticResource ${KEY}}" />`,
    ].join("\n  ")));
    assert.strictEqual(shadowed.length, 2, `shadowing declaration: wrong total; got ${JSON.stringify(shadowed)}`);
    assertDocumentPrivateShape(shadowed, 2, "shadowing declaration");
  });

  it("uses the unsaved current buffer, not the stale on-disk SmokePage.xaml copy", async () => {
    const one = await referencesAt(page(`<Border Background="{StaticResource SmokeAccent|Brush}" />`));
    assert.strictEqual(one.length, 3, `one-buffer-use total should be 3 (buffer + App + DiPage), not disk's 5; got ${JSON.stringify(one)}`);
    assertPositiveCrossFileShape(one, 1, "one unsaved usage");

    const five = await referencesAt(page([
      `<Border Background="{StaticResource SmokeAccent|Brush}" />`,
      `<Border BorderBrush="{ThemeResource ${KEY}}" />`,
      `<Border Tag="{CustomResource ${KEY}}" />`,
      `<TextBlock Text="{Binding Source={StaticResource ${KEY}}, Path=Color}" />`,
      `<Border Background="{StaticResource ${KEY}}" />`,
    ].join("\n  ")));
    assert.strictEqual(five.length, 7, `five-buffer-use total should be 7 (5 buffer + App + DiPage), not disk-doubled; got ${JSON.stringify(five)}`);
    assertPositiveCrossFileShape(five, 5, "five unsaved usages");
  });

  it("honors includeDeclaration=false for cross-file App.xaml while preserving usages", async () => {
    const buffer = page(`<Border Background="{StaticResource SmokeAccent|Brush}" />`);
    const withDecl = await referencesAt(buffer, true);
    assert.strictEqual(withDecl.length, 3, `includeDeclaration=true should include buffer + App + DiPage; got ${JSON.stringify(withDecl)}`);
    assertPositiveCrossFileShape(withDecl, 1, "includeDeclaration=true");

    // VS Code's public executeReferenceProvider command does not expose ReferenceContext, so drive this Use the same server DLL with explicit includeDeclaration=false.
    const withoutDecl = await lspReferencesAt(buffer, false);
    assert.strictEqual(withoutDecl.length, 2, `includeDeclaration=false should include buffer + DiPage only; got ${JSON.stringify(withoutDecl)}`);
    assert.strictEqual(countBase(withoutDecl, "App.xaml"), 0, `includeDeclaration=false leaked App declaration: ${JSON.stringify(withoutDecl)}`);
    assert.strictEqual(countBase(withoutDecl, "DiPage.xaml"), 1, "includeDeclaration=false must keep DiPage usage");
    assert.strictEqual(currentRefs(withoutDecl).length, 1, "includeDeclaration=false must keep current usage");
    assertNoBuildOutput(withoutDecl, "includeDeclaration=false");
  });

  it("returns complete cross-file results on the first cold reference request", async () => {
    const refs = await lspReferencesAt(
      page(`<Border Background="{StaticResource SmokeAccent|Brush}" />`),
      true,
      false);
    assert.strictEqual(refs.length, 3, `cold request should await buffer + App + DiPage; got ${JSON.stringify(refs)}`);
    assertPositiveCrossFileShape(refs, 1, "cold direct LSP request");
  });

  it("keeps a page-local x:Key declaration caret inside its own document", async () => {
    const refs = await referencesAt(page([
      "<Page.Resources>",
      `  <SolidColorBrush x:Key="SmokeAccent|Brush" Color="Red" />`,
      "</Page.Resources>",
      `<Border Background="{StaticResource ${KEY}}" />`,
    ].join("\n  ")));
    assert.strictEqual(refs.length, 2, `a page-local declaration owns only its own buffer's declaration+usage; got ${JSON.stringify(refs)}`);
    assertDocumentPrivateShape(refs, 2, "page-local declaration caret");
  });

  // The mirror of the declaration-side rule: a usage that binds to a page-local declaration is just as private as that declaration.
  it("keeps a usage that resolves to a page-local declaration inside its own document", async () => {
    const refs = await referencesAt(page([
      "<Page.Resources>",
      `  <SolidColorBrush x:Key="${KEY}" Color="Red" />`,
      "</Page.Resources>",
      `<Border Background="{StaticResource SmokeAccent|Brush}" />`,
    ].join("\n  ")));
    assert.strictEqual(refs.length, 2, `a locally-bound usage must not reach App.xaml or DiPage; got ${JSON.stringify(refs)}`);
    assertDocumentPrivateShape(refs, 2, "locally-bound usage caret");
  });

  // A usage that binds nowhere locally does resolve to the App-level declaration, so that file's own usages of it travel with it.
  it("reaches the App-level declaration only when nothing local binds the key", async () => {
    const refs = await referencesAt(page(`<Border Background="{StaticResource SmokeAccent|Brush}" />`));
    assert.strictEqual(refs.length, 3, `unbound usage should reach buffer + App + DiPage; got ${JSON.stringify(refs)}`);
    assertPositiveCrossFileShape(refs, 1, "unbound usage caret");
  });

  // A dictionary that owns the key also owns its own usages of it, so they have to travel with the declaration rather than be skipped for resolving locally.
  it("carries an owning dictionary's internal usages along with its declaration", async () => {
    const refs = await referencesAt(page(`<Border Background="{StaticResource MergedAccent|Brush}" />`));
    assert.strictEqual(countBase(refs, "MergedResources.xaml"), 2, `expected the dictionary's declaration AND its own Setter usage; got ${JSON.stringify(refs)}`);
    assert.strictEqual(currentRefs(refs).length, 1, "expected the current-buffer usage");
    assert.strictEqual(refs.length, 3, `got ${JSON.stringify(refs)}`);
    assertNoBuildOutput(refs, "owning dictionary internal usage");
  });

  it("renames a merged resource without editing an unmerged same-key dictionary", async () => {
    const res = await h.renameAt(
      page(`<Border Background="{StaticResource MergedAccent|Brush}" />`),
      "RenamedMergedAccentBrush");
    assert.ok(!res.error, `rename should succeed; got ${JSON.stringify(res)}`);
    assert.strictEqual(currentRefs(res.edits).length, 1, "expected the current-buffer usage edit");
    assert.strictEqual(countBase(res.edits, "MergedResources.xaml"), 2, "expected the merged declaration and its internal usage");
    assert.strictEqual(countBase(res.edits, "UnmergedResources.xaml"), 0, `unmerged dictionary must not be edited; got ${JSON.stringify(res.edits)}`);
    assert.strictEqual(res.edits.length, 3, `expected only page usage plus merged declaration and usage; got ${JSON.stringify(res.edits)}`);
  });

  it("keeps x:Name document-scoped even when another project file has the same name", async () => {
    const refs = await referencesAt(page([
      `<StackPanel x:Name="DiPage|Title">`,
      `  <TextBlock Text="{Binding ElementName=DiPageTitle, Path=ActualWidth}" />`,
      `  <Storyboard><DoubleAnimation Storyboard.TargetName="DiPageTitle" Storyboard.TargetProperty="Opacity" /></Storyboard>`,
      "</StackPanel>",
    ].join("\n  ")));
    assert.deepStrictEqual(refs.map((r) => r.text), ["DiPageTitle", "DiPageTitle", "DiPageTitle"], `x:Name positive control failed; got ${JSON.stringify(refs)}`);
    assert.ok(refs.every((r) => norm(r.fsPath) === norm(h.getDoc().uri.fsPath)), `x:Name leaked cross-file refs: ${JSON.stringify(refs)}`);
    assert.strictEqual(countBase(refs, "DiPage.xaml"), 0, "x:Name must not include DiPage.xaml's DiPageTitle declaration");
  });

  it("finds framework theme-key project usages without requiring an author x:Key declaration", async () => {
    const refs = await referencesAt(page(`<TextBlock Style="{StaticResource TitleTextBlock|Style}" />`));
    assert.strictEqual(refs.length, 3, `TitleTextBlockStyle should find current + DiPage + Page2 usages only; got ${JSON.stringify(refs)}`);
    assert.strictEqual(currentRefs(refs).length, 1, "TitleTextBlockStyle should include current usage");
    assert.strictEqual(countBase(refs, "DiPage.xaml"), 1, "TitleTextBlockStyle should include DiPage usage");
    assert.strictEqual(countBase(refs, "Page2.xaml"), 1, "TitleTextBlockStyle should include Page2 usage");
    assert.strictEqual(countBase(refs, "App.xaml"), 0, "framework key must not invent an App.xaml declaration");
    assertNoBuildOutput(refs, "framework theme key");
  });

  it("is deterministic across identical requests and A-to-B-to-A buffer mutation", async () => {
    const a = page(`<Border Background="{StaticResource SmokeAccent|Brush}" />`);
    const b = page(`<Border Background="{StaticResource SmokeAccent|Brush}" />\n  <Border BorderBrush="{ThemeResource ${KEY}}" />`);
    const a1 = await referencesAt(a);
    const a2 = await referencesAt(a);
    assert.deepStrictEqual(sortedSignature(a2), sortedSignature(a1), "identical requests should produce identical references");
    assert.strictEqual(a1.length, 3, "A positive control should have 3 refs");

    const b1 = await referencesAt(b);
    assert.strictEqual(b1.length, 4, "B positive control should have 4 refs");
    const a3 = await referencesAt(a);
    assert.deepStrictEqual(sortedSignature(a3), sortedSignature(a1), "A->B->A should restore the original reference set");
  });

  it("returns empty on non-key carets without hiding a nearby positive resource-key control", async () => {
    const positive = await referencesAt(page(`<Border Background="{StaticResource SmokeAccent|Brush}" />`));
    assert.strictEqual(positive.length, 3, "nearby positive resource-key control should work");

    for (const [label, buffer] of [
      ["element tag", page(`<Bor|der Background="{StaticResource ${KEY}}" />`)],
      ["attribute name", page(`<Border Back|ground="{StaticResource ${KEY}}" />`)],
      ["comment", page(`<!-- ${KEY.slice(0, 5)}|${KEY.slice(5)} -->\n  <Border Background="{StaticResource ${KEY}}" />`)],
      ["x prefix", page(`<Border x|:Name="Probe" Background="{StaticResource ${KEY}}" />`)],
    ]) {
      const refs = await referencesAt(buffer);
      assert.strictEqual(refs.length, 0, `${label} should not start references; got ${JSON.stringify(refs)}`);
    }
  });

  it("returns precise cross-file ranges covering only the key token", async () => {
    const refs = await referencesAt(page(`<Border Background="{StaticResource SmokeAccent|Brush}" />`));
    assertPositiveCrossFileShape(refs, 1, "range precision positive shape");

    const appRef = refs.find((r) => basenameOf(r) === "app.xaml");
    const diRef = refs.find((r) => basenameOf(r) === "dipage.xaml");
    assert.ok(appRef, "App.xaml positive hit required for range reconstruction");
    assert.ok(diRef, "DiPage.xaml positive hit required for range reconstruction");
    assert.strictEqual(sliceDiskRange(APP, appRef), KEY, `App.xaml range must slice exactly ${KEY}; got ${JSON.stringify(appRef)}`);
    assert.strictEqual(sliceDiskRange(DIPAGE, diRef), KEY, `DiPage.xaml range must slice exactly ${KEY}; got ${JSON.stringify(diRef)}`);
  });

  it("skips a malformed sibling XAML file without aborting good cross-file results", async () => {
    try {
      fs.writeFileSync(
        MALFORMED,
        `<Page ${h.NS}\n    x:Class="SmokeFixture.ZZRedteam79Malformed">\n  <Grid>\n    <Border Background="{StaticResource ${KEY}"\n`,
        "utf8"
      );
      const refs = await referencesAt(page(`<Border Background="{StaticResource SmokeAccent|Brush}" />`));
      assert.strictEqual(refs.length, 3, `malformed sibling should be skipped while App+DiPage remain; got ${JSON.stringify(refs)}`);
      assertPositiveCrossFileShape(refs, 1, "malformed sibling");
      assert.strictEqual(countBase(refs, path.basename(MALFORMED)), 0, "malformed sibling must not contribute references");
    } finally {
      try { if (fs.existsSync(MALFORMED)) fs.unlinkSync(MALFORMED); } catch { /* best effort */ }
    }
  });
});
