# Embedded only in the explicit Migration24e47e37 adapter. Dot-sourceable for mock tests.
# AppX registration is CURRENT USER, not isolated by the VS suffix. Never replace a collision.
function Invoke-ExperimentalSurfaceRegistration {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$SurfaceDir, [Parameter(Mandatory)][string]$Manifest)
    $ErrorActionPreference = 'Stop'
    $name = 'WinUIXamlPreviewSurface.Migration24e47e37'
    $publisher = 'CN=WinUIXamlPreview'
    $loc = [IO.Path]::GetFullPath($SurfaceDir).TrimEnd('\')
    if ([IO.Path]::GetFullPath($Manifest) -ine "$loc\AppxManifest.xml") {
        throw 'Experimental manifest must be beside Surface.exe.'
    }
    # Refuse ambiguous aliases, including directory links into an existing installation.
    $directory = Get-Item -LiteralPath $loc
    while ($null -ne $directory) {
        if ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Experimental location is a reparse point.' }
        $directory = $directory.Parent
    }
    [xml]$xml = Get-Content -LiteralPath $Manifest -Raw
    $identity = $xml.SelectSingleNode("//*[local-name()='Identity']")
    $apps = $xml.SelectNodes("//*[local-name()='Application']")
    if ($identity.Name -cne $name -or $identity.Publisher -cne $publisher -or
        $identity.Version -cne '1.0.0.0' -or $identity.ProcessorArchitecture -cne 'x64' -or
        $apps.Count -ne 1 -or $apps[0].Id -cne 'Surface' -or $apps[0].Executable -cne 'Surface.exe') {
        throw 'Experimental payload identity does not match the compiled adapter.'
    }
    # No SilentlyContinue: a failed query must never be treated as an absent registration.
    $packages = @(Get-AppxPackage -Name $name -ErrorAction Stop)
    if ($packages.Count -gt 0) {
        if ($packages.Count -ne 1 -or $packages[0].Name -cne $name -or
            $packages[0].Publisher -cne $publisher -or
            $packages[0].PackageFullName -cne ($name + '_1.0.0.0_x64__p47s87298xgjw') -or
            -not $packages[0].InstallLocation -or
            ([IO.Path]::GetFullPath($packages[0].InstallLocation)).TrimEnd('\') -ine $loc -or
            "$($packages[0].Status)" -ne 'Ok') {
            throw 'Experimental identity collision or unhealthy registration; nothing was changed.'
        }
        return 'WXP:ALREADY'
    }
    Add-AppxPackage -Register $Manifest -ExternalLocation $loc -ErrorAction Stop
    $registered = @(Get-AppxPackage -Name $name -ErrorAction Stop)
    if ($registered.Count -ne 1 -or $registered[0].Publisher -cne $publisher -or
        $registered[0].PackageFullName -cne ($name + '_1.0.0.0_x64__p47s87298xgjw') -or
        -not $registered[0].InstallLocation -or
        ([IO.Path]::GetFullPath($registered[0].InstallLocation)).TrimEnd('\') -ine $loc -or
        "$($registered[0].Status)" -ne 'Ok') {
        throw 'Experimental registration could not be verified; no cleanup or replacement attempted.'
    }
    return 'WXP:REGISTERED'
}
