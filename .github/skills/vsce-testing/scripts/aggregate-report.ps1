#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Aggregate all per-app FEEDBACK.md / SUMMARY.md into a single FINAL-REPORT.md via Copilot.
.DESCRIPTION
    Concatenates every per-app FEEDBACK.md, SUMMARY.md and status.json plus the campaign log into
    one raw-data blob, injects it into prompts\report-author.md, and runs `copilot -p` to author
    reports\FINAL-REPORT.md (>=10 constructive criticisms). If Copilot is unavailable, it still
    writes a raw concatenation so no data is lost.
.PARAMETER Model
    Optional model override for the report author.
#>
param(
    [string]$Model = "",
    [int]$TimeoutMinutes = 30
)
$ErrorActionPreference = "Stop"
$Harness = Split-Path $PSScriptRoot -Parent
$perAppRoot = Join-Path $Harness "reports\per-app"
$reportsDir = Join-Path $Harness "reports"

# Build the raw campaign data blob.
$sb = [System.Text.StringBuilder]::new()
[void]$sb.AppendLine("# Raw campaign data")
[void]$sb.AppendLine()

$campaignLog = Join-Path $Harness "logs\campaign-summary.json"
if (Test-Path $campaignLog) {
    [void]$sb.AppendLine("## Campaign run summary (status.json per app)")
    [void]$sb.AppendLine('```json')
    [void]$sb.AppendLine((Get-Content $campaignLog -Raw))
    [void]$sb.AppendLine('```')
    [void]$sb.AppendLine()
}

$appDirs = Get-ChildItem $perAppRoot -Directory -ErrorAction SilentlyContinue | Sort-Object Name
foreach ($d in $appDirs) {
    [void]$sb.AppendLine("=====================================================================")
    [void]$sb.AppendLine("## APP: $($d.Name)")
    [void]$sb.AppendLine("=====================================================================")
    foreach ($f in @("status.json", "SUMMARY.md", "FEEDBACK.md")) {
        $p = Join-Path $d.FullName $f
        if (Test-Path $p) {
            [void]$sb.AppendLine("### $f")
            [void]$sb.AppendLine((Get-Content $p -Raw))
            [void]$sb.AppendLine()
        } else {
            [void]$sb.AppendLine("### $f  (MISSING)")
            [void]$sb.AppendLine()
        }
    }
}
$rawData = $sb.ToString()
$rawPath = Join-Path $reportsDir "raw-campaign-data.md"
Set-Content -Path $rawPath -Value $rawData -Encoding UTF8
Write-Host "==> Wrote raw data: $rawPath ($([math]::Round($rawData.Length/1024,1)) KB)" -ForegroundColor Cyan

# Render the report-author prompt.
$template = Get-Content (Join-Path $Harness "prompts\report-author.md") -Raw
$prompt = $template.Replace("{{CAMPAIGN_DATA}}", $rawData)

$logDir = Join-Path $Harness "logs\report"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$promptFile = Join-Path $logDir "report-prompt.md"
Set-Content -Path $promptFile -Value $prompt -Encoding UTF8

Write-Host "==> Authoring FINAL-REPORT.md via Copilot (timeout ${TimeoutMinutes}m)" -ForegroundColor Cyan
$launcher = Join-Path $Harness "scripts\_invoke-copilot.ps1"
$pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $pwsh) { $pwsh = (Get-Command powershell).Source }
$launchArgs = @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $launcher,
    "-PromptFile", $promptFile,
    "-WorkDir", $Harness,
    "-LogDir", $logDir
)
if ($Model) { $launchArgs += @("-Model", $Model) }

$ok = $false
try {
    $outLog = Join-Path $logDir "report-launch.out.log"
    $errLog = Join-Path $logDir "report-launch.err.log"
    $proc = Start-Process -FilePath $pwsh -ArgumentList $launchArgs -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    if ($proc.WaitForExit($TimeoutMinutes * 60 * 1000)) {
        $ok = ($proc.ExitCode -eq 0)
    } else {
        try { Stop-Process -Id $proc.Id -Force } catch {}
        Write-Warning "Report authoring timed out."
    }
} catch {
    Write-Warning "Copilot report authoring failed: $_"
}

$finalPath = Join-Path $reportsDir "FINAL-REPORT.md"
if (Test-Path $finalPath) {
    Write-Host "==> FINAL-REPORT.md written: $finalPath" -ForegroundColor Green
} else {
    Write-Warning "FINAL-REPORT.md not produced by Copilot; raw data is preserved at $rawPath"
}
