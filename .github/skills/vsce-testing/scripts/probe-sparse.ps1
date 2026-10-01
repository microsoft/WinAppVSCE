# Live-drive probe for the sparse packaging workflow:
#   winapp.initSparse -> winapp.pack (sparse manifest) -> winapp.embedIdentity
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
Import-Module "$PSScriptRoot\dialog-answer.psm1" -Force

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

Write-Host "`n=== 0. Focus + clear first-run modals ==="
Set-VSCodeFocus -Ctx $ctx | Out-Null
$onEditor = Confirm-VSCodeEditor -Ctx $ctx -OpenFileIfNeeded (Join-Path $Workspace 'readme.txt')
Write-Host "  onEditor=$onEditor"

# ---------------------------------------------------------------- step 1 ----
Write-Host "`n=== 1. winapp.initSparse (QuickPick -> App.exe) ==="
Remove-Item -Recurse -Force (Join-Path $projDir 'sparse') -ErrorAction SilentlyContinue
$r1 = Invoke-VSCodeDriverCommand -Ctx $ctx -CommandId 'winapp.initSparse' -Answers @(@{ accept = $true })
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
Write-Host "`n=== 2. winapp.pack (QuickPick row 1 = sparse manifest) ==="
# Row 0 is the win-x64 build-output folder, row 1 is the sparse manifest, so
# one selectNext is needed before accepting. Then exactly ONE more accept for
# the certificate prompt. If the identity-only gating regressed, a third
# (self-contained) QuickPick would still be open afterwards and the pack would
# never run -- caught by the missing-.msix check below.
$r2 = Invoke-VSCodeDriverCommand -Ctx $ctx -CommandId 'winapp.pack' `
    -Answers @(@{ selectNext = 1 }, @{ accept = $true }, @{ accept = $true })
Write-Host "  answers: $(($r2.steps[0].answers | ConvertTo-Json -Compress))"

Start-Sleep -Seconds 8
winapp ui screenshot -w $ctx.Hwnd -o (Join-Path $logDir 'sparse-after-pack.png') 2>&1 | Out-Null

$identityMsix = $null
$deadline = (Get-Date).AddSeconds(180)
while ((Get-Date) -lt $deadline -and -not $identityMsix) {
    $identityMsix = Get-ChildItem $Workspace -Recurse -Filter '*.msix' -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $identityMsix) { Start-Sleep -Seconds 3 }
}
if ($identityMsix) {
    Write-Host "  [ok] identity package: .$($identityMsix.FullName.Substring($Workspace.Length))"
} else {
    Write-Host "  [FAIL] no .msix produced under $Workspace"
}

# Capture the completion notification so the offered actions can be read back.
Start-Sleep -Seconds 4
winapp ui screenshot -w $ctx.Hwnd -o (Join-Path $logDir 'sparse-pack-notification.png') 2>&1 | Out-Null
$notif = (winapp ui inspect -w $ctx.Hwnd --depth 14 2>&1 | Out-String)
$sawInstall = $notif -match '(?m)^\s*.*\bInstall\b'
$sawSign = $notif -match '(?m)^\s*.*\bSign\b'
$sawReveal = $notif -match 'Reveal'
Write-Host "  notification actions: reveal=$sawReveal sign=$sawSign install=$sawInstall (Install should be ABSENT)"

# ---------------------------------------------------------------- step 3 ----
Write-Host "`n=== 3. winapp.embedIdentity (QuickPick -> App.exe, then modal) ==="
$before = Get-Item $exePath
$r3 = Invoke-VSCodeDriverCommand -Ctx $ctx -CommandId 'winapp.embedIdentity' -Answers @(@{ accept = $true })
Write-Host "  answers: $(($r3.steps[0].answers | ConvertTo-Json -Compress))"

# The signature-invalidation warning is a VS Code modal, not a QuickPick, so it
# must be clicked through UIA rather than answered by the driver queue.
Start-Sleep -Seconds 3
winapp ui screenshot -w $ctx.Hwnd -o (Join-Path $logDir 'sparse-embed-modal.png') 2>&1 | Out-Null
$modalTree = (winapp ui inspect -w $ctx.Hwnd --depth 14 2>&1 | Out-String)
$sawWarning = $modalTree -match 'Authenticode'
Write-Host "  modal shown (Authenticode warning)=$sawWarning"
Write-Host "  click Continue: $(Invoke-ModalButton -Hwnd $ctx.Hwnd -Name 'Continue')"

Start-Sleep -Seconds 30
$after = Get-Item $exePath
$rewritten = ($after.LastWriteTimeUtc -ne $before.LastWriteTimeUtc) -or ($after.Length -ne $before.Length)
Write-Host "  exe before: len=$($before.Length) mtime=$($before.LastWriteTimeUtc.ToString('o'))"
Write-Host "  exe after : len=$($after.Length) mtime=$($after.LastWriteTimeUtc.ToString('o'))"
Write-Host "  exe rewritten=$rewritten"

Write-Host "`n=== RESULT ==="
Write-Host "initSparse.manifest=$initOk pack.identityMsix=$([bool]$identityMsix) embed.modal=$sawWarning embed.rewroteExe=$rewritten"
