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
    If set, skip building and just install an existing artifacts\*.vsix.
.PARAMETER Vsix
    Explicit path to the .vsix to install. Pins the build under test, which is the only way to be
    certain which one you measured.
.PARAMETER ExpectedVersion
    Version the newest artifact must have (e.g. "0.3.1-prerelease.156"). If the newest does not
    match, the script throws instead of installing a different build.
#>
param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")).Path,
    [switch]$SkipBuild,
    [string]$Vsix,
    [string]$ExpectedVersion
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

# Selecting "the newest .vsix" silently couples this harness to anything that writes to the repo's
# artifacts directory -- including another session packaging a build while a test round is running.
# That produced a real near-miss: a newly packaged VSIX landed in artifacts mid-round and became the
# install target, which would have published one build's behaviour under another build's name. A
# silent upgrade is indistinguishable from the build you meant to test, so pin it or assert it.
if ($Vsix) {
    if (-not (Test-Path $Vsix)) { throw "Specified -Vsix not found: $Vsix" }
    $vsixFile = Get-Item $Vsix
} else {
    $candidates = @(Get-ChildItem $artifacts -Filter *.vsix -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending)
    if (-not $candidates) { throw "No .vsix found in $artifacts. Build may have failed." }
    $vsixFile = $candidates[0]

    if ($ExpectedVersion) {
        if ($vsixFile.Name -notlike "*$ExpectedVersion*") {
            throw ("Newest artifact is '$($vsixFile.Name)' but -ExpectedVersion '$ExpectedVersion' was " +
                "requested. Another build was packaged into '$artifacts'. Pass -Vsix to pin the " +
                "build under test rather than installing whatever is newest.")
        }
    } elseif ($candidates.Count -gt 1) {
        Write-Warning ("$($candidates.Count) VSIX files in '$artifacts'; taking the newest " +
            "($($vsixFile.Name)). Pass -Vsix or -ExpectedVersion to pin the build under test.")
    }
}

# Provenance belongs in the log of every run, so a result can be attributed after the fact.
Write-Step "Installing extension: $($vsixFile.Name) (written $($vsixFile.LastWriteTime.ToString('s')))"
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

& code "--extensions-dir=$extensionsDir" --install-extension $vsixFile.FullName --force
if ($LASTEXITCODE -ne 0) { throw "code --install-extension failed with exit code $LASTEXITCODE" }

Write-Step "Installed VSIX. Verifying extension is registered with VS Code:"
$installed = & code "--extensions-dir=$extensionsDir" --list-extensions --show-versions 2>$null |
    Where-Object { $_ -like "$extensionId@*" }
if (-not $installed) {
    throw "WinApp extension not found after installation."
}

$expectedVersion = [System.IO.Path]::GetFileNameWithoutExtension($vsixFile.Name) -replace '^winapp-', ''
$installedVersion = ($installed -split '@')[-1]
if ($installedVersion -ne $expectedVersion) {
    throw "VS Code reports WinApp $installedVersion, but the installed VSIX is $expectedVersion. Its extension metadata cache is stale."
}

Write-Host $installed -ForegroundColor Green

Write-Host "VSIX path: $($vsixFile.FullName)"
return $vsixFile.FullName
