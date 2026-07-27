#requires -Version 5.1
<#
  Proves the vscode-drive discipline end-to-end on our OWN probe instance:
    launch WITH driver-extension -> verify focus -> verify page -> run a queued command -> verify result -> teardown.
  Uses a benign driver-queue command: "winapp.getWinappPath" -> the queue step must complete successfully.
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

$ctx = $null
try {
    Write-Host "STEP 1: launch" -ForegroundColor Magenta
    $ctx = Start-VSCodeDrive -Folder $proj -OpenFile ($file.FullName) -WithDriverExtension -SettleSec 22

    Write-Host "STEP 2: verify focus" -ForegroundColor Magenta
    $focus = Set-VSCodeFocus -Ctx $ctx
    Write-Host "  focus ok = $focus"

    Write-Host "STEP 3: verify page state" -ForegroundColor Magenta
    $state = Get-VSCodeState -Ctx $ctx
    $state | Format-List | Out-String | Write-Host
    $onEditor = Confirm-VSCodeEditor -Ctx $ctx -OpenFileIfNeeded ($file.FullName)
    Write-Host "  on editor = $onEditor"

    Write-Host "STEP 4: run queue command (verifiable)" -ForegroundColor Magenta
    $r = Invoke-VSCodeDriverCommand -Ctx $ctx -CommandId 'winapp.getWinappPath' -Answers @(@{ accept = $true }) -TimeoutSec 60
    $r | ConvertTo-Json -Depth 6 | Write-Host
    $commandStep = @($r.steps | Where-Object { $_.type -eq 'command' -and $_.command -eq 'winapp.getWinappPath' }) | Select-Object -First 1
    $commandVerified = [bool]($r.done -and $commandStep -and -not $commandStep.error)

    Write-Host "STEP 5: screenshot final state" -ForegroundColor Magenta
    $shot = Join-Path $skillRoot 'logs\drive-test-final.png'
    winapp ui screenshot -w $ctx.Hwnd -o $shot 2>&1 | Out-Null
    Write-Host "  saved $shot"

    Write-Host "RESULT: focus=$focus editor=$onEditor commandVerified=$commandVerified" -ForegroundColor Green

    if (-not $focus -or -not $onEditor -or -not $commandVerified) {
        Write-Error "FAIL: focus=$focus editor=$onEditor commandVerified=$commandVerified"
        exit 1
    }
}
finally {
    if ($ctx) { Write-Host "TEARDOWN" -ForegroundColor Magenta; Stop-VSCodeDrive -Ctx $ctx }
}
