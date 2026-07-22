#requires -Version 7
<#
  run-app-flow.ps1 — drive ONE app through the live developer experience using the
  WinApp VS Code extension + F5 debugger, capturing every step result for the UX report.

  Flow (as a Windows engineer would do it):
    1. Open the app folder + a source file in a live VS Code instance (with driver queue).
    2. Dismiss first-run modals, confirm we're on the editor.
    3. winapp.certGenerate  — create/prepare the dev cert (package/sign path).
    4. winapp.pack          — package the app into an MSIX (Create MSIX Package).
    5. winapp.sign          — sign the produced package.
    6. F5 -> winapp debugger (vscode.debug.startDebugging with the 'winapp' launch config).
    7. Screenshot the terminal/editor after each meaningful step.
  All step results (res-*.json) are saved so findings are grounded in real output.
#>
param(
    [Parameter(Mandatory)][string]$AppId,
    [switch]$Unpackaged,          # 09-style: createDebugIdentity instead of pack/sign
    [int]$SettleSec = 24
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Import-Module (Join-Path $root 'scripts\vscode-drive.psm1') -Force

$appDir = Join-Path $root "workspace\$AppId"
if (-not (Test-Path $appDir)) { throw "app dir not found: $appDir" }
$csproj = Get-ChildItem $appDir -Recurse -Filter *.csproj |
    Where-Object { $_.FullName -notmatch 'Tests|ReusableControls' } | Select-Object -First 1
$projDir = $csproj.Directory.FullName
$srcFile = Get-ChildItem $projDir -Filter *.xaml.cs | Where-Object { $_.Name -match 'MainWindow|Main' } | Select-Object -First 1
if (-not $srcFile) { $srcFile = Get-ChildItem $projDir -Filter *.xaml.cs | Select-Object -First 1 }
$binRoot = Join-Path $projDir 'bin'
$binWin = $null
if (Test-Path $binRoot) {
    # Prefer the win-x64 output that actually contains the app exe (skip empty/duplicate trees).
    $binWin = Get-ChildItem $binRoot -Recurse -Directory -Filter 'win-x64' -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match 'Debug' -and (Get-ChildItem $_.FullName -Filter *.exe -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch 'createdump' }) } |
        Select-Object -First 1
    if (-not $binWin) {
        $binWin = Get-ChildItem $binRoot -Recurse -Directory -Filter 'win-x64' -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match 'Debug' } | Select-Object -First 1
    }
}
$inputFolder = if ($binWin) { $binWin.FullName } else { $null }

$outDir = Join-Path $root "reports\live-run\$AppId"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$shotDir = Join-Path $outDir 'shots'
New-Item -ItemType Directory -Force -Path $shotDir | Out-Null

$findings = [System.Collections.Generic.List[object]]::new()
function Note($step, $ok, $detail) {
    $findings.Add([pscustomobject]@{ step = $step; ok = $ok; detail = $detail; ts = (Get-Date).ToString('o') })
    Write-Host ("  [{0}] {1} — {2}" -f $(if($ok){'OK '}else{'!! '}), $step, $detail)
}
function Shot($name) {
    try { winapp ui screenshot -w $ctx.Hwnd -o (Join-Path $shotDir "$name.png") 2>&1 | Out-Null } catch {}
}

Write-Host "===== LIVE FLOW: $AppId =====" -ForegroundColor Cyan
Write-Host "  proj:  $projDir"
Write-Host "  src:   $($srcFile.FullName)"
Write-Host "  input: $inputFolder"

$ctx = Start-VSCodeDrive -Folder $projDir -OpenFile $srcFile.FullName -WithDriverExtension -SettleSec $SettleSec
try {
    Set-VSCodeFocus -Ctx $ctx | Out-Null
    $onEditor = Confirm-VSCodeEditor -Ctx $ctx -OpenFileIfNeeded $srcFile.FullName
    Note 'open-editor' $onEditor "editor ready; opened $($srcFile.Name)"
    Shot '01-editor'

    # --- Package/sign via the EXTENSION ---
    $pfx = Join-Path $projDir 'devcert.pfx'
    if (Test-Path $pfx) { Remove-Item $pfx -Force -ErrorAction SilentlyContinue }
    $r = Invoke-VSCodeDriverCommand -Ctx $ctx -CommandId 'winapp.certGenerate' -Answers @(@{accept=$true}) -TimeoutSec 90
    $r | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $outDir 'certGenerate.json')
    Start-Sleep 6
    Note 'certGenerate' ([bool]$r.done) ("done=$($r.done); devcert.pfx=$(Test-Path $pfx)")
    Shot '02-certGenerate'

    if ($Unpackaged) {
        if ($inputFolder) {
            $r = Invoke-VSCodeDriverCommand -Ctx $ctx -CommandId 'winapp.createDebugIdentity' -Answers @(@{nativeDialogPath=$inputFolder}) -TimeoutSec 90
            $r | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $outDir 'createDebugIdentity.json')
            Note 'createDebugIdentity' ([bool]$r.done) "done=$($r.done)"
            Shot '03-createDebugIdentity'
        }
    } else {
        # pack raises a native folder picker, then TWO QuickPicks:
        #   "Generate and install a development certificate?" and
        #   "Bundle Windows App SDK runtime (self-contained)?"
        # IMPORTANT: pack needs the BUILD OUTPUT folder (win-x64, containing the .exe),
        # NOT the project source folder (the dialog's default) — else "no .exe files found".
        $packFolder = if ($inputFolder) { $inputFolder } else { $projDir }
        Get-ChildItem $projDir -Recurse -Include *.msix,*.msixbundle -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
        $r = Invoke-VSCodeDriverCommand -Ctx $ctx -CommandId 'winapp.pack' -Answers @(@{nativeDialogPath=$packFolder}, @{accept=$true}, @{accept=$true}) -TimeoutSec 220
        $r | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $outDir 'pack.json')
        # pack builds asynchronously in the integrated terminal; poll for the msix.
        $msix = $null
        for ($i=0; $i -lt 30; $i++) {
            Start-Sleep 6
            $msix = Get-ChildItem $projDir -Recurse -Include *.msix,*.msixbundle -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -desc | Select-Object -First 1
            if ($msix) { break }
        }
        Note 'pack' ($null -ne $msix) ("folder=$packFolder; msix=$(if($msix){$msix.FullName}else{'<none after 180s>'})")
        Shot '03-pack'
    }

    # --- Launch via F5 / winapp debugger ---
    if ($inputFolder) {
        $r = Invoke-VSCodeDriverDebug -Ctx $ctx -InputFolder $inputFolder -TimeoutSec 150
        $r | ConvertTo-Json -Depth 12 | Set-Content (Join-Path $outDir 'debug.json')
        $dbg = $r.steps | Where-Object { $_.type -eq 'debug' } | Select-Object -First 1
        Note 'F5-debug' ([bool]$dbg.launched) ("launched=$($dbg.launched); startDebuggingReturned=$($dbg.started); events=$($dbg.sessionEvents -join ',')")
        Shot '05-debug'
        Start-Sleep 6
        # Was the app process actually spawned?
        $exe = Get-ChildItem $inputFolder -Filter *.exe -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch 'createdump' } | Select-Object -First 1
        if ($exe) {
            $procName = [IO.Path]::GetFileNameWithoutExtension($exe.Name)
            $running = @(Get-Process -Name $procName -ErrorAction SilentlyContinue)
            Note 'app-process' ($running.Count -gt 0) ("$procName running instances=$($running.Count)")
        } else {
            $running = @()
            Note 'app-process' $false "no app exe found in $inputFolder"
        }
        Shot '06-after-launch'
        # stop debug session
        Invoke-VSCodeDriverStep -Ctx $ctx -Step @{ type='stopDebug' } -TimeoutSec 40 | Out-Null
        foreach ($p in $running) { try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {} }
    } else {
        Note 'F5-debug' $false "no build output (win-x64) found to launch"
    }

    $findings | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $outDir 'summary.json')
    Write-Host "===== DONE $AppId — summary + step JSON in $outDir =====" -ForegroundColor Green
}
finally {
    Stop-VSCodeDrive -Ctx $ctx
}
