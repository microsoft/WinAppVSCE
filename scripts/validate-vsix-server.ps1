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
    $requiredRelativeFiles = @(
        'WinUiXaml.LanguageServer.dll',
        'WinUiXaml.LanguageServer.deps.json',
        'WinUiXaml.LanguageServer.runtimeconfig.json',
        'WinUiXaml.Workspace.dll',
        'WinUiXaml.Xaml.dll',
        'BuildHost-netcore/Microsoft.CodeAnalysis.Workspaces.MSBuild.BuildHost.dll',
        'BuildHost-netcore/Microsoft.CodeAnalysis.Workspaces.MSBuild.BuildHost.deps.json',
        'BuildHost-netcore/Microsoft.CodeAnalysis.Workspaces.MSBuild.BuildHost.runtimeconfig.json'
    )
    foreach ($relativeFile in $requiredRelativeFiles) {
        $entry = "extension/dist/server/$relativeFile"
        if (-not ($zip.Entries | Where-Object { $_.FullName -ieq $entry })) {
            throw "VSIX is missing required server file: $entry"
        }
    }
    $forbiddenNames = @(
        'WinUiXaml.LanguageServer.exe',
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
        if (($forbiddenNames -icontains $name) -or $name -imatch '^WinUiXaml\..*\.exe$') {
            throw "VSIX must not bundle a .NET apphost or runtime file: $($entry.FullName)"
        }
    }
}
finally {
    $zip.Dispose()
}

Write-Host "[VALIDATE] VSIX contains the framework-dependent server and no bundled .NET runtime." -ForegroundColor Green
