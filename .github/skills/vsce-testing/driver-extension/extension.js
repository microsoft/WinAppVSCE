const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const LOG_DIR = path.join(__dirname, '..', 'logs');

function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} }
function appendLog(file, line) { ensureDir(LOG_DIR); try { fs.appendFileSync(path.join(LOG_DIR, file), line + '\n'); } catch (e) {} }
function writeLog(file, data) { ensureDir(LOG_DIR); try { fs.writeFileSync(path.join(LOG_DIR, file), typeof data === 'string' ? data : JSON.stringify(data, null, 2)); } catch (e) {} }
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ---- Native-dialog folder selection via UIA (winapp ui) — SendKeys is blocked in this env. ----
// When a Win32 folder picker (#32770) is foreground we resolve its HWND, set the "Folder:" edit
// via UIA ValuePattern (winapp ui set-value), then invoke "Select Folder". This is reliable where
// synthetic keyboard input (SendInput/SendKeys) silently reaches no window.
function typeIntoNativeDialog(text) {
  return new Promise((resolve) => {
    const escaped = text.replace(/'/g, "''");
    const ps = `
$sig = @'
using System;
using System.Runtime.InteropServices;
public class FG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
}
'@
Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue
function Get-FgInfo {
  $h = [FG]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 256
  [void][FG]::GetClassName($h, $sb, 256)
  return [pscustomobject]@{ Hwnd = [int64]$h; Class = $sb.ToString() }
}
# Poll up to ~15s for a native Win32 dialog (#32770) to become foreground.
$fg = $null
for ($i = 0; $i -lt 30; $i++) {
  $fg = Get-FgInfo
  if ($fg.Class -eq '#32770') { break }
  Start-Sleep -Milliseconds 500
}
if ($fg.Class -ne '#32770') { Write-Output "SKIPPED:$($fg.Class)"; return }
$hwnd = $fg.Hwnd
Start-Sleep -Milliseconds 300
# Resolve the "Folder:" path edit slug via set-value's own disambiguation output.
$editSlug = $null
$sv = winapp ui set-value -w $hwnd "Folder:" '${escaped}' 2>&1 | Out-String
foreach ($ln in ($sv -split "\r?\n")) {
  if ($ln -match 'Edit "Folder:".*->\\s*(\\S+)') { $editSlug = $Matches[1].Trim(); break }
}
if ($editSlug) {
  winapp ui set-value -w $hwnd $editSlug '${escaped}' 2>&1 | Out-Null
} elseif ($sv -notmatch 'matched') {
  # single match already set it
}
Start-Sleep -Milliseconds 400
$inv = winapp ui invoke -w $hwnd "Select Folder" 2>&1 | Out-String
Write-Output "UIA_SET:$hwnd editSlug=$editSlug invoke=$($inv.Trim())"
`;
    try {
      const child = cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
      let out = '';
      child.stdout.on('data', d => out += d.toString());
      child.stderr.on('data', d => out += d.toString());
      child.on('close', () => resolve(out.trim()));
      child.on('error', e => resolve('ERROR:' + String(e)));
    } catch (e) { resolve('ERROR:' + String(e)); }
  });
}

async function acceptQuickInput() {
  try { await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem'); return 'accepted'; }
  catch (e) { return 'accept-error:' + String(e); }
}

// Run a single command step. Invokes the command WITHOUT awaiting (it blocks on its own prompts),
// then answers prompts in order: {accept:true} for QuickPick, {nativeDialogPath} for showOpenDialog.
async function runCommandStep(step, result) {
  const settle = step.settleMs || 1600;
  appendLog('driver-run.log', `command: ${step.command}`);
  Promise.resolve(vscode.commands.executeCommand(step.command)).catch(e => appendLog('driver-run.log', `cmd ${step.command} threw: ${e}`));
  const answers = step.answers || [];
  const log = { type: 'command', command: step.command, answers: [] };
  for (const a of answers) {
    await delay(settle);
    if (a.nativeDialogPath) {
      const r = await typeIntoNativeDialog(a.nativeDialogPath);
      log.answers.push({ kind: 'nativeDialog', path: a.nativeDialogPath, dialogResult: r });
    } else if (a.accept) {
      const r = await acceptQuickInput();
      log.answers.push({ kind: 'accept', result: r });
    }
  }
  await delay(step.afterMs || 4000);
  result.steps.push(log);
}

function writeLaunchJson(folderPath, inputFolder, name) {
  try {
    const vscodeDir = path.join(folderPath, '.vscode');
    ensureDir(vscodeDir);
    const launch = {
      version: '0.2.0',
      configurations: [{
        type: 'winapp',
        request: 'launch',
        name: name || 'WinApp: Launch and Attach',
        debuggerType: 'coreclr',
        inputFolder: inputFolder
      }]
    };
    fs.writeFileSync(path.join(vscodeDir, 'launch.json'), JSON.stringify(launch, null, 2));
    return launch.configurations[0];
  } catch (e) { return null; }
}

async function runDebugStep(step, result) {
  appendLog('driver-run.log', `debug: inputFolder=${step.inputFolder}`);
  const folder = (vscode.workspace.workspaceFolders || [])[0];
  const diag = {};
  const ext = vscode.extensions.getExtension('microsoft-winappcli.winapp')
    || vscode.extensions.getExtension('Microsoft-WinAppCLI.winapp');
  diag.extFound = !!ext;
  if (ext && !ext.isActive) { try { await ext.activate(); diag.activatedNow = true; } catch (e) { diag.activateErr = String(e); } }
  diag.extActive = ext ? ext.isActive : false;
  // Give the debug adapter factory a moment to register after activation.
  await delay(1500);

  const sessionEvents = [];
  const d1 = vscode.debug.onDidStartDebugSession(s => sessionEvents.push('start:' + s.type + ':' + s.name));
  const d2 = vscode.debug.onDidTerminateDebugSession(s => sessionEvents.push('terminate:' + s.type + ':' + s.name));

  const config = {
    type: 'winapp',
    request: 'launch',
    name: step.name || 'WinApp: Launch and Attach',
    debuggerType: 'coreclr',
    inputFolder: step.inputFolder
  };
  if (folder && step.writeLaunch !== false) writeLaunchJson(folder.uri.fsPath, step.inputFolder, config.name);
  let started = false, err = null;
  // The winapp debugger packages the app before launch, which raises a native
  // "Select input folder to package" folder picker (+ a cert QuickPick). Answer them
  // concurrently: kick off the dialog answerer, then start debugging.
  let dialogResult = null;
  if (step.answerDialogs !== false) {
    (async () => {
      dialogResult = await typeIntoNativeDialog(step.inputFolder);
      // A cert QuickPick ("Generate and install a development certificate?") may follow.
      await delay(1500);
      try { await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem'); } catch (e) {}
    })();
  }
  try { started = await vscode.debug.startDebugging(folder, config); }
  catch (e) { err = String(e); }
  // Wait briefly to see whether the coreclr child session (i.e. the app launch) appeared.
  await delay(3000);
  let launched = sessionEvents.some(e => e.startsWith('start:coreclr'));
  if (!started && !launched) {
    await delay(2000);
    try { started = await vscode.debug.startDebugging(folder, config); diag.retried = true; }
    catch (e) { err = (err ? err + ' | ' : '') + String(e); }
  }
  await delay(step.afterMs || 8000);
  const session = vscode.debug.activeDebugSession;
  // A coreclr child session starting indicates the app launched + attach was attempted.
  launched = sessionEvents.some(e => e.startsWith('start:coreclr'));
  d1.dispose(); d2.dispose();
  result.steps.push({ type: 'debug', inputFolder: step.inputFolder, started, launched, activeSession: session ? session.name : null, error: err, diag, dialogResult, sessionEvents });
}

async function stopDebugStep(step, result) {
  let err = null;
  try { await vscode.commands.executeCommand('workbench.action.debug.stop'); } catch (e) { err = String(e); }
  await delay(1500);
  result.steps.push({ type: 'stopDebug', error: err });
}

async function openManifestStep(step, result) {
  let err = null;
  try {
    const uri = vscode.Uri.file(step.path);
    await vscode.commands.executeCommand('vscode.open', uri);
  } catch (e) { err = String(e); }
  await delay(step.afterMs || 2500);
  result.steps.push({ type: 'openManifest', path: step.path, error: err });
}

async function openFileStep(step, result) {
  let err = null;
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(step.path));
    await vscode.window.showTextDocument(doc);
  } catch (e) { err = String(e); }
  await delay(step.afterMs || 1500);
  result.steps.push({ type: 'openFile', path: step.path, error: err });
}

function requireActiveEditor() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) throw new Error('No active text editor');
  return editor;
}

function toPosition(line, character) {
  return new vscode.Position(line || 0, character || 0);
}

function normalizeMarkdown(value) {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value.value === 'string') return value.value;
  return String(value);
}

function normalizeCompletionItems(list, maxItems) {
  const items = (list && Array.isArray(list.items) ? list.items : list || []).slice(0, maxItems || 25);
  return items.map(item => ({
    label: typeof item.label === 'string' ? item.label : item.label?.label,
    detail: item.detail,
    documentation: normalizeMarkdown(item.documentation),
    insertText: typeof item.insertText === 'string'
      ? item.insertText
      : typeof item.insertText?.value === 'string'
        ? item.insertText.value
        : undefined,
    kind: item.kind,
    sortText: item.sortText
  }));
}

function normalizeHoverContents(hover) {
  if (!hover) return [];
  return (hover.contents || []).map(c => {
    if (typeof c === 'string') return c;
    if (typeof c.value === 'string') return c.value;
    if (typeof c.language === 'string' && typeof c.value === 'string') return `\`\`\`${c.language}\n${c.value}\n\`\`\``;
    return String(c);
  });
}

function normalizeDefinition(definition) {
  const entries = Array.isArray(definition) ? definition : definition ? [definition] : [];
  return entries.map(entry => {
    const target = entry.targetUri ? {
      uri: entry.targetUri.fsPath || entry.targetUri.toString(),
      start: entry.targetSelectionRange?.start || entry.targetRange?.start,
      end: entry.targetSelectionRange?.end || entry.targetRange?.end
    } : {
      uri: entry.uri?.fsPath || entry.uri?.toString(),
      start: entry.range?.start,
      end: entry.range?.end
    };
    return {
      uri: target.uri,
      start: target.start ? { line: target.start.line, character: target.start.character } : undefined,
      end: target.end ? { line: target.end.line, character: target.end.character } : undefined
    };
  });
}

function resolveCommandArg(arg) {
  if (!arg || typeof arg !== 'object' || Array.isArray(arg)) {
    return arg;
  }
  switch (arg.kind) {
    case 'activeDocumentUri':
      return requireActiveEditor().document.uri;
    case 'fileUri':
      return vscode.Uri.file(arg.path);
    case 'position':
      return toPosition(arg.line, arg.character);
    default:
      return arg;
  }
}

async function setSelectionStep(step, result) {
  const editor = requireActiveEditor();
  const anchor = toPosition(step.anchorLine ?? step.line ?? 0, step.anchorCharacter ?? step.character ?? 0);
  const active = toPosition(step.activeLine ?? step.line ?? 0, step.activeCharacter ?? step.character ?? 0);
  editor.selection = new vscode.Selection(anchor, active);
  editor.revealRange(new vscode.Range(active, active), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  await delay(step.afterMs || 300);
  result.steps.push({
    type: 'setSelection',
    anchor: { line: anchor.line, character: anchor.character },
    active: { line: active.line, character: active.character }
  });
}

async function setDocumentTextStep(step, result) {
  const editor = requireActiveEditor();
  const fullRange = new vscode.Range(
    editor.document.positionAt(0),
    editor.document.positionAt(editor.document.getText().length)
  );
  const ok = await editor.edit(editBuilder => {
    editBuilder.replace(fullRange, step.text || '');
  });
  if (!ok) throw new Error('Failed to replace active document text');
  await delay(step.afterMs || 400);
  result.steps.push({ type: 'setDocumentText', length: (step.text || '').length });
}

async function replaceTextStep(step, result) {
  const editor = requireActiveEditor();
  const existing = editor.document.getText();
  const updated = existing.replace(new RegExp(step.pattern, step.flags || ''), step.replacement || '');
  if (updated === existing) {
    result.steps.push({ type: 'replaceText', replaced: false, pattern: step.pattern });
    return;
  }
  const fullRange = new vscode.Range(
    editor.document.positionAt(0),
    editor.document.positionAt(existing.length)
  );
  const ok = await editor.edit(editBuilder => {
    editBuilder.replace(fullRange, updated);
  });
  if (!ok) throw new Error('Failed to apply replaceText edit');
  await delay(step.afterMs || 400);
  result.steps.push({ type: 'replaceText', replaced: true, pattern: step.pattern });
}

async function saveDocumentStep(step, result) {
  const editor = requireActiveEditor();
  const saved = await editor.document.save();
  await delay(step.afterMs || 400);
  result.steps.push({ type: 'saveDocument', saved });
}

async function commandArgsStep(step, result) {
  let err = null;
  let value = null;
  try {
    value = await vscode.commands.executeCommand(step.command, ...(step.args || []).map(resolveCommandArg));
  } catch (e) {
    err = String(e);
  }
  await delay(step.afterMs || 800);
  result.steps.push({ type: 'commandArgs', command: step.command, result: value, error: err });
}

async function queryCompletionsStep(step, result) {
  const editor = requireActiveEditor();
  const position = toPosition(step.line, step.character);
  const list = await vscode.commands.executeCommand(
    'vscode.executeCompletionItemProvider',
    editor.document.uri,
    position,
    step.triggerCharacter,
    step.itemResolveCount || 50
  );
  result.steps.push({
    type: 'queryCompletions',
    line: position.line,
    character: position.character,
    items: normalizeCompletionItems(list, step.maxItems || 25)
  });
}

async function queryHoverStep(step, result) {
  const editor = requireActiveEditor();
  const position = toPosition(step.line, step.character);
  const hovers = await vscode.commands.executeCommand(
    'vscode.executeHoverProvider',
    editor.document.uri,
    position
  );
  result.steps.push({
    type: 'queryHover',
    line: position.line,
    character: position.character,
    hovers: (hovers || []).map(h => ({ contents: normalizeHoverContents(h) }))
  });
}

async function queryDefinitionStep(step, result) {
  const editor = requireActiveEditor();
  const position = toPosition(step.line, step.character);
  const definition = await vscode.commands.executeCommand(
    'vscode.executeDefinitionProvider',
    editor.document.uri,
    position
  );
  result.steps.push({
    type: 'queryDefinition',
    line: position.line,
    character: position.character,
    definitions: normalizeDefinition(definition)
  });
}

async function queryDiagnosticsStep(step, result) {
  const editor = requireActiveEditor();
  const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
  result.steps.push({
    type: 'queryDiagnostics',
    diagnostics: diagnostics.map(d => ({
      message: d.message,
      severity: d.severity,
      source: d.source,
      start: { line: d.range.start.line, character: d.range.start.character },
      end: { line: d.range.end.line, character: d.range.end.character }
    }))
  });
}

async function triggerSuggestStep(step, result) {
  await setSelectionStep(step, result);
  await vscode.commands.executeCommand('editor.action.triggerSuggest');
  await delay(step.afterMs || 1200);
  result.steps.push({ type: 'triggerSuggest' });
}

async function showHoverStep(step, result) {
  await setSelectionStep(step, result);
  await vscode.commands.executeCommand('editor.action.showHover');
  await delay(step.afterMs || 1200);
  result.steps.push({ type: 'showHover' });
}

async function revealDefinitionStep(step, result) {
  await setSelectionStep(step, result);
  await vscode.commands.executeCommand('editor.action.revealDefinition');
  await delay(step.afterMs || 1500);
  result.steps.push({ type: 'revealDefinition' });
}

async function runStep(step, result) {
  switch (step.type) {
    case 'command': await runCommandStep(step, result); break;
    case 'debug': await runDebugStep(step, result); break;
    case 'stopDebug': await stopDebugStep(step, result); break;
    case 'openManifest': await openManifestStep(step, result); break;
    case 'openFile': await openFileStep(step, result); break;
    case 'setSelection': await setSelectionStep(step, result); break;
    case 'setDocumentText': await setDocumentTextStep(step, result); break;
    case 'replaceText': await replaceTextStep(step, result); break;
    case 'saveDocument': await saveDocumentStep(step, result); break;
    case 'commandArgs': await commandArgsStep(step, result); break;
    case 'queryCompletions': await queryCompletionsStep(step, result); break;
    case 'queryHover': await queryHoverStep(step, result); break;
    case 'queryDefinition': await queryDefinitionStep(step, result); break;
    case 'queryDiagnostics': await queryDiagnosticsStep(step, result); break;
    case 'triggerSuggest': await triggerSuggestStep(step, result); break;
    case 'showHover': await showHoverStep(step, result); break;
    case 'revealDefinition': await revealDefinitionStep(step, result); break;
    case 'wait': await delay(step.ms || 1000); result.steps.push({ type: 'wait', ms: step.ms }); break;
    default: result.steps.push({ type: step.type, error: 'unknown step type' });
  }
}

// ---- Dynamic command QUEUE ----
// Lets an external driver (vscode-drive.psm1) push commands to a LIVE instance on demand.
// Watches <WINAPP_UX_QUEUE>\req-*.json; runs each once; writes <queue>\res-<id>.json and
// renames the request to *.done so it is not re-run.
function startQueuePoller() {
  const queueDir = process.env.WINAPP_UX_QUEUE;
  if (!queueDir) return;
  ensureDir(queueDir);
  appendLog('driver-run.log', 'queue poller watching ' + queueDir);
  const seen = new Set();
  let busy = false;
  const tick = async () => {
    if (busy) return;
    let files = [];
    try { files = fs.readdirSync(queueDir).filter(f => /^req-.*\.json$/.test(f)); } catch (e) { return; }
    files.sort();
    for (const f of files) {
      if (seen.has(f)) continue;
      seen.add(f);
      busy = true;
      const full = path.join(queueDir, f);
      let step;
      try { step = JSON.parse(fs.readFileSync(full, 'utf8')); }
      catch (e) { appendLog('driver-run.log', 'bad queue req ' + f + ': ' + e); busy = false; continue; }
      const id = step.id || f.replace(/^req-|\.json$/g, '');
      const result = { id, label: 'queue:' + id, startedAt: new Date().toISOString(), steps: [] };
      appendLog('driver-run.log', `queue run ${id}: ${step.type} ${step.command || step.inputFolder || ''}`);
      try { await runStep(step, result); }
      catch (e) { result.steps.push({ type: step.type, error: String(e) }); }
      result.finishedAt = new Date().toISOString();
      result.done = true;
      try { fs.writeFileSync(path.join(queueDir, `res-${id}.json`), JSON.stringify(result, null, 2)); } catch (e) {}
      try { fs.renameSync(full, full + '.done'); } catch (e) {}
      busy = false;
    }
  };
  setInterval(() => { tick().catch(e => appendLog('driver-run.log', 'queue tick err ' + e)); }, 500);
}

async function runScript() {
  const scriptPath = process.env.WINAPP_UX_SCRIPT;
  if (!scriptPath || !fs.existsSync(scriptPath)) {
    appendLog('driver-run.log', 'no script at ' + scriptPath);
    return;
  }
  let script;
  try { script = JSON.parse(fs.readFileSync(scriptPath, 'utf8')); }
  catch (e) { appendLog('driver-run.log', 'bad script json: ' + e); return; }

  const label = script.label || 'run';
  const result = { label, startedAt: new Date().toISOString(), steps: [] };
  appendLog('driver-run.log', `=== run ${label} (${(script.steps || []).length} steps) ===`);
  vscode.window.showInformationMessage(`WinApp UX Driver: running ${label}`);

  for (const step of (script.steps || [])) {
    try {
      await runStep(step, result);
    } catch (e) {
      result.steps.push({ type: step.type, error: String(e) });
    }
    writeLog(`driver-result-${label}.json`, result);
  }
  result.finishedAt = new Date().toISOString();
  result.done = true;
  writeLog(`driver-result-${label}.json`, result);
  appendLog('driver-run.log', `=== done ${label} ===`);
  vscode.window.showInformationMessage(`WinApp UX Driver: done ${label}`);
}

function activate(context) {
  appendLog('driver-activate.log', new Date().toISOString() + ' activated; SCRIPT=' + process.env.WINAPP_UX_SCRIPT + ' QUEUE=' + process.env.WINAPP_UX_QUEUE);
  context.subscriptions.push(vscode.commands.registerCommand('winappUxDriver.runScript', runScript));
  context.subscriptions.push(vscode.commands.registerCommand('winappUxDriver.probePrompts', () => runScript()));
  startQueuePoller();
  if (process.env.WINAPP_UX_SCRIPT) {
    setTimeout(() => { runScript().catch(e => appendLog('driver-run.log', 'fatal ' + String(e))); }, 4000);
  }
}
function deactivate() {}
module.exports = { activate, deactivate };
