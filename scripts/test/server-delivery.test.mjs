import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ensureScript = path.join(root, "scripts", "ensure-server-bundle.mjs");
const downloadScript = path.join(root, "scripts", "download-server.ps1");
const validateVsixScript = path.join(root, "scripts", "validate-vsix-server.ps1");
const requiredRelativeFiles = [
  "WinUiXaml.LanguageServer.dll",
  "WinUiXaml.LanguageServer.deps.json",
  "WinUiXaml.LanguageServer.runtimeconfig.json",
  "WinUiXaml.Workspace.dll",
  "WinUiXaml.Xaml.dll",
  path.join("BuildHost-netcore", "Microsoft.CodeAnalysis.Workspaces.MSBuild.BuildHost.dll"),
  path.join("BuildHost-netcore", "Microsoft.CodeAnalysis.Workspaces.MSBuild.BuildHost.deps.json"),
  path.join("BuildHost-netcore", "Microsoft.CodeAnalysis.Workspaces.MSBuild.BuildHost.runtimeconfig.json"),
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
      rmSync(path.join(server, "WinUiXaml.Workspace.dll"))
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
