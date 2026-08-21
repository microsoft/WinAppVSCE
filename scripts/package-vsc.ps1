#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Package Windows App Development CLI as VS Code extension (VSIX)
.DESCRIPTION
    This script creates a VSIX package from pre-built CLI binaries for x64 and arm64 architectures.
    By default, uses artifacts/cli for binaries and outputs to artifacts directory.
    Use -CliBinariesPath to override the CLI binaries location (e.g., to bundle a public release).
.PARAMETER Version
    Version number for the VSIX package (e.g., "0.1.0" or "0.1.0-prerelease.73").
    If not specified, reads from version.json and calculates based on Stable flag.
.PARAMETER Stable
    Use stable build configuration (default: false, uses prerelease config)
.PARAMETER CliBinariesPath
    Path to CLI binaries directory containing win-x64/ and win-arm64/ subdirectories.
    If not specified, defaults to artifacts/cli in the project root.
.EXAMPLE
    .\scripts\package-vsc.ps1
    .\scripts\package-vsc.ps1 -Version "0.1.0" -Stable
    .\scripts\package-vsc.ps1 -Version "0.1.0-prerelease.73"
    .\scripts\package-vsc.ps1 -CliBinariesPath "C:\path\to\cli-release" -Stable
#>

param(
    [Parameter(Mandatory=$false)]
    [string]$Version,

    [Parameter(Mandatory=$false)]
    [switch]$Stable = $false,

    [Parameter(Mandatory=$false)]
    [string]$CliBinariesPath,

    [Parameter(Mandatory=$false)]
    [switch]$SkipServerBuild = $false
)

# Ensure we're running from the project root
$ProjectRoot = $PSScriptRoot | Split-Path -Parent
Push-Location $ProjectRoot

# Track the bundle mode so a later local package in the same shell cannot accidentally reuse an
# existing signed artifact.
$ServerBundleModeSet = $false
$PriorServerBundleMode = $env:WINUI_XAML_SERVER_BUNDLE_MODE

try
{
    # Define standard paths
    if ([string]::IsNullOrEmpty($CliBinariesPath)) {
        $CliBinariesPath = Join-Path $ProjectRoot "artifacts\cli"
    }
    $OutputPath = Join-Path $ProjectRoot "artifacts"

    Write-Host "[VSC] Starting VS Code extension packaging..." -ForegroundColor Green
    Write-Host "[INFO] Project root: $ProjectRoot" -ForegroundColor Gray
    Write-Host "[INFO] CLI binaries path: $CliBinariesPath" -ForegroundColor Gray
    Write-Host "[INFO] Output path: $OutputPath" -ForegroundColor Gray

    # Validate that the CLI binaries path exists
    if (-not (Test-Path $CliBinariesPath)) {
        Write-Error "CLI binaries path does not exist: $CliBinariesPath. Run build-cli.ps1 first."
        exit 1
    }

    # Validate that required architecture folders exist
    $X64Path = Join-Path $CliBinariesPath "win-x64"
    $Arm64Path = Join-Path $CliBinariesPath "win-arm64"

    if (-not (Test-Path $X64Path)) {
        Write-Error "win-x64 folder not found at: $X64Path"
        exit 1
    }

    if (-not (Test-Path $Arm64Path)) {
        Write-Error "win-arm64 folder not found at: $Arm64Path"
        exit 1
    }

    Write-Host "[VALIDATE] Found CLI binaries:" -ForegroundColor Green
    Write-Host "  - x64: $X64Path" -ForegroundColor Gray
    Write-Host "  - arm64: $Arm64Path" -ForegroundColor Gray

    # Validate that the main executable exists in both folders
    $X64Exe = Join-Path $X64Path "winapp.exe"
    $Arm64Exe = Join-Path $Arm64Path "winapp.exe"

    if (-not (Test-Path $X64Exe)) {
        Write-Error "winapp.exe not found in x64 folder: $X64Exe"
        exit 1
    }

    if (-not (Test-Path $Arm64Exe)) {
        Write-Error "winapp.exe not found in arm64 folder: $Arm64Exe"
        exit 1
    }

    Write-Host "[VALIDATE] All required files found!" -ForegroundColor Green

    # Calculate version if not provided
    if ([string]::IsNullOrEmpty($Version)) {
        Write-Host "[VERSION] Calculating package version..." -ForegroundColor Blue

        # Read base version from package.json (now at project root)
        $VscPackageJsonPath = Join-Path $ProjectRoot "package.json"
        if (-not (Test-Path $VscPackageJsonPath)) {
            Write-Error "package.json not found at $VscPackageJsonPath"
            exit 1
        }

        $VscPackageJson = Get-Content $VscPackageJsonPath -Raw | ConvertFrom-Json
        $BaseVersion = $VscPackageJson.version

        # Get build number
        $GetBuildNumberScript = Join-Path $PSScriptRoot "get-build-number.ps1"
        $BuildNumber = & $GetBuildNumberScript
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Failed to get build number"
            exit 1
        }

        # Construct full version based on Stable flag
        if ($Stable) {
            $Version = $BaseVersion
            Write-Host "[VERSION] Using stable version (no prerelease suffix)" -ForegroundColor Cyan
        } else {
            $Version = "$BaseVersion-prerelease.$BuildNumber"
            Write-Host "[VERSION] Using prerelease version (with prerelease suffix)" -ForegroundColor Cyan
        }
    }

    Write-Host "[VERSION] Package version: $Version" -ForegroundColor Cyan

    # Ensure output directory exists
    if (-not (Test-Path $OutputPath)) {
        New-Item -ItemType Directory -Path $OutputPath -Force | Out-Null
        Write-Host "[SETUP] Created output directory: $OutputPath" -ForegroundColor Blue
    }

    # The project root IS the VS Code extension (standalone repo)
    $VscProjectPath = $ProjectRoot
    if (-not (Test-Path (Join-Path $VscProjectPath "package.json"))) {
        Write-Error "package.json not found at project root: $VscProjectPath"
        exit 1
    }

    Write-Host "[VSC] Preparing VS Code extension..." -ForegroundColor Blue

    Push-Location $VscProjectPath

    # Clean out and dist directories (preserve bin/ which may contain downloaded CLI binaries).
    # Under -SkipServerBuild the language server has already been published (and signed) into
    # dist/server by a prior pipeline step, so preserve dist/ and only clean out/.
    Write-Host "[VSC] Cleaning build artifacts..." -ForegroundColor Blue
    $CleanTargets = if ($SkipServerBuild) { @("out") } else { @("out", "dist") }
    $CleanTargets | ForEach-Object {
        if (Test-Path $_) { Remove-Item $_ -Recurse -Force }
    }

    # Install dependencies
    Write-Host "[VSC] Installing dependencies..." -ForegroundColor Blue
    npm ci
    if ($LASTEXITCODE -ne 0) {
        Write-Error "npm ci failed"
        Pop-Location
        exit 1
    }

    # Compile TypeScript
    Write-Host "[VSC] Compiling TypeScript..." -ForegroundColor Blue
    npm run compile
    if ($LASTEXITCODE -ne 0) {
        Write-Error "TypeScript compilation failed"
        Pop-Location
        exit 1
    }

    # Ensure the WinUI XAML language server (.NET) is published into dist/server so it ships in the VSIX.
    # The single local publish path is vscode:prepublish -> ensure-server-bundle.mjs (triggered by
    # `vsce package` below). In release builds, -SkipServerBuild requires the downloaded, signed
    # pipeline artifact and switches ensure-server-bundle.mjs to artifact mode.
    if ($SkipServerBuild) {
        Write-Host "[VSC] Skipping server build; reusing pre-published dist/server..." -ForegroundColor Blue
        # Preserve the downloaded ESRP signatures instead of rebuilding over them. The mode is
        # restored in the finally block so it never leaks into the caller's shell. The prepublish
        # helper is the canonical completeness check and rejects apphost or runtime payloads.
        $env:WINUI_XAML_SERVER_BUNDLE_MODE = "artifact"
        $ServerBundleModeSet = $true
    } else {
        # Normal packaging: DON'T publish the server here. The `vsce package` step below triggers
        # vscode:prepublish -> ensure-server-bundle.mjs publishes a fresh framework-dependent dist/server.
        # Publishing here too would build the server twice for every package.
        $env:WINUI_XAML_SERVER_BUNDLE_MODE = "source"
        $ServerBundleModeSet = $true
        Write-Host "[VSC] WinUI XAML language server will be published by vscode:prepublish (ensure-server-bundle)." -ForegroundColor Blue
    }

    # Copy CLI binaries from artifacts (skip if source and destination are the same)
    Write-Host "[VSC] Copying CLI binaries to extension..." -ForegroundColor Blue
    $VscBinPath = "bin"
    New-Item -ItemType Directory -Path "$VscBinPath\win-x64" -Force | Out-Null
    New-Item -ItemType Directory -Path "$VscBinPath\win-arm64" -Force | Out-Null

    $resolvedCliBin = (Resolve-Path $CliBinariesPath -ErrorAction SilentlyContinue)?.Path
    $resolvedVscBin = (Resolve-Path $VscBinPath -ErrorAction SilentlyContinue)?.Path
    if ($resolvedCliBin -and $resolvedVscBin -and ($resolvedCliBin -eq $resolvedVscBin)) {
        Write-Host "  CLI binaries already in place (source = destination)" -ForegroundColor Gray
    } else {
        Copy-Item "$CliBinariesPath\win-x64\*.exe" "$VscBinPath\win-x64\" -Force
        Copy-Item "$CliBinariesPath\win-arm64\*.exe" "$VscBinPath\win-arm64\" -Force
    }

    # Sync manifest schemas from NuGet cache after the CLI binaries are available
    Write-Host "[VSC] Syncing manifest schemas..." -ForegroundColor Blue
    $SyncCliPath = Join-Path $VscBinPath 'win-x64\winapp.exe'
    & $PSScriptRoot\sync-schemas.ps1 -CliPath $SyncCliPath
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Schema sync failed"
        Pop-Location
        exit 1
    }
    $schemaFiles = Get-ChildItem -Path "schemas" -Filter "*.xsd" -ErrorAction SilentlyContinue
    if (-not $schemaFiles -or $schemaFiles.Count -eq 0) {
        Write-Error "No schema XSD files found in schemas/ after sync. Packaging would produce a broken extension."
        Pop-Location
        exit 1
    }
    Write-Host "  Found $($schemaFiles.Count) XSD schema files" -ForegroundColor Gray

    # In the monorepo, LICENSE was copied from project root into the VSC subdirectory.
    # In this standalone repo, LICENSE already lives at the project root — no copy needed.

    # Stamp version information into README.md
    Write-Host "[VSC] Stamping version info into README.md..." -ForegroundColor Blue
    $ReadmePath = "README.md"
    Copy-Item $ReadmePath "$ReadmePath.backup" -Force

    # Get CLI version from the bundled x64 binary
    $CliExe = Join-Path $VscBinPath "win-x64\winapp.exe"
    $CliVersion = "unknown"
    if (Test-Path $CliExe) {
        try {
            $RawOutput = & $CliExe --version 2>$null
            # Output may contain ASCII banner art; find the line matching semver pattern
            $VersionLine = $RawOutput | Where-Object { $_ -match '^\d+\.\d+\.\d+' } | Select-Object -First 1
            if (-not [string]::IsNullOrWhiteSpace($VersionLine)) {
                # Strip git hash suffix (e.g., "1.0.0+abc123" -> "1.0.0")
                $CliVersion = ($VersionLine.Trim() -split '\+')[0]
            }
        } catch {
            Write-Warning "Could not determine CLI version from binary"
        }
    }
    Write-Host "[VERSION] Bundled CLI version: $CliVersion" -ForegroundColor Cyan

    # Replace version placeholders in README
    $ReadmeContent = Get-Content $ReadmePath -Raw
    $ReadmeContent = $ReadmeContent -replace '(?<=<!-- EXT_VERSION -->).*?(?=<!-- /EXT_VERSION -->)', $Version
    $ReadmeContent = $ReadmeContent -replace '(?<=<!-- CLI_VERSION -->).*?(?=<!-- /CLI_VERSION -->)', $CliVersion
    Set-Content $ReadmePath -Value $ReadmeContent -NoNewline

    # Backup original package.json
    Write-Host "[VSC] Setting package version to $Version..." -ForegroundColor Blue
    $PackageJsonPath = "package.json"
    Copy-Item $PackageJsonPath "$PackageJsonPath.backup" -Force

    # Update package.json version temporarily
    $PackageJson = Get-Content $PackageJsonPath | ConvertFrom-Json
    $PackageJson.version = $Version
    $PackageJson | ConvertTo-Json -Depth 100 | Set-Content $PackageJsonPath

    # Package the VSIX (vsce installed via npm ci from devDependencies)
    Write-Host "[PACK] Creating VSIX package..." -ForegroundColor Blue

    $RelativeOutputPath = [System.IO.Path]::GetRelativePath($VscProjectPath, $OutputPath)

    npx vsce package --no-dependencies -o "$RelativeOutputPath\winapp-$Version.vsix"
    $PackResult = $LASTEXITCODE

    # Restore original package.json
    Write-Host "[VSC] Restoring original package.json..." -ForegroundColor Blue
    if (Test-Path "$PackageJsonPath.backup") {
        Move-Item "$PackageJsonPath.backup" $PackageJsonPath -Force
    }

    # Restore original README.md
    if (Test-Path "$ReadmePath.backup") {
        Move-Item "$ReadmePath.backup" $ReadmePath -Force
    }

    Pop-Location

    if ($PackResult -ne 0) {
        Write-Error "Failed to create VSIX package"
        exit 1
    }

    # Find the created VSIX and report success
    $CreatedVsix = Get-ChildItem -Path $OutputPath -Filter "winapp-*.vsix" | Sort-Object LastWriteTime -Descending | Select-Object -First 1

    if ($CreatedVsix) {
        $VsixSize = [math]::Round($CreatedVsix.Length / 1MB, 2)
        Write-Host ""
        Write-Host "[SUCCESS] VS Code extension packaged successfully!" -ForegroundColor Green
        Write-Host "[INFO] Package: $($CreatedVsix.Name) ($VsixSize MB)" -ForegroundColor Cyan
        Write-Host "[INFO] Location: $($CreatedVsix.FullName)" -ForegroundColor Cyan
    } else {
        Write-Warning "VSIX was created but could not be located in $OutputPath"
    }

    if ($CreatedVsix) {
        & (Join-Path $PSScriptRoot "validate-vsix-server.ps1") -VsixPath $CreatedVsix.FullName
        if (-not $?) { exit 1 }
    }

    Write-Host "[DONE] VS Code extension packaging complete!" -ForegroundColor Green
}
finally
{
    # Restore original working directory
    Pop-Location

    if ($ServerBundleModeSet) {
        if ($null -eq $PriorServerBundleMode) {
            Remove-Item Env:\WINUI_XAML_SERVER_BUNDLE_MODE -ErrorAction SilentlyContinue
        } else {
            $env:WINUI_XAML_SERVER_BUNDLE_MODE = $PriorServerBundleMode
        }
    }
}
