#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Download WinApp CLI binaries from a public GitHub release for local development.
.DESCRIPTION
    Downloads the x64 and arm64 WinApp CLI binaries from microsoft/winappcli GitHub
    releases and extracts them to bin/win-x64 and bin/win-arm64 respectively.
    These binaries are bundled into the VS Code extension for local testing.
.PARAMETER Tag
    The release tag to download (e.g., "v0.3.2").
    Use "latest" to download the latest stable release.
    Defaults to "latest".
.EXAMPLE
    .\scripts\download-cli.ps1
    .\scripts\download-cli.ps1 -Tag v0.3.2
    .\scripts\download-cli.ps1 -Tag latest
#>

param(
    [Parameter(Mandatory=$false)]
    [string]$Tag = "latest"
)

$ErrorActionPreference = "Stop"
$repo = "microsoft/winappcli"
$projectRoot = Split-Path $PSScriptRoot -Parent
$binDir = Join-Path $projectRoot "bin"

# Resolve "latest" to actual tag
if ($Tag -eq "latest") {
    Write-Host "[CLI] Finding latest stable release..." -ForegroundColor Blue
    $releases = gh release list --repo $repo --limit 10 --json tagName,isPrerelease,isDraft | ConvertFrom-Json
    $stable = $releases | Where-Object { -not $_.isPrerelease -and -not $_.isDraft } | Select-Object -First 1
    if (-not $stable) {
        Write-Error "No stable release found for $repo"
        exit 1
    }
    $Tag = $stable.tagName
}

Write-Host "[CLI] Downloading WinApp CLI $Tag..." -ForegroundColor Blue

# Create directories
New-Item -ItemType Directory -Path "$binDir/win-x64" -Force | Out-Null
New-Item -ItemType Directory -Path "$binDir/win-arm64" -Force | Out-Null

# Download using gh CLI
gh release download $Tag --repo $repo --pattern "winappcli-x64.zip" --dir $binDir --clobber
if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to download winappcli-x64.zip from release $Tag"
    exit 1
}

gh release download $Tag --repo $repo --pattern "winappcli-arm64.zip" --dir $binDir --clobber
if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to download winappcli-arm64.zip from release $Tag"
    exit 1
}

# Extract
Write-Host "[CLI] Extracting binaries..." -ForegroundColor Blue
Expand-Archive -Path "$binDir/winappcli-x64.zip" -DestinationPath "$binDir/win-x64" -Force
Expand-Archive -Path "$binDir/winappcli-arm64.zip" -DestinationPath "$binDir/win-arm64" -Force

# Clean up zips
Remove-Item "$binDir/winappcli-x64.zip", "$binDir/winappcli-arm64.zip" -Force

# Validate
if (-not (Test-Path "$binDir/win-x64/winapp.exe")) {
    Write-Error "winapp.exe not found in extracted x64 archive"
    exit 1
}
if (-not (Test-Path "$binDir/win-arm64/winapp.exe")) {
    Write-Error "winapp.exe not found in extracted arm64 archive"
    exit 1
}

# Report version
$version = & "$binDir/win-x64/winapp.exe" --version 2>$null | Where-Object { $_ -match '^\d+\.\d+\.\d+' } | Select-Object -First 1
Write-Host "[CLI] WinApp CLI $version ($Tag) downloaded successfully!" -ForegroundColor Green
