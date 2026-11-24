#requires -Version 5.1
# No real AppX commands: these local mocks shadow every registration operation.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\WinUIXamlPreview\SurfaceIdentity\Register-Experimental.ps1"
$root = "$PSScriptRoot\obj\IdentityFixture-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory $root | Out-Null
$manifest = "$root\AppxManifest.xml"
$name = 'WinUIXamlPreviewSurface.Migration24e47e37'
$script:addCalls = 0
$script:queryCalls = 0
$script:removeCalls = 0
$script:packages = @()
$script:queryError = $false
function Get-AppxPackage {
    param($Name, $ErrorAction)
    $script:queryCalls++
    if ($Name -cne $name) { throw "Unexpected package query: $Name" }
    if ($script:queryError) { throw 'Injected query failure' }
    return $script:packages
}
function Add-AppxPackage {
    param($Register, $ExternalLocation, $ErrorAction)
    $script:addCalls++
    if ($Register -ine $manifest -or $ExternalLocation -ine $root) { throw 'Unexpected registration paths' }
    $script:packages = @(New-Registration $root)
}
function Remove-AppxPackage {
    $script:removeCalls++
    throw 'Unregister is forbidden'
}
function New-Registration([string]$Location) {
    return [pscustomobject]@{
        Name=$name; Publisher='CN=WinUIXamlPreview'; InstallLocation=$Location; Status='Ok'
        PackageFullName="${name}_1.0.0.0_x64__p47s87298xgjw"
    }
}
function Reset-Fixture {
    $script:addCalls = 0; $script:queryCalls = 0; $script:removeCalls = 0
    $script:packages = @(); $script:queryError = $false
    [xml]$xml = Get-Content "$PSScriptRoot\WinUIXamlPreview\SurfaceIdentity\AppxManifest.xml" -Raw
    $xml.SelectSingleNode("//*[local-name()='Identity']").SetAttribute('Name', $name)
    $xml.Save($manifest)
}
$passed = 0
function Assert-Rejected([string]$Label) {
    $rejected = $false
    try { Invoke-ExperimentalSurfaceRegistration $root $manifest | Out-Null }
    catch { $rejected = $true }
    if (-not $rejected -or $script:addCalls -ne 0 -or $script:removeCalls -ne 0) {
        throw "FAIL: $Label must fail without mutation"
    }
    $script:passed++
    Write-Host "PASS: $Label (no add/unregister)"
}
try {
    Reset-Fixture
    if ((Invoke-ExperimentalSurfaceRegistration $root $manifest) -cne 'WXP:REGISTERED' -or $script:addCalls -ne 1) {
        throw 'New identity was not registered exactly once through the mock'
    }
    $passed++; Write-Host 'PASS: absent identity registers once and verifies'
    $script:addCalls = 0
    if ((Invoke-ExperimentalSurfaceRegistration $root $manifest) -cne 'WXP:ALREADY' -or $script:addCalls -ne 0) {
        throw 'Same-location identity was not idempotent'
    }
    $passed++; Write-Host 'PASS: same-location identity is idempotent'
    foreach ($location in @("$root-other", '', 'C:\a-different-installation')) {
        Reset-Fixture; $script:packages = @(New-Registration $location)
        Assert-Rejected "location collision '$location'"
    }
    Reset-Fixture; $script:packages = @((New-Registration $root), (New-Registration "$root-other"))
    Assert-Rejected 'multiple existing identities'
    Reset-Fixture; $script:queryError = $true
    Assert-Rejected 'query failure is not absence'
    foreach ($property in @('Name', 'Publisher', 'PackageFullName', 'Status')) {
        Reset-Fixture; $p = New-Registration $root; $p.$property = 'unexpected'
        $script:packages = @($p)
        Assert-Rejected "existing $property mismatch"
    }
    foreach ($attribute in @('Name', 'Publisher', 'Version', 'ProcessorArchitecture')) {
        Reset-Fixture
        [xml]$xml = Get-Content $manifest -Raw
        $xml.SelectSingleNode("//*[local-name()='Identity']").SetAttribute($attribute, 'unexpected')
        $xml.Save($manifest)
        Assert-Rejected "manifest $attribute mismatch"
        if ($script:queryCalls -ne 0) { throw 'Bad manifest queried registration' }
    }
    Reset-Fixture
    Copy-Item "$PSScriptRoot\WinUIXamlPreview\SurfaceIdentity\AppxManifest.xml" $manifest -Force
    Assert-Rejected 'shipping manifest cannot enter experimental registration'
    $text = [IO.File]::ReadAllText("$PSScriptRoot\WinUIXamlPreview\SurfaceIdentity\Register-Experimental.ps1")
    if ($text -match 'Remove-AppxPackage|-ErrorAction\s+SilentlyContinue') { throw 'Unsafe operation in experimental script' }
    $passed++; Write-Host 'PASS: experimental script contains no unregister or suppressed query failures'
    Write-Host "Experimental identity: $passed passed; all AppX operations mocked."
} finally { Remove-Item -LiteralPath $root -Recurse -Force }
