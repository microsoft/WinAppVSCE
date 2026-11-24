#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Download the pinned WinApp CLI release or verified main CI artifact.
.DESCRIPTION
    Downloads the x64 and arm64 WinApp CLI binaries from microsoft/winappcli GitHub
    releases and extracts them to bin/win-x64 and bin/win-arm64 respectively.
    These binaries are bundled into the VS Code extension for local testing.
.PARAMETER Tag
    The release tag to download (e.g., "v0.3.2").
    Use "latest" to download the latest stable release.
    Overrides the source pinned in cli-version.json.
.PARAMETER DestinationPath
    Directory that receives win-x64 and win-arm64. Defaults to the repository bin directory.
.EXAMPLE
    .\scripts\download-cli.ps1
    .\scripts\download-cli.ps1 -Tag v0.3.2
    .\scripts\download-cli.ps1 -Tag latest
#>

param(
    [Parameter(Mandatory=$false)]
    [string]$Tag,

    [Parameter(Mandatory=$false)]
    [string]$DestinationPath
)

$ErrorActionPreference = "Stop"
$repo = "microsoft/winappcli"
$projectRoot = Split-Path $PSScriptRoot -Parent
$versionFile = Join-Path $projectRoot "cli-version.json"
$pin = if (Test-Path $versionFile) {
    Get-Content $versionFile -Raw | ConvertFrom-Json
} else {
    $null
}
$binDir = if ([string]::IsNullOrWhiteSpace($DestinationPath)) {
    Join-Path $projectRoot "bin"
} else {
    [System.IO.Path]::GetFullPath($DestinationPath)
}

# Preview builds use an immutable, hash-verified artifact from upstream main.
if ([string]::IsNullOrWhiteSpace($Tag) -and [string]::IsNullOrWhiteSpace($env:WINAPP_CLI_RELEASE_TAG) -and $pin.ciBuild) {
    $build = $pin.ciBuild
    if ($build.commit -notmatch '^[0-9a-f]{40}$' -or $build.sha256 -notmatch '^[0-9a-f]{64}$' -or
        "$($build.runId)" -notmatch '^\d+$' -or "$($build.artifactId)" -notmatch '^\d+$') {
        throw "Invalid CLI CI build pin."
    }
    $run = gh api "repos/$repo/actions/runs/$($build.runId)" | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw "Cannot read the pinned upstream run. GitHub Actions artifact access is required." }
    if ($run.head_sha -ne $build.commit -or $run.head_branch -ne 'main' -or
        $run.event -ne 'push' -or $run.conclusion -ne 'success') {
        throw "The pinned CLI run is not a successful main push at $($build.commit)."
    }
    $artifact = gh api "repos/$repo/actions/artifacts/$($build.artifactId)" | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw "Cannot read the pinned CLI artifact." }
    if ($artifact.name -ne 'cli-binaries' -or $artifact.expired -or
        $artifact.workflow_run.id -ne $build.runId -or $artifact.digest -ne "sha256:$($build.sha256)") {
        throw "The pinned CLI artifact is expired or does not match the recorded build."
    }
    $stage = Join-Path ([IO.Path]::GetTempPath()) ("winapp-cli-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage | Out-Null
    try {
        $archivePath = Join-Path $stage 'cli.zip'
        # Native redirection preserves binary stdout in PowerShell 7.4 and later.
        if ($PSVersionTable.PSVersion -lt [version]'7.4') { throw "Downloading CLI CI artifacts requires PowerShell 7.4 or later." }
        gh api "repos/$repo/actions/artifacts/$($build.artifactId)/zip" > $archivePath
        if ($LASTEXITCODE -ne 0) { throw "Failed to download the pinned CLI artifact." }
        if ((Get-FileHash $archivePath -Algorithm SHA256).Hash -ne $build.sha256) { throw "CLI artifact SHA256 mismatch." }
        $zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
        try {
            foreach ($entry in $zip.Entries) {
                if ($entry.FullName.EndsWith('/') -or $entry.FullName.EndsWith('.pdb')) { continue }
                $relative = $entry.FullName.Replace('/', '\')
                if ($relative -notmatch '^win-(x64|arm64)\\[^\\]+$') { throw "Unexpected CLI artifact entry: $relative" }
                $target = Join-Path $binDir $relative
                New-Item -ItemType Directory -Force (Split-Path $target -Parent) | Out-Null
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
            }
        } finally { $zip.Dispose() }
        foreach ($arch in @('win-x64', 'win-arm64')) {
            foreach ($file in @('winapp.exe', 'WinApp.DevTools.Native.dll', 'WinApp.DevTools.Managed.dll',
                'libSkiaSharp.dll', 'libHarfBuzzSharp.dll', 'winapp-devtools-schema.json')) {
                if (-not (Test-Path (Join-Path $binDir "$arch\$file"))) { throw "CLI artifact missing $arch\$file" }
            }
        }
        Write-Host "[CLI] Downloaded main@$($build.commit), run $($build.runId), verified SHA256."
    } finally { Remove-Item -LiteralPath $stage -Recurse -Force }
    exit 0
}
$pinnedTag = $pin.releaseTag
$Tag = if ([string]::IsNullOrWhiteSpace($Tag)) {
    if ([string]::IsNullOrWhiteSpace($env:WINAPP_CLI_RELEASE_TAG)) {
        if ([string]::IsNullOrWhiteSpace($pinnedTag)) {
            throw "No WinApp CLI release tag was provided and cli-version.json has no releaseTag."
        }
        $pinnedTag
    }
    else { $env:WINAPP_CLI_RELEASE_TAG }
} else {
    $Tag
}
if ($Tag -notmatch '^(latest|v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$') {
    throw "Invalid WinApp CLI release tag: '$Tag'"
}
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
