"use strict";

// Shared helpers for the WinUI XAML VS Code integration tests.
//
// These drive the REAL extension inside a REAL VS Code instance: opening the smoke fixture's
// SmokePage.xaml, replacing its in-memory buffer with "doctored" probe text (a `|` marks the
// caret), and invoking VS Code's own language-feature commands so requests travel through the
// actual LSP client to our .NET server — the same path a user exercises while typing.
//
// The on-disk file is never saved; the buffer is reverted on teardown. Resolution of x:Class,
// project types, and App.xaml resources still works because the server reads those from disk
// while parsing the in-memory buffer, mirroring the stdio smoke test.

const vscode = require("vscode");
const assert = require("node:assert");
const path = require("node:path");

const FIXTURE_DIR = process.env.WINUI_XAML_FIXTURE_DIR || path.resolve(__dirname, "..", "fixtures", "xaml", "fixture");
const XAML_PATH = path.join(FIXTURE_DIR, "SmokePage.xaml");

// Namespace header for self-contained <Page> probes (matches the fixture's declarations).
const NS = [
  'xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"',
  'xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"',
  'xmlns:d="http://schemas.microsoft.com/expression/blend/2008"',
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
  'xmlns:local="using:SmokeFixture"',
  'mc:Ignorable="d"',
].join("\n    ");

let doc;
let editor;

async function openProbe() {
  const uri = vscode.Uri.file(XAML_PATH);
  doc = await vscode.workspace.openTextDocument(uri);
  editor = await vscode.window.showTextDocument(doc, { preview: false });
  return { doc, editor };
}

async function revertProbe() {
  if (!editor) return;
  try {
    await vscode.commands.executeCommand("workbench.action.revertActiveEditor");
  } catch {
    /* best effort — the buffer was never saved, so disk is already pristine */
  }
}

function splitCaret(text) {
  const i = text.indexOf("|");
  assert.ok(i >= 0, "probe text must contain a | caret marker");
  return { clean: text.slice(0, i) + text.slice(i + 1), offset: i };
}

// Computes the caret as an EOL-agnostic (line, character) Position from the probe text. Using a
// line/character position (rather than a flat offset fed through positionAt) is essential because
// VS Code stores the buffer with the document's EOL (CRLF on Windows) while the probe text uses
// LF — a flat offset would drift by one char per preceding newline.
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

async function setBuffer(text) {
  if (!editor || !vscode.window.visibleTextEditors.includes(editor)) {
    editor = await vscode.window.showTextDocument(doc, { preview: false });
  }
  const whole = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
  const ok = await editor.edit((b) => b.replace(whole, text));
  assert.ok(ok, "failed to apply probe edit to the buffer");
}

function labelOf(item) {
  return typeof item.label === "string" ? item.label : item.label.label;
}

async function completionsAt(text) {
  const { clean, position } = caretPosition(text);
  await setBuffer(clean);
  const list = await vscode.commands.executeCommand(
    "vscode.executeCompletionItemProvider",
    doc.uri,
    position
  );
  return (list && list.items ? list.items : []).map(labelOf);
}

// Returns FULL completion items { label, detail, newText } so a test can uniquely identify our
// close-tag item (detail === "Closing tag") apart from VS Code's built-in word-based suggestions.
async function completionItemsAt(text) {
  const { clean, position } = caretPosition(text);
  await setBuffer(clean);
  const list = await vscode.commands.executeCommand(
    "vscode.executeCompletionItemProvider",
    doc.uri,
    position
  );
  return (list && list.items ? list.items : []).map((item) => ({
    label: labelOf(item),
    detail: item.detail,
    newText: item.textEdit
      ? item.textEdit.newText
      : typeof item.insertText === "string"
        ? item.insertText
        : item.insertText && item.insertText.value !== undefined
          ? item.insertText.value
          : undefined,
  }));
}

// Returns FULL completion items { label, detail, newText, additionalTextEdits } where each additional
// edit is { newText, range:{start:{line,character},end:{line,character}} }. Used for the third-party
// (round 84 / gap #4) xmlns-injection completions: a toolkit control item carries an AdditionalTextEdit
// that declares xmlns:PREFIX="using:NS" on the root. Discriminate on these SERVER-ONLY fields (newText /
// detail / additionalTextEdits) so VS Code's buffer word-based suggestions never confound assertions.
async function completionEditsAt(text) {
  const { clean, position } = caretPosition(text);
  await setBuffer(clean);
  const list = await vscode.commands.executeCommand(
    "vscode.executeCompletionItemProvider",
    doc.uri,
    position
  );
  return (list && list.items ? list.items : []).map((item) => ({
    label: labelOf(item),
    detail: item.detail,
    newText: item.textEdit ? item.textEdit.newText : undefined,
    additionalTextEdits: (item.additionalTextEdits || []).map((e) => ({
      newText: e.newText,
      range: {
        start: { line: e.range.start.line, character: e.range.start.character },
        end: { line: e.range.end.line, character: e.range.end.character },
      },
    })),
  }));
}

// Returns FULL completion items { label, detail, documentation } where `documentation` is the plain
// markdown string of item.documentation (round 67 completion-item docs). VS Code delivers our eager
// LSP MarkupContent as a vscode.MarkdownString (.value) or a plain string; normalize both. Tests
// discriminate on this SERVER-ONLY field so buffer word-based suggestions never confound assertions.
async function completionDocsAt(text) {
  const { clean, position } = caretPosition(text);
  await setBuffer(clean);
  const list = await vscode.commands.executeCommand(
    "vscode.executeCompletionItemProvider",
    doc.uri,
    position
  );
  return (list && list.items ? list.items : []).map((item) => {
    const d = item.documentation;
    const documentation = !d ? "" : typeof d === "string" ? d : d.value !== undefined ? d.value : "";
    return { label: labelOf(item), detail: item.detail, documentation };
  });
}

async function definitionsAt(text) {
  const { clean, position } = caretPosition(text);
  await setBuffer(clean);
  const locs = await vscode.commands.executeCommand(
    "vscode.executeDefinitionProvider",
    doc.uri,
    position
  );
  return (locs || []).map((l) => {
    // Definition results are Location or LocationLink.
    const uri = l.targetUri || l.uri;
    const range = l.targetRange || l.range;
    return { uri: uri.toString(), fsPath: uri.fsPath, line: range.start.line };
  });
}

async function referencesAt(text) {
  const { clean, position } = caretPosition(text);
  await setBuffer(clean);
  const locs = await vscode.commands.executeCommand(
    "vscode.executeReferenceProvider",
    doc.uri,
    position
  );
  return (locs || []).map((l) => ({
    uri: l.uri.toString(),
    fsPath: l.uri.fsPath,
    line: l.range.start.line,
    character: l.range.start.character,
    text: doc.getText(l.range),
  }));
}

async function highlightsAt(text) {
  const { clean, position } = caretPosition(text);
  await setBuffer(clean);
  const hls = await vscode.commands.executeCommand(
    "vscode.executeDocumentHighlights",
    doc.uri,
    position
  );
  return (hls || []).map((h) => ({
    line: h.range.start.line,
    character: h.range.start.character,
    // vscode.DocumentHighlightKind: Text=0, Read=1, Write=2 (client enum differs from the LSP wire values).
    kind: h.kind,
    text: doc.getText(h.range),
  }));
}

async function hoverAt(text) {
  const { clean, position } = caretPosition(text);
  await setBuffer(clean);
  const hovers = await vscode.commands.executeCommand(
    "vscode.executeHoverProvider",
    doc.uri,
    position
  );
  const parts = [];
  for (const h of hovers || []) {
    for (const c of h.contents || []) {
      parts.push(typeof c === "string" ? c : c.value);
    }
  }
  return parts.join("\n");
}

async function symbolsAt(text) {
  const { clean } = splitCaret(text.includes("|") ? text : text + "|");
  await setBuffer(clean);
  const syms = await vscode.commands.executeCommand(
    "vscode.executeDocumentSymbolProvider",
    doc.uri
  );
  return syms || [];
}

function flattenSymbols(nodes, out = []) {
  for (const n of nodes || []) {
    out.push(n.name);
    if (n.children && n.children.length) flattenSymbols(n.children, out);
  }
  return out;
}

// Sets the buffer, then waits until the diagnostics for the probe satisfy `predicate`. When no
// predicate is given, waits the full timeout so asynchronously-published diagnostics have time to
// settle (important right after switching buffers, when the previous probe's diagnostics linger).
async function diagnosticsFor(text, predicate, timeoutMs = 15000) {
  const { clean } = splitCaret(text.includes("|") ? text : text + "|");
  await setBuffer(clean);
  const started = Date.now();
  let last = vscode.languages.getDiagnostics(doc.uri);
  while (Date.now() - started < timeoutMs) {
    last = vscode.languages.getDiagnostics(doc.uri);
    if (predicate && predicate(last)) return last;
    await delay(200);
  }
  return last;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Warms the language server: opens the probe, then polls element completion until the project
// has loaded (the first request pays the design-time build cost, ~several seconds cold).
async function warmUp(timeoutMs = 170000) {
  await openProbe();
  const started = Date.now();
  let lastErr;
  while (Date.now() - started < timeoutMs) {
    try {
      const items = await completionItemsAt(`<Page ${NS}>\n  <But|\n</Page>`);
      if (items.some((item) =>
        item.label === "Button" &&
        typeof item.detail === "string" &&
        item.detail.startsWith("Microsoft.UI.Xaml"))) {
        return;
      }
      lastErr = new Error(`semantic element completion did not yet include Button (got ${items.length} items)`);
    } catch (e) {
      lastErr = e;
    }
    await delay(1000);
  }
  throw lastErr || new Error("language server did not warm up in time");
}

// Returns line-start offsets for LF text (probe text uses LF; edit positions are line/character
// so EOL is irrelevant to the logical position).
function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function posToOffset(starts, textLen, line, character) {
  if (line >= starts.length) return textLen;
  return Math.min(starts[line] + character, textLen);
}

// Format Document through VS Code's real formatting command. Returns { formatted, editCount } where
// `formatted` is the edits applied to `text`. `text` contains NO caret marker (formatting is
// whole-document / range, not caret-driven).
async function formatDoc(text, options = { tabSize: 2, insertSpaces: true }) {
  await setBuffer(text);
  const edits = await vscode.commands.executeCommand(
    "vscode.executeFormatDocumentProvider",
    doc.uri,
    options
  );
  const starts = lineStartsOf(text);
  const applied = (edits || [])
    .map((e) => ({
      start: posToOffset(starts, text.length, e.range.start.line, e.range.start.character),
      end: posToOffset(starts, text.length, e.range.end.line, e.range.end.character),
      newText: e.newText,
    }))
    .sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of applied) out = out.slice(0, e.start) + e.newText + out.slice(e.end);
  return { formatted: out, editCount: (edits || []).length };
}

// Maps VS Code's numeric FoldingRangeKind back to its LSP string ("comment"/"region"/"imports") so
// tests can assert on a readable kind without importing the vscode enum. Structural folds are undefined.
function foldKindName(kind) {
  if (kind === vscode.FoldingRangeKind.Comment) return "comment";
  if (kind === vscode.FoldingRangeKind.Region) return "region";
  if (kind === vscode.FoldingRangeKind.Imports) return "imports";
  return undefined;
}

// Folding ranges for a whole buffer (no caret marker). Returns { start, end, kind } with 0-based lines.
async function foldingRangesAt(buffer) {
  await setBuffer(buffer);
  const ranges = await vscode.commands.executeCommand(
    "vscode.executeFoldingRangeProvider",
    doc.uri
  );
  return (ranges || []).map((r) => ({ start: r.start, end: r.end, kind: foldKindName(r.kind) }));
}

// Document color swatches for a whole buffer (no caret marker). Returns
// { color: {red,green,blue,alpha}, range: {start,end}, text } where `text` is the exact source
// substring the swatch covers (handy for asserting the literal, e.g. "#FF0000").
async function documentColorsAt(buffer) {
  await setBuffer(buffer);
  const infos = await vscode.commands.executeCommand(
    "vscode.executeDocumentColorProvider",
    doc.uri
  );
  const lines = buffer.replace(/\r\n/g, "\n").split("\n");
  return (infos || []).map((info) => {
    const r = info.range;
    const text =
      r.start.line === r.end.line
        ? lines[r.start.line].slice(r.start.character, r.end.character)
        : undefined;
    return {
      color: {
        red: info.color.red,
        green: info.color.green,
        blue: info.color.blue,
        alpha: info.color.alpha,
      },
      range: {
        start: { line: r.start.line, character: r.start.character },
        end: { line: r.end.line, character: r.end.character },
      },
      text,
    };
  });
}

// Color presentations for a picked color over a range (as returned by documentColorsAt). `color` is a
// plain {red,green,blue,alpha}; `range` is {start:{line,character}, end:{line,character}}. Returns
// { label, newText, editRange } for each presentation.
async function colorPresentationsAt(buffer, color, range) {
  await setBuffer(buffer);
  const vColor = new vscode.Color(color.red, color.green, color.blue, color.alpha);
  const vRange = new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character
  );
  const presentations = await vscode.commands.executeCommand(
    "vscode.executeColorPresentationProvider",
    vColor,
    { uri: doc.uri, range: vRange }
  );
  return (presentations || []).map((p) => ({
    label: p.label,
    newText: p.textEdit ? p.textEdit.newText : undefined,
    editRange: p.textEdit
      ? {
          start: { line: p.textEdit.range.start.line, character: p.textEdit.range.start.character },
          end: { line: p.textEdit.range.end.line, character: p.textEdit.range.end.character },
        }
      : undefined,
  }));
}

// Selection ranges for a single caret (marked with |). Returns { caret, ranges } where `ranges` is the
// flattened parent chain innermost -> outermost, each { start:{line,character}, end:{line,character} }.
async function selectionRangesAt(text) {
  const { clean, position } = caretPosition(text);
  await setBuffer(clean);
  const result = await vscode.commands.executeCommand(
    "vscode.executeSelectionRangeProvider",
    doc.uri,
    [position]
  );
  const ranges = [];
  let cur = result && result[0];
  while (cur) {
    ranges.push({
      start: { line: cur.range.start.line, character: cur.range.start.character },
      end: { line: cur.range.end.line, character: cur.range.end.character },
    });
    cur = cur.parent;
  }
  return { caret: { line: position.line, character: position.character }, ranges };
}

// Drives the linked-editing provider at the caret. VS Code exposes this only via the internal
// `_executeLinkedEditingProvider` command (there is no public vscode.execute* alias), which can return
// ranges in either the extension shape ({start:{line,character}}) or the internal IRange shape
// ({startLineNumber,startColumn}, 1-based); normalize both. Returns { caret, ranges, wordPattern } with
// ranges [] when the provider returns nothing (self-closing / non-name caret).
async function linkedEditingAt(text) {
  const { clean, position } = caretPosition(text);
  await setBuffer(clean);
  const result = await vscode.commands.executeCommand(
    "_executeLinkedEditingProvider",
    doc.uri,
    position
  );
  const toRange = (r) => {
    if (r instanceof vscode.Range) return r;
    if (typeof r.startLineNumber === "number") {
      return new vscode.Range(r.startLineNumber - 1, r.startColumn - 1, r.endLineNumber - 1, r.endColumn - 1);
    }
    return new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
  };
  const raw = result && result.ranges ? result.ranges : [];
  const ranges = raw.map((r) => {
    const vr = toRange(r);
    return {
      start: { line: vr.start.line, character: vr.start.character },
      end: { line: vr.end.line, character: vr.end.character },
      text: doc.getText(vr),
    };
  });
  return {
    caret: { line: position.line, character: position.character },
    ranges,
    wordPattern: result && result.wordPattern ? String(result.wordPattern) : undefined,
  };
}

// Document links for a whole buffer (no caret marker) via VS Code's real link provider. Returns
// [{ range:{start,end}, target (fsPath), targetUri, text }] where `text` is the exact source substring
// the link covers (the path token). `target` is undefined when the provider returned no resolved URI.
async function documentLinksAt(buffer) {
  await setBuffer(buffer);
  const links = await vscode.commands.executeCommand("vscode.executeLinkProvider", doc.uri);
  return (links || []).map((l) => ({
    range: {
      start: { line: l.range.start.line, character: l.range.start.character },
      end: { line: l.range.end.line, character: l.range.end.character },
    },
    target: l.target ? l.target.fsPath : undefined,
    targetUri: l.target ? l.target.toString() : undefined,
    text: doc.getText(l.range),
  }));
}

// Rename via VS Code's real rename provider. Returns { edits } on success — each edit is
// { uri, fsPath, line, character, endCharacter, newText, text } where `text` is the OLD covered token
// (the buffer is not mutated) — or { error } when the provider rejects (e.g. an invalid new name).
async function renameAt(text, newName) {
  const { clean, position } = caretPosition(text);
  await setBuffer(clean);
  try {
    const we = await vscode.commands.executeCommand(
      "vscode.executeDocumentRenameProvider",
      doc.uri,
      position,
      newName
    );
    const edits = [];
    if (we && typeof we.entries === "function") {
      for (const [uri, tes] of we.entries()) {
        for (const te of tes) {
          edits.push({
            uri: uri.toString(),
            fsPath: uri.fsPath,
            line: te.range.start.line,
            character: te.range.start.character,
            endCharacter: te.range.end.character,
            newText: te.newText,
            text: doc.getText(te.range),
          });
        }
      }
    }
    return { edits };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

// The server's advertised legend order, used as a fallback if VS Code's legend command is unavailable.
// Keep in lock-step with XamlSemanticTokens.TokenTypes.
const SEMANTIC_TOKEN_LEGEND = ["namespace", "class", "property", "macro", "parameter"];

// Semantic tokens for a whole buffer (no caret marker) via VS Code's real semantic-tokens provider.
// Fetches the provider legend, then decodes the flat 5-int LSP delta stream into absolute tokens:
// [{ line, character, length, type (legend name), text (exact covered substring), modifiers (raw bitmask),
// modifierNames (legend names of the set bits) }]. Unlike highlights / links / selection-ranges, semantic
// tokens do NOT merge with a VS Code built-in (grammar coloring is not a semantic-tokens provider), so counts
// and classifications reflect our server alone.
function decodeSemanticTokens(result, types, mods) {
  const data = result && result.data ? Array.from(result.data) : [];
  const tokens = [];
  let line = 0;
  let character = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const deltaLine = data[i];
    const deltaChar = data[i + 1];
    const length = data[i + 2];
    const type = data[i + 3];
    const modifiers = data[i + 4];
    if (deltaLine === 0) character += deltaChar;
    else {
      line += deltaLine;
      character = deltaChar;
    }
    const range = new vscode.Range(line, character, line, character + length);
    const modifierNames = [];
    for (let b = 0; b < mods.length; b++) {
      if ((modifiers & (1 << b)) !== 0) modifierNames.push(mods[b]);
    }
    tokens.push({
      line,
      character,
      length,
      type: types[type] !== undefined ? types[type] : type,
      text: doc.getText(range),
      modifiers,
      modifierNames,
    });
  }
  return tokens;
}

async function semanticTokensAt(buffer) {
  await setBuffer(buffer);
  const legend = await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokensLegend", doc.uri);
  const result = await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokens", doc.uri);
  const types = legend && legend.tokenTypes && legend.tokenTypes.length ? legend.tokenTypes : SEMANTIC_TOKEN_LEGEND;
  const mods = legend && legend.tokenModifiers ? legend.tokenModifiers : [];
  return { legend: { tokenTypes: types, tokenModifiers: mods }, tokens: decodeSemanticTokens(result, types, mods) };
}

// Semantic tokens limited to a range via the range provider VS Code registers when the server advertises
// semanticTokensProvider.range. `range` is a plain shape { start: {line, character}, end: {line, character} }.
async function semanticTokensRangeAt(buffer, range) {
  await setBuffer(buffer);
  const vsRange = new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
  const legend = await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokensLegend", doc.uri);
  const result = await vscode.commands.executeCommand("vscode.provideDocumentRangeSemanticTokens", doc.uri, vsRange);
  const types = legend && legend.tokenTypes && legend.tokenTypes.length ? legend.tokenTypes : SEMANTIC_TOKEN_LEGEND;
  const mods = legend && legend.tokenModifiers ? legend.tokenModifiers : [];
  return { legend: { tokenTypes: types, tokenModifiers: mods }, tokens: decodeSemanticTokens(result, types, mods) };
}

// VS Code's Diagnostic.code may be a plain string or a { value, target } object; our server sends a
// plain string ("WXAML0002"). Normalize to the string form.
function codeString(code) {
  if (code == null) return "";
  return typeof code === "object" && "value" in code ? String(code.value) : String(code);
}

function rangeShape(r) {
  return {
    start: { line: r.start.line, character: r.start.character },
    end: { line: r.end.line, character: r.end.character },
  };
}

function decodeWorkspaceEdit(we) {
  const edits = [];
  if (we && typeof we.entries === "function") {
    for (const [uri, tes] of we.entries()) {
      for (const te of tes) {
        edits.push({
          uri: uri.toString(),
          fsPath: uri.fsPath,
          line: te.range.start.line,
          character: te.range.start.character,
          endLine: te.range.end.line,
          endCharacter: te.range.end.character,
          newText: te.newText,
          text: doc.getText(te.range),
        });
      }
    }
  }
  return edits;
}

// Code actions ("Did you mean …?" quick fixes) for a whole buffer (no caret marker). A code action needs
// a diagnostic to exist first, so this waits for the diagnostic identified by (matchCode[, matchText]) to
// be published, then requests actions over exactly that diagnostic's range. Returns
// { diagnostic: { code, message, range }, actions: [{ title, kind, isPreferred, edits }] }.
// NOTE: vscode.executeCodeActionProvider MERGES actions from every provider (incl. VS Code built-ins), so
// assert OUR action by title/kind rather than by array length.
// matchText should be the EXACT flagged token (what the diagnostic underlines). The wait matches on the
// diagnostic's flagged SPAN TEXT (doc.getText(range) === matchText), not merely its message: this makes the
// helper immune to a cross-test ordering race where a stale diagnostic from the previous probe (same code +
// message substring) is still published and its range now points at unrelated text in this buffer. A
// message-substring fallback is kept only for defensive robustness if a caller passes a non-literal token.
async function codeActionsAt(buffer, matchCode, matchText) {
  const byToken = (d) =>
    codeString(d.code) === matchCode && !!matchText && doc.getText(d.range) === matchText;
  const byMessage = (d) =>
    codeString(d.code) === matchCode && (!matchText || (d.message || "").includes(matchText));
  const wait = matchText ? (ds) => ds.some(byToken) : (ds) => ds.some(byMessage);
  const diags = await diagnosticsFor(buffer, wait);
  const diag = diags.find(byToken) || diags.find(byMessage);
  if (!diag) return { diagnostic: null, actions: [] };

  const raw = await vscode.commands.executeCommand(
    "vscode.executeCodeActionProvider",
    doc.uri,
    diag.range
  );
  const actions = (raw || [])
    .filter((a) => a && a.title)
    .map((a) => ({
      title: a.title,
      kind: a.kind && a.kind.value ? a.kind.value : undefined,
      isPreferred: a.isPreferred === true,
      edits: decodeWorkspaceEdit(a.edit),
    }));

  return {
    diagnostic: { code: codeString(diag.code), message: diag.message, range: rangeShape(diag.range) },
    actions,
  };
}

// Position-driven code actions at a | caret (no diagnostic required) — for the "Generate event handler 'X'"
// quick fix, which fires from the caret sitting on an event attribute value, not from a published diagnostic.
// Returns [{ title, kind, isPreferred, edits }]; assert OUR action by title/kind since
// vscode.executeCodeActionProvider MERGES actions from every provider.
async function codeActionsAtCaret(text) {
  const { clean, position } = caretPosition(text);
  await setBuffer(clean);
  const raw = await vscode.commands.executeCommand(
    "vscode.executeCodeActionProvider",
    doc.uri,
    new vscode.Range(position, position)
  );
  return (raw || [])
    .filter((a) => a && a.title)
    .map((a) => ({
      title: a.title,
      kind: a.kind && a.kind.value ? a.kind.value : undefined,
      isPreferred: a.isPreferred === true,
      edits: decodeWorkspaceEdit(a.edit),
    }));
}

module.exports = {
  FIXTURE_DIR,
  XAML_PATH,
  NS,
  openProbe,
  revertProbe,
  setBuffer,
  completionsAt,
  completionItemsAt,
  completionEditsAt,
  completionDocsAt,
  definitionsAt,
  referencesAt,
  highlightsAt,
  formatDoc,
  foldingRangesAt,
  documentColorsAt,
  colorPresentationsAt,
  selectionRangesAt,
  linkedEditingAt,
  documentLinksAt,
  renameAt,
  semanticTokensAt,
  semanticTokensRangeAt,
  codeActionsAt,
  codeActionsAtCaret,
  hoverAt,
  symbolsAt,
  flattenSymbols,
  diagnosticsFor,
  warmUp,
  delay,
  getDoc: () => doc,
};
