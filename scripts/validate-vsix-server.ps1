#!/usr/bin/env pwsh

param(
    [Parameter(Mandatory=$true)]
    [string]$VsixPath
)

$ErrorActionPreference = "Stop"
$ResolvedVsix = Resolve-Path $VsixPath -ErrorAction Stop
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($ResolvedVsix.Path)
try {
    # The server ships as one Native AOT executable per architecture, plus the shared,
    # framework-dependent generator host that runs source generators out of process.
    $requiredRelativeFiles = @(
        'win-x64/WinUiXaml.LanguageServer.exe',
        'win-arm64/WinUiXaml.LanguageServer.exe',
        'generator-host/WinUiXaml.GeneratorHost.dll',
        'generator-host/WinUiXaml.GeneratorHost.deps.json',
        'generator-host/WinUiXaml.GeneratorHost.runtimeconfig.json'
    )
    foreach ($relativeFile in $requiredRelativeFiles) {
        $entry = "extension/dist/server/$relativeFile"
        if (-not ($zip.Entries | Where-Object { $_.FullName -ieq $entry })) {
            throw "VSIX is missing required server file: $entry"
        }
    }
    # A Native AOT publish is self-contained, so any CoreCLR runtime file means the server was
    # published the old way. The managed server assembly is likewise not allowed to ship.
    $forbiddenNames = @(
        'WinUiXaml.LanguageServer.dll',
        'WinUiXaml.LanguageServer.deps.json',
        'WinUiXaml.LanguageServer.runtimeconfig.json',
        'hostfxr.dll',
        'hostpolicy.dll',
        'coreclr.dll',
        'clrjit.dll',
        'System.Private.CoreLib.dll',
        'dotnet.exe',
        'dotnet.dll',
        'dotnet.deps.json',
        'dotnet.runtimeconfig.json'
    )
    foreach ($entry in $zip.Entries | Where-Object {
        $_.FullName.StartsWith('extension/dist/server/', [System.StringComparison]::OrdinalIgnoreCase)
    }) {
        $name = ($entry.FullName -split '/')[-1]
        # The server executable is the one expected apphost; any other is a stale launcher.
        $isUnexpectedAppHost = $name -imatch '^WinUiXaml\..*\.exe$' -and
            $name -ine 'WinUiXaml.LanguageServer.exe'
        if (($forbiddenNames -icontains $name) -or $isUnexpectedAppHost) {
            throw "VSIX must not bundle a .NET apphost or runtime file: $($entry.FullName)"
        }
    }
}
finally {
    $zip.Dispose()
}

Write-Host "[VALIDATE] VSIX contains the Native AOT server for each architecture and no bundled .NET runtime." -ForegroundColor Green
