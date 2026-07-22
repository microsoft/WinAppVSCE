#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Drive the VS Code GUI (and thereby the WinApp extension) via real OS keystrokes + UIA.
.DESCRIPTION
    Provides functions to focus a VS Code window, run an extension command through the Command
    Palette, answer QuickPick/InputBox prompts, and launch the WinApp debugger (F5). Verification
    of the running app is done separately with `winapp ui`. Dot-source this file to use it:
        . .\scripts\vscode-driver.ps1

    NOTE: Keystroke automation requires the target VS Code window to be foreground. Run on an
    interactive desktop session. All functions add deliberate delays for UI settle time.
#>

Add-Type -AssemblyName System.Windows.Forms

if (-not ("WinApi.Win" -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
namespace WinApi {
  public static class Win {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  }
}
"@
}

function Get-VSCodeWindow {
    <# Returns the first Code process whose MainWindowTitle matches -TitleMatch (wildcard). #>
    param([Parameter(Mandatory)][string]$TitleMatch)
    Get-Process Code -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle -like "*$TitleMatch*" } |
        Select-Object -First 1
}

function Set-VSCodeForeground {
    <# Brings a matching VS Code window to the foreground. Returns $true on success. #>
    param([Parameter(Mandatory)][string]$TitleMatch, [int]$Retries = 10)
    for ($i = 0; $i -lt $Retries; $i++) {
        $p = Get-VSCodeWindow -TitleMatch $TitleMatch
        if ($p) {
            $h = $p.MainWindowHandle
            if ([WinApi.Win]::IsIconic($h)) { [WinApi.Win]::ShowWindow($h, 9) | Out-Null } # SW_RESTORE
            [WinApi.Win]::ShowWindow($h, 5) | Out-Null # SW_SHOW
            [WinApi.Win]::SetForegroundWindow($h) | Out-Null
            Start-Sleep -Milliseconds 700
            if ([WinApi.Win]::GetForegroundWindow() -eq $h) { return $true }
        }
        Start-Sleep -Milliseconds 800
    }
    return $false
}

function Send-VSKeys {
    <# SendWait wrapper with a settle delay. Caller pre-escapes SendKeys special chars. #>
    param([Parameter(Mandatory)][string]$Keys, [int]$SettleMs = 500)
    [System.Windows.Forms.SendKeys]::SendWait($Keys)
    Start-Sleep -Milliseconds $SettleMs
}

function ConvertTo-SendKeysLiteral {
    <# Escape SendKeys metacharacters in literal text we want typed verbatim. #>
    param([Parameter(Mandatory)][string]$Text)
    $sb = [System.Text.StringBuilder]::new()
    foreach ($ch in $Text.ToCharArray()) {
        if ('+^%~(){}[]'.IndexOf($ch) -ge 0) { [void]$sb.Append('{'); [void]$sb.Append($ch); [void]$sb.Append('}') }
        else { [void]$sb.Append($ch) }
    }
    $sb.ToString()
}

function Invoke-VSCommand {
    <#
    .SYNOPSIS Run a VS Code command through the Command Palette and answer any follow-up prompts.
    .PARAMETER TitleMatch  Substring of the VS Code window title (usually the project folder name).
    .PARAMETER CommandTitle  The command's palette title, e.g. 'WinApp: Run Application'.
    .PARAMETER Answers  Ordered responses to QuickPick/InputBox prompts. Each is sent then ENTER.
                        Use '' (empty) to just accept the default/first item with ENTER.
    .PARAMETER PreAnswerDelayMs  Wait before each answer (prompt render time).
    #>
    param(
        [Parameter(Mandatory)][string]$TitleMatch,
        [Parameter(Mandatory)][string]$CommandTitle,
        [string[]]$Answers = @(),
        [int]$PreAnswerDelayMs = 1200
    )
    if (-not (Set-VSCodeForeground -TitleMatch $TitleMatch)) {
        throw "Could not foreground VS Code window matching '$TitleMatch'"
    }
    Send-VSKeys '^+p' 900                              # Ctrl+Shift+P -> Command Palette
    Send-VSKeys (ConvertTo-SendKeysLiteral $CommandTitle) 900
    Send-VSKeys '{ENTER}' $PreAnswerDelayMs            # run the highlighted command
    foreach ($a in $Answers) {
        Start-Sleep -Milliseconds $PreAnswerDelayMs
        if ($a) { Send-VSKeys (ConvertTo-SendKeysLiteral $a) 500 }
        Send-VSKeys '{ENTER}' 600
    }
}

function Set-WinAppLaunchJson {
    <# Write a .vscode/launch.json with the WinApp debugger config for this project. #>
    param(
        [Parameter(Mandatory)][string]$ProjectDir,
        [string]$InputFolder = "",          # build output folder containing the .exe; optional
        [string]$Name = "WinApp: Launch and Attach"
    )
    $vscodeDir = Join-Path $ProjectDir ".vscode"
    New-Item -ItemType Directory -Force -Path $vscodeDir | Out-Null
    $cfg = [ordered]@{ type = "winapp"; request = "launch"; name = $Name; debuggerType = "coreclr" }
    if ($InputFolder) { $cfg.inputFolder = $InputFolder }
    $obj = [ordered]@{ version = "0.2.0"; configurations = @($cfg) }
    $json = $obj | ConvertTo-Json -Depth 6
    Set-Content -Path (Join-Path $vscodeDir "launch.json") -Value $json -Encoding UTF8
    return (Join-Path $vscodeDir "launch.json")
}

function Start-WinAppDebug {
    <# Start the WinApp debugger via F5 in the matching VS Code window. #>
    param([Parameter(Mandatory)][string]$TitleMatch)
    if (-not (Set-VSCodeForeground -TitleMatch $TitleMatch)) {
        throw "Could not foreground VS Code window matching '$TitleMatch'"
    }
    Send-VSKeys '{F5}' 1500
}

function Stop-WinAppDebug {
    <# Stop debugging via Shift+F5. #>
    param([Parameter(Mandatory)][string]$TitleMatch)
    if (Set-VSCodeForeground -TitleMatch $TitleMatch) { Send-VSKeys '+{F5}' 1000 }
}
