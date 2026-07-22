#requires -Version 5.1
<#
.SYNOPSIS
    vscode-drive - a disciplined VS Code UI automation helper.

    Encodes the required order of operations for every interaction:
      1. FOCUS  - activate the correct window (robust, beats the Windows foreground lock) and VERIFY it.
      2. PAGE   - detect what screen VS Code is on; dismiss Welcome/walkthrough overlays.
      3. VERIFY - confirm the main editor/workbench is ready and enumerate interactable elements.
      4. ACT    - only then click (via winapp ui UIA) or type (via real SendInput key injection).

    Reading + clicking use `winapp ui` (UIA - no foreground needed).
    Typing (Command Palette, editors) uses OS-level SendInput AFTER a verified foreground activation.

    This module NEVER targets a window it did not launch. Launch returns a context object; all
    verbs take that context so we only ever drive our own instance.
#>

$script:Native = @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class VSCodeNative {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SystemParametersInfo(uint uiAction, uint uiParam, IntPtr pvParam, uint fWinIni);
    [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    const int SW_RESTORE = 9;
    const int SW_SHOW = 5;
    const uint SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001;
    const uint SPIF_SENDCHANGE = 0x2;
    const byte VK_MENU = 0x12;
    const uint KEYEVENTF_KEYUP_B = 0x2;

    // Remove the foreground lock so SetForegroundWindow is honored from a background process.
    public static void UnlockForeground() {
        SystemParametersInfo(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, IntPtr.Zero, SPIF_SENDCHANGE);
    }

    // Robust foreground activation that defeats the foreground lock by attaching to the
    // target window's input thread. Returns true only if the target is verified foreground.
    public static bool ForceForeground(IntPtr hWnd) {
        if (!IsWindow(hWnd)) return false;
        UnlockForeground();
        if (IsIconic(hWnd)) ShowWindow(hWnd, SW_RESTORE);
        ShowWindow(hWnd, SW_SHOW);
        for (int attempt = 0; attempt < 3; attempt++) {
            IntPtr fg = GetForegroundWindow();
            if (fg == hWnd) return true;
            uint targetThread = GetWindowThreadProcessId(hWnd, out uint _);
            uint fgThread = GetWindowThreadProcessId(fg, out uint __);
            uint thisThread = GetCurrentThreadId();
            bool a1 = false, a2 = false;
            try {
                if (fgThread != targetThread) a1 = AttachThreadInput(thisThread, fgThread, true);
                if (thisThread != targetThread) a2 = AttachThreadInput(thisThread, targetThread, true);
                // ALT nudge: makes Windows treat this thread as having received input,
                // which (together with a zeroed lock timeout) unblocks SetForegroundWindow.
                keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
                keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP_B, UIntPtr.Zero);
                BringWindowToTop(hWnd);
                SetForegroundWindow(hWnd);
            } finally {
                if (a1) AttachThreadInput(thisThread, fgThread, false);
                if (a2) AttachThreadInput(thisThread, targetThread, false);
            }
            for (int i = 0; i < 12; i++) {
                if (GetForegroundWindow() == hWnd) return true;
                Thread.Sleep(50);
            }
        }
        return GetForegroundWindow() == hWnd;
    }

    public static bool IsForeground(IntPtr hWnd) { return GetForegroundWindow() == hWnd; }

    // ---- SendInput keyboard ----
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public InputUnion U; }
    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] p, int cb);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint uCode, uint uMapType);

    const uint INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;
    const uint KEYEVENTF_SCANCODE = 0x0008;
    const uint KEYEVENTF_EXTENDED = 0x0001;
    const uint MAPVK_VK_TO_VSC = 0;

    // Build a key event carrying the HARDWARE SCAN CODE. Chromium/Electron (VS Code) ignores
    // synthetic key events that only set wVk; it requires the scan code to be present.
    static INPUT Sc(ushort vk, bool up) {
        ushort scan = (ushort)MapVirtualKey(vk, MAPVK_VK_TO_VSC);
        uint flags = KEYEVENTF_SCANCODE | (up ? KEYEVENTF_KEYUP : 0);
        // Extended keys (arrows, Enter on numpad, etc.) need the extended flag; Enter/arrows are safe to mark.
        if (vk == 0x0D || (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E) flags |= KEYEVENTF_EXTENDED;
        var i = new INPUT { type = INPUT_KEYBOARD };
        i.U.ki = new KEYBDINPUT { wVk = 0, wScan = scan, dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero };
        return i;
    }
    static INPUT Uni(char c, bool up) {
        var i = new INPUT { type = INPUT_KEYBOARD };
        uint f = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0);
        i.U.ki = new KEYBDINPUT { wVk = 0, wScan = c, dwFlags = f, time = 0, dwExtraInfo = IntPtr.Zero };
        return i;
    }
    static void Send1(INPUT i) { SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT))); }

    // Type a literal Unicode string (no chords). Good for palette filter text / editor text.
    public static void TypeText(string s) {
        foreach (char c in s) {
            Send1(Uni(c, false)); Thread.Sleep(4);
            Send1(Uni(c, true));  Thread.Sleep(12);
        }
    }

    // Press a chord of virtual-key codes (e.g. Ctrl+Shift+P) using scan codes. Downs in order
    // with small gaps, ups in reverse - mirrors real hardware timing so Chromium accepts it.
    public static void Chord(ushort[] vks) {
        foreach (var v in vks) { Send1(Sc(v, false)); Thread.Sleep(30); }
        for (int i = vks.Length - 1; i >= 0; i--) { Send1(Sc(vks[i], true)); Thread.Sleep(30); }
    }

    public static void KeyPress(ushort vk) {
        Send1(Sc(vk, false)); Thread.Sleep(30);
        Send1(Sc(vk, true));  Thread.Sleep(30);
    }
}
'@

if (-not ([System.Management.Automation.PSTypeName]'VSCodeNative').Type) {
    Add-Type -TypeDefinition $script:Native -Language CSharp
}

# Virtual-key codes we use.
$script:VK = @{ CTRL = 0x11; SHIFT = 0x10; ALT = 0x12; ENTER = 0x0D; ESC = 0x1B; P = 0x50 }

function Write-Step($msg, $color = 'Cyan') { Write-Host "  [vscode-drive] $msg" -ForegroundColor $color }

# ---------------------------------------------------------------------------
# 1. LAUNCH - own, isolated instance that lands on the EDITOR (walkthrough suppressed).
# ---------------------------------------------------------------------------
function Start-VSCodeDrive {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Folder,
        [string]$OpenFile,                       # optional file to open so the editor (not Welcome) is active
        [switch]$WithDriverExtension,            # also load the companion driver-extension
        [int]$SettleSec = 22
    )
    if (-not (Test-Path $Folder)) { throw "Folder not found: $Folder" }
    $code = (Get-Command code -ErrorAction Stop).Source
    $harness = Split-Path $PSScriptRoot -Parent
    $udd = Join-Path $harness (".drive-udd-" + [guid]::NewGuid().ToString('N').Substring(0, 8))

    # Seed settings so we land on the editor with NO Welcome / walkthrough / trust dialog.
    $userDir = Join-Path $udd 'User'
    New-Item -ItemType Directory -Force -Path $userDir | Out-Null
    @{
        'workbench.startupEditor'                        = 'none'
        'workbench.welcomePage.walkthroughs.openOnInstall' = $false
        'workbench.tips.enabled'                          = $false
        'update.showReleaseNotes'                         = $false
        'security.workspace.trust.enabled'               = $false
        'window.restoreWindows'                          = 'none'
        'telemetry.telemetryLevel'                       = 'off'
    } | ConvertTo-Json | Set-Content (Join-Path $userDir 'settings.json') -Encoding UTF8

    $args = @("--force-renderer-accessibility", "--user-data-dir=$udd", "--disable-workspace-trust", "--new-window", $Folder)
    # Isolated extensions dir that holds the installed winapp extension (so its winapp.* commands
    # are registered), without touching the user's global VS Code profile. Falls back gracefully.
    $driveExtDir = Join-Path $harness '.drive-extensions'
    if (Test-Path $driveExtDir) { $args = @("--extensions-dir=$driveExtDir") + $args }
    $queueDir = $null
    if ($WithDriverExtension) {
        $args += "--extensionDevelopmentPath=$(Join-Path $harness 'driver-extension')"
        # Set up a per-instance command QUEUE so we can push commands to this LIVE instance on demand.
        $queueDir = Join-Path $harness (".queue-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
        New-Item -ItemType Directory -Force -Path $queueDir | Out-Null
        $env:WINAPP_UX_QUEUE = $queueDir   # inherited by the launched Code process
    }
    if ($OpenFile -and (Test-Path $OpenFile)) { $args += @("--goto", "$OpenFile:1:1") }

    Write-Step "launching VS Code (udd=$(Split-Path $udd -Leaf))"
    Start-Process $code -ArgumentList $args | Out-Null
    if ($WithDriverExtension) { $env:WINAPP_UX_QUEUE = $null }   # don't leak into later launches
    Start-Sleep -Seconds $SettleSec

    $ctx = [pscustomobject]@{ Udd = $udd; Folder = $Folder; Hwnd = $null; Pid = $null; UddLeaf = (Split-Path $udd -Leaf); EditorFile = $(if ($OpenFile) { Split-Path $OpenFile -Leaf } else { $null }); QueueDir = $queueDir; ReqSeq = 0 }
    $win = Get-VSCodeWindow -Ctx $ctx
    if (-not $win) { throw "Could not locate the launched VS Code window." }
    $ctx.Hwnd = $win.Hwnd; $ctx.Pid = $win.Pid
    Write-Step "window HWND=$($ctx.Hwnd) PID=$($ctx.Pid)" 'Green'
    return $ctx
}

# Find OUR VS Code window (matched to the udd's process tree), never the user's.
# IMPORTANT: match STRICTLY on the "(Code, PID <n>)" process tag for a PID we launched.
# We must NEVER title-match on "Visual Studio Code", because the user's browser tabs
# (e.g. "Publishing Extensions | Visual Studio Code Extension API", surfaced as explorer
# TabProxyWindows) contain that phrase and would be picked up as false positives.
function Get-VSCodeWindow {
    param([Parameter(Mandatory)]$Ctx)
    # PIDs whose command line contains our unique udd marker (the whole process tree).
    $ourPids = (Get-CimInstance Win32_Process -Filter "Name='Code.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match [regex]::Escape($Ctx.UddLeaf) }).ProcessId
    if (-not $ourPids) { return $null }

    # list-windows WRAPS long lines, so flatten whitespace before parsing per-window records.
    $flat = ((winapp ui list-windows 2>&1 | Out-String) -replace "`r?`n", ' ') -replace '\s+', ' '
    $best = $null
    foreach ($m in [regex]::Matches($flat, 'HWND (\d+): "([^"]*)"[^"]*?\(Code, PID (\d+)\)')) {
        $hwnd = [int]$m.Groups[1].Value
        $title = $m.Groups[2].Value
        $wpid = [int]$m.Groups[3].Value
        if ($ourPids -notcontains $wpid) { continue }
        # Prefer the main editor window: a "... - Visual Studio Code" title, and the
        # foreground/largest one if several match. Satellite windows (sharedProcess,
        # extension host output) either lack the title or are tiny.
        $isForeground = $m.Value -match 'foreground'
        $area = 0
        if ($m.Value -match '\((?:window),\s*(\d+)x(\d+)') { $area = [int]$Matches[1] * [int]$Matches[2] }
        $score = $area + $(if ($isForeground) { 100000000 } else { 0 }) + $(if ($title -match 'Visual Studio Code') { 50000000 } else { 0 })
        if (-not $best -or $score -gt $best.Score) {
            $best = [pscustomobject]@{ Hwnd = $hwnd; Pid = $wpid; Title = $title; Score = $score }
        }
    }
    if ($best) { return [pscustomobject]@{ Hwnd = $best.Hwnd; Pid = $best.Pid } }
    return $null
}

# ---------------------------------------------------------------------------
# 2. FOCUS - activate + VERIFY. No typing happens unless this returns $true.
# ---------------------------------------------------------------------------
function Set-VSCodeFocus {
    param([Parameter(Mandatory)]$Ctx, [int]$Retries = 3)
    for ($i = 1; $i -le $Retries; $i++) {
        $ok = [VSCodeNative]::ForceForeground([IntPtr]$Ctx.Hwnd)
        if ($ok) { Write-Step "focus verified (HWND=$($Ctx.Hwnd) is foreground)" 'Green'; return $true }
        Start-Sleep -Milliseconds 300
    }
    Write-Step "FAILED to bring HWND=$($Ctx.Hwnd) to foreground" 'Red'
    return $false
}

function Test-VSCodeFocused { param([Parameter(Mandatory)]$Ctx) return [VSCodeNative]::IsForeground([IntPtr]$Ctx.Hwnd) }

# ---------------------------------------------------------------------------
# 2b. PAGE STATE - what screen are we on? Dismiss overlays. Confirm editor.
# ---------------------------------------------------------------------------
function Get-VSCodeState {
    param([Parameter(Mandatory)]$Ctx)
    $search = { param($q) (winapp ui search $q -w $Ctx.Hwnd --max 3 2>&1 | Out-String) }
    # A blocking modal captures input; it MUST be cleared before any palette/keyboard work.
    $onSignIn = (((& $search 'Continue without Signing In') + (& $search 'Sign in to use GitHub Copilot')) -match 'Found [1-9]')
    $onWalkthrough = (((& $search 'Make It Yours') + (& $search 'Build with AI Agents') + (& $search 'Get Started with Accessibility')) -match 'Found [1-9]')
    $onTrust = ((& $search 'Do you trust the authors') -match 'Found [1-9]')
    $onWelcomeTab = ((& $search 'Welcome to Visual Studio Code') -match 'Found [1-9]')
    # Editor detection: the open file's TAB is visible cheaply (shallow tree); the
    # 'workbench.parts.editor' automationid only surfaces at depth 12+ (a 13KB inspect).
    if ($Ctx.EditorFile) {
        $hasEditor = ((& $search $Ctx.EditorFile) -match 'Found [1-9]')
    } else {
        $deep = winapp ui inspect -w $Ctx.Hwnd --depth 14 2>&1 | Out-String
        $hasEditor = ($deep -match 'workbench\.parts\.editor' -or $deep -match 'Editor Group')
    }
    $blocked = ($onSignIn -or $onTrust -or $onWalkthrough)   # walkthrough is a blocking modal overlay
    $state = if ($onSignIn) { 'signin-modal' }
             elseif ($onTrust) { 'trust-modal' }
             elseif ($onWalkthrough) { 'walkthrough' }
             elseif ($hasEditor) { 'editor' }
             elseif ($onWelcomeTab) { 'welcome-tab' }
             else { 'unknown' }
    return [pscustomobject]@{
        State = $state; Blocked = $blocked; OnSignIn = $onSignIn; OnTrust = $onTrust
        OnWalkthrough = $onWalkthrough; OnWelcomeTab = $onWelcomeTab; HasEditor = $hasEditor
    }
}

# Dismiss the "Sign in to use GitHub Copilot" first-run modal via "Continue without Signing In".
function Close-VSCodeSignIn {
    param([Parameter(Mandatory)]$Ctx, [int]$Retries = 4)
    for ($i = 1; $i -le $Retries; $i++) {
        if (-not (Get-VSCodeState -Ctx $Ctx).OnSignIn) { return $true }
        Write-Step "dismissing sign-in modal (Continue without Signing In)"
        winapp ui click 'Continue without Signing In' -w $Ctx.Hwnd 2>&1 | Out-Null
        Start-Sleep -Milliseconds 800
    }
    return (-not (Get-VSCodeState -Ctx $Ctx).OnSignIn)
}

# Clear ALL blocking modals: sign-in, workspace-trust, and the "Make It Yours" walkthrough
# overlay. The walkthrough is dismissed via its OWN close button (coordinate-filtered) so we
# never hit the window title-bar X, which destroys the whole instance.
function Clear-VSCodeOverlays {
    param([Parameter(Mandatory)]$Ctx, [int]$MaxRounds = 6)
    for ($r = 1; $r -le $MaxRounds; $r++) {
        $st = Get-VSCodeState -Ctx $Ctx
        if (-not $st.Blocked) { return $st }
        Write-Step "clearing modal: $($st.State)"
        if ($st.OnSignIn) { Close-VSCodeSignIn -Ctx $Ctx | Out-Null }
        elseif ($st.OnTrust) { winapp ui click 'Yes, I trust the authors' -w $Ctx.Hwnd 2>&1 | Out-Null; Start-Sleep -Milliseconds 700 }
        elseif ($st.OnWalkthrough) { Close-VSCodeWalkthrough -Ctx $Ctx | Out-Null }
        Start-Sleep -Milliseconds 400
    }
    return Get-VSCodeState -Ctx $Ctx
}

# The "Make It Yours" walkthrough is a BLOCKING modal overlay (dims the editor, captures
# input). Dismiss it via its OWN close (x) button - identified by y-coordinate BELOW the
# title bar. The title-bar close (y< ~80) destroys the whole instance, so it is excluded.
function Close-VSCodeWalkthrough {
    param([Parameter(Mandatory)]$Ctx, [int]$Retries = 5)
    for ($i = 1; $i -le $Retries; $i++) {
        if (-not (Get-VSCodeState -Ctx $Ctx).OnWalkthrough) { return $true }
        $matches = winapp ui search 'Close' -w $Ctx.Hwnd --max 12 2>&1 | Out-String
        $slug = $null
        foreach ($line in ($matches -split "`r?`n")) {
            # lines look like: btn-close-bb37 Button "Close" (2069,297 53x54)
            if ($line -match '(btn-close[\w-]*)\s+Button\s+"Close"\s+\((\d+),(\d+)\s') {
                $s = $Matches[1]; $y = [int]$Matches[3]
                if ($y -gt 100) { $slug = $s; break }   # overlay close, NOT the title-bar X
            }
        }
        if ($slug) {
            Write-Step "dismissing walkthrough overlay via $slug (safe, below title bar)"
            winapp ui click $slug -w $Ctx.Hwnd 2>&1 | Out-Null
        } else {
            Write-Step "no safe overlay-close found; not clicking (avoid destroying window)" 'Yellow'
            break
        }
        Start-Sleep -Milliseconds 800
    }
    return (-not (Get-VSCodeState -Ctx $Ctx).OnWalkthrough)
}

# Guarantee we are actually on OUR file editor: clear blocking modals, then bring our file tab
# to the front via --goto (idempotent, reuses our window). Never touches the walkthrough's close.
function Confirm-VSCodeEditor {
    param([Parameter(Mandatory)]$Ctx, [string]$OpenFileIfNeeded)
    # 1. clear TRUE blocking modals (sign-in / trust) - safe, verified, window survives
    $st = Clear-VSCodeOverlays -Ctx $Ctx
    Write-Step "page state = $($st.State)"
    if ($st.Blocked) { Write-Step "modal still present: $($st.State)" 'Yellow' }
    # 2. bring OUR file tab to front (switches away from any walkthrough tab; opens it if missing)
    $target = if ($OpenFileIfNeeded -and (Test-Path $OpenFileIfNeeded)) { $OpenFileIfNeeded } else { $null }
    if ($target) {
        Write-Step "focusing our file tab via --goto (our instance)"
        # MUST pass --user-data-dir so this targets OUR drive instance, not the default profile.
        & (Get-Command code).Source "--user-data-dir=$($Ctx.Udd)" "--reuse-window" "--goto" "$($target):1:1" | Out-Null
        Start-Sleep 2
        Set-VSCodeFocus -Ctx $Ctx | Out-Null   # a helper process may briefly steal foreground
        $st = Get-VSCodeState -Ctx $Ctx
    }
    Write-Step "editor ready = $($st.HasEditor)" ($(if ($st.HasEditor) { 'Green' } else { 'Yellow' }))
    return $st.HasEditor
}

# ---------------------------------------------------------------------------
# 3. ACT - click (UIA) or type (SendInput, only after verified focus).
# ---------------------------------------------------------------------------
function Invoke-VSCodeElement {
    param([Parameter(Mandatory)]$Ctx, [Parameter(Mandatory)][string]$Selector, [switch]$Click)
    if ($Click) { return winapp ui click $Selector -w $Ctx.Hwnd 2>&1 | Out-String }
    return winapp ui invoke $Selector -w $Ctx.Hwnd 2>&1 | Out-String
}

function Send-VSCodeText {
    param([Parameter(Mandatory)]$Ctx, [Parameter(Mandatory)][string]$Text)
    if (-not (Test-VSCodeFocused -Ctx $Ctx)) {
        if (-not (Set-VSCodeFocus -Ctx $Ctx)) { throw "Refusing to type: window not foreground." }
    }
    [VSCodeNative]::TypeText($Text)
}

function Send-VSCodeChord {
    param([Parameter(Mandatory)]$Ctx, [Parameter(Mandatory)][ushort[]]$Vks)
    if (-not (Test-VSCodeFocused -Ctx $Ctx)) {
        if (-not (Set-VSCodeFocus -Ctx $Ctx)) { throw "Refusing to send keys: window not foreground." }
    }
    [VSCodeNative]::Chord($Vks)
}

function Send-VSCodeKey {
    param([Parameter(Mandatory)]$Ctx, [Parameter(Mandatory)][ushort]$Vk)
    if (-not (Test-VSCodeFocused -Ctx $Ctx)) {
        if (-not (Set-VSCodeFocus -Ctx $Ctx)) { throw "Refusing to send key: window not foreground." }
    }
    [VSCodeNative]::KeyPress($Vk)
}

# ---------------------------------------------------------------------------
# The disciplined Command Palette command runner (KEYSTROKE path).
#   NOTE: synthetic keyboard injection is BLOCKED in this agent environment (SendInput
#   reaches no window - verified against Notepad + VS Code). This function is kept for
#   reference / other environments, but WILL NOT drive the palette here. Use the driver
#   queue functions below (Invoke-VSCodeDriverCommand) to fire extension commands reliably.
# ---------------------------------------------------------------------------
function Invoke-VSCodeCommand {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Ctx,
        [Parameter(Mandatory)][string]$Command,   # e.g. "Preferences: Open Settings (UI)"
        [string]$VerifySearch,                     # winapp ui search text expected AFTER the command runs
        [int]$SettleMs = 1200
    )
    # 1. focus + verify
    if (-not (Set-VSCodeFocus -Ctx $Ctx)) { return [pscustomobject]@{ ok = $false; reason = 'focus-failed' } }
    # 2. must be on the editor for the palette flow
    if (-not (Confirm-VSCodeEditor -Ctx $Ctx)) { Write-Step "not on editor - palette may misbehave" 'Yellow' }
    # re-assert focus (Confirm may have run UIA that changed foreground)
    Set-VSCodeFocus -Ctx $Ctx | Out-Null
    # 3. open palette (Ctrl+Shift+P opens quick-input ALREADY in command mode, i.e. prefilled ">").
    Write-Step "Ctrl+Shift+P"
    Send-VSCodeChord -Ctx $Ctx -Vks @([ushort]$script:VK.CTRL, [ushort]$script:VK.SHIFT, [ushort]$script:VK.P)
    Start-Sleep -Milliseconds 700
    # 4. type the command name WITHOUT a leading '>' (the palette already supplied it; a
    #    second '>' becomes '>>' which matches nothing).
    Send-VSCodeText -Ctx $Ctx -Text $Command
    Start-Sleep -Milliseconds 700
    # 5. run it
    Send-VSCodeKey -Ctx $Ctx -Vk ([ushort]$script:VK.ENTER)
    Start-Sleep -Milliseconds $SettleMs
    # 6. verify effect (if asked)
    $verified = $null
    if ($VerifySearch) {
        $res = winapp ui search $VerifySearch -w $Ctx.Hwnd --max 3 2>&1 | Out-String
        $verified = ($res -match 'Found [1-9]')
        Write-Step "verify '$VerifySearch' => $verified" ($(if ($verified) { 'Green' } else { 'Red' }))
    }
    return [pscustomobject]@{ ok = $true; command = $Command; verified = $verified }
}

# ---------------------------------------------------------------------------
# DRIVER QUEUE - the RELIABLE way to drive extension commands in this environment.
# Pushes a step to the live driver-extension (which runs it via vscode.commands.executeCommand /
# vscode.debug.startDebugging) and waits for its result. Requires Start-VSCodeDrive -WithDriverExtension.
# ---------------------------------------------------------------------------
function Invoke-VSCodeDriverStep {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Ctx,
        [Parameter(Mandatory)][hashtable]$Step,     # e.g. @{ type='command'; command='winapp.certGenerate'; answers=@(@{accept=$true}) }
        [int]$TimeoutSec = 120
    )
    if (-not $Ctx.QueueDir) { throw "This context has no driver queue. Launch with Start-VSCodeDrive -WithDriverExtension." }
    $Ctx.ReqSeq++
    $id = "{0:d4}" -f $Ctx.ReqSeq
    $Step['id'] = $id
    $reqFile = Join-Path $Ctx.QueueDir "req-$id.json"
    $resFile = Join-Path $Ctx.QueueDir "res-$id.json"
    ($Step | ConvertTo-Json -Depth 8) | Set-Content $reqFile -Encoding UTF8
    Write-Step "driver queue -> [$id] $($Step.type) $($Step.command)$($Step.inputFolder)"
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path $resFile) {
            try {
                $r = Get-Content $resFile -Raw | ConvertFrom-Json
                if ($r.done) { Write-Step "driver result [$id] ready" 'Green'; return $r }
            } catch {}
        }
        Start-Sleep -Milliseconds 500
    }
    Write-Step "driver step [$id] timed out after ${TimeoutSec}s" 'Red'
    return [pscustomobject]@{ id = $id; done = $false; error = 'timeout' }
}

# Fire a winapp.* (or any) command by ID; answers is an ordered list of @{accept=$true} /
# @{nativeDialogPath='...'} to satisfy the command's prompts.
function Invoke-VSCodeDriverCommand {
    param(
        [Parameter(Mandatory)]$Ctx,
        [Parameter(Mandatory)][string]$CommandId,
        [object[]]$Answers = @(),
        [int]$SettleMs = 1600,
        [int]$TimeoutSec = 120
    )
    return Invoke-VSCodeDriverStep -Ctx $Ctx -Step @{ type = 'command'; command = $CommandId; answers = $Answers; settleMs = $SettleMs } -TimeoutSec $TimeoutSec
}

# Launch the app via the WinApp DEBUGGER (vscode.debug.startDebugging).
function Invoke-VSCodeDriverDebug {
    param([Parameter(Mandatory)]$Ctx, [Parameter(Mandatory)][string]$InputFolder, [string]$Name = 'WinApp: Launch and Attach', [int]$TimeoutSec = 120)
    return Invoke-VSCodeDriverStep -Ctx $Ctx -Step @{ type = 'debug'; inputFolder = $InputFolder; name = $Name } -TimeoutSec $TimeoutSec
}

# Open a file / the manifest webview in the live instance.
function Invoke-VSCodeDriverOpenFile {
    param([Parameter(Mandatory)]$Ctx, [Parameter(Mandatory)][string]$Path, [switch]$AsManifest, [int]$TimeoutSec = 60)
    $type = if ($AsManifest) { 'openManifest' } else { 'openFile' }
    return Invoke-VSCodeDriverStep -Ctx $Ctx -Step @{ type = $type; path = $Path } -TimeoutSec $TimeoutSec
}

# ---------------------------------------------------------------------------
# Teardown - kill ONLY our instance, clean the udd.
# ---------------------------------------------------------------------------
function Stop-VSCodeDrive {
    param([Parameter(Mandatory)]$Ctx)
    $ourPids = (Get-CimInstance Win32_Process -Filter "Name='Code.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match [regex]::Escape($Ctx.UddLeaf) }).ProcessId
    foreach ($p in $ourPids) { try { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } catch {} }
    Start-Sleep 2
    Remove-Item $Ctx.Udd -Recurse -Force -ErrorAction SilentlyContinue
    if ($Ctx.QueueDir) { Remove-Item $Ctx.QueueDir -Recurse -Force -ErrorAction SilentlyContinue }
    Write-Step "stopped + cleaned udd$(if ($Ctx.QueueDir) { ' + queue' })" 'Green'
}

Export-ModuleMember -Function Start-VSCodeDrive, Get-VSCodeWindow, Set-VSCodeFocus, Test-VSCodeFocused,
    Get-VSCodeState, Close-VSCodeWalkthrough, Close-VSCodeSignIn, Clear-VSCodeOverlays, Confirm-VSCodeEditor, Invoke-VSCodeElement,
    Send-VSCodeText, Send-VSCodeChord, Send-VSCodeKey, Invoke-VSCodeCommand,
    Invoke-VSCodeDriverStep, Invoke-VSCodeDriverCommand, Invoke-VSCodeDriverDebug, Invoke-VSCodeDriverOpenFile,
    Stop-VSCodeDrive
