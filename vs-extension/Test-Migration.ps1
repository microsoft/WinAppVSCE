#requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$IncludeRenderer,
    # Rebuilds both VSIXes (-NoDeploy) and runs the archive/payload/packaging-gate suites.
    [switch]$IncludePackaging
)
$ErrorActionPreference = "Stop"
$root = (Resolve-Path "$PSScriptRoot\..").Path
$pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
if (-not $pwsh) { throw "PowerShell 7 (pwsh) required for surface\Test-Foundation.ps1." }
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$msbuild = & $vswhere -latest -prerelease -products * -version "[17.0,18.0)" -requires Microsoft.Component.MSBuild `
    -find "MSBuild\**\Bin\MSBuild.exe" | Select-Object -First 1
if (-not $msbuild) { throw "Desktop MSBuild (VS2022 17.x) required." }
foreach ($name in @("SurfaceClient.Smoke", "SurfaceClient.UITest", "SurfaceClient.FaultTests")) {
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

# Deterministic resilience/fault-injection suite — drives the production SurfaceClient against a
# controllable fake surface, so it needs no Windows App SDK or real renderer and always runs.
& "$PSScriptRoot\SurfaceClient.FaultTests\bin\x64\Debug\net472\SurfaceClient.FaultTests.exe"
if ($LASTEXITCODE -ne 0) { throw "Fault-injection suite failed (exit $LASTEXITCODE)." }

# Experimental-identity registration logic against mocks; no registration is performed.
& "$PSScriptRoot\Test-ExperimentalIdentity.ps1"

if ($IncludePackaging) {
    foreach ($identity in @("Shipping", "Migration24e47e37")) {
        & "$PSScriptRoot\WinUIXamlPreview\Build-Vsix.ps1" -SurfaceIdentity $identity -NoDeploy
    }
    # Payload contents (Test-VsixPayload) + missing-input packaging gates.
    & "$PSScriptRoot\Test-BuildGuards.ps1"
    # Shipping/experimental archives are never interchangeable.
    & "$PSScriptRoot\Test-ExperimentalPackaging.ps1"
}

# Provisioner unit tests, protocol typecheck and compatibility tests. The real-provisioning and
# actual-user-PRI lanes need the HostSDK stage and the renderer, so they ride -IncludeRenderer.
$foundationArgs = @("-NoProfile", "-File", "$root\surface\Test-Foundation.ps1")
if ($IncludeRenderer) { $foundationArgs += @("-IncludeBuild", "-IncludeRenderer") }
& $pwsh.Source @foundationArgs
if ($LASTEXITCODE -ne 0) { throw "Foundation suite failed (exit $LASTEXITCODE)." }

if (-not $IncludeRenderer) { return }

# Use only a disposable copy of the pristine build, never an installed identity,
# source output or host cache. The smoke client owns/disposes each child PID.
$raw = "$root\surface\obj\PayloadBuild\Surface\bin\x64\Debug\net10.0-windows10.0.26100.0\win-x64"
if (-not (Test-Path "$raw\Surface.exe")) { throw "Run Build-Vsix.ps1 -NoDeploy first (Debug)." }
& dotnet build "$root\surface\TestUserApp\TestUserApp.csproj" -c Debug -p:Platform=x64 `
    -p:RuntimeIdentifier=win-x64 --nologo -v minimal
if ($LASTEXITCODE -ne 0) { throw "TestUserApp build failed (exit $LASTEXITCODE)." }
# Q-suite fixture app: custom/other-project/Toolkit controls and resources at every scope.
& dotnet build "$root\surface\TestFixtureApp\TestFixtureApp.csproj" -c Debug -p:Platform=x64 `
    -p:RuntimeIdentifier=win-x64 --nologo -v minimal
if ($LASTEXITCODE -ne 0) { throw "TestFixtureApp build failed (exit $LASTEXITCODE)." }
$run = "$results\Renderer-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $run -Force | Out-Null
Copy-Item "$raw\*" $run -Recurse -Force
$saved = @{}
# Keep baseline unguarded and prevent inherited external Gallery opt-in.
foreach ($name in @("WINUI_SURFACE_EXE", "WINUI_SURFACE_USER_PRI", "WINUI_GALLERY_PAGE", "SURFACE_GUARDS",
    "SURFACE_RENDER_SETTLE")) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
    [Environment]::SetEnvironmentVariable($name, $null, "Process")
}
try {
    $env:WINUI_SURFACE_EXE = "$run\Surface.exe"
    & "$PSScriptRoot\SurfaceClient.Smoke\bin\x64\Debug\net472\SurfaceClient.Smoke.exe"
    if ($LASTEXITCODE -ne 0) { throw "Renderer smoke failed (exit $LASTEXITCODE)." }
    # I2: every client source-map path must select the same element on the live surface.
    & $ui --parity --surface "$run\Surface.exe" --out $results
    if ($LASTEXITCODE -ne 0) { throw "Caret/designer parity failed (exit $LASTEXITCODE)." }
    # D3: click-to-select (PickAt) incl. transparent-panel padding; framework XAML, no Gallery.
    & $ui --d3 --surface "$run\Surface.exe" --out $results
    if ($LASTEXITCODE -ne 0) { throw "Click-to-select (D3) failed (exit $LASTEXITCODE)." }
    $fixtures = "$root\surface\TestFixtureApp"
    & $ui --fixtures --surface "$run\Surface.exe" --out $results `
        --user-dll "$fixtures\bin\x64\Debug\net10.0-windows10.0.26100.0\TestFixtureApp.dll" `
        --fixtures-dir "$fixtures\Fixtures"
    if ($LASTEXITCODE -ne 0) { throw "Fixture suite failed (exit $LASTEXITCODE)." }
} finally {
    foreach ($name in $saved.Keys) {
        [Environment]::SetEnvironmentVariable($name, $saved[$name], "Process")
    }
}
