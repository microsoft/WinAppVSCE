param(
    [Parameter(Mandatory = $true)]
    [string]$TelemetryProviderGuid,

    # This repo has no central package management, so the internal package needs an explicit version.
    [Parameter(Mandatory = $true)]
    [string]$TelemetryPackageVersion
)

# Release-pipeline step (mirrors WinAppCli's .pipelines\Unstub.ps1): swap the local TelemetryEventSource stub for
# the internal Microsoft.Telemetry.Inbox.Managed package and register the provider in the ETW group so previewer
# events reach the shared WinApp telemetry pipeline. Dev and CI builds keep the stub: events stay local ETW only.

$ErrorActionPreference = "Stop"

$projectDir = Join-Path $PSScriptRoot "WinUIXamlPreview"
$stub = Join-Path $projectDir "Telemetry\TelemetryEventSource.cs"
$projFile = Join-Path $projectDir "WinUIXamlPreview.csproj"
$telemetryFile = Join-Path $projectDir "Telemetry\PreviewTelemetry.cs"

if (Test-Path $stub) {
    Remove-Item $stub
}

$projContent = Get-Content $projFile -Encoding UTF8 -Raw
if ($projContent.Contains("Microsoft.Telemetry.Inbox.Managed")) {
    Write-Output "Project file already references the internal telemetry package."
}
else {
    # Text insert (not an XML round-trip, which reflows multi-line attributes in this project file).
    $close = $projContent.LastIndexOf("</Project>")
    if ($close -lt 0) {
        Write-Error "Could not find </Project> in $projFile"
        exit 1
    }
    $reference = "  <ItemGroup>`r`n    <PackageReference Include=""Microsoft.Telemetry.Inbox.Managed"" Version=""$TelemetryPackageVersion"" />`r`n  </ItemGroup>`r`n"
    Set-Content $projFile ($projContent.Insert($close, $reference)) -Encoding UTF8 -NoNewline
}

$oldLine = "EventSource TelemetryEventSourceInstance = new "
$newLine = "            internal static readonly EventSource TelemetryEventSourceInstance = new EventSource(ProviderName, EventSourceSettings.EtwManifestEventFormat, new[] { ""ETW_GROUP"", ""{$TelemetryProviderGuid}"" });"

$lineFound = $false
$newContent = foreach ($line in (Get-Content $telemetryFile -Encoding UTF8)) {
    if ($line -like "*$oldLine*") {
        $lineFound = $true
        $newLine
    }
    else {
        $line
    }
}

if (-not $lineFound) {
    Write-Error "Could not find a line containing '$oldLine' in $telemetryFile; has the telemetry file changed?"
    exit 1
}

$newContent | Set-Content $telemetryFile -Encoding UTF8
Write-Output "Unstubbed previewer telemetry (provider group {$TelemetryProviderGuid})."
