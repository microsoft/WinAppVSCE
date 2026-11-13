import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const buildToolsFiles = [
  "AppxManifestSchema.xsd",
  "FoundationManifestSchema.xsd",
  "FoundationManifestSchema_v2.xsd",
  "UapManifestSchema.xsd",
  ...[2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13].map((version) => `UapManifestSchema_v${version}.xsd`),
];
const sdkCppFiles = [
  "AppxManifestTypes.xsd",
  "ComManifestSchema.xsd",
  "DesktopManifestSchema.xsd",
  "DesktopManifestSchema_v2.xsd",
  "DesktopManifestSchema_v3.xsd",
];
const scenarios = [
  { name: "cached schemas clear an inherited failure code", cached: true, inherited: 37, exit: 0 },
  { name: "successful restore reports success", exit: 0 },
  { name: "complete schemas survive a failed workspace restore with a warning", exit: 7 },
  { name: "npm-style Command invocation reports schema success", exit: 7, invocation: "command" },
  { name: "standalone File invocation reports schema success", exit: 7, invocation: "file" },
  { name: "failed restore with missing packages stays fatal", exit: 7, missingPackages: true, fails: /packages are missing/ },
  { name: "successful restore with missing packages stays fatal", exit: 0, missingPackages: true, fails: /packages are missing/ },
  { name: "partial restore with a missing XSD stays fatal", exit: 7, missingXsd: true, fails: /Schema sync is incomplete/ },
  { name: "cached packages with a missing XSD stay fatal", cached: true, exit: 0, missingXsd: true, fails: /Schema sync is incomplete/ },
];

for (const scenario of scenarios) {
  test(`schema sync: ${scenario.name}`, () => {
    const temp = mkdtempSync(path.join(tmpdir(), "winapp-schema-sync-"));
    try {
      const checkout = path.join(temp, "checkout");
      const profile = path.join(temp, "profile");
      const source = path.join(temp, "packages");
      mkdirSync(path.join(checkout, "scripts"), { recursive: true });
      mkdirSync(profile);
      copyFileSync(path.join(root, "scripts", "sync-schemas.ps1"), path.join(checkout, "scripts", "sync-schemas.ps1"));
      writeFileSync(path.join(checkout, "winapp.yaml"), [
        "packages:",
        "  - name: Microsoft.Windows.SDK.BuildTools",
        "    version: 1.0.0",
        "  - name: Microsoft.Windows.SDK.CPP",
        "    version: 1.0.0",
        "",
      ].join("\n"));
      for (const [directory, files] of [
        [path.join(source, "microsoft.windows.sdk.buildtools", "1.0.0", "schemas", "1.0", "winrt"), buildToolsFiles],
        [path.join(source, "microsoft.windows.sdk.cpp", "1.0.0", "c", "Include", "1.0", "winrt"), sdkCppFiles],
      ]) {
        mkdirSync(directory, { recursive: true });
        for (const file of files) {
          if (scenario.missingXsd && file === "DesktopManifestSchema_v3.xsd") continue;
          writeFileSync(path.join(directory, file), `<schema id="${file}" />`);
        }
      }
      const cli = path.join(temp, "restore.ps1");
      writeFileSync(cli, `
        Write-Output 'fixture restore diagnostic'
        ${scenario.missingPackages ? "" : `
          $cache = Join-Path $env:USERPROFILE '.nuget'
          New-Item -ItemType Directory -Path $cache -Force | Out-Null
          Copy-Item -LiteralPath $env:SCHEMA_TEST_PACKAGES -Destination $cache -Recurse -Force
        `}
        & (Get-Process -Id $PID).Path -NoProfile -Command 'exit ${scenario.exit}'
        exit $LASTEXITCODE
      `);
      const script = path.join(checkout, "scripts", "sync-schemas.ps1");
      const invoke = "& (Join-Path $env:SCHEMA_TEST_CHECKOUT 'scripts\\sync-schemas.ps1') -CliPath $env:SCHEMA_TEST_CLI";
      const invocation = scenario.invocation === "file"
        ? ["-File", script, "-CliPath", cli]
        : ["-Command", scenario.invocation === "command" ? invoke : `
        $ErrorActionPreference = 'Stop'
        ${scenario.cached ? `
          $cache = Join-Path $env:USERPROFILE '.nuget'
          New-Item -ItemType Directory -Path $cache -Force | Out-Null
          Copy-Item -LiteralPath $env:SCHEMA_TEST_PACKAGES -Destination $cache -Recurse -Force
        ` : ""}
        $global:LASTEXITCODE = ${scenario.inherited ?? 0}
        ${invoke}
        if ($LASTEXITCODE -ne 0) { throw "Caller observed schema sync failure: $LASTEXITCODE" }
        Write-Output 'Caller observed schema sync success'
      `];
      const result = spawnSync("pwsh", ["-NoProfile", ...invocation], {
        cwd: checkout,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          USERPROFILE: profile,
          SCHEMA_TEST_CHECKOUT: checkout,
          SCHEMA_TEST_PACKAGES: source,
          SCHEMA_TEST_CLI: cli,
        },
      });
      const output = result.stdout + result.stderr;
      assert.ifError(result.error);
      if (scenario.fails) {
        assert.notEqual(result.status, 0, output);
        assert.match(output, scenario.fails);
        assert.doesNotMatch(output, /Synced \d+ XSD|Caller observed schema sync success/);
      } else {
        assert.equal(result.status, 0, output);
        assert.match(output, /Synced 20 XSD/);
        if (!scenario.invocation) assert.match(output, /Caller observed schema sync success/);
        const schemas = path.join(checkout, "schemas");
        assert.deepEqual(readdirSync(schemas).sort(), [...buildToolsFiles, ...sdkCppFiles].sort());
        for (const file of [...buildToolsFiles, ...sdkCppFiles]) {
          assert.equal(readFileSync(path.join(schemas, file), "utf8"), `<schema id="${file}" />`);
        }
      }
      if (!scenario.cached && scenario.exit !== 0) {
        assert.match(output, /WARNING:.*winapp restore.*7/);
        assert.match(output, /fixture restore diagnostic/);
      }
      if (scenario.cached) assert.doesNotMatch(output, /Downloading SDK|fixture restore diagnostic/);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
}
