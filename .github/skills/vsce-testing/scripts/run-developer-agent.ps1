#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Run ONE app through the WinApp-extension UX battle-test, in three GUARANTEED phases:
      A) Build agent     - Copilot (winui3-builder) creates + builds the varied app, writes BUILD-INFO.json.
      B) Harness drive   - DETERMINISTICALLY drives the real winapp.* commands + WinApp debugger IN VS Code
                           (via driver-extension + drive-extension.ps1). This always runs, regardless of
                           what the build agent did, so the extension is genuinely exercised in VS Code.
      C) Feedback agent  - Copilot reads the driver-result JSON + build notes and writes FEEDBACK.md / SUMMARY.md.
    Deliverables are copied to reports\per-app\<id> with a status record.
.PARAMETER AppId           App spec id from config\apps.json.
.PARAMETER Model           Optional model override for Copilot.
.PARAMETER TimeoutMinutes  Per-agent-phase timeout (each of A and C). Default 30.
.PARAMETER DriveTimeoutSec Timeout for the VS Code driving phase. Default 480.
#>
param(
    [Parameter(Mandatory = $true)][string]$AppId,
    [string]$Model = "",
    [int]$TimeoutMinutes = 30,
    [int]$DriveTimeoutSec = 480
)
$ErrorActionPreference = "Stop"
$Harness = Split-Path $PSScriptRoot -Parent

$cfg = Get-Content (Join-Path $Harness "config\apps.json") -Raw | ConvertFrom-Json
$spec = $cfg.apps | Where-Object { $_.id -eq $AppId }
if (-not $spec) { throw "App id '$AppId' not found in config\apps.json" }

$work   = Join-Path $Harness "workspace\$AppId"
$logDir = Join-Path $Harness "logs\$AppId"
$perApp = Join-Path $Harness "reports\per-app\$AppId"
New-Item -ItemType Directory -Force -Path $work, $logDir, $perApp | Out-Null

$specJson = $spec | ConvertTo-Json -Depth 8
$launcher = Join-Path $Harness "scripts\_invoke-copilot.ps1"
$pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $pwsh) { $pwsh = (Get-Command powershell).Source }

function Invoke-AgentPhase([string]$phase, [string]$promptText, [int]$timeoutMin) {
    $promptFile = Join-Path $logDir "prompt-$phase.md"
    Set-Content -Path $promptFile -Value $promptText -Encoding UTF8
    $aargs = @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $launcher,
        "-PromptFile", $promptFile, "-WorkDir", $work, "-LogDir", $logDir,
        "-Agent", "winui3-agent:winui3-builder"
    )
    if ($Model) { $aargs += @("-Model", $Model) }
    Write-Host "==> [$AppId] phase $phase (timeout ${timeoutMin}m)" -ForegroundColor Cyan
    # Hidden window + file-redirected streams so the child NEVER attaches to (and leaks into) the
    # user's console. Copilot already mirrors everything to copilot.log; these capture the wrapper.
    $outLog = Join-Path $logDir "phase-$phase.out.log"
    $errLog = Join-Path $logDir "phase-$phase.err.log"
    $p = Start-Process -FilePath $pwsh -ArgumentList $aargs -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    if (-not $p.WaitForExit($timeoutMin * 60 * 1000)) {
        Write-Warning "[$AppId] phase $phase timed out after ${timeoutMin}m - terminating"
        try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
        return -1
    }
    return $p.ExitCode
}

$start = Get-Date

# ---- Phase A: build agent ----
$buildPrompt = (Get-Content (Join-Path $Harness "prompts\persona-build.md") -Raw).
    Replace("{{APP_SPEC}}", $specJson).Replace("{{HARNESS}}", $Harness).Replace("{{WORK}}", $work)
$exitA = Invoke-AgentPhase "build" $buildPrompt $TimeoutMinutes

# Locate the project folder (prefer BUILD-INFO.json's projectDir; else the dir containing a .csproj).
$projectDir = $null
$bi = Get-ChildItem -Path $work -Filter "BUILD-INFO.json" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if ($bi) {
    try {
        $biJson = Get-Content $bi.FullName -Raw | ConvertFrom-Json
        if ($biJson.projectDir -and (Test-Path $biJson.projectDir)) { $projectDir = $biJson.projectDir }
    } catch {}
    if (-not $projectDir) { $projectDir = $bi.Directory.FullName }
}
if (-not $projectDir) {
    $csproj = Get-ChildItem -Path $work -Filter "*.csproj" -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch '\\(obj|bin)\\' } | Select-Object -First 1
    if ($csproj) { $projectDir = $csproj.Directory.FullName }
}
if (-not $projectDir) { $projectDir = $work }

# ---- Phase B: deterministic VS Code driving (ALWAYS) ----
$scriptJson = Join-Path $logDir "driver-script.json"
$unpackagedFlag = @()
if ($spec.id -match 'unpackaged') { $unpackagedFlag = @("-Unpackaged") }
Write-Host "==> [$AppId] phase drive: building driver script + driving VS Code" -ForegroundColor Cyan
& $pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Harness "scripts\build-driver-script.ps1") `
    -AppId $AppId -Project $projectDir -OutFile $scriptJson @unpackagedFlag

$driverResult = Join-Path $Harness "logs\driver-result-$AppId.json"
Remove-Item $driverResult -ErrorAction SilentlyContinue
try {
    & $pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Harness "scripts\drive-extension.ps1") `
        -Project $projectDir -ScriptJson $scriptJson -TimeoutSec $DriveTimeoutSec | Out-Null
} catch {
    Write-Warning "[$AppId] drive phase error: $_"
}
$drove = Test-Path $driverResult
if ($drove) { Copy-Item $driverResult (Join-Path $perApp "driver-result.json") -Force }

# ---- Phase C: feedback agent ----
$fbPrompt = (Get-Content (Join-Path $Harness "prompts\persona-feedback.md") -Raw).
    Replace("{{APP_SPEC}}", $specJson).Replace("{{WORK}}", $work).
    Replace("{{APP_ID}}", $AppId).Replace("{{DRIVER_RESULT}}", $driverResult)
$exitC = Invoke-AgentPhase "feedback" $fbPrompt $TimeoutMinutes

# ---- Collect deliverables ----
foreach ($name in @("FEEDBACK.md", "SUMMARY.md", "BUILD-NOTES.md", "BUILD-INFO.json")) {
    Get-ChildItem -Path $work -Filter $name -Recurse -ErrorAction SilentlyContinue |
        Select-Object -First 1 | ForEach-Object { Copy-Item $_.FullName (Join-Path $perApp $name) -Force }
}

$feedbackPath = Join-Path $perApp "FEEDBACK.md"
$feedbackCount = 0
if (Test-Path $feedbackPath) {
    $feedbackCount = (Select-String -Path $feedbackPath -Pattern '^\s*##\s*\[' -ErrorAction SilentlyContinue).Count
}
$driverSteps = 0
if ($drove) { try { $driverSteps = ((Get-Content $driverResult -Raw | ConvertFrom-Json).steps).Count } catch {} }

$elapsed = [int]((Get-Date) - $start).TotalSeconds
$status = [ordered]@{
    appId         = $AppId
    template      = $spec.template
    packages      = $spec.packages
    buildExit     = $exitA
    feedbackExit  = $exitC
    drove         = $drove
    driverSteps   = $driverSteps
    elapsedSec    = $elapsed
    feedbackItems = $feedbackCount
    hasFeedback   = (Test-Path $feedbackPath)
    hasSummary    = (Test-Path (Join-Path $perApp "SUMMARY.md"))
    finishedAt    = (Get-Date).ToString("o")
}
$status | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $perApp "status.json") -Encoding UTF8
Write-Host "==> [$AppId] done: buildExit=$exitA drove=$drove steps=$driverSteps feedbackExit=$exitC feedback=$feedbackCount elapsed=${elapsed}s" -ForegroundColor Green
return $status
