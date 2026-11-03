import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ensureScript = path.join(root, "scripts", "ensure-server-bundle.mjs");
const downloadScript = path.join(root, "scripts", "download-server.ps1");
const validateVsixScript = path.join(root, "scripts", "validate-vsix-server.ps1");
// The bundle ships one Native AOT executable per architecture plus the shared, framework-dependent
// generator host.
const requiredRelativeFiles = [
  path.join("win-x64", "WinUiXaml.LanguageServer.exe"),
  path.join("win-arm64", "WinUiXaml.LanguageServer.exe"),
  path.join("generator-host", "WinUiXaml.GeneratorHost.dll"),
  path.join("generator-host", "WinUiXaml.GeneratorHost.deps.json"),
  path.join("generator-host", "WinUiXaml.GeneratorHost.runtimeconfig.json"),
];

function createServer(directory) {
  for (const relativeFile of requiredRelativeFiles) {
    const file = path.join(directory, relativeFile);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "");
  }
}

function runEnsure(output, mode) {
  return spawnSync(process.execPath, [ensureScript], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      WINUI_XAML_SERVER_OUTPUT: output,
      WINUI_XAML_SERVER_BUNDLE_MODE: mode,
    },
  });
}

function createSyntheticVsix(temp, configure = () => {}) {
  const content = path.join(temp, "content");
  const server = path.join(content, "extension", "dist", "server");
  createServer(server);
  configure(server);
  const vsix = path.join(temp, "synthetic.zip");
  const result = spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${content.replaceAll("'", "''")}\\*' -DestinationPath '${vsix.replaceAll("'", "''")}' -Force`,
    ],
    { cwd: root, encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return vsix;
}

function validateVsix(vsix) {
  return spawnSync(
    "pwsh",
    ["-NoProfile", "-File", validateVsixScript, "-VsixPath", vsix],
    { cwd: root, encoding: "utf8" }
  );
}

test("release build jobs configure and authenticate NuGet before restoring packages", () => {
  const pipeline = readFileSync(path.join(root, ".pipelines", "release-vsc.yml"), "utf8");
  for (const jobName of ["BuildServer", "Build"]) {
    const job = pipeline.split(`      - job: ${jobName}\n`)[1]?.split(/^    - stage:/m)[0];
    assert.ok(job, `Missing ${jobName} release job`);
    const setup = job.indexOf("- template: /.pipelines/templates/nuget-feed.yml@self");
    assert.ok(setup >= 0, `${jobName} must use a repository-rooted @self NuGet template reference`);
    const restore = job.indexOf("dotnet restore ");
    assert.ok(setup >= 0 && setup < restore, `${jobName} must configure NuGet before restoring`);
  }
  const template = readFileSync(path.join(root, ".pipelines", "templates", "nuget-feed.yml"), "utf8");
  assert.ok(template.indexOf("Copy-Item") < template.indexOf("- task: NuGetAuthenticate@1"));
  assert.match(template, /errorActionPreference: stop/);
});

test("release NuGet setup replaces repository and user sources with the approved feed", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "winui-nuget-"));
  try {
    const checkout = path.join(temp, "checkout");
    const appData = path.join(temp, "appdata");
    mkdirSync(path.join(checkout, ".pipelines"), { recursive: true });
    mkdirSync(path.join(appData, "NuGet"), { recursive: true });
    const config = readFileSync(path.join(root, ".pipelines", "release-nuget.config"), "utf8");
    writeFileSync(path.join(checkout, ".pipelines", "release-nuget.config"), config);
    const oldConfig = '<configuration><packageSources><add key="old" value="https://obsolete.invalid/v3/index.json" /></packageSources></configuration>';
    writeFileSync(path.join(checkout, "nuget.config"), oldConfig);
    writeFileSync(path.join(appData, "NuGet", "NuGet.Config"), oldConfig);
    const template = readFileSync(path.join(root, ".pipelines", "templates", "nuget-feed.yml"), "utf8");
    const inline = template.match(/      script: \|\r?\n((?:        .*\r?\n)+)/)?.[1];
    assert.ok(inline, "Missing NuGet setup script");
    const script = inline.replace(/^        /gm, "").replaceAll("$(Build.SourcesDirectory)", "$env:RELEASE_TEST_CHECKOUT");
    const result = spawnSync("pwsh", ["-NoProfile", "-Command", `
      $ErrorActionPreference = 'Stop'
      ${script}
      [xml]$config = Get-Content -LiteralPath (Join-Path $env:RELEASE_TEST_CHECKOUT 'nuget.config') -Raw
      $sources = $config.configuration.packageSources
      if ($sources.ChildNodes[0].Name -ne 'clear') { throw 'Inherited sources were not cleared' }
      if (@($sources.add).Count -ne 1) { throw 'Expected exactly one package source' }
      if ($sources.add.key -ne 'pde-oss_Internal') { throw 'Unexpected feed name' }
      if ($sources.add.value -ne 'https://pkgs.dev.azure.com/microsoft/pde-oss/_packaging/pde-oss_Internal/nuget/v3/index.json') { throw 'Unexpected feed URL' }
      if ($null -eq $config.configuration.disabledPackageSources.clear) { throw 'Inherited disabled sources were not cleared' }
    `], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, APPDATA: appData, RELEASE_TEST_CHECKOUT: checkout },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(readFileSync(path.join(checkout, "nuget.config"), "utf8"), config);
    assert.equal(readFileSync(path.join(appData, "NuGet", "NuGet.Config"), "utf8"), config);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("release signing patterns select every first-party server binary", () => {
  const pipeline = readFileSync(path.join(root, ".pipelines", "release-vsc.yml"), "utf8");
  const signing = pipeline
    .split("displayName: Code Sign ESRP - WinUI XAML language server\n")[1]
    ?.split("            - task:")[0];
  assert.ok(signing, "Missing server signing task");
  assert.match(signing, /UseMinimatch: true/);
  const patternBlock = signing.match(/^                Pattern: \|\r?\n((?:                  .+\r?\n)+)/m)?.[1];
  assert.ok(patternBlock, "ESRP minimatch patterns must be newline-separated");
  const patterns = patternBlock.trim().split(/\r?\n/).map((pattern) => pattern.trim());
  const binaries = requiredRelativeFiles
    .filter((file) => /\.(dll|exe)$/.test(file))
    .map((file) => file.replaceAll(path.sep, "/"));
  const bundleFiles = [
    ...requiredRelativeFiles.map((file) => file.replaceAll(path.sep, "/")),
    "generator-host/Microsoft.CodeAnalysis.dll",
    "generator-host/Microsoft.CodeAnalysis.CSharp.dll",
  ];
  const selected = bundleFiles.filter((file) =>
    patterns.some((pattern) => path.posix.matchesGlob(file, pattern))
  );
  assert.deepEqual(selected.sort(), binaries.sort());
});

for (const scenario of [
  { name: "installs through the CLI into the E2E extensions directory", exitCode: 0 },
  { name: "reports the installer diagnostic and exit code", exitCode: 19 },
  { name: "rejects a missing CLI instead of invoking the GUI", missingCli: true },
]) {
  test(`release VSIX installation ${scenario.name}`, { skip: process.platform !== "win32" }, () => {
    const temp = realpathSync.native(mkdtempSync(path.join(tmpdir(), "winapp-vsix-install-")));
    try {
      const agentTemp = path.join(temp, "agent temp");
      const checkout = path.join(temp, "checkout");
      const codePath = path.join(agentTemp, "vscode", "Code.exe");
      const cliArgs = path.join(temp, "cli-args.txt");
      const vsixPath = path.join(checkout, "artifacts", "winapp-0.4.0.vsix");
      mkdirSync(path.join(agentTemp, "vscode", "bin"), { recursive: true });
      mkdirSync(path.dirname(vsixPath), { recursive: true });
      writeFileSync(codePath, "");
      writeFileSync(vsixPath, "");
      if (!scenario.missingCli) {
        writeFileSync(path.join(agentTemp, "vscode", "bin", "code.cmd"), [
          "@echo off",
          "echo fixture installer diagnostic",
          'echo %* > "%RELEASE_TEST_CLI_ARGS%"',
          `exit /b ${scenario.exitCode}`,
          "",
        ].join("\r\n"));
      }
      const pipeline = readFileSync(path.join(root, ".pipelines", "release-vsc.yml"), "utf8");
      const e2eStep = pipeline.split("displayName: Run E2E tests\n")[1]?.split("          - task:")[0];
      const install = e2eStep?.match(/                \$codePath = Join-Path[\s\S]+?(?=                # The 'vscode' project)/)?.[0];
      assert.ok(install, "Missing release VSIX install script");
      const script = install.replace(/^                /gm, "")
        .replaceAll("$(Agent.TempDirectory)", "$env:RELEASE_TEST_AGENT_TEMP")
        .replaceAll("$(System.DefaultWorkingDirectory)", "$env:RELEASE_TEST_CHECKOUT");
      const result = spawnSync("pwsh", ["-NoProfile", "-Command", `
        $ErrorActionPreference = 'Stop'
        $global:LASTEXITCODE = 37
        $vscodeDir = Join-Path $env:RELEASE_TEST_AGENT_TEMP 'vscode'
        ${script}
        if ($env:VSCODE_PATH -ne (Join-Path $env:RELEASE_TEST_AGENT_TEMP 'vscode\\Code.exe')) { throw 'E2E must launch Code.exe' }
        if ($env:E2E_USE_INSTALLED_EXTENSION -ne '1') { throw 'E2E must use the installed VSIX' }
        if ([IO.Path]::GetFullPath($env:E2E_EXTENSIONS_DIR) -ne (Join-Path $env:RELEASE_TEST_AGENT_TEMP 'vscode-extensions')) { throw 'E2E extension directory mismatch' }
        Write-Host 'Ready to run E2E tests'
      `], {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          RELEASE_TEST_AGENT_TEMP: agentTemp,
          RELEASE_TEST_CHECKOUT: checkout,
          RELEASE_TEST_CLI_ARGS: cliArgs,
        },
      });
      assert.ifError(result.error);
      const output = result.stdout + result.stderr;
      if (scenario.missingCli) {
        assert.notEqual(result.status, 0, output);
        assert.match(output, /Downloaded VS Code CLI not found/);
      } else {
        assert.match(output, /fixture installer diagnostic/);
        const args = readFileSync(cliArgs, "utf8").replaceAll('"', "").replaceAll("/", "\\");
        assert.ok(args.includes(`--user-data-dir ${path.join(agentTemp, "vscode-install-profile")}`), args);
        assert.ok(args.includes(`--extensions-dir ${path.join(agentTemp, "vscode-extensions")}`), args);
        assert.ok(args.includes(`--install-extension ${vsixPath} --force`), args);
        if (scenario.exitCode === 0) {
          assert.equal(result.status, 0, output);
          assert.match(output, /Ready to run E2E tests/);
        } else {
          assert.notEqual(result.status, 0, output);
          assert.match(output, /Failed to install packaged VSIX.*exit code 19/);
        }
      }
      if (scenario.missingCli || scenario.exitCode !== 0) {
        assert.doesNotMatch(output, /Ready to run E2E tests/);
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
}

test("ensure-server-bundle rejects an unknown mode", () => {
  const output = mkdtempSync(path.join(tmpdir(), "winui-ensure-"));
  try {
    const result = runEnsure(output, "unexpected");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsupported.*mode/i);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("artifact mode accepts one framework-dependent server", () => {
  const output = mkdtempSync(path.join(tmpdir(), "winui-ensure-"));
  try {
    createServer(output);
    const result = runEnsure(output, "artifact");
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("artifact mode rejects bundled runtime files", () => {
  const output = mkdtempSync(path.join(tmpdir(), "winui-ensure-"));
  try {
    createServer(output);
    writeFileSync(path.join(output, "hostfxr.dll"), "");
    const result = runEnsure(output, "artifact");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /forbidden.*runtime/i);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("artifact mode rejects nested legacy runtime files", () => {
  const output = mkdtempSync(path.join(tmpdir(), "winui-ensure-"));
  try {
    createServer(output);
    mkdirSync(path.join(output, "win-x64"), { recursive: true });
    writeFileSync(path.join(output, "win-x64", "hostfxr.dll"), "");
    const result = runEnsure(output, "artifact");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /forbidden.*runtime/i);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("artifact mode rejects removed XAML apphosts", () => {
  const output = mkdtempSync(path.join(tmpdir(), "winui-ensure-"));
  try {
    createServer(output);
    mkdirSync(path.join(output, "legacy"), { recursive: true });
    writeFileSync(path.join(output, "legacy", "WinUiXaml.DotnetHost.exe"), "");
    const result = runEnsure(output, "artifact");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /forbidden.*runtime/i);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("artifact mode rejects removed runtime metadata", () => {
  const output = mkdtempSync(path.join(tmpdir(), "winui-ensure-"));
  try {
    createServer(output);
    mkdirSync(path.join(output, "legacy"), { recursive: true });
    writeFileSync(path.join(output, "legacy", "dotnet.runtimeconfig.json"), "");
    const result = runEnsure(output, "artifact");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /forbidden.*runtime/i);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("download-server installs and validates a downloaded artifact directory", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "winui-download-"));
  const artifact = path.join(temp, "artifact");
  const destination = path.join(temp, "installed");
  try {
    createServer(artifact);
    const result = spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-File",
        downloadScript,
        "-ArtifactPath",
        artifact,
        "-DestinationPath",
        destination,
      ],
      { cwd: root, encoding: "utf8" }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("download-server rejects an incomplete artifact directory", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "winui-download-"));
  const artifact = path.join(temp, "artifact");
  const destination = path.join(temp, "installed");
  try {
    mkdirSync(artifact, { recursive: true });
    writeFileSync(path.join(artifact, "WinUiXaml.LanguageServer.dll"), "");
    const result = spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-File",
        downloadScript,
        "-ArtifactPath",
        artifact,
        "-DestinationPath",
        destination,
      ],
      { cwd: root, encoding: "utf8" }
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /incomplete/i);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("VSIX validator accepts a flat framework-dependent server", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "winui-vsix-"));
  try {
    const result = validateVsix(createSyntheticVsix(temp));
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("VSIX validator rejects a missing required server file", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "winui-vsix-"));
  try {
    const vsix = createSyntheticVsix(temp, (server) =>
      rmSync(path.join(server, "win-arm64", "WinUiXaml.LanguageServer.exe"))
    );
    const result = validateVsix(vsix);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing required server file/i);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("VSIX validator rejects a bundled runtime or apphost", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "winui-vsix-"));
  try {
    const vsix = createSyntheticVsix(temp, (server) =>
      writeFileSync(path.join(server, "hostfxr.dll"), "")
    );
    const result = validateVsix(vsix);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not bundle/i);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("VSIX validator rejects a nested legacy runtime payload", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "winui-vsix-"));
  try {
    const vsix = createSyntheticVsix(temp, (server) => {
      mkdirSync(path.join(server, "win-x64"), { recursive: true });
      writeFileSync(path.join(server, "win-x64", "hostfxr.dll"), "");
    });
    const result = validateVsix(vsix);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not bundle/i);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("VSIX validator rejects removed XAML apphosts", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "winui-vsix-"));
  try {
    const vsix = createSyntheticVsix(temp, (server) => {
      mkdirSync(path.join(server, "legacy"), { recursive: true });
      writeFileSync(path.join(server, "legacy", "WinUiXaml.DotnetHost.exe"), "");
    });
    const result = validateVsix(vsix);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not bundle/i);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("VSIX validator rejects removed runtime metadata", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "winui-vsix-"));
  try {
    const vsix = createSyntheticVsix(temp, (server) => {
      mkdirSync(path.join(server, "legacy"), { recursive: true });
      writeFileSync(path.join(server, "legacy", "dotnet.runtimeconfig.json"), "");
    });
    const result = validateVsix(vsix);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not bundle/i);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
