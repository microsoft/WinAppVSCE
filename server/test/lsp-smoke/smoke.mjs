// End-to-end LSP smoke test for the WinUI XAML language server. Drives the real server over stdio (no VS Code, no test framework, no npm deps) and proves the spine: initialize -> didOpen (syntactic diagnostics) -> textDocument/definition (F12) resolves an event-handler attribute value to the C# method in the page's code-behind. Usage:  node smoke.mjs Exit 0 = pass. Requires the server to be built (Debug) and the WinUI smoke fixture on disk.

import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { runCoreScenarios } from "./smoke-core-scenarios.mjs";
import { runEditorScenarios } from "./smoke-editor-scenarios.mjs";
import { runCompletionScenarios } from "./smoke-completion-scenarios.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const SERVER_DLL = resolve(
  here,
  "../../src/WinUiXaml.LanguageServer/bin/Debug/net10.0/WinUiXaml.LanguageServer.dll"
);
// Allow pointing the smoke test at an alternate framework-dependent DLL.
const serverPath =
  process.env.WINUI_XAML_SERVER_PATH || SERVER_DLL;
const XAML = process.env.WINUI_XAML_FIXTURE_XAML || resolve(here, "../../../test/fixtures/xaml/fixture/SmokePage.xaml");
const EXPECTED_CODE_BEHIND = "smokepage.xaml.cs";
const EXPECTED_HANDLER_LINE = 26; // OnGo_Click is on line 27 (1-based) of SmokePage.xaml.cs
const EXPECTED_GREETING_LINE = 15; // GreetingText is on line 16 (1-based) of SmokePage.xaml.cs
const EXPECTED_APP_XAML = "app.xaml";
const APP_XAML = resolve(dirname(XAML), "App.xaml");

let server;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
  if (server) server.kill();
  process.exit();
}

if (!existsSync(serverPath)) fail(`server not built: ${serverPath}`);
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

if (!existsSync(APP_XAML)) fail(`fixture not found: ${APP_XAML}`);
const appXamlText = readFileSync(APP_XAML, "utf8");
const accentKeyOffset = appXamlText.indexOf('x:Key="SmokeAccentBrush"');
if (accentKeyOffset < 0) fail('could not find x:Key="SmokeAccentBrush" in App.xaml');
const EXPECTED_ACCENT_KEY_LINE = offsetToPosition(appXamlText, accentKeyOffset).line;

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

const classIdx = xamlText.indexOf("x:Class");
if (classIdx < 0) fail("could not find x:Class in the fixture");
const classCaret = offsetToPosition(xamlText, classIdx + 3);

const buttonIdx = xamlText.indexOf("<Button");
if (buttonIdx < 0) fail("could not find Button in the fixture");
const buttonCaret = offsetToPosition(xamlText, buttonIdx + 3);
const pageIdx = xamlText.indexOf("<Page");
if (pageIdx < 0) fail("could not find Page in the fixture");
const pageCaret = offsetToPosition(xamlText, pageIdx + 3);
const navigationIdx = xamlText.indexOf('NavigationCacheMode="Required"');
if (navigationIdx < 0) fail("could not find NavigationCacheMode in the fixture");
const navigationCaret = offsetToPosition(xamlText, navigationIdx + 5);
const requiredCaret = offsetToPosition(xamlText, navigationIdx + 'NavigationCacheMode="'.length + 3);
const ignorableIdx = xamlText.indexOf("mc:Ignorable");
if (ignorableIdx < 0) fail("could not find mc:Ignorable in the fixture");
const ignorableCaret = offsetToPosition(xamlText, ignorableIdx + 4);
const contentIdx = xamlText.indexOf('Content="Go to Page 2"', buttonIdx);
if (contentIdx < 0) fail("could not find Button.Content in the fixture");
const contentCaret = offsetToPosition(xamlText, contentIdx + 3);
const contentValueCaret = offsetToPosition(xamlText, contentIdx + 'Content="'.length + 3);

// Caret inside the {StaticResource SmokeAccentBrush} value (resolves cross-file to App.xaml's x:Key).
const resIdx = xamlText.indexOf("{StaticResource SmokeAccentBrush}");
if (resIdx < 0) fail("could not find {StaticResource SmokeAccentBrush} in the fixture");
const resCaretOffset = xamlText.indexOf("SmokeAccentBrush", resIdx) + 3;
const resCaret = offsetToPosition(xamlText, resCaretOffset);

if (!serverPath.toLowerCase().endsWith(".dll")) fail(`server must be a framework-dependent DLL: ${serverPath}`);
server = spawn("dotnet", [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
  cwd: dirname(serverPath),
});

// --- LSP framing ---
let buffer = Buffer.alloc(0);
const waiters = [];
const publishedDiagnostics = [];

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
  if (msg.method === "textDocument/publishDiagnostics") {
    publishedDiagnostics.push(msg.params);
  }

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
  // 1) initialize Pass the fixture directory as the sole trusted workspace root so the server performs project discovery / MSBuild evaluation for the in-root fixture (matching the real client, which sends its workspace folders as initializationOptions.allowedRoots).
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
  if (!caps.completionProvider.triggerCharacters?.includes(",")) {
    fail("server did not advertise comma as a completion trigger");
  }
  if (caps.documentSymbolProvider !== true) fail("server did not advertise documentSymbolProvider");
  if (caps.textDocumentSync?.openClose !== true) fail("server did not advertise openClose sync");
  console.log("[ok] initialize: definition + hover + completion + documentSymbol + openClose advertised");

  send({ method: "initialized", params: {} });

  // 2) didOpen -> expect diagnostics (0 for the clean fixture)
  const diagPromise = waitFor(notification("textDocument/publishDiagnostics"), 15000, "publishDiagnostics");
  const loadingStatusPromise = waitFor(
    (message) =>
      message.method === "winui-xaml/projectContextStatus" &&
      message.params?.uri === xamlUri &&
      message.params?.state === "loading",
    15000,
    "project context loading status"
  );
  const frameworkReadyStatusPromise = waitFor(
    (message) =>
      message.method === "winui-xaml/projectContextStatus" &&
      message.params?.uri === xamlUri &&
      message.params?.state === "framework-ready",
    90000,
    "project context framework-ready status"
  );
  const readyStatusPromise = waitFor(
    (message) =>
      message.method === "winui-xaml/projectContextStatus" &&
      message.params?.uri === xamlUri &&
      message.params?.state === "ready",
    90000,
    "project context ready status"
  );
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
  await loadingStatusPromise;
  console.log("[ok] didOpen: 0 syntactic diagnostics for the valid fixture");

  // Completion requested during the cold-load window must be explicitly provisional rather than
  // looking like an authoritative empty result.
  send({
    id: 103,
    method: "textDocument/completion",
    params: {
      textDocument: { uri: xamlUri },
      position: { line: 6, character: 5 },
    },
  });
  const coldCompletion = await waitFor(responseFor(103), 5000, "cold completion");
  if (coldCompletion.result?.isIncomplete !== true) {
    fail(`cold completion must be marked incomplete while project metadata loads: ${JSON.stringify(coldCompletion.result)}`);
  }
  console.log("[ok] completion(cold): provisional result is marked incomplete");

  // Project-independent directive quick info must not wait for the cold design-time build.
  const coldHoverStarted = performance.now();
  send({
    id: 100,
    method: "textDocument/hover",
    params: { textDocument: { uri: xamlUri }, position: classCaret },
  });
  const coldHover = await waitFor(responseFor(100), 5000, "cold x:Class hover");
  const coldHoverMs = performance.now() - coldHoverStarted;
  const coldHoverText = coldHover.result?.contents?.value ?? "";
  if (!coldHoverText.includes("x:Class") || !/CLR class/i.test(coldHoverText)) {
    fail(`cold x:Class hover was not useful: ${coldHoverText}`);
  }
  if (coldHoverMs >= 1000) fail(`cold x:Class hover took ${coldHoverMs.toFixed(0)} ms (contract: <1000 ms)`);
  console.log(`[ok] hover(cold directive): x:Class (${coldHoverMs.toFixed(0)} ms)`);

  const coldElementStarted = performance.now();
  send({
    id: 101,
    method: "textDocument/hover",
    params: { textDocument: { uri: xamlUri }, position: pageCaret },
  });
  const coldElementHover = await waitFor(responseFor(101), 5000, "cold element hover");
  const coldElementMs = performance.now() - coldElementStarted;
  if (coldElementHover.result !== null) {
    fail(`cold element hover should be suppressed while project IntelliSense loads: ${JSON.stringify(coldElementHover.result)}`);
  }
  if (coldElementMs >= 1000) fail(`cold element hover took ${coldElementMs.toFixed(0)} ms (contract: <1000 ms)`);
  console.log(`[ok] hover(cold element): suppressed while loading (${coldElementMs.toFixed(0)} ms)`);

  for (const [id, position, label, expected] of [
    [105, ignorableCaret, "mc:Ignorable", /namespace prefixes/i],
    [192, resCaret, "resource reference", /References a XAML resource by key/i],
  ]) {
    const started = performance.now();
    send({ id, method: "textDocument/hover", params: { textDocument: { uri: xamlUri }, position } });
    const response = await waitFor(responseFor(id), 5000, `cold ${label} hover`);
    const elapsedMs = performance.now() - started;
    const text = response.result?.contents?.value ?? "";
    const prose = (text.split("```")[2] || "").trim();
    if (prose.length === 0 || !expected.test(prose)) fail(`cold ${label} hover had no useful prose: ${text}`);
    if (/loading/i.test(text)) fail(`cold ${label} hover exposed loading state: ${text}`);
    if (elapsedMs >= 1000) fail(`cold ${label} hover took ${elapsedMs.toFixed(0)} ms (contract: <1000 ms)`);
    console.log(`[ok] hover(cold ${label}): (${elapsedMs.toFixed(0)} ms)`);
  }

  // 3) definition (F12) must NEVER queue behind the design-time build. A user who pressed F12, saw
  // nothing, and moved on must not have the editor jump somewhere seconds later when the build lands.
  const coldDefinitionStarted = performance.now();
  send({
    id: 103,
    method: "textDocument/definition",
    params: { textDocument: { uri: xamlUri }, position: caret },
  });
  const coldDefinition = await waitFor(responseFor(103), 5000, "cold definition");
  const coldDefinitionMs = performance.now() - coldDefinitionStarted;
  if (coldDefinition.result !== null) {
    fail(`cold definition should be suppressed while project IntelliSense loads: ${JSON.stringify(coldDefinition.result)}`);
  }
  if (coldDefinitionMs >= 1000) {
    fail(`cold definition took ${coldDefinitionMs.toFixed(0)} ms (contract: <1000 ms — it must not block on the project load)`);
  }
  console.log(`[ok] definition(cold): suppressed while loading, did not block (${coldDefinitionMs.toFixed(0)} ms)`);

  await frameworkReadyStatusPromise;
  await readyStatusPromise;
  console.log("[ok] project context status: loading -> framework-ready -> ready");

  // 4) the same F12, once the project is ready, resolves OnGo_Click to the C# code-behind.
  console.log(`[..] definition at ${caret.line}:${caret.character}`);
  const definitionStarted = performance.now();
  send({
    id: 2,
    method: "textDocument/definition",
    params: { textDocument: { uri: xamlUri }, position: caret },
  });
  const def = await waitFor(responseFor(2), 90000, "definition");
  const definitionMs = performance.now() - definitionStarted;
  if (def.error) fail(`definition errored: ${JSON.stringify(def.error)}`);
  const loc = def.result;
  if (!loc || !loc.uri) fail(`definition returned no location: ${JSON.stringify(loc)}`);
  if (!loc.uri.toLowerCase().endsWith(EXPECTED_CODE_BEHIND)) {
    fail(`definition landed in unexpected file: ${loc.uri}`);
  }
  if (loc.range?.start?.line !== EXPECTED_HANDLER_LINE) {
    fail(`definition landed on line ${loc.range?.start?.line}, expected ${EXPECTED_HANDLER_LINE}`);
  }
  console.log(`[ok] definition: OnGo_Click -> ${loc.uri} @ line ${loc.range.start.line} (${definitionMs.toFixed(0)} ms ready)`);

  const warmHoverStarted = performance.now();
  send({
    id: 102,
    method: "textDocument/hover",
    params: { textDocument: { uri: xamlUri }, position: buttonCaret },
  });
  const warmHover = await waitFor(responseFor(102), 5000, "warm element hover");
  const warmHoverMs = performance.now() - warmHoverStarted;
  const warmHoverText = warmHover.result?.contents?.value ?? "";
  const warmDescription = (warmHoverText.split("```")[2] || "").trim();
  if (!warmHoverText.includes("Button") || warmDescription.length === 0) {
    fail(`warm element hover was signature-only: ${warmHoverText}`);
  }
  if (warmHoverMs >= 1000) fail(`warm element hover took ${warmHoverMs.toFixed(0)} ms (contract: <1000 ms)`);
  console.log(`[ok] hover(warm element): Button (${warmHoverMs.toFixed(0)} ms)`);

  for (const [id, position, label, expected] of [
    [103, navigationCaret, "NavigationCacheMode attribute", /NavigationCacheMode[\s\S]+Page/i],
    [104, requiredCaret, "Required enum value", /NavigationCacheMode\.Required/i],
    [106, contentCaret, "Content attribute", /ContentControl\.Content/i],
    [191, bindCaret, "x:Bind expression", /SmokePage\.GreetingText/i],
  ]) {
    send({ id, method: "textDocument/hover", params: { textDocument: { uri: xamlUri }, position } });
    const response = await waitFor(responseFor(id), 5000, `warm ${label} hover`);
    const text = response.result?.contents?.value ?? "";
    if (!expected.test(text)) fail(`warm ${label} hover was not semantic: ${text}`);
  }

  // Actual generated-file watcher traffic must not invalidate authoritative context.
  send({
    method: "workspace/didChangeWatchedFiles",
    params: {
      changes: [{
        uri: pathToFileURL(join(dirname(XAML), "obj", "Debug", "Generated.g.cs")).href,
        type: 2,
      }],
    },
  });
  const generatedHoverStarted = performance.now();
  send({
    id: 188,
    method: "textDocument/hover",
    params: { textDocument: { uri: xamlUri }, position: pageCaret },
  });
  const generatedHover = await waitFor(responseFor(188), 5000, "post-obj watcher hover");
  const generatedHoverMs = performance.now() - generatedHoverStarted;
  const generatedHoverText = generatedHover.result?.contents?.value ?? "";
  if (!/```csharp/.test(generatedHoverText) || !/Represents|page/i.test((generatedHoverText.split("```")[2] || ""))) {
    fail(`obj/bin watcher reset authoritative context: ${generatedHoverText}`);
  }
  if (generatedHoverMs >= 1000) fail(`post-obj watcher hover took ${generatedHoverMs.toFixed(0)} ms`);
  console.log(`[ok] obj/bin watched event preserves authoritative context (${generatedHoverMs.toFixed(0)} ms)`);

  // A project-affecting watched change invalidates the context while this document remains open.
  // Hover must stay responsive immediately and the existing single-flight warm-up must eventually
  // restore authoritative quick info without closing/reopening the XAML document.
  const importedBuildPath = join(dirname(XAML), "Directory.Build.targets");
  const importedBuildUri = pathToFileURL(importedBuildPath).href;
  if (existsSync(importedBuildPath)) fail(`test requires no pre-existing ${importedBuildPath}`);
  const cleanImportedBuild = () => rmSync(importedBuildPath, { force: true });
  process.once("exit", cleanImportedBuild);
  writeFileSync(
    importedBuildPath,
    '<Project><ItemGroup><Compile Remove="SmokePage.xaml.cs" /></ItemGroup></Project>',
    "utf8"
  );
  // The blocking F12 below used to double as this section's reload barrier. Definition is now
  // non-blocking (issue #220), so synchronize on the same status notification the real client uses.
  // Registered before the change is sent so the reload's notification cannot be missed.
  const reloadReadyPromise = waitFor(
    (message) =>
      message.method === "winui-xaml/projectContextStatus" &&
      message.params?.uri === xamlUri &&
      message.params?.state === "ready",
    90000,
    "project context ready status after invalidation"
  );
  send({
    method: "workspace/didChangeWatchedFiles",
    params: { changes: [{ uri: importedBuildUri, type: 2 }] },
  });

  const fallbackStarted = performance.now();
  send({
    id: 108,
    method: "textDocument/hover",
    params: { textDocument: { uri: xamlUri }, position: pageCaret },
  });
  const fallbackResponse = await waitFor(responseFor(108), 5000, "post-invalidation suppressed hover");
  const fallbackMs = performance.now() - fallbackStarted;
  if (fallbackMs >= 1000) fail(`post-invalidation fallback hover took ${fallbackMs.toFixed(0)} ms`);
  if (fallbackResponse.result !== null) {
    fail(`post-invalidation hover should be suppressed while reloading: ${JSON.stringify(fallbackResponse.result)}`);
  }

  await reloadReadyPromise;

  // SmokePage.xaml.cs is no longer part of the compilation, so F12 on the handler must not resolve.
  // Asserted after the reload has completed, which proves the context actually changed rather than
  // merely that the request arrived while the project was still loading.
  send({
    id: 700,
    method: "textDocument/definition",
    params: { textDocument: { uri: xamlUri }, position: caret },
  });
  const removedDefinition = await waitFor(responseFor(700), 30000, "definition after imported props change");
  if (removedDefinition.result != null) {
    fail(`imported props change did not alter project context: ${JSON.stringify(removedDefinition.result)}`);
  }

  const authoritativeStarted = performance.now();
  send({
    id: 109,
    method: "textDocument/hover",
    params: { textDocument: { uri: xamlUri }, position: pageCaret },
  });
  const authoritativeResponse = await waitFor(responseFor(109), 5000, "post-reload Page hover");
  const authoritativeMs = performance.now() - authoritativeStarted;
  const authoritativeText = authoritativeResponse.result?.contents?.value ?? "";
  if (authoritativeMs >= 1000) fail(`post-reload hover took ${authoritativeMs.toFixed(0)} ms`);
  if (!/```csharp/.test(authoritativeText) ||
      !/Represents|page/i.test((authoritativeText.split("```")[2] || ""))) {
    fail(`context did not restore authoritative Page hover after invalidation: ${authoritativeText}`);
  }
  console.log(`[ok] hover is suppressed during invalidation and authoritative after reload (${fallbackMs.toFixed(0)} ms suppressed, ${authoritativeMs.toFixed(0)} ms restored)`);

  cleanImportedBuild();
  process.removeListener("exit", cleanImportedBuild);
  send({
    method: "workspace/didChangeWatchedFiles",
    params: { changes: [{ uri: importedBuildUri, type: 3 }] },
  });
  let restoredDefinition;
  for (let attempt = 0; attempt < 80; attempt++) {
    const id = 701 + attempt;
    send({
      id,
      method: "textDocument/definition",
      params: { textDocument: { uri: xamlUri }, position: caret },
    });
    const response = await waitFor(responseFor(id), 90000, "definition after imported props removal");
    if (response.result?.uri?.toLowerCase().endsWith(EXPECTED_CODE_BEHIND)) {
      restoredDefinition = response.result;
      break;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  if (!restoredDefinition) fail("project context did not recover after imported props removal");
  console.log("[ok] imported props watched event changes and restores project context");

  // Unsaved x:Class edits invalidate only this URI and resolution must use the in-memory text.
  const page2Text = xamlText
    .replace("SmokeFixture.SmokePage", "SmokeFixture.Page2")
    .replace("OnGo_Click", "OnOpenDiPage_Click");
  const page2HandlerOffset = page2Text.indexOf("OnOpenDiPage_Click") + 3;
  const page2HandlerCaret = offsetToPosition(page2Text, page2HandlerOffset);
  send({
    method: "textDocument/didChange",
    params: { textDocument: { uri: xamlUri, version: 2 }, contentChanges: [{ text: page2Text }] },
  });
  send({
    id: 189,
    method: "textDocument/definition",
    params: { textDocument: { uri: xamlUri }, position: page2HandlerCaret },
  });
  const changedClassDefinition = await waitFor(responseFor(189), 30000, "definition after x:Class edit");
  if (changedClassDefinition.error) fail(`x:Class edit definition errored: ${JSON.stringify(changedClassDefinition.error)}`);
  if (!changedClassDefinition.result?.uri?.toLowerCase().endsWith("page2.xaml.cs")) {
    fail(`replacement x:Class did not resolve Page2 member: ${JSON.stringify(changedClassDefinition.result)}`);
  }

  send({
    method: "textDocument/didChange",
    params: { textDocument: { uri: xamlUri, version: 3 }, contentChanges: [{ text: xamlText }] },
  });
  send({
    id: 190,
    method: "textDocument/definition",
    params: { textDocument: { uri: xamlUri }, position: caret },
  });
  const restoredClassDefinition = await waitFor(responseFor(190), 30000, "definition after x:Class restore");
  if (!restoredClassDefinition.result?.uri?.toLowerCase().endsWith(EXPECTED_CODE_BEHIND)) {
    fail(`restored x:Class did not restore SmokePage resolution: ${JSON.stringify(restoredClassDefinition.result)}`);
  }
  console.log("[ok] in-memory x:Class changes invalidate and rebuild only the document context");

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
  let version = 3;
  const nextVersion = () => ++version;
  const retainFixtureClass = (body) =>
    /^<Page\b(?![^>]*\bx:Class=)/.test(body)
      ? body.replace("<Page", '<Page x:Class="SmokeFixture.SmokePage"')
      : body;

  async function completeWith(id, body, label) {
    body = retainFixtureClass(body);
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
    body = retainFixtureClass(body);
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
    body = retainFixtureClass(body);
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
    body = retainFixtureClass(body);
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
    body = retainFixtureClass(body);
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
    body = retainFixtureClass(body);
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
    body = retainFixtureClass(body);
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

  const scenarioContext = {
    fail,
    send,
    waitFor,
    responseFor,
    notification,
    offsetToPosition,
    resCaret,
    xamlText,
    xamlUri,
    XAML,
    EXPECTED_CODE_BEHIND,
    EXPECTED_HANDLER_LINE,
    EXPECTED_GREETING_LINE,
    EXPECTED_APP_XAML,
    EXPECTED_ACCENT_KEY_LINE,
    NS,
    nextVersion,
    publishedDiagnostics,
    completeWith,
    completeItemsWith,
    hoverAt,
    definitionWith,
    codeActionAtCaret,
    positionToOffset,
    referencesWith,
    highlightWith,
    applyEdits,
    formatWith,
    foldingWith,
    documentColorWith,
    colorPresentationWith,
    selectionRangeWith,
    linkedEditingWith,
    documentLinkWith,
    prepareRenameWith,
    renameWith,
    semanticTokensWith,
    semanticTokensRangeWith,
    decodeSemanticTokens,
    codeActionWith,
    readFileSync,
    writeFileSync,
    pathToFileURL,
    dirname,
    resolve,
    join,
    mkdtempSync,
    rmSync,
    tmpdir,
  };
  await runCoreScenarios(scenarioContext);
  await runEditorScenarios(scenarioContext);
  await runCompletionScenarios(scenarioContext);

  // Saving a generated event handler must invalidate the C# compilation and republish the open
  // XAML document so the stale missing-handler diagnostic disappears without another XAML edit.
  const generatedHandlerName = "GeneratedRefresh_Click";
  const generatedHandlerText = xamlText.replace("OnGo_Click", generatedHandlerName);
  const generatedHandlerVersion = nextVersion();
  const missingHandlerDiagnostic = waitFor(
    (message) =>
      message.method === "textDocument/publishDiagnostics" &&
      message.params.uri === xamlUri &&
      message.params.version === generatedHandlerVersion &&
      message.params.diagnostics.some((diagnostic) => diagnostic.code === "WXAML0015"),
    30000,
    "missing generated event-handler diagnostic"
  );
  send({
    method: "textDocument/didChange",
    params: {
      textDocument: { uri: xamlUri, version: generatedHandlerVersion },
      contentChanges: [{ text: generatedHandlerText }],
    },
  });
  await missingHandlerDiagnostic;

  const codeBehindPath = join(dirname(XAML), "SmokePage.xaml.cs");
  const originalCodeBehind = readFileSync(codeBehindPath, "utf8");
  const followingTypeIndex = originalCodeBehind.indexOf("internal sealed class InternalCard");
  const classCloseIndex = originalCodeBehind.lastIndexOf("}", followingTypeIndex);
  if (followingTypeIndex < 0 || classCloseIndex < 0) {
    fail("could not insert generated event handler into smoke fixture");
  }
  const generatedMethod =
    `    private void ${generatedHandlerName}(object sender, RoutedEventArgs e)\r\n` +
    "    {\r\n" +
    "    }\r\n\r\n";
  const generatedCodeBehind =
    originalCodeBehind.slice(0, classCloseIndex) +
    generatedMethod +
    originalCodeBehind.slice(classCloseIndex);
  const restoreCodeBehind = () => writeFileSync(codeBehindPath, originalCodeBehind, "utf8");
  process.once("exit", restoreCodeBehind);
  writeFileSync(codeBehindPath, generatedCodeBehind, "utf8");

  const clearedGeneratedHandlerDiagnostic = waitFor(
    (message) =>
      message.method === "textDocument/publishDiagnostics" &&
      message.params.uri === xamlUri &&
      message.params.version === generatedHandlerVersion &&
      !message.params.diagnostics.some((diagnostic) => diagnostic.code === "WXAML0015"),
    30000,
    "generated event-handler diagnostic clear"
  );
  const generatedHandlerReady = waitFor(
    (message) =>
      message.method === "winui-xaml/projectContextStatus" &&
      message.params?.uri === xamlUri &&
      message.params?.state === "ready",
    90000,
    "project context ready after generated event-handler save"
  );
  send({
    method: "workspace/didChangeWatchedFiles",
    params: {
      changes: [{ uri: pathToFileURL(codeBehindPath).href, type: 2 }],
    },
  });
  await clearedGeneratedHandlerDiagnostic;
  await generatedHandlerReady;

  const generatedDefinitionId = 9998;
  send({
    id: generatedDefinitionId,
    method: "textDocument/definition",
    params: {
      textDocument: { uri: xamlUri },
      position: offsetToPosition(
        generatedHandlerText,
        generatedHandlerText.indexOf(generatedHandlerName) + 3
      ),
    },
  });
  const generatedDefinition = await waitFor(
    responseFor(generatedDefinitionId),
    30000,
    "generated event-handler definition"
  );
  if (!generatedDefinition.result?.uri?.toLowerCase().endsWith(EXPECTED_CODE_BEHIND)) {
    fail(`generated event handler was not loaded from code-behind: ${JSON.stringify(generatedDefinition.result)}`);
  }
  console.log("[ok] generated event-handler save clears stale XAML diagnostics");

  restoreCodeBehind();
  process.removeListener("exit", restoreCodeBehind);
  send({
    method: "workspace/didChangeWatchedFiles",
    params: {
      changes: [{ uri: pathToFileURL(codeBehindPath).href, type: 2 }],
    },
  });

  // Closing cancels pending semantic validation and clears diagnostics before the URI is reopened.
  publishedDiagnostics.length = 0;
  const closingVersion = nextVersion();
  const clearedAfterClose = waitFor(
    (message) =>
      message.method === "textDocument/publishDiagnostics" &&
      message.params.uri === xamlUri &&
      message.params.version === undefined &&
      message.params.diagnostics.length === 0,
    10000,
    "diagnostic clear after didClose"
  );
  send({
    method: "textDocument/didChange",
    params: {
      textDocument: { uri: xamlUri, version: closingVersion },
      contentChanges: [{ text: xamlText.replace("<Button", "<Buton") }],
    },
  });
  send({ method: "textDocument/didClose", params: { textDocument: { uri: xamlUri } } });
  await clearedAfterClose;
  await new Promise((resolve) => setTimeout(resolve, 750));
  if (publishedDiagnostics.some(
    (publish) =>
      publish.version === closingVersion &&
      publish.diagnostics.some((diagnostic) => diagnostic.code === "WXAML0002")
  )) {
    fail("didClose allowed pending semantic diagnostics to publish");
  }

  // Reopening the same URI with a different class must not serve definitions from the closed
  // SmokePage context.
  const reopenedText =
    `<Page ${NS} x:Class="SmokeFixture.Page2">\n` +
    `  <Button Click="OnGo_Click" />\n` +
    `</Page>`;
  send({
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: xamlUri,
        languageId: "xaml",
        version: 1,
        text: reopenedText,
      },
    },
  });
  send({
    id: 9999,
    method: "textDocument/definition",
    params: {
      textDocument: { uri: xamlUri },
      position: offsetToPosition(reopenedText, reopenedText.indexOf("OnGo_Click") + 3),
    },
  });
  const reopenedDefinition = await waitFor(responseFor(9999), 30000, "definition after close/reopen");
  if (reopenedDefinition.error) fail(`definition after close/reopen errored: ${JSON.stringify(reopenedDefinition.error)}`);
  if (reopenedDefinition.result !== null) {
    fail(`DidClose retained the stale SmokePage context: ${JSON.stringify(reopenedDefinition.result)}`);
  }
  console.log("[ok] didClose cancels pending diagnostics, evicts context, and prevents stale publication");

  // 22) shutdown
  send({ id: 11, method: "shutdown", params: null });
  await waitFor(responseFor(11), 10000, "shutdown");
  send({ method: "exit", params: null });

  console.log("\nPASS: language server spine works (initialize + diagnostics + F12 + x:Bind F12 + hover incl. element/attribute names + completion incl. enum/bool values + markup-extension names + Mode= + resource keys + x:Bind member paths + close-tag completion + using: namespace completion + document outline + semantic validation + formatting + folding + document color + selection ranges + linked editing + document links + rename + semantic tokens + code actions + completion documentation + method hover enrichment + GridLength value completion + named-color value completion + FontWeight value completion + third-party control completion + generate event handler).");
  setTimeout(() => process.exit(0), 200);
}

main().catch((err) => {
  const recentDiagnostics = publishedDiagnostics
    .slice(-6)
    .map((publish) => ({
      version: publish.version,
      codes: publish.diagnostics.map((diagnostic) => diagnostic.code),
    }));
  fail(`${err.message}; recent diagnostics: ${JSON.stringify(recentDiagnostics)}`);
});
