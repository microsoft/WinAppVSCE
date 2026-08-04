#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Drive the REAL WinApp VS Code extension through VS Code, using the companion driver extension.
.DESCRIPTION
    Launches a fresh, isolated VS Code instance that loads the installed WinApp extension PLUS the
    local "winapp-ux-driver" extension. The driver reads a script (JSON) describing extension
    operations to perform IN VS Code and executes them visibly:
      * command   - invokes a winapp.* palette command and auto-answers its prompts
      * debug     - launches the app via the WinApp DEBUGGER (vscode.debug.startDebugging)
      * openManifest / openFile - opens editors (manifest opens the custom webview)
      * stopDebug / wait
    Results (per-step success/error, debug launch + session events) are written to
    logs\driver-result-<label>.json. This script waits for completion and prints that JSON.

    SCRIPT (steps) SCHEMA - write this with the app's real paths, then pass via -ScriptJson:
    {
      "label": "01-counter-blank",
      "steps": [
        { "type":"command", "command":"winapp.getWinappPath",
          "answers":[ {"accept":true} ] },                       // accept = pick highlighted QuickPick item
        { "type":"command", "command":"winapp.certGenerate",
          "answers":[ {"accept":true} ] },
        { "type":"command", "command":"winapp.pack",
          "answers":[ {"nativeDialogPath":"C:\\...\\win-x64"},     // types path into native folder dialog
                      {"accept":true}, {"accept":true} ] },
        { "type":"openManifest", "path":"C:\\...\\Package.appxmanifest" },
        { "type":"debug", "inputFolder":"C:\\...\\bin\\...\\win-x64", "name":"WinApp: Launch and Attach" },
        { "type":"wait", "ms":4000 },
        { "type":"stopDebug" }
      ]
    }
    NOTES on answers (verified empirically):
      - QuickPick prompts: {"accept":true} accepts the HIGHLIGHTED (first/default) item. There is no
        reliable way to type-filter, so list answers in prompt order and rely on sensible defaults.
      - showInputBox prompts (winapp.tool args, winapp.certInfo password) CANNOT be auto-typed - skip them.
      - showOpenDialog prompts (winapp.pack/run/createDebugIdentity) use {"nativeDialogPath":...};
        the driver SendKeys the path ONLY when a Win32 dialog (#32770) is foreground (guarded).
      - The WinApp debugger launches the app but its coreclr attach currently detaches immediately
        (report this); the app itself stays running.
.PARAMETER Project
    Folder to open in VS Code (the WinUI project root).
.PARAMETER ScriptJson
    Path to the steps JSON described above.
.PARAMETER TimeoutSec
    Max seconds to wait for the driver to finish. Default 240.
#>
param(
    [Parameter(Mandatory = $true)][string]$Project,
    [Parameter(Mandatory = $true)][string]$ScriptJson,
    [int]$TimeoutSec = 420
)
$ErrorActionPreference = "Stop"
$Harness = Split-Path $PSScriptRoot -Parent
$Driver  = Join-Path $Harness "driver-extension"
$LogDir  = Join-Path $Harness "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if (-not (Test-Path $ScriptJson)) { throw "ScriptJson not found: $ScriptJson" }
if (-not (Test-Path $Project))    { throw "Project not found: $Project" }

$script = Get-Content $ScriptJson -Raw | ConvertFrom-Json
$label  = if ($script.label) { $script.label } else { "run" }
$resultFile = Join-Path $LogDir "driver-result-$label.json"
Remove-Item $resultFile -ErrorAction SilentlyContinue

$code = (Get-Command code -ErrorAction SilentlyContinue).Source
if (-not $code) { throw "VS Code 'code' CLI not found on PATH." }

# Fresh user-data-dir so this process inherits WINAPP_UX_SCRIPT (a reused VS Code main process would not).
$udd = Join-Path $Harness (".udd-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$env:WINAPP_UX_SCRIPT = $ScriptJson

Write-Host "==> [drive:$label] launching VS Code with driver extension" -ForegroundColor Cyan
& $code --user-data-dir=$udd --disable-workspace-trust --extensionDevelopmentPath=$Driver $Project | Out-Null

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$done = $false
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 4
    if (Test-Path $resultFile) {
        try {
            $r = Get-Content $resultFile -Raw | ConvertFrom-Json
            if ($r.done) { $done = $true; break }
        } catch {}
    }
}

if (-not $done) {
    Write-Warning "[drive:$label] driver did not report done within ${TimeoutSec}s"
}

# Close ONLY the VS Code instance(s) we launched. We match on either our unique --user-data-dir
# leaf OR the driver-extension development path (which ONLY ever appears in harness-launched
# instances). This guarantees we never orphan an ext-dev-host whose integrated terminal could
# otherwise leak into the user's console, while never touching the user's own VS Code windows.
try {
    $uddLeaf  = Split-Path $udd -Leaf
    $driverRe = [regex]::Escape($Driver)
    $procs = Get-CimInstance Win32_Process -Filter "Name='Code.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and ($_.CommandLine -match [regex]::Escape($uddLeaf) -or $_.CommandLine -match $driverRe) }
    foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
} catch {}

# Best-effort cleanup of the throwaway user-data-dir.
Start-Sleep -Seconds 2
Remove-Item $udd -Recurse -Force -ErrorAction SilentlyContinue

if (Test-Path $resultFile) {
    Write-Host "==> [drive:$label] result:" -ForegroundColor Green
    Get-Content $resultFile -Raw
} else {
    Write-Warning "[drive:$label] no result file produced."
    exit 1
}
