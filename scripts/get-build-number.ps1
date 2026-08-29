<#
.SYNOPSIS
    Calculates the build number based on commits since the last version change.

.DESCRIPTION
    Counts the number of commits since package.json's "version" field was last modified.
    Used by package-vsc.ps1 to generate prerelease version suffixes.

.OUTPUTS
    Returns the build number as an integer.

.EXAMPLE
    .\get-build-number.ps1
#>

param(
    [string]$ProjectRoot = ($PSScriptRoot | Split-Path -Parent)
)

$ErrorActionPreference = "Stop"
$PackageJsonPath = Join-Path $ProjectRoot "package.json"

# Ensure we're in a git repository
Push-Location $ProjectRoot
try {
    if (-not (Test-Path ".git")) {
        Write-Error "Not in a git repository root."
        exit 1
    }

    # Find the last commit that changed the version line, not merely another
    # package.json contribution or script entry.
    $lastVersionCommit = git log -1 --format="%H" -G '^\s*"version"\s*:' -- $PackageJsonPath 2>$null

    if ([string]::IsNullOrEmpty($lastVersionCommit)) {
        $buildNumber = git rev-list --count HEAD 2>$null
        if ([string]::IsNullOrEmpty($buildNumber)) {
            Write-Output "1"
            exit 0
        }
    } else {
        $buildNumber = git rev-list --count "$lastVersionCommit..HEAD" 2>$null
        if ([string]::IsNullOrEmpty($buildNumber)) {
            $buildNumber = 0
        }
        $buildNumber = [int]$buildNumber + 1
    }

    # Local packaging can include uncommitted changes without advancing HEAD.
    # Keep prerelease identities monotonic when an earlier VSIX already exists.
    $baseVersion = (Get-Content $PackageJsonPath -Raw | ConvertFrom-Json).version
    $artifactDirectory = Join-Path $ProjectRoot "artifacts"
    if (Test-Path $artifactDirectory) {
        $escapedVersion = [Regex]::Escape($baseVersion)
        $existingBuilds = Get-ChildItem $artifactDirectory -Filter "winapp-$baseVersion-prerelease.*.vsix" |
            ForEach-Object {
                if ($_.Name -match "^winapp-$escapedVersion-prerelease\.(\d+)\.vsix$") {
                    [int]$Matches[1]
                }
            }
        if ($existingBuilds) {
            $buildNumber = [Math]::Max([int]$buildNumber, ([int]($existingBuilds | Measure-Object -Maximum).Maximum) + 1)
        }
    }

    Write-Output $buildNumber
} finally {
    Pop-Location
}
