#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Invoke the Copilot CLI with a prompt loaded from a FILE (avoids command-line length/escaping
    issues for large prompts). Intended to be launched in its own pwsh process by the harness so a
    timeout can be enforced from the parent.
.PARAMETER PromptFile
    Path to a UTF-8 file containing the full prompt text.
.PARAMETER WorkDir
    Working directory Copilot runs in (passed as -C).
.PARAMETER LogDir
    Directory for Copilot logs and the combined stdout/stderr capture.
.PARAMETER Agent
    Optional custom agent id (e.g. winui3-agent:winui3-builder).
.PARAMETER Model
    Optional model override.
#>
param(
    [Parameter(Mandatory = $true)][string]$PromptFile,
    [Parameter(Mandatory = $true)][string]$WorkDir,
    [Parameter(Mandatory = $true)][string]$LogDir,
    [string]$Agent = "",
    [string]$Model = ""
)
$ErrorActionPreference = "Stop"

$node = (Get-Command node -ErrorAction Stop).Source
$loader = Join-Path $env:APPDATA "npm\node_modules\@github\copilot\npm-loader.js"
if (-not (Test-Path $loader)) { throw "Copilot npm-loader.js not found at $loader" }
if (-not (Test-Path $PromptFile)) { throw "Prompt file not found: $PromptFile" }

$prompt = Get-Content -Raw -Path $PromptFile

$cliArgs = @(
    $loader,
    "-p", $prompt,
    "--allow-all-tools",
    "--allow-all-paths",
    "--no-color",
    "-C", $WorkDir,
    "--log-dir", $LogDir,
    "--log-level", "info"
)
if ($Agent) { $cliArgs += @("--agent", $Agent) }
if ($Model) { $cliArgs += @("--model", $Model) }

$combined = Join-Path $LogDir "copilot.log"
# Native call operator passes the multiline prompt correctly (no cmd.exe involved).
& $node @cliArgs *> $combined
exit $LASTEXITCODE
