#!/usr/bin/env pwsh
param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")).Path
)

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "vscode-drive.psm1") -Force

$openFile = Join-Path $RepoRoot "README.md"
$logDir = Join-Path (Split-Path $PSScriptRoot -Parent) "logs"
$runDir = Join-Path $logDir ("tool-probe-" + [guid]::NewGuid().ToString("N"))
$marker = Join-Path $runDir "tool-injection-marker.txt"
$inputManifest = Join-Path $runDir "tool-probe-input.manifest"
$outputManifest = Join-Path $runDir "tool-probe-output.manifest"
$screenshot = Join-Path $runDir "tool-injection.png"
$failureScreenshot = Join-Path $logDir "tool-injection-failure.png"
New-Item -ItemType Directory -Force $logDir | Out-Null
New-Item -ItemType Directory -Force $runDir | Out-Null
Remove-Item -LiteralPath $failureScreenshot -Force -ErrorAction SilentlyContinue

@'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity name="WinApp.Tool.Argument.Probe" version="1.0.0.0" processorArchitecture="*" type="win32" />
</assembly>
'@ | Set-Content -LiteralPath $inputManifest -Encoding UTF8

$ctx = $null
try {
    $ctx = Start-VSCodeDrive -Folder $RepoRoot -OpenFile $openFile -WithDriverExtension -SettleSec 24
    Set-VSCodeFocus -Ctx $ctx | Out-Null
    $editorReady = Confirm-VSCodeEditor -Ctx $ctx -OpenFileIfNeeded $openFile

    # First prove that winapp.tool consumed the supplied arguments. mt.exe creates
    # this exact output only when it receives both controlled paths.
    $positiveArgs = "-nologo -manifest `"$inputManifest`" -out:`"$outputManifest`""
    $positiveResult = Invoke-VSCodeDriverCommand `
        -Ctx $ctx `
        -CommandId "winapp.tool" `
        -CommandArgs @(@{ toolName = "mt"; argumentText = $positiveArgs }) `
        -WaitForTask `
        -TaskSource "WinApp" `
        -TaskTimeoutSec 90 `
        -SettleMs 500 `
        -TimeoutSec 105

    $positiveTask = $positiveResult.steps[-1].task
    $outputCreated = Test-Path -LiteralPath $outputManifest
    $outputMatches = $outputCreated -and
        ((Get-Content -LiteralPath $outputManifest -Raw) -match "WinApp\.Tool\.Argument\.Probe")

    # Then send a payload that would create the marker if a command shell
    # interpreted it. Waiting for task exit prevents a false pass on an idle UI.
    # Single quotes keep the marker path valid in the old vulnerable PowerShell
    # command while remaining literal argument text under Windows parsing.
    $escapedMarker = $marker.Replace("'", "''")
    $payload = "/?; Set-Content '$escapedMarker' owned"
    $injectionResult = Invoke-VSCodeDriverCommand `
        -Ctx $ctx `
        -CommandId "winapp.tool" `
        -CommandArgs @(@{ toolName = "makeappx"; argumentText = $payload }) `
        -WaitForTask `
        -TaskSource "WinApp" `
        -TaskTimeoutSec 90 `
        -SettleMs 500 `
        -TimeoutSec 105

    winapp ui screenshot -w $ctx.Hwnd -o $screenshot | Out-Null
    $injectionTask = $injectionResult.steps[-1].task
    $markerCreated = Test-Path -LiteralPath $marker

    Write-Host "RESULT: editor=$editorReady positiveDone=$($positiveResult.done) positiveTask=$($positiveTask.completed) outputMatches=$outputMatches injectionDone=$($injectionResult.done) injectionTask=$($injectionTask.completed) markerCreated=$markerCreated"
    if (-not $positiveTask.completed) {
        Write-Host "Positive task error: $($positiveTask.error)"
    }
    if (-not $injectionTask.completed) {
        Write-Host "Injection task error: $($injectionTask.error)"
    }
    if (-not $editorReady -or
        -not $positiveResult.done -or -not $positiveTask.completed -or $positiveTask.exitCode -ne 0 -or
        -not $outputMatches -or
        -not $injectionResult.done -or -not $injectionTask.completed -or
        $markerCreated) {
        throw "winapp.tool shell-injection probe failed. Failure screenshot will be saved to: $failureScreenshot"
    }
} catch {
    if (Test-Path -LiteralPath $screenshot) {
        Copy-Item -LiteralPath $screenshot -Destination $failureScreenshot -Force
    } elseif ($ctx) {
        try {
            winapp ui screenshot -w $ctx.Hwnd -o $failureScreenshot | Out-Null
        } catch {}
    }
    throw
} finally {
    if ($ctx) {
        Stop-VSCodeDrive -Ctx $ctx
    }
    Remove-Item -LiteralPath $runDir -Recurse -Force -ErrorAction SilentlyContinue
}
