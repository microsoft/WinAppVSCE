# Answer a native Win32 file-open dialog (#32770) via UIA.
#
# The harness's own typeIntoNativeDialog is unreliable for 'file' dialogs here:
# its edit-slug regex does not match the "File name:" combo, and plain
# `invoke 'Open'` is ambiguous because the dialog also carries two
# dropdown-arrow buttons named "Open". Both are resolved by reading the
# disambiguation list that winapp ui prints and choosing deliberately:
# the Edit element for the path, and the widest "Open" button (the real
# command button, ~132px, versus the ~24px arrows).
function Get-ForegroundDialogHwnd {
    param([int]$TimeoutSec = 20)
    $sig = @'
using System;
using System.Runtime.InteropServices;
public class FGX {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
}
'@
    Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $h = [FGX]::GetForegroundWindow()
        $sb = New-Object System.Text.StringBuilder 256
        [void][FGX]::GetClassName($h, $sb, 256)
        if ($sb.ToString() -eq '#32770') { return [int64]$h }
        Start-Sleep -Milliseconds 400
    }
    return 0
}

function Invoke-WidestButton {
    param([int64]$Hwnd, [string]$Name)
    $out = (winapp ui invoke -w $Hwnd $Name 2>&1 | Out-String)
    if ($out -notmatch 'matched') {
        return "invoked-directly: $($out.Trim() -replace '\s+', ' ')"
    }
    # Disambiguation rows look like:
    #   [2] Button "Open" (931,756 132x39)  -> btn-1-4dc3
    $best = $null
    $bestWidth = -1
    foreach ($ln in ($out -split "\r?\n")) {
        if ($ln -match '\((\d+),(\d+)\s+(\d+)x(\d+)\)\s*->\s*(\S+)') {
            $w = [int]$Matches[3]
            if ($w -gt $bestWidth) { $bestWidth = $w; $best = $Matches[5].Trim() }
        }
    }
    if (-not $best) { return "no-slug-found: $($out.Trim() -replace '\s+', ' ')" }
    $r = (winapp ui invoke -w $Hwnd $best 2>&1 | Out-String)
    return "invoked $best (width=$bestWidth): $($r.Trim() -replace '\s+', ' ')"
}

function Answer-FileDialog {
    param([string]$Path, [int]$TimeoutSec = 20)
    $hwnd = Get-ForegroundDialogHwnd -TimeoutSec $TimeoutSec
    if (-not $hwnd) { return 'NO-DIALOG' }

    Start-Sleep -Milliseconds 400
    $sv = (winapp ui set-value -w $hwnd 'File name:' $Path 2>&1 | Out-String)
    if ($sv -match 'matched') {
        $editSlug = $null
        foreach ($ln in ($sv -split "\r?\n")) {
            if ($ln -match 'Edit .*->\s*(\S+)') { $editSlug = $Matches[1].Trim(); break }
        }
        if ($editSlug) {
            winapp ui set-value -w $hwnd $editSlug $Path 2>&1 | Out-Null
        } else {
            return "NO-EDIT-SLUG: $($sv.Trim() -replace '\s+', ' ')"
        }
    }
    Start-Sleep -Milliseconds 500
    $inv = Invoke-WidestButton -Hwnd $hwnd -Name 'Open'
    return "DIALOG:$hwnd $inv"
}

function Invoke-ModalButton {
    param([int64]$Hwnd, [string]$Name)
    Start-Sleep -Seconds 2
    return (winapp ui invoke -w $Hwnd $Name 2>&1 | Out-String).Trim() -replace '\s+', ' '
}
