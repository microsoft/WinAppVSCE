#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Install a downloaded WinUI XAML language server pipeline artifact.
.DESCRIPTION
    The release pipeline downloads the ESRP-signed server artifact, then this script installs and
    validates it in dist/server. Local development does not use this script; ensure-server-bundle.mjs
    publishes fresh self-contained servers from source instead.
.PARAMETER ArtifactPath
    Path to the downloaded winui-xaml-server pipeline artifact directory.
.PARAMETER DestinationPath
    Extraction destination. Defaults to dist/server.
#>

param(
    [Parameter(Mandatory=$true)]
    [string]$ArtifactPath,

    [Parameter(Mandatory=$false)]
    [string]$DestinationPath
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path $PSScriptRoot -Parent

if ([string]::IsNullOrWhiteSpace($DestinationPath)) {
    $DestinationPath = Join-Path $ProjectRoot "dist\server"
}

$ResolvedArtifact = Resolve-Path $ArtifactPath -ErrorAction Stop
if (-not (Test-Path $ResolvedArtifact.Path -PathType Container)) {
    throw "Server artifact must be a directory: $($ResolvedArtifact.Path)"
}

if (Test-Path $DestinationPath) {
    Remove-Item $DestinationPath -Recurse -Force
}
New-Item -ItemType Directory -Path $DestinationPath -Force | Out-Null

Write-Host "[SERVER] Installing signed server artifact..." -ForegroundColor Blue
Copy-Item (Join-Path $ResolvedArtifact.Path "*") $DestinationPath -Recurse -Force

$PriorMode = $env:WINUI_XAML_SERVER_BUNDLE_MODE
$PriorOutput = $env:WINUI_XAML_SERVER_OUTPUT
try {
    $env:WINUI_XAML_SERVER_BUNDLE_MODE = "artifact"
    $env:WINUI_XAML_SERVER_OUTPUT = $DestinationPath
    & node (Join-Path $PSScriptRoot "ensure-server-bundle.mjs")
    if ($LASTEXITCODE -ne 0) {
        throw "Downloaded server artifact is incomplete."
    }
}
finally {
    if ($null -eq $PriorMode) {
        Remove-Item Env:WINUI_XAML_SERVER_BUNDLE_MODE -ErrorAction SilentlyContinue
    } else {
        $env:WINUI_XAML_SERVER_BUNDLE_MODE = $PriorMode
    }
    if ($null -eq $PriorOutput) {
        Remove-Item Env:WINUI_XAML_SERVER_OUTPUT -ErrorAction SilentlyContinue
    } else {
        $env:WINUI_XAML_SERVER_OUTPUT = $PriorOutput
    }
}

Write-Host "[SERVER] Signed self-contained server artifact installed in $DestinationPath" -ForegroundColor Green
