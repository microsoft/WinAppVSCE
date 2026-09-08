#requires -Version 5.1
[CmdletBinding()]
param([switch]$IncludeRenderer)
$ErrorActionPreference = "Stop"
$root = (Resolve-Path "$PSScriptRoot\..").Path
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$msbuild = & $vswhere -latest -prerelease -products * -requires Microsoft.Component.MSBuild `
    -find "MSBuild\**\Bin\MSBuild.exe" | Select-Object -First 1
if (-not $msbuild) { throw "Desktop MSBuild required." }
foreach ($name in @("SurfaceClient.Smoke", "SurfaceClient.UITest")) {
    & $msbuild "$PSScriptRoot\$name\$name.csproj" /restore /nologo `
        /p:Configuration=Debug /p:Platform=x64 /v:minimal
    if ($LASTEXITCODE -ne 0) { throw "$name build failed (exit $LASTEXITCODE)." }
}
$ui = "$PSScriptRoot\SurfaceClient.UITest\bin\x64\Debug\net472\SurfaceClient.UITest.exe"
$results = "$PSScriptRoot\SurfaceClient.UITest\TestResults\Migration"
foreach ($mode in @("--d2", "--d2residual")) {
    & $ui $mode --out $results
    if ($LASTEXITCODE -ne 0) { throw "$mode failed (exit $LASTEXITCODE)." }
}
if (-not $IncludeRenderer) { return }

# Use only a disposable copy of the pristine build, never an installed identity,
# source output or host cache. The smoke client owns/disposes each child PID.
$raw = "$root\surface\obj\PayloadBuild\Surface\bin\x64\Debug\net10.0-windows10.0.26100.0\win-x64"
if (-not (Test-Path "$raw\Surface.exe")) { throw "Run Build-Vsix.ps1 -NoDeploy first (Debug)." }
& dotnet build "$root\surface\TestUserApp\TestUserApp.csproj" -c Debug -p:Platform=x64 `
    -p:RuntimeIdentifier=win-x64 --nologo -v minimal
if ($LASTEXITCODE -ne 0) { throw "TestUserApp build failed (exit $LASTEXITCODE)." }
$run = "$results\Renderer-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $run -Force | Out-Null
Copy-Item "$raw\*" $run -Recurse -Force
$saved = @{}
# Keep baseline unguarded and prevent inherited external Gallery opt-in.
foreach ($name in @("WINUI_SURFACE_EXE", "WINUI_SURFACE_USER_PRI", "WINUI_GALLERY_PAGE", "SURFACE_GUARDS",
    "SURFACE_LIVE_MODE", "SURFACE_DTD_REFLECT", "SURFACE_RENDER_SETTLE")) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
    [Environment]::SetEnvironmentVariable($name, $null, "Process")
}
try {
    $env:WINUI_SURFACE_EXE = "$run\Surface.exe"
    & "$PSScriptRoot\SurfaceClient.Smoke\bin\x64\Debug\net472\SurfaceClient.Smoke.exe"
    if ($LASTEXITCODE -ne 0) { throw "Renderer smoke failed (exit $LASTEXITCODE)." }
} finally {
    foreach ($name in $saved.Keys) {
        [Environment]::SetEnvironmentVariable($name, $saved[$name], "Process")
    }
}
