# WinApp Extension Live-Drive Test Harness

Infrastructure for launching an isolated VS Code instance with the
[WinApp extension](https://marketplace.visualstudio.com/) installed and
programmatically interacting with it to test any piece of extension
functionality live.

> This directory lives inside the `WinAppVSCE` repo at `.github/skills/vsce-testing/`.

> **Read [`AGENTS.md`](./AGENTS.md) first.** It is the authoritative onboarding for the
> validated live-drive workflow and documents every environment gotcha.

## What it does

1. **Installs the extension** — builds the local VSIX from the repo
   (`scripts\build-vsce.ps1 -Package`) and installs it into an isolated
   `--extensions-dir` so the user's global VS Code is unaffected.
2. **Launches an isolated VS Code instance** — with a fresh user-data dir,
   the driver-extension loaded, and a file-based command queue active.
3. **Drives real extension commands** — fires `winapp.*` commands
   (`certGenerate`, `pack`, `run`, `createDebugIdentity`, `init`, etc.)
   through the driver queue, dismisses first-run modals via UIA, and
   verifies real outcomes (generated certificates, MSIX packages, debugger
   sessions).
4. **Observes and screenshots** — uses `winapp ui` for UI automation
   (click, read, screenshot) to verify extension state.

## Prerequisites

- **Windows** with VS Code (`code`) on PATH.
- **.NET SDK** with WinUI templates (`dotnet new winui`).
- **Node.js** (`node`) and `npm` on PATH (used by the VSIX build scripts).
- **`winapp` CLI** on PATH.
- **C# extension** (`ms-dotnettools.csharp`) installed in `.drive-extensions`
  for F5/debugger flows.
- This directory must be inside the `WinAppVSCE` repo at
  `.github/skills/vsce-testing/`.

## Quick start

```powershell
# 1. Build and install the extension into the isolated extensions dir
.\scripts\install-extension.ps1

# 2. Smoke-test the driver mechanism
pwsh -NoProfile -File scripts\test-driver-queue.ps1 -Project <path-to-winui-project>
# PASS = "RESULT: editor=True driverDone=True certCreated=True"

# 3. Use the automation module interactively (see AGENTS.md for the full workflow)
Import-Module .\scripts\vscode-drive.psm1 -Force
$ctx = Start-VSCodeDrive -Folder <project> -OpenFile <file> -WithDriverExtension -SettleSec 24
# ... drive commands, observe, screenshot ...
Stop-VSCodeDrive -Ctx $ctx
```

## Layout

```
vsce-testing/
  AGENTS.md                     # authoritative onboarding & gotchas
  SKILL.md                      # skill metadata for Copilot discovery
  driver-extension/
    extension.js                # VS Code companion extension (queue poller + command executor)
    package.json                # extension manifest
  scripts/
    vscode-drive.psm1           # core PowerShell automation module
    install-extension.ps1       # build local VSIX + install into --extensions-dir
    drive-extension.ps1         # batch launcher for scripted step sequences
    test-driver-queue.ps1       # end-to-end smoke test
    test-vscode-drive.ps1       # complementary smoke test (focus/editor/command flow)
    launch-and-shoot.ps1        # quick launch + screenshot
    probe-f5.ps1                # F5 debug feature probe
    probe-pack.ps1              # pack feature probe
    probe-native-dialog.ps1     # native dialog automation probe
  logs/                         # driver output logs (gitignored)
  .drive-extensions/            # isolated VS Code extensions dir (gitignored)
```

## How it drives the extension

The harness launches VS Code with a companion **driver-extension** that exposes a
**file-based command queue**. Drop `req-<id>.json` into the queue directory → the
extension runs the command via `vscode.commands.executeCommand` /
`vscode.debug.startDebugging` → writes `res-<id>.json` with the result. This
exercises the **real extension command handlers** inside a live VS Code instance.

UIA (`winapp ui`) is used for clicking, reading UI state, and taking screenshots —
but NOT for typing, since synthetic keyboard input is blocked in this environment.
The `scripts/vscode-drive.psm1` module wraps all of this into a clean PowerShell API.
