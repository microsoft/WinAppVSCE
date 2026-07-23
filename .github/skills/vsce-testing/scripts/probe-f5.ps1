#requires -Version 7
# Focused probe: press F5 (winapp debugger) on app01 and capture exactly what happens,
# with the C# extension present and the correct build-output inputFolder.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Import-Module (Join-Path $root 'scripts\vscode-drive.psm1') -Force

$proj = Join-Path $root 'workspace\01-counter-blank\CounterApp'
$src  = Join-Path $proj 'MainWindow.xaml.cs'
# the win-x64 output that actually has the app exe
$input = (Get-ChildItem (Join-Path $proj 'bin') -Recurse -Directory -Filter win-x64 |
    Where-Object { $_.FullName -match 'Debug' -and (Get-ChildItem $_.FullName -Filter *.exe -EA SilentlyContinue | Where-Object Name -notmatch createdump) } |
    Select-Object -First 1).FullName
Write-Host "inputFolder = $input"
$shot = Join-Path $root 'logs\f5'
New-Item -ItemType Directory -Force -Path $shot | Out-Null

$ctx = Start-VSCodeDrive -Folder $proj -OpenFile $src -WithDriverExtension -SettleSec 22
try {
    Set-VSCodeFocus -Ctx $ctx | Out-Null
    Confirm-VSCodeEditor -Ctx $ctx -OpenFileIfNeeded $src | Out-Null
    winapp ui screenshot -w $ctx.Hwnd -o (Join-Path $shot '00-editor.png') 2>&1 | Out-Null

    # Push the debug step in the background (driver blocks until afterMs); meanwhile we snapshot.
    $reqDir = $ctx.QueueDir
    $job = Start-Job -ScriptBlock {
        param($mod,$ctx,$input)
        Import-Module $mod -Force
        Invoke-VSCodeDriverDebug -Ctx $ctx -InputFolder $input -TimeoutSec 180 | ConvertTo-Json -Depth 12
    } -ArgumentList (Join-Path $root 'scripts\vscode-drive.psm1'), $ctx, $input

    # Snapshot every 8s for ~2min to watch the debugger's UI (dialogs, notifications, terminal).
    for ($i=1; $i -le 15; $i++) {
        Start-Sleep 8
        winapp ui screenshot -w $ctx.Hwnd -o (Join-Path $shot ("t{0:d2}.png" -f $i)) 2>&1 | Out-Null
        $lw = (winapp ui list-windows 2>&1 | Out-String) -replace '\r?\n',' '
        $dlg = [regex]::Match($lw, 'HWND (\d+): "([^"]*)"[^)]*#32770')
        if ($dlg.Success) { Write-Host ("t{0:d2}: dialog '{1}' hwnd {2}" -f $i, $dlg.Groups[2].Value, $dlg.Groups[1].Value) }
        if ($job.State -ne 'Running') { break }
    }
    $res = Receive-Job $job -Wait
    Remove-Job $job -Force -EA SilentlyContinue
    $res | Set-Content (Join-Path $root 'logs\f5\debug-result.json')
    Write-Host "=== debug result ==="; Write-Host $res

    # Did the app process launch?
    $exeName = [IO.Path]::GetFileNameWithoutExtension((Get-ChildItem $input -Filter *.exe | Where-Object Name -notmatch createdump | Select-Object -First 1).Name)
    $running = @(Get-Process -Name $exeName -EA SilentlyContinue)
    Write-Host "app '$exeName' running = $($running.Count)"
    foreach ($p in $running) { try { Stop-Process -Id $p.Id -Force -EA SilentlyContinue } catch {} }
}
finally {
    Stop-VSCodeDrive -Ctx $ctx
}
