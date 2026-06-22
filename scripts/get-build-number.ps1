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

$ErrorActionPreference = "Stop"
$ProjectRoot = $PSScriptRoot | Split-Path -Parent
$PackageJsonPath = Join-Path $ProjectRoot "package.json"

# Ensure we're in a git repository
Push-Location $ProjectRoot
try {
    if (-not (Test-Path ".git")) {
        Write-Error "Not in a git repository root."
        exit 1
    }

    # Get the commit hash where package.json was last changed
    $lastVersionCommit = git log -1 --format="%H" -- $PackageJsonPath 2>$null

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

    Write-Output $buildNumber
} finally {
    Pop-Location
}
