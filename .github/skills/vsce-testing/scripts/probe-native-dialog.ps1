#requires -Version 7
# Probe: can we answer the winapp pack native folder dialog via UIA (set-value + invoke)
# instead of blocked SendKeys? Starts app01, fires winapp.pack, then drives the #32770 dialog.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Import-Module (Join-Path $root 'scripts\vscode-drive.psm1') -Force

$proj = Join-Path $root 'workspace\01-counter-blank\CounterApp'
$src  = Join-Path $proj 'MainWindow.xaml.cs'
$msix = Join-Path $proj 'CounterApp_dev.msix'
if (Test-Path $msix) { Remove-Item $msix -Force }   # ensure a fresh pack is unambiguous

$ctx = Start-VSCodeDrive -Folder $proj -OpenFile $src -WithDriverExtension -SettleSec 22
try {
    Set-VSCodeFocus -Ctx $ctx | Out-Null
    Confirm-VSCodeEditor -Ctx $ctx -OpenFileIfNeeded $src | Out-Null

    # Fire pack but DON'T let the driver answer (no nativeDialogPath) — we answer via UIA.
    $null = Invoke-VSCodeDriverStep -Ctx $ctx -Step @{ type='command'; command='winapp.pack'; answers=@(); afterMs=2000 } -TimeoutSec 30

    # Poll for the native folder dialog (#32770) owned by our Code instance.
    $dlgHwnd = $null
    for ($i=0; $i -lt 30; $i++) {
        Start-Sleep 1
        $lw = winapp ui list-windows 2>&1 | Out-String
        $flat = ($lw -replace '\r?\n',' ')
        $m = [regex]::Match($flat, 'HWND (\d+): "Select input folder to package"')
        if ($m.Success) { $dlgHwnd = $m.Groups[1].Value; break }
    }
    Write-Host "dialog hwnd = $dlgHwnd"
    if (-not $dlgHwnd) { throw "pack folder dialog never appeared" }

    # Resolve the Folder edit slug via set-value's own disambiguation output (reliable).
    $sv = winapp ui set-value -w $dlgHwnd "Folder:" "$proj" 2>&1 | Out-String
    $editSlug = $null
    foreach ($ln in ($sv -split "\r?\n")) {
        if ($ln -match 'Edit "Folder:".*->\s*(\S+)') { $editSlug = $Matches[1].Trim(); break }
    }
    Write-Host "folder edit slug = $editSlug"
    Write-Host "=== set-value (Folder edit) ==="
    if ($editSlug) {
        winapp ui set-value -w $dlgHwnd $editSlug "$proj" 2>&1 | Write-Host
        Start-Sleep 1
        Write-Host "=== read back ==="
        winapp ui get-value -w $dlgHwnd $editSlug 2>&1 | Write-Host
    }

    winapp ui screenshot -w $dlgHwnd -o (Join-Path $root 'logs\dlg-after-setvalue.png') 2>&1 | Out-Null
    Write-Host "=== invoke Select Folder ==="
    winapp ui invoke -w $dlgHwnd "Select Folder" 2>&1 | Write-Host

    Start-Sleep 12
    Write-Host "=== terminal after pack ==="
    winapp ui screenshot -w $ctx.Hwnd -o (Join-Path $root 'logs\pack-terminal.png') 2>&1 | Out-Null
    Write-Host "msix (any *.msix under proj):"
    Get-ChildItem $proj -Recurse -Include *.msix,*.msixbundle -ErrorAction SilentlyContinue | Select-Object FullName,Length,LastWriteTime | Format-Table -Auto | Out-String | Write-Host

    Start-Sleep 10
    Write-Host "msix created = $(Test-Path $msix)"
}
finally {
    Stop-VSCodeDrive -Ctx $ctx
}
