<#
.SYNOPSIS
    Summarizes WinUI XAML Preview latency markers (WS3-P0) from the designer log.
.DESCRIPTION
    Parses "PERF <name> ms=<n> [key=value ...]" lines written by the VS extension to
    %LOCALAPPDATA%\WinUIXamlPreview\preview.log and prints count / min / median / p90 / max per marker.
    By default only the most recent VS session in the log is considered.
.PARAMETER LogPath
    Log file to read. Defaults to the extension's log.
.PARAMETER AllSessions
    Include every session in the log instead of just the latest one.
.PARAMETER ByOutcome
    Group "*.paint" markers by outcome (hwnd / frame / error / superseded) as well as by name.
#>
param(
    [string]$LogPath = (Join-Path $env:LOCALAPPDATA 'WinUIXamlPreview\preview.log'),
    [switch]$AllSessions,
    [switch]$ByOutcome
)

if (-not (Test-Path $LogPath)) { throw "Log not found: $LogPath" }

$lines = Get-Content $LogPath
if (-not $AllSessions) {
    $start = 0
    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
        if ($lines[$i] -like '===== WinUI XAML Preview session start*') { $start = $i; break }
    }
    $lines = $lines[$start..($lines.Count - 1)]
}

$samples = foreach ($line in $lines) {
    if ($line -match 'PERF (?<name>\S+) ms=(?<ms>\d+)(?<rest>.*)$') {
        $name = $Matches.name
        if ($ByOutcome -and $Matches.rest -match 'outcome=(?<o>\S+)') { $name = "$name [$($Matches.o)]" }
        [pscustomobject]@{ Name = $name; Ms = [int]$Matches.ms }
    }
}

if (-not $samples) { Write-Host 'No PERF markers found.'; return }

function Get-Pct([int[]]$sorted, [double]$p) {
    $idx = [math]::Min($sorted.Count - 1, [math]::Max(0, [math]::Ceiling($p * $sorted.Count) - 1))
    $sorted[$idx]
}

$samples | Group-Object Name | Sort-Object Name | ForEach-Object {
    $v = [int[]]($_.Group.Ms | Sort-Object)
    [pscustomobject]@{
        Marker = $_.Name
        N      = $v.Count
        Min    = $v[0]
        Median = Get-Pct $v 0.5
        P90    = Get-Pct $v 0.9
        Max    = $v[-1]
    }
} | Format-Table -AutoSize
