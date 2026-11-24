import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('release staging keeps CLI sidecars and verifies against the original source', () => {
    const temp = mkdtempSync(path.join(tmpdir(), 'winapp-payload-'));
    try {
        for (const arch of ['win-x64', 'win-arm64']) {
            const dir = path.join(temp, 'source', arch);
            mkdirSync(dir, { recursive: true });
            for (const file of ['winapp.exe', 'WinApp.DevTools.Native.dll', 'winapp-devtools-schema.json', 'debug.pdb']) {
                writeFileSync(path.join(dir, file), 'fixture');
            }
        }
        const result = spawnSync('pwsh', ['-NoProfile', '-Command', `
            $CliBinariesPath=Join-Path $env:CLI_TEST_DIR 'source'
            $VscBinPath=Join-Path $env:CLI_TEST_DIR 'staged'
            New-Item -ItemType Directory -Force "$VscBinPath\\win-x64","$VscBinPath\\win-arm64" | Out-Null
            $ast=[System.Management.Automation.Language.Parser]::ParseFile($env:CLI_PACKAGE_SCRIPT,[ref]$null,[ref]$null)
            $copies=$ast.FindAll({param($n) $n -is [System.Management.Automation.Language.CommandAst] -and
                $n.GetCommandName() -eq 'Copy-Item' -and $n.Extent.Text.Contains('$CliBinariesPath')},$true)
            if($copies.Count -ne 2){throw 'Expected architecture staging commands'}
            foreach($copy in $copies){& ([scriptblock]::Create($copy.Extent.Text))}
            Get-ChildItem $VscBinPath -Recurse -File | ForEach-Object {$_.Name} | ConvertTo-Json
        `], { encoding: 'utf8', env: { ...process.env, CLI_TEST_DIR: temp,
            CLI_PACKAGE_SCRIPT: path.join(root, 'scripts', 'package-vsc.ps1') } });
        assert.equal(result.status, 0, result.stderr);
        const files = JSON.parse(result.stdout);
        assert.equal(files.filter(name => name.endsWith('.dll')).length, 2);
        assert.equal(files.filter(name => name.endsWith('.json')).length, 2);
        assert.ok(!files.includes('debug.pdb'));
        assert.match(readFileSync(path.join(root, 'scripts', 'package-vsc.ps1'), 'utf8'),
            /& \$VerifyScript -VsixPath \$CreatedVsix.FullName -BinPath \$CliBinariesPath/);
    } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('the download pin and DevTools schema provenance identify the same immutable main build', () => {
    const pin = JSON.parse(readFileSync(path.join(root, 'cli-version.json'), 'utf8')).ciBuild;
    const schema = JSON.parse(readFileSync(path.join(root, 'schemas', 'devtools', 'pinned-cli.json'), 'utf8'));
    assert.equal(pin.commit, schema.commit);
    assert.equal(pin.runId, schema.runId);
    assert.equal(schema.branch, 'main');
    assert.match(pin.commit, /^[a-f0-9]{40}$/);
    assert.match(pin.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(pin.artifactId));
});
