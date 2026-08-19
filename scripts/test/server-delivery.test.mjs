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
const requiredRelativeFiles = [
  "WinUiXaml.LanguageServer.exe",
  "WinUiXaml.Workspace.dll",
  "WinUiXaml.Xaml.dll",
  "hostfxr.dll",
  "hostpolicy.dll",
  "coreclr.dll",
  "clrjit.dll",
  "System.Private.CoreLib.dll",
  "WinUiXaml.LanguageServer.dll",
  "WinUiXaml.LanguageServer.deps.json",
  "WinUiXaml.LanguageServer.runtimeconfig.json",
  "dotnet.exe",
  "dotnet.dll",
  "dotnet.deps.json",
  "dotnet.runtimeconfig.json",
  path.join("BuildHost-netcore", "Microsoft.CodeAnalysis.Workspaces.MSBuild.BuildHost.dll"),
  path.join("BuildHost-netcore", "Microsoft.CodeAnalysis.Workspaces.MSBuild.BuildHost.deps.json"),
  path.join("BuildHost-netcore", "Microsoft.CodeAnalysis.Workspaces.MSBuild.BuildHost.runtimeconfig.json"),
];

function createRuntime(directory, rid) {
  for (const relativeFile of requiredRelativeFiles) {
    const file = path.join(directory, rid, relativeFile);
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

test("artifact mode fails closed when either runtime is missing", () => {
  const output = mkdtempSync(path.join(tmpdir(), "winui-ensure-"));
  try {
    createRuntime(output, "win-x64");

    const result = runEnsure(output, "artifact");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /win-arm64.*WinUiXaml\.LanguageServer\.exe/i);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("download-server installs and validates a downloaded artifact directory", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "winui-download-"));
  const artifact = path.join(temp, "artifact");
  const destination = path.join(temp, "installed");
  try {
    for (const rid of ["win-x64", "win-arm64"]) {
      createRuntime(artifact, rid);
    }

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
    createRuntime(artifact, "win-x64");

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
