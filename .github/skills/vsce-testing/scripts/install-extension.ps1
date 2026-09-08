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
$extensionId = "microsoft-winappcli.winapp"
$extensionsDir = Join-Path (Split-Path $PSScriptRoot -Parent) ".drive-extensions"
New-Item -ItemType Directory -Force -Path $extensionsDir | Out-Null
$installedBefore = & code "--extensions-dir=$extensionsDir" --list-extensions 2>$null |
    Where-Object { $_ -eq $extensionId }
if ($installedBefore) {
    Write-Step "Removing the currently registered WinApp extension to avoid stale VS Code metadata"
    & code "--extensions-dir=$extensionsDir" --uninstall-extension $extensionId
    if ($LASTEXITCODE -ne 0) {
        throw "code --uninstall-extension failed with exit code $LASTEXITCODE"
    }
}

& code "--extensions-dir=$extensionsDir" --install-extension $vsix.FullName --force
if ($LASTEXITCODE -ne 0) { throw "code --install-extension failed with exit code $LASTEXITCODE" }

Write-Step "Installed VSIX. Verifying extension is registered with VS Code:"
$installed = & code "--extensions-dir=$extensionsDir" --list-extensions --show-versions 2>$null |
    Where-Object { $_ -like "$extensionId@*" }
if (-not $installed) {
    throw "WinApp extension not found after installation."
}

$expectedVersion = [System.IO.Path]::GetFileNameWithoutExtension($vsix.Name) -replace '^winapp-', ''
$installedVersion = ($installed -split '@')[-1]
if ($installedVersion -ne $expectedVersion) {
    throw "VS Code reports WinApp $installedVersion, but the installed VSIX is $expectedVersion. Its extension metadata cache is stale."
}

Write-Host $installed -ForegroundColor Green

Write-Host "VSIX path: $($vsix.FullName)"
return $vsix.FullName
