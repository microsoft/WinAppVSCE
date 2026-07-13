// End-to-end LSP smoke test for the WinUI XAML language server.
//
// Drives the real server over stdio (no VS Code, no test framework, no npm deps) and proves the
// spine: initialize -> didOpen (syntactic diagnostics) -> textDocument/definition (F12) resolves an
// event-handler attribute value to the C# method in the page's code-behind.
//
// Usage:  node smoke.mjs
// Exit 0 = pass. Requires the server to be built (Debug) and the WinUI smoke fixture on disk.

import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));

const SERVER_DLL = resolve(
  here,
  "../../src/WinUiXaml.LanguageServer/bin/Debug/net10.0/WinUiXaml.LanguageServer.dll"
);
// Allow pointing the smoke test at an alternate build (e.g. the bundled Release publish).
const serverDll = process.env.WINUI_XAML_SERVER_DLL || SERVER_DLL;
const XAML = process.env.WINUI_XAML_FIXTURE_XAML || resolve(here, "../../../test/fixtures/xaml/fixture/SmokePage.xaml");
const EXPECTED_CODE_BEHIND = "smokepage.xaml.cs";
const EXPECTED_HANDLER_LINE = 26; // OnGo_Click is on line 27 (1-based) of SmokePage.xaml.cs
const EXPECTED_GREETING_LINE = 15; // GreetingText is on line 16 (1-based) of SmokePage.xaml.cs
const EXPECTED_APP_XAML = "app.xaml";
const EXPECTED_ACCENT_KEY_LINE = 13; // <SolidColorBrush x:Key="SmokeAccentBrush"> is on line 14 (1-based) of App.xaml

let server;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
  if (server) server.kill();
  process.exit();
}

if (!existsSync(serverDll)) fail(`server not built: ${serverDll}`);
if (!existsSync(XAML)) fail(`fixture not found: ${XAML}`);

const xamlText = readFileSync(XAML, "utf8");
const xamlUri = pathToFileURL(XAML).href;

function offsetToPosition(text, offset) {
  let line = 0;
  let last = 0;
  for (let i = 0; i < offset; i++) {
    if (text[i] === "\n") {
      line++;
      last = i + 1;
    }
  }
  return { line, character: offset - last };
}

// Caret a few chars into the OnGo_Click handler value.
const handlerIdx = xamlText.indexOf('Click="OnGo_Click"');
if (handlerIdx < 0) fail('could not find Click="OnGo_Click" in the fixture');
const caretOffset = xamlText.indexOf("OnGo_Click", handlerIdx) + 3;
const caret = offsetToPosition(xamlText, caretOffset);

// Caret inside the {x:Bind GreetingText, ...} path expression.
const bindIdx = xamlText.indexOf("{x:Bind GreetingText");
if (bindIdx < 0) fail("could not find {x:Bind GreetingText in the fixture");
const bindCaretOffset = xamlText.indexOf("GreetingText", bindIdx) + 3;
const bindCaret = offsetToPosition(xamlText, bindCaretOffset);

// Caret inside the {StaticResource SmokeAccentBrush} value (resolves cross-file to App.xaml's x:Key).
const resIdx = xamlText.indexOf("{StaticResource SmokeAccentBrush}");
if (resIdx < 0) fail("could not find {StaticResource SmokeAccentBrush} in the fixture");
const resCaretOffset = xamlText.indexOf("SmokeAccentBrush", resIdx) + 3;
const resCaret = offsetToPosition(xamlText, resCaretOffset);

server = spawn("dotnet", [serverDll], { stdio: ["pipe", "pipe", "inherit"] });

// --- LSP framing ---
let buffer = Buffer.alloc(0);
const waiters = [];

server.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) fail("bad header from server");
    const len = parseInt(m[1], 10);
    const start = headerEnd + 4;
    if (buffer.length < start + len) return;
    const body = buffer.subarray(start, start + len).toString("utf8");
    buffer = buffer.subarray(start + len);
    dispatch(JSON.parse(body));
  }
});

function dispatch(msg) {
  for (let i = 0; i < waiters.length; i++) {
    if (waiters[i].match(msg)) {
      const [w] = waiters.splice(i, 1);
      w.resolve(msg);
      return;
    }
  }
}

function send(msg) {
  const json = JSON.stringify({ jsonrpc: "2.0", ...msg });
  const payload = Buffer.from(json, "utf8");
  server.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
  server.stdin.write(payload);
}

function waitFor(match, timeoutMs, label) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs);
    waiters.push({
      match,
      resolve: (m) => {
        clearTimeout(timer);
        resolvePromise(m);
      },
    });
  });
}

const responseFor = (id) => (m) => m.id === id && (m.result !== undefined || m.error !== undefined);
const notification = (method) => (m) => m.method === method;

async function main() {
  // 1) initialize
  // Pass the fixture directory as the sole trusted workspace root so the server performs project
  // discovery / MSBuild evaluation for the in-root fixture (matching the real client, which sends
  // its workspace folders as initializationOptions.allowedRoots).
  const allowedRoots = [dirname(XAML)];
  send({
    id: 1,
    method: "initialize",
    params: { processId: process.pid, rootUri: null, initializationOptions: { allowedRoots } },
  });
  const init = await waitFor(responseFor(1), 15000, "initialize");
  if (init.error) fail(`initialize errored: ${JSON.stringify(init.error)}`);
  const caps = init.result?.capabilities ?? {};
  if (caps.definitionProvider !== true) fail("server did not advertise definitionProvider");
  if (caps.hoverProvider !== true) fail("server did not advertise hoverProvider");
  if (!caps.completionProvider) fail("server did not advertise completionProvider");
  if (caps.documentSymbolProvider !== true) fail("server did not advertise documentSymbolProvider");
  if (caps.textDocumentSync?.openClose !== true) fail("server did not advertise openClose sync");
  console.log("[ok] initialize: definition + hover + completion + documentSymbol + openClose advertised");

  send({ method: "initialized", params: {} });

  // 2) didOpen -> expect diagnostics (0 for the clean fixture)
  const diagPromise = waitFor(notification("textDocument/publishDiagnostics"), 15000, "publishDiagnostics");
  send({
    method: "textDocument/didOpen",
    params: { textDocument: { uri: xamlUri, languageId: "xaml", version: 1, text: xamlText } },
  });
  const diag = await diagPromise;
  if (diag.params.uri !== xamlUri) fail("diagnostics were for the wrong document");
  if (!Array.isArray(diag.params.diagnostics)) fail("diagnostics payload is not an array");
  if (diag.params.diagnostics.length !== 0) {
    fail(`expected 0 diagnostics for the clean fixture, got ${diag.params.diagnostics.length}`);
  }
  console.log("[ok] didOpen: 0 syntactic diagnostics for the valid fixture");

  // 3) definition (F12) on OnGo_Click -> C# code-behind (first call pays the design-time build cost)
  console.log(`[..] definition at ${caret.line}:${caret.character} (loading project, ~several s)`);
  send({
    id: 2,
    method: "textDocument/definition",
    params: { textDocument: { uri: xamlUri }, position: caret },
  });
  const def = await waitFor(responseFor(2), 90000, "definition");
  if (def.error) fail(`definition errored: ${JSON.stringify(def.error)}`);
  const loc = def.result;
  if (!loc || !loc.uri) fail(`definition returned no location: ${JSON.stringify(loc)}`);
  if (!loc.uri.toLowerCase().endsWith(EXPECTED_CODE_BEHIND)) {
    fail(`definition landed in unexpected file: ${loc.uri}`);
  }
  if (loc.range?.start?.line !== EXPECTED_HANDLER_LINE) {
    fail(`definition landed on line ${loc.range?.start?.line}, expected ${EXPECTED_HANDLER_LINE}`);
  }
  console.log(`[ok] definition: OnGo_Click -> ${loc.uri} @ line ${loc.range.start.line}`);

  // 4) definition (F12) on the {x:Bind GreetingText} path -> the GreetingText property (project cached now)
  send({
    id: 3,
    method: "textDocument/definition",
    params: { textDocument: { uri: xamlUri }, position: bindCaret },
  });
  const bindDef = await waitFor(responseFor(3), 30000, "x:Bind definition");
  if (bindDef.error) fail(`x:Bind definition errored: ${JSON.stringify(bindDef.error)}`);
  const bindLoc = bindDef.result;
  if (!bindLoc || !bindLoc.uri) fail(`x:Bind definition returned no location: ${JSON.stringify(bindLoc)}`);
  if (!bindLoc.uri.toLowerCase().endsWith(EXPECTED_CODE_BEHIND)) {
    fail(`x:Bind definition landed in unexpected file: ${bindLoc.uri}`);
  }
  if (bindLoc.range?.start?.line !== EXPECTED_GREETING_LINE) {
    fail(`x:Bind definition landed on line ${bindLoc.range?.start?.line}, expected ${EXPECTED_GREETING_LINE}`);
  }
  console.log(`[ok] definition: {x:Bind GreetingText} -> ${bindLoc.uri} @ line ${bindLoc.range.start.line}`);

  // 4b) definition (F12) on {StaticResource SmokeAccentBrush} -> the x:Key declaration in App.xaml
  //     (cross-file resource navigation: not declared locally, so it resolves through the project).
  send({
    id: 5,
    method: "textDocument/definition",
    params: { textDocument: { uri: xamlUri }, position: resCaret },
  });
  const resDef = await waitFor(responseFor(5), 30000, "resource-key definition");
  if (resDef.error) fail(`resource-key definition errored: ${JSON.stringify(resDef.error)}`);
  const resLoc = resDef.result;
  if (!resLoc || !resLoc.uri) fail(`resource-key definition returned no location: ${JSON.stringify(resLoc)}`);
  if (!resLoc.uri.toLowerCase().endsWith(EXPECTED_APP_XAML)) {
    fail(`resource-key definition landed in unexpected file: ${resLoc.uri}`);
  }
  if (resLoc.range?.start?.line !== EXPECTED_ACCENT_KEY_LINE) {
    fail(`resource-key definition landed on line ${resLoc.range?.start?.line}, expected ${EXPECTED_ACCENT_KEY_LINE}`);
  }
  console.log(`[ok] definition: {StaticResource SmokeAccentBrush} -> ${resLoc.uri} @ line ${resLoc.range.start.line}`);

  // 4c) hover on {StaticResource SmokeAccentBrush} -> the resource's type + where it is declared
  send({
    id: 6,
    method: "textDocument/hover",
    params: { textDocument: { uri: xamlUri }, position: resCaret },
  });
  const resHover = await waitFor(responseFor(6), 30000, "resource-key hover");
  if (resHover.error) fail(`resource-key hover errored: ${JSON.stringify(resHover.error)}`);
  const resHoverText = resHover.result?.contents?.value;
  if (typeof resHoverText !== "string") fail(`resource-key hover returned no content: ${JSON.stringify(resHover.result)}`);
  for (const needle of ["SolidColorBrush", "SmokeAccentBrush", "App.xaml"]) {
    if (!resHoverText.includes(needle)) fail(`resource-key hover missing '${needle}': ${resHoverText}`);
  }
  console.log(`[ok] hover(resource): {StaticResource SmokeAccentBrush} -> ${resHoverText.replace(/\n/g, " ").trim()}`);

  // 5) hover on OnGo_Click -> a csharp signature block mentioning the member
  send({
    id: 4,
    method: "textDocument/hover",
    params: { textDocument: { uri: xamlUri }, position: caret },
  });
  const hover = await waitFor(responseFor(4), 30000, "hover");
  if (hover.error) fail(`hover errored: ${JSON.stringify(hover.error)}`);
  const contents = hover.result?.contents;
  if (!contents || typeof contents.value !== "string") {
    fail(`hover returned no markup content: ${JSON.stringify(hover.result)}`);
  }
  if (!contents.value.includes("OnGo_Click")) {
    fail(`hover did not mention the member: ${contents.value}`);
  }
  if (!contents.value.includes("```")) {
    fail(`hover was not a fenced code block: ${contents.value}`);
  }
  console.log(`[ok] hover: OnGo_Click -> ${contents.value.replace(/\n/g, " ").trim()}`);

  // 6-8) completion in three contexts. We drive completion on doctored in-memory text (sent via
  //      didChange) for the fixture URI, so the type system is the real WinUI project.
  const NS =
    'xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" ' +
    'xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"';
  let version = 2;

  async function completeWith(id, body, label) {
    const markerIdx = body.indexOf("|");
    if (markerIdx < 0) fail(`completion doc for ${label} has no caret marker`);
    const text = body.slice(0, markerIdx) + body.slice(markerIdx + 1);
    const pos = offsetToPosition(text, markerIdx);
    send({
      method: "textDocument/didChange",
      params: { textDocument: { uri: xamlUri, version: ++version }, contentChanges: [{ text }] },
    });
    send({ id, method: "textDocument/completion", params: { textDocument: { uri: xamlUri }, position: pos } });
    const res = await waitFor(responseFor(id), 30000, `completion ${label}`);
    if (res.error) fail(`completion ${label} errored: ${JSON.stringify(res.error)}`);
    const items = Array.isArray(res.result) ? res.result : res.result?.items;
    if (!Array.isArray(items)) fail(`completion ${label} returned no items: ${JSON.stringify(res.result)}`);
    return items.map((i) => i.label);
  }

  // Like completeWith but returns the full completion items (label + textEdit), so close-tag
  // completion can assert the inserted text (name, and whether a '>' is appended).
  async function completeItemsWith(id, body, label) {
    const markerIdx = body.indexOf("|");
    if (markerIdx < 0) fail(`completion doc for ${label} has no caret marker`);
    const text = body.slice(0, markerIdx) + body.slice(markerIdx + 1);
    const pos = offsetToPosition(text, markerIdx);
    send({
      method: "textDocument/didChange",
      params: { textDocument: { uri: xamlUri, version: ++version }, contentChanges: [{ text }] },
    });
    send({ id, method: "textDocument/completion", params: { textDocument: { uri: xamlUri }, position: pos } });
    const res = await waitFor(responseFor(id), 30000, `completion ${label}`);
    if (res.error) fail(`completion ${label} errored: ${JSON.stringify(res.error)}`);
    const items = Array.isArray(res.result) ? res.result : res.result?.items;
    if (!Array.isArray(items)) fail(`completion ${label} returned no items: ${JSON.stringify(res.result)}`);
    return items;
  }

  // Hover at a caret marker in doctored in-memory text; returns the markdown string (or "").
  async function hoverAt(id, body, label) {
    const markerIdx = body.indexOf("|");
    if (markerIdx < 0) fail(`hover doc for ${label} has no caret marker`);
    const text = body.slice(0, markerIdx) + body.slice(markerIdx + 1);
    const pos = offsetToPosition(text, markerIdx);
    send({
      method: "textDocument/didChange",
      params: { textDocument: { uri: xamlUri, version: ++version }, contentChanges: [{ text }] },
    });
    send({ id, method: "textDocument/hover", params: { textDocument: { uri: xamlUri }, position: pos } });
    const res = await waitFor(responseFor(id), 30000, `hover ${label}`);
    if (res.error) fail(`hover ${label} errored: ${JSON.stringify(res.error)}`);
    return res.result?.contents?.value ?? "";
  }

  // F12 at a caret marker in doctored in-memory text; returns the first location (or null).
  async function definitionWith(id, body, label) {
    const markerIdx = body.indexOf("|");
    if (markerIdx < 0) fail(`definition doc for ${label} has no caret marker`);
    const text = body.slice(0, markerIdx) + body.slice(markerIdx + 1);
    const pos = offsetToPosition(text, markerIdx);
    send({
      method: "textDocument/didChange",
      params: { textDocument: { uri: xamlUri, version: ++version }, contentChanges: [{ text }] },
    });
    send({ id, method: "textDocument/definition", params: { textDocument: { uri: xamlUri }, position: pos } });
    const res = await waitFor(responseFor(id), 30000, `definition ${label}`);
    if (res.error) fail(`definition ${label} errored: ${JSON.stringify(res.error)}`);
    return (Array.isArray(res.result) ? res.result[0] : res.result) ?? null;
  }

  // Position-driven code actions at a caret marker in doctored in-memory text (no diagnostic required) —
  // for the gap #3 "Generate event handler 'X'" quick fix. Returns the raw action array.
  async function codeActionAtCaret(id, body, label) {
    const markerIdx = body.indexOf("|");
    if (markerIdx < 0) fail(`codeAction doc for ${label} has no caret marker`);
    const text = body.slice(0, markerIdx) + body.slice(markerIdx + 1);
    const pos = offsetToPosition(text, markerIdx);
    send({
      method: "textDocument/didChange",
      params: { textDocument: { uri: xamlUri, version: ++version }, contentChanges: [{ text }] },
    });
    send({
      id,
      method: "textDocument/codeAction",
      params: { textDocument: { uri: xamlUri }, range: { start: pos, end: pos }, context: { diagnostics: [] } },
    });
    const res = await waitFor(responseFor(id), 30000, `codeAction ${label}`);
    if (res.error) fail(`codeAction ${label} errored: ${JSON.stringify(res.error)}`);
    return Array.isArray(res.result) ? res.result : [];
  }

  // Maps an LSP Position back to a 0-based character offset in `text` (LF-based; smoke bodies use LF).
  function positionToOffset(text, pos) {
    const lines = text.split("\n");
    let offset = 0;
    for (let i = 0; i < pos.line; i++) offset += lines[i].length + 1;
    return offset + pos.character;
  }

  // Find All References at a caret marker in doctored in-memory text. Returns { locations, texts }
  // where texts[i] is the substring the returned range covers (so assertions never hardcode positions).
  async function referencesWith(id, body, label, includeDeclaration = true) {
    const markerIdx = body.indexOf("|");
    if (markerIdx < 0) fail(`references doc for ${label} has no caret marker`);
    const text = body.slice(0, markerIdx) + body.slice(markerIdx + 1);
    const pos = offsetToPosition(text, markerIdx);
    send({
      method: "textDocument/didChange",
      params: { textDocument: { uri: xamlUri, version: ++version }, contentChanges: [{ text }] },
    });
    send({
      id,
      method: "textDocument/references",
      params: { textDocument: { uri: xamlUri }, position: pos, context: { includeDeclaration } },
    });
    const res = await waitFor(responseFor(id), 30000, `references ${label}`);
    if (res.error) fail(`references ${label} errored: ${JSON.stringify(res.error)}`);
    const locations = Array.isArray(res.result) ? res.result : [];
    const texts = locations.map((l) =>
      text.slice(positionToOffset(text, l.range.start), positionToOffset(text, l.range.end)));
    return { locations, texts };
  }

  // Document Highlights at a caret marker. Returns { highlights, texts, kinds } where texts[i] is the
  // covered substring and kinds[i] is the highlight kind (2=Read usage, 3=Write declaration).
  async function highlightWith(id, body, label) {
    const markerIdx = body.indexOf("|");
    if (markerIdx < 0) fail(`highlight doc for ${label} has no caret marker`);
    const text = body.slice(0, markerIdx) + body.slice(markerIdx + 1);
    const pos = offsetToPosition(text, markerIdx);
    send({
      method: "textDocument/didChange",
      params: { textDocument: { uri: xamlUri, version: ++version }, contentChanges: [{ text }] },
    });
    send({ id, method: "textDocument/documentHighlight", params: { textDocument: { uri: xamlUri }, position: pos } });
    const res = await waitFor(responseFor(id), 30000, `highlight ${label}`);
    if (res.error) fail(`highlight ${label} errored: ${JSON.stringify(res.error)}`);
    const highlights = Array.isArray(res.result) ? res.result : [];
    const texts = highlights.map((h) =>
      text.slice(positionToOffset(text, h.range.start), positionToOffset(text, h.range.end)));
    const kinds = highlights.map((h) => h.kind);
    return { highlights, texts, kinds };
  }

  // Applies LSP TextEdits to `text` (edits are non-overlapping; apply right-to-left to keep offsets valid).
  function applyEdits(text, edits) {
    const ordered = edits
      .map((e) => ({ start: positionToOffset(text, e.range.start), end: positionToOffset(text, e.range.end), newText: e.newText }))
      .sort((a, b) => b.start - a.start);
    let out = text;
    for (const e of ordered) out = out.slice(0, e.start) + e.newText + out.slice(e.end);
    return out;
  }

  // Format Document over in-memory text. Returns { edits, formatted } (the edits applied to `body`).
  async function formatWith(id, body, label, options = { tabSize: 2, insertSpaces: true }) {
    send({
      method: "textDocument/didChange",
      params: { textDocument: { uri: xamlUri, version: ++version }, contentChanges: [{ text: body }] },
    });
    send({ id, method: "textDocument/formatting", params: { textDocument: { uri: xamlUri }, options } });
    const res = await waitFor(responseFor(id), 30000, `formatting ${label}`);
    if (res.error) fail(`formatting ${label} errored: ${JSON.stringify(res.error)}`);
    const edits = Array.isArray(res.result) ? res.result : [];
    return { edits, formatted: applyEdits(body, edits) };
  }

  // Folding: send the body then request textDocument/foldingRange. Returns the FoldingRange[].
  async function foldingWith(id, body, label) {
    send({
      method: "textDocument/didChange",
      params: { textDocument: { uri: xamlUri, version: ++version }, contentChanges: [{ text: body }] },
    });
    send({ id, method: "textDocument/foldingRange", params: { textDocument: { uri: xamlUri } } });
    const res = await waitFor(responseFor(id), 30000, `foldingRange ${label}`);
    if (res.error) fail(`foldingRange ${label} errored: ${JSON.stringify(res.error)}`);
    return Array.isArray(res.result) ? res.result : [];
  }

  async function documentColorWith(id, body, label) {
    send({
      method: "textDocument/didChange",
      params: { textDocument: { uri: xamlUri, version: ++version }, contentChanges: [{ text: body }] },
    });
    send({ id, method: "textDocument/documentColor", params: { textDocument: { uri: xamlUri } } });
    const res = await waitFor(responseFor(id), 30000, `documentColor ${label}`);
    if (res.error) fail(`documentColor ${label} errored: ${JSON.stringify(res.error)}`);
    return Array.isArray(res.result) ? res.result : [];
  }

  async function colorPresentationWith(id, color, range, label) {
    send({
      id,
      method: "textDocument/colorPresentation",
      params: { textDocument: { uri: xamlUri }, color, range },
    });
    const res = await waitFor(responseFor(id), 30000, `colorPresentation ${label}`);
    if (res.error) fail(`colorPresentation ${label} errored: ${JSON.stringify(res.error)}`);
    return Array.isArray(res.result) ? res.result : [];
  }

  async function selectionRangeWith(id, body, positions, label) {
    send({
      method: "textDocument/didChange",
      params: { textDocument: { uri: xamlUri, version: ++version }, contentChanges: [{ text: body }] },
    });
    send({ id, method: "textDocument/selectionRange", params: { textDocument: { uri: xamlUri }, positions } });
    const res = await waitFor(responseFor(id), 30000, `selectionRange ${label}`);
    if (res.error) fail(`selectionRange ${label} errored: ${JSON.stringify(res.error)}`);
    return Array.isArray(res.result) ? res.result : [];
  }

  async function linkedEditingWith(id, body, position, label) {
    send({
      method: "textDocument/didChange",
      params: { textDocument: { uri: xamlUri, version: ++version }, contentChanges: [{ text: body }] },
    });
    send({ id, method: "textDocument/linkedEditingRange", params: { textDocument: { uri: xamlUri }, position } });
    const res = await waitFor(responseFor(id), 30000, `linkedEditingRange ${label}`);
    if (res.error) fail(`linkedEditingRange ${label} errored: ${JSON.stringify(res.error)}`);
    return res.result; // LinkedEditingRanges | null
  }

  async function documentLinkWith(id, body, label) {
    send({
      method: "textDocument/didChange",
      params: { textDocument: { uri: xamlUri, version: ++version }, contentChanges: [{ text: body }] },
    });
    send({ id, method: "textDocument/documentLink", params: { textDocument: { uri: xamlUri } } });
    const res = await waitFor(responseFor(id), 30000, `documentLink ${label}`);
    if (res.error) fail(`documentLink ${label} errored: ${JSON.stringify(res.error)}`);
    return Array.isArray(res.result) ? res.result : [];
  }

  async function prepareRenameWith(id, body, position, label) {
    send({
      method: "textDocument/didChange",
      params: { textDocument: { uri: xamlUri, version: ++version }, contentChanges: [{ text: body }] },
    });
    send({ id, method: "textDocument/prepareRename", params: { textDocument: { uri: xamlUri }, position } });
    const res = await waitFor(responseFor(id), 30000, `prepareRename ${label}`);
    if (res.error) fail(`prepareRename ${label} errored: ${JSON.stringify(res.error)}`);
    return res.result; // { range, placeholder } | null
  }

  async function renameWith(id, body, position, newName, label) {
    send({
      method: "textDocument/didChange",
      params: { textDocument: { uri: xamlUri, version: ++version }, contentChanges: [{ text: body }] },
    });
    send({ id, method: "textDocument/rename", params: { textDocument: { uri: xamlUri }, position, newName } });
    const res = await waitFor(responseFor(id), 30000, `rename ${label}`);
    return res; // { result } | { error }
  }

  async function semanticTokensWith(id, body, label) {
    send({
      method: "textDocument/didChange",
      params: { textDocument: { uri: xamlUri, version: ++version }, contentChanges: [{ text: body }] },
    });
    send({ id, method: "textDocument/semanticTokens/full", params: { textDocument: { uri: xamlUri } } });
    const res = await waitFor(responseFor(id), 30000, `semanticTokens ${label}`);
    if (res.error) fail(`semanticTokens ${label} errored: ${JSON.stringify(res.error)}`);
    return res.result && Array.isArray(res.result.data) ? res.result.data : [];
  }

  async function semanticTokensRangeWith(id, body, range, label) {
    send({
      method: "textDocument/didChange",
      params: { textDocument: { uri: xamlUri, version: ++version }, contentChanges: [{ text: body }] },
    });
    send({ id, method: "textDocument/semanticTokens/range", params: { textDocument: { uri: xamlUri }, range } });
    const res = await waitFor(responseFor(id), 30000, `semanticTokens/range ${label}`);
    if (res.error) fail(`semanticTokens/range ${label} errored: ${JSON.stringify(res.error)}`);
    return res.result && Array.isArray(res.result.data) ? res.result.data : [];
  }

  // Decode the LSP flat 5-int stream into {type, covered, modifiers} tokens against the given source lines.
  function decodeSemanticTokens(data, lines, legend) {
    if (data.length % 5 !== 0) fail(`semanticTokens: data length must be a multiple of 5, got ${data.length}`);
    const toks = [];
    let line = 0;
    let ch = 0;
    for (let i = 0; i < data.length; i += 5) {
      const dl = data[i];
      const dc = data[i + 1];
      const len = data[i + 2];
      const ty = data[i + 3];
      const mod = data[i + 4];
      if (dl === 0) ch += dc;
      else {
        line += dl;
        ch = dc;
      }
      if (ty < 0 || ty >= legend.length) fail(`semanticTokens: type index ${ty} out of range`);
      toks.push({ type: legend[ty], covered: lines[line].slice(ch, ch + len), modifiers: mod, line, char: ch });
    }
    return toks;
  }

  // Code actions: replay a diagnostic (with its round-tripped .data) back to textDocument/codeAction over
  // its own range. The doc is expected to already hold the buffer that produced the diagnostic (set by an
  // earlier validateDoc), so we only issue the request. Returns the CodeAction[].
  async function codeActionWith(id, diagnostic, label) {
    send({
      id,
      method: "textDocument/codeAction",
      params: {
        textDocument: { uri: xamlUri },
        range: diagnostic.range,
        context: { diagnostics: [diagnostic] },
      },
    });
    const res = await waitFor(responseFor(id), 30000, `codeAction ${label}`);
    if (res.error) fail(`codeAction ${label} errored: ${JSON.stringify(res.error)}`);
    return Array.isArray(res.result) ? res.result : [];
  }

  const elementLabels = await completeWith(5, `<Page ${NS}>\n  <But|\n</Page>`, "element-name");
  for (const want of ["Button"]) {
    if (!elementLabels.includes(want)) fail(`element completion missing '${want}' (got ${elementLabels.length} items)`);
  }
  console.log(`[ok] completion(element): '<But' -> Button (${elementLabels.length} items)`);

  const attrLabels = await completeWith(6, `<Page ${NS}>\n  <Button |\n</Page>`, "attribute-name");
  for (const want of ["Content", "Click", "IsEnabled"]) {
    if (!attrLabels.includes(want)) fail(`attribute completion missing '${want}' (got ${attrLabels.length} items)`);
  }
  console.log(`[ok] completion(attribute): '<Button ' -> Content/Click/IsEnabled (${attrLabels.length} items)`);

  const attachedLabels = await completeWith(7, `<Page ${NS}>\n  <Button Grid.|\n</Page>`, "attached-property");
  for (const want of ["Grid.Row", "Grid.Column"]) {
    if (!attachedLabels.includes(want)) fail(`attached-property completion missing '${want}' (got ${attachedLabels.length} items)`);
  }
  console.log(`[ok] completion(attached): '<Button Grid.' -> Grid.Row/Grid.Column (${attachedLabels.length} items)`);

  // 9) value completion: enum-typed attribute -> enum members.
  const enumLabels = await completeWith(8, `<Page ${NS}>\n  <Button HorizontalAlignment="|" />\n</Page>`, "enum-value");
  for (const want of ["Left", "Center", "Right", "Stretch"]) {
    if (!enumLabels.includes(want)) fail(`enum value completion missing '${want}' (got ${enumLabels.join(",")})`);
  }
  console.log(`[ok] completion(enum): 'HorizontalAlignment="' -> Left/Center/Right/Stretch (${enumLabels.length} items)`);

  // 10) value completion: enum members filter by the partial already typed.
  const enumPartial = await completeWith(9, `<Page ${NS}>\n  <Button HorizontalAlignment="C|" />\n</Page>`, "enum-value-partial");
  if (!enumPartial.includes("Center")) fail(`enum partial completion missing 'Center' (got ${enumPartial.join(",")})`);
  if (enumPartial.includes("Left")) fail(`enum partial completion should have filtered out 'Left' (got ${enumPartial.join(",")})`);
  console.log(`[ok] completion(enum, partial 'C'): -> Center, not Left (${enumPartial.length} items)`);

  // 11) value completion: boolean-typed attribute -> True/False.
  const boolLabels = await completeWith(10, `<Page ${NS}>\n  <Button IsEnabled="|" />\n</Page>`, "bool-value");
  for (const want of ["True", "False"]) {
    if (!boolLabels.includes(want)) fail(`bool value completion missing '${want}' (got ${boolLabels.join(",")})`);
  }
  console.log(`[ok] completion(bool): 'IsEnabled="' -> True/False (${boolLabels.length} items)`);

  // 12) x:Bind member-path completion: members of the page's x:Class (SmokePage), filtered by partial.
  //     pageClass is resolved from the real SmokePage.xaml on disk, so the doctored wrapper is fine.
  const bindLabels = await completeWith(20, `<Page ${NS}>\n  <TextBlock Text="{x:Bind Gre|}" />\n</Page>`, "bind-path");
  if (!bindLabels.includes("GreetingText")) fail(`x:Bind path completion missing 'GreetingText' (got ${bindLabels.join(",")})`);
  if (bindLabels.includes("Items")) fail(`x:Bind path completion with partial 'Gre' should have filtered out 'Items' (got ${bindLabels.join(",")})`);
  console.log(`[ok] completion(x:Bind, 'Gre'): -> GreetingText, not Items (${bindLabels.length} items)`);

  // 13) x:Bind with an empty path -> all bindable members of the page.
  const bindAll = await completeWith(21, `<Page ${NS}>\n  <TextBlock Text="{x:Bind |}" />\n</Page>`, "bind-path-empty");
  for (const want of ["GreetingText", "Items"]) {
    if (!bindAll.includes(want)) fail(`x:Bind empty-path completion missing '${want}' (got ${bindAll.length} items)`);
  }
  console.log(`[ok] completion(x:Bind, ''): -> GreetingText + Items (${bindAll.length} items)`);

  // 14) x:Bind dotted path -> members of the leading segment's type. Items is IReadOnlyList<string>,
  //     so 'Items.' must surface Count (found by walking the interface's inherited interfaces).
  const bindDotted = await completeWith(22, `<Page ${NS}>\n  <TextBlock Text="{x:Bind Items.C|}" />\n</Page>`, "bind-path-dotted");
  if (!bindDotted.includes("Count")) fail(`x:Bind dotted-path completion missing 'Count' (got ${bindDotted.join(",")})`);
  console.log(`[ok] completion(x:Bind, 'Items.C'): -> Count (${bindDotted.length} items)`);

  // 14a) element completion inside a collection property element is scoped to the collection's item
  //      type: <Grid.RowDefinitions> offers RowDefinition, not the full control list.
  const propChild = await completeWith(43, `<Page ${NS}>\n  <Grid>\n    <Grid.RowDefinitions>\n      <|\n    </Grid.RowDefinitions>\n  </Grid>\n</Page>`, "property-element-child");
  if (!propChild.includes("RowDefinition")) fail(`property-element child completion missing 'RowDefinition' (got ${propChild.slice(0, 40).join(",")})`);
  if (propChild.includes("Button")) fail(`property-element child completion should be scoped to RowDefinition, not offer 'Button' (got ${propChild.length} items)`);
  console.log(`[ok] completion(property element): '<Grid.RowDefinitions><' -> RowDefinition, scoped (${propChild.length} items)`);

  // 14b) nested markup extension: {Binding Source={StaticResource |}} completes resource keys for the
  //      INNER StaticResource, not the outer Binding.
  const nestedRes = await completeWith(44, `<Page ${NS}>\n  <Border Tag="{Binding Source={StaticResource |}}" />\n</Page>`, "nested-resource");
  if (!nestedRes.includes("SmokeAccentBrush")) fail(`nested StaticResource completion missing 'SmokeAccentBrush' (got ${nestedRes.slice(0, 40).join(",")})`);
  console.log(`[ok] completion(nested markup): '{Binding Source={StaticResource ' -> SmokeAccentBrush (${nestedRes.length} items)`);

  // 14c) element completion inside a CDATA section is suppressed (no leak of element names).
  const cdataItems = await completeWith(45, `<Page ${NS}>\n  <Grid>\n    <![CDATA[ <But| ]]>\n  </Grid>\n</Page>`, "cdata-suppression");
  if (cdataItems.includes("Button")) fail(`completion inside CDATA must not offer 'Button' (got ${cdataItems.slice(0, 20).join(",")})`);
  console.log(`[ok] completion(cdata): '<![CDATA[ <But' -> no element completions (${cdataItems.length} items)`);

  // 15) Style/ControlTemplate authoring completion (VS parity).
  const pageRes = (inner) => `<Page ${NS}>\n  <Page.Resources>\n    ${inner}\n  </Page.Resources>\n</Page>`;

  // 15a) <Style TargetType="|"> completes type names (incl. alphabetically-late ones like TextBlock).
  const styleTt = await completeWith(46, pageRes(`<Style TargetType="|">\n      <Setter Property="Content" Value="Go" />\n    </Style>`), "style-targettype");
  if (!styleTt.includes("Button")) fail(`Style.TargetType completion missing 'Button' (got ${styleTt.length} items)`);
  if (!styleTt.includes("TextBlock")) fail(`Style.TargetType completion missing 'TextBlock' (dropped by item cap?) (got ${styleTt.length} items)`);
  console.log(`[ok] completion(Style.TargetType): '<Style TargetType="' -> Button + TextBlock (${styleTt.length} items)`);

  // 15b) <Setter Property="|"> completes settable properties of the enclosing TargetType.
  const setterProp = await completeWith(47, pageRes(`<Style TargetType="Button">\n      <Setter Property="|" Value="Go" />\n    </Style>`), "setter-property");
  if (!setterProp.includes("Content")) fail(`Setter.Property completion missing Button 'Content' (got ${setterProp.slice(0, 40).join(",")})`);
  if (!setterProp.includes("IsEnabled")) fail(`Setter.Property completion missing Button 'IsEnabled'`);
  if (setterProp.includes("Button")) fail(`Setter.Property should offer properties, not types (unexpected 'Button')`);
  console.log(`[ok] completion(Setter.Property): '<Setter Property="' -> Content/IsEnabled scoped to Button (${setterProp.length} items)`);

  // 15c) <ControlTemplate TargetType="|"> completes type names.
  const ctTt = await completeWith(48, pageRes(`<ControlTemplate TargetType="|">\n      <Grid />\n    </ControlTemplate>`), "controltemplate-targettype");
  if (!ctTt.includes("Button")) fail(`ControlTemplate.TargetType completion missing 'Button' (got ${ctTt.length} items)`);
  console.log(`[ok] completion(ControlTemplate.TargetType): -> Button (${ctTt.length} items)`);

  // 16) Round-4 regressions: Setter.Value enum/bool, TemplateBinding, TargetType F12, Setter.Property hover.
  const dLocal = 'xmlns:local="using:SmokeFixture"';
  const sv1 = await completeWith(95, pageRes(`<Style TargetType="Button">\n      <Setter Property="HorizontalAlignment" Value="|" />\n    </Style>`), "setterval-enum");
  for (const want of ["Center", "Stretch"]) {
    if (!sv1.includes(want)) fail(`Setter.Value(enum) missing '${want}' (got ${sv1.length} items)`);
  }
  console.log(`[ok] completion(Setter.Value enum): -> Center/Stretch (${sv1.length} items)`);

  const sv2 = await completeWith(96, pageRes(`<Style TargetType="Button">\n      <Setter Property="IsEnabled" Value="|" />\n    </Style>`), "setterval-bool");
  for (const want of ["True", "False"]) {
    if (!sv2.includes(want)) fail(`Setter.Value(bool) missing '${want}' (got ${sv2.length} items)`);
  }
  console.log(`[ok] completion(Setter.Value bool): -> True/False (${sv2.length} items)`);

  const tb = await completeWith(97, pageRes(`<ControlTemplate TargetType="Button">\n      <ContentPresenter Content="{TemplateBinding |}" />\n    </ControlTemplate>`), "templatebinding");
  for (const want of ["Content", "IsEnabled"]) {
    if (!tb.includes(want)) fail(`TemplateBinding completion missing '${want}' (got ${tb.length} items)`);
  }
  console.log(`[ok] completion(TemplateBinding): -> Content/IsEnabled (${tb.length} items)`);

  const ttDef = await definitionWith(98, `<Page ${NS} ${dLocal}>\n  <Page.Resources>\n    <Style TargetType="local:Smoke|Page">\n      <Setter Property="DataContext" Value="{x:Null}" />\n    </Style>\n  </Page.Resources>\n</Page>`, "targettype-f12");
  if (!ttDef?.uri || !ttDef.uri.endsWith("SmokePage.xaml.cs")) {
    fail(`TargetType F12 did not land on SmokePage.xaml.cs (got ${ttDef?.uri ?? "null"})`);
  }
  console.log(`[ok] definition(TargetType user type): local:SmokePage -> SmokePage.xaml.cs`);

  const spHover = await hoverAt(99, pageRes(`<Style TargetType="Button">\n      <Setter Property="Cont|ent" Value="Go" />\n    </Style>`), "setterprop-hover");
  if (!/Content/.test(spHover) || !/ContentControl/.test(spHover)) {
    fail(`Setter.Property hover did not resolve to ContentControl.Content (got ${JSON.stringify(spHover)})`);
  }
  console.log(`[ok] hover(Setter.Property): Content -> ContentControl.Content`);

  // 17) Round-5 regressions: RelativeSource arg-name/Mode, event-handler value, x:DataType F12.
  const pageCls = (inner) => `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
  const rs1 = await completeWith(190, pageCls(`<Border Tag="{RelativeSource |}" />`), "relativesource-argname");
  if (!rs1.includes("Mode")) fail(`RelativeSource arg-name completion missing 'Mode' (got ${rs1.join(",")})`);
  console.log(`[ok] completion(RelativeSource arg name): -> Mode (${rs1.length} items)`);

  const rs2 = await completeWith(191, pageCls(`<Border Tag="{RelativeSource Mode=|}" />`), "relativesource-mode");
  for (const want of ["Self", "TemplatedParent"]) {
    if (!rs2.includes(want)) fail(`RelativeSource Mode completion missing '${want}' (got ${rs2.join(",")})`);
  }
  if (rs2.includes("OneWay")) fail(`RelativeSource Mode wrongly offered BindingMode value 'OneWay' (got ${rs2.join(",")})`);
  console.log(`[ok] completion(RelativeSource Mode): -> Self/TemplatedParent, not BindingMode (${rs2.length} items)`);

  const rs3 = await completeWith(192, pageCls(`<Border Tag="{Binding RelativeSource={RelativeSource Mode=|}}" />`), "relativesource-nested");
  for (const want of ["Self", "TemplatedParent"]) {
    if (!rs3.includes(want)) fail(`nested RelativeSource Mode completion missing '${want}' (got ${rs3.join(",")})`);
  }
  console.log(`[ok] completion(RelativeSource Mode, nested in Binding): -> Self/TemplatedParent (${rs3.length} items)`);

  const ev = await completeWith(193, pageCls(`<Button Click="|" />`), "event-handler");
  if (!ev.includes("OnGo_Click")) fail(`event-handler completion missing 'OnGo_Click' (got ${ev.join(",")})`);
  console.log(`[ok] completion(event handler Click=): -> OnGo_Click (${ev.length} items)`);

  const dtDef = await definitionWith(194, `<Page ${NS} ${dLocal}>\n  <ItemsRepeater>\n    <ItemsRepeater.ItemTemplate>\n      <DataTemplate x:DataType="local:Smoke|Page">\n        <TextBlock />\n      </DataTemplate>\n    </ItemsRepeater.ItemTemplate>\n  </ItemsRepeater>\n</Page>`, "datatype-f12");
  if (!dtDef?.uri || !dtDef.uri.endsWith("SmokePage.xaml.cs")) {
    fail(`x:DataType F12 did not land on SmokePage.xaml.cs (got ${dtDef?.uri ?? "null"})`);
  }
  console.log(`[ok] definition(x:DataType user type): local:SmokePage -> SmokePage.xaml.cs`);

  // Regression: x:Bind Mode= still resolves BindingMode (no extension type).
  const modeBind = await completeWith(195, pageCls(`<TextBlock Text="{x:Bind GreetingText, Mode=|}" />`), "xbind-mode");
  for (const want of ["OneWay", "TwoWay", "OneTime"]) {
    if (!modeBind.includes(want)) fail(`x:Bind Mode completion missing BindingMode '${want}' (got ${modeBind.join(",")})`);
  }
  console.log(`[ok] completion(x:Bind Mode): -> BindingMode preserved (${modeBind.length} items)`);

  // 18) Round-6 regressions: x:Bind method completion (private handlers), DataTemplate x:DataType scoping.
  const pageClsLocal = (inner) => `<Page ${NS} ${dLocal} x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
  const b1 = await completeWith(200, pageCls(`<Button Click="{x:Bind |}" />`), "xbind-event-page");
  if (!b1.includes("OnGo_Click")) fail(`x:Bind event completion (page) missing private 'OnGo_Click' (got ${b1.length} items)`);
  console.log(`[ok] completion(x:Bind event, page class): -> OnGo_Click (private handler surfaced, ${b1.length} items)`);

  const b2 = await completeWith(201, pageClsLocal(`<ItemsRepeater>\n    <ItemsRepeater.ItemTemplate>\n      <DataTemplate x:DataType="local:Page2">\n        <Button Click="{x:Bind |}" />\n      </DataTemplate>\n    </ItemsRepeater.ItemTemplate>\n  </ItemsRepeater>`), "xbind-event-template");
  if (!b2.includes("OnBack_Click")) fail(`x:Bind event completion (Page2 template) missing 'OnBack_Click' (got ${b2.length} items)`);
  if (b2.includes("OnGo_Click")) fail(`x:Bind in Page2 template wrongly offered SmokePage's 'OnGo_Click' (bad x:DataType scoping)`);
  console.log(`[ok] completion(x:Bind event, Page2 x:DataType): -> OnBack_Click, not SmokePage.OnGo_Click (${b2.length} items)`);

  const b3 = await definitionWith(202, pageClsLocal(`<ItemsRepeater>\n    <ItemsRepeater.ItemTemplate>\n      <DataTemplate x:DataType="local:Page2">\n        <Button Click="{x:Bind OnBack|_Click}" />\n      </DataTemplate>\n    </ItemsRepeater.ItemTemplate>\n  </ItemsRepeater>`), "xbind-f12-template");
  if (!b3?.uri || !b3.uri.endsWith("Page2.xaml.cs")) {
    fail(`x:Bind F12 in Page2 template did not land on Page2.xaml.cs (got ${b3?.uri ?? "null"})`);
  }
  console.log(`[ok] definition(x:Bind method, Page2 x:DataType): OnBack_Click -> Page2.xaml.cs`);

  // 18b) ROUND 76: a classic {Binding ElementName=Foo, Path=…} completes the NAMED element's members
  // (rooted at that element's TYPE), not the DataContext — previously it declined and offered nothing.
  const enBox = (path) => pageCls(`<StackPanel>\n    <TextBox x:Name="myBox" />\n    <TextBlock Text="${path}" />\n  </StackPanel>`);
  const en1 = await completeWith(503, enBox("{Binding ElementName=myBox, Path=|}"), "binding-elementname-path");
  for (const want of ["Text", "IsEnabled"]) {
    if (!en1.includes(want)) fail(`{Binding ElementName=myBox, Path=} should offer TextBox member '${want}' (got ${en1.slice(0, 40).join(",")})`);
  }
  if (en1.includes("GreetingText")) fail(`{Binding ElementName=myBox} must root at the TextBox, NOT the page DataContext (leaked 'GreetingText')`);
  console.log(`[ok] completion({Binding ElementName=myBox, Path=}): TextBox members, not page DataContext (${en1.length} items)`);

  // 18b-ii) a dotted path walks from the named element's member type (Text : string).
  const en2 = await completeWith(504, enBox("{Binding ElementName=myBox, Path=Text.|}"), "binding-elementname-dotted");
  if (!en2.includes("Length")) fail(`{Binding ElementName=myBox, Path=Text.} should offer string member 'Length' (got ${en2.slice(0, 40).join(",")})`);
  if (en2.includes("IsEnabled")) fail(`dotted path into Text:string must NOT still offer TextBox 'IsEnabled' (got ${en2.slice(0, 40).join(",")})`);
  console.log(`[ok] completion({Binding ElementName=myBox, Path=Text.}): string members, walked past TextBox (${en2.length} items)`);

  // 18b-iii) an unknown ElementName resolves to no type -> no members (never guesses).
  const en3 = await completeWith(505, enBox("{Binding ElementName=ghost, Path=|}"), "binding-elementname-unknown");
  if (en3.includes("Text") || en3.includes("IsEnabled")) fail(`unknown ElementName must offer no members (got ${en3.slice(0, 40).join(",")})`);
  console.log(`[ok] completion({Binding ElementName=ghost}): unknown element -> no members (${en3.length} items)`);

  // 18b-iv) a Source=/RelativeSource= redirect still declines (its target type isn't statically known here).
  const en4 = await completeWith(506, enBox("{Binding RelativeSource={RelativeSource Self}, Path=|}"), "binding-relativesource-declines");
  if (en4.includes("Text") || en4.includes("IsEnabled")) fail(`RelativeSource binding must still decline path completion (got ${en4.slice(0, 40).join(",")})`);
  console.log(`[ok] completion({Binding RelativeSource=…, Path=}): declines (unchanged) (${en4.length} items)`);

  // 18b-v) PRECEDENCE: a Source= redirector wins over a co-present ElementName= in BOTH arg orders
  // (the source's target type isn't statically known, so path completion must still decline).
  const enBoxAfter = (path) => pageCls(`<StackPanel>\n    <TextBlock Text="${path}" />\n    <TextBox x:Name="myBox" />\n  </StackPanel>`);
  const en5 = await completeWith(507, enBox("{Binding ElementName=myBox, Source={StaticResource SmokeAccentBrush}, Path=|}"), "binding-elementname-source-precedence");
  if (en5.includes("Text") || en5.includes("IsEnabled")) fail(`Source= must win over ElementName= (ElementName first): expected decline, got ${en5.slice(0, 40).join(",")}`);
  const en6 = await completeWith(508, enBox("{Binding Source={StaticResource SmokeAccentBrush}, ElementName=myBox, Path=|}"), "binding-source-elementname-precedence");
  if (en6.includes("Text") || en6.includes("IsEnabled")) fail(`Source= must win over ElementName= (Source first): expected decline, got ${en6.slice(0, 40).join(",")}`);
  console.log(`[ok] completion({Binding ElementName=…, Source=…, Path=}): Source wins -> declines in both orders`);

  // 18b-vi) FORWARD REFERENCE: the named element declared AFTER the binding still roots the path
  // (x:Name scope is the whole page, so ElementName resolution is order-independent).
  const en7 = await completeWith(509, enBoxAfter("{Binding ElementName=myBox, Path=|}"), "binding-elementname-forward-ref");
  for (const want of ["Text", "IsEnabled"]) {
    if (!en7.includes(want)) fail(`forward-referenced ElementName should offer TextBox member '${want}' (got ${en7.slice(0, 40).join(",")})`);
  }
  if (en7.includes("GreetingText")) fail(`forward-referenced ElementName must root at the TextBox, not the page (leaked 'GreetingText')`);
  console.log(`[ok] completion({Binding ElementName=myBox} declared after the binding): roots at the TextBox (${en7.length} items)`);

  // 18b-vii) a BARE POSITIONAL first arg that happens to be named like a redirector is a PATH, not a
  // redirector: {Binding Source} rooted at an Image x:DataType completes Image.Source (round-51 guard).
  const tmplImg = (path) => pageCls(`<ListView>\n    <ListView.ItemTemplate>\n      <DataTemplate x:DataType="Image">\n        <TextBlock Text="${path}" />\n      </DataTemplate>\n    </ListView.ItemTemplate>\n  </ListView>`);
  const en8 = await completeWith(510, tmplImg("{Binding Source|}"), "binding-bare-positional-source");
  if (!en8.includes("Source")) fail(`bare positional {Binding Source} should complete Image.Source as a path (got ${en8.slice(0, 40).join(",")})`);
  console.log(`[ok] completion({Binding Source} in Image template): bare positional is a path, not Source= (${en8.length} items)`);

  // 18c) ROUND 77: Storyboard.TargetProperty parenthesized (Owner.Property) qualifiers complete the
  // EXPLICIT owner type's members (instance DP + attached), independently of Storyboard.TargetName.
  const sb = (tp) => pageCls(`<StackPanel>\n    <Border x:Name="AttachedProbe" />\n    <Storyboard>\n      <DoubleAnimation Storyboard.TargetName="AttachedProbe" Storyboard.TargetProperty="${tp}" />\n    </Storyboard>\n  </StackPanel>`);
  // (i) instance DP of an explicit owner: (UIElement.Opac -> Opacity.
  const sp1 = await completeWith(511, sb("(UIElement.Opac|"), "sb-paren-instance-dp");
  if (!sp1.includes("Opacity")) fail(`(UIElement.Opac should complete instance DP 'Opacity' (got ${sp1.slice(0, 40).join(",")})`);
  console.log(`[ok] completion(Storyboard.TargetProperty '(UIElement.Opac'): -> Opacity (${sp1.length} items)`);
  // (ii) attached properties of an explicit owner: (Canvas. -> Left/Top/ZIndex.
  const sp2 = await completeWith(512, sb("(Canvas.|"), "sb-paren-attached");
  for (const want of ["Left", "Top"]) {
    if (!sp2.includes(want)) fail(`(Canvas. should complete attached property '${want}' (got ${sp2.slice(0, 40).join(",")})`);
  }
  console.log(`[ok] completion(Storyboard.TargetProperty '(Canvas.'): -> attached Left/Top (${sp2.length} items)`);
  // (iii) attached filter: (Canvas.Le -> Left only, not Top.
  const sp3 = await completeWith(513, sb("(Canvas.Le|"), "sb-paren-attached-filter");
  if (!sp3.includes("Left")) fail(`(Canvas.Le should complete 'Left' (got ${sp3.slice(0, 40).join(",")})`);
  if (sp3.includes("Top")) fail(`(Canvas.Le should filter OUT 'Top' (got ${sp3.slice(0, 40).join(",")})`);
  console.log(`[ok] completion(Storyboard.TargetProperty '(Canvas.Le'): -> Left only (${sp3.length} items)`);
  // (iv) chained transform group: (UIElement.RenderTransform).(CompositeTransform.Trans -> TranslateX/Y.
  const sp4 = await completeWith(514, sb("(UIElement.RenderTransform).(CompositeTransform.Trans|"), "sb-paren-chained");
  if (!sp4.includes("TranslateX")) fail(`chained (…).(CompositeTransform.Trans should complete 'TranslateX' (got ${sp4.slice(0, 40).join(",")})`);
  console.log(`[ok] completion(Storyboard.TargetProperty chained CompositeTransform.Trans): -> TranslateX (${sp4.length} items)`);
  // (v) simple (non-parenthesized) path still roots at the TargetName element (regression): Border.Opac.
  const sp5 = await completeWith(515, sb("Opac|"), "sb-simple-roots-at-target");
  if (!sp5.includes("Opacity")) fail(`simple TargetProperty 'Opac' should root at the Border target -> 'Opacity' (got ${sp5.slice(0, 40).join(",")})`);
  console.log(`[ok] completion(Storyboard.TargetProperty simple 'Opac'): roots at target element (${sp5.length} items)`);
  // (vi) an unknown owner type in the group offers nothing (never the element's members).
  const sp6 = await completeWith(516, sb("(NoSuchOwner.|"), "sb-paren-unknown-owner");
  if (sp6.includes("Opacity") || sp6.includes("Width")) fail(`unknown owner type must offer no members (got ${sp6.slice(0, 40).join(",")})`);
  console.log(`[ok] completion(Storyboard.TargetProperty '(NoSuchOwner.'): unknown owner -> no members (${sp6.length} items)`);

  // (vii) bare "(Owner." with an empty member partial merges the owner's instance DPs AND attached props.
  const sp7 = await completeWith(517, sb("(UIElement.|"), "sb-paren-bare-owner");
  for (const want of ["Opacity", "RenderTransform"]) {
    if (!sp7.includes(want)) fail(`(UIElement. should merge instance DP '${want}' (got ${sp7.slice(0, 40).join(",")})`);
  }
  console.log(`[ok] completion(Storyboard.TargetProperty '(UIElement.'): merged instance+attached (${sp7.length} items)`);
  // (viii) a leading-space owner token is trimmed and still resolves ("( Canvas." -> attached Left/Top).
  const sp8 = await completeWith(518, sb("( Canvas.|"), "sb-paren-ws-owner");
  for (const want of ["Left", "Top"]) {
    if (!sp8.includes(want)) fail(`( Canvas. (leading space) should trim + resolve -> attached '${want}' (got ${sp8.slice(0, 40).join(",")})`);
  }
  console.log(`[ok] completion(Storyboard.TargetProperty '( Canvas.'): trimmed owner resolves (${sp8.length} items)`);
  // (ix) a dotted sub-path into the ABSTRACT Transform type is benign-empty — never jumps back to the owner
  // (no 'Opacity') and never leaks page members (no 'GreetingText'); the concrete tail uses the ").(Cast." form.
  const sp9 = await completeWith(519, sb("(UIElement.RenderTransform.|"), "sb-paren-dotted-abstract");
  if (sp9.includes("Opacity")) fail(`(UIElement.RenderTransform. must not jump back to UIElement members (got ${sp9.slice(0, 40).join(",")})`);
  if (sp9.includes("GreetingText")) fail(`(UIElement.RenderTransform. must not leak page members (got ${sp9.slice(0, 40).join(",")})`);
  console.log(`[ok] completion(Storyboard.TargetProperty '(UIElement.RenderTransform.'): benign sub-path (${sp9.length} items)`);

  // 18d) ROUND 78: document-local author keys are conservatively type-scoped by their DECLARING element's
  // type (VS parity — the round-74 follow-on), while App.xaml keys and un-resolvable declarations stay
  // always-offered so an author's own key is never wrongly hidden.
  const authorRes =
    `<SolidColorBrush x:Key="MyDocBrush" Color="Red" />\n` +
    `    <Style x:Key="MyDocStyle" TargetType="Button" />\n` +
    `    <x:Double x:Key="MyDocNum">12</x:Double>`;
  const pageAuthor = (attr) =>
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Page.Resources>\n    ${authorRes}\n  </Page.Resources>\n  <Grid ${attr} />\n</Page>`;
  // (i) On a Brush property: the author Brush + the App.xaml Brush show; the author Style is HIDDEN, and
  // the intrinsic x:Double is HIDDEN too (ResolveElementType maps x:Double -> System.Double, so it is
  // correctly type-scoped away from a Brush — VS parity, not a false-hide: it shows on a double property).
  const ak1 = await completeWith(520, pageAuthor('Background="{StaticResource |}"'), "author-key-on-brush");
  if (!ak1.includes("MyDocBrush")) fail(`author Brush key should show on a Brush property (got ${ak1.slice(0, 40).join(",")})`);
  if (!ak1.includes("SmokeAccentBrush")) fail(`App.xaml Brush key should always show (got ${ak1.slice(0, 40).join(",")})`);
  if (ak1.includes("MyDocStyle")) fail(`author Style key must be HIDDEN on a Brush property (got ${ak1.slice(0, 40).join(",")})`);
  if (ak1.includes("MyDocNum")) fail(`author x:Double key must be HIDDEN on a Brush property (got ${ak1.slice(0, 40).join(",")})`);
  console.log(`[ok] completion(author key on Brush): MyDocBrush+SmokeAccentBrush, Style+Double hidden (${ak1.length} items)`);
  // (ii) On a Style property: the author Style shows; the doc-local Brush is HIDDEN. The App.xaml Brush key
  // stays SHOWN — App keys carry no declaring element here, so they are conservatively always-offered.
  const ak2 = await completeWith(521, pageAuthor('Style="{StaticResource |}"'), "author-key-on-style");
  if (!ak2.includes("MyDocStyle")) fail(`author Style key should show on a Style property (got ${ak2.slice(0, 40).join(",")})`);
  if (ak2.includes("MyDocBrush")) fail(`doc-local Brush key must be HIDDEN on a Style property (got ${ak2.slice(0, 40).join(",")})`);
  if (ak2.includes("MyDocNum")) fail(`doc-local x:Double key must be HIDDEN on a Style property (got ${ak2.slice(0, 40).join(",")})`);
  if (!ak2.includes("SmokeAccentBrush")) fail(`App.xaml key must stay offered on a Style property (always-offered) (got ${ak2.slice(0, 40).join(",")})`);
  console.log(`[ok] completion(author key on Style): MyDocStyle shown, doc-local Brush/Double hidden, App key always-offered (${ak2.length} items)`);
  // (iii) On a double property (Width): the intrinsic x:Double shows; the Brush and Style keys are HIDDEN —
  // proving the intrinsic IS collected and correctly type-matched (not merely dropped everywhere).
  const ak3 = await completeWith(522, pageAuthor('Width="{StaticResource |}"'), "author-key-on-double");
  if (!ak3.includes("MyDocNum")) fail(`intrinsic x:Double key should show on a double property (got ${ak3.slice(0, 40).join(",")})`);
  if (ak3.includes("MyDocBrush")) fail(`author Brush key must be HIDDEN on a double property (got ${ak3.slice(0, 40).join(",")})`);
  if (ak3.includes("MyDocStyle")) fail(`author Style key must be HIDDEN on a double property (got ${ak3.slice(0, 40).join(",")})`);
  console.log(`[ok] completion(author key on double Width): x:Double MyDocNum shown, Brush/Style hidden (${ak3.length} items)`);
  // (iv) On an 'object' property (Tag) every author key is offered — no scoping when the target is object.
  const ak4 = await completeWith(523, pageAuthor('Tag="{StaticResource |}"'), "author-key-on-object");
  for (const want of ["MyDocBrush", "MyDocStyle", "MyDocNum", "SmokeAccentBrush"]) {
    if (!ak4.includes(want)) fail(`object 'Tag' property should offer every author key incl '${want}' (got ${ak4.slice(0, 40).join(",")})`);
  }
  console.log(`[ok] completion(author key on object Tag): all author keys offered (${ak4.length} items)`);


  // 14a) x:Bind via the named Path= argument resolves the same members as the positional form.
  const bindNamedPath = await completeWith(40, `<Page ${NS}>\n  <TextBlock Text="{x:Bind Path=Gre|}" />\n</Page>`, "bind-named-path");
  if (!bindNamedPath.includes("GreetingText")) fail(`x:Bind named-Path completion missing 'GreetingText' (got ${bindNamedPath.join(",")})`);
  if (bindNamedPath.includes("Items")) fail(`x:Bind named-Path 'Gre' should filter out 'Items' (got ${bindNamedPath.join(",")})`);
  console.log(`[ok] completion(x:Bind, 'Path=Gre'): -> GreetingText, not Items (${bindNamedPath.length} items)`);

  // 14a-ii) F12 through the named Path= argument lands on the same member as the positional form.
  const bindNamedDef = await definitionWith(41, `<Page ${NS}>\n  <TextBlock Text="{x:Bind Path=Greeting|Text}" />\n</Page>`, "bind-named-path");
  if (!bindNamedDef || !bindNamedDef.uri) fail(`x:Bind named-Path definition returned no location: ${JSON.stringify(bindNamedDef)}`);
  if (!bindNamedDef.uri.toLowerCase().endsWith(EXPECTED_CODE_BEHIND)) fail(`x:Bind named-Path definition landed in unexpected file: ${bindNamedDef.uri}`);
  if (bindNamedDef.range?.start?.line !== EXPECTED_GREETING_LINE) fail(`x:Bind named-Path definition landed on line ${bindNamedDef.range?.start?.line}, expected ${EXPECTED_GREETING_LINE}`);
  console.log(`[ok] definition: {x:Bind Path=GreetingText} -> ${bindNamedDef.uri} @ line ${bindNamedDef.range.start.line}`);

  // 14a-iii) element completion inside an XML comment is suppressed (no leak of element names).
  const commentItems = await completeWith(42, `<Page ${NS}>\n  <Grid>\n    <!-- <But| -->\n  </Grid>\n</Page>`, "comment-suppression");
  if (commentItems.includes("Button")) fail(`completion inside an XML comment must not offer 'Button' (got ${commentItems.slice(0, 20).join(",")})`);
  console.log(`[ok] completion(comment): '<!-- <But' -> no element completions (${commentItems.length} items)`);

  // 14b) markup-extension NAME completion: typing '{' (or a partial name) offers the extensions.
  const markupAll = await completeWith(23, `<Page ${NS}>\n  <TextBlock Text="{|}" />\n</Page>`, "markup-name");
  for (const want of ["x:Bind", "Binding", "StaticResource", "ThemeResource"]) {
    if (!markupAll.includes(want)) fail(`markup-name completion missing '${want}' (got ${markupAll.join(",")})`);
  }
  console.log(`[ok] completion(markup, '{'): -> x:Bind/Binding/StaticResource/... (${markupAll.length} items)`);

  // 14c) partial name filters to matching extensions and does NOT eagerly list x:Bind members.
  const markupStatic = await completeWith(24, `<Page ${NS}>\n  <TextBlock Text="{Stat|}" />\n</Page>`, "markup-name-partial");
  if (!markupStatic.includes("StaticResource")) fail(`markup-name 'Stat' should offer StaticResource (got ${markupStatic.join(",")})`);
  if (markupStatic.includes("GreetingText")) fail(`markup-name 'Stat' must not list x:Bind members (got ${markupStatic.join(",")})`);
  console.log(`[ok] completion(markup, 'Stat'): -> StaticResource, no bind members (${markupStatic.length} items)`);

  // 14d) Mode= named argument -> BindingMode enum members (shared by x:Bind and Binding).
  const modeAll = await completeWith(25, `<Page ${NS}>\n  <TextBlock Text="{x:Bind GreetingText, Mode=|}" />\n</Page>`, "markup-arg-Mode");
  for (const want of ["OneWay", "TwoWay", "OneTime"]) {
    if (!modeAll.includes(want)) fail(`Mode= completion missing '${want}' (got ${modeAll.join(",")})`);
  }
  console.log(`[ok] completion(markup arg, 'Mode='): -> OneWay/TwoWay/OneTime (${modeAll.length} items)`);

  // 14e) partial Mode value filters to matching members and doesn't reopen the member list.
  const modePartial = await completeWith(26, `<Page ${NS}>\n  <TextBlock Text="{Binding Path=X, Mode=Tw|}" />\n</Page>`, "markup-arg-Mode-partial");
  if (!modePartial.includes("TwoWay")) fail(`Mode='Tw' should offer TwoWay (got ${modePartial.join(",")})`);
  if (modePartial.includes("OneWay")) fail(`Mode='Tw' should not offer OneWay (got ${modePartial.join(",")})`);
  console.log(`[ok] completion(markup arg, 'Mode=Tw'): -> TwoWay only (${modePartial.length} items)`);

  // 14f) {StaticResource key} completion pulls x:Key'd resources, including the project's App.xaml.
  const resAll = await completeWith(27, `<Page ${NS}>\n  <TextBlock Foreground="{StaticResource |}" />\n</Page>`, "resource-key");
  if (!resAll.includes("SmokeAccentBrush")) fail(`resource-key completion missing App.xaml 'SmokeAccentBrush' (got ${resAll.join(",")})`);
  console.log(`[ok] completion(resource, '{StaticResource '): -> SmokeAccentBrush from App.xaml (${resAll.length} items)`);

  // 14g) document-local x:Key resources are offered too, and a partial filters out non-matches.
  const resLocal = await completeWith(
    28,
    `<Page ${NS}>\n  <Page.Resources>\n    <SolidColorBrush x:Key="LocalBrush" />\n  </Page.Resources>\n  <TextBlock Foreground="{StaticResource Loc|}" />\n</Page>`,
    "resource-key-local"
  );
  if (!resLocal.includes("LocalBrush")) fail(`resource-key completion missing document-local 'LocalBrush' (got ${resLocal.join(",")})`);
  if (resLocal.includes("SmokeAccentBrush")) fail(`partial 'Loc' should filter out SmokeAccentBrush (got ${resLocal.join(",")})`);
  console.log(`[ok] completion(resource, '{StaticResource Loc'): -> LocalBrush, filtered (${resLocal.length} items)`);

  // 14h) common WinUI theme STYLE resources are offered on a Style-typed property (type-scoped, round 74).
  const resTheme = await completeWith(29, `<Page ${NS}>\n  <TextBlock Style="{StaticResource Tit|}" />\n</Page>`, "resource-key-theme");
  for (const needle of ["TitleTextBlockStyle", "TitleLargeTextBlockStyle"]) {
    if (!resTheme.includes(needle)) fail(`theme resource completion missing '${needle}' (got ${resTheme.join(",")})`);
  }
  if (resTheme.includes("SmokeAccentBrush")) fail(`partial 'Tit' should filter out SmokeAccentBrush (got ${resTheme.join(",")})`);
  console.log(`[ok] completion(resource, Style '{StaticResource Tit'): -> Title*TextBlockStyle theme resources (${resTheme.length} items)`);

  // 14i) ROUND 74: theme resource keys are type-scoped to the target property (VS parity). On a Brush
  // property the theme BRUSH keys are offered while theme Style/Color/CornerRadius keys are hidden; the
  // project's own author keys (App.xaml SmokeAccentBrush) are ALWAYS offered regardless of type.
  const resBrushProp = await completeWith(493, `<Page ${NS}>\n  <TextBlock Foreground="{StaticResource |}" />\n</Page>`, "resource-key-typed-brush");
  if (!resBrushProp.includes("AccentFillColorDefaultBrush")) fail(`Brush property should offer theme brush key 'AccentFillColorDefaultBrush' (got ${resBrushProp.join(",")})`);
  if (!resBrushProp.includes("SmokeAccentBrush")) fail(`Brush property should still offer App.xaml author key 'SmokeAccentBrush' (got ${resBrushProp.join(",")})`);
  for (const hidden of ["TitleTextBlockStyle", "SystemAccentColor", "ControlCornerRadius"]) {
    if (resBrushProp.includes(hidden)) fail(`Brush property must HIDE non-brush theme key '${hidden}' (got ${resBrushProp.join(",")})`);
  }
  console.log(`[ok] completion(resource, Brush prop): brush + author keys, Style/Color/CornerRadius hidden (${resBrushProp.length} items)`);

  // 14j) On a Color property (SolidColorBrush.Color) theme COLOR keys are offered, brush/style hidden.
  const resColorProp = await completeWith(494, `<Page ${NS}>\n  <Page.Background>\n    <SolidColorBrush Color="{ThemeResource |}" />\n  </Page.Background>\n</Page>`, "resource-key-typed-color");
  if (!resColorProp.includes("SystemAccentColor")) fail(`Color property should offer theme color key 'SystemAccentColor' (got ${resColorProp.join(",")})`);
  for (const hidden of ["AccentFillColorDefaultBrush", "TitleTextBlockStyle"]) {
    if (resColorProp.includes(hidden)) fail(`Color property must HIDE non-color theme key '${hidden}' (got ${resColorProp.join(",")})`);
  }
  console.log(`[ok] completion(resource, Color prop): color keys offered, brush/style hidden (${resColorProp.length} items)`);

  // 14k) On a CornerRadius property (Border.CornerRadius) theme CORNER RADIUS keys are offered.
  const resCornerProp = await completeWith(495, `<Page ${NS}>\n  <Border CornerRadius="{StaticResource |}" />\n</Page>`, "resource-key-typed-corner");
  if (!resCornerProp.includes("ControlCornerRadius")) fail(`CornerRadius property should offer 'ControlCornerRadius' (got ${resCornerProp.join(",")})`);
  if (resCornerProp.includes("AccentFillColorDefaultBrush")) fail(`CornerRadius property must HIDE brush key (got ${resCornerProp.join(",")})`);
  console.log(`[ok] completion(resource, CornerRadius prop): corner-radius keys offered, brush hidden (${resCornerProp.length} items)`);

  // 14l) On an 'object' property (Tag) NO type filter is applied — every theme key is offered.
  const resTagProp = await completeWith(496, `<Page ${NS}>\n  <TextBlock Tag="{StaticResource |}" />\n</Page>`, "resource-key-object");
  for (const needle of ["AccentFillColorDefaultBrush", "TitleTextBlockStyle", "SystemAccentColor", "ControlCornerRadius"]) {
    if (!resTagProp.includes(needle)) fail(`object (Tag) property must offer ALL theme keys incl '${needle}' (got ${resTagProp.length} items)`);
  }
  console.log(`[ok] completion(resource, object Tag prop): all theme keys offered, no type filter (${resTagProp.length} items)`);

  // 14m) A resource nested in another markup extension is NOT type-scoped (it feeds the extension arg,
  // not the attribute), so every theme key is offered even on a Brush-typed attribute.
  const resNested = await completeWith(497, `<Page ${NS}>\n  <TextBlock Foreground="{Binding Source={StaticResource |}}" />\n</Page>`, "resource-key-nested");
  for (const needle of ["AccentFillColorDefaultBrush", "TitleTextBlockStyle", "SystemAccentColor"]) {
    if (!resNested.includes(needle)) fail(`nested resource must offer ALL theme keys incl '${needle}' (got ${resNested.join(",")})`);
  }
  console.log(`[ok] completion(resource, nested {Binding Source={StaticResource): all theme keys offered (${resNested.length} items)`);

  // 14n) ROUND 75: a <Setter Value="{StaticResource |}"> is declared 'object' but VS scopes it to the
  // property named by the sibling Property= on the enclosing TargetType (like the scalar Setter.Value
  // path). So a Setter for a Brush property scopes theme keys to brushes; author keys stay always-offered.
  const svBrush = await completeWith(498, pageRes(`<Style TargetType="TextBlock">\n      <Setter Property="Foreground" Value="{StaticResource |}" />\n    </Style>`), "setterval-resource-brush");
  if (!svBrush.includes("AccentFillColorDefaultBrush")) fail(`Setter.Value(Foreground) should offer theme brush key (got ${svBrush.join(",")})`);
  if (!svBrush.includes("SmokeAccentBrush")) fail(`Setter.Value(Foreground) should still offer App.xaml author key 'SmokeAccentBrush' (got ${svBrush.join(",")})`);
  for (const hidden of ["TitleTextBlockStyle", "SystemAccentColor", "ControlCornerRadius"]) {
    if (svBrush.includes(hidden)) fail(`Setter.Value(Foreground) must HIDE non-brush theme key '${hidden}' (got ${svBrush.join(",")})`);
  }
  console.log(`[ok] completion(Setter.Value Foreground): brush + author keys, Style/Color/CornerRadius hidden (${svBrush.length} items)`);

  // 14o) A Setter for a CornerRadius property scopes theme keys to corner radii.
  const svCorner = await completeWith(499, pageRes(`<Style TargetType="Border">\n      <Setter Property="CornerRadius" Value="{StaticResource |}" />\n    </Style>`), "setterval-resource-corner");
  if (!svCorner.includes("ControlCornerRadius")) fail(`Setter.Value(CornerRadius) should offer 'ControlCornerRadius' (got ${svCorner.join(",")})`);
  if (svCorner.includes("AccentFillColorDefaultBrush")) fail(`Setter.Value(CornerRadius) must HIDE brush key (got ${svCorner.join(",")})`);
  console.log(`[ok] completion(Setter.Value CornerRadius): corner-radius keys offered, brush hidden (${svCorner.length} items)`);

  // 14p) A Setter with NO resolvable Property= (ResolveSetterValueType -> null) offers EVERY theme key,
  // exactly as before round 75 (keeps the round-74 offer-all guarantee for untyped Setter.Value).
  const svNoProp = await completeWith(500, pageRes(`<Style TargetType="Button">\n      <Setter Value="{StaticResource |}" />\n    </Style>`), "setterval-resource-noprop");
  for (const needle of ["AccentFillColorDefaultBrush", "TitleTextBlockStyle", "SystemAccentColor", "ControlCornerRadius"]) {
    if (!svNoProp.includes(needle)) fail(`Setter.Value with no Property must offer ALL theme keys incl '${needle}' (got ${svNoProp.length} items)`);
  }
  console.log(`[ok] completion(Setter.Value no Property): all theme keys offered (${svNoProp.length} items)`);

  // 14q) A Setter for a dotted ATTACHED property (Grid.Row : int) scopes to int — no theme key matches,
  // so every theme key is hidden, yet the project's author key is ALWAYS offered (round-74 invariant).
  const svAttached = await completeWith(501, pageRes(`<Style TargetType="Button">\n      <Setter Property="Grid.Row" Value="{StaticResource |}" />\n    </Style>`), "setterval-resource-attached");
  if (!svAttached.includes("SmokeAccentBrush")) fail(`Setter.Value(Grid.Row) should still offer App.xaml author key 'SmokeAccentBrush' (got ${svAttached.join(",")})`);
  for (const hidden of ["AccentFillColorDefaultBrush", "TitleTextBlockStyle", "SystemAccentColor", "ControlCornerRadius"]) {
    if (svAttached.includes(hidden)) fail(`Setter.Value(Grid.Row : int) must HIDE theme key '${hidden}' (got ${svAttached.join(",")})`);
  }
  console.log(`[ok] completion(Setter.Value Grid.Row : int): all theme keys hidden, author key still offered (${svAttached.length} items)`);

  // 14r) ROUND 75 (x:Type TargetType): a Style whose TargetType uses the {x:Type Button} markup-extension
  // wrapper must scope Setter.Value identically to a bare TargetType="TextBlock" (ResolveStyleTargetType
  // unwraps the wrapper). Foreground -> brush + author keys, theme Style key hidden.
  const svXType = await completeWith(502, pageRes(`<Style TargetType="{x:Type TextBlock}">\n      <Setter Property="Foreground" Value="{StaticResource |}" />\n    </Style>`), "setterval-resource-xtype");
  if (!svXType.includes("AccentFillColorDefaultBrush")) fail(`Setter.Value under {x:Type TextBlock} should offer theme brush key (got ${svXType.join(",")})`);
  if (!svXType.includes("SmokeAccentBrush")) fail(`Setter.Value under {x:Type TextBlock} should offer author key (got ${svXType.join(",")})`);
  if (svXType.includes("TitleTextBlockStyle")) fail(`Setter.Value under {x:Type TextBlock} must HIDE theme Style key on a Brush property (got ${svXType.join(",")})`);
  console.log(`[ok] completion(Setter.Value {x:Type TextBlock}): brush + author keys, Style hidden (${svXType.length} items)`);

  // 15) hover on an element name -> the resolved type (works for framework metadata types).
  const typeHover = await hoverAt(30, `<Page ${NS}>\n  <But|ton />\n</Page>`, "element-name");
  if (!typeHover.includes("Button")) fail(`element-name hover missing 'Button': ${typeHover}`);
  if (!typeHover.includes("class")) fail(`element-name hover should name the type kind: ${typeHover}`);
  console.log(`[ok] hover(element): '<Button>' -> ${typeHover.replace(/\n/g, " ").trim()}`);

  // 16) hover on a simple attribute name -> the property/event symbol on the element type.
  const attrHover = await hoverAt(31, `<Page ${NS}>\n  <Button Con|tent="x" />\n</Page>`, "attribute-name");
  if (!attrHover.includes("Content")) fail(`attribute-name hover missing 'Content': ${attrHover}`);
  console.log(`[ok] hover(attribute): 'Button.Content' -> ${attrHover.replace(/\n/g, " ").trim()}`);

  // 16b) hover on a no-prefix <Owner.Member> property-element name -> the Member property on the owner type
  // (works for framework metadata like Grid.RowDefinitions; renders the property signature).
  const peHover = await hoverAt(32,
    `<Page ${NS}>\n  <Grid>\n    <Grid.RowDef|initions>\n      <RowDefinition />\n    </Grid.RowDefinitions>\n  </Grid>\n</Page>`,
    "property-element-name");
  if (!peHover.includes("RowDefinitions")) fail(`property-element hover missing 'RowDefinitions': ${peHover}`);
  console.log(`[ok] hover(property element): '<Grid.RowDefinitions>' -> ${peHover.replace(/\n/g, " ").trim()}`);

  // 16c) a mis-cased / unknown property-element member resolves to no symbol -> no hover (conservative,
  // never guesses), mirroring the WXAML0006 case-sensitivity.
  const peHoverBad = await hoverAt(33,
    `<Page ${NS}>\n  <Grid>\n    <Grid.rowDef|initions>\n      <RowDefinition />\n    </Grid.rowDefinitions>\n  </Grid>\n</Page>`,
    "property-element-name-bad");
  if (peHoverBad.includes("rowDefinitions") || peHoverBad.includes("RowDefinitions")) fail(`mis-cased property element should not hover to a member: ${peHoverBad}`);
  console.log(`[ok] hover(property element): mis-cased '<Grid.rowDefinitions>' -> no member hover (conservative)`);

  // 16d) caret on the OWNER segment of a property element resolves the owner TYPE, not the member — the
  // member must not masquerade under a caret that is not on it.
  const peHoverOwner = await hoverAt(34,
    `<Page ${NS}>\n  <Grid>\n    <Gr|id.RowDefinitions>\n      <RowDefinition />\n    </Grid.RowDefinitions>\n  </Grid>\n</Page>`,
    "property-element-owner");
  if (peHoverOwner.includes("Grid.RowDefinitions")) fail(`owner-segment hover must not resolve the member: ${peHoverOwner}`);
  if (!peHoverOwner.includes("Grid")) fail(`owner-segment hover should resolve the Grid type: ${peHoverOwner}`);
  console.log(`[ok] hover(property element): owner segment '<Grid|.RowDefinitions>' -> ${peHoverOwner.replace(/\n/g, " ").trim()}`);

  // 17) document symbols (outline): the parsed element tree, annotated with x:Name.
  async function docSymbols(id, body, label) {
    send({
      method: "textDocument/didChange",
      params: { textDocument: { uri: xamlUri, version: ++version }, contentChanges: [{ text: body }] },
    });
    send({ id, method: "textDocument/documentSymbol", params: { textDocument: { uri: xamlUri } } });
    const res = await waitFor(responseFor(id), 30000, `documentSymbol ${label}`);
    if (res.error) fail(`documentSymbol ${label} errored: ${JSON.stringify(res.error)}`);
    return Array.isArray(res.result) ? res.result : [];
  }
  function flattenSymbols(nodes, out = []) {
    for (const n of nodes) {
      out.push(n);
      if (Array.isArray(n.children)) flattenSymbols(n.children, out);
    }
    return out;
  }

  const outline = await docSymbols(
    40,
    `<Page ${NS}>\n  <Grid>\n    <Button x:Name="GoButton" Content="Go" />\n  </Grid>\n</Page>`,
    "outline"
  );
  if (outline.length !== 1) fail(`outline should have a single root, got ${outline.length}`);
  if (!outline[0].name.includes("Page")) fail(`outline root should be Page, got '${outline[0].name}'`);
  const flatSymbols = flattenSymbols(outline);
  if (!flatSymbols.some((s) => s.name.includes("Grid"))) fail(`outline missing Grid: ${flatSymbols.map((s) => s.name).join(", ")}`);
  const namedSymbol = flatSymbols.find((s) => s.name.includes("GoButton"));
  if (!namedSymbol) fail(`outline missing the x:Name-annotated Button: ${flatSymbols.map((s) => s.name).join(", ")}`);
  if (!namedSymbol.name.includes("Button")) fail(`named symbol should be a Button, got '${namedSymbol.name}'`);
  console.log(`[ok] documentSymbol: Page > Grid > Button (GoButton) (${flatSymbols.length} symbols)`);

  // 13-14) semantic validation (diagnostics). Diagnostics arrive as publishDiagnostics notifications;
  //        the server sends a fast syntactic publish, then a combined one once semantic analysis runs.
  async function validateDoc(text, predicate, label) {
    const done = waitFor(
      (m) =>
        m.method === "textDocument/publishDiagnostics" &&
        m.params.uri === xamlUri &&
        predicate(m.params.diagnostics),
      30000,
      label
    );
    send({
      method: "textDocument/didChange",
      params: { textDocument: { uri: xamlUri, version: ++version }, contentChanges: [{ text }] },
    });
    return (await done).params.diagnostics;
  }

  // Inject exactly one unknown element into the REAL fixture: if any of the many real controls
  // (Grid, ScrollViewer, ItemsRepeater, DataTemplate, RowDefinition, ...) or property elements were
  // wrongly flagged, this assertion fails — so it doubles as a whole-fixture false-positive guard.
  const dirtyType = xamlText.replace("<Button", "<Buton");
  if (dirtyType === xamlText) fail("could not inject an unknown element into the fixture");
  const typeDiags = await validateDoc(
    dirtyType,
    (d) => d.some((x) => x.code === "WXAML0002" && x.message.includes("Buton")),
    "unknown-type diagnostic"
  );
  const unknownType = typeDiags.filter((x) => x.code === "WXAML0002");
  if (unknownType.length !== 1) {
    fail(`expected exactly 1 unknown-type diagnostic on the fixture, got ${unknownType.length}: ${JSON.stringify(typeDiags.map((t) => t.message))}`);
  }
  if (unknownType[0].severity !== 2) fail(`unknown-type should be a warning (severity 2), got ${unknownType[0].severity}`);
  // The whole fixture (every real control + attribute) must produce no OTHER diagnostics.
  if (typeDiags.length !== 1) fail(`expected exactly 1 total diagnostic on the fixture, got ${typeDiags.length}: ${JSON.stringify(typeDiags.map((t) => `${t.code}:${t.message}`))}`);
  console.log(`[ok] validation: fixture + <Buton> -> exactly 1 unknown-type warning, zero false positives`);

  // Attribute typo on a known element -> unknown-property warning. Injecting into the real fixture also
  // guards against false positives across every valid attribute (NavigationCacheMode, Foreground, ...).
  const dirtyAttr = xamlText.replace('Text="Smoke Fixture"', 'Texx="Smoke Fixture"');
  if (dirtyAttr === xamlText) fail("could not inject an unknown attribute into the fixture");
  const attrDiags = await validateDoc(
    dirtyAttr,
    (d) => d.some((x) => x.code === "WXAML0003" && x.message.includes("Texx")),
    "unknown-attribute diagnostic"
  );
  const unknownAttr = attrDiags.filter((x) => x.code === "WXAML0003");
  if (unknownAttr.length !== 1) fail(`expected exactly 1 unknown-attribute diagnostic, got ${unknownAttr.length}: ${JSON.stringify(attrDiags.map((t) => `${t.code}:${t.message}`))}`);
  if (unknownAttr[0].severity !== 2) fail(`unknown-attribute should be a warning (severity 2), got ${unknownAttr[0].severity}`);
  if (attrDiags.length !== 1) fail(`expected exactly 1 total diagnostic, got ${attrDiags.length}: ${JSON.stringify(attrDiags.map((t) => `${t.code}:${t.message}`))}`);
  console.log(`[ok] validation: TextBlock Texx="..." -> exactly 1 unknown-attribute warning, zero false positives`);

  // Attached-property typo (Owner.Member) -> WXAML0004. Injecting one bad member into the real fixture
  // also guards every valid attached property (the remaining Grid.Row's + AutomationProperties.AutomationId).
  const dirtyAttached = xamlText.replace("Grid.Row=", "Grid.Roww=");
  if (dirtyAttached === xamlText) fail("could not inject a bad attached property into the fixture");
  const attachedDiags = await validateDoc(
    dirtyAttached,
    (d) => d.some((x) => x.code === "WXAML0004" && x.message.includes("Roww")),
    "unknown-attached-property diagnostic"
  );
  const unknownAttached = attachedDiags.filter((x) => x.code === "WXAML0004");
  if (unknownAttached.length !== 1) fail(`expected exactly 1 attached-property diagnostic, got ${unknownAttached.length}: ${JSON.stringify(attachedDiags.map((t) => `${t.code}:${t.message}`))}`);
  if (unknownAttached[0].severity !== 2) fail(`attached-property should be a warning (severity 2), got ${unknownAttached[0].severity}`);
  if (attachedDiags.length !== 1) fail(`expected exactly 1 total diagnostic, got ${attachedDiags.length}: ${JSON.stringify(attachedDiags.map((t) => `${t.code}:${t.message}`))}`);
  console.log(`[ok] validation: Grid.Roww="..." -> exactly 1 attached-property warning, zero false positives`);

  // Undeclared namespace prefix -> error.
  const prefixDiags = await validateDoc(
    `<Page ${NS}>\n  <zzz:Widget x:Name="w" />\n</Page>`,
    (d) => d.some((x) => x.code === "WXAML0001" && x.message.includes("zzz")),
    "undeclared-prefix diagnostic"
  );
  const undeclared = prefixDiags.filter((x) => x.code === "WXAML0001");
  if (undeclared.length !== 1) fail(`expected exactly 1 undeclared-prefix diagnostic, got ${undeclared.length}: ${JSON.stringify(prefixDiags)}`);
  if (undeclared[0].severity !== 1) fail(`undeclared-prefix should be an error (severity 1), got ${undeclared[0].severity}`);
  console.log(`[ok] validation: '<zzz:Widget>' -> undeclared-prefix error`);

  // 19) Round-7 regressions: function-binding F12, x:Bind completion noise, invalid-member diagnostic, unquoted value.
  const fnF12 = await definitionWith(210, pageCls('<Button Click="{x:Bind OnGo_Cl|ick()}" />'), "fn-binding-f12");
  if (!fnF12?.uri || !fnF12.uri.endsWith("SmokePage.xaml.cs")) {
    fail(`function-style x:Bind F12 (OnGo_Click()) did not resolve to SmokePage.xaml.cs (got ${fnF12?.uri ?? "null"})`);
  }
  console.log(`[ok] definition(x:Bind function binding): OnGo_Click() -> SmokePage.xaml.cs`);

  const bindNoise = await completeWith(211, pageCls('<TextBlock Text="{x:Bind |}" />'), "xbind-noise");
  if (!bindNoise.includes("GreetingText") || !bindNoise.includes("Items")) fail(`x:Bind root completion missing source members (got ${bindNoise.length})`);
  if (bindNoise.includes("InitializeComponent")) fail(`x:Bind completion leaked generated 'InitializeComponent'`);
  if (bindNoise.includes("FindName")) fail(`x:Bind completion flooded framework method 'FindName'`);
  console.log(`[ok] completion(x:Bind root): source members kept, generated/framework noise dropped (${bindNoise.length} items)`);

  const badBind = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <TextBlock Text="{x:Bind DefinitelyMissingMember}" />\n</Page>`,
    (d) => d.some((x) => x.code === "WXAML0005"),
    "invalid-x:Bind diagnostic");
  const badMember = badBind.filter((x) => x.code === "WXAML0005");
  if (badMember.length !== 1) fail(`expected exactly 1 WXAML0005, got ${badMember.length}: ${JSON.stringify(badBind.map((x) => `${x.code}:${x.message}`))}`);
  if (badMember[0].severity !== 2) fail(`invalid x:Bind member should be a warning (severity 2), got ${badMember[0].severity}`);
  if (badBind.length !== 1) fail(`expected exactly 1 total diagnostic for the invalid-x:Bind buffer, got ${badBind.length}`);
  console.log(`[ok] validation: '{x:Bind DefinitelyMissingMember}' -> exactly 1 WXAML0005 warning`);

  const uBool = await completeWith(212, pageCls("<Button IsEnabled=| />"), "unquoted-bool");
  if (!uBool.includes("True") || !uBool.includes("False")) fail(`unquoted 'IsEnabled=' should complete True/False (got ${uBool.join(", ")})`);
  console.log(`[ok] completion(unquoted value): 'IsEnabled=|' -> True/False (${uBool.length} items)`);

  // 20) Round-8 regressions: markup-extension-name hover, enum-value hover, nested DataTemplate x:DataType
  //     scoping (completion + validation), and x:Bind argument-name completion after nested/named args.
  const bindNameHover = await hoverAt(220, pageCls('<TextBlock Text="{x:B|ind GreetingText}" />'), "xbind-name-hover");
  if (!/x:Bind/i.test(bindNameHover) || !/compiled|bind/i.test(bindNameHover)) fail(`x:Bind name hover should describe the extension (got ${JSON.stringify(bindNameHover)})`);
  console.log(`[ok] hover(markup name): '{x:Bind}' -> ${bindNameHover.replace(/\n/g, " ").trim().slice(0, 60)}...`);

  const resNameHover = await hoverAt(221, pageCls('<Grid Background="{StaticR|esource SmokeAccentBrush}" />'), "staticresource-name-hover");
  if (!/StaticResource/i.test(resNameHover) || !/resource/i.test(resNameHover)) fail(`StaticResource name hover should describe resource lookup (got ${JSON.stringify(resNameHover)})`);
  console.log(`[ok] hover(markup name): '{StaticResource}' -> ${resNameHover.replace(/\n/g, " ").trim().slice(0, 60)}...`);

  const enumHover = await hoverAt(222, pageCls('<Button HorizontalAlignment="Cent|er" />'), "enum-value-hover");
  if (!/HorizontalAlignment/i.test(enumHover) || !/Center/.test(enumHover)) fail(`enum value hover should show HorizontalAlignment.Center (got ${JSON.stringify(enumHover)})`);
  console.log(`[ok] hover(enum value): 'HorizontalAlignment="Center"' -> ${enumHover.replace(/\n/g, " ").trim()}`);

  const modeHover = await hoverAt(223, pageCls('<TextBlock Text="{x:Bind GreetingText, Mode=One|Way}" />'), "bindmode-value-hover");
  if (!/OneWay/.test(modeHover) || !/BindingMode|Mode/i.test(modeHover)) fail(`x:Bind Mode value hover should show BindingMode.OneWay (got ${JSON.stringify(modeHover)})`);
  console.log(`[ok] hover(enum arg value): 'Mode=OneWay' -> ${modeHover.replace(/\n/g, " ").trim()}`);

  const innerScope = await completeWith(
    224,
    pageClsLocal('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="local:SmokePage"><StackPanel><StackPanel.Resources><DataTemplate x:Key="T" x:DataType="x:String"><TextBlock Text="{x:Bind |}" /></DataTemplate></StackPanel.Resources></StackPanel></DataTemplate></ListView.ItemTemplate></ListView>'),
    "nested-datatemplate-scope");
  if (!innerScope.includes("Length")) fail(`inner x:String DataTemplate completion should include String.Length (got ${innerScope.slice(0, 40).join(", ")})`);
  if (innerScope.includes("GreetingText")) fail(`inner x:String DataTemplate completion must not leak outer SmokePage.GreetingText (got ${innerScope.slice(0, 40).join(", ")})`);
  console.log(`[ok] completion(nested DataTemplate): inner x:String -> Length, no outer GreetingText (${innerScope.length} items)`);

  const innerDiag = await validateDoc(
    pageClsLocal('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="local:SmokePage"><StackPanel><DataTemplate x:DataType="x:String"><TextBlock Text="{x:Bind GreetingText}" /></DataTemplate></StackPanel></DataTemplate></ListView.ItemTemplate></ListView>'),
    (d) => d.some((x) => x.code === "WXAML0005" && x.message.includes("GreetingText")),
    "nested-datatemplate-diagnostic");
  const innerBad = innerDiag.filter((x) => x.code === "WXAML0005");
  if (innerBad.length !== 1) fail(`inner x:String template should flag GreetingText once, got ${innerBad.length}: ${JSON.stringify(innerDiag.map((x) => `${x.code}:${x.message}`))}`);
  console.log(`[ok] validation(nested DataTemplate): inner x:String flags GreetingText (WXAML0005)`);

  const argNames = await completeWith(
    225,
    pageCls('<Page.Resources><SolidColorBrush x:Key="C" Color="Red" /></Page.Resources>\n  <TextBlock Text="{x:Bind GreetingText, Converter={StaticResource C}, ConverterParameter=abc, |}" />'),
    "xbind-argname");
  for (const want of ["Mode", "FallbackValue", "TargetNullValue"]) {
    if (!argNames.includes(want)) fail(`x:Bind arg-name completion after ConverterParameter should include '${want}' (got ${argNames.slice(0, 40).join(", ")})`);
  }
  console.log(`[ok] completion(x:Bind arg names): after Converter/ConverterParameter -> Mode/FallbackValue/TargetNullValue (${argNames.length} items)`);

  // 21) Round-9 regressions: attached-property completion inside <Setter Property="Owner.">, and
  //     hover on a non-first x:Bind path segment resolving against the preceding segment's type.
  const setterAttached = await completeWith(
    230,
    pageRes(`<Style TargetType="Button">\n      <Setter Property="Grid.|" Value="1" />\n    </Style>`),
    "setter-attached-property");
  if (!setterAttached.includes("Grid.Row") || !setterAttached.includes("Grid.Column")) fail(`Setter Property="Grid." should complete Grid.Row/Grid.Column (got ${setterAttached.slice(0, 40).join(", ")})`);
  console.log(`[ok] completion(Setter attached property): 'Grid.' -> Grid.Row/Grid.Column (${setterAttached.length} items)`);

  const secondSegHover = await hoverAt(231, pageCls('<TextBlock Text="{x:Bind GreetingText.Len|gth}" />'), "xbind-second-segment-hover");
  if (!/Length/.test(secondSegHover) || !/\bint\b|Int32/.test(secondSegHover)) fail(`x:Bind second-segment hover should resolve String.Length : int (got ${JSON.stringify(secondSegHover)})`);
  if (/GreetingText/.test(secondSegHover)) fail(`x:Bind second-segment hover should describe Length, not the first segment GreetingText (got ${JSON.stringify(secondSegHover)})`);
  console.log(`[ok] hover(x:Bind second segment): 'GreetingText.Length' -> ${secondSegHover.replace(/\n/g, " ").trim()}`);

  // 22) Round-10 regressions: named-element references (ElementName / Storyboard.TargetName) and
  //     attached-property hover (attribute name + Setter Property value).
  const enNamed =
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <StackPanel>\n` +
    `    <TextBox x:Name="InputBox" />\n` +
    `    <TextBlock Text="{Binding ElementName=InputBox}" />\n  </StackPanel>\n</Page>`;
  const enLine = enNamed.split("\n").findIndex((l) => l.includes('x:Name="InputBox"'));

  // 22a) ElementName value completion offers the x:Name'd elements (no word-based fallback over stdio).
  const enComp = await completeWith(240, enNamed.replace("ElementName=InputBox", "ElementName=|"), "elementname-completion");
  if (!enComp.includes("InputBox")) fail(`ElementName completion should offer 'InputBox' (got ${enComp.slice(0, 40).join(", ")})`);
  console.log(`[ok] completion(ElementName): '{Binding ElementName=' -> InputBox (${enComp.length} items)`);

  // 22b) F12 on an ElementName value lands on the x:Name declaration in this document.
  const enDef = await definitionWith(241, enNamed.replace("ElementName=InputBox", "ElementName=Inp|utBox"), "elementname-f12");
  if (!enDef?.uri || !enDef.uri.toLowerCase().endsWith("smokepage.xaml")) fail(`ElementName F12 should land in this document (got ${enDef?.uri})`);
  if (enDef.range.start.line !== enLine) fail(`ElementName F12 should land on x:Name line ${enLine} (got ${enDef.range.start.line})`);
  console.log(`[ok] definition(ElementName): 'InputBox' -> ${enDef.uri} @ line ${enDef.range.start.line}`);

  // 22c) Hover on an ElementName value identifies the referenced element + its type.
  const enHover = await hoverAt(242, enNamed.replace("ElementName=InputBox", "ElementName=Inp|utBox"), "elementname-hover");
  if (!/InputBox/.test(enHover) || !/TextBox/.test(enHover)) fail(`ElementName hover should mention InputBox + TextBox (got ${JSON.stringify(enHover)})`);
  console.log(`[ok] hover(ElementName): 'InputBox' -> ${enHover.replace(/\n/g, " ").trim()}`);

  // 22d) F12 on Storyboard.TargetName lands on the x:Name declaration (not the generated backing field).
  const tnNamed =
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Grid>\n` +
    `    <Button x:Name="GoButton" />\n` +
    `    <Storyboard>\n      <ObjectAnimationUsingKeyFrames Storyboard.TargetName="GoButton" />\n` +
    `    </Storyboard>\n  </Grid>\n</Page>`;
  const tnLine = tnNamed.split("\n").findIndex((l) => l.includes('x:Name="GoButton"'));
  const tnDef = await definitionWith(243, tnNamed.replace('TargetName="GoButton"', 'TargetName="Go|Button"'), "targetname-f12");
  if (!tnDef?.uri || !tnDef.uri.toLowerCase().endsWith("smokepage.xaml")) fail(`Storyboard.TargetName F12 should land in this document (got ${tnDef?.uri})`);
  if (tnDef.range.start.line !== tnLine) fail(`Storyboard.TargetName F12 should land on x:Name line ${tnLine} (got ${tnDef.range.start.line})`);
  console.log(`[ok] definition(Storyboard.TargetName): 'GoButton' -> ${tnDef.uri} @ line ${tnDef.range.start.line}`);

  // 22e) Hover on an attached-property attribute name (Grid.Row="1") identifies the attached property.
  const grHover = await hoverAt(244, pageCls('<Grid>\n    <Button Grid.R|ow="1" />\n  </Grid>'), "attached-name-hover");
  if (!/Row/.test(grHover) || !/\bint\b|Int32/.test(grHover)) fail(`Grid.Row attribute-name hover should identify Row : int (got ${JSON.stringify(grHover)})`);
  console.log(`[ok] hover(attached name): 'Grid.Row' -> ${grHover.replace(/\n/g, " ").trim()}`);

  // 22f) Hover on a <Setter Property="Grid.Row"> value identifies the attached property.
  const spAttachedHover = await hoverAt(245, pageRes(`<Style TargetType="Button">\n      <Setter Property="Grid.R|ow" Value="1" />\n    </Style>`), "attached-setterprop-hover");
  if (!/Row/.test(spAttachedHover) || !/\bint\b|Int32/.test(spAttachedHover)) fail(`Setter Property="Grid.Row" hover should identify Row : int (got ${JSON.stringify(spAttachedHover)})`);
  console.log(`[ok] hover(Setter attached property): 'Grid.Row' -> ${spAttachedHover.replace(/\n/g, " ").trim()}`);

  // 22g) VisualState <Setter Target="Elem."> completes the named element's property members (VSM parity).
  const vsmSetter =
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Grid>\n` +
    `    <Border x:Name="Chrome" />\n` +
    `    <VisualStateManager.VisualStateGroups>\n      <VisualStateGroup>\n        <VisualState>\n` +
    `          <VisualState.Setters>\n            <Setter Target="Chrome.OPH" Value="0.5" />\n` +
    `          </VisualState.Setters>\n        </VisualState>\n      </VisualStateGroup>\n` +
    `    </VisualStateManager.VisualStateGroups>\n  </Grid>\n</Page>`;
  const vsmProp = await completeWith(246, vsmSetter.replace("Chrome.OPH", "Chrome.|"), "vsm-setter-target-prop");
  if (!vsmProp.includes("Opacity") || !vsmProp.includes("Background")) fail(`Setter Target="Chrome." should complete Border props Opacity/Background (got ${vsmProp.slice(0, 40).join(", ")})`);
  console.log(`[ok] completion(VSM Setter.Target prop): 'Chrome.' -> Opacity/Background (${vsmProp.length} items)`);

  // 22h) VisualState <Setter Target="|"> (element-name segment) completes x:Name'd elements in scope.
  const vsmElem = await completeWith(247, vsmSetter.replace('Target="Chrome.OPH"', 'Target="|"'), "vsm-setter-target-elem");
  if (!vsmElem.includes("Chrome")) fail(`Setter Target="" should complete element name 'Chrome' (got ${vsmElem.slice(0, 40).join(", ")})`);
  console.log(`[ok] completion(VSM Setter.Target elem): 'Target="' -> Chrome (${vsmElem.length} items)`);

  // 22i) Storyboard.TargetProperty="|" completes properties of the element named by the sibling TargetName.
  const sbAnim =
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Grid>\n` +
    `    <Border x:Name="Chrome" />\n` +
    `    <Storyboard>\n      <DoubleAnimation Storyboard.TargetName="Chrome" Storyboard.TargetProperty="OPH" To="0.5" />\n` +
    `    </Storyboard>\n  </Grid>\n</Page>`;
  const sbProp = await completeWith(248, sbAnim.replace('TargetProperty="OPH"', 'TargetProperty="|"'), "storyboard-targetproperty");
  if (!sbProp.includes("Opacity")) fail(`Storyboard.TargetProperty="" should complete target Border prop 'Opacity' (got ${sbProp.slice(0, 40).join(", ")})`);
  console.log(`[ok] completion(Storyboard.TargetProperty): -> Opacity (${sbProp.length} items)`);

  // 23) Round-11: x:Bind indexer paths (Items[0].Member) and function-binding arguments (Method(arg)).
  //     Proven hermetically over stdio so no VS Code word-based suggestions can confound the assertions.
  const idxComp = await completeWith(250, pageCls('<TextBlock Text="{x:Bind Items[0].|}" />'), "xbind-indexer-completion");
  if (!idxComp.includes("Length")) fail(`x:Bind indexer 'Items[0].' should complete String.Length (got ${idxComp.slice(0, 40).join(", ")})`);
  console.log(`[ok] completion(x:Bind indexer): 'Items[0].' -> Length (${idxComp.length} items)`);

  const idxHover = await hoverAt(251, pageCls('<TextBlock Text="{x:Bind Items[0].Len|gth}" />'), "xbind-indexer-hover");
  if (!/Length/.test(idxHover) || !/\bint\b|Int32/.test(idxHover)) fail(`x:Bind indexer member hover should resolve String.Length : int (got ${JSON.stringify(idxHover)})`);
  if (/Items/.test(idxHover)) fail(`x:Bind indexer member hover should describe Length, not the Items collection (got ${JSON.stringify(idxHover)})`);
  console.log(`[ok] hover(x:Bind indexer member): 'Items[0].Length' -> ${idxHover.replace(/\n/g, " ").trim()}`);

  const idxBaseHover = await hoverAt(252, pageCls('<TextBlock Text="{x:Bind Item|s[0].Length}" />'), "xbind-indexer-base-hover");
  if (!/Items/.test(idxBaseHover)) fail(`x:Bind hover on the indexer base should identify the Items member (got ${JSON.stringify(idxBaseHover)})`);
  console.log(`[ok] hover(x:Bind indexer base): 'Items[0]' -> ${idxBaseHover.replace(/\n/g, " ").trim()}`);

  const argF12 = await definitionWith(253, pageCls('<TextBlock Text="{x:Bind OnGo_Click(Greeting|Text)}" />'), "xbind-arg-f12");
  if (!argF12?.uri || !argF12.uri.endsWith("SmokePage.xaml.cs")) fail(`x:Bind function-arg F12 (GreetingText) should resolve to SmokePage.xaml.cs (got ${argF12?.uri ?? "null"})`);
  console.log(`[ok] definition(x:Bind function arg): OnGo_Click(GreetingText) -> SmokePage.xaml.cs`);

  const argHover = await hoverAt(254, pageCls('<TextBlock Text="{x:Bind OnGo_Click(Greeting|Text)}" />'), "xbind-arg-hover");
  if (!/GreetingText/.test(argHover) || !/string|String/.test(argHover)) fail(`x:Bind function-arg hover should identify GreetingText : string (got ${JSON.stringify(argHover)})`);
  console.log(`[ok] hover(x:Bind function arg): OnGo_Click(GreetingText) -> ${argHover.replace(/\n/g, " ").trim()}`);

  // A comma-separated function-binding argument list stays one positional path argument, so a later
  // argument still resolves (the parser tracks parenthesis depth when splitting markup arguments).
  const argF12b = await definitionWith(255, pageCls('<TextBlock Text="{x:Bind OnGo_Click(GreetingText, Greeting|Text)}" />'), "xbind-arg2-f12");
  if (!argF12b?.uri || !argF12b.uri.endsWith("SmokePage.xaml.cs")) fail(`x:Bind later function-arg F12 should resolve to SmokePage.xaml.cs (got ${argF12b?.uri ?? "null"})`);
  console.log(`[ok] definition(x:Bind later function arg): OnGo_Click(_, GreetingText) -> SmokePage.xaml.cs`);

  // 23b) Boolean negation ({x:Bind !Member}) still validates/completes/hovers the member after the '!'.
  const negComp = await completeWith(256, pageCls('<TextBlock Text="{x:Bind !Greet|}" />'), "xbind-negation-completion");
  if (!negComp.includes("GreetingText")) fail(`negated x:Bind '!Greet' should complete GreetingText (got ${negComp.slice(0, 40).join(", ")})`);
  console.log(`[ok] completion(x:Bind negation): '!Greet' -> GreetingText (${negComp.length} items)`);

  const negHover = await hoverAt(257, pageCls('<TextBlock Text="{x:Bind !Greeting|Text}" />'), "xbind-negation-hover");
  if (!/GreetingText/.test(negHover) || !/string|String/.test(negHover)) fail(`negated x:Bind hover should identify GreetingText : string (got ${JSON.stringify(negHover)})`);
  console.log(`[ok] hover(x:Bind negation): '!GreetingText' -> ${negHover.replace(/\n/g, " ").trim()}`);

  const negDiag = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <TextBlock Text="{x:Bind !DefinitelyMissingNegated}" />\n</Page>`,
    (d) => d.some((x) => x.code === "WXAML0005"),
    "xbind-negation-diagnostic");
  const negBad = negDiag.filter((x) => x.code === "WXAML0005");
  if (negBad.length !== 1) fail(`negated unknown member should raise exactly 1 WXAML0005, got ${negBad.length}: ${JSON.stringify(negDiag.map((x) => `${x.code}:${x.message}`))}`);
  if (!/DefinitelyMissingNegated/.test(negBad[0].message)) fail(`negation diagnostic should name the missing member (got ${JSON.stringify(negBad[0].message)})`);
  if (negDiag.length !== 1) fail(`expected exactly 1 total diagnostic for the negated-member buffer, got ${negDiag.length}`);
  console.log(`[ok] validation(x:Bind negation): '!DefinitelyMissingNegated' -> exactly 1 WXAML0005`);

  // 26) Cast x:Bind path ((local:Type)Member): the member after the cast resolves against the cast
  // target type for F12/hover/completion. A cast to the page's own type navigates to source.
  const pageCast = (inner) => `<Page ${NS} xmlns:local="using:SmokeFixture" x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
  const castF12 = await definitionWith(310, pageCast('<TextBlock Text="{x:Bind (local:SmokePage)Greeting|Text}" />'), "xbind-cast-f12");
  if (!castF12?.uri || !castF12.uri.endsWith("SmokePage.xaml.cs")) fail(`cast x:Bind member F12 should resolve to SmokePage.xaml.cs (got ${castF12?.uri ?? "null"})`);
  console.log(`[ok] definition(x:Bind cast): (local:SmokePage)GreetingText -> SmokePage.xaml.cs`);

  const castHover = await hoverAt(311, pageCast('<TextBlock Text="{x:Bind (local:SmokePage)Greeting|Text}" />'), "xbind-cast-hover");
  if (!/GreetingText/.test(castHover) || !/string|String/.test(castHover)) fail(`cast x:Bind hover should identify GreetingText : string (got ${JSON.stringify(castHover)})`);
  console.log(`[ok] hover(x:Bind cast): (local:SmokePage)GreetingText -> ${castHover.replace(/\n/g, " ").trim()}`);

  const castComp = await completeWith(312, pageCast('<TextBlock Text="{x:Bind (local:SmokePage)Greet|}" />'), "xbind-cast-completion");
  if (!castComp.includes("GreetingText")) fail(`cast x:Bind '(local:SmokePage)Greet' should complete GreetingText (got ${castComp.slice(0, 40).join(", ")})`);
  console.log(`[ok] completion(x:Bind cast): (local:SmokePage)Greet -> GreetingText (${castComp.length} items)`);

  // The cast genuinely rebinds the root: casting to x:String offers String.Length, which is NOT a
  // member of the page root (a bare {x:Bind Len} would not offer it).
  const castRebind = await completeWith(313, pageCast('<TextBlock Text="{x:Bind (x:String)Len|}" />'), "xbind-cast-rebind");
  if (!castRebind.includes("Length")) fail(`cast to x:String should complete String.Length (got ${castRebind.slice(0, 40).join(", ")})`);
  const pageRootNoLength = await completeWith(314, pageCast('<TextBlock Text="{x:Bind Len|}" />'), "xbind-root-no-length");
  if (pageRootNoLength.includes("Length")) fail(`page root should NOT offer String.Length without a cast (got ${pageRootNoLength.slice(0, 40).join(", ")})`);
  console.log(`[ok] completion(x:Bind cast rebind): (x:String)Len -> Length, page root -> no Length`);

  // 26b) Cast x:Bind TYPO diagnostics (WXAML0005): the member chain after a cast is validated against the
  // cast TARGET type (VS's XAML compiler checks these too). A bad tail member after a valid cast fires.
  const castTailDiag = await validateDoc(
    pageCast('<TextBlock Text="{x:Bind (local:SmokePage)GreetingText.Nope}" />'),
    (d) => d.some((x) => x.code === "WXAML0005" && /Nope/.test(x.message)),
    "xbind-cast-tail-typo");
  const castTailBad = castTailDiag.filter((x) => x.code === "WXAML0005");
  if (castTailBad.length !== 1) fail(`cast tail typo '(local:SmokePage)GreetingText.Nope' should raise exactly 1 WXAML0005, got ${castTailBad.length}: ${JSON.stringify(castTailDiag.map((x) => `${x.code}:${x.message}`))}`);
  if (!/Nope/.test(castTailBad[0].message)) fail(`cast tail diagnostic should name the missing member Nope (got ${JSON.stringify(castTailBad[0].message)})`);

  // A bad FIRST member checked directly against the cast target type fires too.
  const castFirstDiag = await validateDoc(
    pageCast('<TextBlock Text="{x:Bind (local:SmokePage)BogusMember}" />'),
    (d) => d.some((x) => x.code === "WXAML0005" && /BogusMember/.test(x.message)),
    "xbind-cast-first-typo");
  const castFirstBad = castFirstDiag.filter((x) => x.code === "WXAML0005");
  if (castFirstBad.length !== 1) fail(`cast first-member typo '(local:SmokePage)BogusMember' should raise exactly 1 WXAML0005, got ${castFirstBad.length}: ${JSON.stringify(castFirstDiag.map((x) => `${x.code}:${x.message}`))}`);
  if (!/BogusMember/.test(castFirstBad[0].message)) fail(`cast first-member diagnostic should name BogusMember (got ${JSON.stringify(castFirstBad[0].message)})`);
  console.log(`[ok] validation(x:Bind cast typo): (local:SmokePage)GreetingText.Nope + (local:SmokePage)BogusMember -> 2 WXAML0005`);

  // 26c) Cast false-positive guard: a valid cast member chain, a valid intrinsic cast, an unresolved cast
  // target, and an attached-property step must ALL stay silent — only the plain sentinel path fires. This
  // proves cast validation adds no spurious diagnostics on the conservative paths.
  const castSilentInner = [
    '<StackPanel>',
    '    <TextBlock Text="{x:Bind (local:SmokePage)GreetingText}" />',
    '    <TextBlock Text="{x:Bind (x:String)Length}" />',
    '    <TextBlock Text="{x:Bind (Grid.Row)}" />',
    '    <TextBlock Text="{x:Bind (local:Unknown)Whatever}" />',
    '    <TextBlock Text="{x:Bind CastSentinelMissing}" />',
    '  </StackPanel>',
  ].join('\n  ');
  const castSilentDiag = await validateDoc(
    pageCast(castSilentInner),
    (d) => d.some((x) => x.code === "WXAML0005" && /CastSentinelMissing/.test(x.message)),
    "xbind-cast-silent-guard");
  const castSilentBad = castSilentDiag.filter((x) => x.code === "WXAML0005");
  if (castSilentBad.length !== 1) fail(`valid/unresolved/attached casts must add no WXAML0005 — only the sentinel should fire, got ${castSilentBad.length}: ${JSON.stringify(castSilentDiag.map((x) => `${x.code}:${x.message}`))}`);
  console.log(`[ok] validation(x:Bind cast silent guard): valid + intrinsic + unresolved + attached casts -> 0 spurious WXAML0005 (only sentinel)`);

  // 27) Attached-property x:Bind path ((Grid.Row)): hover identifies the attached property on the owner.
  const attachedHover = await hoverAt(315, pageCast('<TextBlock Text="{x:Bind (Grid.R|ow)}" />'), "xbind-attached-hover");
  if (!/Grid\.Row/.test(attachedHover)) fail(`attached x:Bind path hover should identify Grid.Row (got ${JSON.stringify(attachedHover)})`);
  if (!/attached property/.test(attachedHover)) fail(`attached x:Bind path hover should label it an attached property (got ${JSON.stringify(attachedHover)})`);
  console.log(`[ok] hover(x:Bind attached): (Grid.Row) -> ${attachedHover.replace(/\n/g, " ").trim()}`);

  // Caret precision: the attached-property hover fires ONLY on the member (Row), never on the owner
  // type (Grid) or the dot boundary -- otherwise hovering the owner wrongly claims it is the property.
  const attachedOnOwner = await hoverAt(316, pageCast('<TextBlock Text="{x:Bind (G|rid.Row)}" />'), "xbind-attached-owner-caret");
  if (/attached property/.test(attachedOnOwner)) fail(`caret on the owner type of (Grid.Row) must NOT render the attached-property hover (got ${JSON.stringify(attachedOnOwner)})`);
  const attachedOnDot = await hoverAt(317, pageCast('<TextBlock Text="{x:Bind (Grid|.Row)}" />'), "xbind-attached-dot-caret");
  if (/attached property/.test(attachedOnDot)) fail(`caret on the dot boundary of (Grid.Row) must NOT render the attached-property hover (got ${JSON.stringify(attachedOnDot)})`);
  console.log(`[ok] hover(x:Bind attached precision): caret on owner/dot -> no attached-property hover`);

  // 28) Round-28 regressions: function-argument validation/completion + lexically-scoped resource F12.
  // Function-binding arguments are paths bound against the root: a bogus argument member is flagged the
  // same as a bogus root path, while valid arguments (including indexer tails) stay silent.
  const fnArgDiag = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <StackPanel>\n` +
    `    <TextBlock Text="{x:Bind OnGo_Click(GreetingText, Items[0])}" />\n` +      // valid: both args are members
    `    <TextBlock Text="{x:Bind OnGo_Click(GreetingText, DefinitelyMissingArg28)}" />\n  </StackPanel>\n</Page>`,
    (d) => d.some((x) => x.code === "WXAML0005"),
    "function-arg-diagnostic");
  const fnArgBad = fnArgDiag.filter((x) => x.code === "WXAML0005");
  if (fnArgBad.length !== 1) fail(`expected exactly 1 WXAML0005 for the bogus function argument (valid args must stay silent), got ${fnArgBad.length}: ${JSON.stringify(fnArgDiag.map((x) => `${x.code}:${x.message}`))}`);
  if (!/DefinitelyMissingArg28/.test(fnArgBad[0].message)) fail(`function-arg diagnostic should name the bogus argument (got ${JSON.stringify(fnArgBad[0].message)})`);
  console.log(`[ok] validation(x:Bind function arg): bogus arg -> 1 WXAML0005; valid args silent`);

  // Completion inside a function-argument gap offers page members (the next argument binds to the root).
  const fnArgComp = await completeWith(320, pageCls('<TextBlock Text="{x:Bind OnGo_Click(GreetingText, |)}" />'), "function-arg-completion");
  for (const want of ["GreetingText", "Items"]) {
    if (!fnArgComp.includes(want)) fail(`function-argument gap should complete '${want}' (got ${fnArgComp.slice(0, 40).join(", ")})`);
  }
  console.log(`[ok] completion(x:Bind function arg gap): OnGo_Click(GreetingText, |) -> page members (${fnArgComp.length} items)`);

  // A {StaticResource} reference inside a <Grid.Resources> scope resolves the NEAREST key, shadowing an
  // outer <Page.Resources> key of the same name; F12 selects the x:Key value span, not the element tag.
  const shadowBody =
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n` +
    `  <Page.Resources>\n    <SolidColorBrush x:Key="ScopeKey28" Color="Red" />\n  </Page.Resources>\n` +
    `  <Grid>\n    <Grid.Resources>\n      <SolidColorBrush x:Key="ScopeKey28" Color="Blue" />\n    </Grid.Resources>\n` +
    `    <Border Background="{StaticResource Scope|Key28}" />\n  </Grid>\n</Page>`;
  const shadowClean = shadowBody.replace("|", "");
  const shadowLines = shadowClean.split("\n");
  const expectedShadowLine = shadowLines.findIndex((l) => l.includes('x:Key="ScopeKey28"') && l.includes('Color="Blue"'));
  const shadowDef = await definitionWith(321, shadowBody, "scoped-resource-f12");
  if (!shadowDef?.range) fail(`scoped resource F12 should resolve; got ${JSON.stringify(shadowDef)}`);
  if (shadowDef.range.start.line !== expectedShadowLine) fail(`scoped resource F12 should land on the inner Grid.Resources key (line ${expectedShadowLine}), got line ${shadowDef.range.start.line}`);
  const shadowKeyText = shadowLines[shadowDef.range.start.line].slice(shadowDef.range.start.character, shadowDef.range.end.character);
  if (shadowKeyText !== "ScopeKey28") fail(`scoped resource F12 range should select the x:Key value 'ScopeKey28', got ${JSON.stringify(shadowKeyText)}`);
  console.log(`[ok] definition(scoped resource): inner Grid.Resources shadows Page.Resources; range selects x:Key value`);

  // 23a) The indexer first-segment base is validated: a bogus base is flagged while a valid Items[0] stays silent.
  const idxDiag = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <StackPanel>\n` +
    `    <TextBlock Text="{x:Bind Items[0].Length}" />\n` +
    `    <TextBlock Text="{x:Bind Bogus[0].Length}" />\n  </StackPanel>\n</Page>`,
    (d) => d.some((x) => x.code === "WXAML0005"),
    "indexer-base-diagnostic");
  const idxBad = idxDiag.filter((x) => x.code === "WXAML0005");
  if (idxBad.length !== 1) fail(`expected exactly 1 WXAML0005 for the bogus indexer base, got ${idxBad.length}: ${JSON.stringify(idxDiag.map((x) => `${x.code}:${x.message}`))}`);
  if (!/Bogus/.test(idxBad[0].message)) fail(`indexer-base diagnostic should name the bogus base 'Bogus' (got ${JSON.stringify(idxBad[0].message)})`);
  if (idxDiag.length !== 1) fail(`expected exactly 1 total diagnostic for the indexer buffer (Items[0] must stay silent), got ${idxDiag.length}`);
  console.log(`[ok] validation(x:Bind indexer base): 'Bogus[0]' -> 1 WXAML0005, 'Items[0]' silent`);

  // 23c) Property-element member validation (WXAML0006): a mis-cased property element (<Grid.rowDefinitions>)
  // is flagged, while a correctly-cased instance property element (<Grid.RowDefinitions>) and an attached
  // property used in element form (<Grid.Row>) stay silent — proving no false positives on valid forms.
  const peDiag = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Grid>\n` +
    `    <Grid.RowDefinitions>\n      <RowDefinition />\n    </Grid.RowDefinitions>\n` +
    `    <Grid.rowDefinitions>\n      <RowDefinition />\n    </Grid.rowDefinitions>\n` +
    `    <TextBlock><Grid.Row>0</Grid.Row></TextBlock>\n  </Grid>\n</Page>`,
    (d) => d.some((x) => x.code === "WXAML0006"),
    "property-element-diagnostic");
  const peBad = peDiag.filter((x) => x.code === "WXAML0006");
  if (peBad.length !== 1) fail(`expected exactly 1 WXAML0006 for the mis-cased property element, got ${peBad.length}: ${JSON.stringify(peDiag.map((x) => `${x.code}:${x.message}`))}`);
  if (!/rowDefinitions/.test(peBad[0].message)) fail(`property-element diagnostic should name the mis-cased member 'rowDefinitions' (got ${JSON.stringify(peBad[0].message)})`);
  if (peDiag.length !== 1) fail(`expected exactly 1 total diagnostic (valid <Grid.RowDefinitions> and attached <Grid.Row> must stay silent), got ${peDiag.length}: ${JSON.stringify(peDiag.map((x) => `${x.code}:${x.message}`))}`);
  console.log(`[ok] validation(property element): '<Grid.rowDefinitions>' -> 1 WXAML0006; valid instance/attached forms silent`);

  // 23c2) UNKNOWN-OWNER property element (<Bogus.Foo>): the owner type does not resolve in the (known)
  // default namespace, so it is flagged as an unknown type (WXAML0002) on the OWNER segment — mirroring a
  // plain <Bogus> element. The member 'Foo' is NOT separately flagged, and a real property element in the
  // same buffer (<Grid.RowDefinitions>) stays silent, proving the owner check doesn't over-fire.
  const poDiag = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Grid>\n` +
    `    <Grid.RowDefinitions>\n      <RowDefinition />\n    </Grid.RowDefinitions>\n` +
    `    <Bogus.Foo>\n      <RowDefinition />\n    </Bogus.Foo>\n  </Grid>\n</Page>`,
    (d) => d.some((x) => x.code === "WXAML0002"),
    "property-element-unknown-owner");
  const poBad = poDiag.filter((x) => x.code === "WXAML0002");
  if (poBad.length !== 1) fail(`expected exactly 1 WXAML0002 for the unknown property-element owner, got ${poBad.length}: ${JSON.stringify(poDiag.map((x) => `${x.code}:${x.message}`))}`);
  if (!/Bogus/.test(poBad[0].message)) fail(`unknown-owner diagnostic should name the owner 'Bogus' (got ${JSON.stringify(poBad[0].message)})`);
  if (/Foo/.test(poBad[0].message)) fail(`unknown-owner diagnostic should flag the OWNER, not the member 'Foo' (got ${JSON.stringify(poBad[0].message)})`);
  if (poDiag.length !== 1) fail(`expected exactly 1 total diagnostic (valid <Grid.RowDefinitions> must stay silent), got ${poDiag.length}: ${JSON.stringify(poDiag.map((x) => `${x.code}:${x.message}`))}`);
  console.log(`[ok] validation(property element): '<Bogus.Foo>' -> 1 WXAML0002 on owner; valid forms silent`);

  // 23d) An event used as a property element (<Button.Click>) is WXAML0006 — events need attribute syntax,
  // so property-element syntax is invalid even though Click IS a member of Button.
  const evtDiag = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Button>\n    <Button.Click>OnGo_Click</Button.Click>\n  </Button>\n</Page>`,
    (d) => d.some((x) => x.code === "WXAML0006"),
    "event-property-element-diagnostic");
  const evtBad = evtDiag.filter((x) => x.code === "WXAML0006");
  if (evtBad.length !== 1) fail(`event-as-property-element should raise exactly 1 WXAML0006, got ${evtBad.length}: ${JSON.stringify(evtDiag.map((x) => `${x.code}:${x.message}`))}`);
  if (!/Click/.test(evtBad[0].message) || !/event/.test(evtBad[0].message)) fail(`event property-element diagnostic should name 'Click' and mention it is an event (got ${JSON.stringify(evtBad[0].message)})`);
  if (evtDiag.length !== 1) fail(`expected exactly 1 total diagnostic for the event-property-element buffer, got ${evtDiag.length}`);
  console.log(`[ok] validation(property element): '<Button.Click>' event -> 1 WXAML0006 (event-specific message)`);

  // 23e) x:Bind NON-FIRST-segment validation (WXAML0005 extended): a bad member after a valid first
  // segment is now flagged, while valid multi-segment paths (dotted, indexer-tail, interface members)
  // stay silent — the walk types each hop the same way completion/hover do.
  const nfDiag = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <StackPanel>\n` +
    `    <TextBlock Text="{x:Bind GreetingText.Length}" />\n` +      // valid: string.Length
    `    <TextBlock Text="{x:Bind Items[0].Length}" />\n` +          // valid: element (string).Length
    `    <TextBlock Text="{x:Bind Items.Count}" />\n` +              // valid: IReadOnlyList<>.Count (interface)
    `    <TextBlock Text="{x:Bind GreetingText.Nope}" />\n  </StackPanel>\n</Page>`, // INVALID: string has no Nope
    (d) => d.some((x) => x.code === "WXAML0005"),
    "nonfirst-segment-diagnostic");
  const nfBad = nfDiag.filter((x) => x.code === "WXAML0005");
  if (nfBad.length !== 1) fail(`expected exactly 1 WXAML0005 for the bad non-first member (valid dotted/indexer/interface paths must stay silent), got ${nfBad.length}: ${JSON.stringify(nfDiag.map((x) => `${x.code}:${x.message}`))}`);
  if (!/Nope/.test(nfBad[0].message)) fail(`non-first-segment diagnostic should name the bad member 'Nope' (got ${JSON.stringify(nfBad[0].message)})`);
  if (!/String/.test(nfBad[0].message)) fail(`non-first-segment diagnostic should name the owning type 'String' (got ${JSON.stringify(nfBad[0].message)})`);
  console.log(`[ok] validation(x:Bind non-first): 'GreetingText.Nope' -> 1 WXAML0005 on String; valid dotted/indexer/interface paths silent`);

  // 23f) The non-first walk unwraps indexer element types too: Items[0] is a string, so a bad tail
  // member after the indexer is flagged against String.
  const nfIdxDiag = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <StackPanel>\n` +
    `    <TextBlock Text="{x:Bind Items[0].Nope}" />\n  </StackPanel>\n</Page>`,
    (d) => d.some((x) => x.code === "WXAML0005"),
    "nonfirst-indexer-tail-diagnostic");
  const nfIdxBad = nfIdxDiag.filter((x) => x.code === "WXAML0005");
  if (nfIdxBad.length !== 1) fail(`expected exactly 1 WXAML0005 for the bad member after an indexer, got ${nfIdxBad.length}: ${JSON.stringify(nfIdxDiag.map((x) => `${x.code}:${x.message}`))}`);
  if (!/Nope/.test(nfIdxBad[0].message)) fail(`indexer-tail diagnostic should name the bad member 'Nope' (got ${JSON.stringify(nfIdxBad[0].message)})`);
  console.log(`[ok] validation(x:Bind non-first): 'Items[0].Nope' -> 1 WXAML0005 (indexer element type walked)`);

  // 24) {x:Type} / {x:Static} navigation + completion (round 20).
  const xTypeHover = await hoverAt(300,
    `<Page ${NS}>\n  <Button Tag="{x:Type Butt|on}" />\n</Page>`, "x:Type-hover");
  if (!/Button/.test(xTypeHover)) fail(`{x:Type Button} hover should identify the Button type (got ${JSON.stringify(xTypeHover)})`);
  if (!/class/.test(xTypeHover)) fail(`{x:Type Button} hover should render the class keyword (got ${JSON.stringify(xTypeHover)})`);
  console.log(`[ok] hover(x:Type): '{x:Type Button}' -> ${xTypeHover.replace(/\n/g, " ").trim()}`);

  const dLocalX = 'xmlns:local="using:SmokeFixture"';
  const xTypeDef = await definitionWith(301,
    `<Page ${NS} ${dLocalX}>\n  <Button Tag="{x:Type local:Smoke|Page}" />\n</Page>`, "x:Type-f12");
  if (!xTypeDef?.uri || !xTypeDef.uri.endsWith("SmokePage.xaml.cs")) fail(`{x:Type local:SmokePage} F12 should land on SmokePage.xaml.cs (got ${xTypeDef?.uri ?? "null"})`);
  console.log(`[ok] definition(x:Type user type): '{x:Type local:SmokePage}' -> SmokePage.xaml.cs`);

  const xStaticHover = await hoverAt(302,
    `<Page ${NS}>\n  <Button Tag="{x:Static Visibility.Collap|sed}" />\n</Page>`, "x:Static-hover");
  if (!/Collapsed/.test(xStaticHover)) fail(`{x:Static Visibility.Collapsed} hover should name the Collapsed member (got ${JSON.stringify(xStaticHover)})`);
  if (!/Visibility/.test(xStaticHover)) fail(`{x:Static Visibility.Collapsed} hover should name the Visibility type (got ${JSON.stringify(xStaticHover)})`);
  console.log(`[ok] hover(x:Static): '{x:Static Visibility.Collapsed}' -> ${xStaticHover.replace(/\n/g, " ").trim()}`);

  // Caret on the OWNER segment resolves the owner TYPE, not the member (caret precision, like round 19).
  const xStaticOwner = await hoverAt(303,
    `<Page ${NS}>\n  <Button Tag="{x:Static Visi|bility.Collapsed}" />\n</Page>`, "x:Static-owner");
  if (!/Visibility/.test(xStaticOwner)) fail(`{x:Static} owner-segment hover should resolve the Visibility type (got ${JSON.stringify(xStaticOwner)})`);
  if (/Collapsed/.test(xStaticOwner)) fail(`{x:Static} owner-segment hover must not resolve the Collapsed member (got ${JSON.stringify(xStaticOwner)})`);
  console.log(`[ok] hover(x:Static owner): '{x:Static Visi|bility.Collapsed}' -> ${xStaticOwner.replace(/\n/g, " ").trim()}`);

  const xTypeComplete = await completeWith(304,
    `<Page ${NS}>\n  <Button Tag="{x:Type Butt|}" />\n</Page>`, "x:Type-completion");
  if (!xTypeComplete.includes("Button")) fail(`{x:Type Butt} completion should offer Button (got ${xTypeComplete.length} items)`);
  console.log(`[ok] completion(x:Type): '{x:Type Butt' -> Button (${xTypeComplete.length} items)`);

  const xStaticComplete = await completeWith(305,
    `<Page ${NS}>\n  <Button Tag="{x:Static Visibility.|}" />\n</Page>`, "x:Static-completion");
  for (const want of ["Collapsed", "Visible"]) {
    if (!xStaticComplete.includes(want)) fail(`{x:Static Visibility.} completion missing '${want}' (got ${xStaticComplete.join(",")})`);
  }
  console.log(`[ok] completion(x:Static members): '{x:Static Visibility.' -> Collapsed/Visible (${xStaticComplete.length} items)`);

  const xNameComplete = await completeWith(306,
    `<Page ${NS}>\n  <Button Tag="{x:S|}" />\n</Page>`, "x:Static-name-completion");
  if (!xNameComplete.includes("x:Static")) fail(`'{x:S' should offer the x:Static markup extension (got ${xNameComplete.join(",")})`);
  console.log(`[ok] completion(markup name): '{x:S' -> x:Static (${xNameComplete.length} items)`);

  // 24b) Type-reference completion ({x:Type} / {x:Static} owner) offers ALL type kinds — enums and
  // structs and static classes — not just instantiable classes like element-name completion. Regression
  // guard for the round-21 fix: Visibility (enum) and Thickness (struct) are reachable here even though
  // they are excluded from <Element> completion.
  const xTypeEnum = await completeWith(307,
    `<Page ${NS}>\n  <Button Tag="{x:Type Vis|}" />\n</Page>`, "x:Type-enum-completion");
  if (!xTypeEnum.includes("Visibility")) fail(`{x:Type Vis} completion should offer the Visibility enum (got ${xTypeEnum.join(",")})`);
  console.log(`[ok] completion(x:Type enum): '{x:Type Vis' -> Visibility (${xTypeEnum.length} items)`);

  const xTypeStruct = await completeWith(308,
    `<Page ${NS}>\n  <Button Tag="{x:Type Thick|}" />\n</Page>`, "x:Type-struct-completion");
  if (!xTypeStruct.includes("Thickness")) fail(`{x:Type Thick} completion should offer the Thickness struct (got ${xTypeStruct.join(",")})`);
  console.log(`[ok] completion(x:Type struct): '{x:Type Thick' -> Thickness (${xTypeStruct.length} items)`);

  const xStaticOwnerEnum = await completeWith(309,
    `<Page ${NS}>\n  <Button Tag="{x:Static Vis|}" />\n</Page>`, "x:Static-owner-enum-completion");
  if (!xStaticOwnerEnum.includes("Visibility")) fail(`{x:Static Vis} owner completion should offer the Visibility enum (got ${xStaticOwnerEnum.join(",")})`);
  console.log(`[ok] completion(x:Static owner enum): '{x:Static Vis' -> Visibility (${xStaticOwnerEnum.length} items)`);

  // 25a) DUPLICATE x:Name in the same (page-root) name scope -> exactly 1 WXAML0007 (an error) on the
  // duplicated name; a differently-named sibling stays silent, proving the check does not over-fire.
  const dupName = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <StackPanel>\n` +
    `    <Button x:Name="Dup" />\n` +
    `    <TextBlock x:Name="Unique" />\n` +
    `    <Button x:Name="Dup" />\n  </StackPanel>\n</Page>`,
    (d) => d.some((x) => x.code === "WXAML0007"),
    "duplicate-x-name");
  const dupNameBad = dupName.filter((x) => x.code === "WXAML0007");
  if (dupNameBad.length !== 1) fail(`expected exactly 1 WXAML0007 for the duplicated x:Name, got ${dupNameBad.length}: ${JSON.stringify(dupName.map((x) => `${x.code}:${x.message}`))}`);
  if (!/\bDup\b/.test(dupNameBad[0].message)) fail(`duplicate-name diagnostic should name 'Dup' (got ${JSON.stringify(dupNameBad[0].message)})`);
  if (dupNameBad[0].severity !== 1) fail(`duplicate x:Name should be an error (severity 1), got ${dupNameBad[0].severity}`);
  if (dupName.length !== 1) fail(`expected exactly 1 total diagnostic (the uniquely-named sibling must stay silent), got ${dupName.length}: ${JSON.stringify(dupName.map((x) => `${x.code}:${x.message}`))}`);
  console.log(`[ok] validation(x:Name): duplicate 'Dup' -> 1 WXAML0007 (error); unique name silent`);

  // 25b) The SAME x:Name reused at page scope AND inside two separate DataTemplates is NOT a collision:
  // each template instantiates its own name scope. Proven with a genuine page-scope duplicate ('Trigger')
  // as the sentinel — exactly 1 WXAML0007 must fire, and it must name 'Trigger', never the scoped 'Item'.
  const scopedName = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <StackPanel>\n` +
    `    <TextBlock x:Name="Item" />\n` +
    `    <ContentControl>\n      <DataTemplate>\n        <TextBlock x:Name="Item" />\n      </DataTemplate>\n    </ContentControl>\n` +
    `    <ContentControl>\n      <DataTemplate>\n        <TextBlock x:Name="Item" />\n      </DataTemplate>\n    </ContentControl>\n` +
    `    <Button x:Name="Trigger" />\n    <Button x:Name="Trigger" />\n  </StackPanel>\n</Page>`,
    (d) => d.some((x) => x.code === "WXAML0007"),
    "scoped-x-name");
  const scopedBad = scopedName.filter((x) => x.code === "WXAML0007");
  if (scopedBad.length !== 1) fail(`per-scope names must not collide: expected exactly 1 WXAML0007 (the page-scope 'Trigger' dup), got ${scopedBad.length}: ${JSON.stringify(scopedName.map((x) => `${x.code}:${x.message}`))}`);
  if (!/\bTrigger\b/.test(scopedBad[0].message)) fail(`the only duplicate-name diagnostic should name 'Trigger' (got ${JSON.stringify(scopedBad[0].message)})`);
  if (/\bItem\b/.test(scopedBad[0].message)) fail(`x:Name 'Item' reused across separate template scopes must NOT be flagged (got ${JSON.stringify(scopedBad[0].message)})`);
  console.log(`[ok] validation(x:Name): 'Item' across two DataTemplates + page scope -> silent; only page-scope 'Trigger' dup fires`);

  // 25c) DUPLICATE x:Key in one dictionary (<Page.Resources>) -> exactly 1 WXAML0008 (an error); a
  // distinctly-keyed entry and the dictionary property element itself stay silent (no false positives).
  const dupKey = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Page.Resources>\n` +
    `    <SolidColorBrush x:Key="Accent" Color="Red" />\n` +
    `    <SolidColorBrush x:Key="Other" Color="Green" />\n` +
    `    <SolidColorBrush x:Key="Accent" Color="Blue" />\n  </Page.Resources>\n` +
    `  <Grid />\n</Page>`,
    (d) => d.some((x) => x.code === "WXAML0008"),
    "duplicate-x-key");
  const dupKeyBad = dupKey.filter((x) => x.code === "WXAML0008");
  if (dupKeyBad.length !== 1) fail(`expected exactly 1 WXAML0008 for the duplicated x:Key, got ${dupKeyBad.length}: ${JSON.stringify(dupKey.map((x) => `${x.code}:${x.message}`))}`);
  if (!/same key/i.test(dupKeyBad[0].message)) fail(`duplicate-key diagnostic should mention the same key was already added (got ${JSON.stringify(dupKeyBad[0].message)})`);
  if (dupKeyBad[0].severity !== 1) fail(`duplicate x:Key should be an error (severity 1), got ${dupKeyBad[0].severity}`);
  if (dupKey.length !== 1) fail(`expected exactly 1 total diagnostic (distinct key + the Page.Resources element must stay silent), got ${dupKey.length}: ${JSON.stringify(dupKey.map((x) => `${x.code}:${x.message}`))}`);
  console.log(`[ok] validation(x:Key): duplicate 'Accent' -> 1 WXAML0008 (error); distinct key silent`);

  // 25d) The SAME x:Key in two DIFFERENT dictionaries (<Page.Resources> vs a nested <Grid.Resources>) is
  // NOT a collision — each dictionary is its own key scope. Proven with a genuine duplicate ('Dup') in the
  // page dictionary as the sentinel: exactly 1 WXAML0008 must fire (the cross-dictionary 'Shared' stays silent).
  const scopedKey = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Page.Resources>\n` +
    `    <SolidColorBrush x:Key="Shared" Color="Red" />\n` +
    `    <SolidColorBrush x:Key="Dup" Color="Green" />\n` +
    `    <SolidColorBrush x:Key="Dup" Color="Blue" />\n  </Page.Resources>\n` +
    `  <Grid>\n    <Grid.Resources>\n      <SolidColorBrush x:Key="Shared" Color="Black" />\n    </Grid.Resources>\n  </Grid>\n</Page>`,
    (d) => d.some((x) => x.code === "WXAML0008"),
    "scoped-x-key");
  const scopedKeyBad = scopedKey.filter((x) => x.code === "WXAML0008");
  if (scopedKeyBad.length !== 1) fail(`per-dictionary keys must not collide: expected exactly 1 WXAML0008 (the page-dictionary 'Dup'), got ${scopedKeyBad.length}: ${JSON.stringify(scopedKey.map((x) => `${x.code}:${x.message}`))}`);
  console.log(`[ok] validation(x:Key): 'Shared' across <Page.Resources> and <Grid.Resources> -> silent; only page-dict 'Dup' fires`);

  // 25e) Duplicate x:Key expressed as an {x:Type Foo} implicit-style key is a collision too (VS-parity),
  // while a DISTINCT {x:Type} (TextBox) and a same-text STRING key ("Button", a separate key-space) must
  // NOT collide with it. Exactly 1 WXAML0008 must fire (the duplicated {x:Type Button}).
  const typeKey = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Page.Resources>\n` +
    `    <Style x:Key="{x:Type Button}" TargetType="Button" />\n` +
    `    <Style x:Key="{x:Type Button}" TargetType="Button" />\n` +
    `    <Style x:Key="{x:Type TextBox}" TargetType="TextBox" />\n` +
    `    <SolidColorBrush x:Key="Button" Color="Red" />\n  </Page.Resources>\n` +
    `  <Grid />\n</Page>`,
    (d) => d.some((x) => x.code === "WXAML0008"),
    "type-key-dup");
  const typeKeyBad = typeKey.filter((x) => x.code === "WXAML0008");
  if (typeKeyBad.length !== 1) fail(`{x:Type Button} duplicate should raise exactly 1 WXAML0008 (distinct {x:Type TextBox} and string key "Button" must not collide), got ${typeKeyBad.length}: ${JSON.stringify(typeKey.map((x) => `${x.code}:${x.message}`))}`);
  if (typeKeyBad[0].severity !== 1) fail(`duplicate {x:Type} key should be an error (severity 1), got ${typeKeyBad[0].severity}`);
  console.log(`[ok] validation(x:Key): duplicate '{x:Type Button}' -> 1 WXAML0008; distinct {x:Type TextBox} + string "Button" silent`);

  // 27) Find All References (textDocument/references), document-scoped. Driven on self-contained buffers
  //      (x:Name declaration + ElementName + Storyboard.TargetName usages; x:Key declaration + StaticResource
  //      + ThemeResource usages). Ranges are sliced back to text so assertions never hardcode positions.
  const nameBase =
    `<Page ${NS} xmlns:local="using:SmokeFixture" x:Class="SmokeFixture.SmokePage">\n` +
    `  <StackPanel>\n` +
    `    <Button x:Name="GoButton" Content="Go" />\n` +
    `    <TextBlock Text="{Binding ElementName=GoButton}" />\n` +
    `    <Storyboard>\n` +
    `      <DoubleAnimation Storyboard.TargetName="GoButton" Storyboard.TargetProperty="Opacity" />\n` +
    `    </Storyboard>\n` +
    `  </StackPanel>\n</Page>`;

  // 27a) caret ON the x:Name declaration, includeDeclaration=true -> declaration + both usages (3), all "GoButton".
  const nameDecl = await referencesWith(330, nameBase.replace('x:Name="GoButton"', 'x:Name="Go|Button"'), "name-decl", true);
  if (nameDecl.locations.length !== 3) fail(`references(x:Name decl, includeDecl): expected 3 (decl + ElementName + TargetName), got ${nameDecl.locations.length}: ${JSON.stringify(nameDecl.texts)}`);
  if (!nameDecl.texts.every((t) => t === "GoButton")) fail(`references(x:Name) should all read 'GoButton', got ${JSON.stringify(nameDecl.texts)}`);
  console.log(`[ok] references(x:Name decl): 3 locations (decl + ElementName + Storyboard.TargetName), all 'GoButton'`);

  // 27b) caret ON the ElementName usage, includeDeclaration=false -> both usages only (2), declaration excluded.
  const nameUse = await referencesWith(331, nameBase.replace("ElementName=GoButton}", "ElementName=GoBut|ton}"), "name-use-nodecl", false);
  if (nameUse.locations.length !== 2) fail(`references(x:Name usage, includeDecl=false): expected 2 usages (no declaration), got ${nameUse.locations.length}: ${JSON.stringify(nameUse.texts)}`);
  if (!nameUse.texts.every((t) => t === "GoButton")) fail(`references(x:Name usage) should all read 'GoButton', got ${JSON.stringify(nameUse.texts)}`);
  console.log(`[ok] references(x:Name usage, includeDecl=false): 2 usages, declaration excluded`);

  const resBase =
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n` +
    `  <Page.Resources>\n` +
    `    <SolidColorBrush x:Key="Brush1" Color="Red" />\n` +
    `  </Page.Resources>\n` +
    `  <StackPanel>\n` +
    `    <Border Background="{StaticResource Brush1}" />\n` +
    `    <Border Background="{ThemeResource Brush1}" />\n` +
    `  </StackPanel>\n</Page>`;

  // 27c) caret ON the x:Key declaration, includeDeclaration=true -> declaration + both usages (3), all "Brush1".
  const keyDecl = await referencesWith(332, resBase.replace('x:Key="Brush1"', 'x:Key="Bru|sh1"'), "key-decl", true);
  if (keyDecl.locations.length !== 3) fail(`references(x:Key decl, includeDecl): expected 3 (decl + StaticResource + ThemeResource), got ${keyDecl.locations.length}: ${JSON.stringify(keyDecl.texts)}`);
  if (!keyDecl.texts.every((t) => t === "Brush1")) fail(`references(x:Key) should all read 'Brush1', got ${JSON.stringify(keyDecl.texts)}`);
  console.log(`[ok] references(x:Key decl): 3 locations (decl + StaticResource + ThemeResource), all 'Brush1'`);

  // 27d) caret ON a {StaticResource} usage, includeDeclaration=false -> both usages only (2), declaration excluded.
  const keyUse = await referencesWith(333, resBase.replace("{StaticResource Brush1}", "{StaticResource Bru|sh1}"), "key-use-nodecl", false);
  if (keyUse.locations.length !== 2) fail(`references(x:Key usage, includeDecl=false): expected 2 usages (no declaration), got ${keyUse.locations.length}: ${JSON.stringify(keyUse.texts)}`);
  if (!keyUse.texts.every((t) => t === "Brush1")) fail(`references(x:Key usage) should all read 'Brush1', got ${JSON.stringify(keyUse.texts)}`);
  console.log(`[ok] references(x:Key usage, includeDecl=false): 2 usages, declaration excluded`);

  // 27e) caret NOT on a reference (a plain element tag) -> no references.
  const noRef = await referencesWith(334, nameBase.replace("<StackPanel>", "<StackPa|nel>"), "no-ref", true);
  if (noRef.locations.length !== 0) fail(`references(non-reference caret): expected 0, got ${noRef.locations.length}: ${JSON.stringify(noRef.texts)}`);
  console.log(`[ok] references(non-reference caret): 0 locations`);

  // 27f) ROUND 79: cross-file resource-key Find All References. SmokeAccentBrush is DECLARED in App.xaml
  //      and USED across pages (SmokePage, DiPage), so references must span the whole project (read-only),
  //      not just the open document. Restore the real SmokePage buffer first (earlier cases mutated it),
  //      then reference the real {StaticResource SmokeAccentBrush} usage.
  send({ method: "textDocument/didChange", params: { textDocument: { uri: xamlUri, version: ++version }, contentChanges: [{ text: xamlText }] } });
  send({ id: 524, method: "textDocument/references", params: { textDocument: { uri: xamlUri }, position: resCaret, context: { includeDeclaration: true } } });
  const xref = await waitFor(responseFor(524), 30000, "xref-with-decl");
  if (xref.error) fail(`cross-file references errored: ${JSON.stringify(xref.error)}`);
  const xrefLocs = Array.isArray(xref.result) ? xref.result : [];
  const uriEndsWith = (needle) => xrefLocs.filter((l) => l.uri.toLowerCase().endsWith(needle)).length;
  if (xrefLocs.some((l) => /[\\/]obj[\\/]/i.test(decodeURIComponent(l.uri)))) {
    fail(`cross-file refs leaked a build-output (obj) copy: ${JSON.stringify(xrefLocs.map((l) => l.uri))}`);
  }
  if (xrefLocs.length !== 5) {
    fail(`cross-file references(SmokeAccentBrush, includeDecl): expected 5 (3 SmokePage + 1 App decl + 1 DiPage), got ${xrefLocs.length}: ${JSON.stringify(xrefLocs.map((l) => `${l.uri}@${l.range.start.line}`))}`);
  }
  if (uriEndsWith("smokepage.xaml") !== 3) fail(`expected 3 SmokePage usages, got ${uriEndsWith("smokepage.xaml")}`);
  if (uriEndsWith("app.xaml") !== 1) fail(`expected 1 App.xaml declaration, got ${uriEndsWith("app.xaml")}`);
  if (uriEndsWith("dipage.xaml") !== 1) fail(`expected 1 DiPage usage, got ${uriEndsWith("dipage.xaml")}`);
  console.log(`[ok] references(cross-file SmokeAccentBrush, includeDecl): 5 across SmokePage(3)+App.xaml(1 decl)+DiPage(1), no obj`);

  // includeDeclaration=false drops the App.xaml x:Key DECLARATION cross-file -> 4 usages (3 SmokePage + 1 DiPage).
  send({ id: 525, method: "textDocument/references", params: { textDocument: { uri: xamlUri }, position: resCaret, context: { includeDeclaration: false } } });
  const xref2 = await waitFor(responseFor(525), 30000, "xref-no-decl");
  if (xref2.error) fail(`cross-file references(no decl) errored: ${JSON.stringify(xref2.error)}`);
  const xref2Locs = Array.isArray(xref2.result) ? xref2.result : [];
  if (xref2Locs.length !== 4) {
    fail(`cross-file references(no decl): expected 4 usages (App.xaml decl excluded), got ${xref2Locs.length}: ${JSON.stringify(xref2Locs.map((l) => l.uri))}`);
  }
  if (xref2Locs.some((l) => l.uri.toLowerCase().endsWith("app.xaml"))) {
    fail(`includeDeclaration=false must exclude the App.xaml declaration, got ${JSON.stringify(xref2Locs.map((l) => l.uri))}`);
  }
  console.log(`[ok] references(cross-file, includeDecl=false): 4 usages, App.xaml declaration excluded`);

  // 28) Document Highlights (textDocument/documentHighlight): the same occurrences as references, rendered
  //     as editor highlights. Declaration is a Write highlight (kind 3); usages are Read highlights (kind 2).
  // 28a) x:Name: caret on a usage highlights declaration (Write) + both usages (Read) = 3, all "GoButton".
  const nameHl = await highlightWith(335, nameBase.replace("ElementName=GoButton}", "ElementName=GoBut|ton}"), "name-highlight");
  if (nameHl.highlights.length !== 3) fail(`highlight(x:Name): expected 3 (decl + 2 usages), got ${nameHl.highlights.length}: ${JSON.stringify(nameHl.texts)}`);
  if (!nameHl.texts.every((t) => t === "GoButton")) fail(`highlight(x:Name) should all read 'GoButton', got ${JSON.stringify(nameHl.texts)}`);
  if (nameHl.kinds.filter((k) => k === 3).length !== 1) fail(`highlight(x:Name): expected exactly 1 Write (declaration) kind, got kinds ${JSON.stringify(nameHl.kinds)}`);
  if (nameHl.kinds.filter((k) => k === 2).length !== 2) fail(`highlight(x:Name): expected 2 Read (usage) kinds, got kinds ${JSON.stringify(nameHl.kinds)}`);
  console.log(`[ok] highlight(x:Name usage caret): 3 highlights (1 Write decl + 2 Read usages), all 'GoButton'`);

  // 28b) resource key: caret on the x:Key declaration highlights decl (Write) + both usages (Read) = 3.
  const keyHl = await highlightWith(336, resBase.replace('x:Key="Brush1"', 'x:Key="Bru|sh1"'), "key-highlight");
  if (keyHl.highlights.length !== 3) fail(`highlight(x:Key): expected 3 (decl + 2 usages), got ${keyHl.highlights.length}: ${JSON.stringify(keyHl.texts)}`);
  if (!keyHl.texts.every((t) => t === "Brush1")) fail(`highlight(x:Key) should all read 'Brush1', got ${JSON.stringify(keyHl.texts)}`);
  if (keyHl.kinds.filter((k) => k === 3).length !== 1) fail(`highlight(x:Key): expected exactly 1 Write (declaration) kind, got kinds ${JSON.stringify(keyHl.kinds)}`);
  console.log(`[ok] highlight(x:Key decl caret): 3 highlights (1 Write decl + 2 Read usages), all 'Brush1'`);

  // 28c) caret NOT on a symbol -> no highlights.
  const noHl = await highlightWith(337, nameBase.replace("<StackPanel>", "<StackPa|nel>"), "no-highlight");
  if (noHl.highlights.length !== 0) fail(`highlight(non-symbol caret): expected 0, got ${noHl.highlights.length}: ${JSON.stringify(noHl.texts)}`);
  console.log(`[ok] highlight(non-symbol caret): 0 highlights`);

  // 14b) formatting — reindent nesting, preserve significant whitespace, idempotence
  const fmtMessy = "<Page>\n<Grid>\n<Button />\n</Grid>\n</Page>";
  const fmtExpected = "<Page>\n  <Grid>\n    <Button />\n  </Grid>\n</Page>";
  const fmtRes = await formatWith(338, fmtMessy, "reindent");
  if (fmtRes.formatted !== fmtExpected) fail(`formatting(reindent): got ${JSON.stringify(fmtRes.formatted)}`);
  console.log(`[ok] formatting(reindent): nested tags -> 2-space depth (${fmtRes.edits.length} edits)`);

  const fmtPreserve = '<Page>\n<TextBlock xml:space="preserve">\n      keep  this\n   text</TextBlock>\n</Page>';
  const preRes = await formatWith(339, fmtPreserve, "preserve");
  if (!preRes.formatted.includes("\n      keep  this\n   text</TextBlock>"))
    fail(`formatting(preserve): significant whitespace changed: ${JSON.stringify(preRes.formatted)}`);
  if (!preRes.formatted.includes('  <TextBlock xml:space="preserve">'))
    fail(`formatting(preserve): open tag not reindented: ${JSON.stringify(preRes.formatted)}`);
  console.log(`[ok] formatting(preserve): xml:space content byte-preserved, open tag reindented`);

  const cleanRes = await formatWith(340, fmtExpected, "idempotent");
  if (cleanRes.edits.length !== 0) fail(`formatting(idempotent): expected 0 edits, got ${cleanRes.edits.length}`);
  console.log(`[ok] formatting(idempotent): already-formatted -> 0 edits`);

  // 14c) folding — multi-line elements + a #region/#endregion pair
  const foldBody = "<Grid>\n  <StackPanel>\n    <Button />\n  </StackPanel>\n</Grid>";
  const folds = await foldingWith(341, foldBody, "elements");
  const gridFold = folds.find((f) => f.startLine === 0);
  if (!gridFold || gridFold.endLine !== 4) fail(`folding(elements): expected <Grid> fold [0,4], got ${JSON.stringify(folds)}`);
  const spFold = folds.find((f) => f.startLine === 1);
  if (!spFold || spFold.endLine !== 3) fail(`folding(elements): expected <StackPanel> fold [1,3], got ${JSON.stringify(folds)}`);
  if (folds.some((f) => f.endLine <= f.startLine)) fail(`folding(elements): inverted/degenerate range: ${JSON.stringify(folds)}`);
  console.log(`[ok] folding(elements): nested element folds [0,4] + [1,3]`);

  const regionBody = "<Grid>\n  <!-- #region Buttons -->\n  <Button />\n  <!-- #endregion -->\n</Grid>";
  const regionFolds = await foldingWith(342, regionBody, "region");
  const region = regionFolds.find((f) => f.kind === "region");
  if (!region || region.startLine !== 1 || region.endLine !== 3)
    fail(`folding(region): expected region fold [1,3], got ${JSON.stringify(regionFolds)}`);
  console.log(`[ok] folding(region): #region/#endregion fold [1,3] kind=region`);

  // 15) document color — hex literals become swatches; non-color values do not
  const colorBody = `<Page ${NS}>\n  <Rectangle Fill="#FF3B82F6" />\n  <TextBlock Text="not a color" />\n  <Border Background="{StaticResource Brush1}" />\n</Page>`;
  const colors = await documentColorWith(343, colorBody, "hex");
  if (colors.length !== 1) fail(`documentColor: expected exactly 1 swatch, got ${colors.length}: ${JSON.stringify(colors)}`);
  const swatch = colors[0];
  if (swatch.range.start.line !== 1) fail(`documentColor: swatch on wrong line: ${JSON.stringify(swatch.range)}`);
  // #FF3B82F6 -> alpha FF, r 0x3B, g 0x82, b 0xF6
  const near = (a, b) => Math.abs(a - b) < 0.01;
  if (!near(swatch.color.alpha, 1.0) || !near(swatch.color.red, 0x3b / 255) ||
      !near(swatch.color.green, 0x82 / 255) || !near(swatch.color.blue, 0xf6 / 255))
    fail(`documentColor: wrong color channels: ${JSON.stringify(swatch.color)}`);
  console.log(`[ok] documentColor: exactly 1 swatch for #FF3B82F6 (text + {StaticResource} ignored)`);

  // 15b) color presentation — a picked opaque color round-trips and stays bounded to the literal's range
  const pres = await colorPresentationWith(
    344,
    { red: 0x3b / 255, green: 0x82 / 255, blue: 0xf6 / 255, alpha: 1.0 },
    swatch.range,
    "opaque",
  );
  if (!pres.some((p) => p.label === "#3B82F6")) fail(`colorPresentation: missing #3B82F6: ${JSON.stringify(pres)}`);
  if (!pres.some((p) => p.label === "#FF3B82F6")) fail(`colorPresentation: missing #FF3B82F6: ${JSON.stringify(pres)}`);
  for (const p of pres) {
    if (!p.textEdit) fail(`colorPresentation: presentation '${p.label}' has no textEdit`);
    if (p.textEdit.range.start.character !== swatch.range.start.character ||
        p.textEdit.range.end.character !== swatch.range.end.character)
      fail(`colorPresentation: edit range must equal the literal range: ${JSON.stringify(p.textEdit.range)}`);
  }
  console.log(`[ok] colorPresentation: opaque -> #3B82F6 + #FF3B82F6, edits bounded to the literal`);

  // 15c) color presentation — a translucent picked color offers #AARRGGBB first
  const presA = await colorPresentationWith(
    345,
    { red: 1.0, green: 0.0, blue: 0.0, alpha: 0x80 / 255 },
    swatch.range,
    "translucent",
  );
  if (presA[0].label !== "#80FF0000") fail(`colorPresentation(translucent): expected #80FF0000 first, got ${JSON.stringify(presA)}`);
  console.log(`[ok] colorPresentation: translucent -> #80FF0000 offered first`);

  // 16) selection range — expand/shrink selection walks the syntax tree, strictly nested
  const selBody = `<Page ${NS}>\n  <Grid Background="#FF0000" />\n</Page>`;
  const gridLine = selBody.split("\n")[1];
  const selCol = gridLine.indexOf("#FF0000") + 2; // caret inside the color literal
  const selRanges = await selectionRangeWith(346, selBody, [{ line: 1, character: selCol }], "color");
  if (selRanges.length !== 1) fail(`selectionRange: expected 1 result, got ${selRanges.length}`);
  // flatten the parent chain and assert strict containment + document-sized outermost
  const flat = [];
  for (let cur = selRanges[0]; cur; cur = cur.parent) flat.push(cur.range);
  if (flat.length < 3) fail(`selectionRange: expected several nested levels, got ${flat.length}: ${JSON.stringify(flat)}`);
  const inDoc = (r) => r.start.line === 1 && r.start.character <= selCol && r.end.character >= selCol;
  if (!inDoc(flat[0])) fail(`selectionRange: innermost must contain the caret: ${JSON.stringify(flat[0])}`);
  for (let i = 0; i + 1 < flat.length; i++) {
    const inner = flat[i];
    const outer = flat[i + 1];
    const contains =
      (outer.start.line < inner.start.line ||
        (outer.start.line === inner.start.line && outer.start.character <= inner.start.character)) &&
      (outer.end.line > inner.end.line ||
        (outer.end.line === inner.end.line && outer.end.character >= inner.end.character));
    if (!contains) fail(`selectionRange: level ${i + 1} must contain level ${i}: ${JSON.stringify({ inner, outer })}`);
  }
  const outermost = flat[flat.length - 1];
  if (outermost.start.line !== 0 || outermost.start.character !== 0)
    fail(`selectionRange: outermost must be the whole document, got ${JSON.stringify(outermost)}`);
  console.log(`[ok] selectionRange: ${flat.length} strictly-nested levels, outermost = whole document`);

  // 17) linked editing — the caret on an element's open tag name returns both the open and end tag
  // name ranges so VS Code renames the matching tag as the user types.
  const leBody = `<Page ${NS}>\n  <StackPanel>\n    <Button />\n  </StackPanel>\n</Page>`;
  const leOpenCol = leBody.split("\n")[1].indexOf("StackPanel") + 3; // caret inside the open <StackPanel>
  const leOpen = await linkedEditingWith(347, leBody, { line: 1, character: leOpenCol }, "open tag");
  if (!leOpen || !Array.isArray(leOpen.ranges) || leOpen.ranges.length !== 2)
    fail(`linkedEditingRange: expected 2 ranges on open tag, got ${JSON.stringify(leOpen)}`);
  const textAt = (r) => {
    const lines = leBody.split("\n");
    if (r.start.line !== r.end.line) return "<multi-line>";
    return lines[r.start.line].slice(r.start.character, r.end.character);
  };
  if (textAt(leOpen.ranges[0]) !== "StackPanel" || textAt(leOpen.ranges[1]) !== "StackPanel")
    fail(`linkedEditingRange: ranges must cover both StackPanel names, got ${JSON.stringify(leOpen.ranges.map(textAt))}`);
  // open range (line 1) precedes the end range (line 3)
  if (!(leOpen.ranges[0].start.line < leOpen.ranges[1].start.line))
    fail(`linkedEditingRange: open name must precede end name, got ${JSON.stringify(leOpen.ranges)}`);
  // a self-closing tag has nothing to link -> null
  const leSelf = await linkedEditingWith(348, leBody, { line: 2, character: leBody.split("\n")[2].indexOf("Button") + 2 }, "self-closing");
  if (leSelf !== null && !(leSelf && leSelf.ranges && leSelf.ranges.length === 0))
    fail(`linkedEditingRange: self-closing <Button /> must not link, got ${JSON.stringify(leSelf)}`);
  console.log(`[ok] linkedEditingRange: open tag -> both StackPanel names linked; self-closing -> none`);

  // 18) document links — ctrl+click a ResourceDictionary Source that exists on disk (the fixture's
  // App.xaml, next to SmokePage.xaml) yields a file link over exactly the path token; ms-appx:/// resolves
  // under the project root (same fixture dir); a missing target yields no link.
  const dlBody = `<ResourceDictionary Source="App.xaml" />`;
  const dlLinks = await documentLinkWith(349, dlBody, "existing Source");
  if (dlLinks.length !== 1) fail(`documentLink: expected 1 link for existing App.xaml, got ${JSON.stringify(dlLinks)}`);
  if (!dlLinks[0].target || !/\/App\.xaml$/i.test(decodeURIComponent(dlLinks[0].target)))
    fail(`documentLink: target must point at App.xaml, got ${JSON.stringify(dlLinks[0])}`);
  const dlRange = dlLinks[0].range;
  if (dlBody.slice(dlRange.start.character, dlRange.end.character) !== "App.xaml")
    fail(`documentLink: range must cover the path token "App.xaml", got ${JSON.stringify(dlRange)}`);
  const dlAppx = await documentLinkWith(350, `<ResourceDictionary Source="ms-appx:///App.xaml" />`, "ms-appx Source");
  if (dlAppx.length !== 1 || !/\/App\.xaml$/i.test(decodeURIComponent(dlAppx[0].target || "")))
    fail(`documentLink: ms-appx:///App.xaml must resolve under the project root, got ${JSON.stringify(dlAppx)}`);
  const dlMissing = await documentLinkWith(351, `<ResourceDictionary Source="DoesNotExist.xaml" />`, "missing Source");
  if (dlMissing.length !== 0) fail(`documentLink: a missing target must not link, got ${JSON.stringify(dlMissing)}`);
  console.log(`[ok] documentLink: existing/ms-appx ResourceDictionary Source -> file link; missing -> none`);

  // 18b) asset document links — Image/BitmapImage sources resolve app-root-relative (ms-appx:/// semantics)
  // to real files under the fixture's Assets folder, over exactly the path token.
  const dlImgBody = `<Image Source="Assets/StoreLogo.png" />`;
  const dlImg = await documentLinkWith(352, dlImgBody, "Image asset Source");
  if (dlImg.length !== 1 || !/\/Assets\/StoreLogo\.png$/i.test(decodeURIComponent(dlImg[0].target || "")))
    fail(`documentLink: Image Source="Assets/StoreLogo.png" must link the real asset, got ${JSON.stringify(dlImg)}`);
  if (dlImgBody.slice(dlImg[0].range.start.character, dlImg[0].range.end.character) !== "Assets/StoreLogo.png")
    fail(`documentLink: range must cover the asset path token, got ${JSON.stringify(dlImg[0].range)}`);
  const dlBmp = await documentLinkWith(353, `<BitmapImage UriSource="ms-appx:///Assets/StoreLogo.png" />`, "BitmapImage UriSource");
  if (dlBmp.length !== 1 || !/\/Assets\/StoreLogo\.png$/i.test(decodeURIComponent(dlBmp[0].target || "")))
    fail(`documentLink: BitmapImage UriSource ms-appx must resolve under the package root, got ${JSON.stringify(dlBmp)}`);
  console.log(`[ok] documentLink: Image/BitmapImage asset sources -> real Assets file link (app-root)`);

  // 19) rename (F2) — prepareRename validates the caret token (placeholder + tight range) and rename
  // rewrites the x:Name declaration plus every reference; an invalid identifier is rejected with an error,
  // and a caret on a non-symbol (the element name) is not renameable.
  const rnBody = `<Grid x:Name="Root"><TextBox Text="{Binding ElementName=Root}" /></Grid>`;
  const rnPos = { line: 0, character: 16 }; // inside the x:Name="Root" declaration
  const rnPrep = await prepareRenameWith(360, rnBody, rnPos, "x:Name decl");
  if (!rnPrep || rnPrep.placeholder !== "Root")
    fail(`prepareRename: expected placeholder "Root", got ${JSON.stringify(rnPrep)}`);
  if (rnBody.slice(rnPrep.range.start.character, rnPrep.range.end.character) !== "Root")
    fail(`prepareRename: range must cover "Root", got ${JSON.stringify(rnPrep.range)}`);
  const rnOk = await renameWith(361, rnBody, rnPos, "Panel", "x:Name -> Panel");
  if (rnOk.error) fail(`rename: unexpected error ${JSON.stringify(rnOk.error)}`);
  const rnChanges = rnOk.result && rnOk.result.changes ? Object.values(rnOk.result.changes) : [];
  const rnEdits = rnChanges.length === 1 ? rnChanges[0] : [];
  if (rnEdits.length !== 2)
    fail(`rename: expected 2 edits (decl + ElementName usage), got ${JSON.stringify(rnOk.result)}`);
  if (!rnEdits.every((e) => e.newText === "Panel"))
    fail(`rename: every edit must set newText "Panel", got ${JSON.stringify(rnEdits)}`);
  if (!rnEdits.every((e) => rnBody.slice(e.range.start.character, e.range.end.character) === "Root"))
    fail(`rename: every edit range must cover the old name "Root", got ${JSON.stringify(rnEdits)}`);
  const rnBad = await renameWith(362, rnBody, rnPos, "1Bad", "invalid identifier");
  if (!rnBad.error)
    fail(`rename: an invalid identifier must be rejected with an error, got ${JSON.stringify(rnBad.result)}`);
  const rnNon = await prepareRenameWith(363, rnBody, { line: 0, character: 2 }, "element name");
  if (rnNon !== null)
    fail(`prepareRename: a caret on the element name must not be renameable, got ${JSON.stringify(rnNon)}`);
  console.log(`[ok] rename: prepareRename validates x:Name; rename rewrites decl+usage; invalid name rejected; non-symbol -> null`);

  // 19b) ROUND 80: element-name reference nav + rename now recognize RelativePanel alignment attached
  //      properties (bare-name, like Storyboard.TargetName) AND VSM <Setter Target="Element.Property">
  //      (only the pre-dot element segment). Before this, renaming an x:Name silently left these dangling.
  // F12 on a RelativePanel.RightOf value navigates to the referenced x:Name declaration (line 1, not the usage).
  const rpBody =
    "<RelativePanel>\n" +
    '  <TextBox x:Name="Anchor" />\n' +
    '  <Button RelativePanel.RightOf="An|chor" />\n' +
    "</RelativePanel>";
  const rpDef = await definitionWith(526, rpBody, "RelativePanel.RightOf F12");
  if (!rpDef || rpDef.range.start.line !== 1)
    fail(`definition(RelativePanel.RightOf): expected the x:Name decl on line 1, got ${JSON.stringify(rpDef)}`);
  console.log(`[ok] definition(RelativePanel.RightOf): navigates to the x:Name="Anchor" declaration`);

  // References on the x:Name decl include BOTH RelativePanel alignment usages (RightOf + AlignTopWith).
  const rpRefBody =
    "<RelativePanel>\n" +
    '  <TextBox x:Name="An|chor" />\n' +
    '  <Button RelativePanel.RightOf="Anchor" RelativePanel.AlignTopWith="Anchor" />\n' +
    "</RelativePanel>";
  const rpRefs = await referencesWith(527, rpRefBody, "RelativePanel refs", true);
  if (rpRefs.locations.length !== 3)
    fail(`references(RelativePanel x:Name): expected 3 (decl + RightOf + AlignTopWith), got ${rpRefs.locations.length}: ${JSON.stringify(rpRefs.texts)}`);
  if (!rpRefs.texts.every((t) => t === "Anchor"))
    fail(`references(RelativePanel) should all read 'Anchor', got ${JSON.stringify(rpRefs.texts)}`);
  console.log(`[ok] references(RelativePanel x:Name): 3 (decl + RightOf + AlignTopWith), all 'Anchor'`);

  // F12 on the ELEMENT segment of a VSM Setter.Target navigates to the x:Name declaration (line 1).
  const stgBody =
    "<Page>\n" +
    '  <Border x:Name="Hero" />\n' +
    '  <Setter Target="He|ro.Background" Value="Red" />\n' +
    "</Page>";
  const stgDef = await definitionWith(528, stgBody, "Setter.Target F12");
  if (!stgDef || stgDef.range.start.line !== 1)
    fail(`definition(Setter.Target element): expected the x:Name decl on line 1, got ${JSON.stringify(stgDef)}`);
  console.log(`[ok] definition(Setter.Target element segment): navigates to the x:Name="Hero" declaration`);

  // THE RAZOR: renaming the x:Name rewrites the Setter.Target ELEMENT segment only — every edit covers exactly
  // "Hero", never "Hero.Background", so the ".Background" property tail is preserved.
  const stgRnBody =
    "<Page>\n" +
    '  <Border x:Name="Hero" />\n' +
    '  <Setter Target="Hero.Background" Value="Red" />\n' +
    "</Page>";
  const stgRn = await renameWith(529, stgRnBody, { line: 1, character: 19 }, "Banner", "Setter.Target rename");
  if (stgRn.error) fail(`rename(Setter.Target): unexpected error ${JSON.stringify(stgRn.error)}`);
  const stgChanges = stgRn.result && stgRn.result.changes ? Object.values(stgRn.result.changes) : [];
  const stgEdits = stgChanges.length === 1 ? stgChanges[0] : [];
  if (stgEdits.length !== 2)
    fail(`rename(Setter.Target): expected 2 edits (decl + Target element), got ${JSON.stringify(stgRn.result)}`);
  if (!stgEdits.every((e) => e.newText === "Banner"))
    fail(`rename(Setter.Target): every edit must set newText "Banner", got ${JSON.stringify(stgEdits)}`);
  const stgLines = stgRnBody.split("\n");
  if (!stgEdits.every((e) => stgLines[e.range.start.line].slice(e.range.start.character, e.range.end.character) === "Hero"))
    fail(`rename(Setter.Target): every edit must cover exactly "Hero" (not "Hero.Background"), got ${JSON.stringify(stgEdits)}`);
  console.log(`[ok] rename(Setter.Target): 2 edits, both cover exactly "Hero" — ".Background" preserved`);

  // NEGATIVE: a caret on the ".Property" tail is NOT a name reference (it's a member on Hero) -> not renameable.
  const stgProp = await prepareRenameWith(530, stgRnBody, { line: 2, character: 27 }, "Setter.Target .Property");
  if (stgProp !== null)
    fail(`prepareRename(Setter.Target .Property): the property tail must not be renameable, got ${JSON.stringify(stgProp)}`);
  console.log(`[ok] prepareRename(Setter.Target .Property tail): null — the member is not an element-name reference`);

  // 19c) ROUND 81: F12 + hover on the MEMBER segment of a VSM <Setter Target="Element.Property"> value, and a
  //      bare Storyboard.TargetProperty="Property" value -> the property on the target element's type,
  //      symmetric with <Setter Property="...">. Round 80 shipped the pre-dot ELEMENT reference nav/rename;
  //      round 81 resolves the post-dot MEMBER. Framework members resolve for HOVER but have no source
  //      location, so F12 returns null there (the documented metadata boundary) — and a member caret must NOT
  //      fall through to the round-80 element F12 (which would wrongly navigate to the x:Name declaration).
  const vsmSetterTarget = (target) =>
    pageCls(`<Border x:Name="Chrome" />\n  <Setter Target="${target}" Value="0.5" />`);

  // Hover on the Setter.Target member resolves the property on the named element's type (Border -> UIElement.Opacity).
  const stmHover = await hoverAt(531, vsmSetterTarget("Chrome.Opac|ity"), "Setter.Target member hover");
  if (!/Opacity/.test(stmHover) || !/(UIElement|double|Double)/.test(stmHover))
    fail(`hover(Setter.Target member): expected Border's Opacity property, got ${JSON.stringify(stmHover)}`);
  console.log(`[ok] hover(Setter.Target member 'Chrome.Opacity'): resolves the Opacity property on the target element's type`);

  // F12 on the member (framework property) returns null gracefully — and crucially does NOT navigate to the
  // x:Name declaration (that is the round-80 pre-dot ELEMENT behavior; the member caret must fall through it).
  const stmMemberDef = await definitionWith(532, vsmSetterTarget("Chrome.Opac|ity"), "Setter.Target member F12");
  if (stmMemberDef !== null)
    fail(`definition(Setter.Target member): a framework member has no source + must not hit the x:Name decl, got ${JSON.stringify(stmMemberDef)}`);
  // The ELEMENT segment still navigates to the decl (round-80 caret-precision razor re-confirmed with a member tail).
  const stmElemDef = await definitionWith(533, vsmSetterTarget("Chr|ome.Opacity"), "Setter.Target element F12");
  if (!stmElemDef || stmElemDef.range.start.line !== 1)
    fail(`definition(Setter.Target element w/ member tail): expected the x:Name decl on line 1, got ${JSON.stringify(stmElemDef)}`);
  console.log(`[ok] definition(Setter.Target): member caret -> null (framework, graceful; not the decl); element caret -> x:Name decl (round-80 intact)`);

  // Hover on a bare Storyboard.TargetProperty member resolves against the sibling Storyboard.TargetName element.
  const sbtpBody = pageCls(
    `<StackPanel>\n` +
    `    <Border x:Name="Chrome" />\n` +
    `    <Storyboard>\n` +
    `      <DoubleAnimation Storyboard.TargetName="Chrome" Storyboard.TargetProperty="Opac|ity" />\n` +
    `    </Storyboard>\n` +
    `  </StackPanel>`);
  const sbtpHover = await hoverAt(534, sbtpBody, "Storyboard.TargetProperty member hover");
  if (!/Opacity/.test(sbtpHover) || !/(UIElement|double|Double)/.test(sbtpHover))
    fail(`hover(Storyboard.TargetProperty member): expected the sibling TargetName element's Opacity, got ${JSON.stringify(sbtpHover)}`);
  console.log(`[ok] hover(Storyboard.TargetProperty 'Opacity'): resolves against the sibling Storyboard.TargetName element`);

  // Round-81 follow-up fix: with NO sibling Storyboard.TargetName the value has no target, so a bare member
  // must NOT leak to the generic page-class member fallback (which would else mis-hover "Opacity" as the
  // page's own UIElement.Opacity). Same buffer minus the TargetName -> silent.
  const sbtpNoTargetBody = pageCls(
    `<StackPanel>\n` +
    `    <Storyboard>\n` +
    `      <DoubleAnimation Storyboard.TargetProperty="Opac|ity" />\n` +
    `    </Storyboard>\n` +
    `  </StackPanel>`);
  const sbtpNoTargetHover = await hoverAt(535, sbtpNoTargetBody, "Storyboard.TargetProperty no-target hover");
  if (sbtpNoTargetHover !== "")
    fail(`hover(Storyboard.TargetProperty no target): expected no hover (no target element), got ${JSON.stringify(sbtpNoTargetHover)}`);
  console.log(`[ok] hover(Storyboard.TargetProperty 'Opacity' w/o TargetName): silent — no page-member leak`);

  // 19d) ROUND 82: F12 + hover on the PROPERTY argument of a {TemplateBinding Property} inside a ControlTemplate
  //      -> the property on the template's TargetType (the templated parent). Symmetric with the round-4
  //      TemplateBinding COMPLETION, which already offers those same properties (both reuse ResolveStyleTargetType).
  //      Framework members resolve for HOVER but have no source location, so F12 returns null (the documented
  //      metadata boundary). The extension NAME hover ("TemplateBinding" macro description) must be UNCHANGED —
  //      it is handled earlier by ResolveValueHoverAsync and only fires when the caret is on the name.
  const tbTemplate = (inner) => pageCls(
    `<Page.Resources>\n` +
    `    <Style TargetType="Button">\n` +
    `      <Setter Property="Template">\n` +
    `        <Setter.Value>\n` +
    `          <ControlTemplate TargetType="Button">\n` +
    `            ${inner}\n` +
    `          </ControlTemplate>\n` +
    `        </Setter.Value>\n` +
    `      </Setter>\n` +
    `    </Style>\n` +
    `  </Page.Resources>`);

  // Hover on the TemplateBinding property resolves the member on the template's TargetType (Button -> Control.Background).
  const tbHover = await hoverAt(536, tbTemplate('<Border Background="{TemplateBinding Back|ground}" />'), "TemplateBinding member hover");
  if (!/Background/.test(tbHover) || !/(Control|Brush)/.test(tbHover))
    fail(`hover(TemplateBinding member): expected the Button's Background property, got ${JSON.stringify(tbHover)}`);
  console.log(`[ok] hover(TemplateBinding 'Background'): resolves the property on the template's TargetType`);

  // F12 on the member (a framework property) returns null gracefully — no source location.
  const tbDef = await definitionWith(537, tbTemplate('<Border Background="{TemplateBinding Back|ground}" />'), "TemplateBinding member F12");
  if (tbDef !== null)
    fail(`definition(TemplateBinding member): a framework member has no source, expected null, got ${JSON.stringify(tbDef)}`);
  console.log(`[ok] definition(TemplateBinding 'Background'): null (framework member, graceful metadata boundary)`);

  // Caret on the extension NAME still shows the macro description, NOT a member (ResolveValueHoverAsync wins there).
  const tbNameHover = await hoverAt(538, tbTemplate('<Border Background="{Templ|ateBinding Background}" />'), "TemplateBinding name hover");
  if (!/TemplateBinding/.test(tbNameHover) || !/templated (control|parent)/i.test(tbNameHover))
    fail(`hover(TemplateBinding name): expected the macro description (unchanged), got ${JSON.stringify(tbNameHover)}`);
  console.log(`[ok] hover(TemplateBinding name): macro description preserved (no member conflict)`);

  // A property that is NOT on the TargetType -> silent (FindMember null, no leak to a page/other member).
  const tbBogus = await hoverAt(539, tbTemplate('<Border Background="{TemplateBinding Zork|le}" />'), "TemplateBinding bogus member");
  if (tbBogus !== "")
    fail(`hover(TemplateBinding bogus member): expected no hover, got ${JSON.stringify(tbBogus)}`);
  console.log(`[ok] hover(TemplateBinding 'Zorkle'): silent — unknown member on the TargetType`);

  // Caret precision: genuine interior whitespace (a caret BEFORE the member start, not at its edge) resolves
  // nothing — the value span excludes leading/trailing whitespace, so the hit-test is exact, not greedy. This
  // is the round-82 precision invariant most likely to silently regress if the hit-test is ever widened.
  const tbSpace = await hoverAt(540, tbTemplate('<Border Background="{TemplateBinding | Background}" />'), "TemplateBinding whitespace caret");
  if (tbSpace !== "")
    fail(`hover(TemplateBinding whitespace): a caret in interior whitespace must not resolve, got ${JSON.stringify(tbSpace)}`);
  console.log(`[ok] hover(TemplateBinding interior whitespace): silent — value span excludes whitespace (exact hit-test)`);

  // 19e) ROUND 83: F12 + hover on the MEMBER (or owner type) of a parenthesized (Owner.Property) qualifier
  //      inside Storyboard.TargetProperty — the read-side counterpart of the round-77 qualified-group COMPLETION
  //      (both resolve the EXPLICITLY named owner type, independently of Storyboard.TargetName). A member caret
  //      resolves an INSTANCE property or an ATTACHED property of the owner; an owner caret resolves the owner
  //      TYPE. Framework members/types have no source, so F12 returns null (the documented metadata boundary).
  //      Reuses the round-77 sb(tp) fixture helper (Border "AttachedProbe" + DoubleAnimation).
  //
  // (i) instance-member caret -> the property on the explicit owner type (UIElement.Opacity, double).
  const q1 = await hoverAt(541, sb("(UIElement.Opac|ity)"), "sb-nav-instance-member");
  if (!/Opacity/.test(q1) || !/UIElement/.test(q1))
    fail(`hover((UIElement.Opacity) member): expected UIElement.Opacity, got ${JSON.stringify(q1)}`);
  console.log(`[ok] hover(Storyboard.TargetProperty '(UIElement.Opacity)'): instance member on the explicit owner`);

  // (ii) attached-member caret -> the "(attached property) T Owner.Member" framing (Canvas.Left, double).
  const q2 = await hoverAt(542, sb("(Canvas.Le|ft)"), "sb-nav-attached-member");
  if (!/attached property/.test(q2) || !/Canvas\.Left/.test(q2))
    fail(`hover((Canvas.Left) member): expected the attached-property framing, got ${JSON.stringify(q2)}`);
  console.log(`[ok] hover(Storyboard.TargetProperty '(Canvas.Left)'): attached-property framing`);

  // (iii) owner-segment caret -> the owner TYPE (like {x:Type}), NOT the member.
  const q3 = await hoverAt(543, sb("(UIEle|ment.Opacity)"), "sb-nav-owner-type");
  if (!/class/.test(q3) || !/UIElement/.test(q3))
    fail(`hover((UIElement.Opacity) owner): expected the UIElement type, got ${JSON.stringify(q3)}`);
  if (/attached property/.test(q3) || /\bOpacity\b/.test(q3))
    fail(`hover((UIElement.Opacity) owner): must resolve the TYPE, not the member, got ${JSON.stringify(q3)}`);
  console.log(`[ok] hover(Storyboard.TargetProperty '(UIElement.Opacity)' owner caret): the owner type`);

  // (iv) chained group: the SECOND group's member resolves against ITS explicit owner (CompositeTransform.TranslateX).
  const q4 = await hoverAt(544, sb("(UIElement.RenderTransform).(CompositeTransform.Trans|lateX)"), "sb-nav-chained-member");
  if (!/TranslateX/.test(q4) || !/CompositeTransform/.test(q4))
    fail(`hover(chained (…).(CompositeTransform.TranslateX)): expected CompositeTransform.TranslateX, got ${JSON.stringify(q4)}`);
  console.log(`[ok] hover(Storyboard.TargetProperty chained '(CompositeTransform.TranslateX)'): member on the second group's owner`);

  // (v) F12 on a framework member -> null (no source location — the documented metadata boundary).
  const q5 = await definitionWith(545, sb("(UIElement.Opac|ity)"), "sb-nav-f12-framework");
  if (q5 !== null)
    fail(`definition((UIElement.Opacity) framework member): expected null, got ${JSON.stringify(q5)}`);
  console.log(`[ok] definition(Storyboard.TargetProperty '(UIElement.Opacity)'): null (framework member, graceful)`);

  // (vi) an unresolvable owner in the group -> silent (never leaks a page/element member).
  const q6 = await hoverAt(546, sb("(NoSuchOwner.Fo|o)"), "sb-nav-unknown-owner");
  if (q6 !== "")
    fail(`hover((NoSuchOwner.Foo)): an unresolvable owner must be silent, got ${JSON.stringify(q6)}`);
  console.log(`[ok] hover(Storyboard.TargetProperty '(NoSuchOwner.Foo)'): silent — owner does not resolve`);


  // 20) semantic tokens — purely syntactic classification of NAMES by structural role (element type=class,
  // attribute/member/attached=property, name prefix=namespace, markup-extension name=macro, named-arg=parameter).
  // Values (the x:Name "Root", the resource key "Accent") and xmlns declarations are intentionally NOT tokenized.
  // This buffer declares NO xmlns, so no prefix resolves and the defaultLibrary modifier never fires (a valid
  // negative — the framework-vs-user marking is proven with a real header in case 426).
  const stLegend = ["namespace", "class", "property", "macro", "parameter"];
  const stBody = `<Grid x:Name="Root" Background="{StaticResource Accent}"><local:Foo Grid.Row="1" /></Grid>`;
  const stData = await semanticTokensWith(370, stBody, "mixed");
  const stToks = decodeSemanticTokens(stData, stBody.split("\n"), stLegend);
  for (const t of stToks) {
    if (t.modifiers !== 0) fail(`semanticTokens: no xmlns in scope, so no defaultLibrary modifier expected, got ${t.modifiers} on '${t.covered}'`);
  }
  const stHas = (covered, type) => stToks.some((t) => t.covered === covered && t.type === type);
  for (const [cov, ty] of [
    ["Grid", "class"], ["x", "namespace"], ["Name", "property"], ["Background", "property"],
    ["StaticResource", "macro"], ["local", "namespace"], ["Foo", "class"], ["Grid.Row", "property"],
  ]) {
    if (!stHas(cov, ty)) fail(`semanticTokens: expected a '${ty}' token covering '${cov}', got ${JSON.stringify(stToks)}`);
  }
  if (stToks.some((t) => t.covered === "Root")) fail(`semanticTokens: must not tokenize the x:Name value "Root", got ${JSON.stringify(stToks)}`);
  if (stToks.filter((t) => t.covered === "Grid" && t.type === "class").length !== 2)
    fail(`semanticTokens: expected 2 class tokens over Grid (open + end tag), got ${JSON.stringify(stToks)}`);
  console.log(`[ok] semantic tokens: element=class, prefix=namespace, member/attached=property, markup-ext=macro; values + xmlns skipped (${stData.length / 5} tokens)`);

  // 426) semantic-token defaultLibrary modifier — a name bound (via the document's OWN xmlns) to a framework
  // namespace (WinUI presentation or the XAML language ns) carries the modifier; a user-namespace name does not.
  const stModHeader = NS + ' xmlns:local="using:SmokeFixture"';
  const stModBody = `<Page ${stModHeader}><Grid x:Name="Root"><local:Foo Background="{StaticResource Accent}" /></Grid></Page>`;
  const stModData = await semanticTokensWith(426, stModBody, "modifiers");
  const stModToks = decodeSemanticTokens(stModData, stModBody.split("\n"), stLegend);
  const DEFAULT_LIBRARY = 1 << 0;
  const isFw = (covered, type) =>
    stModToks.some((t) => t.covered === covered && t.type === type && (t.modifiers & DEFAULT_LIBRARY) !== 0);
  const notFw = (covered) =>
    stModToks.filter((t) => t.covered === covered).every((t) => (t.modifiers & DEFAULT_LIBRARY) === 0);
  // Framework: default-ns element, Page, the x: directive prefix + local name, the unprefixed markup extension.
  for (const [cov, ty] of [["Page", "class"], ["Grid", "class"], ["x", "namespace"], ["Name", "property"], ["StaticResource", "macro"]]) {
    if (!isFw(cov, ty)) fail(`semanticTokens/modifiers: expected defaultLibrary on '${cov}' (${ty}), got ${JSON.stringify(stModToks)}`);
  }
  // User: the local: prefix + its element name; an UNPREFIXED member is never marked (its ns is its owner type).
  for (const cov of ["local", "Foo", "Background"]) {
    if (!notFw(cov)) fail(`semanticTokens/modifiers: '${cov}' must NOT carry defaultLibrary, got ${JSON.stringify(stModToks)}`);
  }
  console.log(`[ok] semantic tokens: defaultLibrary marks framework names (Grid/Page/x:Name/{StaticResource}) not user names (local:Foo, unprefixed member)`);

  // 427) semanticTokens/range — the same encoding limited to tokens overlapping the requested range. A request
  // for one line returns exactly that line's tokens; tokens on other lines are excluded.
  const stRangeBody = `<Grid>\n  <Button />\n  <TextBox />\n</Grid>`;
  const stRangeLines = stRangeBody.split("\n");
  const stFull = decodeSemanticTokens(await semanticTokensWith(427, stRangeBody, "range-full"), stRangeLines, stLegend);
  const stRange = decodeSemanticTokens(
    await semanticTokensRangeWith(428, stRangeBody, { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } }, "range-line1"),
    stRangeLines,
    stLegend
  );
  if (!stRange.some((t) => t.covered === "Button" && t.type === "class"))
    fail(`semanticTokens/range: expected the in-range Button token, got ${JSON.stringify(stRange)}`);
  if (stRange.some((t) => t.covered === "TextBox"))
    fail(`semanticTokens/range: TextBox is on line 2, out of the requested range, got ${JSON.stringify(stRange)}`);
  if (stRange.some((t) => t.covered === "Grid"))
    fail(`semanticTokens/range: Grid open/end tags are outside the requested range, got ${JSON.stringify(stRange)}`);
  // The ranged tokens must be exactly the full tokens on line 1 (identical absolute decoding, just a subset).
  const stFullLine1 = stFull.filter((t) => t.line === 1);
  if (JSON.stringify(stRange) !== JSON.stringify(stFullLine1))
    fail(`semanticTokens/range: expected the line-1 subset ${JSON.stringify(stFullLine1)}, got ${JSON.stringify(stRange)}`);
  console.log(`[ok] semantic tokens/range: line-1 request returns exactly Button (Grid + TextBox excluded), matching the full-set subset`);

  // 21) code actions ("Did you mean …?" quick fixes). The unknown-name diagnostics carry ranked spelling
  //     suggestions in Diagnostic.data (computed against the REAL SDK type list at diagnostic time); a
  //     textDocument/codeAction request turns each into a "Change 'X' to 'Y'" edit that replaces EXACTLY
  //     the flagged span with a known-valid name. Proves the full validator -> data -> code-action loop.
  const caDirty = xamlText.replace("<Button", "<Buton");
  if (caDirty === xamlText) fail("could not inject a misspelled element for the code-action case");
  const caDiags = await validateDoc(
    caDirty,
    (d) => d.some((x) => x.code === "WXAML0002" && x.message.includes("Buton")),
    "code-action unknown-type"
  );
  const caDiag = caDiags.find((x) => x.code === "WXAML0002" && x.message.includes("Buton"));
  if (!caDiag) fail(`code actions: expected a WXAML0002 for 'Buton' (got ${JSON.stringify(caDiags.map((x) => x.code))})`);
  // The validator must have attached ranked suggestions from the real SDK's type list.
  if (!caDiag.data || !Array.isArray(caDiag.data.suggestions) || !caDiag.data.suggestions.includes("Button")) {
    fail(`code actions: WXAML0002 for 'Buton' should carry a 'Button' suggestion in data (got ${JSON.stringify(caDiag.data)})`);
  }
  const caActions = await codeActionWith(380, caDiag, "buton-fix");
  const buttonFix = caActions.find((a) => a.title === "Change 'Buton' to 'Button'");
  if (!buttonFix) fail(`code actions: expected a "Change 'Buton' to 'Button'" quick fix (got ${JSON.stringify(caActions.map((a) => a.title))})`);
  if (buttonFix.kind !== "quickfix") fail(`code actions: fix kind should be 'quickfix', got ${buttonFix.kind}`);
  if (buttonFix.isPreferred !== true) fail(`code actions: the top suggestion should be isPreferred`);
  const caEdit = buttonFix.edit && buttonFix.edit.changes && buttonFix.edit.changes[xamlUri] && buttonFix.edit.changes[xamlUri][0];
  if (!caEdit || caEdit.newText !== "Button") fail(`code actions: fix must replace with 'Button' (got ${JSON.stringify(caEdit)})`);
  // The edit must cover EXACTLY the diagnostic's flagged span — never widen into markup.
  if (JSON.stringify(caEdit.range) !== JSON.stringify(caDiag.range)) {
    fail(`code actions: edit range ${JSON.stringify(caEdit.range)} must equal the diagnostic range ${JSON.stringify(caDiag.range)}`);
  }
  console.log(`[ok] code actions: <Buton> -> "Change 'Buton' to 'Button'" quickfix replacing exactly the flagged span (${caActions.length} action(s))`);

  // 21b) code action for a misspelled property element whose intended target is a GET-ONLY collection
  //      property (Grid.RowDefinitions has no setter). Regression guard: the suggestion candidate source
  //      must mirror property-element VALIDITY (HasProperty, get-only included), not the setter-only
  //      GetMembers — otherwise a real fix like RowDefinitionz -> RowDefinitions would be silently missing.
  const caPe = `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Grid>\n    <Grid.RowDefinitionz><RowDefinition /></Grid.RowDefinitionz>\n  </Grid>\n</Page>`;
  const caPeDiags = await validateDoc(
    caPe,
    (d) => d.some((x) => x.code === "WXAML0006" && x.message.includes("RowDefinitionz")),
    "code-action property-element member"
  );
  const caPeDiag = caPeDiags.find((x) => x.code === "WXAML0006" && x.message.includes("RowDefinitionz"));
  if (!caPeDiag) fail(`code actions: expected a WXAML0006 for 'RowDefinitionz' (got ${JSON.stringify(caPeDiags.map((x) => `${x.code}:${x.message}`))})`);
  if (!caPeDiag.data || !Array.isArray(caPeDiag.data.suggestions) || !caPeDiag.data.suggestions.includes("RowDefinitions")) {
    fail(`code actions: WXAML0006 for 'RowDefinitionz' should suggest the get-only 'RowDefinitions' (got ${JSON.stringify(caPeDiag.data)})`);
  }
  const caPeActions = await codeActionWith(382, caPeDiag, "rowdefz-fix");
  const caPeFix = caPeActions.find((a) => a.title === "Change 'RowDefinitionz' to 'RowDefinitions'");
  if (!caPeFix) fail(`code actions: expected a "Change 'RowDefinitionz' to 'RowDefinitions'" quick fix (got ${JSON.stringify(caPeActions.map((a) => a.title))})`);
  const caPeEdit = caPeFix.edit && caPeFix.edit.changes && caPeFix.edit.changes[xamlUri] && caPeFix.edit.changes[xamlUri][0];
  if (!caPeEdit || caPeEdit.newText !== "RowDefinitions") fail(`code actions: property-element fix must replace with 'RowDefinitions' (got ${JSON.stringify(caPeEdit)})`);
  if (JSON.stringify(caPeEdit.range) !== JSON.stringify(caPeDiag.range)) {
    fail(`code actions: property-element edit range ${JSON.stringify(caPeEdit.range)} must equal the diagnostic range ${JSON.stringify(caPeDiag.range)}`);
  }
  console.log(`[ok] code actions: <Grid.RowDefinitionz> -> "Change … to 'RowDefinitions'" (get-only collection property offered as a fix)`);

  // 21c) code action for a misspelled x:Bind PATH member (WXAML0005). VS offers a spelling fix for a
  //      mistyped bind member the same as any other unknown name. Two shapes exercised: a single-segment
  //      path (the diagnostic span IS the token) and a dotted path whose FIRST segment is wrong (the
  //      diagnostic underlines the WHOLE value, so the fix must narrow to just the bad segment and keep the
  //      trailing ".Length").
  const caBind = `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <TextBlock Text="{x:Bind GreetingTexx}" />\n</Page>`;
  const caBindDiags = await validateDoc(
    caBind,
    (d) => d.some((x) => x.code === "WXAML0005" && x.message.includes("GreetingTexx")),
    "code-action x:Bind member"
  );
  const caBindDiag = caBindDiags.find((x) => x.code === "WXAML0005" && x.message.includes("GreetingTexx"));
  if (!caBindDiag) fail(`code actions: expected a WXAML0005 for 'GreetingTexx' (got ${JSON.stringify(caBindDiags.map((x) => `${x.code}:${x.message}`))})`);
  if (!caBindDiag.data || !Array.isArray(caBindDiag.data.suggestions) || !caBindDiag.data.suggestions.includes("GreetingText")) {
    fail(`code actions: WXAML0005 for 'GreetingTexx' should suggest the bindable member 'GreetingText' (got ${JSON.stringify(caBindDiag.data)})`);
  }
  const caBindActions = await codeActionWith(384, caBindDiag, "bind-fix");
  const caBindFix = caBindActions.find((a) => a.title === "Change 'GreetingTexx' to 'GreetingText'");
  if (!caBindFix) fail(`code actions: expected a "Change 'GreetingTexx' to 'GreetingText'" quick fix (got ${JSON.stringify(caBindActions.map((a) => a.title))})`);
  const caBindEdit = caBindFix.edit && caBindFix.edit.changes && caBindFix.edit.changes[xamlUri] && caBindFix.edit.changes[xamlUri][0];
  if (!caBindEdit || caBindEdit.newText !== "GreetingText") fail(`code actions: x:Bind fix must replace with 'GreetingText' (got ${JSON.stringify(caBindEdit)})`);
  if (JSON.stringify(caBindEdit.range) !== JSON.stringify(caBindDiag.range)) {
    fail(`code actions: single-segment x:Bind edit range ${JSON.stringify(caBindEdit.range)} must equal the diagnostic range ${JSON.stringify(caBindDiag.range)}`);
  }
  console.log(`[ok] code actions: {x:Bind GreetingTexx} -> "Change … to 'GreetingText'" (bindable-member spelling fix)`);

  const caBind2 = `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <TextBlock Text="{x:Bind GreetingTexx.Length}" />\n</Page>`;
  const caBind2Diags = await validateDoc(
    caBind2,
    (d) => d.some((x) => x.code === "WXAML0005" && x.message.includes("GreetingTexx")),
    "code-action x:Bind dotted first segment"
  );
  const caBind2Diag = caBind2Diags.find((x) => x.code === "WXAML0005" && x.message.includes("GreetingTexx"));
  if (!caBind2Diag) fail(`code actions: expected a WXAML0005 for the dotted 'GreetingTexx.Length' (got ${JSON.stringify(caBind2Diags.map((x) => `${x.code}:${x.message}`))})`);
  const caBind2Actions = await codeActionWith(385, caBind2Diag, "bind-fix2");
  const caBind2Fix = caBind2Actions.find((a) => a.title === "Change 'GreetingTexx' to 'GreetingText'");
  if (!caBind2Fix) fail(`code actions: expected the dotted-path quick fix (got ${JSON.stringify(caBind2Actions.map((a) => a.title))})`);
  const caBind2Edit = caBind2Fix.edit && caBind2Fix.edit.changes && caBind2Fix.edit.changes[xamlUri] && caBind2Fix.edit.changes[xamlUri][0];
  if (!caBind2Edit || caBind2Edit.newText !== "GreetingText") fail(`code actions: dotted x:Bind fix must replace with 'GreetingText' (got ${JSON.stringify(caBind2Edit)})`);
  // The fix must NARROW to exactly "GreetingTexx" (12 chars) at the value start — NOT clobber the ".Length" tail.
  if (JSON.stringify(caBind2Edit.range.start) !== JSON.stringify(caBind2Diag.range.start)) {
    fail(`code actions: dotted x:Bind edit must start at the value start (got ${JSON.stringify(caBind2Edit.range.start)} vs diag ${JSON.stringify(caBind2Diag.range.start)})`);
  }
  if (caBind2Edit.range.end.character !== caBind2Diag.range.start.character + 12) {
    fail(`code actions: dotted x:Bind edit must cover exactly 'GreetingTexx' (12 chars), got end ${JSON.stringify(caBind2Edit.range.end)}`);
  }
  if (caBind2Edit.range.end.character >= caBind2Diag.range.end.character) {
    fail(`code actions: dotted x:Bind edit must be NARROWER than the whole-value diagnostic span so '.Length' survives (edit end ${caBind2Edit.range.end.character} >= diag end ${caBind2Diag.range.end.character})`);
  }
  console.log(`[ok] code actions: {x:Bind GreetingTexx.Length} -> fix narrows to 'GreetingTexx', preserving the '.Length' tail`);

  // 21d) code action for an undeclared WELL-KNOWN prefix (WXAML0001) -> "Add xmlns:d declaration". The
  //      fixture NS declares only the default + x namespaces, so a <d:Foo /> use leaves 'd' undeclared;
  //      the fix inserts the standard blend design-time namespace on the ROOT (grouped after the existing
  //      xmlns declarations) as a single zero-width edit, which makes the prefix resolvable.
  const caXmlns = `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Grid>\n    <d:Foo />\n  </Grid>\n</Page>`;
  const caXmlnsDiags = await validateDoc(
    caXmlns,
    (d) => d.some((x) => x.code === "WXAML0001" && x.message.includes("d")),
    "code-action undeclared prefix"
  );
  const caXmlnsDiag = caXmlnsDiags.find((x) => x.code === "WXAML0001");
  if (!caXmlnsDiag) fail(`code actions: expected a WXAML0001 for the undeclared 'd' prefix (got ${JSON.stringify(caXmlnsDiags.map((x) => x.code))})`);
  const caXmlnsActions = await codeActionWith(392, caXmlnsDiag, "add-xmlns-d");
  const caXmlnsFix = caXmlnsActions.find((a) => a.title === "Add xmlns:d declaration");
  if (!caXmlnsFix) fail(`code actions: expected an "Add xmlns:d declaration" quick fix (got ${JSON.stringify(caXmlnsActions.map((a) => a.title))})`);
  if (caXmlnsFix.kind !== "quickfix") fail(`code actions: xmlns fix kind should be 'quickfix', got ${caXmlnsFix.kind}`);
  if (caXmlnsFix.isPreferred !== true) fail(`code actions: the xmlns fix should be isPreferred`);
  const caXmlnsEdit = caXmlnsFix.edit && caXmlnsFix.edit.changes && caXmlnsFix.edit.changes[xamlUri] && caXmlnsFix.edit.changes[xamlUri][0];
  const expectedXmlns = ' xmlns:d="http://schemas.microsoft.com/expression/blend/2008"';
  if (!caXmlnsEdit || caXmlnsEdit.newText !== expectedXmlns) {
    fail(`code actions: xmlns fix must insert '${expectedXmlns}' (got ${JSON.stringify(caXmlnsEdit)})`);
  }
  // A pure insertion: zero-width range on the root's open-tag line.
  if (JSON.stringify(caXmlnsEdit.range.start) !== JSON.stringify(caXmlnsEdit.range.end)) {
    fail(`code actions: xmlns fix must be a zero-width insertion (got ${JSON.stringify(caXmlnsEdit.range)})`);
  }
  if (caXmlnsEdit.range.start.line !== 0) {
    fail(`code actions: xmlns fix must insert on the root open-tag line 0 (got line ${caXmlnsEdit.range.start.line})`);
  }
  console.log(`[ok] code actions: <d:Foo /> undeclared prefix -> "Add xmlns:d declaration" (zero-width insertion of the standard blend namespace)`);

  // 21e) code action for an undeclared CUSTOM prefix (WXAML0001) whose element names one of the project's
  //      OWN source types -> "Add xmlns:local=\"using:<namespace>\"". <local:SmokePage> references the
  //      fixture's own SmokeFixture.SmokePage, so the fix INFERS the using: namespace from the type system
  //      (grouped after the root's xmlns declarations, before x:Class) as a single zero-width edit.
  const caUsing = `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Grid>\n    <local:SmokePage />\n  </Grid>\n</Page>`;
  const caUsingDiags = await validateDoc(
    caUsing,
    (d) => d.some((x) => x.code === "WXAML0001" && x.message.includes("'local'")),
    "code-action custom prefix using:"
  );
  const caUsingDiag = caUsingDiags.find((x) => x.code === "WXAML0001");
  if (!caUsingDiag) fail(`code actions: expected a WXAML0001 for the undeclared 'local' prefix (got ${JSON.stringify(caUsingDiags.map((x) => x.code))})`);
  const caUsingActions = await codeActionWith(393, caUsingDiag, "add-xmlns-local-using");
  const caUsingFix = caUsingActions.find((a) => a.title === 'Add xmlns:local="using:SmokeFixture"');
  if (!caUsingFix) fail(`code actions: expected an 'Add xmlns:local="using:SmokeFixture"' quick fix (got ${JSON.stringify(caUsingActions.map((a) => a.title))})`);
  if (caUsingFix.kind !== "quickfix") fail(`code actions: using: fix kind should be 'quickfix', got ${caUsingFix.kind}`);
  if (caUsingFix.isPreferred !== true) fail(`code actions: the using: fix should be isPreferred (single candidate namespace)`);
  const caUsingEdit = caUsingFix.edit && caUsingFix.edit.changes && caUsingFix.edit.changes[xamlUri] && caUsingFix.edit.changes[xamlUri][0];
  const expectedUsing = ' xmlns:local="using:SmokeFixture"';
  if (!caUsingEdit || caUsingEdit.newText !== expectedUsing) {
    fail(`code actions: using: fix must insert '${expectedUsing}' (got ${JSON.stringify(caUsingEdit)})`);
  }
  if (JSON.stringify(caUsingEdit.range.start) !== JSON.stringify(caUsingEdit.range.end)) {
    fail(`code actions: using: fix must be a zero-width insertion (got ${JSON.stringify(caUsingEdit.range)})`);
  }
  if (caUsingEdit.range.start.line !== 0) {
    fail(`code actions: using: fix must insert on the root open-tag line 0 (got line ${caUsingEdit.range.start.line})`);
  }
  // Grouped after the xmlns block but before x:Class (proves the insertion point, and that applying it
  // yields a well-formed root declaration that makes 'local' resolvable).
  {
    const rootLine0 = caUsing.split("\n")[0];
    const spliced = rootLine0.slice(0, caUsingEdit.range.start.character) + expectedUsing + rootLine0.slice(caUsingEdit.range.start.character);
    const locAt = spliced.indexOf('xmlns:local="using:SmokeFixture"');
    if (locAt < 0 || !(spliced.indexOf("xmlns:x") < locAt && locAt < spliced.indexOf("x:Class"))) {
      fail(`code actions: using: fix must be grouped after the xmlns block and before x:Class (spliced: ${spliced})`);
    }
  }
  console.log(`[ok] code actions: <local:SmokePage> undeclared custom prefix -> 'Add xmlns:local="using:SmokeFixture"' (using: namespace inferred from the project's own type)`);

  // 22a) close-tag completion — typing "</" inside an unclosed element offers that element's name so
  //      it completes to "</Grid>" (VS-style). Purely AST-driven (no type system): the nearest UNCLOSED
  //      enclosing element wins; a '>' is appended only when one is not already present after the caret;
  //      self-closed siblings are skipped; property-element (dotted) names come whole; and when every
  //      enclosing element is already closed nothing is offered (never a name that wouldn't balance).
  const ctBody = `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Grid>\n    </|\n</Page>`;
  const ctItems = await completeItemsWith(386, ctBody, "close-tag unclosed grid");
  const ctGrid = ctItems.find((i) => i.label === "Grid");
  if (!ctGrid) fail(`close-tag: '</' inside an unclosed <Grid> should offer 'Grid' (got ${JSON.stringify(ctItems.map((i) => i.label))})`);
  if (!ctGrid.textEdit || ctGrid.textEdit.newText !== "Grid>") {
    fail(`close-tag: no '>' after the caret means the fix must append it -> 'Grid>' (got ${JSON.stringify(ctGrid.textEdit)})`);
  }
  console.log(`[ok] close-tag: '</' in an unclosed <Grid> -> 'Grid>' (${ctItems.length} item)`);

  // '<' auto-closing pair leaves "</>" with the caret before the '>': reuse it, don't double it.
  const ctBody2 = `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Grid>\n    </|>\n</Page>`;
  const ctItems2 = await completeItemsWith(387, ctBody2, "close-tag autoclosed bracket");
  const ctGrid2 = ctItems2.find((i) => i.label === "Grid");
  if (!ctGrid2) fail(`close-tag: '</>' inside an unclosed <Grid> should still offer 'Grid' (got ${JSON.stringify(ctItems2.map((i) => i.label))})`);
  if (!ctGrid2.textEdit || ctGrid2.textEdit.newText !== "Grid") {
    fail(`close-tag: an existing '>' after the caret must be reused -> 'Grid' with no extra bracket (got ${JSON.stringify(ctGrid2.textEdit)})`);
  }
  console.log(`[ok] close-tag: '</>' (auto-closed bracket) -> 'Grid' reusing the existing '>'`);

  // Property-element (dotted) name comes whole; self-closed siblings are skipped.
  const ctBody3 = `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Grid>\n    <Grid.RowDefinitions>\n      <RowDefinition />\n      </|\n  </Grid>\n</Page>`;
  const ctLabels3 = (await completeItemsWith(388, ctBody3, "close-tag property element")).map((i) => i.label);
  if (!ctLabels3.includes("Grid.RowDefinitions")) {
    fail(`close-tag: '</' inside <Grid.RowDefinitions> should offer the whole dotted name (got ${JSON.stringify(ctLabels3)})`);
  }
  console.log(`[ok] close-tag: '</' inside <Grid.RowDefinitions> -> 'Grid.RowDefinitions' (self-closed <RowDefinition/> skipped)`);

  // When every enclosing element is already closed, nothing is offered (no guessed name).
  const ctBody4 = `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <StackPanel></StackPanel>\n  </|\n</Page>`;
  const ctLabels4 = (await completeItemsWith(389, ctBody4, "close-tag all closed")).map((i) => i.label);
  if (ctLabels4.length !== 0) {
    fail(`close-tag: with every enclosing element already closed, nothing should be offered (got ${JSON.stringify(ctLabels4)})`);
  }
  console.log(`[ok] close-tag: all enclosing elements closed -> no suggestion (never guesses an unbalancing name)`);

  // Fully-typed matching name WITHOUT '>': the parser marks the element closed (EndTagSpan present)
  // yet the tag still needs its '>', so the suggestion must stay available through the last keystroke
  // and append '>'. (round-47 red-team regression: previously returned nothing.)
  const ctBody5 = `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Grid>\n    </Grid|\n</Page>`;
  const ctItems5 = await completeItemsWith(390, ctBody5, "close-tag fully-typed no bracket");
  const ctGrid5 = ctItems5.find((i) => i.label === "Grid");
  if (!ctGrid5) fail(`close-tag: a fully-typed '</Grid' must still offer 'Grid' (got ${JSON.stringify(ctItems5.map((i) => i.label))})`);
  if (!ctGrid5.textEdit || ctGrid5.textEdit.newText !== "Grid>") {
    fail(`close-tag: fully-typed '</Grid' with no '>' must append it -> 'Grid>' (got ${JSON.stringify(ctGrid5.textEdit)})`);
  }
  console.log(`[ok] close-tag: fully-typed '</Grid' (no '>') -> 'Grid>' (stays available, appends '>')`);

  // Fully-typed matching name WITH '>' already present (caret before it): still offered, reuse the '>'.
  const ctBody6 = `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Grid>\n    </Grid|>\n</Page>`;
  const ctItems6 = await completeItemsWith(391, ctBody6, "close-tag fully-typed with bracket");
  const ctGrid6 = ctItems6.find((i) => i.label === "Grid");
  if (!ctGrid6) fail(`close-tag: a fully-typed '</Grid>' (caret before '>') must still offer 'Grid' (got ${JSON.stringify(ctItems6.map((i) => i.label))})`);
  if (!ctGrid6.textEdit || ctGrid6.textEdit.newText !== "Grid") {
    fail(`close-tag: fully-typed '</Grid>' must reuse the existing '>' -> 'Grid' (got ${JSON.stringify(ctGrid6.textEdit)})`);
  }
  console.log(`[ok] close-tag: fully-typed '</Grid>' (caret before '>') -> 'Grid' reusing the existing '>'`);

  // 21f) xmlns "using:" CLR-namespace completion — offers the project's OWN source namespaces (SmokeFixture,
  //      sort group 0 / detail "CLR namespace") AND the referenced-assembly namespaces (framework + libraries,
  //      sort group 1 / detail "CLR namespace (referenced)"), so a control library reached only through using:
  //      is completable (VS parity). The two groups are disjoint. Also a PERF gate: the referenced walk over the
  //      full WinAppSDK reference closure runs on this first call (then caches).
  const unBody = `<Page ${NS} xmlns:local="using:|">\n  <Grid />\n</Page>`;
  const unStart = Date.now();
  const unItems = await completeItemsWith(394, unBody, "using-namespace");
  const unElapsed = Date.now() - unStart;
  const unSource = unItems.filter((i) => i.detail === "CLR namespace").map((i) => i.label);
  const unReferenced = unItems.filter((i) => i.detail === "CLR namespace (referenced)").map((i) => i.label);
  if (!unSource.includes("SmokeFixture")) {
    fail(`using: completion must offer the project namespace 'SmokeFixture' as a source namespace (got source ${JSON.stringify(unSource)})`);
  }
  // The referenced group now DOES include framework/library namespaces (a library referenced as an assembly with
  // no registered xmlns is reachable ONLY via using:). "Microsoft.UI.Xaml.Controls" sorts early (Ordinal 'M'), so
  // it survives the MaxItems truncation of the large closure.
  if (!unReferenced.includes("Microsoft.UI.Xaml.Controls")) {
    fail(`using: completion must offer referenced framework namespaces (expected 'Microsoft.UI.Xaml.Controls' in the referenced group; got ${unReferenced.length} referenced items)`);
  }
  // The two groups are disjoint: a source namespace is never also referenced, and vice versa.
  if (unReferenced.includes("SmokeFixture")) {
    fail(`'SmokeFixture' is a source namespace and must not also appear in the referenced group`);
  }
  if (unSource.includes("Microsoft.UI.Xaml.Controls")) {
    fail(`'Microsoft.UI.Xaml.Controls' is a referenced namespace and must not appear in the source group`);
  }
  if (unElapsed > 15000) {
    fail(`using: completion (first referenced-closure walk) took ${unElapsed}ms — perf gate exceeded`);
  }
  console.log(`[ok] using: completion -> source 'SmokeFixture' + ${unReferenced.length} referenced framework/library namespaces (first-call ${unElapsed}ms)`);

  const unBodyMatch = `<Page ${NS} xmlns:local="using:Smoke|">\n  <Grid />\n</Page>`;
  const unLabelsMatch = await completeWith(395, unBodyMatch, "using-namespace-filter");
  if (!unLabelsMatch.includes("SmokeFixture")) {
    fail(`using:Smoke should still match 'SmokeFixture' on the dotted prefix (got ${JSON.stringify(unLabelsMatch)})`);
  }
  const unBodyMiss = `<Page ${NS} xmlns:local="using:Zzz|">\n  <Grid />\n</Page>`;
  const unLabelsMiss = await completeWith(396, unBodyMiss, "using-namespace-filter-miss");
  if (unLabelsMiss.includes("SmokeFixture")) {
    fail(`using:Zzz must NOT match 'SmokeFixture' (got ${JSON.stringify(unLabelsMiss)})`);
  }
  console.log(`[ok] using: completion filters on the whole dotted token (Smoke -> match, Zzz -> no match)`);

  // 429) Referenced-namespace dotted-prefix filtering — typing a partial dotted referenced namespace filters the
  //      referenced group on the WHOLE token, and the token-only replacement never corrupts the typed prefix.
  const unRefBody = `<Page ${NS} xmlns:zzz="using:Microsoft.UI.Xaml.Cont|">\n  <Grid />\n</Page>`;
  const unRefItems = await completeItemsWith(429, unRefBody, "using-referenced-filter");
  const unRefCtrls = unRefItems.find((i) => i.label === "Microsoft.UI.Xaml.Controls");
  if (!unRefCtrls || unRefCtrls.detail !== "CLR namespace (referenced)") {
    fail(`using: dotted referenced filter must offer 'Microsoft.UI.Xaml.Controls' (referenced); got ${JSON.stringify(unRefItems.map((i) => i.label))}`);
  }
  if (unRefCtrls.textEdit && unRefCtrls.textEdit.newText !== "Microsoft.UI.Xaml.Controls") {
    fail(`using: referenced completion must replace with the whole namespace token (got ${JSON.stringify(unRefCtrls.textEdit)})`);
  }
  console.log(`[ok] using: referenced completion filters on the whole dotted token -> Microsoft.UI.Xaml.Controls`);

  // 430) xmlns declaration VALUE completion (round 61) — an empty/partial xmlns value offers the well-known
  //      framework URIs plus the using: scheme (VS-parity authoring aid), each replacing the whole value.
  const PRES = "http://schemas.microsoft.com/winfx/2006/xaml/presentation";
  const XAMLNS = "http://schemas.microsoft.com/winfx/2006/xaml";
  const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
  const xvEmpty = await completeItemsWith(430, `<Page ${NS} xmlns:zzz="|">\n  <Grid />\n</Page>`, "xmlns-value-empty");
  const xvLabels = xvEmpty.map((i) => i.label);
  for (const want of [PRES, XAMLNS, MC, "using:"]) {
    if (!xvLabels.includes(want)) {
      fail(`empty xmlns value must offer '${want}' (got ${JSON.stringify(xvLabels.filter((l) => l.startsWith("http") || l === "using:"))})`);
    }
  }
  const presItem = xvEmpty.find((i) => i.label === PRES);
  if (presItem.detail !== "WinUI presentation namespace") {
    fail(`presentation URI should carry its detail (got ${JSON.stringify(presItem.detail)})`);
  }
  const presNewText = presItem.textEdit ? presItem.textEdit.newText : presItem.insertText;
  if (presNewText !== PRES) {
    fail(`xmlns value item must replace the whole value with the URI (got ${JSON.stringify(presNewText)})`);
  }
  // Scheme still being typed -> the using: scheme item is offered (hands off to CLR-namespace completion).
  const xvUsing = (await completeItemsWith(431, `<Page ${NS} xmlns:zzz="usin|">\n  <Grid />\n</Page>`, "xmlns-value-using")).map((i) => i.label);
  if (!xvUsing.includes("using:")) {
    fail(`partial 'usin' must offer the using: scheme (got ${JSON.stringify(xvUsing)})`);
  }
  // A partial URI filters on the whole value: the presentation prefix matches the WinUI URI but not the mc URI.
  const xvHttp = (await completeItemsWith(432, `<Page ${NS} xmlns:zzz="http://schemas.microsoft.com/winfx|">\n  <Grid />\n</Page>`, "xmlns-value-partial")).map((i) => i.label);
  if (!xvHttp.includes(PRES) || xvHttp.includes(MC)) {
    fail(`partial winfx URI must match the WinUI URIs but not the openxmlformats mc URI (got ${JSON.stringify(xvHttp.filter((l) => l.startsWith("http")))})`);
  }
  console.log(`[ok] xmlns value completion -> framework URIs + using: scheme, whole-value replacement, prefix-filtered`);

  // 433-436) RelativePanel alignment attached-property completion (round 62) — properties like
  //      RelativePanel.RightOf reference an x:Name'd sibling, so they complete with the in-scope element
  //      names (like Storyboard.TargetName); the boolean *WithPanel variants stay bool (True/False).
  const rpNames = (inner, id, label) =>
    completeWith(id, `<Page ${NS}>\n  <RelativePanel>\n    <TextBox x:Name="FirstBox" />\n    <TextBox x:Name="SecondBox" />\n    <Button x:Name="GoButton" ${inner} />\n  </RelativePanel>\n</Page>`, label);

  const rpRightOf = await rpNames('RelativePanel.RightOf="|"', 433, "relativepanel-rightof");
  for (const want of ["FirstBox", "SecondBox"]) {
    if (!rpRightOf.includes(want)) {
      fail(`RelativePanel.RightOf must offer the in-scope name '${want}' (got ${JSON.stringify(rpRightOf)})`);
    }
  }
  const rpFilter = await rpNames('RelativePanel.RightOf="First|"', 434, "relativepanel-filter");
  if (!rpFilter.includes("FirstBox") || rpFilter.includes("SecondBox")) {
    fail(`RelativePanel.RightOf partial 'First' must match FirstBox but not SecondBox (got ${JSON.stringify(rpFilter)})`);
  }
  const rpAlignTop = await rpNames('RelativePanel.AlignTopWith="|"', 435, "relativepanel-aligntop");
  if (!rpAlignTop.includes("FirstBox")) {
    fail(`RelativePanel.AlignTopWith must also offer in-scope names (got ${JSON.stringify(rpAlignTop)})`);
  }
  const rpPanelBool = await rpNames('RelativePanel.AlignLeftWithPanel="|"', 436, "relativepanel-panelbool");
  if (!rpPanelBool.includes("True") || !rpPanelBool.includes("False")) {
    fail(`RelativePanel.AlignLeftWithPanel is boolean -> should offer True/False (got ${JSON.stringify(rpPanelBool)})`);
  }
  if (rpPanelBool.includes("FirstBox")) {
    fail(`the boolean *WithPanel variant must NOT offer element names (got ${JSON.stringify(rpPanelBool)})`);
  }
  console.log(`[ok] RelativePanel alignment completion -> in-scope x:Names (filtered); *WithPanel stays boolean`);

  // 21g) classic {Binding} member-path completion (round 51) — inside a DataTemplate the design-time
  //      DataContext is the template's x:DataType, so {Binding} completes that type's members; at the
  //      page root the DataContext type is unknown, so {Binding} offers no project members.
  const cbTemplate =
    `<Page ${NS} xmlns:local="using:SmokeFixture" x:Class="SmokeFixture.SmokePage">\n` +
    `  <ListView>\n    <ListView.ItemTemplate>\n` +
    `      <DataTemplate x:DataType="local:SmokePage">\n` +
    `        <TextBlock Text="{Binding Gree|}" />\n` +
    `      </DataTemplate>\n    </ListView.ItemTemplate>\n  </ListView>\n</Page>`;
  const cbLabels = await completeWith(397, cbTemplate, "classic-binding-template");
  if (!cbLabels.includes("GreetingText")) {
    fail(`classic {Binding} in a DataTemplate must complete the x:DataType member 'GreetingText' (got ${JSON.stringify(cbLabels)})`);
  }

  const cbEmpty =
    `<Page ${NS} xmlns:local="using:SmokeFixture" x:Class="SmokeFixture.SmokePage">\n` +
    `  <TextBlock Text="{Binding |}" />\n</Page>`;
  const cbEmptyLabels = await completeWith(398, cbEmpty, "classic-binding-page-root");
  if (cbEmptyLabels.includes("GreetingText")) {
    fail(`classic {Binding} at the page root must NOT leak x:Class members (DataContext is unknown; got ${JSON.stringify(cbEmptyLabels)})`);
  }

  // Round 76: an ElementName redirect inside a DataTemplate roots the path at the NAMED element's type,
  // overriding the template's x:DataType — so it completes that element's members, not the x:DataType's.
  const cbRedirect =
    `<Page ${NS} xmlns:local="using:SmokeFixture" x:Class="SmokeFixture.SmokePage">\n` +
    `  <ListView>\n    <ListView.ItemTemplate>\n` +
    `      <DataTemplate x:DataType="local:SmokePage">\n` +
    `        <StackPanel>\n` +
    `          <TextBox x:Name="Root" />\n` +
    `          <TextBlock Text="{Binding ElementName=Root, Path=|}" />\n` +
    `        </StackPanel>\n` +
    `      </DataTemplate>\n    </ListView.ItemTemplate>\n  </ListView>\n</Page>`;
  const cbRedirectLabels = await completeWith(399, cbRedirect, "classic-binding-redirect");
  for (const want of ["Text", "IsEnabled"]) {
    if (!cbRedirectLabels.includes(want)) {
      fail(`{Binding ElementName=Root} inside a DataTemplate should offer the named TextBox member '${want}' (got ${JSON.stringify(cbRedirectLabels.slice(0, 40))})`);
    }
  }
  if (cbRedirectLabels.includes("GreetingText")) {
    fail(`{Binding ElementName=Root} must root at the named element, NOT the template x:DataType (leaked 'GreetingText')`);
  }
  console.log(`[ok] classic {Binding}: DataTemplate -> x:DataType members; ElementName redirect -> named element wins over x:DataType`);

  // 21h) classic {Binding} page-level rooting via a design-time DataContext (round 52) — an ancestor's
  //      d:DataContext="{d:DesignInstance local:SmokePage}" gives the editor the DataContext type, so a
  //      page-level {Binding} completes that type's members. A nearer DataTemplate x:DataType still wins.
  const diNs =
    `<Page ${NS} xmlns:d="http://schemas.microsoft.com/expression/blend/2008" ` +
    `xmlns:local="using:SmokeFixture" ` +
    `xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ` +
    `mc:Ignorable="d" x:Class="SmokeFixture.SmokePage">`;

  const diBody =
    `${diNs}\n  <Grid d:DataContext="{d:DesignInstance local:SmokePage}">\n` +
    `    <TextBlock Text="{Binding Gree|}" />\n  </Grid>\n</Page>`;
  const diLabels = await completeWith(400, diBody, "design-instance-binding");
  if (!diLabels.includes("GreetingText")) {
    fail(`d:DataContext {d:DesignInstance local:SmokePage} must root {Binding} at SmokePage -> GreetingText (got ${JSON.stringify(diLabels)})`);
  }

  const diTypeEq =
    `${diNs}\n  <Grid d:DataContext="{d:DesignInstance Type=local:SmokePage, IsDesignTimeCreatable=True}">\n` +
    `    <TextBlock Text="{Binding Gree|}" />\n  </Grid>\n</Page>`;
  const diTypeEqLabels = await completeWith(401, diTypeEq, "design-instance-type-eq");
  if (!diTypeEqLabels.includes("GreetingText")) {
    fail(`d:DesignInstance Type=local:SmokePage (named form) must also root at SmokePage (got ${JSON.stringify(diTypeEqLabels)})`);
  }

  const diShadow =
    `${diNs}\n  <Grid d:DataContext="{d:DesignInstance local:SmokePage}">\n` +
    `    <ListView>\n      <ListView.ItemTemplate>\n        <DataTemplate x:DataType="x:String">\n` +
    `          <TextBlock Text="{Binding Gree|}" />\n` +
    `        </DataTemplate>\n      </ListView.ItemTemplate>\n    </ListView>\n  </Grid>\n</Page>`;
  const diShadowLabels = await completeWith(402, diShadow, "design-instance-shadow");
  if (diShadowLabels.includes("GreetingText")) {
    fail(`a nearer DataTemplate x:DataType must shadow the outer d:DataContext (String has no GreetingText; got ${JSON.stringify(diShadowLabels)})`);
  }

  // The DesignInstance extension's OWN prefix must resolve to a design-time namespace, not just end in
  // ":DesignInstance". An undeclared {zzz:DesignInstance …} is not the hint and must not root the Binding.
  const diBadPrefix =
    `${diNs}\n  <Grid d:DataContext="{zzz:DesignInstance local:SmokePage}">\n` +
    `    <TextBlock Text="{Binding Gree|}" />\n  </Grid>\n</Page>`;
  const diBadPrefixLabels = await completeWith(403, diBadPrefix, "design-instance-bad-prefix");
  if (diBadPrefixLabels.includes("GreetingText")) {
    fail(`an undeclared DesignInstance extension prefix must not root {Binding} at SmokePage (got ${JSON.stringify(diBadPrefixLabels)})`);
  }
  console.log(`[ok] design-time {Binding}: d:DataContext {d:DesignInstance} (positional + Type=) roots at SmokePage; inner x:DataType shadows; foreign extension prefix rejected`);

  // x:DataType is recognized only under the reserved x prefix (consistent with the validator + F12 sites).
  // A DataTemplate whose DataType uses a FOREIGN prefix is not an x:DataType, so bindings inside get no root.
  const xdtControl =
    `${diNs}\n  <ListView><ListView.ItemTemplate>\n` +
    `    <DataTemplate x:DataType="local:SmokePage">\n` +
    `      <TextBlock Text="{x:Bind Gree|}" />\n` +
    `    </DataTemplate>\n  </ListView.ItemTemplate></ListView>\n</Page>`;
  const xdtControlLabels = await completeWith(404, xdtControl, "xdatatype-x-prefix");
  if (!xdtControlLabels.includes("GreetingText")) {
    fail(`x:DataType (reserved x prefix) must root x:Bind at SmokePage -> GreetingText (got ${JSON.stringify(xdtControlLabels)})`);
  }
  const xdtForeign =
    `${diNs}\n  <ListView><ListView.ItemTemplate>\n` +
    `    <DataTemplate zzz:DataType="local:SmokePage">\n` +
    `      <TextBlock Text="{x:Bind Gree|}" />\n` +
    `    </DataTemplate>\n  </ListView.ItemTemplate></ListView>\n</Page>`;
  const xdtForeignLabels = await completeWith(405, xdtForeign, "xdatatype-foreign-prefix");
  if (xdtForeignLabels.includes("GreetingText")) {
    fail(`a foreign-prefix DataType must NOT be treated as x:DataType (expected no GreetingText; got ${JSON.stringify(xdtForeignLabels)})`);
  }
  console.log(`[ok] x:DataType prefix: reserved x roots x:Bind in a template; foreign-prefix DataType is not x:DataType`);

  // Round 54: x:DataType="|" completes type names (the design-time item type), like TargetType.
  const xdtLocal =
    `${diNs}\n  <ListView><ListView.ItemTemplate>\n` +
    `    <DataTemplate x:DataType="local:|">\n` +
    `      <TextBlock />\n    </DataTemplate>\n  </ListView.ItemTemplate></ListView>\n</Page>`;
  const xdtLocalLabels = await completeWith(406, xdtLocal, "xdatatype-value-local");
  if (!xdtLocalLabels.includes("SmokePage")) {
    fail(`x:DataType="local:|" must complete project types -> SmokePage (got ${JSON.stringify(xdtLocalLabels)})`);
  }

  const xdtFilter =
    `${diNs}\n  <ListView><ListView.ItemTemplate>\n` +
    `    <DataTemplate x:DataType="local:Smo|">\n` +
    `      <TextBlock />\n    </DataTemplate>\n  </ListView.ItemTemplate></ListView>\n</Page>`;
  const xdtFilterLabels = await completeWith(407, xdtFilter, "xdatatype-value-filter");
  if (!xdtFilterLabels.includes("SmokePage")) {
    fail(`x:DataType="local:Smo|" must filter to SmokePage (got ${JSON.stringify(xdtFilterLabels)})`);
  }

  // Empty prefix resolves the default (WinUI presentation) namespace -> framework types are offered.
  const xdtDefault =
    `${diNs}\n  <ListView><ListView.ItemTemplate>\n` +
    `    <DataTemplate x:DataType="Butt|">\n` +
    `      <TextBlock />\n    </DataTemplate>\n  </ListView.ItemTemplate></ListView>\n</Page>`;
  const xdtDefaultLabels = await completeWith(408, xdtDefault, "xdatatype-value-default-ns");
  if (!xdtDefaultLabels.includes("Button")) {
    fail(`x:DataType="Butt|" must complete default-namespace framework types -> Button (got ${JSON.stringify(xdtDefaultLabels)})`);
  }

  // Guard: only x:DataType gets type completion; another x: directive (x:Name) must not.
  const xnameGuard =
    `${diNs}\n  <ListView><ListView.ItemTemplate>\n` +
    `    <DataTemplate x:Name="local:|">\n` +
    `      <TextBlock />\n    </DataTemplate>\n  </ListView.ItemTemplate></ListView>\n</Page>`;
  const xnameGuardLabels = await completeWith(409, xnameGuard, "xname-value-no-types");
  if (xnameGuardLabels.includes("SmokePage")) {
    fail(`x:Name value must NOT get type completion (only x:DataType); got ${JSON.stringify(xnameGuardLabels)}`);
  }
  console.log(`[ok] x:DataType value: completes project (local:SmokePage) + framework (Button) types with prefix/partial filtering; other x: directives unaffected`);

  // Round 55: type-name completion offers the XAML intrinsic aliases (x:String, x:Boolean, …) when the
  // reference prefix resolves to the XAML language namespace — cross-cutting to every type-reference site.
  const xiEmpty =
    `${diNs}\n  <ListView><ListView.ItemTemplate>\n` +
    `    <DataTemplate x:DataType="x:|">\n` +
    `      <TextBlock />\n    </DataTemplate>\n  </ListView.ItemTemplate></ListView>\n</Page>`;
  const xiEmptyLabels = await completeWith(410, xiEmpty, "intrinsic-xdatatype-empty");
  for (const alias of ["String", "Boolean", "Int32", "Object"]) {
    if (!xiEmptyLabels.includes(alias)) {
      fail(`x:DataType="x:|" must offer the XAML intrinsic ${alias} (got ${JSON.stringify(xiEmptyLabels)})`);
    }
  }

  const xiFilter =
    `${diNs}\n  <ListView><ListView.ItemTemplate>\n` +
    `    <DataTemplate x:DataType="x:Str|">\n` +
    `      <TextBlock />\n    </DataTemplate>\n  </ListView.ItemTemplate></ListView>\n</Page>`;
  const xiFilterLabels = await completeWith(411, xiFilter, "intrinsic-xdatatype-filter");
  if (!xiFilterLabels.includes("String") || xiFilterLabels.includes("Boolean")) {
    fail(`x:DataType="x:Str|" must filter intrinsics to String only (got ${JSON.stringify(xiFilterLabels)})`);
  }

  // Cross-cutting + Round 56: TargetType uses the CLASS-ONLY type list, so intrinsics are kind-filtered
  // to match — reference-type aliases (String/Object/Type/Uri) are offered, value-type aliases
  // (Int32/Boolean/Double/…) are NOT, exactly as a value-type CLR struct would be filtered out here.
  const xiTarget = `${diNs}\n  <Style TargetType="x:|" />\n</Page>`;
  const xiTargetLabels = await completeWith(412, xiTarget, "intrinsic-targettype");
  for (const refAlias of ["String", "Object", "Type", "Uri"]) {
    if (!xiTargetLabels.includes(refAlias)) {
      fail(`TargetType="x:|" must offer the reference-type intrinsic ${refAlias} (got ${JSON.stringify(xiTargetLabels)})`);
    }
  }
  for (const valAlias of ["Int32", "Boolean", "Double"]) {
    if (xiTargetLabels.includes(valAlias)) {
      fail(`TargetType="x:|" (class-only) must NOT offer the value-type intrinsic ${valAlias} (got ${JSON.stringify(xiTargetLabels)})`);
    }
  }

  // The intrinsics are keyed by the resolved URI, not the literal "x" prefix: a custom prefix mapped to
  // the XAML language namespace offers them too.
  const xiCustomNs =
    `<Page ${NS} xmlns:d="http://schemas.microsoft.com/expression/blend/2008" ` +
    `xmlns:local="using:SmokeFixture" ` +
    `xmlns:sys="http://schemas.microsoft.com/winfx/2006/xaml" ` +
    `xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ` +
    `mc:Ignorable="d" x:Class="SmokeFixture.SmokePage">`;
  const xiCustom =
    `${xiCustomNs}\n  <ListView><ListView.ItemTemplate>\n` +
    `    <DataTemplate x:DataType="sys:Str|">\n` +
    `      <TextBlock />\n    </DataTemplate>\n  </ListView.ItemTemplate></ListView>\n</Page>`;
  const xiCustomLabels = await completeWith(413, xiCustom, "intrinsic-custom-prefix");
  if (!xiCustomLabels.includes("String")) {
    fail(`a custom prefix mapped to the XAML URI must offer intrinsics -> String (got ${JSON.stringify(xiCustomLabels)})`);
  }

  // Round 56: the kind-permissive callers ({x:Type}/{x:Static} owner, x:DataType) KEEP the value-type
  // intrinsics — a {x:Type x:Int32} / x:DataType="x:Int32" is valid, so the filter must not over-prune.
  const xiTypeArg = `${diNs}\n  <Button Tag="{x:Type x:|}" />\n</Page>`;
  const xiTypeArgLabels = await completeWith(414, xiTypeArg, "intrinsic-xtype-valuetypes");
  for (const alias of ["String", "Int32", "Boolean"]) {
    if (!xiTypeArgLabels.includes(alias)) {
      fail(`{x:Type x:|} (all-kinds) must still offer the intrinsic ${alias} incl. value types (got ${JSON.stringify(xiTypeArgLabels)})`);
    }
  }
  console.log(`[ok] XAML intrinsics: full set in x:DataType/{x:Type} (all kinds); TargetType kind-filtered to reference types only (round 56); partial-filtered; keyed by the resolved XAML URI (custom prefix works)`);

  // Round 57: {d:DesignInstance …} type-argument completion — the AUTHORING counterpart to the round-52
  // CONSUMPTION cases (400-403). The TYPE arg (positional or Type=) completes type names; the extension
  // prefix must resolve to a design-time namespace (foreign/undeclared → nothing).
  const diPos = `${diNs}\n  <Grid d:DataContext="{d:DesignInstance local:|}" />\n</Page>`;
  const diPosLabels = await completeWith(415, diPos, "designinstance-positional-type");
  if (!diPosLabels.includes("SmokePage")) {
    fail(`{d:DesignInstance local:|} must complete project types -> SmokePage (got ${JSON.stringify(diPosLabels)})`);
  }

  const diTypeArg = `${diNs}\n  <Grid d:DataContext="{d:DesignInstance Type=local:Smo|}" />\n</Page>`;
  const diTypeArgLabels = await completeWith(416, diTypeArg, "designinstance-type-eq-completion");
  if (!diTypeArgLabels.includes("SmokePage")) {
    fail(`{d:DesignInstance Type=local:Smo|} must filter to SmokePage (got ${JSON.stringify(diTypeArgLabels)})`);
  }

  // Type= after a leading bool arg is still found (top-level comma splitting).
  const diAfterArg = `${diNs}\n  <Grid d:DataContext="{d:DesignInstance IsDesignTimeCreatable=True, Type=local:Smo|}" />\n</Page>`;
  const diAfterArgLabels = await completeWith(417, diAfterArg, "designinstance-type-after-arg");
  if (!diAfterArgLabels.includes("SmokePage")) {
    fail(`{d:DesignInstance IsDesignTimeCreatable=True, Type=local:Smo|} must still complete SmokePage (got ${JSON.stringify(diAfterArgLabels)})`);
  }

  // A custom prefix mapped to the SAME design-time URI also works (gate is by resolved URI, not literal "d").
  const diCustomNs =
    `<Page ${NS} xmlns:dd="http://schemas.microsoft.com/expression/blend/2008" ` +
    `xmlns:local="using:SmokeFixture" ` +
    `xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ` +
    `mc:Ignorable="dd" x:Class="SmokeFixture.SmokePage">`;
  const diCustom = `${diCustomNs}\n  <Grid dd:DataContext="{dd:DesignInstance local:|}" />\n</Page>`;
  const diCustomLabels = await completeWith(418, diCustom, "designinstance-custom-design-prefix");
  if (!diCustomLabels.includes("SmokePage")) {
    fail(`{dd:DesignInstance local:|} (custom prefix on the blend/2008 URI) must complete SmokePage (got ${JSON.stringify(diCustomLabels)})`);
  }

  // Gate: a foreign/undeclared extension prefix offers NOTHING (design-time namespace gate).
  const diForeign = `${diNs}\n  <Grid d:DataContext="{zzz:DesignInstance local:|}" />\n</Page>`;
  const diForeignLabels = await completeWith(419, diForeign, "designinstance-foreign-prefix");
  if (diForeignLabels.includes("SmokePage")) {
    fail(`{zzz:DesignInstance local:|} (undeclared prefix) must offer no type completion (got ${JSON.stringify(diForeignLabels)})`);
  }

  // The wrapped {d:DesignInstance {x:Type local:Smo|}} form completes via the inner {x:Type} re-rooting.
  const diWrapped = `${diNs}\n  <Grid d:DataContext="{d:DesignInstance {x:Type local:Smo|}}" />\n</Page>`;
  const diWrappedLabels = await completeWith(420, diWrapped, "designinstance-wrapped-xtype");
  if (!diWrappedLabels.includes("SmokePage")) {
    fail(`{d:DesignInstance {x:Type local:Smo|}} must complete SmokePage via the inner {x:Type} (got ${JSON.stringify(diWrappedLabels)})`);
  }
  console.log(`[ok] {d:DesignInstance …} type-arg completion: positional + Type= (incl. after another arg) complete project types; custom design-time prefix works by URI; foreign prefix gated to nothing; wrapped {x:Type} re-roots (round 57)`);

  // Round 58: XAML intrinsic aliases offered as ELEMENTS (<x:String>, <x:Double>, …) — the element-name
  // counterpart to rounds 55/56 (which offered them in type-REFERENCE positions). ALL 14 are offered
  // (incl. value types) since XAML supports instantiating the intrinsic value types as elements; the gate
  // is the resolved XAML language URI, and the existing content-type assignability filter still constrains
  // typed collection property elements.
  const xelEmpty = pageRes("<x:|");
  const xelEmptyLabels = await completeWith(421, xelEmpty, "intrinsic-element-empty");
  for (const alias of ["String", "Int32", "Double", "Boolean", "Object", "TimeSpan", "Uri"]) {
    if (!xelEmptyLabels.includes(alias)) {
      fail(`<x:| element completion must offer the intrinsic ${alias} (got ${JSON.stringify(xelEmptyLabels)})`);
    }
  }

  const xelFilter = pageRes("<x:Dou|");
  const xelFilterLabels = await completeWith(422, xelFilter, "intrinsic-element-filter");
  if (!xelFilterLabels.includes("Double") || xelFilterLabels.includes("Int32") || xelFilterLabels.includes("String")) {
    fail(`<x:Dou| must filter intrinsic elements to Double only (got ${JSON.stringify(xelFilterLabels)})`);
  }

  // Unprefixed element position (default presentation ns) must NOT offer intrinsics — you write <x:String>.
  const xelDefault = `<Page ${NS}>\n  <|\n</Page>`;
  const xelDefaultLabels = await completeWith(423, xelDefault, "intrinsic-element-default-ns");
  if (xelDefaultLabels.includes("Int32") || xelDefaultLabels.includes("Double")) {
    fail(`unprefixed <| must not offer intrinsic elements (got ${JSON.stringify(xelDefaultLabels)})`);
  }

  // A custom prefix mapped to the XAML language URI offers intrinsic elements too (gate is by resolved URI).
  const xelCustom = `<Page ${NS} xmlns:sys="http://schemas.microsoft.com/winfx/2006/xaml">\n  <Page.Resources>\n    <sys:Str|\n  </Page.Resources>\n</Page>`;
  const xelCustomLabels = await completeWith(424, xelCustom, "intrinsic-element-custom-prefix");
  if (!xelCustomLabels.includes("String")) {
    fail(`<sys:Str| (custom prefix on the XAML URI) must offer the String intrinsic element (got ${JSON.stringify(xelCustomLabels)})`);
  }

  // Assignability: inside a typed collection property element the intrinsics are filtered out, exactly as
  // the CLR element list is — <Grid.RowDefinitions> offers RowDefinition, not <x:String>.
  const xelTyped = `<Page ${NS}>\n  <Grid>\n    <Grid.RowDefinitions>\n      <x:|\n    </Grid.RowDefinitions>\n  </Grid>\n</Page>`;
  const xelTypedLabels = await completeWith(425, xelTyped, "intrinsic-element-assignability");
  if (xelTypedLabels.includes("String") || xelTypedLabels.includes("Int32") || xelTypedLabels.includes("Double")) {
    fail(`<Grid.RowDefinitions><x:| must not offer non-assignable intrinsic elements (got ${JSON.stringify(xelTypedLabels)})`);
  }
  console.log(`[ok] XAML intrinsics as ELEMENTS: <x:| offers the full 14 (incl. value types) in resources; partial-filtered; unprefixed offers none; custom XAML-URI prefix works; typed collection property element filters them by assignability (round 58)`);

  // 437-440) contextual parent-container attached-property name completion (round 63) — a child element's
  //      attribute-name list also offers the nearest container's attached properties (e.g. Grid.Row/Column
  //      on a child of a <Grid>), ranked after the element's own members, exactly like VS/Blend. Immediate
  //      container only (self-limiting: a container with no attached properties adds nothing).
  const gridChild = `<Page ${NS}>\n  <Grid>\n    <Button |/>\n  </Grid>\n</Page>`;
  const gridChildLabels = await completeWith(437, gridChild, "container-attached-grid");
  for (const want of ["Grid.Row", "Grid.Column", "Grid.RowSpan", "Grid.ColumnSpan"]) {
    if (!gridChildLabels.includes(want)) {
      fail(`<Grid><Button | must offer the container's attached property '${want}' (got ${JSON.stringify(gridChildLabels.filter((l) => l.startsWith("Grid.")))})`);
    }
  }
  if (!gridChildLabels.includes("IsEnabled")) {
    fail(`<Grid><Button | must still offer the element's OWN members (IsEnabled) alongside attached props (got ${JSON.stringify(gridChildLabels.slice(0, 20))})`);
  }

  const gridChildPartial = `<Page ${NS}>\n  <Grid>\n    <Button Ro|/>\n  </Grid>\n</Page>`;
  const gridPartialLabels = await completeWith(438, gridChildPartial, "container-attached-grid-partial");
  if (!gridPartialLabels.includes("Grid.Row") || !gridPartialLabels.includes("Grid.RowSpan")) {
    fail(`partial 'Ro' must match the attached member name -> Grid.Row/Grid.RowSpan (got ${JSON.stringify(gridPartialLabels.filter((l) => l.startsWith("Grid.")))})`);
  }
  if (gridPartialLabels.includes("Grid.Column")) {
    fail(`partial 'Ro' must NOT surface Grid.Column (member 'Column' does not start with 'Ro'; got ${JSON.stringify(gridPartialLabels.filter((l) => l.startsWith("Grid.")))})`);
  }

  const canvasChild = `<Page ${NS}>\n  <Canvas>\n    <Button |/>\n  </Canvas>\n</Page>`;
  const canvasChildLabels = await completeWith(439, canvasChild, "container-attached-canvas");
  for (const want of ["Canvas.Left", "Canvas.Top"]) {
    if (!canvasChildLabels.includes(want)) {
      fail(`<Canvas><Button | must offer '${want}' (got ${JSON.stringify(canvasChildLabels.filter((l) => l.startsWith("Canvas.")))})`);
    }
  }
  if (canvasChildLabels.includes("Grid.Row")) {
    fail(`a Canvas child must NOT offer Grid.Row (only the immediate container's attached properties; got ${JSON.stringify(canvasChildLabels.filter((l) => l.includes(".")))})`);
  }

  // Immediate-container scoping + self-limiting: a StackPanel defines no attached properties, so a StackPanel
  // child (even nested inside a Grid) offers NO attached properties — Grid.Row applies to the StackPanel, not
  // to the StackPanel's own child.
  const stackChild = `<Page ${NS}>\n  <Grid>\n    <StackPanel>\n      <Button |/>\n    </StackPanel>\n  </Grid>\n</Page>`;
  const stackChildLabels = await completeWith(440, stackChild, "container-attached-none");
  if (stackChildLabels.includes("Grid.Row") || stackChildLabels.includes("Canvas.Left")) {
    fail(`a StackPanel child must offer NO container attached properties (StackPanel has none; Grid is not the immediate container; got ${JSON.stringify(stackChildLabels.filter((l) => l.includes(".")))})`);
  }
  if (!stackChildLabels.includes("IsEnabled")) {
    fail(`a StackPanel child must still offer its own members (IsEnabled) (got ${JSON.stringify(stackChildLabels.slice(0, 20))})`);
  }
  console.log(`[ok] container attached-property completion: a child offers the immediate container's attached props (Grid.Row/Column, Canvas.Left/Top) after its own members; member-partial filtered; self-limiting (round 63)`);

  // 441-445) mc:Ignorable value completion (round 64) — the near-universal WinUI header attribute lists the
  //      namespace prefixes a runtime XAML processor may ignore; offer the declared DESIGN-TIME prefixes
  //      (space-separated aware), matched by the RESOLVED markup-compatibility URI so a custom prefix works.
  const D2008 = "http://schemas.microsoft.com/expression/blend/2008";
  const D2006 = "http://schemas.microsoft.com/expression/blend/2006";
  const mcHeader = (rootAttrs) =>
    `<Page ${NS} xmlns:d="${D2008}" xmlns:dd="${D2006}" xmlns:mc="${MC}" ${rootAttrs}>\n  <Grid />\n</Page>`;

  const mcEmpty = await completeWith(441, mcHeader('mc:Ignorable="|"'), "mc-ignorable-empty");
  for (const want of ["d", "dd"]) {
    if (!mcEmpty.includes(want)) {
      fail(`mc:Ignorable="|" must offer the declared design-time prefix '${want}' (got ${JSON.stringify(mcEmpty)})`);
    }
  }
  for (const notWant of ["mc", "x"]) {
    if (mcEmpty.includes(notWant)) {
      fail(`mc:Ignorable must NOT offer the non-design-time prefix '${notWant}' (got ${JSON.stringify(mcEmpty)})`);
    }
  }

  const mcPartial = await completeWith(442, mcHeader('mc:Ignorable="d|"'), "mc-ignorable-partial");
  if (!mcPartial.includes("d") || !mcPartial.includes("dd")) {
    fail(`mc:Ignorable="d|" must match both 'd' and 'dd' (StartsWith 'd'; got ${JSON.stringify(mcPartial)})`);
  }
  const mcGarbage = await completeWith(443, mcHeader('mc:Ignorable="z|"'), "mc-ignorable-garbage");
  if (mcGarbage.length !== 0) {
    fail(`mc:Ignorable="z|" must offer nothing (no design-time prefix starts with 'z'; got ${JSON.stringify(mcGarbage)})`);
  }

  // Space-separated: 'd' already listed -> offer only the remaining design-time prefix 'dd', and the edit must
  // replace ONLY the current (empty) token after the space, not the whole "d " value.
  const mcSecond = await completeItemsWith(444, mcHeader('mc:Ignorable="d |"'), "mc-ignorable-second");
  const mcSecondLabels = mcSecond.map((i) => i.label);
  if (!mcSecondLabels.includes("dd") || mcSecondLabels.includes("d")) {
    fail(`mc:Ignorable="d |" must offer 'dd' and NOT re-offer the already-listed 'd' (got ${JSON.stringify(mcSecondLabels)})`);
  }
  const ddItem = mcSecond.find((i) => i.label === "dd");
  if (ddItem.textEdit.newText !== "dd") {
    fail(`the second-token edit must insert just 'dd' (got ${JSON.stringify(ddItem.textEdit)})`);
  }

  // Resolved-URI gating: a CUSTOM prefix mapped to the markup-compatibility URI is also mc:Ignorable; a
  // design-time-prefixed 'Ignorable' (wrong URI) is NOT.
  const mcCustom = await completeWith(445,
    `<Page ${NS} xmlns:d="${D2008}" xmlns:compat="${MC}" compat:Ignorable="|">\n  <Grid />\n</Page>`,
    "mc-ignorable-custom-prefix");
  if (!mcCustom.includes("d")) {
    fail(`compat:Ignorable (custom prefix on the markup-compat URI) must offer 'd' (got ${JSON.stringify(mcCustom)})`);
  }
  const mcWrongUri = await completeWith(446,
    `<Page ${NS} xmlns:d="${D2008}" d:Ignorable="|">\n  <Grid />\n</Page>`,
    "mc-ignorable-wrong-uri");
  if (mcWrongUri.includes("d")) {
    fail(`d:Ignorable (design-time prefix, NOT the markup-compat URI) must not be treated as mc:Ignorable (got ${JSON.stringify(mcWrongUri)})`);
  }
  console.log(`[ok] mc:Ignorable value completion: offers declared design-time prefixes (d/dd), space-separated aware (already-listed excluded, current-token edit), URI-gated (custom mc prefix works, design-time-prefixed Ignorable rejected) (round 64)`);

  // 447-450) x:Bind enum-argument VALUE completion (round 65) — {x:Bind} is compiled and has no reflectable
  //      extension type, so its enum-typed named arguments (Mode, UpdateSourceTrigger) resolve to null and
  //      previously the VALUE completed nothing even though the NAME is offered. A curated enum map now
  //      supplies the CLR enum so the value completes.
  const ust = await completeWith(447, pageCls('<TextBox Text="{x:Bind GreetingText, Mode=TwoWay, UpdateSourceTrigger=|}" />'), "xbind-ust");
  for (const want of ["Default", "PropertyChanged", "Explicit", "LostFocus"]) {
    if (!ust.includes(want)) fail(`x:Bind UpdateSourceTrigger completion missing '${want}' (got ${ust.join(",")})`);
  }
  const ustPartial = await completeWith(448, pageCls('<TextBox Text="{x:Bind GreetingText, UpdateSourceTrigger=Prop|}" />'), "xbind-ust-partial");
  if (!ustPartial.includes("PropertyChanged")) fail(`UpdateSourceTrigger='Prop' should offer PropertyChanged (got ${ustPartial.join(",")})`);
  if (ustPartial.includes("Default")) fail(`UpdateSourceTrigger='Prop' should not offer Default (got ${ustPartial.join(",")})`);
  // Regression: x:Bind Mode= still resolves BindingMode via the same map.
  const modeStill = await completeWith(449, pageCls('<TextBlock Text="{x:Bind GreetingText, Mode=|}" />'), "xbind-mode-still");
  for (const want of ["OneWay", "TwoWay", "OneTime"]) {
    if (!modeStill.includes(want)) fail(`x:Bind Mode still must offer BindingMode '${want}' (got ${modeStill.join(",")})`);
  }
  // Classic {Binding} UpdateSourceTrigger resolves through its runtime extension type (unchanged path).
  const bindingUst = await completeWith(450, pageCls('<TextBox Text="{Binding Path=X, UpdateSourceTrigger=|}" />'), "binding-ust");
  for (const want of ["PropertyChanged", "LostFocus"]) {
    if (!bindingUst.includes(want)) fail(`classic Binding UpdateSourceTrigger missing '${want}' (got ${bindingUst.join(",")})`);
  }
  console.log(`[ok] x:Bind enum-argument value completion: UpdateSourceTrigger -> Default/PropertyChanged/Explicit/LostFocus (partial-filtered), Mode -> BindingMode preserved, classic Binding UpdateSourceTrigger via extension type (round 65)`);

  // 451) Leak guard (round 65): the curated x:Bind enum fallback is GATED to compiled-binding extensions, so
  //      a non-binding extension with a bogus same-named argument must NOT borrow BindingMode/UpdateSourceTrigger.
  const enumLeak = ["OneWay", "TwoWay", "OneTime", "Default", "PropertyChanged", "Explicit", "LostFocus"];
  for (const [id, ext] of [[451, "StaticResource"], [452, "TemplateBinding"]]) {
    for (const arg of ["Mode", "UpdateSourceTrigger"]) {
      const leaked = await completeWith(id, pageCls(`<TextBlock Text="{${ext} ${arg}=|}" />`), `${ext}-${arg}-leak`);
      const bad = leaked.filter((l) => enumLeak.includes(l));
      if (bad.length) fail(`{${ext} ${arg}=} must not leak binding enum values (got ${JSON.stringify(bad)})`);
    }
  }
  console.log(`[ok] x:Bind enum fallback is gated to bind extensions: StaticResource/TemplateBinding Mode=/UpdateSourceTrigger= leak no binding enums (round 65)`);

  // 453-456) XML-doc <summary> hover enrichment (round 66): symbol-based hovers now append the member's
  //          <summary> as quick-info (VS parity) for BOTH framework reference assemblies AND the user's own
  //          source. summaryOf() isolates the text AFTER the closing ``` fence, so each assertion proves the
  //          SUMMARY (not the signature) is present.
  const summaryOf = (v) => (v.split("```")[2] || "").trim();

  // 453) Framework element TYPE: Button's <summary> appears below the class signature.
  const docElem = await hoverAt(453, `<Page ${NS}>\n  <But|ton />\n</Page>`, "doc-element");
  if (!docElem.includes("class")) fail(`doc-element hover missing signature: ${docElem}`);
  if (!summaryOf(docElem).toLowerCase().includes("button")) fail(`doc-element hover missing framework <summary>: ${docElem}`);

  // 454) Framework PROPERTY: ContentControl.Content "Gets or sets ..." summary.
  const docAttr = await hoverAt(454, `<Page ${NS}>\n  <Button Con|tent="x" />\n</Page>`, "doc-attribute");
  if (!summaryOf(docAttr).toLowerCase().includes("gets or sets")) fail(`doc-attribute hover missing 'Gets or sets' <summary>: ${docAttr}`);

  // 455) USER SOURCE member: SmokePage.GreetingText carries the fixture's own <summary>, with the inline
  //      <see cref="IGreetingService"/> simplified to the bare type name.
  const docUser = await hoverAt(455, pageCls('<TextBlock Text="{x:Bind Greet|ingText}" />'), "doc-user-member");
  if (!docUser.includes("GreetingText")) fail(`doc-user hover missing signature: ${docUser}`);
  if (!summaryOf(docUser).includes("Greeting sourced from the DI singleton IGreetingService"))
    fail(`doc-user hover missing user <summary> with simplified see-cref: ${docUser}`);

  // 456) ATTACHED PROPERTY: the Grid.Row getter's <summary> ("Gets the value of the Grid.Row ...").
  const docAttached = await hoverAt(456, `<Page ${NS}>\n  <Grid>\n    <Button Grid.Ro|w="0" />\n  </Grid>\n</Page>`, "doc-attached");
  if (!docAttached.includes("(attached property)")) fail(`doc-attached hover missing signature: ${docAttached}`);
  if (!summaryOf(docAttached).toLowerCase().includes("gets the value")) fail(`doc-attached hover missing getter <summary>: ${docAttached}`);

  console.log(`[ok] hover doc-summary enrichment: framework type/property + user member (see-cref simplified) + attached-property getter carry <summary> quick-info (round 66)`);

  // 457-458) Authoring-markup sanitization (round 66 hardening): real framework summaries embed DocFX moniker
  //          zones, alert blockquotes, and escaped HTML (<img>/<sup>/<br>) as text. The hover must strip these
  //          to clean prose — never a broken <img> or a wall of ":::"/">"/"[!NOTE]" noise.
  const docExpander = await hoverAt(457, `<Page ${NS}>\n  <Expan|der />\n</Page>`, "doc-sanitize-moniker");
  {
    const s = summaryOf(docExpander);
    if (s.length === 0) fail(`Expander hover should carry a <summary>: ${docExpander}`);
    for (const bad of [":::", "moniker", "[!", "<img", "<sup", "<br", ">"]) {
      if (s.includes(bad)) fail(`Expander summary must be sanitized of '${bad}': ${JSON.stringify(s)}`);
    }
    if (!/displays a header/i.test(s)) fail(`Expander summary should surface the real prose: ${JSON.stringify(s)}`);
  }
  const docXyFocus = await hoverAt(458, `<Page ${NS}>\n  <Button XYFocusDownNavigationStrategy="Rectili|nearDistance" />\n</Page>`, "doc-sanitize-img");
  {
    const s = summaryOf(docXyFocus);
    if (s.length === 0) fail(`XYFocus enum-value hover should carry a <summary>: ${docXyFocus}`);
    for (const bad of ["<img", "src=", "<", ">"]) {
      if (s.includes(bad)) fail(`XYFocus RectilinearDistance summary must strip escaped HTML '${bad}': ${JSON.stringify(s)}`);
    }
    if (!/rectilinear|closest element/i.test(s)) fail(`XYFocus summary should surface the real prose: ${JSON.stringify(s)}`);
  }
  console.log(`[ok] hover doc-summary sanitization: Expander strips DocFX ::: moniker/[!CAUTION]; XYFocus.RectilinearDistance strips escaped <img> -> clean prose (round 66)`);

  // 459-463) Completion-item documentation (round 67): completion items now carry the member's XML-doc
  //          <summary> as their Documentation flyout (VS parity — the details pane beside the popup), reusing
  //          the round-66 XmlDocSummary engine. Unlike hover, CompletionDoc emits the summary PROSE ONLY (no
  //          signature fence), since VS renders Detail as the header and Documentation as the body. docOf()
  //          reads the MarkupContent value for a given label.
  const docOf = (items, lbl) => items.find((i) => i.label === lbl)?.documentation?.value ?? "";

  // 459) Framework element TYPE: <Button completion carries Button's <summary>.
  const cdElem = await completeItemsWith(459, `<Page ${NS}>\n  <But|\n</Page>`, "compdoc-element");
  {
    const d = docOf(cdElem, "Button");
    if (d.length === 0) fail(`Button completion item should carry documentation: ${JSON.stringify(cdElem.find((i) => i.label === "Button"))}`);
    if (!d.toLowerCase().includes("button")) fail(`Button completion documentation missing framework <summary>: ${JSON.stringify(d)}`);
  }

  // 460) Framework PROPERTY: the Content attribute-name item carries "Gets or sets ..." — proving the
  //      XamlMemberInfo.Symbol path documents attribute completion, not just element completion.
  const cdAttr = await completeItemsWith(460, `<Page ${NS}>\n  <Button |\n</Page>`, "compdoc-attribute");
  if (!docOf(cdAttr, "Content").toLowerCase().includes("gets or sets"))
    fail(`Content completion documentation missing 'Gets or sets' <summary>: ${JSON.stringify(docOf(cdAttr, "Content"))}`);

  // 461) Framework ENUM value: Visibility.Collapsed completion carries the field's <summary> (high value —
  //      framework enum members are well-documented) and the round-66 sanitizer runs on completion docs too.
  const cdEnum = await completeItemsWith(461, `<Page ${NS}>\n  <Button Visibility="|" />\n</Page>`, "compdoc-enum");
  {
    const d = docOf(cdEnum, "Collapsed");
    if (d.length === 0) fail(`Visibility.Collapsed completion item should carry documentation: ${JSON.stringify(cdEnum.find((i) => i.label === "Collapsed"))}`);
    if (!d.toLowerCase().includes("display")) fail(`Collapsed completion documentation missing enum <summary>: ${JSON.stringify(d)}`);
    for (const bad of [":::", "<img", "[!"]) if (d.includes(bad)) fail(`Collapsed completion documentation must be sanitized of '${bad}': ${JSON.stringify(d)}`);
  }

  // 462) USER SOURCE member: {x:Bind Gree|} completes GreetingText with the fixture's OWN <summary>, with the
  //      inline <see cref="IGreetingService"/> simplified — proving source symbols document completion.
  const cdUser = await completeItemsWith(462, pageCls('<TextBlock Text="{x:Bind Gree|}" />'), "compdoc-user");
  if (!docOf(cdUser, "GreetingText").includes("Greeting sourced from the DI singleton IGreetingService"))
    fail(`GreetingText completion documentation missing user <summary> with simplified see-cref: ${JSON.stringify(docOf(cdUser, "GreetingText"))}`);

  // 463) ATTACHED PROPERTY: <Button Grid.| completes Grid.Row with the getter's <summary> ("Gets the value ...").
  const cdAttached = await completeItemsWith(463, `<Page ${NS}>\n  <Grid>\n    <Button Grid.|\n  </Grid>\n</Page>`, "compdoc-attached");
  if (!docOf(cdAttached, "Grid.Row").toLowerCase().includes("gets the value"))
    fail(`Grid.Row completion documentation missing attached getter <summary>: ${JSON.stringify(docOf(cdAttached, "Grid.Row"))}`);

  console.log(`[ok] completion documentation: framework element/property/enum + user member (see-cref simplified) + attached-property completion items carry <summary> quick-info, sanitized (round 67)`);

  // 464-466) x:Bind markup-extension argument-NAME documentation (round 68): the curated {x:Bind} arg-name
  //          list (Mode/Converter/.../UpdateSourceTrigger + BindBack) previously carried NO documentation,
  //          while the classic {Binding} arg names ARE documented (round 67, via reflected symbols). Round 68
  //          resolves each curated name to its Microsoft.UI.Xaml.Data.Binding property symbol and reuses
  //          CompletionDoc, so x:Bind arg names read IDENTICALLY to classic Binding; BindBack (x:Bind-only,
  //          no Binding property) gets a small curated doc.

  // 464) x:Bind arg names now carry docs: Mode/Converter borrow Binding's "Gets or sets ..." <summary>;
  //      BindBack carries the curated x:Bind-only doc.
  const xbArg = await completeItemsWith(464, pageCls('<TextBlock Text="{x:Bind GreetingText, |}" />'), "xbind-argname-doc");
  {
    const dMode = docOf(xbArg, "Mode");
    if (!dMode.toLowerCase().includes("gets or sets")) fail(`x:Bind Mode arg-name should carry Binding.Mode <summary>: ${JSON.stringify(dMode)}`);
    const dConv = docOf(xbArg, "Converter");
    if (!dConv.toLowerCase().includes("gets or sets")) fail(`x:Bind Converter arg-name should carry Binding.Converter <summary>: ${JSON.stringify(dConv)}`);
    const dBB = docOf(xbArg, "BindBack");
    if (dBB.length === 0 || !dBB.toLowerCase().includes("back")) fail(`x:Bind BindBack arg-name should carry the curated TwoWay-write-back doc: ${JSON.stringify(dBB)}`);
    for (const bad of [":::", "<img", "[!", "```"]) if (dMode.includes(bad)) fail(`x:Bind Mode doc must be sanitized of '${bad}': ${JSON.stringify(dMode)}`);
  }

  // 465) CONSISTENCY (the headline): the x:Bind Mode doc is BYTE-IDENTICAL to the classic Binding Mode doc,
  //      since both resolve the SAME Binding.Mode symbol. Classic arg-name completion fires after a comma.
  const bnArg = await completeItemsWith(465, pageCls('<TextBlock Text="{Binding Path=GreetingText, |}" />'), "binding-argname-doc");
  {
    const dX = docOf(xbArg, "Mode");
    const dB = docOf(bnArg, "Mode");
    if (dB.length === 0) fail(`classic Binding Mode arg-name should carry documentation (round 67): ${JSON.stringify(bnArg.map((i) => i.label))}`);
    if (dX !== dB) fail(`x:Bind Mode doc must equal classic Binding Mode doc (consistency):\n  x:Bind=${JSON.stringify(dX)}\n  Binding=${JSON.stringify(dB)}`);
  }

  // 466) BindBack is x:Bind-ONLY: it appears in the x:Bind curated list (with a doc) but classic {Binding}
  //      has no BindBack property, so it is NOT offered there at all — proving the curated fallback is scoped.
  {
    if (!xbArg.some((i) => i.label === "BindBack")) fail(`x:Bind arg names must include BindBack`);
    if (bnArg.some((i) => i.label === "BindBack")) fail(`classic Binding must NOT offer BindBack (x:Bind-only): ${JSON.stringify(bnArg.map((i) => i.label))}`);
  }

  console.log(`[ok] x:Bind arg-name documentation: curated {x:Bind} arg names carry Binding.<Property> <summary> (Mode/Converter), BindBack curated doc, x:Bind Mode doc === classic Binding Mode doc (consistency), BindBack x:Bind-only (round 68)`);

  // 467-468) x:Bind argument-name Detail-line parity (round 69): the curated {x:Bind} arg names now ALSO
  //          carry the same Detail (the dimmed "property : Type" type-hint header) that the classic {Binding}
  //          arg name shows — off the SAME resolved Binding member — so BOTH the popup header (Detail) and
  //          body (Documentation) reach parity. BindBack (x:Bind-only) gets a small curated "method" detail.
  const detailOf = (items, lbl) => items.find((i) => i.label === lbl)?.detail ?? "";

  // 467) Mode/Converter Detail is non-empty AND byte-identical to the classic Binding arg Detail (parity),
  //      while the round-68 documentation stays intact (no regression).
  {
    const dxMode = detailOf(xbArg, "Mode");
    const dbMode = detailOf(bnArg, "Mode");
    if (dbMode.length === 0) fail(`classic Binding Mode arg should carry a Detail: ${JSON.stringify(bnArg.find((i) => i.label === "Mode"))}`);
    if (dxMode !== dbMode) fail(`x:Bind Mode Detail must equal classic Binding Mode Detail:\n  x:Bind=${JSON.stringify(dxMode)}\n  Binding=${JSON.stringify(dbMode)}`);
    if (!/property\s*:/i.test(dxMode)) fail(`x:Bind Mode Detail should read 'property : <Type>': ${JSON.stringify(dxMode)}`);
    const dxConv = detailOf(xbArg, "Converter");
    if (dxConv !== detailOf(bnArg, "Converter")) fail(`x:Bind Converter Detail must equal classic Binding Converter Detail: x=${JSON.stringify(dxConv)} b=${JSON.stringify(detailOf(bnArg, "Converter"))}`);
    if (docOf(xbArg, "Mode").length === 0) fail(`round-68 documentation must remain after adding Detail (Mode)`);
  }

  // 468) BindBack carries the curated x:Bind-only Detail (no Binding property to borrow) and still its doc.
  {
    const dBB = detailOf(xbArg, "BindBack");
    if (dBB !== "method") fail(`x:Bind BindBack Detail should be the curated 'method': ${JSON.stringify(dBB)}`);
    if (docOf(xbArg, "BindBack").length === 0) fail(`BindBack documentation must remain after adding Detail`);
  }

  console.log(`[ok] x:Bind arg-name Detail parity: curated {x:Bind} arg Detail === classic Binding arg Detail ('property : Type', Mode/Converter), BindBack curated 'method' detail, round-68 docs intact (round 69)`);

  // 469-472) Method hover <returns>/<param> enrichment (round 70): a hover on a METHOD symbol now appends the
  //          member's <returns> and documented <param>s below the summary (VS quick-info parity), reusing the
  //          round-66 XmlDocSummary engine (new ExtractQuickInfo). Gated to IMethodSymbol so properties/fields/
  //          types/enums stay summary-only, and attached-property getters (presented AS a property) pass
  //          methodDetails:false so they are NOT enriched. Proven end-to-end on the REAL SDK.

  // 469) Framework page-inherited method {x:Bind FindName}: signature + summary + Returns + Parameters `name`.
  const mFindName = await hoverAt(469, pageCls('<TextBlock Text="{x:Bind Find|Name}" />'), "method-hover-findname");
  {
    if (!mFindName.includes("object FrameworkElement.FindName(string name)")) fail(`FindName hover missing signature: ${JSON.stringify(mFindName)}`);
    if (!mFindName.includes("**Returns:**")) fail(`FindName hover should carry a Returns section: ${JSON.stringify(mFindName)}`);
    if (!mFindName.includes("**Parameters:**")) fail(`FindName hover should carry a Parameters section: ${JSON.stringify(mFindName)}`);
    if (!mFindName.includes("`name`")) fail(`FindName hover should document the 'name' param: ${JSON.stringify(mFindName)}`);
  }

  // 470) Framework MEMBER method via a string segment {x:Bind GreetingText.Substring}: enriched too.
  const mSubstring = await hoverAt(470, pageCls('<TextBlock Text="{x:Bind GreetingText.Subs|tring}" />'), "method-hover-substring");
  {
    if (!mSubstring.includes("string string.Substring(int startIndex)")) fail(`Substring hover missing signature: ${JSON.stringify(mSubstring)}`);
    if (!mSubstring.includes("**Returns:**")) fail(`Substring hover should carry a Returns section: ${JSON.stringify(mSubstring)}`);
    if (!mSubstring.includes("`startIndex`")) fail(`Substring hover should document the 'startIndex' param: ${JSON.stringify(mSubstring)}`);
  }

  // 471) NEGATIVE — an undocumented USER method (function binding) stays signature-only, byte-identical to the
  //      pre-round-70 behavior (no phantom empty Returns/Parameters sections).
  const mUserFn = await hoverAt(471, pageCls('<TextBlock Text="{x:Bind OnGo_C|lick()}" />'), "method-hover-user-nodoc");
  {
    const expected = "```csharp\nvoid SmokePage.OnGo_Click(object sender, RoutedEventArgs e)\n```";
    if (mUserFn !== expected) fail(`Undocumented user method hover must be signature-only: ${JSON.stringify(mUserFn)}`);
  }

  // 472) NEGATIVE — an attached-property hover is presented AS a property (methodDetails:false), so even though
  //      its resolved symbol is the getter METHOD, it is NOT enriched with the getter's Returns/Parameters.
  const mAttached = await hoverAt(472, pageCls('<Grid>\n    <Button Grid.R|ow="1" />\n  </Grid>'), "method-hover-attached-noenrich");
  {
    if (!mAttached.includes("(attached property)")) fail(`Grid.Row hover should identify the attached property: ${JSON.stringify(mAttached)}`);
    if (mAttached.includes("**Returns:**") || mAttached.includes("**Parameters:**")) fail(`attached-property hover must NOT carry method Returns/Parameters: ${JSON.stringify(mAttached)}`);
  }

  console.log(`[ok] method hover enrichment: {x:Bind FindName}/GreetingText.Substring show Returns + Parameters; undocumented OnGo_Click stays signature-only; attached Grid.Row not enriched (round 70)`);

  // 473-476) GridLength value completion (round 71): a GridLength-typed attribute value (RowDefinition.Height,
  //          ColumnDefinition.Width) now offers the two keyword sizings VS/Blend surface — Auto and * — while
  //          a 'double' Width/Height (FrameworkElement) correctly offers neither. Curated + benign-empty.
  const gridLenOf = (items) => items.filter((i) => (i.detail ?? "").startsWith("GridLength")).map((i) => i.label).sort();

  // 473) RowDefinition.Height empty -> exactly [*, Auto] with the GridLength detail + whole-token newText.
  const glRow = await completeItemsWith(473, pageCls('<Grid>\n    <Grid.RowDefinitions>\n      <RowDefinition Height="|" />\n    </Grid.RowDefinitions>\n  </Grid>'), "gridlength-row");
  {
    const labels = gridLenOf(glRow);
    if (labels.join(",") !== "*,Auto") fail(`RowDefinition.Height should offer Auto and *: ${JSON.stringify(glRow.map((i) => i.label))}`);
    const auto = glRow.find((i) => i.label === "Auto");
    if (auto?.textEdit?.newText !== "Auto") fail(`Auto item should carry a whole-token TextEdit: ${JSON.stringify(auto)}`);
    // RAW-WIRE lock: the server sets FilterText = SortText = the token so client-side filtering matches the label.
    // (VS Code's executeCompletionItemProvider omits these when they equal the label, so the harness cannot see
    // them — this stdio smoke is the authoritative layer for the wire contract; see redteam71 assertExactGridShapes.)
    if (auto?.filterText !== "Auto" || auto?.sortText !== "Auto") fail(`Auto item should carry filterText/sortText = token on the wire: ${JSON.stringify(auto)}`);
    const star = glRow.find((i) => i.label === "*");
    if (star?.filterText !== "*" || star?.sortText !== "*") fail(`* item should carry filterText/sortText = token on the wire: ${JSON.stringify(star)}`);
    if (glRow.some((i) => i.label === "True" || i.label === "False")) fail(`GridLength value must not offer booleans: ${JSON.stringify(glRow.map((i) => i.label))}`);
  }

  // 474) RowDefinition.Height partial 'A' -> Auto only (prefix filter), no *.
  const glPartial = await completeItemsWith(474, pageCls('<Grid>\n    <Grid.RowDefinitions>\n      <RowDefinition Height="A|" />\n    </Grid.RowDefinitions>\n  </Grid>'), "gridlength-partial");
  {
    const labels = gridLenOf(glPartial);
    if (labels.join(",") !== "Auto") fail(`partial 'A' should offer only Auto: ${JSON.stringify(glPartial.map((i) => i.label))}`);
  }

  // 475) ColumnDefinition.Width empty -> Auto and * too (GridLength on the column axis).
  const glCol = await completeItemsWith(475, pageCls('<Grid>\n    <Grid.ColumnDefinitions>\n      <ColumnDefinition Width="|" />\n    </Grid.ColumnDefinitions>\n  </Grid>'), "gridlength-col");
  {
    if (gridLenOf(glCol).join(",") !== "*,Auto") fail(`ColumnDefinition.Width should offer Auto and *: ${JSON.stringify(glCol.map((i) => i.label))}`);
  }

  // 476) NEGATIVE — FrameworkElement.Width is 'double', NOT GridLength, so no Auto/* is offered.
  const glDouble = await completeItemsWith(476, pageCls('<Button Width="|" />'), "gridlength-double-negative");
  {
    if (gridLenOf(glDouble).length !== 0) fail(`a double Width must NOT offer GridLength keywords: ${JSON.stringify(glDouble.map((i) => i.label))}`);
  }

  console.log(`[ok] GridLength value completion: RowDefinition.Height / ColumnDefinition.Width offer Auto + * (prefix-filtered); double FrameworkElement.Width offers neither (round 71)`);

  // 477-481) Named-color value completion (round 72): a Brush/Color-typed attribute value now completes the
  //          WinUI named colors (Microsoft.UI.Colors — Red, CornflowerBlue, …, Transparent) with a Color-kind
  //          item + hex Detail (swatch), while a non-Brush/Color value (double/enum/string) offers none.
  const colorItems = (items) => items.filter((i) => i.kind === 16); // CompletionItemKind.Color
  const colorLabels = (items) => colorItems(items).map((i) => i.label);

  // 477) Foreground (Brush) empty -> the full named-color set incl. CornflowerBlue/Red/Transparent, Color-kind,
  //      whole-token TextEdit, hex Detail (swatch) + raw-wire filterText/sortText = token.
  const clrFg = await completeItemsWith(477, pageCls('<TextBlock Foreground="|" />'), "namedcolor-foreground");
  {
    const labels = colorLabels(clrFg);
    if (labels.length < 100) fail(`Foreground should offer the full named-color set (got ${labels.length})`);
    for (const want of ["Red", "CornflowerBlue", "Transparent", "AliceBlue", "YellowGreen"]) {
      if (!labels.includes(want)) fail(`Foreground named colors missing ${want}: ${labels.length} items`);
    }
    const cfb = clrFg.find((i) => i.label === "CornflowerBlue");
    if (cfb?.textEdit?.newText !== "CornflowerBlue") fail(`CornflowerBlue should carry a whole-token TextEdit: ${JSON.stringify(cfb)}`);
    if (cfb?.detail !== "#6495ED") fail(`CornflowerBlue detail should be its hex swatch #6495ED: ${JSON.stringify(cfb?.detail)}`);
    if (cfb?.filterText !== "CornflowerBlue" || cfb?.sortText !== "CornflowerBlue") fail(`CornflowerBlue should carry filterText/sortText = token on the wire: ${JSON.stringify(cfb)}`);
    const tr = clrFg.find((i) => i.label === "Transparent");
    if (tr?.detail !== "#FFFFFF00") fail(`Transparent detail should be CSS alpha-last #FFFFFF00: ${JSON.stringify(tr?.detail)}`);
    if (clrFg.some((i) => i.label === "True" || i.label === "False")) fail(`a Brush value must not offer booleans`);
  }

  // 478) Foreground partial 'Corn' -> only Cornflower* / Cornsilk (prefix filter, OrdinalIgnoreCase).
  const clrPartial = await completeItemsWith(478, pageCls('<TextBlock Foreground="Corn|" />'), "namedcolor-partial");
  {
    const labels = colorLabels(clrPartial).sort();
    if (labels.join(",") !== "CornflowerBlue,Cornsilk") fail(`partial 'Corn' should offer CornflowerBlue + Cornsilk only: ${JSON.stringify(labels)}`);
  }

  // 479) Background (also a Brush) -> named colors too.
  const clrBg = await completeItemsWith(479, pageCls('<Grid Background="|" />'), "namedcolor-background");
  {
    if (!colorLabels(clrBg).includes("Red")) fail(`Background (Brush) should offer named colors incl. Red`);
  }

  // 480) SolidColorBrush.Color (a Windows.UI.Color value, not a Brush) -> named colors via IsColor.
  const clrColorProp = await completeItemsWith(480, pageCls('<Grid>\n    <Grid.Background>\n      <SolidColorBrush Color="|" />\n    </Grid.Background>\n  </Grid>'), "namedcolor-color-prop");
  {
    if (!colorLabels(clrColorProp).includes("CornflowerBlue")) fail(`SolidColorBrush.Color (Windows.UI.Color) should offer named colors incl. CornflowerBlue`);
  }

  // 481) NEGATIVE — a double (Width) and an enum (Visibility) must NOT offer named colors.
  const clrDouble = await completeItemsWith(481, pageCls('<Button Width="|" />'), "namedcolor-double-negative");
  {
    if (colorItems(clrDouble).length !== 0) fail(`a double Width must NOT offer named colors: ${JSON.stringify(colorLabels(clrDouble))}`);
    const clrEnum = await completeWith(482, pageCls('<Button Visibility="|" />'), "namedcolor-enum-negative");
    if (clrEnum.includes("Red") || clrEnum.includes("CornflowerBlue")) fail(`an enum Visibility must NOT leak named colors: ${JSON.stringify(clrEnum)}`);
  }

  console.log(`[ok] Named-color value completion: Brush (Foreground/Background) + Color (SolidColorBrush.Color) offer the WinUI named colors with hex swatches (prefix-filtered); double/enum offer none (round 72)`);

  // 483-484) Mid-token accept replaces the WHOLE value token (round 72 fix): with the caret inside an existing
  //          value ("Corn|silk"), the item's TextEdit range must span the whole token so applying it yields a
  //          clean value, never a duplicated suffix ("Cornsilksilk"). The same fix covers the GridLength sibling.
  const applyEdit = (text, range, newText) => {
    const toOffset = (pos) => {
      const lines = text.split("\n");
      let off = 0;
      for (let l = 0; l < pos.line; l++) off += lines[l].length + 1;
      return off + pos.character;
    };
    return text.slice(0, toOffset(range.start)) + newText + text.slice(toOffset(range.end));
  };

  // 483) Foreground="Corn|silk" accepting Cornsilk -> Foreground="Cornsilk" (no dangling 'silk').
  {
    const body = pageCls('<TextBlock Foreground="Corn|silk" Tag="tail" />');
    const items = await completeItemsWith(483, body, "namedcolor-midtoken");
    const text = body.replace("|", "");
    const cs = items.find((i) => i.label === "Cornsilk" && i.kind === 16);
    if (!cs?.textEdit) fail(`mid-token Cornsilk should carry a TextEdit: ${JSON.stringify(cs)}`);
    const applied = applyEdit(text, cs.textEdit.range, cs.textEdit.newText);
    if (!applied.includes('Foreground="Cornsilk" Tag="tail"')) fail(`mid-token accept must replace the whole token: ${JSON.stringify(applied.match(/Foreground="[^"]*"/)?.[0])}`);
    if (applied.includes("Cornsilksilk")) fail(`mid-token accept duplicated the suffix (Cornsilksilk)`);
  }

  // 484) GridLength Height="A|uto" accepting Auto -> Height="Auto" (sibling scalar fix, same whole-token range).
  {
    const body = pageCls('<Grid>\n    <Grid.RowDefinitions>\n      <RowDefinition Height="A|uto" />\n    </Grid.RowDefinitions>\n  </Grid>');
    const items = await completeItemsWith(484, body, "gridlength-midtoken");
    const text = body.replace("|", "");
    const au = items.find((i) => i.label === "Auto" && (i.detail ?? "").startsWith("GridLength"));
    if (!au?.textEdit) fail(`mid-token Auto should carry a TextEdit: ${JSON.stringify(au)}`);
    const applied = applyEdit(text, au.textEdit.range, au.textEdit.newText);
    if (!applied.includes('Height="Auto"')) fail(`mid-token GridLength accept must replace the whole token: ${JSON.stringify(applied.match(/Height="[^"]*"/)?.[0])}`);
    if (applied.includes("Autouto")) fail(`mid-token GridLength accept duplicated the suffix (Autouto)`);
  }

  console.log(`[ok] Mid-token value accept replaces the whole token (no duplicated suffix) for named colors + GridLength (round 72 fix)`);

  // 485-489) FontWeight named-value completion (round 73): a FontWeight-typed attribute value
  //          (Control/TextBlock.FontWeight, typed Windows.UI.Text.FontWeight) now completes the named weights
  //          (Microsoft.UI.Text.FontWeights — Thin, Light, Normal, SemiBold, Bold, …, ExtraBlack) as
  //          Value-kind items whose Detail is the numeric weight (Bold => 700). Numeric literals stay free-form.
  const fwItems = (items) => items.filter((i) => /^\d{2,3}$/.test(i.detail ?? "")); // weight-number Detail (100..950)
  const fwLabels = (items) => fwItems(items).map((i) => i.label);

  // 485) FontWeight empty -> the full 11-name set with weight-number Detail, Value-kind, whole-token TextEdit.
  const fw = await completeItemsWith(485, pageCls('<TextBlock FontWeight="|" />'), "fontweight-empty");
  {
    const labels = fwLabels(fw).sort();
    const want = ["Black", "Bold", "ExtraBlack", "ExtraBold", "ExtraLight", "Light", "Medium", "Normal", "SemiBold", "SemiLight", "Thin"];
    if (labels.join(",") !== want.join(",")) fail(`FontWeight empty should offer exactly the 11 named weights: ${JSON.stringify(labels)}`);
    const bold = fw.find((i) => i.label === "Bold");
    if (bold?.kind !== 12) fail(`Bold should be a Value-kind item: ${JSON.stringify(bold)}`);
    if (bold?.detail !== "700") fail(`Bold detail should be its weight number 700: ${JSON.stringify(bold?.detail)}`);
    if (bold?.textEdit?.newText !== "Bold") fail(`Bold should carry a whole-token TextEdit: ${JSON.stringify(bold)}`);
    const sl = fw.find((i) => i.label === "SemiLight");
    if (sl?.detail !== "350") fail(`SemiLight detail should be 350: ${JSON.stringify(sl?.detail)}`);
    const eb = fw.find((i) => i.label === "ExtraBlack");
    if (eb?.detail !== "950") fail(`ExtraBlack detail should be 950: ${JSON.stringify(eb?.detail)}`);
    if (fw.some((i) => i.label === "True" || i.label === "False")) fail(`a FontWeight value must not offer booleans`);
  }

  // 486) FontWeight partial 'Ex' -> only ExtraLight / ExtraBold / ExtraBlack (prefix filter, OrdinalIgnoreCase).
  const fwPartial = await completeItemsWith(486, pageCls('<TextBlock FontWeight="Ex|" />'), "fontweight-partial");
  {
    const labels = fwLabels(fwPartial).sort();
    if (labels.join(",") !== "ExtraBlack,ExtraBold,ExtraLight") fail(`partial 'Ex' should offer the three Extra* weights only: ${JSON.stringify(labels)}`);
  }

  // 487) FontWeight on a Control base type (Button) also completes (FontWeight is a Control property).
  const fwBtn = await completeItemsWith(487, pageCls('<Button FontWeight="|" />'), "fontweight-control");
  {
    if (!fwLabels(fwBtn).includes("SemiBold")) fail(`Button.FontWeight should offer named weights incl. SemiBold`);
  }

  // 488) NEGATIVE — a double (Width) and an enum (Visibility) must NOT offer named weights.
  {
    const fwDouble = await completeItemsWith(488, pageCls('<Button Width="|" />'), "fontweight-double-negative");
    if (fwItems(fwDouble).length !== 0) fail(`a double Width must NOT offer named weights: ${JSON.stringify(fwLabels(fwDouble))}`);
    const fwEnum = await completeWith(489, pageCls('<Button Visibility="|" />'), "fontweight-enum-negative");
    if (fwEnum.includes("Bold") || fwEnum.includes("SemiBold")) fail(`an enum Visibility must NOT leak named weights: ${JSON.stringify(fwEnum)}`);
  }

  console.log(`[ok] FontWeight value completion: Control/TextBlock.FontWeight offers the WinUI named weights with weight-number details (prefix-filtered); double/enum offer none (round 73)`);

  // 490-492) Setter.Value scalar completion generalized (round 73 fix): the <Setter Value="|"> path now
  //          shares the SAME scalar dispatch as ordinary attribute values, so a Style setter completes a
  //          FontWeight/Brush property identically to setting it directly (VS parity) — previously only
  //          enum/bool completed there. Typed by the sibling Property= against the enclosing TargetType.
  // 490) <Setter Property="FontWeight" Value="|"> -> named weights (the round-73 deliverable in a Style).
  const svFw = await completeItemsWith(490, pageRes('<Style TargetType="Button">\n      <Setter Property="FontWeight" Value="|" />\n    </Style>'), "setterval-fontweight");
  {
    const labels = fwLabels(svFw).sort();
    if (!labels.includes("Bold") || !labels.includes("SemiBold")) fail(`Setter.Value FontWeight should offer named weights incl. Bold/SemiBold: ${JSON.stringify(labels)}`);
    const bold = svFw.find((i) => i.label === "Bold" && /^\d{2,3}$/.test(i.detail ?? ""));
    if (bold?.detail !== "700") fail(`Setter.Value Bold detail should be 700: ${JSON.stringify(bold?.detail)}`);
  }

  // 491) <Setter Property="Foreground" Value="|"> -> named colors (proves the shared dispatch generalized
  //      round-72 to Setter.Value too, not just FontWeight).
  const svClr = await completeItemsWith(491, pageRes('<Style TargetType="Button">\n      <Setter Property="Foreground" Value="|" />\n    </Style>'), "setterval-foreground");
  {
    if (!colorLabels(svClr).includes("CornflowerBlue")) fail(`Setter.Value Foreground (Brush) should offer named colors incl. CornflowerBlue: ${JSON.stringify(colorLabels(svClr))}`);
  }

  // 492) NEGATIVE — a double-typed setter value (Opacity) must offer neither weights nor colors.
  const svDbl = await completeItemsWith(492, pageRes('<Style TargetType="Button">\n      <Setter Property="Opacity" Value="|" />\n    </Style>'), "setterval-double-negative");
  {
    if (fwItems(svDbl).length !== 0 || colorItems(svDbl).length !== 0) fail(`a double Setter.Value (Opacity) must offer no weights/colors: ${JSON.stringify(svDbl.map((i) => i.label))}`);
  }

  console.log(`[ok] Setter.Value scalar completion generalized: <Setter Property="FontWeight"/Foreground" Value="|"> offers named weights/colors like a direct attribute (double offers none) (round 73 fix)`);

  // 493-494) USER GAP #1 (context-aware element types): element completion is narrowed to the nearest
  //          enclosing element's content type, so a panel child only offers UIElement-assignable types —
  //          NOT VisualStateManager / EventArgs / intrinsics (the noise the user reported). An object-typed
  //          content position (ContentControl.Content = object) stays permissive (VS parity).
  // 493) A <Grid> child offers Button (a UIElement) but NOT VisualStateManager (a DependencyObject, not a
  //      UIElement) and NOT RoutedEventArgs (derives from object) — the headline fix for gap #1.
  {
    const gridChild = await completeWith(493, pageCls('<Grid>\n    <|\n  </Grid>'), "ctx-types-grid-child");
    if (!gridChild.includes("Button")) fail(`a <Grid> child should still offer Button (UIElement): ${JSON.stringify(gridChild.slice(0, 30))}`);
    if (gridChild.includes("VisualStateManager")) fail(`a <Grid> child must NOT offer VisualStateManager (not a UIElement): ${JSON.stringify(gridChild.filter((l) => /Manager|EventArgs/.test(l)))}`);
    if (gridChild.includes("RoutedEventArgs")) fail(`a <Grid> child must NOT offer RoutedEventArgs: ${JSON.stringify(gridChild.filter((l) => /EventArgs/.test(l)))}`);
  }
  // 494) An object-typed content position (a ContentControl's Content) stays permissive — VisualStateManager
  //      is still offered, proving the narrowing does not over-fire.
  {
    const objChild = await completeWith(494, pageCls('<Button>\n    <|\n  </Button>'), "ctx-types-object-content");
    if (!objChild.includes("Button")) fail(`object-content child should offer Button: ${JSON.stringify(objChild.slice(0, 20))}`);
    if (!objChild.includes("VisualStateManager")) fail(`object-content (Button.Content = object) child should stay permissive and offer VisualStateManager: ${JSON.stringify(objChild.slice(0, 30))}`);
  }
  console.log(`[ok] context-aware element types (#1): a <Grid> child narrows to UIElement (Button yes; VisualStateManager/RoutedEventArgs no) while object-typed content stays permissive (round 84)`);

  // 495-497) USER GAP #2 (attribute-name value quoting): an attribute/event-handler name completion now
  //          inserts `Name="$0"` as a snippet (caret between the quotes) via InsertTextFormat=2 + a
  //          whole-token TextEdit — instead of the bare unquoted name. Skipped when the name is already
  //          followed by `=` (the value already exists). Asserted on the RAW LSP wire (textEdit + format).
  const attrItem = (items, label) => items.find((i) => i.label === label);
  // 495) an EVENT handler name (Click) inserts Click="$0".
  {
    const items = await completeItemsWith(495, pageCls('<Button Cli|>'), "attr-snippet-event");
    const it = attrItem(items, "Click");
    if (!it) fail(`<Button Cli| should offer the Click event: ${JSON.stringify(items.map((i) => i.label).slice(0, 20))}`);
    if (it.textEdit?.newText !== 'Click="$0"') fail(`Click completion should insert the snippet Click="$0": ${JSON.stringify(it.textEdit)}`);
    if (it.insertTextFormat !== 2) fail(`Click completion should be a snippet (InsertTextFormat=2): ${JSON.stringify(it.insertTextFormat)}`);
    if (it.label !== "Click" || it.filterText === 'Click="$0"') fail(`the Click label/filterText must stay the bare name: ${JSON.stringify({ label: it.label, filterText: it.filterText })}`);
  }
  // 496) a PROPERTY name (Content) inserts Content="$0" too.
  {
    const items = await completeItemsWith(496, pageCls('<Button Con|>'), "attr-snippet-prop");
    const it = attrItem(items, "Content");
    if (!it) fail(`<Button Con| should offer the Content property: ${JSON.stringify(items.map((i) => i.label).slice(0, 20))}`);
    if (it.textEdit?.newText !== 'Content="$0"') fail(`Content completion should insert Content="$0": ${JSON.stringify(it.textEdit)}`);
    if (it.insertTextFormat !== 2) fail(`Content completion should be a snippet (InsertTextFormat=2): ${JSON.stringify(it.insertTextFormat)}`);
  }
  // 497) NEGATIVE — when the name is ALREADY followed by `=`, the item stays BARE (no snippet, value exists).
  {
    const items = await completeItemsWith(497, pageCls('<Button Click|="OnGo_Click" />'), "attr-snippet-already-has-value");
    const it = attrItem(items, "Click");
    if (!it) fail(`<Button Click|="..." should still offer the Click event: ${JSON.stringify(items.map((i) => i.label).slice(0, 20))}`);
    const nt = it.textEdit?.newText ?? it.insertText;
    if (nt && nt.includes('="$0"')) fail(`Click already followed by '=' must NOT re-append a value snippet: ${JSON.stringify({ newText: it.textEdit?.newText, insertText: it.insertText })}`);
    if (it.insertTextFormat === 2) fail(`Click already followed by '=' must NOT be a snippet: ${JSON.stringify(it.insertTextFormat)}`);
  }
  console.log(`[ok] attribute value-snippet (#2): event/property name completion inserts Name="$0" (InsertTextFormat=2, bare label) and stays bare when a value already follows '=' (round 84)`);

  // 555) USER GAP #2 FOLLOW-ON (unquoted attribute-value quoting): when the user types the '=' THEMSELVES
  //       and completes a VALUE at an UNQUOTED position (Click=On|), the inserted value must be wrapped in
  //       quotes to be valid XAML (Click="OnGo_Click", not Click=OnGo_Click). This applies uniformly to
  //       every value type at an unquoted position; the whole value token is replaced (mid-token suffixes
  //       consumed). A value already inside quotes must NOT be re-quoted. Asserted on the RAW LSP wire.
  {
    // event handler at an unquoted position -> "OnGo_Click"
    const evItems = await completeItemsWith(555, pageCls("<Button Click=On|>"), "unquoted-quote-event");
    const ev = evItems.find((i) => i.label === "OnGo_Click");
    if (!ev) fail(`unquoted Click=On| should offer OnGo_Click: ${JSON.stringify(evItems.map((i) => i.label).slice(0, 20))}`);
    if (ev.textEdit?.newText !== '"OnGo_Click"') fail(`unquoted Click= must insert quoted text: ${JSON.stringify(ev.textEdit)}`);

    // enum member at an unquoted position -> "Collapsed"
    const enItems = await completeItemsWith(555, pageCls("<Button Visibility=Coll|>"), "unquoted-quote-enum");
    const en = enItems.find((i) => i.label === "Collapsed");
    if (!en) fail(`unquoted Visibility=Coll| should offer Collapsed: ${JSON.stringify(enItems.map((i) => i.label).slice(0, 20))}`);
    if (en.textEdit?.newText !== '"Collapsed"') fail(`unquoted enum value must be quoted: ${JSON.stringify(en.textEdit)}`);

    // bool at an unquoted position -> "True"
    const boItems = await completeItemsWith(555, pageCls("<Button IsEnabled=Tr|>"), "unquoted-quote-bool");
    const bo = boItems.find((i) => i.label === "True");
    if (!bo) fail(`unquoted IsEnabled=Tr| should offer True: ${JSON.stringify(boItems.map((i) => i.label).slice(0, 20))}`);
    if (bo.textEdit?.newText !== '"True"') fail(`unquoted bool value must be quoted: ${JSON.stringify(bo.textEdit)}`);

    // mid-token accept replaces the whole token (consumes the 'Xyz' suffix) -> "OnGo_Click", never with a suffix.
    const midItems = await completeItemsWith(555, pageCls("<Button Click=On|Xyz>"), "unquoted-quote-midtoken");
    const mid = midItems.find((i) => i.label === "OnGo_Click");
    if (!mid) fail(`mid-token Click=On|Xyz should offer OnGo_Click: ${JSON.stringify(midItems.map((i) => i.label).slice(0, 20))}`);
    if (mid.textEdit?.newText !== '"OnGo_Click"') fail(`mid-token accept must replace the whole token with quoted text: ${JSON.stringify(mid.textEdit)}`);

    // NEGATIVE — a value already inside quotes stays BARE (no double-quoting).
    const qItems = await completeItemsWith(555, pageCls('<Button Click="On|">'), "unquoted-quote-negative");
    const q = qItems.find((i) => i.label === "OnGo_Click");
    if (!q) fail(`quoted Click="On| should offer OnGo_Click: ${JSON.stringify(qItems.map((i) => i.label).slice(0, 20))}`);
    if (q.textEdit?.newText !== "OnGo_Click") fail(`a quoted value must NOT get extra quotes: ${JSON.stringify(q.textEdit)}`);
  }
  console.log(`[ok] unquoted value quoting (#2 follow-on): a value completed at an unquoted position (Click=On|) is wrapped in quotes (handler/enum/bool), the whole token is replaced, and a quoted value stays bare (round 85)`);

  // 547-550) GAP #4 (ux-thirdparty-xmlns): a referenced control library that registers no
  //          XmlnsDefinitionAttribute (the Windows Community Toolkit's SettingsControls, reachable ONLY
  //          via using:CommunityToolkit.WinUI.Controls) is offered in element completion; accepting one
  //          inserts a prefixed name AND auto-declares the xmlns on the root via additionalTextEdits.
  const pageToolkit = (inner) =>
    `<Page ${NS} xmlns:toolkit="using:CommunityToolkit.WinUI.Controls" x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
  const byNewText = (items, nt) => items.find((i) => i.textEdit?.newText === nt);
  // 547) <Sett| in a Grid offers controls:SettingsCard + controls:SettingsExpander, each injecting the xmlns.
  {
    const items = await completeItemsWith(547, pageCls("<Grid><Sett|</Grid>"), "thirdparty-offer");
    const card = byNewText(items, "controls:SettingsCard");
    if (!card) fail(`<Sett| should offer controls:SettingsCard: ${JSON.stringify(items.map((i) => i.textEdit?.newText).filter(Boolean).slice(0, 20))}`);
    if (!/CommunityToolkit\.WinUI\.Controls \(adds xmlns:controls\)/.test(card.detail || "")) fail(`detail should name the ns + injected xmlns: ${card.detail}`);
    const edits = card.additionalTextEdits;
    if (!Array.isArray(edits) || edits.length !== 1) fail(`SettingsCard should carry exactly one additionalTextEdit: ${JSON.stringify(edits)}`);
    if (edits[0].newText !== ' xmlns:controls="using:CommunityToolkit.WinUI.Controls"') fail(`the injected xmlns declaration is wrong: ${JSON.stringify(edits[0])}`);
    const r = edits[0].range;
    if (r.start.line !== r.end.line || r.start.character !== r.end.character) fail(`the xmlns injection must be a zero-width insertion: ${JSON.stringify(r)}`);
    const exp = byNewText(items, "controls:SettingsExpander");
    if (!exp) fail(`<Sett| should also offer controls:SettingsExpander`);
    if (exp.additionalTextEdits?.[0]?.newText !== ' xmlns:controls="using:CommunityToolkit.WinUI.Controls"') fail(`SettingsExpander should inject the same xmlns: ${JSON.stringify(exp.additionalTextEdits)}`);
  }
  // 548) partial filter — <SettingsC| matches SettingsCard, NOT SettingsExpander.
  {
    const items = await completeItemsWith(548, pageCls("<Grid><SettingsC|</Grid>"), "thirdparty-filter");
    const names = items.map((i) => i.textEdit?.newText).filter((t) => t && t.startsWith("controls:"));
    if (!names.includes("controls:SettingsCard")) fail(`SettingsC should match SettingsCard: ${JSON.stringify(names)}`);
    if (names.includes("controls:SettingsExpander")) fail(`SettingsC must NOT match SettingsExpander: ${JSON.stringify(names)}`);
  }
  // 549) an ALREADY-DECLARED prefix is reused with NO injection (bare detail, no additionalTextEdits).
  {
    const items = await completeItemsWith(549, pageToolkit("<Grid><Sett|</Grid>"), "thirdparty-reuse");
    const card = byNewText(items, "toolkit:SettingsCard");
    if (!card) fail(`a declared xmlns:toolkit should be reused as toolkit:SettingsCard: ${JSON.stringify(items.map((i) => i.textEdit?.newText).filter(Boolean).slice(0, 20))}`);
    if (card.additionalTextEdits && card.additionalTextEdits.length > 0) fail(`a declared prefix needs NO xmlns injection: ${JSON.stringify(card.additionalTextEdits)}`);
    if (card.detail !== "CommunityToolkit.WinUI.Controls") fail(`detail should be the bare namespace (no '(adds …)'): ${card.detail}`);
    if (byNewText(items, "controls:SettingsCard")) fail(`must not ALSO offer a generated controls: prefix when one is declared`);
  }
  // 550) NEGATIVE — non-DependencyObject referenced types (DI services) are NEVER offered as elements.
  {
    const items = await completeItemsWith(550, pageCls("<Grid><Serv|</Grid>"), "thirdparty-di-excluded");
    const di = items.filter((i) => {
      const nt = i.textEdit?.newText || "";
      return /Service(Collection|Provider|Descriptor)/.test(nt) || /DependencyInjection/.test(i.detail || "");
    });
    if (di.length > 0) fail(`DI service types must never be offered as elements: ${JSON.stringify(di.map((i) => i.textEdit?.newText))}`);
  }
  console.log(`[ok] third-party control completion (#4): toolkit controls offered with auto xmlns injection, prefix reuse, partial filter, and DI exclusion (round 84)`);

  // 551-553) GAP #3 (ux-generate-handler): the caret on an event attribute whose handler is ABSENT from the
  //          code-behind offers a "Generate event handler 'X'" quick fix whose cross-file WorkspaceEdit stubs
  //          the method into the USER .xaml.cs partial (never a generated .g.cs) with the delegate signature.
  const genOf = (actions) => actions.find((a) => a.title && a.title.startsWith("Generate event handler"));
  // 551) fresh Foo_Click -> generate action targeting SmokePage.xaml.cs with the RoutedEventHandler signature.
  {
    const actions = await codeActionAtCaret(551, pageCls(`<Button Click="Foo|_Click" Content="Hi" />`), "gen-handler");
    const gen = genOf(actions);
    if (!gen) fail(`gap #3: a missing Click handler should offer a generate action: ${JSON.stringify(actions.map((a) => a.title))}`);
    if (gen.title !== "Generate event handler 'Foo_Click'") fail(`gap #3: wrong title: ${gen.title}`);
    if (gen.kind !== "quickfix") fail(`gap #3: action must be a quickfix, got ${gen.kind}`);
    if (gen.isPreferred !== true) fail(`gap #3: action must be preferred`);
    const changes = gen.edit?.changes || {};
    const target = Object.keys(changes)[0] || "";
    if (!target.toLowerCase().endsWith("smokepage.xaml.cs")) fail(`gap #3: edit should target SmokePage.xaml.cs, got ${target}`);
    if (/\.g\.i?\.cs$/i.test(target)) fail(`gap #3: must not write to a generated partial: ${target}`);
    const newText = changes[target]?.[0]?.newText || "";
    if (!newText.includes("private void Foo_Click(object sender, RoutedEventArgs e)")) {
      fail(`gap #3: stub should carry the delegate signature, got ${JSON.stringify(newText)}`);
    }
  }
  // 552) existing OnGo_Click -> NO generate action (never regenerate an existing handler).
  {
    const actions = await codeActionAtCaret(552, pageCls(`<Button Click="OnGo|_Click" Content="Hi" />`), "gen-handler-existing");
    if (genOf(actions)) fail(`gap #3: an existing handler must not be regenerated: ${JSON.stringify(actions.map((a) => a.title))}`);
  }
  // 553) non-event attribute + markup-extension value -> NO generate action.
  {
    const nonEvent = await codeActionAtCaret(553, pageCls(`<Button Foreground="Nope|_Handler" Content="Hi" />`), "gen-handler-nonevent");
    if (genOf(nonEvent)) fail(`gap #3: a non-event attribute must not offer the fix: ${JSON.stringify(nonEvent.map((a) => a.title))}`);
    const markup = await codeActionAtCaret(554, pageCls(`<Button Click="{x:Bind Ghost|_Click}" Content="Hi" />`), "gen-handler-markup");
    if (genOf(markup)) fail(`gap #3: a markup-extension value is not a handler name: ${JSON.stringify(markup.map((a) => a.title))}`);
  }
  console.log(`[ok] generate event handler (#3): missing handler -> cross-file stub into the user code-behind; existing/non-event/markup values offer nothing`);

  // 555) workspace/didChangeWatchedFiles null/empty-changes guard (regression): a client may send this
  // notification with an omitted, null, or empty `changes` array. The server must treat it as a no-op
  // and stay fully responsive to subsequent requests (never throw / drop the connection).
  send({ method: "workspace/didChangeWatchedFiles", params: {} }); // omitted changes
  send({ method: "workspace/didChangeWatchedFiles", params: { changes: null } }); // null changes
  send({ method: "workspace/didChangeWatchedFiles", params: { changes: [] } }); // empty changes
  {
    const stillAlive = await docSymbols(
      560,
      `<Page ${NS}>\n  <Grid>\n    <Button x:Name="WatchProbe" Content="Go" />\n  </Grid>\n</Page>`,
      "post-didChangeWatchedFiles"
    );
    if (stillAlive.length !== 1) fail(`server unresponsive after null/empty didChangeWatchedFiles, got ${stillAlive.length} symbols`);
    if (!stillAlive[0].name.includes("Page")) fail(`unexpected outline after didChangeWatchedFiles guard: '${stillAlive[0].name}'`);
  }
  console.log(`[ok] workspace/didChangeWatchedFiles: omitted/null/empty changes are a no-op; server stays responsive`);

  // 556) workspace-trust boundary (behavioral negative): a document OUTSIDE every allowedRoot must be
  // served project-less — the server must NOT reach the project resolver / MSBuild for it. We open a
  // real .xaml under the OS temp dir (guaranteed outside the fixture root that was passed as the only
  // allowedRoot) with an x:Class + event handler, and assert F12 on the handler yields NO location.
  // The in-root fixture DID resolve earlier (definition #2 landed in the code-behind), so a null here
  // proves the boundary gates resolution rather than the feature being globally broken.
  {
    const outDir = mkdtempSync(join(tmpdir(), "winui-xaml-oob-"));
    const outFile = join(outDir, "OutOfRootPage.xaml");
    const outText =
      `<Page x:Class="OutOfRoot.OutOfRootPage" ${NS}>\n` +
      `  <Grid>\n` +
      `    <Button x:Name="OobButton" Click="OnOobClick" Content="Go" />\n` +
      `  </Grid>\n` +
      `</Page>\n`;
    try {
      writeFileSync(outFile, outText, "utf8");
      const outUri = pathToFileURL(outFile).href;
      const handlerAt = outText.indexOf("OnOobClick") + 3;
      const outCaret = offsetToPosition(outText, handlerAt);

      send({
        method: "textDocument/didOpen",
        params: { textDocument: { uri: outUri, languageId: "xaml", version: 1, text: outText } },
      });
      send({
        id: 561,
        method: "textDocument/definition",
        params: { textDocument: { uri: outUri }, position: outCaret },
      });
      const oobDef = await waitFor(responseFor(561), 30000, "out-of-root definition");
      if (oobDef.error) fail(`out-of-root definition errored: ${JSON.stringify(oobDef.error)}`);
      const oobLoc = Array.isArray(oobDef.result) ? oobDef.result[0] : oobDef.result;
      if (oobLoc && oobLoc.uri) {
        fail(`out-of-root document was project-resolved (boundary bypass): ${JSON.stringify(oobLoc)}`);
      }
      send({ method: "textDocument/didClose", params: { textDocument: { uri: outUri } } });
    } finally {
      try { rmSync(outDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
  console.log(`[ok] workspace-trust boundary: an out-of-root .xaml is served project-less (F12 handler -> no location), while the in-root fixture resolved`);

  // 22) shutdown
  send({ id: 11, method: "shutdown", params: null });
  await waitFor(responseFor(11), 10000, "shutdown");
  send({ method: "exit", params: null });

  console.log("\nPASS: language server spine works (initialize + diagnostics + F12 + x:Bind F12 + hover incl. element/attribute names + completion incl. enum/bool values + markup-extension names + Mode= + resource keys + x:Bind member paths + close-tag completion + using: namespace completion + document outline + semantic validation + formatting + folding + document color + selection ranges + linked editing + document links + rename + semantic tokens + code actions + completion documentation + method hover enrichment + GridLength value completion + named-color value completion + FontWeight value completion + third-party control completion + generate event handler).");
  setTimeout(() => process.exit(0), 200);
}

main().catch((err) => fail(err.message));

