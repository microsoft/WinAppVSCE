#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$VsixPath,
    [ValidateSet("Shipping", "Migration24e47e37")][string]$SurfaceIdentity = "Shipping"
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead((Resolve-Path $VsixPath).Path)
try {
    $names = @($zip.Entries | ForEach-Object { [Uri]::UnescapeDataString($_.FullName).Replace('\', '/') })
    $required = @(
        "extension.vsixmanifest", "WinUIXamlPreview.dll", "WinUIXamlPreview.handcrafted.pkgdef",
        "WinUIXamlPreview.Properties.pkgdef",
        "LICENSE.winui-vsc.txt", "System.Text.Json.dll", "System.IO.Pipelines.dll",
        "Microsoft.Bcl.AsyncInterfaces.dll", "System.Text.Encodings.Web.dll",
        "Surface/Surface.exe", "Surface/Surface.dll", "Surface/Surface.pri", "Surface/Surface.wasdk.version",
        "Surface/Surface.deps.json", "Surface/Surface.runtimeconfig.json", "Surface/Microsoft.WinUI.dll",
        "Surface/AppxManifest.xml", "Surface/Assets/StoreLogo.png",
        "Surface/Assets/MedTile.png", "Surface/Assets/AppList.png",
        "HostSDK/engine.stamp", "HostSDK/LICENSE.winui-vsc.txt",
        "HostSDK/surface/Surface/Surface.csproj", "HostSDK/surface/Surface/App.cs",
        "HostSDK/DesignHost/DesignHost.csproj", "HostSDK/DesignHost/Package.appxmanifest",
        "HostSDK/SurfaceProvisioner/SurfaceProvisioner.exe",
        "HostSDK/SurfaceProvisioner/SurfaceProvisioner.dll",
        "HostSDK/SurfaceProvisioner/SurfaceProvisioner.deps.json",
        "HostSDK/SurfaceProvisioner/SurfaceProvisioner.runtimeconfig.json"
    )
    foreach ($name in $required) {
        $index = [Array]::IndexOf($names, $name)
        if ($index -lt 0 -or $zip.Entries[$index].Length -eq 0) { throw "VSIX payload missing/empty: $name" }
    }
    $reader = New-Object IO.StreamReader ($zip.Entries[[Array]::IndexOf($names, "extension.vsixmanifest")].Open())
    try { [xml]$extension = $reader.ReadToEnd() } finally { $reader.Dispose() }
    $packageAssets = @($extension.SelectNodes("//*[local-name()='Asset'][@Type='Microsoft.VisualStudio.VsPackage']") |
        ForEach-Object { $_.Path })
    foreach ($registration in @("WinUIXamlPreview.handcrafted.pkgdef", "WinUIXamlPreview.Properties.pkgdef")) {
        if ($packageAssets -cnotcontains $registration) {
            throw "VSIX does not advertise the package registration asset: $registration"
        }
    }
    $reader = New-Object IO.StreamReader ($zip.Entries[[Array]::IndexOf($names, "WinUIXamlPreview.Properties.pkgdef")].Open())
    try { $propertiesRegistration = $reader.ReadToEnd() } finally { $reader.Dispose() }
    if (-not $propertiesRegistration.Contains('$RootKey$\ToolWindows\{6b1e9d4a-7c83-4f2e-a1d6-2b9c8e5f0a37}')) {
        throw "VSIX lacks the Properties tool-window registration."
    }
    foreach ($notice in @(
        @("LICENSE.winui-vsc.txt", "$PSScriptRoot\..\LICENSE.winui-vsc.txt"),
        @("HostSDK/LICENSE.winui-vsc.txt", "$PSScriptRoot\..\..\surface\LICENSE.winui-vsc.txt"))) {
        $reader = New-Object IO.StreamReader ($zip.Entries[[Array]::IndexOf($names, $notice[0])].Open())
        try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
        if ($text.Replace("`r`n", "`n") -ne [IO.File]::ReadAllText($notice[1]).Replace("`r`n", "`n")) {
            throw "Packaged source notice differs from its owner's notice: $($notice[0])"
        }
    }
    $reader = New-Object IO.StreamReader ($zip.Entries[[Array]::IndexOf($names, "HostSDK/engine.stamp")].Open())
    try { $stamp = $reader.ReadToEnd() } finally { $reader.Dispose() }
    if ($stamp -notmatch '^[a-f0-9]{64}$') { throw "Missing full shared engine/template fingerprint." }
    $bad = @($names | Where-Object {
        $_ -match '(?i)(^|/)(bin|obj|TestResults|qa-results|TestUserApp|WinUIGallery|AIDevGallery|Spike[^/]*)(/|\.|$)' -or
        $_ -match '(?i)(\.bak|\.log|\.user|launchSettings\.json)$' -or
        $_ -match '(?i)^Surface/.*\.(xaml|xbf)$'
    })
    if ($bad) { throw "Contaminated VSIX payload: $($bad -join ', ')" }
    $reader = New-Object IO.StreamReader ($zip.Entries[[Array]::IndexOf($names, "WinUIXamlPreview.handcrafted.pkgdef")].Open())
    try { $pkgdef = $reader.ReadToEnd() } finally { $reader.Dispose() }
    if (-not $pkgdef.Contains('$PackageFolder$\WinUIXamlPreview.dll')) {
        throw "Handcrafted pkgdef lost the required PackageFolder CodeBase workaround."
    }
    # Read the identity from the actual packaged PE resource, not just the staging
    # input file. Extract only to an ignored build directory; never register it.
    $mt = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Filter mt.exe -Recurse |
        Where-Object { $_.FullName -match '\\x64\\' } |
        Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
    if (-not $mt) { throw "Windows SDK x64 mt.exe required to verify packaged identity." }
    $check = Join-Path $PSScriptRoot "obj\IdentityCheck-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $check | Out-Null
    try {
        [IO.Compression.ZipFileExtensions]::ExtractToFile(
            $zip.Entries[[Array]::IndexOf($names, "Surface/Surface.exe")], "$check\Surface.exe")
        & $mt -nologo -inputresource:"$check\Surface.exe;#1" -out:"$check\embedded.manifest"
        if ($LASTEXITCODE -ne 0) { throw "Cannot extract packaged Surface identity." }
        [xml]$embedded = Get-Content "$check\embedded.manifest" -Raw
        $msix = $embedded.SelectSingleNode("//*[local-name()='msix']")
        $reader = New-Object IO.StreamReader ($zip.Entries[[Array]::IndexOf($names, "Surface/AppxManifest.xml")].Open())
        try { [xml]$appx = $reader.ReadToEnd() } finally { $reader.Dispose() }
        $identity = $appx.SelectSingleNode("//*[local-name()='Identity']")
        $application = $appx.SelectSingleNode("//*[local-name()='Application']")
        $expectedName = "WinUIXamlPreviewSurface"
        if ($SurfaceIdentity -ne "Shipping") { $expectedName += ".Migration24e47e37" }
        if ($identity.Name -cne $expectedName -or $identity.Publisher -cne "CN=WinUIXamlPreview" -or
            $application.Id -cne "Surface" -or $application.Executable -cne "Surface.exe" -or
            $identity.Version -cne "1.0.0.0" -or $identity.ProcessorArchitecture -cne "x64") {
            throw "Packaged identity does not match the explicitly selected $SurfaceIdentity configuration."
        }
        if (-not $msix -or $msix.packageName -ne $identity.Name -or
            $msix.publisher -ne $identity.Publisher -or $msix.applicationId -ne $application.Id) {
            throw "Packaged executable sparse identity is absent or inconsistent with AppxManifest.xml."
        }
        [IO.Compression.ZipFileExtensions]::ExtractToFile(
            $zip.Entries[[Array]::IndexOf($names, "WinUIXamlPreview.dll")], "$check\WinUIXamlPreview.dll")
        # Load bytes in an isolated assembly object, not LoadFrom's filename cache across builds.
        $adapter = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes("$check\WinUIXamlPreview.dll"))
        $config = $adapter.GetType("WinUIXamlPreview.Protocol.SurfaceIdentity", $true)
        foreach ($pair in @(@("PackageName", $expectedName), @("Publisher", "CN=WinUIXamlPreview"),
            @("AppId", "Surface"), @("FamilyName", "${expectedName}_p47s87298xgjw"),
            @("IsExperimental", ($SurfaceIdentity -ne "Shipping")))) {
            if ($config.GetField($pair[0]).GetRawConstantValue() -cne $pair[1]) {
                throw "Compiled adapter identity mismatch: $($pair[0])"
            }
        }
        $resource = $adapter.GetManifestResourceStream("WinUIXamlPreview.RegisterExperimental")
        if ($SurfaceIdentity -ne "Shipping") {
            if (-not $resource) { throw "Experimental adapter has no fail-closed registration resource." }
            $reader = New-Object IO.StreamReader $resource
            try { $registration = $reader.ReadToEnd() } finally { $reader.Dispose() }
            if ($registration -match 'Remove-AppxPackage' -or
                $registration -cne [IO.File]::ReadAllText("$PSScriptRoot\SurfaceIdentity\Register-Experimental.ps1")) {
                throw "Experimental adapter registration differs from the tested non-replacing script."
            }
        } elseif ($resource) {
            $resource.Dispose()
            throw "Shipping adapter unexpectedly embeds the experimental registration."
        }
        Write-Host "Packaged sparse identity verified: $($msix.packageName); no registration performed."
    } finally { Remove-Item -LiteralPath $check -Recurse -Force }
    Write-Host "Payload verified: $($names.Count) entries; $($required.Count) required files; no Gallery/test/build contamination."
} finally { $zip.Dispose() }
