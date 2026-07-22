#requires -Version 5.1
<#
  Proves the vscode-drive discipline end-to-end on our OWN probe instance:
    launch (lands on editor) -> verify focus -> verify page -> run a palette command -> verify effect -> teardown.
  Uses a benign, verifiable command: "Preferences: Open Settings (UI)" -> a Settings editor tab must appear.
#>
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'vscode-drive.psm1') -Force

$skillRoot = Split-Path $PSScriptRoot -Parent
$proj = Join-Path $skillRoot 'workspace\01-counter-blank\CounterApp'
$file = Get-ChildItem $proj -Recurse -Filter '*.xaml.cs' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\(obj|bin)\\' } | Select-Object -First 1

$ctx = $null
try {
    Write-Host "STEP 1: launch" -ForegroundColor Magenta
    $ctx = Start-VSCodeDrive -Folder $proj -OpenFile ($file.FullName) -SettleSec 22

    Write-Host "STEP 2: verify focus" -ForegroundColor Magenta
    $focus = Set-VSCodeFocus -Ctx $ctx
    Write-Host "  focus ok = $focus"

    Write-Host "STEP 3: verify page state" -ForegroundColor Magenta
    $state = Get-VSCodeState -Ctx $ctx
    $state | Format-List | Out-String | Write-Host
    $onEditor = Confirm-VSCodeEditor -Ctx $ctx -OpenFileIfNeeded ($file.FullName)
    Write-Host "  on editor = $onEditor"

    Write-Host "STEP 4: run palette command (verifiable)" -ForegroundColor Magenta
    $r = Invoke-VSCodeCommand -Ctx $ctx -Command 'Preferences: Open Settings (UI)' -VerifySearch 'Commonly Used'
    $r | Format-List | Out-String | Write-Host

    Write-Host "STEP 5: screenshot final state" -ForegroundColor Magenta
    $shot = Join-Path $skillRoot 'logs\drive-test-final.png'
    winapp ui screenshot -w $ctx.Hwnd -o $shot 2>&1 | Out-Null
    Write-Host "  saved $shot"

    Write-Host "RESULT: focus=$focus editor=$onEditor commandVerified=$($r.verified)" -ForegroundColor Green
}
finally {
    if ($ctx) { Write-Host "TEARDOWN" -ForegroundColor Magenta; Stop-VSCodeDrive -Ctx $ctx }
}
