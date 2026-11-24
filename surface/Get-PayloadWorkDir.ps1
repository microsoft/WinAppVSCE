#requires -Version 5.1
# Where Build-Payload.ps1 builds the surface. The nested PreviewHost/PRI build paths are ~135 characters deep,
# so building under the repo would pass MAX_PATH (260) for repos checked out deeper than ~125 characters
# (PRI175/PRI222/APPX0002). A short per-checkout folder under %TEMP% keeps it independent of checkout depth.
$sha = [Security.Cryptography.SHA256]::Create()
try {
    $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(
        $PSScriptRoot.ToLowerInvariant()))).Replace('-', '').Substring(0, 8).ToLowerInvariant()
} finally { $sha.Dispose() }
Join-Path ([IO.Path]::GetTempPath()) "wxp\$hash"
