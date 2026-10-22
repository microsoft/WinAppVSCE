#requires -Version 5.1
<#
.SYNOPSIS
    WinAppSDK version matrix: runs the renderer suites (Smoke, I2 parity, Q fixtures) against a surface
    and test apps built for each WinAppSDK version.
.DESCRIPTION
    For each version the surface is built self-contained with the same properties the SurfaceProvisioner
    uses for a matched host (-p:WinUISurfaceWasdkVersion=<v> -p:WindowsAppSDKSelfContained=true), so no
    Windows App Runtime install is needed. TestUserApp / TestFixtureApp / TestFixtureLib are rebuilt with
    -p:TestWasdkVersion=<v> so the user code matches the host. Ready.wasdk must report the requested
    version. A failing version does not stop the run; the summary lists every version and the exit code is
    non-zero if any failed. Surface builds are staged under %TEMP%\WinUIVersionMatrix (never the payload).
.EXAMPLE
    .\Test-VersionMatrix.ps1
    .\Test-VersionMatrix.ps1 -Versions 2.2.0,2.5.1
#>
[CmdletBinding()]
param(
    # Matched hosts support 1.8+ (the <=1.7 framework-MSIX layout is not handled by the provisioner).
    [string[]]$Versions = @("1.8.260921001", "2.0.1", "2.1.3", "2.2.0", "2.3.1", "2.4.0", "2.5.1")
)
$ErrorActionPreference = "Stop"
# `powershell -File` passes "a,b" as one string; accept both forms.
$Versions = @($Versions | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$root = (Resolve-Path "$PSScriptRoot\..").Path
$tfm = "net10.0-windows10.0.26100.0"
$msbuild = & "$PSScriptRoot\Find-DesktopMSBuild.ps1"
foreach ($name in @("SurfaceClient.Smoke", "SurfaceClient.UITest")) {
    & $msbuild "$PSScriptRoot\$name\$name.csproj" /restore /nologo /p:Configuration=Debug /p:Platform=x64 /v:minimal
    if ($LASTEXITCODE -ne 0) { throw "$name build failed (exit $LASTEXITCODE)." }
}
$smoke = "$PSScriptRoot\SurfaceClient.Smoke\bin\x64\Debug\net472\SurfaceClient.Smoke.exe"
$ui = "$PSScriptRoot\SurfaceClient.UITest\bin\x64\Debug\net472\SurfaceClient.UITest.exe"
# Staged under %TEMP%: the self-contained WinAppSDK 1.8 build copies files whose paths exceed MAX_PATH from a deep worktree.
$stageRoot = Join-Path ([IO.Path]::GetTempPath()) "WinUIVersionMatrix"
$logRoot = "$PSScriptRoot\SurfaceClient.UITest\TestResults\VersionMatrix"
New-Item -ItemType Directory -Force $stageRoot, $logRoot | Out-Null

function Invoke-Logged([string]$Log, [scriptblock]$Body) {
    # PS 5.1 turns redirected native stderr into terminating errors under Stop.
    $ErrorActionPreference = "Continue"
    & $Body 2>&1 | ForEach-Object { "$_" } | Tee-Object -FilePath $Log -Append | Out-Null
    return $LASTEXITCODE
}
function Get-Count([string]$Log, [string]$Pattern) {
    $m = Select-String -Path $Log -Pattern $Pattern | Select-Object -Last 1
    if ($m) { return $m.Matches[0].Groups[1].Value + "/" + ([int]$m.Matches[0].Groups[1].Value + [int]$m.Matches[0].Groups[2].Value) }
    return "-"
}
function Build-TestApps([string]$Version, [string]$Log) {
    foreach ($proj in @("TestUserApp\TestUserApp.csproj", "TestFixtureApp\TestFixtureApp.csproj")) {
        $code = Invoke-Logged $Log { & dotnet build "$root\surface\$proj" -c Debug -p:Platform=x64 `
            -p:RuntimeIdentifier=win-x64 "-p:TestWasdkVersion=$Version" --nologo -v minimal }
        if ($code -ne 0) { return "build $proj" }
    }
    return $null
}

$saved = @{}
foreach ($name in @("WINUI_SURFACE_EXE", "WINUI_SURFACE_USER_PRI", "WINUI_GALLERY_PAGE", "SURFACE_GUARDS")) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
    [Environment]::SetEnvironmentVariable($name, $null, "Process")
}
$rows = @()
try {
    foreach ($v in $Versions) {
        Write-Host "===== WinAppSDK $v =====" -ForegroundColor Cyan
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $log = "$logRoot\$v.log"
        if (Test-Path $log) { Remove-Item $log -Force }
        $row = [ordered]@{ Version = $v; Result = "PASS"; Wasdk = "-"; Smoke = "-"; Parity = "-"; Fixtures = "-"; Minutes = 0; Failure = "" }
        try {
            # 1. Matched-host surface, staged per version so builds never collide with the payload build.
            $stage = "$stageRoot\$v"
            if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
            & robocopy "$root\surface\Surface" "$stage\Surface" /E /XD bin obj .vs /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
            if ($LASTEXITCODE -ge 8) { throw "stage surface (robocopy $LASTEXITCODE)" }
            $code = Invoke-Logged $log { & dotnet build "$stage\Surface\Surface.csproj" -c Debug -p:Platform=x64 `
                -p:RuntimeIdentifier=win-x64 "-p:WinUISurfaceWasdkVersion=$v" -p:WindowsAppSDKSelfContained=true `
                --nologo -v minimal -nodeReuse:false }
            if ($code -ne 0) { throw "build surface" }
            $exe = "$stage\Surface\bin\x64\Debug\$tfm\win-x64\Surface.exe"
            if (-not (Test-Path $exe)) { throw "Surface.exe missing after build" }

            # 2. Test apps at the same version.
            $err = Build-TestApps $v $log
            if ($err) { throw $err }

            # 3. Suites. Run them all so one failure still reports the rest.
            $failed = @()
            $env:WINUI_SURFACE_EXE = $exe
            if ((Invoke-Logged $log { & $smoke }) -ne 0) { $failed += "smoke" }
            $env:WINUI_SURFACE_EXE = $null
            if ((Invoke-Logged $log { & $ui --parity --surface $exe --out "$logRoot\$v" }) -ne 0) { $failed += "parity" }
            $fx = "$root\surface\TestFixtureApp"
            if ((Invoke-Logged $log { & $ui --fixtures --surface $exe --out "$logRoot\$v" `
                --user-dll "$fx\bin\x64\Debug\$tfm\TestFixtureApp.dll" --fixtures-dir "$fx\Fixtures" }) -ne 0) { $failed += "fixtures" }

            # 4. The surface must actually be the requested version (R3).
            $w = Select-String -Path $log -Pattern '^\s*wasdk = (.+)$' | Select-Object -First 1
            if ($w) { $row.Wasdk = $w.Matches[0].Groups[1].Value.Trim() }
            if ($row.Wasdk -ne $v) { $failed += "wasdk=$($row.Wasdk)" }

            $row.Smoke = Get-Count $log '===== (\d+) passed, (\d+) failed ====='
            $row.Parity = Get-Count $log '===== PARITY: (\d+) passed, (\d+) failed ====='
            $row.Fixtures = Get-Count $log '===== FIXTURES: (\d+) passed, (\d+) failed ====='
            if ($failed) { $row.Result = "FAIL"; $row.Failure = $failed -join ", " }
            # Self-contained hosts are a few hundred MB each; keep only failing ones for debugging.
            else { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
        } catch {
            $row.Result = "FAIL"; $row.Failure = "$_"
        }
        $row.Minutes = [math]::Round($sw.Elapsed.TotalMinutes, 1)
        Write-Host ("  {0}  {1}  ({2} min)  log: {3}" -f $row.Result, $row.Failure, $row.Minutes, $log)
        $rows += [pscustomobject]$row
    }
} finally {
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], "Process") }
    # Leave the test apps at the default version so Test-Migration and the IDE see the usual build.
    Write-Host "Restoring test apps to the default WinAppSDK..."
    $null = Build-TestApps "2.2.0" "$logRoot\restore-default.log"
}

Write-Host ""
Write-Host "===== WinAppSDK version matrix =====" -ForegroundColor Cyan
$rows | Format-Table Version, Result, Wasdk, Smoke, Parity, Fixtures, Minutes, Failure -AutoSize | Out-Host
$bad = @($rows | Where-Object Result -ne "PASS")
Write-Host ("===== MATRIX: {0} passed, {1} failed =====" -f ($rows.Count - $bad.Count), $bad.Count)
if ($bad.Count) { exit 1 }
