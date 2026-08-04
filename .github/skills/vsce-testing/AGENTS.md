# AGENTS.md — WinApp Extension Live-Drive Harness

> **Read this first.** It is the onboarding contract for any agent/session working in
> `vsce-testing`. It encodes the *validated* way to drive the **WinApp VS Code extension**
> (`microsoft-winappcli.winapp`) inside a live VS Code instance, plus every gotcha that has already
> cost hours to rediscover. Follow the "Getting started" checklist before doing anything else.

This directory lives inside the `WinAppVSCE` repo at `.github/skills/vsce-testing/`.
It provides the infrastructure for an agent to launch an isolated VS Code instance with the WinApp
extension installed and programmatically interact with the extension to test any piece of
functionality live.

---

## TL;DR — how we actually drive the extension

Synthetic keyboard input is **blocked** in this environment, so we do **not** type into the Command
Palette. Instead we run a companion **driver-extension** (`driver-extension/`) inside the target VS
Code instance. It exposes a **file-based command queue**: we drop `req-<id>.json` into a queue dir and
it runs the real command via `vscode.commands.executeCommand` / `vscode.debug.startDebugging`, then
writes `res-<id>.json`. This drives the **real extension** and produces **real effects** (e.g.
`devcert.pfx`). UIA (`winapp ui`) is used only to *click/read* — dismiss modals, verify state,
screenshot. All of this is wrapped by `scripts/vscode-drive.psm1`.

**Validated end-to-end** by `scripts/test-driver-queue.ps1` →
`RESULT: editor=True driverDone=True certCreated=True`.

---

## Getting started (do these in order, every fresh session)

1. **Check for a stuck VS Code updater FIRST.** If fresh instances mysteriously die ~35s after
   launch, a background update is holding the InnoSetup `vscode-updating` mutex:
   ```powershell
   Get-CimInstance Win32_Process -Filter "Name LIKE 'CodeSetup%'" | Select ProcessId,CommandLine
   ```
   If a `CodeSetup-stable-*.exe` is running, every fresh `--user-data-dir` launch waits 30s then
   exits with `Error: Code is currently being updated`. Wait for it to finish (build hash under
   `%LOCALAPPDATA%\Programs\Microsoft VS Code` changes) or let the user complete it. Reusing an
   already-open instance is unaffected — only *fresh-profile* launches are blocked.

2. **Ensure the winapp extension is installed into the isolated extensions dir** (NOT the user's
   global VS Code). A fresh `--user-data-dir` still uses the shared global extensions dir, so we
   pin our own `--extensions-dir=.drive-extensions`:
   ```powershell
   code --extensions-dir="$PWD\.drive-extensions" --list-extensions --show-versions
   # expect: microsoft-winappcli.winapp@<version>
   ```
   If missing, (re)build + install:
   ```powershell
   # From the repo root (4 levels up from this skill directory):
   $repoRoot = Resolve-Path "$PSScriptRoot\..\..\..\.."
   & "$repoRoot\scripts\build-vsce.ps1" -Package
   $vsix = Get-ChildItem "$repoRoot\artifacts\*.vsix" | sort LastWriteTime -desc | select -First 1
   code --extensions-dir="$PWD\.drive-extensions" --install-extension $vsix.FullName --force
   ```
   `Start-VSCodeDrive` auto-adds `--extensions-dir=.drive-extensions` when that dir exists.

3. **Sanity-check the mechanism** before doing real work:
   ```powershell
   pwsh -NoProfile -File scripts\test-driver-queue.ps1 -Project <path-to-a-winui-project>
   # PASS = "RESULT: editor=True driverDone=True certCreated=True"
   ```

---

## The canonical live-drive workflow

```powershell
Import-Module .\scripts\vscode-drive.psm1 -Force
$proj = "<path-to-your-winui-project>"
$file = "$proj\App.xaml.cs"

# 1. Launch an isolated, live instance WITH the driver-extension + command queue.
$ctx = Start-VSCodeDrive -Folder $proj -OpenFile $file -WithDriverExtension -SettleSec 24

# 2. Focus + clear the first-run modals, then confirm we're on the editor.
Set-VSCodeFocus -Ctx $ctx | Out-Null
$onEditor = Confirm-VSCodeEditor -Ctx $ctx -OpenFileIfNeeded $file

# 3. Push REAL extension commands to the LIVE instance and verify their effects.
Invoke-VSCodeDriverCommand -Ctx $ctx -CommandId 'winapp.certGenerate' -Answers @(@{accept=$true})
Invoke-VSCodeDriverDebug   -Ctx $ctx -InputFolder "$proj\bin\x64\Debug\net8.0-windows10.0.19041.0\win-x64"
Invoke-VSCodeDriverOpenFile -Ctx $ctx -Path "$proj\Package.appxmanifest"

# 4. Observe: screenshot the integrated terminal / editor.
winapp ui screenshot -w $ctx.Hwnd -o .\logs\step.png

# 5. Always tear down (removes the udd + queue dir).
Stop-VSCodeDrive -Ctx $ctx
```

**Discipline before every action: focus → verify page → act.** Never fire a command while a blocking
modal is up. `Confirm-VSCodeEditor` handles that; if you act manually, call `Clear-VSCodeOverlays` first.

---

## Hard-won gotchas (do not relearn these)

- **Synthetic keyboard injection is blocked environment-wide.** `SendInput` returns success but
  reaches NO window (proven vs Notepad AND VS Code). The Command Palette (type-to-filter) cannot be
  driven. `Send-VSCodeText/Chord/Key` and `Invoke-VSCodeCommand` exist but are **non-functional here**
  — use the driver queue instead.
- **`winapp ui set-value` is a no-op on VS Code inputs** (Monaco/contentEditable). There is no way to
  type into VS Code inputs; commands needing a free-text `showInputBox` can't be auto-answered.
- **`winapp ui invoke`/`click`/`search`/`screenshot` DO work** (UIA, no foreground needed). This is
  the usable "interact with controls" layer.
- **Match OUR window strictly by the `(Code, PID <n>)` tag.** `winapp ui list-windows` WRAPS long
  lines — flatten whitespace first. NEVER title-match on "Visual Studio Code": the user's browser
  tabs (e.g. *"Publishing Extensions | Visual Studio Code Extension API"*, shown as explorer
  TabProxyWindows) contain that phrase and get falsely selected — which leaves the real sign-in modal
  up. `Get-VSCodeWindow` already does this correctly.
- **VS Code windows only appear in the UIA tree with `--force-renderer-accessibility`** (already passed
  by `Start-VSCodeDrive`).
- **First-run modals on a fresh udd (in order), even with seeded settings:**
  1. *"Sign in to use GitHub Copilot"* **modal** → click **"Continue without Signing In"**
     (`Close-VSCodeSignIn`). Window survives. **Always do this before firing commands.**
  2. *"Make It Yours"* **walkthrough** modal overlay (color-theme picker) → click its OWN close × whose
     y-coordinate is **>100** (`Close-VSCodeWalkthrough`). NEVER the title-bar × (y<~80) — that
     destroys the whole instance.
- **Editor detection:** `workbench.parts.editor` only shows at UIA `inspect --depth 12+`; instead we
  cheaply search for the open file's tab basename (stored in `$ctx.EditorFile`).
- **`code --reuse-window --goto` MUST include `--user-data-dir=$ctx.Udd`** or it targets the default
  profile, not our drive instance.
- **Extension commands run fire-and-forget in an integrated terminal** (`terminal.sendText`).
  `executeCommand` returns before the CLI finishes — **poll for the effect** (e.g. `devcert.pfx`), do
  not check immediately.
- **`command 'winapp.certGenerate' not found`** means the winapp extension isn't loaded in that
  instance → fix the `--extensions-dir` (step 2 above), it's not a code bug.
- **Process-kill safety:** only `Stop-Process -Id <PID>` for OUR instances (match `drive-udd-*` /
  `.diag-*` in the cmdline, or orphaned helpers whose parent is dead — e.g. a leaked
  `dotnet.exe` Roslyn BuildHost holding `exthost.log`). NEVER kill the user's VS Code, the node
  runtime, or Notepad (Win11 Notepad is single-process; PID-killing it closes the user's tabs).

---

## Driver command IDs & answer schemas

Real command IDs: `winapp.getWinappPath`, `winapp.init`, `winapp.restore`, `winapp.manifestGenerate`,
`winapp.certGenerate`, `winapp.pack`, `winapp.run`, `winapp.createDebugIdentity`, `winapp.sign`,
`winapp.certInstall`, `winapp.unregister`, `winapp.manifestAddAlias`, …

For commands that accept programmatic arguments, pass `-CommandArgs`. For example,
`winapp.tool` can be driven without automating its free-text inputs:
```powershell
Invoke-VSCodeDriverCommand -Ctx $ctx -CommandId 'winapp.tool' `
  -CommandArgs @(@{toolName='makeappx'; argumentText='/?'})
```

Answers (ordered, one per prompt the command raises):
- `@{accept=$true}` — accept the selected QuickPick item (e.g. certGenerate's Install Yes/No).
- `@{nativeDialogPath='<path>'}` — a `showOpenDialog` folder picker (pack/run).
  Only typed when a `#32770` native dialog is foreground; a Chromium dialog is `SKIPPED`.
- `@{nativeFileDialogPath='<path>'}` — a `showOpenDialog` file picker (createDebugIdentity,
  sign, certInstall). Targets the `File name:` edit field and clicks `Open`.
- Free-text `showInputBox` prompts (e.g. cert password) **cannot** be auto-answered — avoid or accept
  defaults.

`debug` steps use `launch.json`'s `inputFolder` (the app's built `win-x64` output). No dialogs.

---

## Learned behaviors — pack / sign / F5

- **Native folder dialogs ARE now automatable via UIA.** `SendKeys` is blocked, but
  `winapp ui set-value` **does** work on the native `#32770` "Folder:" edit (unlike Monaco). The
  driver's `typeIntoNativeDialog` (extension.js) was rewritten to: poll for a foreground `#32770`,
  resolve the "Folder:" Edit slug via `set-value`'s own disambiguation output, `set-value` the path,
  then `winapp ui invoke "Select Folder"`. This unblocked pack/run/createDebugIdentity/F5-packaging.
- **`winapp.pack` needs the BUILD-OUTPUT folder** (`bin\…\win-x64`, containing the `.exe`), NOT the
  project source folder (the dialog's default). Wrong folder ⇒ *"no .exe files were found in the
  input folder."* Pack then raises **two** QuickPicks: "Generate and install a development
  certificate?" and "Bundle Windows App SDK runtime (self-contained)?" → answer order for the driver
  is `@(@{nativeDialogPath=$buildOutput}, @{accept=$true}, @{accept=$true})`.
- **Pack is slow + fire-and-forget.** The driver returns `done` in ~11s but `winapp pack` keeps
  building in the terminal; **poll for the MSIX** (up to ~2 min). Output lands at
  `<proj>\.winapp\self-contained\<arch>\extracted\MSIX\Main.msix` (hidden, generically named).
- **F5 / `Invoke-VSCodeDriverDebug` works** with a valid `launch.json` `inputFolder` = the `win-x64`
  build output containing the exe: `sessionEvents` shows `start:coreclr:…` and the app process comes
  up. NOTE `startDebugging` returns **false** even on success — key on `launched` (a `start:coreclr`
  event), not `started`. If `inputFolder` is empty/wrong, F5 silently falls back to the pack folder
  picker.
- **The WinApp debugger requires `ms-dotnettools.csharp`** (coreclr) — install it into
  `.drive-extensions` too: `code --extensions-dir=.drive-extensions
  --install-extension ms-dotnettools.csharp`. Without it F5 shows an "Install Extension" prompt.
- **`sign` uses a FILE picker** ("Select file to sign", button "Open"), not a folder picker — use
  `@{nativeFileDialogPath='<path-to-msix>'}` to answer it. The `createDebugIdentity` command also
  uses a file picker ("Select executable") — use `@{nativeFileDialogPath='<path-to-exe>'}`.

---

## Key files

- `scripts/vscode-drive.psm1` — the automation module. Working: `Start-VSCodeDrive`,
  `Set-VSCodeFocus`, `Get-VSCodeState`, `Close-VSCodeSignIn`, `Clear-VSCodeOverlays`,
  `Close-VSCodeWalkthrough`, `Confirm-VSCodeEditor`, `Invoke-VSCodeElement`, and the RELIABLE
  `Invoke-VSCodeDriver{Step,Command,Debug,OpenFile}`. `Stop-VSCodeDrive` cleans up.
- `driver-extension/extension.js` — the in-VS-Code driver: `startQueuePoller()` watches
  `WINAPP_UX_QUEUE\req-*.json`; also runs a one-shot batch from `WINAPP_UX_SCRIPT`.
- `driver-extension/command-step.js` — executes command steps, supplies arguments and prompt answers,
  and optionally tracks the exact launched task through VS Code task-completion events with a timeout.
- `driver-extension/command-step.test.js` — unit tests for command execution, answer handling, exact
  task-event correlation, cancellation, and timeout behavior.
- `scripts/vscode-drive.test.ps1` — tests driver timeout calculation and command-plan serialization,
  plus the tool-injection probe's path escaping.
- `scripts/test-driver-queue.ps1` — end-to-end validation (run to confirm the mechanism works).
- `scripts/test-vscode-drive.ps1` — complementary smoke test: launches VS Code, verifies focus/editor,
  then exercises the queue-based command flow via `Invoke-VSCodeDriverCommand`.
- `scripts/drive-extension.ps1` — batch launcher (`WINAPP_UX_SCRIPT`) for running scripted step
  sequences.
- `scripts/install-extension.ps1` — builds the local VSIX and installs it into VS Code.
- `scripts/probe-*.ps1` — targeted probes for specific features (F5 debug, pack, native dialogs).
- `scripts/probe-tool-injection.ps1` — manual Windows/VS Code probe that waits for SDK-tool task
  completion, verifies an argument-dependent artifact, and checks that shell-injection text has no
  effect. The non-UI command registration, process adapter, and driver `commandArgs` transport tests
  run under `npm run test:unit`; the live probe remains manual because it requires an interactive
  desktop, an isolated VS Code instance, and an installed Windows SDK.
- `.drive-extensions/` — isolated extensions dir holding the installed winapp extension.
