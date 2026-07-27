#requires -Version 7
<#
  launch-and-shoot.ps1  —  Launch ONE WinUI app via the WinApp VS Code debugger (F5),
  prove it is running (screenshot the live app + full screen while the debugger is
  attached), and record structured feedback about the debugger experience.

  Usage:  pwsh -NoProfile -File scripts\launch-and-shoot.ps1 -AppId 01-counter-blank
#>
param(
    [Parameter(Mandatory)][string]$AppId,
    [int]$SettleSec = 22,
    [int]$AppWaitSec = 40,
    [string]$Rid = 'win-x64'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Import-Module (Join-Path $root 'scripts\vscode-drive.psm1') -Force

# --- resolve project, source file, app exe + input folder -------------------
$appDir  = Join-Path $root "workspace\$AppId"
if (-not (Test-Path $appDir)) { throw "app dir not found: $appDir" }
$csproj  = Get-ChildItem $appDir -Recurse -Filter *.csproj | Select-Object -First 1
$proj    = $csproj.DirectoryName
$appName = $csproj.BaseName
$exe     = Get-ChildItem $appDir -Recurse -Filter "$appName.exe" |
           Where-Object { $_.DirectoryName -match [regex]::Escape($Rid) -and $_.DirectoryName -notmatch 'AppX' } |
           Select-Object -First 1
if (-not $exe) { throw "no built exe for $AppId (rid=$Rid) (build it first)" }
$input   = $exe.DirectoryName
$srcFile = @(
    (Join-Path $proj 'MainWindow.xaml.cs'),
    (Join-Path $proj 'App.xaml.cs'),
    $csproj.FullName
) | Where-Object { Test-Path $_ } | Select-Object -First 1

$outDir  = Join-Path $root "reports\debugger-run\$AppId"
$shotDir = Join-Path $outDir 'shots'
New-Item -ItemType Directory -Force -Path $shotDir | Out-Null

$finding = [ordered]@{
    appId = $AppId; appName = $appName; inputFolder = $input; srcFile = $srcFile
    startedUtc = (Get-Date).ToUniversalTime().ToString('o')
    events = @(); timings = [ordered]@{}; screenshots = @(); notes = @()
}
function Note($m){ $finding.notes += $m; Write-Host "  · $m" -ForegroundColor DarkGray }

Write-Host "=== $AppId ($appName) ===" -ForegroundColor Cyan
Write-Host "inputFolder = $input"

$ctx = Start-VSCodeDrive -Folder $proj -OpenFile $srcFile -WithDriverExtension -SettleSec $SettleSec
try {
    Set-VSCodeFocus -Ctx $ctx | Out-Null
    $onEditor = Confirm-VSCodeEditor -Ctx $ctx -OpenFileIfNeeded $srcFile
    $finding.timings.onEditor = [bool]$onEditor
    winapp ui screenshot -w $ctx.Hwnd -o (Join-Path $shotDir '00-editor.png') 2>&1 | Out-Null

    # --- press F5 (winapp debugger) ---
    $t0 = Get-Date
    Note "invoking WinApp debugger (F5) with inputFolder set in launch.json"
    $res = Invoke-VSCodeDriverDebug -Ctx $ctx -InputFolder $input -TimeoutSec 150
    $dbg = $res.steps | Where-Object type -eq 'debug' | Select-Object -First 1
    $finding.debugStep = $dbg
    $finding.events    = @($dbg.sessionEvents)
    $finding.timings.driverReturnedSec = [math]::Round(((Get-Date) - $t0).TotalSeconds,1)
    Note "driver returned: started=$($dbg.started) launched=$($dbg.launched) events=[$($dbg.sessionEvents -join ', ')]"
    if ($dbg.error)        { Note "debug error: $($dbg.error)" }
    if ($dbg.dialogResult) { Note "native dialog was answered: $($dbg.dialogResult)" }

    # --- wait for the app window to appear, keep it alive, screenshot it ---
    $appProc = $null; $appHwnd = $null
    $tw = Get-Date
    while (((Get-Date) - $tw).TotalSeconds -lt $AppWaitSec) {
        $appProc = Get-Process -Name $appName -EA SilentlyContinue | Select-Object -First 1
        if ($appProc) {
            $lw = (winapp ui list-windows -a $appName 2>&1 | Out-String) -replace '\r?\n',' '
            $m = [regex]::Match($lw, "HWND (\d+):")
            if ($m.Success) { $appHwnd = $m.Groups[1].Value; break }
        }
        Start-Sleep -Milliseconds 800
    }
    if ($appProc) {
        $finding.timings.appVisibleSec = [math]::Round(((Get-Date) - $t0).TotalSeconds,1)
        $finding.appRunning = $true; $finding.appPid = $appProc.Id; $finding.appHwnd = $appHwnd
        Note "APP RUNNING pid=$($appProc.Id) hwnd=$appHwnd after $($finding.timings.appVisibleSec)s"
        Start-Sleep 2  # let it finish painting
        if ($appHwnd) {
            winapp ui screenshot -w $appHwnd -o (Join-Path $shotDir '10-app-window.png') 2>&1 | Out-Null
            $finding.screenshots += '10-app-window.png'
        }
        winapp ui screenshot -a $appName --capture-screen -o (Join-Path $shotDir '11-app-fullscreen.png') 2>&1 | Out-Null
        $finding.screenshots += '11-app-fullscreen.png'
        winapp ui screenshot -w $ctx.Hwnd -o (Join-Path $shotDir '12-vscode-debugging.png') 2>&1 | Out-Null
        $finding.screenshots += '12-vscode-debugging.png'
    } else {
        $finding.appRunning = $false
        Note "APP DID NOT APPEAR within ${AppWaitSec}s (launched flag=$($dbg.launched))"
        winapp ui screenshot -w $ctx.Hwnd -o (Join-Path $shotDir '10-no-app.png') 2>&1 | Out-Null
        # check for a blocking native dialog
        $lw = (winapp ui list-windows 2>&1 | Out-String) -replace '\r?\n',' '
        $dlg = [regex]::Match($lw, 'HWND (\d+): "([^"]*)"[^)]*#32770')
        if ($dlg.Success) { Note "blocking native dialog present: '$($dlg.Groups[2].Value)'"; winapp ui screenshot -w $dlg.Groups[1].Value -o (Join-Path $shotDir '13-dialog.png') 2>&1 | Out-Null }
    }

    # --- clean up the launched app + any registered package ---
    if ($appProc) { try { Stop-Process -Id $appProc.Id -Force -EA SilentlyContinue; Note "stopped app pid $($appProc.Id)" } catch {} }
}
finally {
    Stop-VSCodeDrive -Ctx $ctx
    $finding.endedUtc = (Get-Date).ToUniversalTime().ToString('o')
    $finding | ConvertTo-Json -Depth 12 | Set-Content (Join-Path $outDir 'finding.json')
    Write-Host "wrote $(Join-Path $outDir 'finding.json')" -ForegroundColor Green
}
