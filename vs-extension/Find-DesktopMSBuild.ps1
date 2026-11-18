#requires -Version 5.1
# Returns the desktop MSBuild.exe of the newest complete VS 2022 (17.x) or VS 2026 (18.x) install.
# Installs missing the .NET SDK or the .NET Framework 4.7.2 targeting pack (e.g. a bare Build Tools
# install) are skipped rather than picked and failing later for unrelated reasons.
$ErrorActionPreference = "Stop"
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) { throw "vswhere.exe not found: $vswhere" }
$msbuild = & $vswhere -latest -prerelease -products * -version "[17.0,19.0)" `
    -requires Microsoft.Component.MSBuild Microsoft.NetCore.Component.SDK Microsoft.Net.Component.4.7.2.TargetingPack `
    -find "MSBuild\**\Bin\MSBuild.exe" | Select-Object -First 1
if (-not $msbuild) {
    throw ("Desktop MSBuild not found. Install Visual Studio 2022 or 2026 (any edition or Build Tools) with " +
        "MSBuild, the .NET SDK and the .NET Framework 4.7.2 targeting pack.")
}
$msbuild
