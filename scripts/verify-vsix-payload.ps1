<#
.SYNOPSIS
    Verifies that every CLI payload file in bin\ survived VSIX packaging.

.DESCRIPTION
    The DevTools engine is the first winapp feature that is not self-contained
    in winapp.exe: it needs sidecar native libraries and a schema file next to
    the executable. An over-eager .vscodeignore rule once shipped winapp.exe
    without them, which passed every build check and then failed at runtime in
    the user's install with a misleading "reinstall winapp" error.

    This check closes that gap by diffing the bin\ tree on disk against the
    bin\ entries actually inside the packaged VSIX, so a dropped payload file
    fails the build instead of reaching users. Debug symbols are excluded
    deliberately — they are hundreds of megabytes and nothing loads them at
    runtime.

.PARAMETER VsixPath
    Path to the packaged .vsix file.

.PARAMETER BinPath
    Path to the bin directory whose contents were bundled.
#>
param(
    [Parameter(Mandatory = $true)][string]$VsixPath,
    [Parameter(Mandatory = $true)][string]$BinPath
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $VsixPath)) {
    Write-Error "VSIX not found: $VsixPath"
    exit 1
}
if (-not (Test-Path $BinPath)) {
    Write-Error "bin directory not found: $BinPath"
    exit 1
}

# Files expected to ship: everything under bin\ except debug symbols.
$expected = Get-ChildItem -Path $BinPath -Recurse -File |
    Where-Object { $_.Extension -ne '.pdb' } |
    ForEach-Object { [System.IO.Path]::GetRelativePath($BinPath, $_.FullName).Replace('\', '/') } |
    Sort-Object

if ($expected.Count -eq 0) {
    Write-Error "No CLI payload found under $BinPath. Run 'npm run download-cli' before packaging."
    exit 1
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path $VsixPath))
try {
    # VSIX entries are rooted at "extension/".
    $actual = $archive.Entries |
        Where-Object { $_.FullName -like 'extension/bin/*' -and -not $_.FullName.EndsWith('/') } |
        ForEach-Object { $_.FullName.Substring('extension/bin/'.Length) } |
        Sort-Object
} finally {
    $archive.Dispose()
}

$missing = $expected | Where-Object { $actual -notcontains $_ }

if ($missing.Count -gt 0) {
    Write-Host ""
    Write-Host "[FAIL] The VSIX is missing $($missing.Count) CLI payload file(s):" -ForegroundColor Red
    $missing | ForEach-Object { Write-Host "         bin/$_" -ForegroundColor Red }
    Write-Host ""
    Write-Host "       These files exist in '$BinPath' but were excluded from the package." -ForegroundColor Yellow
    Write-Host "       Check .vscodeignore — an exclusion rule is dropping part of the CLI payload." -ForegroundColor Yellow
    exit 1
}

$symbols = $actual | Where-Object { $_.EndsWith('.pdb') }
if ($symbols.Count -gt 0) {
    Write-Host "[WARN] The VSIX contains $($symbols.Count) .pdb file(s); these bloat the package and are not needed at runtime." -ForegroundColor Yellow
}

Write-Host "[OK] VSIX payload verified: $($expected.Count) CLI file(s) present." -ForegroundColor Green
exit 0
