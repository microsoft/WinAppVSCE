<#
.SYNOPSIS
  Runs the in-VS integration tests (WinUIXamlPreview.IntegrationTests) against a real Visual Studio.

.DESCRIPTION
  Builds the product VSIX, the test-only agent VSIX and the runner, then runs the runner on a separate,
  never-shown Windows desktop so VS, VSIXInstaller and Surface windows don't appear on screen or take focus.
  Both VSIXes are installed into the dedicated "WinUIPreviewTest" root suffix only (never your normal or Exp hive).
  The first run primes that hive (first-run dialog) which adds ~1 minute.

.EXAMPLE
  .\Test-VsIntegration.ps1                      # everything
  .\Test-VsIntegration.ps1 -Group Load,Margin   # selected sections
  .\Test-VsIntegration.ps1 -SkipBuild -Visible  # reuse binaries, run on the normal desktop (debugging)
#>
param(
    [string[]] $Group,
    [switch] $SkipBuild,
    [switch] $NoInstall,
    [switch] $Visible,
    [switch] $KeepOpen,
    [string] $OutDir = (Join-Path $env:TEMP "wxp-vs-integration"),
    [int] $TimeoutMinutes = 45
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -prerelease -version "[17.8,19.0)" -requires Microsoft.VisualStudio.Component.CoreEditor -format json | ConvertFrom-Json | Select-Object -First 1
if (-not $vs) { throw "No Visual Studio 17.8+ found." }
$devenv = Join-Path $vs.installationPath "Common7\IDE\devenv.exe"

$productVsix = Join-Path $here "WinUIXamlPreview\bin\Debug\WinUIXamlPreview.vsix"
$agentProj = Join-Path $here "WinUIXamlPreview.TestAgent\WinUIXamlPreview.TestAgent.csproj"
$agentVsix = Join-Path $here "WinUIXamlPreview.TestAgent\bin\Debug\WinUIXamlPreview.TestAgent.vsix"
$runnerProj = Join-Path $here "WinUIXamlPreview.IntegrationTests\WinUIXamlPreview.IntegrationTests.csproj"
$runnerExe = Join-Path $here "WinUIXamlPreview.IntegrationTests\bin\Debug\net472\WinUIXamlPreview.IntegrationTests.exe"

if (-not $SkipBuild) {
    Write-Host "Building product VSIX..."
    & (Join-Path $here "Build-Vsix.ps1") -NoDeploy | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Build-Vsix.ps1 failed" }

    $msb = & (Join-Path $here "Find-DesktopMSBuild.ps1")
    Write-Host "Building test agent VSIX..."
    & $msb $agentProj /restore /p:Configuration=Debug /v:m /nologo | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "TestAgent build failed" }

    Write-Host "Building runner..."
    dotnet build $runnerProj -c Debug -v q --nologo | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "IntegrationTests build failed" }
}

foreach ($f in $productVsix, $agentVsix, $runnerExe) { if (-not (Test-Path $f)) { throw "Missing $f (drop -SkipBuild)" } }

$runnerArgs = @('--devenv', "`"$devenv`"", '--instance', $vs.instanceId, '--out', "`"$OutDir`"",
    '--vsix', "`"$productVsix`"", '--agent-vsix', "`"$agentVsix`"")
if ($Group) { $runnerArgs += @('--group', ($Group -join ',')) }
if ($NoInstall) { $runnerArgs += '--no-install' }
if ($KeepOpen) { $runnerArgs += '--keep-open' }

New-Item -ItemType Directory -Force $OutDir | Out-Null
$results = Join-Path $OutDir "results.log"
Remove-Item $results -ErrorAction SilentlyContinue

if ($Visible) {
    & $runnerExe @($runnerArgs | ForEach-Object { $_.Trim('"') })
    $code = $LASTEXITCODE
} else {
    Write-Host "Running on a hidden desktop (nothing will appear on screen); results: $results"
    $cmdLine = "`"`"$runnerExe`" $($runnerArgs -join ' ')`""
    & (Join-Path $here "Invoke-HiddenDesktop.ps1") -CommandLine $cmdLine -DesktopName "wxp-vs-integration" -TimeoutSeconds ($TimeoutMinutes * 60)
    $code = $LASTEXITCODE
    if (Test-Path $results) { Get-Content $results | Out-Host }
}

exit $code
