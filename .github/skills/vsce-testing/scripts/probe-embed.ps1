# Focused probe for winapp.embedIdentity.
#
# Step 3 of the sparse workflow is the only one that raises a VS Code *modal*
# (the Authenticode signature-invalidation warning) rather than a QuickPick.
# Modals are not answerable through the driver queue, so this probe dumps the
# UIA tree at increasing depths to locate the dialog and its buttons before
# clicking, rather than guessing a name.
param(
    [string]$CtxJson = "$env:TEMP\sparse-ctx.json",
    [string]$Workspace = "$env:TEMP\sparse-live"
)

$ErrorActionPreference = 'Stop'
Import-Module "$PSScriptRoot\vscode-drive.psm1" -Force

$ctx = Get-Content $CtxJson -Raw | ConvertFrom-Json
$Workspace = (Resolve-Path $Workspace).Path
$ctx.Folder = $Workspace

$exePath = Join-Path $Workspace 'src\App\bin\x64\Debug\net8.0-windows10.0.19041.0\win-x64\App.exe'
$logDir = Join-Path $PSScriptRoot '..\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

Write-Host "=== focus ==="
Set-VSCodeFocus -Ctx $ctx | Out-Null
Confirm-VSCodeEditor -Ctx $ctx -OpenFileIfNeeded (Join-Path $Workspace 'readme.txt') | Out-Null

$before = Get-Item $exePath
Write-Host "exe before: len=$($before.Length) mtime=$($before.LastWriteTimeUtc.ToString('o'))"

Write-Host "`n=== fire winapp.embedIdentity, accept the exe QuickPick ==="
$r = Invoke-VSCodeDriverCommand -Ctx $ctx -CommandId 'winapp.embedIdentity' -Answers @(@{ accept = $true })
Write-Host "answers: $(($r.steps[0].answers | ConvertTo-Json -Compress))"

Start-Sleep -Seconds 5
winapp ui screenshot -w $ctx.Hwnd -o (Join-Path $logDir 'embed-modal.png') 2>&1 | Out-Null

Write-Host "`n=== UIA tree scan for the modal ==="
foreach ($depth in 10, 16, 22) {
    $tree = (winapp ui inspect -w $ctx.Hwnd --depth $depth 2>&1 | Out-String)
    $hits = ($tree -split "\r?\n") | Where-Object {
        $_ -match 'Authenticode|Continue|Cancel|mt\.exe|rewrite|Button'
    }
    Write-Host "--- depth=$depth : $($hits.Count) candidate line(s) ---"
    $hits | Select-Object -First 25 | ForEach-Object { Write-Host "   $($_.Trim())" }
    if ($tree -match 'Authenticode') { Write-Host "   >>> modal text FOUND at depth $depth"; break }
}

Write-Host "`n=== attempt to click Continue ==="
foreach ($name in 'Continue', 'Continue (Enter)') {
    $out = (winapp ui invoke -w $ctx.Hwnd $name 2>&1 | Out-String).Trim()
    Write-Host "invoke '$name': $($out -replace '\s+', ' ')"
    if ($out -notmatch 'No element found') { break }
}

Start-Sleep -Seconds 35
$after = Get-Item $exePath
$rewritten = ($after.LastWriteTimeUtc -ne $before.LastWriteTimeUtc) -or ($after.Length -ne $before.Length)
Write-Host "`nexe after : len=$($after.Length) mtime=$($after.LastWriteTimeUtc.ToString('o'))"
Write-Host "RESULT embed.rewroteExe=$rewritten"
