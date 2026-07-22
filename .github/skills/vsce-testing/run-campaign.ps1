#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Orchestrate the full WinApp-extension UX battle-test campaign (10 WinUI apps) and produce a report.
.DESCRIPTION
    1. Builds + installs the local WinApp VSIX into VS Code (unless -SkipInstall).
    2. Runs the simulated Windows engineer (Copilot CLI + winui3-builder) for each app spec.
    3. Aggregates all FEEDBACK into reports\FINAL-REPORT.md (unless -SkipReport).

    Apps run SEQUENTIALLY by default (each spins up real VS Code / packaging / signing, which
    contend for the machine). Use -Apps to run a subset (smoke test).
.PARAMETER Apps
    Optional list of app ids to run (default: all in config\apps.json).
.PARAMETER Model
    Optional model override passed to every Copilot invocation.
.PARAMETER TimeoutMinutes
    Per-app hard timeout. Default 60.
.PARAMETER SkipInstall
    Skip building/installing the VSIX (use the already-installed extension).
.PARAMETER SkipReport
    Skip final report authoring (just run the apps).
.EXAMPLE
    .\run-campaign.ps1                      # full campaign: install, 10 apps, report
.EXAMPLE
    .\run-campaign.ps1 -Apps 01-counter-blank -SkipInstall   # smoke test one app
#>
param(
    [string[]]$Apps,
    [string]$Model = "",
    [int]$TimeoutMinutes = 60,
    [switch]$SkipInstall,
    [switch]$SkipReport
)
$ErrorActionPreference = "Stop"
$Harness = $PSScriptRoot
$started = Get-Date

function Write-Banner($m) {
    Write-Host ""
    Write-Host "############################################################" -ForegroundColor Magenta
    Write-Host "## $m" -ForegroundColor Magenta
    Write-Host "############################################################" -ForegroundColor Magenta
}

$cfg = Get-Content (Join-Path $Harness "config\apps.json") -Raw | ConvertFrom-Json
$allIds = $cfg.apps | ForEach-Object { $_.id }
$runIds = if ($Apps) { $Apps } else { $allIds }

Write-Banner "WinApp Extension UX Battle-Test Campaign"
Write-Host "Apps to run: $($runIds -join ', ')"
Write-Host "Per-app timeout: ${TimeoutMinutes}m  Model: $(if($Model){$Model}else{'(default)'})"

# Step 1: install the extension.
if (-not $SkipInstall) {
    Write-Banner "Step 1/3: Build + install local WinApp VSIX"
    & (Join-Path $Harness "scripts\install-extension.ps1")
    if ($LASTEXITCODE -ne 0) { throw "Extension install failed." }
} else {
    Write-Banner "Step 1/3: SKIPPED extension install (using already-installed extension)"
}

# Step 2: run each app's developer agent.
Write-Banner "Step 2/3: Run developer agent for $($runIds.Count) app(s)"
$results = @()
$idx = 0
foreach ($id in $runIds) {
    $idx++
    Write-Host ""
    Write-Host ">>> [$idx/$($runIds.Count)] $id" -ForegroundColor Yellow
    try {
        $r = & (Join-Path $Harness "scripts\run-developer-agent.ps1") -AppId $id -Model $Model -TimeoutMinutes $TimeoutMinutes
        $results += $r
    } catch {
        Write-Warning "[$id] developer agent errored: $_"
        $results += [ordered]@{ appId = $id; exitCode = -2; error = "$_"; feedbackItems = 0 }
    }
}

# Persist a campaign summary for the report author.
$summary = [ordered]@{
    startedAt   = $started.ToString("o")
    finishedAt  = (Get-Date).ToString("o")
    elapsedMin  = [math]::Round(((Get-Date) - $started).TotalMinutes, 1)
    appCount    = $runIds.Count
    results     = $results
}
$summary | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $Harness "logs\campaign-summary.json") -Encoding UTF8

Write-Host ""
Write-Host "Campaign results:" -ForegroundColor Cyan
$results | ForEach-Object {
    "{0,-22} exit={1,-3} feedback={2}" -f $_.appId, $_.exitCode, $_.feedbackItems | Write-Host
}

# Step 3: author the final report.
if (-not $SkipReport) {
    Write-Banner "Step 3/3: Aggregate -> FINAL-REPORT.md"
    & (Join-Path $Harness "scripts\aggregate-report.ps1") -Model $Model
} else {
    Write-Banner "Step 3/3: SKIPPED report authoring"
}

Write-Banner "Campaign complete in $($summary.elapsedMin) min"
Write-Host "Per-app feedback: $Harness\reports\per-app\<id>\FEEDBACK.md"
Write-Host "Final report:     $Harness\reports\FINAL-REPORT.md"
