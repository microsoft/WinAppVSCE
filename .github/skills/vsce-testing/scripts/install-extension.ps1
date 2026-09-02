#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Build the WinApp extension from the local repo and (force) install the VSIX into VS Code.
.DESCRIPTION
    Honors the user's convention: build via the repo's scripts\build-vsce.ps1 -Package.
    Then installs the freshly produced .vsix with `code --install-extension --force`.
.PARAMETER RepoRoot
    Path to the WinAppVSCE repo root. Default: auto-detected (4 levels up from this script).
.PARAMETER SkipBuild
    If set, skip building and just install the newest existing artifacts\*.vsix.
#>
param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")).Path,
    [switch]$SkipBuild
)
$ErrorActionPreference = "Stop"

function Write-Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }

if (-not (Test-Path $RepoRoot)) { throw "Repo not found: $RepoRoot" }
$artifacts = Join-Path $RepoRoot "artifacts"

if (-not $SkipBuild) {
    Write-Step "Building local VSIX via scripts\build-vsce.ps1 -Package (this can take several minutes)"
    Push-Location $RepoRoot
    try {
        & (Join-Path $RepoRoot "scripts\build-vsce.ps1") -Package
        if ($LASTEXITCODE -ne 0) { throw "build-vsce.ps1 failed with exit code $LASTEXITCODE" }
    } finally { Pop-Location }
} else {
    Write-Step "SkipBuild set - using existing artifacts"
}

$vsix = Get-ChildItem $artifacts -Filter *.vsix -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $vsix) { throw "No .vsix found in $artifacts. Build may have failed." }

Write-Step "Installing extension: $($vsix.Name)"
& code --install-extension $vsix.FullName --force
if ($LASTEXITCODE -ne 0) { throw "code --install-extension failed with exit code $LASTEXITCODE" }

Write-Step "Installed VSIX. Verifying extension is registered with VS Code:"
$installed = & code --list-extensions --show-versions 2>$null | Select-String -Pattern 'winapp'
if ($installed) { Write-Host $installed -ForegroundColor Green } else { Write-Warning "winapp extension not found in code --list-extensions" }

Write-Host "VSIX path: $($vsix.FullName)"
return $vsix.FullName
