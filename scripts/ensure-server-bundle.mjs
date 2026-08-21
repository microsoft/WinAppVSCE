// Artifact mode must never fall back to an unsigned local build.

import { existsSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(
  root,
  process.env.WINUI_XAML_SERVER_OUTPUT ?? path.join("dist", "server")
);
const bundleMode = process.env.WINUI_XAML_SERVER_BUNDLE_MODE ?? "source";

if (!["source", "artifact"].includes(bundleMode)) {
  console.error(
    `[ensure-server-bundle] Unsupported WINUI_XAML_SERVER_BUNDLE_MODE '${bundleMode}'. ` +
      "Expected 'source' or 'artifact'."
  );
  process.exit(1);
}

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
const forbiddenFileNames = new Set([
  "WinUiXaml.LanguageServer.exe",
  "hostfxr.dll",
  "hostpolicy.dll",
  "coreclr.dll",
  "clrjit.dll",
  "System.Private.CoreLib.dll",
  "dotnet.exe",
  "dotnet.dll",
  "dotnet.deps.json",
  "dotnet.runtimeconfig.json",
].map((name) => name.toLowerCase()));

function isForbiddenFileName(name) {
  return forbiddenFileNames.has(name.toLowerCase()) ||
    /^WinUiXaml\..*\.exe$/i.test(name);
}

function findForbiddenFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return findForbiddenFiles(entryPath);
    }
    return isForbiddenFileName(entry.name) ? [entryPath] : [];
  });
}

function validateBundle(source) {
  const missing = requiredRelativeFiles
    .map((relativeFile) => path.join(outDir, relativeFile))
    .filter((file) => !existsSync(file));
  if (missing.length > 0) {
    console.error(
      `[ensure-server-bundle] ${source} is incomplete. Missing:\n` +
        missing.map((file) => `  - ${path.relative(root, file)}`).join("\n")
    );
    process.exit(1);
  }

  const bundledRuntimeFiles = findForbiddenFiles(outDir);
  if (bundledRuntimeFiles.length > 0) {
    console.error(
      `[ensure-server-bundle] ${source} contains forbidden apphost/runtime files:\n` +
        bundledRuntimeFiles.map((file) => `  - ${path.relative(root, file)}`).join("\n")
    );
    process.exit(1);
  }
}

if (bundleMode === "artifact") {
  validateBundle("Signed server artifact");
  console.log(
    `[ensure-server-bundle] Reusing signed framework-dependent server artifact in ${path.relative(root, outDir)}.`
  );
  process.exit(0);
}

console.log(
  `[ensure-server-bundle] Publishing framework-dependent WinUI XAML language server to ${path.relative(root, outDir)}...`
);
const csproj = path.join(
  root,
  "server",
  "src",
  "WinUiXaml.LanguageServer",
  "WinUiXaml.LanguageServer.csproj"
);
rmSync(outDir, { recursive: true, force: true });

const result = spawnSync(
  "dotnet",
  [
    "publish",
    csproj,
    "-c",
    "Release",
    "--self-contained",
    "false",
    "-p:UseAppHost=false",
    "-o",
    outDir,
  ],
  { stdio: "inherit", cwd: root, shell: false }
);

if (result.error?.code === "ENOENT") {
  console.error(
    "[ensure-server-bundle] The .NET 10 SDK ('dotnet') was not found. It is required to build the server."
  );
  process.exit(1);
}
if (result.status !== 0) {
  console.error("[ensure-server-bundle] dotnet publish failed.");
  process.exit(result.status ?? 1);
}

validateBundle("Local publish");
console.log("[ensure-server-bundle] Framework-dependent language server published to dist/server.");
