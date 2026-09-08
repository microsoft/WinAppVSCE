#requires -Version 5.1
# Exercise packaging failure gates without changing sources or deploying anything.
$ErrorActionPreference = "Stop"
$projectDir = "$PSScriptRoot\WinUIXamlPreview"
$vsix = "$projectDir\bin\Debug\WinUIXamlPreview.vsix"
& "$projectDir\Test-VsixPayload.ps1" -VsixPath $vsix
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$msbuild = & $vswhere -latest -prerelease -products * -requires Microsoft.Component.MSBuild `
    -find "MSBuild\**\Bin\MSBuild.exe" | Select-Object -First 1
if (-not $msbuild) { throw "Desktop MSBuild required." }
$check = "$projectDir\obj\GuardCheck-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $check | Out-Null
try {
    [IO.Compression.ZipFile]::ExtractToDirectory((Resolve-Path $vsix).Path, $check)
    foreach ($missing in @("Surface\Surface.exe", "Surface\AppxManifest.xml",
        "HostSDK\SurfaceProvisioner\SurfaceProvisioner.dll", "HostSDK\LICENSE.winui-vsc.txt",
        "Surface\Surface.wasdk.version")) {
        $path = Join-Path $check $missing
        Move-Item $path "$path.hidden"
        try {
            $output = & $msbuild "$projectDir\WinUIXamlPreview.csproj" /t:ValidateDesignerPayload `
                /p:DotnetVsixBuild=false /p:DeployExtension=false `
                /p:SurfaceOutDir="$check\Surface" /p:HostSdkStageDir="$check\HostSDK" /nologo /v:minimal 2>&1
            if ($LASTEXITCODE -eq 0 -or ($output -join "`n") -notmatch "Required designer payload missing") {
                throw "Expected missing-input failure not observed: $missing`n$($output -join '`n')"
            }
            Write-Host "PASS: packaging rejects missing $missing"
        } finally { Move-Item "$path.hidden" $path }
    }
    $refused = $false
    try { & "$projectDir\Build-Vsix.ps1" }
    catch {
        if ($_.Exception.Message -notmatch "Specify -NoDeploy") { throw }
        $refused = $true
    }
    if (-not $refused) { throw "Build should require explicit -NoDeploy." }
    Write-Host "PASS: build refuses invocation without -NoDeploy"
} finally { Remove-Item -LiteralPath $check -Recurse -Force }
# Expected native failures above must not leak a failure exit status to script callers.
$global:LASTEXITCODE = 0
