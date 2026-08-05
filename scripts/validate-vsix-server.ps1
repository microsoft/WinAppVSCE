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
        'WinUiXaml.LanguageServer.exe',
        'WinUiXaml.LanguageServer.dll',
        'WinUiXaml.LanguageServer.deps.json',
        'WinUiXaml.LanguageServer.runtimeconfig.json',
        'WinUiXaml.Workspace.dll',
        'WinUiXaml.Xaml.dll',
        'hostfxr.dll',
        'hostpolicy.dll',
        'coreclr.dll',
        'clrjit.dll',
        'System.Private.CoreLib.dll',
        'dotnet.exe',
        'dotnet.dll',
        'dotnet.deps.json',
        'dotnet.runtimeconfig.json',
        'BuildHost-netcore/Microsoft.CodeAnalysis.Workspaces.MSBuild.BuildHost.dll',
        'BuildHost-netcore/Microsoft.CodeAnalysis.Workspaces.MSBuild.BuildHost.deps.json',
        'BuildHost-netcore/Microsoft.CodeAnalysis.Workspaces.MSBuild.BuildHost.runtimeconfig.json'
    )
    foreach ($rid in @('win-x64', 'win-arm64')) {
        foreach ($relativeFile in $requiredRelativeFiles) {
            $entry = "extension/dist/server/$rid/$relativeFile"
            if (-not ($zip.Entries | Where-Object { $_.FullName -ieq $entry })) {
                throw "VSIX is missing required server file: $entry"
            }
        }
    }
}
finally {
    $zip.Dispose()
}

Write-Host "[VALIDATE] VSIX contains both self-contained servers and MSBuild BuildHost." -ForegroundColor Green
