#requires -Version 5.1
<#
  Proves the RELIABLE dynamic-drive path end-to-end:
    launch WITH driver-extension -> dismiss modals via UIA -> verify editor ->
    push a REAL winapp command (winapp.certGenerate) to the LIVE instance via the queue ->
    verify its effect (devcert.pfx is (re)created) -> screenshot -> teardown.
  This is the mechanism that works despite synthetic keyboard injection being blocked.
#>
param(
    [string]$Project
)

$ErrorActionPreference = 'Stop'

$skillRoot = Split-Path $PSScriptRoot -Parent
$proj = if ($Project) { $Project } else { Join-Path $skillRoot 'workspace\01-counter-blank\CounterApp' }
if (-not (Test-Path $proj -PathType Container)) {
    Write-Error "ERROR: Sample app not found at $proj. Run the campaign first to generate workspace apps, or provide a project path via -Project parameter."
    exit 1
}
$proj = (Resolve-Path $proj).Path
$file = Get-ChildItem $proj -Recurse -Filter '*.xaml.cs' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\(obj|bin)\\' } | Select-Object -First 1
if (-not $file) {
    Write-Error "ERROR: No .xaml.cs file found under $proj. Run the campaign first to generate workspace apps, or provide a project path via -Project parameter."
    exit 1
}

Import-Module (Join-Path $PSScriptRoot 'vscode-drive.psm1') -Force
$cert = Join-Path $proj 'devcert.pfx'

$ctx = $null
try {
    Write-Host "STEP 1: launch WITH driver extension" -ForegroundColor Magenta
    $ctx = Start-VSCodeDrive -Folder $proj -OpenFile ($file.FullName) -WithDriverExtension -SettleSec 24
    Write-Host "  queue dir: $($ctx.QueueDir)"

    Write-Host "STEP 2: focus + clear modals + verify editor (UIA)" -ForegroundColor Magenta
    Set-VSCodeFocus -Ctx $ctx | Out-Null
    $onEditor = Confirm-VSCodeEditor -Ctx $ctx -OpenFileIfNeeded ($file.FullName)
    Write-Host "  on editor = $onEditor"

    Write-Host "STEP 3: remove existing devcert.pfx so the effect is unambiguous" -ForegroundColor Magenta
    Remove-Item $cert -Force -ErrorAction SilentlyContinue
    Write-Host "  cert present before = $(Test-Path $cert)"

    Write-Host "STEP 4: push winapp.certGenerate to the LIVE instance via the driver queue" -ForegroundColor Magenta
    $r = Invoke-VSCodeDriverCommand -Ctx $ctx -CommandId 'winapp.certGenerate' -Answers @(@{ accept = $true }) -TimeoutSec 90
    $r | ConvertTo-Json -Depth 6 | Write-Host

    Write-Host "STEP 5: verify effect (cert generates in an async integrated terminal; poll)" -ForegroundColor Magenta
    $made = $false
    for ($i = 0; $i -lt 30; $i++) {
        if (Test-Path $cert) { $made = $true; break }
        Start-Sleep 1
    }
    Write-Host "  devcert.pfx created = $made (after $i s)" -ForegroundColor ($(if ($made) { 'Green' } else { 'Red' }))

    Write-Host "STEP 6: screenshot" -ForegroundColor Magenta
    $shot = Join-Path $skillRoot 'logs\driver-queue-final.png'
    winapp ui screenshot -w $ctx.Hwnd -o $shot 2>&1 | Out-Null
    Write-Host "  saved $shot"

    Write-Host "RESULT: editor=$onEditor driverDone=$($r.done) certCreated=$made" -ForegroundColor Green

    if (-not $onEditor -or -not $r.done -or -not $made) {
        Write-Error "FAIL: editor=$onEditor driverDone=$($r.done) certCreated=$made"
        exit 1
    }
}
finally {
    if ($ctx) { Write-Host "TEARDOWN" -ForegroundColor Magenta; Stop-VSCodeDrive -Ctx $ctx }
}
