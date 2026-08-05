// Local packaging publishes fresh self-contained servers. Release packaging sets artifact mode after
// downloading the signed server pipeline artifact into dist/server; artifact mode never falls back to
// an unsigned local build.

import { existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(
  root,
  process.env.WINUI_XAML_SERVER_OUTPUT ?? path.join("dist", "server")
);
const bundleMode = process.env.WINUI_XAML_SERVER_BUNDLE_MODE ?? "source";
const runtimes = ["win-x64", "win-arm64"];

if (!["source", "artifact"].includes(bundleMode)) {
  console.error(
    `[ensure-server-bundle] Unsupported WINUI_XAML_SERVER_BUNDLE_MODE '${bundleMode}'. ` +
      "Expected 'source' or 'artifact'."
  );
  process.exit(1);
}

const requiredRelativeFiles = [
  "WinUiXaml.LanguageServer.exe",
  "WinUiXaml.LanguageServer.dll",
  "WinUiXaml.LanguageServer.deps.json",
  "WinUiXaml.LanguageServer.runtimeconfig.json",
  "WinUiXaml.Workspace.dll",
  "WinUiXaml.Xaml.dll",
  "hostfxr.dll",
  "hostpolicy.dll",
  "coreclr.dll",
  "clrjit.dll",
  "System.Private.CoreLib.dll",
  "dotnet.exe",
  "dotnet.dll",
  "dotnet.deps.json",
  "dotnet.runtimeconfig.json",
  path.join("BuildHost-netcore", "Microsoft.CodeAnalysis.Workspaces.MSBuild.BuildHost.dll"),
  path.join("BuildHost-netcore", "Microsoft.CodeAnalysis.Workspaces.MSBuild.BuildHost.deps.json"),
  path.join("BuildHost-netcore", "Microsoft.CodeAnalysis.Workspaces.MSBuild.BuildHost.runtimeconfig.json"),
];

function validateBundle(source) {
  const missing = runtimes.flatMap((rid) =>
    requiredRelativeFiles
      .map((relativeFile) => path.join(outDir, rid, relativeFile))
      .filter((file) => !existsSync(file))
  );
  if (missing.length > 0) {
    console.error(
      `[ensure-server-bundle] ${source} is incomplete. Missing:\n` +
        missing.map((file) => `  - ${path.relative(root, file)}`).join("\n")
    );
    process.exit(1);
  }
}

if (bundleMode === "artifact") {
  validateBundle("Signed server artifact");
  console.log(
    `[ensure-server-bundle] Reusing signed self-contained server artifact in ${path.relative(root, outDir)}.`
  );
  process.exit(0);
}

console.log(
  `[ensure-server-bundle] Publishing self-contained WinUI XAML language servers to ${path.relative(root, outDir)}...`
);
const csproj = path.join(
  root,
  "server",
  "src",
  "WinUiXaml.LanguageServer",
  "WinUiXaml.LanguageServer.csproj"
);
const dotnetHostCsproj = path.join(
  root,
  "server",
  "src",
  "WinUiXaml.DotnetHost",
  "WinUiXaml.DotnetHost.csproj"
);
rmSync(outDir, { recursive: true, force: true });

for (const rid of runtimes) {
  const ridOutDir = path.join(outDir, rid);
  const result = spawnSync(
    "dotnet",
    [
      "publish",
      csproj,
      "-c",
      "Release",
      "-r",
      rid,
      "--self-contained",
      "true",
      "-o",
      ridOutDir,
    ],
    { stdio: "inherit", cwd: root, shell: false }
  );

  if (result.error?.code === "ENOENT") {
    console.error(
      "[ensure-server-bundle] The .NET 10 SDK ('dotnet') was not found. It is required to " +
        "build the server locally; users of the packaged extension do not need .NET."
    );
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[ensure-server-bundle] dotnet publish failed for ${rid}.`);
    process.exit(result.status ?? 1);
  }

  const hostResult = spawnSync(
    "dotnet",
    [
      "publish",
      dotnetHostCsproj,
      "-c",
      "Release",
      "-r",
      rid,
      "--self-contained",
      "true",
      "-o",
      ridOutDir,
    ],
    { stdio: "inherit", cwd: root, shell: false }
  );
  if (hostResult.status !== 0) {
    console.error(`[ensure-server-bundle] dotnet host publish failed for ${rid}.`);
    process.exit(hostResult.status ?? 1);
  }
}

validateBundle("Local publish");
console.log("[ensure-server-bundle] Self-contained language servers published to dist/server.");
