# WinApp Extension UX Battle-Test Harness

A Copilot-CLI-driven harness that **simulates a Windows engineer using the
[WinApp VS Code extension](https://marketplace.visualstudio.com/) to build and ship WinUI 3 apps**,
then produces a consolidated UX report. It exists to gather real user-experience data about the
extension by having an AI "developer persona" build 10 varied WinUI 3 apps and exercise the full
extension command surface, logging every bit of friction and delight.

> This directory lives inside the `WinAppVSCE` repo at `.github/skills/vsce-testing/`.

> **New sessions: read [`AGENTS.md`](./AGENTS.md) first.** It is the authoritative onboarding for the
> *validated live-drive workflow* (driving the real extension inside a live VS Code instance via the
> `driver-extension` command queue) and documents every environment gotcha. The CLI-only flow below is
> the original/legacy approach still used for the batch persona campaign.

## What it does

1. **Installs the extension** — builds the local VSIX from the repo
   (`scripts\build-vsce.ps1 -Package`) and force-installs it into VS Code.
2. **Builds 10 WinUI 3 apps** — for each app spec, it launches Copilot CLI with the
   `winui3-builder` agent acting as **"Sam," a Windows engineer trying the extension for the first
   time**. The persona:
   - scaffolds the app (`dotnet new winui|winui-navview|winui-lib|winui-unittest`),
   - opens it in VS Code (`code <dir>`) so the extension activates,
   - exercises the extension commands (Initialize Project, Restore, Update, Create MSIX Package,
     Run Application, Create Debug Identity, Generate/Install/Info Certificate, Sign, the Manifest
     commands, Run SDK Tool, Unregister, …) via the bundled `winapp` CLI the extension wraps,
   - verifies the running app with `winapp ui` (the standalone `raka` CLI is not installed),
   - and logs everything to a per-app `FEEDBACK.md` from the extension-UX point of view.
3. **Writes a report** — aggregates all feedback into `reports/FINAL-REPORT.md` with at least
   **10 constructive criticisms**, what worked well, and prioritized UX improvements.

## The 10 apps (varied structure / deps / functionality / edge cases)

See `config/apps.json`. Coverage spans blank/navview/lib/unittest templates; deps like
CommunityToolkit.Mvvm and CommunityToolkit.WinUI DataGrid; features like MVVM todo, theme-persisted
settings, async HTTP, file picker + image, app notifications; and edge cases like multi-project
workspaces, unpackaged run + `create-debug-identity`, certificate/sign chains, manifest aliases,
and `unregister` cleanup.

## Prerequisites

- Windows with VS Code (`code`), .NET SDK with WinUI templates (`dotnet new winui`), and the
  Copilot CLI (`copilot`) on PATH.
- The `winapp` CLI on PATH and the `winui3-builder` agent + winui3 skills installed.
- This directory lives inside the `WinAppVSCE` repo at `.github/skills/vsce-testing/`.

## Usage

```powershell
# Full campaign: build+install VSIX, run all 10 apps, author the report (long-running, hours)
.\run-campaign.ps1

# Smoke test a single app without reinstalling the extension
.\run-campaign.ps1 -Apps 01-counter-blank -SkipInstall -SkipReport

# Run a subset with a model override and shorter timeout
.\run-campaign.ps1 -Apps 01-counter-blank,02-todo-mvvm -Model claude-sonnet-4.5 -TimeoutMinutes 45

# Just (re)generate the report from existing per-app feedback
.\scripts\aggregate-report.ps1
```

### Useful switches
- `-SkipInstall` — use the already-installed extension (skip building the VSIX).
- `-SkipReport` — run the apps but don't author the final report.
- `-Apps <id,...>` — run a subset of app ids.
- `-TimeoutMinutes <n>` — per-app hard timeout (default 60).
- `-Model <name>` — model override for every Copilot invocation.

## Layout

```
vsce-testing/
  run-campaign.ps1              # orchestrator (install -> run apps -> report)
  config/apps.json              # the 10 app specs
  prompts/
    developer-persona.md        # the "Sam the Windows engineer" per-app prompt
    report-author.md            # the final-report synthesis prompt
  scripts/
    install-extension.ps1       # build local VSIX + code --install-extension --force
    run-developer-agent.ps1     # run Copilot/winui3-builder for one app, collect FEEDBACK
    aggregate-report.ps1        # concatenate feedback -> FINAL-REPORT.md
  workspace/<app-id>/           # generated apps + their FEEDBACK.md/SUMMARY.md (gitignored)
  logs/<app-id>/                # prompt + copilot stdout/stderr + status (gitignored)
  reports/
    per-app/<app-id>/           # collected FEEDBACK.md / SUMMARY.md / status.json
    raw-campaign-data.md        # concatenated raw feedback (report author input)
    FINAL-REPORT.md             # the deliverable
```

## How "using the extension" is simulated honestly

Two complementary mechanisms:

- **Live-drive (preferred, see [`AGENTS.md`](./AGENTS.md))** — launches a real, isolated VS Code
  instance with the installed extension plus a companion `driver-extension`, then fires the extension's
  **actual command handlers** (`vscode.commands.executeCommand` / `vscode.debug.startDebugging`) via a
  file-based command queue, while UIA (`winapp ui`) dismisses first-run modals, verifies state, and
  screenshots. This exercises the true extension UX and produces real effects (packages, certs, debug
  sessions). Note: synthetic keyboard input is blocked in this environment, so the Command Palette is
  driven programmatically, not by typing.
- **CLI persona (legacy/batch)** — the persona invokes the **same `winapp` CLI the extension commands
  wrap**, judging the VS Code surface (discoverability, prompts, error placement, onboarding). Useful
  for the long unattended 10-app campaign. Limitations are recorded in the report's methodology appendix.

## Notes

- The campaign is long-running; apps run sequentially because each spins up real builds,
  packaging, signing, and a running app that contend for the machine.
- Re-running is safe: each app uses a fresh `workspace/<id>` working directory.
