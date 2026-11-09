# Live-drive probe for the sparse packaging workflow:
#   winapp.initSparse -> winapp.packSparse -> winapp.embedIdentity
#
# The test executable lives INSIDE the workspace, in a realistic project
# layout, so every command resolves its target through the QuickPick path that
# real users hit rather than the native Browse dialog fallback.
#
# Expected workspace layout (created by the caller):
#   src\App\App.csproj
#   src\App\bin\x64\Debug\net8.0-windows10.0.19041.0\win-x64\App.exe
param(
    [string]$CtxJson = "$env:TEMP\sparse-ctx.json",
    [string]$Workspace = "$env:TEMP\sparse-live"
)

$ErrorActionPreference = 'Stop'
Import-Module "$PSScriptRoot\vscode-drive.psm1" -Force

$ctx = Get-Content $CtxJson -Raw | ConvertFrom-Json
$Workspace = (Resolve-Path $Workspace).Path
$ctx.Folder = $Workspace

$projDir = Join-Path $Workspace 'src\App'
$exePath = Join-Path $projDir 'bin\x64\Debug\net8.0-windows10.0.19041.0\win-x64\App.exe'
# findProjectRootForFile walks up from the exe to App.csproj, so the sparse
# folder is expected beside the project -- NOT at the workspace root.
$manifest = Join-Path $projDir 'sparse\appxmanifest.xml'
$logDir = Join-Path $PSScriptRoot '..\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Wait-ForPath {
    param([string]$Path, [int]$TimeoutSec = 150, [string]$Label)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path $Path) { Write-Host "  [ok] $Label -> $Path"; return $true }
        Start-Sleep -Seconds 2
    }
    Write-Host "  [FAIL] $Label never appeared ($Path)"
    return $false
}

function Reset-ToEditor {
    Set-VSCodeFocus -Ctx $ctx | Out-Null
    Close-VSCodeWalkthrough -Ctx $ctx -Retries 8 | Out-Null
    $state = Clear-VSCodeOverlays -Ctx $ctx -MaxRounds 12
    if ($state.Blocked) {
        Confirm-VSCodeEditor -Ctx $ctx -OpenFileIfNeeded (Join-Path $Workspace 'readme.txt') | Out-Null
        $state = Clear-VSCodeOverlays -Ctx $ctx -MaxRounds 12
    }
    return (-not $state.Blocked)
}

function Wait-ForPackNotification {
    param([int]$TimeoutSec = 20)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $tree = (winapp ui inspect -w $ctx.Hwnd --depth 14 2>&1 | Out-String)
        if ($tree -match 'Button\s+"Reveal in Explorer"' -and $tree -match 'Button\s+"Sign"') {
            return $tree
        }
        Start-Sleep -Milliseconds 500
    }
    return ''
}

Write-Host "`n=== 0. Focus + clear first-run modals ==="
Set-VSCodeFocus -Ctx $ctx | Out-Null
$onEditor = Confirm-VSCodeEditor -Ctx $ctx -OpenFileIfNeeded (Join-Path $Workspace 'readme.txt')
$overlaysCleared = Reset-ToEditor
Write-Host "  overlaysCleared=$overlaysCleared"
Write-Host "  onEditor=$onEditor"

# ---------------------------------------------------------------- step 1 ----
Write-Host "`n=== 1. winapp.initSparse (QuickPick -> App.exe) ==="
Remove-Item -Recurse -Force (Join-Path $projDir 'sparse') -ErrorAction SilentlyContinue
$r1 = Invoke-VSCodeDriverCommand -Ctx $ctx -CommandId 'winapp.initSparse' `
    -Answers @(@{ accept = $true }) -SettleMs 4000
Write-Host "  answers: $(($r1.steps[0].answers | ConvertTo-Json -Compress))"
$initOk = Wait-ForPath -Path $manifest -Label 'sparse manifest'

if ($initOk) {
    Write-Host "  --- identity inferred from the exe ---"
    (Get-Content $manifest -Raw) -split "\r?\n" |
        Where-Object { $_ -match '<Identity|DisplayName|AllowExternalContent' } |
        ForEach-Object { Write-Host "    $($_.Trim())" }
    Write-Host "  --- sparse folder contents ---"
    Get-ChildItem (Join-Path $projDir 'sparse') -Recurse |
        ForEach-Object { Write-Host "    .$($_.FullName.Substring($Workspace.Length))" }
}

# ---------------------------------------------------------------- step 2 ----
Write-Host "`n=== 2. winapp.packSparse (manifest QuickPick) ==="
Reset-ToEditor | Out-Null
$existingIdentityPackages = @{}
Get-ChildItem $Workspace -Recurse -Filter '*.identity.msix' -File -ErrorAction SilentlyContinue |
    ForEach-Object { $existingIdentityPackages[$_.FullName] = $_.LastWriteTimeUtc }
$r2 = Invoke-VSCodeDriverCommand -Ctx $ctx -CommandId 'winapp.packSparse' `
    -Answers @(@{ accept = $true }, @{ selectNext = 1 }, @{ accept = $true }) -SettleMs 4000
Write-Host "  answers: $(($r2.steps[0].answers | ConvertTo-Json -Compress))"

Start-Sleep -Seconds 8
winapp ui screenshot -w $ctx.Hwnd -o (Join-Path $logDir 'sparse-after-pack.png') 2>&1 | Out-Null

$identityMsix = $null
$deadline = (Get-Date).AddSeconds(180)
while ((Get-Date) -lt $deadline -and -not $identityMsix) {
    $identityMsix = Get-ChildItem $Workspace -Recurse -Filter '*.identity.msix' -File -ErrorAction SilentlyContinue |
        Where-Object {
            -not $existingIdentityPackages.ContainsKey($_.FullName) -or
            $_.LastWriteTimeUtc -gt $existingIdentityPackages[$_.FullName]
        } |
        Select-Object -First 1
    if (-not $identityMsix) { Start-Sleep -Seconds 3 }
}
if ($identityMsix) {
    Write-Host "  [ok] identity package: .$($identityMsix.FullName.Substring($Workspace.Length))"
} else {
    Write-Host "  [FAIL] no .msix produced under $Workspace"
}

# Capture the completion notification so the offered actions can be read back.
$notif = Wait-ForPackNotification
winapp ui screenshot -w $ctx.Hwnd -o (Join-Path $logDir 'sparse-pack-notification.png') 2>&1 | Out-Null
$sawInstall = $notif -match 'Button\s+"Install"'
$sawSign = $notif -match 'Button\s+"Sign"'
$sawReveal = $notif -match 'Button\s+"Reveal in Explorer"'
Write-Host "  notification actions reveal=$sawReveal sign=$sawSign install=$sawInstall (Reveal and Sign required; Install absent)"

# ---------------------------------------------------------------- step 3 ----
Write-Host "`n=== 3. winapp.embedIdentity (QuickPick -> App.exe) ==="
Reset-ToEditor | Out-Null
$before = Get-Item $exePath
$r3 = Invoke-VSCodeDriverCommand -Ctx $ctx -CommandId 'winapp.embedIdentity' `
    -Answers @(@{ accept = $true }) -SettleMs 4000
Write-Host "  answers: $(($r3.steps[0].answers | ConvertTo-Json -Compress))"

Start-Sleep -Seconds 30
$after = Get-Item $exePath
$rewritten = ($after.LastWriteTimeUtc -ne $before.LastWriteTimeUtc) -or ($after.Length -ne $before.Length)
Write-Host "  exe before: len=$($before.Length) mtime=$($before.LastWriteTimeUtc.ToString('o'))"
Write-Host "  exe after : len=$($after.Length) mtime=$($after.LastWriteTimeUtc.ToString('o'))"
Write-Host "  exe rewritten=$rewritten"

Write-Host "`n=== RESULT ==="
Write-Host "initSparse.manifest=$initOk pack.identityMsix=$([bool]$identityMsix) embed.rewroteExe=$rewritten"

$failures = @()
if (-not $onEditor) { $failures += 'VS Code editor did not become ready' }
if (-not $overlaysCleared) { $failures += 'VS Code first-run overlays were not cleared' }
if (-not $initOk) { $failures += 'sparse manifest was not created' }
if (-not $identityMsix) { $failures += 'a new identity MSIX was not created' }
if (-not $sawReveal) { $failures += 'identity-only pack notification did not offer Reveal in Explorer' }
if (-not $sawSign) { $failures += 'identity-only pack notification did not offer Sign' }
if ($sawInstall) { $failures += 'identity-only pack notification incorrectly offered Install' }
if (-not $rewritten) { $failures += 'target executable was not rewritten' }

if ($failures.Count -gt 0) {
    throw "Sparse workflow probe failed: $($failures -join '; ')"
}

exit 0
