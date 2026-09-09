#requires -Version 5.1
# Validate actual archives; mutations are confined to a new ignored fixture archive.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$project = "$PSScriptRoot\WinUIXamlPreview"
$shipping = "$project\bin\Debug\WinUIXamlPreview.vsix"
$experimental = "$project\bin\Debug\Migration24e47e37\WinUIXamlPreview.vsix"
$fixture = "$PSScriptRoot\obj\IdentityArchive-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory $fixture | Out-Null
function Assert-Rejected([string]$Archive, [string]$Configuration, [string]$Reason) {
    $rejected = $false
    try { & "$project\Test-VsixPayload.ps1" -VsixPath $Archive -SurfaceIdentity $Configuration }
    catch {
        if ($_.Exception.Message -notmatch $Reason) { throw }
        $rejected = $true
    }
    if (-not $rejected) { throw "Expected validation failure: $Reason" }
    Write-Host "PASS: $Reason"
}
try {
    Assert-Rejected $shipping Migration24e47e37 'explicitly selected Migration24e47e37'
    Assert-Rejected $experimental Shipping 'explicitly selected Shipping'
    Copy-Item $experimental "$fixture\mixed.vsix"
    $source = [IO.Compression.ZipFile]::OpenRead($shipping)
    $mixed = [IO.Compression.ZipFile]::Open("$fixture\mixed.vsix", [IO.Compression.ZipArchiveMode]::Update)
    try {
        $mixed.GetEntry('WinUIXamlPreview.dll').Delete()
        $inputStream = $source.GetEntry('WinUIXamlPreview.dll').Open()
        $outputStream = $mixed.CreateEntry('WinUIXamlPreview.dll').Open()
        try { $inputStream.CopyTo($outputStream) }
        finally { $inputStream.Dispose(); $outputStream.Dispose() }
    } finally { $source.Dispose(); $mixed.Dispose() }
    Assert-Rejected "$fixture\mixed.vsix" Migration24e47e37 'Compiled adapter identity mismatch'
    Copy-Item $experimental "$fixture\unadvertised.vsix"
    $broken = [IO.Compression.ZipFile]::Open("$fixture\unadvertised.vsix", [IO.Compression.ZipArchiveMode]::Update)
    try {
        $entry = $broken.GetEntry('extension.vsixmanifest')
        $reader = New-Object IO.StreamReader ($entry.Open())
        try { [xml]$xml = $reader.ReadToEnd() } finally { $reader.Dispose() }
        $xml.SelectSingleNode("//*[local-name()='Asset'][@Path='WinUIXamlPreview.handcrafted.pkgdef']").SetAttribute('Path', 'WinUIXamlPreview.dll')
        $entry.Delete()
        $writer = New-Object IO.StreamWriter ($broken.CreateEntry('extension.vsixmanifest').Open())
        try { $writer.Write($xml.OuterXml) } finally { $writer.Dispose() }
    } finally { $broken.Dispose() }
    Assert-Rejected "$fixture\unadvertised.vsix" Migration24e47e37 'does not advertise the package registration asset'
    Write-Host 'Experimental packaging: 4 negative archive tests passed; no deployment/registration.'
} finally { Remove-Item -LiteralPath $fixture -Recurse -Force }
