<#
.SYNOPSIS
    Copies AppxManifest XSD schema files from the NuGet package cache into the
    local schemas/ directory. Run after `winapp restore`.

.DESCRIPTION
    This script reads the SDK package versions from winapp.yaml and locates
    the corresponding NuGet packages in the global cache. It then copies the
    required XSD files into schemas/ for use by the extension's IntelliSense
    and manifest validation features.

.EXAMPLE
    pwsh -NoProfile -Command "& ./scripts/sync-schemas.ps1"
#>

[CmdletBinding()]
param(
    [Parameter(HelpMessage = "Path to the winapp CLI executable. If not provided, searches bin/ then PATH.")]
    [string]$CliPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$schemasDir = Join-Path $repoRoot 'schemas'
$winappYaml = Join-Path $repoRoot 'winapp.yaml'

# Resolve winapp CLI location
if ($CliPath) {
    if (-not (Test-Path $CliPath)) {
        throw "The provided -CliPath does not exist: $CliPath"
    }
    $winappExe = $CliPath
} else {
    # Try bin/ directory first, then fall back to PATH
    $ridBinPath = Join-Path $repoRoot 'bin' 'win-x64' 'winapp.exe'
    $binPath = Join-Path $repoRoot 'bin' 'winapp.exe'
    if (Test-Path $ridBinPath) {
        $winappExe = $ridBinPath
    } elseif (Test-Path $binPath) {
        $winappExe = $binPath
    } else {
        $winappExe = (Get-Command 'winapp' -ErrorAction SilentlyContinue)?.Source
        if ($winappExe) {
            Write-Warning "Using PATH-resolved winapp executable at '$winappExe'. CI/release builds should pass -CliPath or pre-populate bin\."
        }
    }
}

# --- Parse winapp.yaml for package versions ---
if (-not (Test-Path $winappYaml)) {
    Write-Error "winapp.yaml not found at $winappYaml. Run from the repo root."
}

# Simple YAML parser for our flat package list
$yamlContent = Get-Content $winappYaml -Raw
$buildToolsVersion = $null
$sdkCppVersion = $null

$lines = $yamlContent -split "`n"
$currentPkg = $null
foreach ($line in $lines) {
    if ($line -match '^\s*-\s*name:\s*(.+)$') {
        $currentPkg = $Matches[1].Trim()
    }
    elseif ($line -match '^\s*version:\s*(.+)$' -and $currentPkg) {
        $ver = $Matches[1].Trim()
        switch ($currentPkg) {
            'Microsoft.Windows.SDK.BuildTools' { $buildToolsVersion = $ver }
            'Microsoft.Windows.SDK.CPP' { $sdkCppVersion = $ver }
        }
        $currentPkg = $null
    }
}

if (-not $buildToolsVersion) { Write-Error "Microsoft.Windows.SDK.BuildTools version not found in winapp.yaml" }
if (-not $sdkCppVersion) { Write-Error "Microsoft.Windows.SDK.CPP version not found in winapp.yaml" }

# --- Locate NuGet packages in global cache ---
$nugetCache = Join-Path $env:USERPROFILE '.nuget' 'packages'

$buildToolsBase = Join-Path $nugetCache 'microsoft.windows.sdk.buildtools' $buildToolsVersion
$sdkCppBase = Join-Path $nugetCache 'microsoft.windows.sdk.cpp' $sdkCppVersion

# Auto-download missing packages using winapp restore (or NuGet directly as fallback)
$needsRestore = (-not (Test-Path $buildToolsBase)) -or (-not (Test-Path $sdkCppBase))
if ($needsRestore) {
    if (-not $winappExe) {
        throw "Required SDK schema packages are missing and winapp.exe could not be resolved. Pass -CliPath or restore the CLI into bin\ before running sync-schemas."
    }

    Write-Host "Downloading SDK packages via winapp restore..."
    & $winappExe restore $repoRoot --quiet 2>&1 | Out-Null
    $restoreExitCode = $LASTEXITCODE

    if ((-not (Test-Path $buildToolsBase) -or -not (Test-Path $sdkCppBase))) {
        if ($env:CI) {
            throw "Required schema packages are missing after 'winapp restore' in CI. Pre-restore packages before running sync-schemas."
        }

        if ($restoreExitCode -eq 0) {
            throw "Required schema packages are still missing after 'winapp restore'. Run 'winapp restore' again or pass a valid -CliPath."
        }

        $nugetExe = (Get-Command 'nuget' -ErrorAction SilentlyContinue)?.Source
        if (-not $nugetExe) {
            throw "winapp restore failed and NuGet.exe was not found on PATH. Install NuGet for local development or pre-restore packages."
        }

        Write-Warning "Using PATH-resolved NuGet executable at '$nugetExe'. This fallback is for local development only and must not be used in CI/release builds."
        # Development-only fallback: copy packages from an explicit NuGet download when
        # winapp restore fails locally. CI/release builds should always use pre-restored
        # packages from `winapp restore`.
        Write-Host "Falling back to direct NuGet install for local development..."
        $downloadRoot = Join-Path $repoRoot '.schema-restore'
        New-Item -ItemType Directory -Path $downloadRoot -Force | Out-Null

        try {
            if (-not (Test-Path $buildToolsBase)) {
                & $nugetExe install Microsoft.Windows.SDK.BuildTools -Version $buildToolsVersion -OutputDirectory $downloadRoot -Source "https://api.nuget.org/v3/index.json" -NonInteractive 2>&1 | Out-Null
                $downloadedPkg = Join-Path $downloadRoot "Microsoft.Windows.SDK.BuildTools.$buildToolsVersion"
                if (-not (Test-Path $downloadedPkg)) {
                    throw "NuGet download did not produce $downloadedPkg"
                }
                $destDir = Split-Path $buildToolsBase -Parent
                New-Item -ItemType Directory -Path $destDir -Force | Out-Null
                Copy-Item $downloadedPkg -Destination $buildToolsBase -Recurse -Force
            }
            if (-not (Test-Path $sdkCppBase)) {
                & $nugetExe install Microsoft.Windows.SDK.CPP -Version $sdkCppVersion -OutputDirectory $downloadRoot -Source "https://api.nuget.org/v3/index.json" -NonInteractive 2>&1 | Out-Null
                $downloadedPkg = Join-Path $downloadRoot "Microsoft.Windows.SDK.CPP.$sdkCppVersion"
                if (-not (Test-Path $downloadedPkg)) {
                    throw "NuGet download did not produce $downloadedPkg"
                }
                $destDir = Split-Path $sdkCppBase -Parent
                New-Item -ItemType Directory -Path $destDir -Force | Out-Null
                Copy-Item $downloadedPkg -Destination $sdkCppBase -Recurse -Force
            }
        }
        finally {
            Remove-Item $downloadRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

if (-not (Test-Path $buildToolsBase)) {
    Write-Error "SDK.BuildTools $buildToolsVersion not found in NuGet cache. Run 'winapp restore' first."
}
if (-not (Test-Path $sdkCppBase)) {
    Write-Error "SDK.CPP $sdkCppVersion not found in NuGet cache. Run 'winapp restore' first."
}

# --- Discover XSD source directories ---
# BuildTools stores XSDs in schemas/{sdkVer}/winrt/
$buildToolsSchemaDir = Get-ChildItem (Join-Path $buildToolsBase 'schemas') -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name |
    Select-Object -Last 1
if (-not $buildToolsSchemaDir) {
    Write-Error "No schema version directory found in $buildToolsBase\schemas\"
}
$buildToolsXsdDir = Join-Path $buildToolsSchemaDir.FullName 'winrt'

# SDK.CPP stores XSDs in c/Include/{sdkVer}/winrt/
$sdkCppIncludeDir = Get-ChildItem (Join-Path $sdkCppBase 'c' 'Include') -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name |
    Select-Object -Last 1
if (-not $sdkCppIncludeDir) {
    Write-Error "No Include version directory found in $sdkCppBase\c\Include\"
}
$sdkCppXsdDir = Join-Path $sdkCppIncludeDir.FullName 'winrt'

# --- Define which XSD files we need ---
# Files from SDK.BuildTools (Uap and Foundation schemas)
$buildToolsFiles = @(
    'AppxManifestSchema.xsd'
    'FoundationManifestSchema.xsd'
    'FoundationManifestSchema_v2.xsd'
    'UapManifestSchema.xsd'
    'UapManifestSchema_v2.xsd'
    'UapManifestSchema_v3.xsd'
    'UapManifestSchema_v4.xsd'
    'UapManifestSchema_v5.xsd'
    'UapManifestSchema_v6.xsd'
    'UapManifestSchema_v7.xsd'
    'UapManifestSchema_v8.xsd'
    'UapManifestSchema_v10.xsd'
    'UapManifestSchema_v11.xsd'
    'UapManifestSchema_v12.xsd'
    'UapManifestSchema_v13.xsd'
)

# Files from SDK.CPP (Types, Com, Desktop schemas)
$sdkCppFiles = @(
    'AppxManifestTypes.xsd'
    'ComManifestSchema.xsd'
    'DesktopManifestSchema.xsd'
    'DesktopManifestSchema_v2.xsd'
    'DesktopManifestSchema_v3.xsd'
)

# --- Copy XSD files ---
if (-not (Test-Path $schemasDir)) {
    New-Item -ItemType Directory -Path $schemasDir -Force | Out-Null
}

$copied = 0
$errors = @()

foreach ($file in $buildToolsFiles) {
    $src = Join-Path $buildToolsXsdDir $file
    if (Test-Path $src) {
        Copy-Item $src -Destination $schemasDir -Force
        $copied++
    } else {
        $errors += "Missing from BuildTools: $file"
    }
}

foreach ($file in $sdkCppFiles) {
    $src = Join-Path $sdkCppXsdDir $file
    if (Test-Path $src) {
        Copy-Item $src -Destination $schemasDir -Force
        $copied++
    } else {
        $errors += "Missing from SDK.CPP: $file"
    }
}

# --- Report ---
Write-Host "✅ Synced $copied XSD schema files to schemas/" -ForegroundColor Green
Write-Host "   BuildTools: $buildToolsVersion ($buildToolsXsdDir)"
Write-Host "   SDK.CPP:    $sdkCppVersion ($sdkCppXsdDir)"

if ($errors.Count -gt 0) {
    Write-Warning "Some files were not found:"
    $errors | ForEach-Object { Write-Warning "  $_" }
    throw "Schema sync is incomplete; missing $($errors.Count) required XSD file(s)."
}
