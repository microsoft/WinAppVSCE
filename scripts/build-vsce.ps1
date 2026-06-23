#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Build the WinApp VS Code extension locally.
.DESCRIPTION
    Downloads CLI binaries (if not already present), installs dependencies,
    compiles TypeScript, runs linting and unit tests, and optionally packages a VSIX.

.PARAMETER SkipDownload
    Skip downloading CLI binaries (use existing bin/ contents).
.PARAMETER SkipTests
    Skip running unit tests.
.PARAMETER Package
    Also package the extension into a .vsix file after building.
.PARAMETER Stable
    When packaging, produce a stable version (no prerelease suffix).
.PARAMETER CliTag
    CLI release tag to download (default: "latest").

.EXAMPLE
    .\scripts\build-vsce.ps1
.EXAMPLE
    .\scripts\build-vsce.ps1 -Package
.EXAMPLE
    .\scripts\build-vsce.ps1 -SkipDownload -SkipTests
#>

param(
    [switch]$SkipDownload = $false,
    [switch]$SkipTests = $false,
    [switch]$Package = $false,
    [switch]$Stable = $false,
    [string]$CliTag = "latest"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = $PSScriptRoot | Split-Path -Parent

Push-Location $ProjectRoot
try {
    Write-Host ""
    Write-Host "╔══════════════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "║   WinApp VS Code Extension - Build           ║" -ForegroundColor Cyan
    Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Cyan
    Write-Host ""

    # Step 1: Download CLI binaries
    if (-not $SkipDownload) {
        Write-Host "[1/5] Downloading CLI binaries..." -ForegroundColor Blue
        $downloadScript = Join-Path $PSScriptRoot "download-cli.ps1"
        & $downloadScript -Tag $CliTag
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Failed to download CLI binaries"
            exit 1
        }
    } else {
        Write-Host "[1/5] Skipping CLI download (using existing bin/)" -ForegroundColor Gray
        if (-not (Test-Path "bin/win-x64/winapp.exe")) {
            Write-Warning "bin/win-x64/winapp.exe not found. Run without -SkipDownload or run: npm run download-cli"
        }
    }

    # Step 2: Install dependencies
    Write-Host ""
    Write-Host "[2/5] Installing dependencies..." -ForegroundColor Blue
    npm ci
    if ($LASTEXITCODE -ne 0) {
        Write-Error "npm ci failed"
        exit 1
    }

    # Step 3: Compile TypeScript
    Write-Host ""
    Write-Host "[3/5] Compiling TypeScript..." -ForegroundColor Blue
    npm run compile
    if ($LASTEXITCODE -ne 0) {
        Write-Error "TypeScript compilation failed"
        exit 1
    }

    # Step 4: Lint
    Write-Host ""
    Write-Host "[4/5] Running linter..." -ForegroundColor Blue
    npm run lint
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Lint found issues (non-blocking)"
    }

    # Step 5: Unit tests
    if (-not $SkipTests) {
        Write-Host ""
        Write-Host "[5/5] Running unit tests..." -ForegroundColor Blue
        npm run test:unit
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Unit tests failed"
            exit 1
        }
    } else {
        Write-Host ""
        Write-Host "[5/5] Skipping tests" -ForegroundColor Gray
    }

    # Optional: Package VSIX
    if ($Package) {
        Write-Host ""
        Write-Host "[PACK] Packaging VS Code extension..." -ForegroundColor Blue
        $packageScript = Join-Path $PSScriptRoot "package-vsc.ps1"
        & $packageScript -Stable:$Stable -CliBinariesPath (Join-Path $ProjectRoot "bin")
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Packaging failed"
            exit 1
        }
    }

    Write-Host ""
    Write-Host "[SUCCESS] Build completed successfully!" -ForegroundColor Green
    Write-Host ""

} finally {
    Pop-Location
}
