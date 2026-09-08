#requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet("Debug", "Release")][string]$Configuration = "Debug",
    [string]$WinUISurfaceWasdkVersion = "2.2.0"
)
$ErrorActionPreference = "Stop"
# This script owns only these generated children, never a user cache or caller source.
$work = Join-Path $PSScriptRoot "obj\PayloadBuild"
$sdk = Join-Path $PSScriptRoot "obj\HostSDK"
function Assert-File([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Required shared input/output missing: $Path" }
}
function Copy-SourceTree([string]$Source, [string]$Destination) {
    & robocopy $Source $Destination /E /XD bin obj .vs .git Properties `
        /XF .gitignore *.bak *.user *.log *.vsix /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Host
    if ($LASTEXITCODE -ge 8) { throw "Source staging failed: $Source (robocopy $LASTEXITCODE)" }
}
foreach ($file in @("Surface\Surface.csproj", "Surface\App.cs", "DesignHost\DesignHost.csproj",
    "DesignHost\Package.appxmanifest", "SurfaceProvisioner\SurfaceProvisioner.csproj",
    "SurfaceProvisioner\HostBuilder.cs", "Shared\HostPayload.cs", "LICENSE.winui-vsc.txt")) {
    Assert-File "$PSScriptRoot\$file"
}
Get-Command dotnet -ErrorAction Stop | Out-Null
# A second packaging client must not concurrently delete this build's staging.
$lockPath = Join-Path $PSScriptRoot "obj\payload.lock"
New-Item -ItemType Directory -Force (Split-Path $lockPath) | Out-Null
$lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
try {
    foreach ($dir in @($work, $sdk)) {
        if (Test-Path $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
        New-Item -ItemType Directory $dir | Out-Null
    }
    Copy-SourceTree "$PSScriptRoot\Surface" "$work\Surface"
    Copy-SourceTree "$PSScriptRoot\SurfaceProvisioner" "$work\SurfaceProvisioner"
    Copy-SourceTree "$PSScriptRoot\Shared" "$work\Shared"
    & dotnet build "$work\Surface\Surface.csproj" -c $Configuration -p:Platform=x64 `
        -p:RuntimeIdentifier=win-x64 "-p:WinUISurfaceWasdkVersion=$WinUISurfaceWasdkVersion" --nologo -v minimal | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Surface build failed (exit $LASTEXITCODE)." }
    $raw = "$work\Surface\bin\x64\$Configuration\net10.0-windows10.0.26100.0\win-x64"
    foreach ($file in @("Surface.exe", "Surface.dll", "Surface.deps.json", "Surface.runtimeconfig.json",
        "Surface.pri", "Microsoft.WinUI.dll")) { Assert-File "$raw\$file" }
    Set-Content "$raw\Surface.wasdk.version" $WinUISurfaceWasdkVersion -NoNewline -Encoding ASCII
    # Installed SDK layout is deliberately backward compatible, NOT source ownership.
    Copy-SourceTree "$PSScriptRoot\Surface" "$sdk\surface\Surface"
    Copy-SourceTree "$PSScriptRoot\DesignHost" "$sdk\DesignHost"
    Copy-Item "$PSScriptRoot\LICENSE.winui-vsc.txt" "$sdk\LICENSE.winui-vsc.txt"
    & dotnet build "$work\SurfaceProvisioner\SurfaceProvisioner.csproj" -c $Configuration `
        -p:Platform=x64 -o "$sdk\SurfaceProvisioner" --nologo -v minimal | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "SurfaceProvisioner build failed (exit $LASTEXITCODE)." }
    foreach ($file in @("SurfaceProvisioner.exe", "SurfaceProvisioner.dll",
        "SurfaceProvisioner.runtimeconfig.json", "SurfaceProvisioner.deps.json")) {
        Assert-File "$sdk\SurfaceProvisioner\$file"
    }
    # Every source/asset and the provisioner implementation affect this distribution identity.
    # Explicit source tree enumeration avoids compiled MVID/build timestamp fingerprints.
    $lines = foreach ($name in @("Surface", "DesignHost", "SurfaceProvisioner", "Shared")) {
        Get-ChildItem "$PSScriptRoot\$name" -Recurse -File |
            Where-Object { $_.FullName.Substring($PSScriptRoot.Length) -notmatch '\\(bin|obj|Properties)\\' } |
            ForEach-Object { "$($_.FullName.Substring($PSScriptRoot.Length))=$((Get-FileHash $_.FullName -Algorithm SHA256).Hash)" }
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $stamp = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(
            (($lines | Sort-Object) -join "`n")))).Replace('-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
    Set-Content "$sdk\engine.stamp" $stamp -NoNewline -Encoding ASCII
    [pscustomobject]@{ SurfaceOutDir = $raw; HostSdkStageDir = $sdk; EngineStamp = $stamp }
} finally { $lock.Dispose() }
