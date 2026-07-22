#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Deterministically build a driver steps JSON for an app, so the harness (not the agent) guarantees
    the WinApp extension + debugger are driven IN VS Code.
.DESCRIPTION
    Auto-discovers the build-output folder (containing the app .exe) and the Package.appxmanifest under
    the project, then emits a steps file exercising the full extension pipeline:
      getWinappPath -> init -> restore -> manifestGenerate -> certGenerate -> pack ->
      openManifest -> run -> debug (WinApp debugger / F5) -> stopDebug -> unregister
    Optional BUILD-INFO.json (written by the build agent) can override discovery and skip steps.
.PARAMETER AppId      App id (used as the driver label).
.PARAMETER Project    Project folder opened in VS Code.
.PARAMETER OutFile    Path to write the steps JSON.
.PARAMETER ExeFolder  Optional explicit build-output folder (overrides discovery).
.PARAMETER Manifest   Optional explicit Package.appxmanifest path (overrides discovery).
.PARAMETER Unpackaged If set, skip pack/cert/manifest packaged-only steps (for unpackaged apps).
#>
param(
    [Parameter(Mandatory = $true)][string]$AppId,
    [Parameter(Mandatory = $true)][string]$Project,
    [Parameter(Mandatory = $true)][string]$OutFile,
    [string]$ExeFolder = "",
    [string]$Manifest = "",
    [switch]$Unpackaged
)
$ErrorActionPreference = "Stop"

function Find-ExeFolder([string]$root) {
    $exes = Get-ChildItem -Path $root -Recurse -Filter *.exe -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch '\\obj\\' -and $_.FullName -match '\\bin\\' }
    if (-not $exes) { return $null }
    # Prefer an exe inside a win-x64 (or any win-*) RID folder; else newest.
    $rid = $exes | Where-Object { $_.DirectoryName -match 'win-(x64|x86|arm64)$' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($rid) { return $rid.DirectoryName }
    return ($exes | Sort-Object LastWriteTime -Descending | Select-Object -First 1).DirectoryName
}

# Honor a BUILD-INFO.json if the build agent left one.
$buildInfoPath = Join-Path $Project "BUILD-INFO.json"
$buildInfo = $null
if (Test-Path $buildInfoPath) {
    try { $buildInfo = Get-Content $buildInfoPath -Raw | ConvertFrom-Json } catch {}
}
if ($buildInfo) {
    if (-not $ExeFolder -and $buildInfo.exeOutputFolder) { $ExeFolder = $buildInfo.exeOutputFolder }
    if (-not $Manifest   -and $buildInfo.manifestPath)    { $Manifest   = $buildInfo.manifestPath }
    if ($buildInfo.unpackaged) { $Unpackaged = $true }
}

if (-not $ExeFolder) { $ExeFolder = Find-ExeFolder $Project }
if (-not $Manifest) {
    $m = Get-ChildItem -Path $Project -Recurse -Filter "Package.appxmanifest" -ErrorAction SilentlyContinue |
        Sort-Object { $_.FullName.Length } | Select-Object -First 1
    if ($m) { $Manifest = $m.FullName }
}

$steps = New-Object System.Collections.ArrayList
[void]$steps.Add(@{ type = "command"; command = "winapp.getWinappPath"; answers = @(@{ accept = $true }) })
[void]$steps.Add(@{ type = "command"; command = "winapp.init";          answers = @(@{ accept = $true }) })
[void]$steps.Add(@{ type = "command"; command = "winapp.restore";       answers = @(); afterMs = 60000 })

if (-not $Unpackaged) {
    [void]$steps.Add(@{ type = "command"; command = "winapp.manifestGenerate"; answers = @(@{ accept = $true }) })
    [void]$steps.Add(@{ type = "command"; command = "winapp.certGenerate";     answers = @(@{ accept = $true }) })
    if ($ExeFolder) {
        [void]$steps.Add(@{ type = "command"; command = "winapp.pack";
            answers = @(@{ nativeDialogPath = $ExeFolder }, @{ accept = $true }, @{ accept = $true }); afterMs = 150000 })
    }
    if ($Manifest) { [void]$steps.Add(@{ type = "openManifest"; path = $Manifest; afterMs = 3000 }) }
}

if ($ExeFolder) {
    [void]$steps.Add(@{ type = "command"; command = "winapp.run";
        answers = @(@{ nativeDialogPath = $ExeFolder }); afterMs = 15000 })
    [void]$steps.Add(@{ type = "debug"; inputFolder = $ExeFolder; name = "WinApp: Launch and Attach"; afterMs = 12000 })
    [void]$steps.Add(@{ type = "wait"; ms = 5000 })
    [void]$steps.Add(@{ type = "stopDebug" })
}

if (-not $Unpackaged) {
    [void]$steps.Add(@{ type = "command"; command = "winapp.unregister"; answers = @(@{ accept = $true }) })
}

$obj = [ordered]@{ label = $AppId; project = $Project; exeOutputFolder = $ExeFolder; manifest = $Manifest; steps = $steps }
$json = $obj | ConvertTo-Json -Depth 8
New-Item -ItemType Directory -Force -Path (Split-Path $OutFile -Parent) | Out-Null
Set-Content -Path $OutFile -Value $json -Encoding UTF8
Write-Host "Wrote driver script: $OutFile (exeFolder=$ExeFolder, manifest=$([bool]$Manifest), steps=$($steps.Count))"
