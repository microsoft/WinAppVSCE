#requires -Version 7
# Focused probe: winapp.pack on app01 — capture the integrated-terminal output to see why
# no .msix is produced. Answers: folder picker (project dir) + cert QuickPick.
param([ValidateSet('accept','decline')][string]$CertAnswer = 'accept')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Import-Module (Join-Path $root 'scripts\vscode-drive.psm1') -Force

$proj = Join-Path $root 'workspace\01-counter-blank\CounterApp'
$src  = Join-Path $proj 'MainWindow.xaml.cs'
# pack needs the BUILD OUTPUT folder (win-x64 with the .exe), not the project source folder.
$packFolder = (Get-ChildItem (Join-Path $proj 'bin') -Recurse -Directory -Filter win-x64 |
    Where-Object { $_.FullName -match 'Debug' -and (Get-ChildItem $_.FullName -Filter *.exe -EA SilentlyContinue | Where-Object Name -notmatch createdump) } |
    Select-Object -First 1).FullName
Write-Host "packFolder = $packFolder"
Get-ChildItem $proj -Recurse -Include *.msix,*.msixbundle -EA SilentlyContinue | Remove-Item -Force -EA SilentlyContinue
$shot = Join-Path $root 'logs\pack'; New-Item -ItemType Directory -Force -Path $shot | Out-Null

$answers = @(@{nativeDialogPath=$packFolder}, @{accept=$true}, @{accept=$true})

$ctx = Start-VSCodeDrive -Folder $proj -OpenFile $src -WithDriverExtension -SettleSec 22
try {
    Set-VSCodeFocus -Ctx $ctx | Out-Null
    Confirm-VSCodeEditor -Ctx $ctx -OpenFileIfNeeded $src | Out-Null

    $job = Start-Job -ScriptBlock {
        param($mod,$ctx,$answers)
        Import-Module $mod -Force
        Invoke-VSCodeDriverCommand -Ctx $ctx -CommandId 'winapp.pack' -Answers $answers -TimeoutSec 220 | ConvertTo-Json -Depth 12
    } -ArgumentList (Join-Path $root 'scripts\vscode-drive.psm1'), $ctx, $answers

    for ($i=1; $i -le 30; $i++) {
        Start-Sleep 7
        winapp ui screenshot -w $ctx.Hwnd -o (Join-Path $shot ("t{0:d2}.png" -f $i)) 2>&1 | Out-Null
        $msix = Get-ChildItem $proj -Recurse -Include *.msix,*.msixbundle -EA SilentlyContinue | Select-Object -First 1
        if ($msix) { Write-Host ("t{0}: MSIX FOUND {1}" -f $i, $msix.FullName); break }
    }
    $res = Receive-Job $job -Wait; Remove-Job $job -Force -EA SilentlyContinue
    Write-Host "=== pack result ==="; Write-Host $res
    winapp ui screenshot -w $ctx.Hwnd -o (Join-Path $shot 'final.png') 2>&1 | Out-Null
    Write-Host "=== msix under project ==="
    Get-ChildItem $proj -Recurse -Include *.msix,*.msixbundle -EA SilentlyContinue | Select-Object FullName,Length | Format-Table -Auto | Out-String | Write-Host
}
finally { Stop-VSCodeDrive -Ctx $ctx }
