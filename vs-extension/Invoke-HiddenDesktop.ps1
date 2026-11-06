param(
    [Parameter(Mandatory)] [string] $CommandLine,
    [string] $DesktopName = "wxp-hidden-test",
    [int] $TimeoutSeconds = 900
)

# Runs $CommandLine (via cmd.exe /c) on a separate, never-shown desktop in WinSta0, so its windows don't appear
# on the user's screen or steal focus. Child processes inherit the desktop. Returns the process exit code.
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class HiddenDesktop {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateDesktop(string name, IntPtr dev, IntPtr mode, uint flags, uint access, IntPtr sa);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseDesktop(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags,
        IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll")] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] public static extern bool TerminateProcess(IntPtr h, uint code);
}
"@

$GENERIC_ALL = 0x10000000
$desk = [HiddenDesktop]::CreateDesktop($DesktopName, [IntPtr]::Zero, [IntPtr]::Zero, 0, $GENERIC_ALL, [IntPtr]::Zero)
if ($desk -eq [IntPtr]::Zero) { throw "CreateDesktop failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
try {
    $si = New-Object HiddenDesktop+STARTUPINFO
    $si.cb = [Runtime.InteropServices.Marshal]::SizeOf($si)
    $si.lpDesktop = "WinSta0\$DesktopName"
    $pi = New-Object HiddenDesktop+PROCESS_INFORMATION
    $cmd = "`"$env:ComSpec`" /c $CommandLine"
    if (-not [HiddenDesktop]::CreateProcess($env:ComSpec, $cmd, [IntPtr]::Zero, [IntPtr]::Zero, $false, 0x00000010 <# CREATE_NEW_CONSOLE #>,
            [IntPtr]::Zero, [NullString]::Value, [ref]$si, [ref]$pi)) {
        throw "CreateProcess failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    Write-Host "Started PID $($pi.dwProcessId) on desktop WinSta0\$DesktopName"
    $r = [HiddenDesktop]::WaitForSingleObject($pi.hProcess, [uint32]($TimeoutSeconds * 1000))
    if ($r -ne 0) { [HiddenDesktop]::TerminateProcess($pi.hProcess, 1) | Out-Null; Write-Host "TIMED OUT"; $code = 1 }
    else { $c = [uint32]0; [HiddenDesktop]::GetExitCodeProcess($pi.hProcess, [ref]$c) | Out-Null; $code = [BitConverter]::ToInt32([BitConverter]::GetBytes($c), 0) }
    [HiddenDesktop]::CloseHandle($pi.hProcess) | Out-Null; [HiddenDesktop]::CloseHandle($pi.hThread) | Out-Null
    Write-Host "Exit code: $code"
    exit $code
} finally {
    [HiddenDesktop]::CloseDesktop($desk) | Out-Null
}
