#requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet("Debug", "Release")][string]$Configuration = "Debug",
    [ValidateSet("AnyCPU")][string]$Platform = "AnyCPU",
    [string]$WinUISurfaceWasdkVersion = "2.2.0",
    [switch]$NoDeploy
)
$ErrorActionPreference = "Stop"
if (-not $NoDeploy) { throw "Deployment is not supported by this build lane. Specify -NoDeploy." }
$projectDir = $PSScriptRoot
$repoRoot = (Resolve-Path "$projectDir\..\..").Path
$project = "$projectDir\WinUIXamlPreview.csproj"
$vsix = "$projectDir\bin\$Configuration\WinUIXamlPreview.vsix"
function Assert-File([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Required build input/output missing: $Path" }
}
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
Assert-File $vswhere
$msbuild = & $vswhere -latest -prerelease -products * -requires Microsoft.Component.MSBuild `
    -find "MSBuild\**\Bin\MSBuild.exe" | Select-Object -First 1
if (-not $msbuild) { throw "Desktop MSBuild not found via vswhere." }
$mt = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Filter mt.exe -Recurse |
    Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object FullName -Descending |
    Select-Object -First 1 -ExpandProperty FullName
if (-not $mt) { throw "Windows SDK x64 mt.exe required." }
$identity = "$projectDir\SurfaceIdentity"
foreach ($file in @("$identity\Surface.identity.manifest", "$identity\AppxManifest.xml",
    "$repoRoot\vs-extension\LICENSE.winui-vsc.txt")) { Assert-File $file }
if (Test-Path $vsix) { Remove-Item -LiteralPath $vsix -Force }

# Shared sources/build definition contain no VS identity, WPF or VSSDK concerns.
$payload = & "$repoRoot\surface\Build-Payload.ps1" -Configuration $Configuration `
    -WinUISurfaceWasdkVersion $WinUISurfaceWasdkVersion
$hostSdkStage = $payload.HostSdkStageDir
$surfaceOutDir = "$projectDir\obj\IdentityPayload"
if (Test-Path $surfaceOutDir) { Remove-Item -LiteralPath $surfaceOutDir -Recurse -Force }
New-Item -ItemType Directory $surfaceOutDir | Out-Null
Copy-Item "$($payload.SurfaceOutDir)\*" $surfaceOutDir -Recurse -Force
& $mt -nologo -manifest "$identity\Surface.identity.manifest" -outputresource:"$surfaceOutDir\Surface.exe;#1"
if ($LASTEXITCODE -ne 0) { throw "mt.exe identity embed failed (exit $LASTEXITCODE)." }
Copy-Item "$identity\AppxManifest.xml" $surfaceOutDir
$assets = "$surfaceOutDir\Assets"
New-Item -ItemType Directory -Force $assets | Out-Null
Add-Type -AssemblyName System.Drawing
function New-PlaceholderPng([string]$Path, [int]$Width, [int]$Height) {
    $bitmap = New-Object System.Drawing.Bitmap $Width, $Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.Clear([System.Drawing.Color]::FromArgb(255, 0, 120, 215))
        $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
}
New-PlaceholderPng "$assets\StoreLogo.png" 50 50
New-PlaceholderPng "$assets\MedTile.png" 150 150
New-PlaceholderPng "$assets\AppList.png" 44 44

# Fresh restore/evaluation, flat obj, handcrafted pkgdef and forced runtime DLLs retained.
& $msbuild $project /t:Restore /p:Configuration=$Configuration /p:Platform=$Platform `
    /p:DotnetVsixBuild=false /p:DeployExtension=false /v:minimal /nologo
if ($LASTEXITCODE -ne 0) { throw "Adapter restore failed (exit $LASTEXITCODE)." }
& $msbuild $project /t:Rebuild /p:Configuration=$Configuration /p:Platform=$Platform `
    /p:DotnetVsixBuild=false /p:DeployExtension=false /p:SurfaceOutDir=$surfaceOutDir `
    /p:HostSdkStageDir=$hostSdkStage /v:minimal /nologo
if ($LASTEXITCODE -ne 0) { throw "Adapter/VSIX build failed (exit $LASTEXITCODE)." }
Assert-File $vsix
& "$projectDir\Test-VsixPayload.ps1" -VsixPath $vsix
Write-Host "VSIX (not deployed): $vsix" -ForegroundColor Green
