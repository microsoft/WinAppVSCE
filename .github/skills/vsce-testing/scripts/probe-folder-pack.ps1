# Regression probe: the non-sparse (folder) pack path.
#
# Step 2 proved an identity-only pack skips the self-contained prompt and
# suppresses Install. This proves that gating did NOT leak into the normal
# folder path, which must still ask about self-contained.
#
# VS Code does not expose a QuickPick's placeholder text through UIA, so the
# prompts are captured as screenshots while the driver answers them in a
# background job.
param(
    [string]$CtxJson = "$env:TEMP\sparse-ctx.json"
)

$ErrorActionPreference = 'Stop'
Import-Module "$PSScriptRoot\vscode-drive.psm1" -Force

$ctx = Get-Content $CtxJson -Raw | ConvertFrom-Json
$shotDir = Join-Path $PSScriptRoot '..\logs\folder-pack'
Remove-Item $shotDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $shotDir | Out-Null

Set-VSCodeFocus -Ctx $ctx | Out-Null
# A fresh profile re-shows the sign-in/walkthrough overlays, which swallow the
# QuickPicks this probe is trying to observe.
Close-VSCodeSignIn -Ctx $ctx -ErrorAction SilentlyContinue
Close-VSCodeWalkthrough -Ctx $ctx -ErrorAction SilentlyContinue
Clear-VSCodeOverlays -Ctx $ctx -ErrorAction SilentlyContinue
Confirm-VSCodeEditor -Ctx $ctx -OpenFileIfNeeded (Join-Path $env:TEMP 'sparse-live\readme.txt') | Out-Null

# Answer: row 0 for the input folder, "No" to the certificate prompt
# (selectNext+accept), then "Yes" to self-contained (row 0).
#
# Answering *Yes* is the assertion that matters: --self-contained can only
# reach the command line if the prompt was actually shown, whereas answering
# No is indistinguishable from the prompt being skipped.
$job = Start-Job -ScriptBlock {
    param($modulePath, $ctxJson)
    Import-Module $modulePath -Force
    $ctx = Get-Content $ctxJson -Raw | ConvertFrom-Json
    Invoke-VSCodeDriverCommand -Ctx $ctx -CommandId 'winapp.pack' -Answers @(
        @{ accept = $true },
        @{ selectNext = 1 }, @{ accept = $true },
        @{ accept = $true }
    ) | ConvertTo-Json -Depth 8
} -ArgumentList "$PSScriptRoot\vscode-drive.psm1", $CtxJson

for ($i = 1; $i -le 14; $i++) {
    Start-Sleep -Milliseconds 1100
    winapp ui screenshot -w $ctx.Hwnd -o (Join-Path $shotDir ("shot-{0:d2}.png" -f $i)) 2>&1 | Out-Null
}

# The architecture-mismatch modal lives inside the same `if (!identityOnly)`
# block as the self-contained prompt, and only appears once self-contained is
# answered Yes. Seeing it proves the whole folder-only branch ran.
$tree = (winapp ui inspect -w $ctx.Hwnd --depth 12 2>&1 | Out-String)
$sawArchModal = $tree -match 'Continue anyway'
Write-Host "RESULT folderPack.sawArchMismatchModal=$sawArchModal"
($tree -split "\r?\n") | Where-Object { $_ -match 'Continue anyway|architecture|Cancel' } |
    Select-Object -First 6 | ForEach-Object { Write-Host "   $($_.Trim())" }

# Dismiss it so no real packaging run is left behind.
if ($sawArchModal) { winapp ui invoke -w $ctx.Hwnd 'Cancel' 2>&1 | Out-Null }

Receive-Job $job -Wait -AutoRemoveJob | Out-File (Join-Path $shotDir 'driver-result.json')
Write-Host "screenshots in $shotDir"
