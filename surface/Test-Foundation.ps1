#requires -Version 7.0
[CmdletBinding()]
param([switch]$IncludeBuild, [switch]$IncludeRenderer)
$ErrorActionPreference = "Stop"
$root = (Resolve-Path "$PSScriptRoot\..").Path
& dotnet run --project "$PSScriptRoot\SurfaceProvisioner.Tests\SurfaceProvisioner.Tests.csproj"
if ($LASTEXITCODE -ne 0) { throw "Provisioner fixtures failed." }
& node "$root\node_modules\typescript\bin\tsc" -p "$PSScriptRoot\protocol\tsconfig.json"
if ($LASTEXITCODE -ne 0) { throw "Protocol typecheck failed." }
& dotnet restore "$PSScriptRoot\protocol\Compatibility.csproj" --nologo -v:q
if ($LASTEXITCODE -ne 0) { throw "Protocol SDK assets restore failed." }
& node "$root\node_modules\tsx\dist\cli.mjs" --test "$PSScriptRoot\protocol\compatibility.test.ts"
if ($LASTEXITCODE -ne 0) { throw "Protocol compatibility failed." }
if (-not $IncludeBuild) {
    if ($IncludeRenderer) { throw "-IncludeRenderer requires -IncludeBuild." }
    return
}
$sdk = "$PSScriptRoot\obj\HostSDK"
$exe = "$sdk\SurfaceProvisioner\SurfaceProvisioner.exe"
if (-not (Test-Path $exe)) { throw "Build-Vsix.ps1 -NoDeploy first." }
$stamp = Get-Content "$sdk\engine.stamp" -Raw
$cache = "$PSScriptRoot\obj\Foundation-$([Guid]::NewGuid().ToString('N').Substring(0,12))"
$arguments = @("--build", "--project", "$PSScriptRoot\TestUserApp\TestUserApp.csproj",
    "--surface-project", "$sdk\surface\Surface\Surface.csproj",
    "--designhostpri-project", "$sdk\DesignHost\DesignHost.csproj", "--cache", $cache, "--engine-stamp", $stamp)
function Start-Provisioner([string[]]$Arguments) {
    $psi = [Diagnostics.ProcessStartInfo]::new($exe)
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardInput = $true
    foreach ($arg in $Arguments) { $psi.ArgumentList.Add($arg) }
    $process = [Diagnostics.Process]::Start($psi)
    [pscustomobject]@{ Process = $process; Output = $process.StandardOutput.ReadToEndAsync(); Diagnostics = $process.StandardError.ReadToEndAsync() }
}
function Complete-Provisioner($Invocation) {
    if (-not $Invocation.Process.WaitForExit(300000)) { throw "Provisioner timed out." }
    $out = $Invocation.Output.GetAwaiter().GetResult()
    $diag = $Invocation.Diagnostics.GetAwaiter().GetResult()
    Write-Host $diag
    $result = $out | ConvertFrom-Json
    if ($result.contractVersion -ne 1) { throw "Structured contract missing." }
    [pscustomobject]@{ Exit = $Invocation.Process.ExitCode; Result = $result }
}
$active = @()
try {
    # Two real independent clients, empty explicitly owned cache. Source input paths may be arbitrarily deep.
    $active += Start-Provisioner $arguments
    $active += Start-Provisioner $arguments
    $a = Complete-Provisioner $active[0]
    $b = Complete-Provisioner $active[1]
    if ($a.Exit -ne 0 -or $b.Exit -ne 0 -or
        ((@($a.Result.status, $b.Result.status) | Sort-Object) -join ',') -ne 'built,cached' -or
        $a.Result.cacheKey -ne $b.Result.cacheKey -or $a.Result.hostDir -ne $b.Result.hostDir) {
        throw "Cross-process build/cache contract failed: $($a | ConvertTo-Json -Depth 8) / $($b | ConvertTo-Json -Depth 8)"
    }
    Write-Host "PASS: concurrent real provisioning => one built, one cached; identical immutable host."
    $active += Start-Provisioner @("--build", "--cancel-on-stdin", "--project", "$PSScriptRoot\TestUserApp\TestUserApp.csproj",
        "--surface-project", "$sdk\surface\Surface\Surface.csproj", "--designhostpri-project", "$sdk\DesignHost\DesignHost.csproj",
        "--cache", "$cache\cancelled")
    $active[-1].Process.StandardInput.Close()
    $cancelled = Complete-Provisioner $active[-1]
    if ($cancelled.Exit -ne 130 -or -not $cancelled.Result.cancelled -or $cancelled.Result.success) {
        throw "Cooperative CLI cancellation failed."
    }
    Write-Host "PASS: cooperative CLI cancellation => failed/cancelled, exit 130."
    $missingArgs = @("--build", "--project", "$PSScriptRoot\TestUserApp\TestUserApp.csproj",
        "--surface-project", "$cache\missing.csproj", "--designhostpri-project", "$sdk\DesignHost\DesignHost.csproj",
        "--cache", "$cache\missing")
    $active += Start-Provisioner $missingArgs
    $failed = Complete-Provisioner $active[-1]
    if ($failed.Exit -ne 1 -or $failed.Result.status -ne 'failed' -or $failed.Result.success -or
        $failed.Result.error -notmatch 'Required source project missing') { throw "Structured missing-input failure lost detail." }
    $active += Start-Provisioner ($missingArgs + @("--bundled-host", "$root\vs-extension\WinUIXamlPreview\obj\IdentityPayload"))
    $degraded = Complete-Provisioner $active[-1]
    if ($degraded.Exit -ne 3 -or $degraded.Result.status -ne 'degraded' -or $degraded.Result.success -or
        $degraded.Result.error -notmatch 'Required source project missing') { throw "Explicit fallback falsely reported success." }
    Write-Host "PASS: real CLI failed/degraded outcomes preserve source failure; neither reports success."
    $hostDir = $a.Result.hostDir
    $cancelledRun = "$cache\cancelled-run"
    $active += Start-Provisioner @("--prepare-run", "--cancel-on-stdin", "--host", $hostDir, "--run-root", $cancelledRun)
    $active[-1].Process.StandardInput.Close()
    $prepareCancelled = Complete-Provisioner $active[-1]
    if ($prepareCancelled.Exit -ne 130 -or -not $prepareCancelled.Result.cancelled -or
        $prepareCancelled.Result.success -or $prepareCancelled.Result.status -ne 'failed' -or
        (Test-Path $cancelledRun) -or
        (Get-ChildItem -LiteralPath $cache -Directory -Filter 'cancelled-run.preparing-*')) {
        throw "Run preparation stdin cancellation or owned staging cleanup failed."
    }
    Write-Host "PASS: real --prepare-run stdin cancellation => failed/cancelled, exit 130; no owned partial run."
    $run = "$cache\run"
    $active += Start-Provisioner @("--prepare-run", "--host", $hostDir, "--run-root", $run)
    $prepared = Complete-Provisioner $active[-1]
    if ($prepared.Exit -ne 0 -or -not (Test-Path "$run\.surface-run")) { throw "Shared CLI run-copy failed." }
    $hash = (Get-FileHash "$hostDir\Surface.pri").Hash
    if ($IncludeRenderer) {
        $smoke = "$root\vs-extension\SurfaceClient.Smoke\bin\x64\Debug\net472\SurfaceClient.Smoke.exe"
        if (-not (Test-Path $smoke)) { throw "Run vs-extension\Test-Migration.ps1 first." }
        $saved = @{}
        foreach ($name in @("WINUI_SURFACE_EXE", "WINUI_SURFACE_USER_PRI", "WINUI_GALLERY_PAGE", "SURFACE_GUARDS",
            "SURFACE_LIVE_MODE", "SURFACE_DTD_REFLECT", "SURFACE_RENDER_SETTLE")) {
            $saved[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
            [Environment]::SetEnvironmentVariable($name, $null, "Process")
        }
        try {
            $env:WINUI_SURFACE_EXE = "$run\Surface.exe"
            $env:WINUI_SURFACE_USER_PRI = "$run\Surface.designtime.pri"
            & $smoke
            if ($LASTEXITCODE -ne 0) { throw "Matched actual-user-PRI smoke failed." }
        } finally {
            foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], "Process") }
        }
    }
    if ((Get-FileHash "$hostDir\Surface.pri").Hash -ne $hash) { throw "Pristine cache PRI changed." }
    # Durable test evidence is part of this harness, not redirected console output.
    [IO.File]::WriteAllText("$cache\results.json", (@{ first = $a; second = $b; cancellation = $cancelled; prepareCancellation = $prepareCancelled; failed = $failed; degraded = $degraded;
        prepared = $prepared; pristinePriUnchanged = $true; rendererRequested = [bool]$IncludeRenderer } | ConvertTo-Json -Depth 10))
    Write-Host "Foundation evidence: $cache\results.json"
} finally {
    foreach ($invocation in $active) {
        if (-not $invocation.Process.HasExited) {
            $invocation.Process.Kill($true)
            $invocation.Process.WaitForExit()
        }
        $invocation.Process.Dispose()
    }
}
