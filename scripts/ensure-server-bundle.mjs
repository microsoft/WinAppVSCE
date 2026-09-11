// Artifact mode must never fall back to an unsigned local build.

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
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

// The server is published as a Native AOT executable, so it is architecture-specific and the
// VSIX carries one per architecture -- exactly like the winapp CLI in bin/win-<arch>/. The
// extension picks the matching folder at launch.
const SUPPORTED_RIDS = ["win-x64", "win-arm64"];
const hostRid = process.arch === "arm64" ? "win-arm64" : "win-x64";
const rids = (process.env.WINUI_XAML_SERVER_RIDS ?? SUPPORTED_RIDS.join(","))
  .split(",")
  .map((rid) => rid.trim())
  .filter(Boolean);

const unsupported = rids.filter((rid) => !SUPPORTED_RIDS.includes(rid));
if (unsupported.length > 0) {
  console.error(
    `[ensure-server-bundle] Unsupported runtime identifier(s): ${unsupported.join(", ")}. ` +
      `Expected any of: ${SUPPORTED_RIDS.join(", ")}.`
  );
  process.exit(1);
}

const GENERATOR_HOST_DIR = "generator-host";

// The generator host is the one framework-dependent piece: source generators are analyzer
// assemblies loaded with Assembly.LoadFrom, which Native AOT cannot do. It is architecture
// neutral, so a single copy is shared by both server binaries.
// In artifact mode the bundle must be complete for every shipping architecture. In source mode
// only what was asked for is required, so a developer can build just their own architecture.
const requiredRids = bundleMode === "artifact" ? SUPPORTED_RIDS : rids;
const requiredRelativeFiles = [
  ...requiredRids.map((rid) => path.join(rid, "WinUiXaml.LanguageServer.exe")),
  path.join(GENERATOR_HOST_DIR, "WinUiXaml.GeneratorHost.dll"),
  path.join(GENERATOR_HOST_DIR, "WinUiXaml.GeneratorHost.deps.json"),
  path.join(GENERATOR_HOST_DIR, "WinUiXaml.GeneratorHost.runtimeconfig.json"),
];

// A Native AOT publish emits a single self-contained executable, so none of these may appear.
// Their presence means the server was silently published as a CoreCLR app instead, reintroducing
// the runtime dependency the AOT server exists to remove.
const alwaysForbiddenFileNames = new Set(
  [
    "hostfxr.dll",
    "hostpolicy.dll",
    "coreclr.dll",
    "clrjit.dll",
    "System.Private.CoreLib.dll",
    "dotnet.exe",
    "dotnet.dll",
    "dotnet.deps.json",
    "dotnet.runtimeconfig.json",
  ].map((name) => name.toLowerCase())
);

// The managed form of the server itself. Allowed nowhere: the shipped server must be native.
const managedServerFileNames = new Set(
  [
    "WinUiXaml.LanguageServer.dll",
    "WinUiXaml.LanguageServer.deps.json",
    "WinUiXaml.LanguageServer.runtimeconfig.json",
  ].map((name) => name.toLowerCase())
);

function isForbiddenFileName(name, directory) {
  const lower = name.toLowerCase();
  if (alwaysForbiddenFileNames.has(lower) || managedServerFileNames.has(lower)) {
    return true;
  }
  // The server executable is the one WinUiXaml apphost that is expected; any other is a leftover
  // launcher that must not ship.
  return /^WinUiXaml\..*\.exe$/i.test(name) && lower !== "winuixaml.languageserver.exe";
}

function findForbiddenFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return findForbiddenFiles(entryPath);
    }
    return isForbiddenFileName(entry.name, directory) ? [entryPath] : [];
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
      `[ensure-server-bundle] ${source} contains forbidden apphost/runtime files; the server ` +
        "must ship as a single Native AOT executable per architecture:\n" +
        bundledRuntimeFiles.map((file) => `  - ${path.relative(root, file)}`).join("\n")
    );
    process.exit(1);
  }
}

if (bundleMode === "artifact") {
  validateBundle("Signed server artifact");
  console.log(
    `[ensure-server-bundle] Reusing signed Native AOT server artifact in ${path.relative(root, outDir)}.`
  );
  process.exit(0);
}

const serverCsproj = path.join(
  root,
  "server",
  "src",
  "WinUiXaml.LanguageServer",
  "WinUiXaml.LanguageServer.csproj"
);
const generatorHostCsproj = path.join(
  root,
  "server",
  "src",
  "WinUiXaml.GeneratorHost",
  "WinUiXaml.GeneratorHost.csproj"
);
rmSync(outDir, { recursive: true, force: true });

// Stamp the extension version onto the server assembly so the LSP `serverInfo.version` a user
// reports from the output channel identifies the exact build that shipped.
const { version: extensionVersion } = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8")
);

function publish(label, args) {
  const result = spawnSync("dotnet", args, { stdio: "inherit", cwd: root, shell: false });
  if (result.error?.code === "ENOENT") {
    console.error(
      "[ensure-server-bundle] The .NET 10 SDK ('dotnet') was not found. It is required to build the server."
    );
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[ensure-server-bundle] dotnet publish failed for ${label}.`);
    // The most common local failure is ILC not finding the MSVC linker, which surfaces as an
    // MSB3073 'link.exe exited with code 123' well after code generation succeeded.
    console.error(
      "[ensure-server-bundle] Native AOT requires the MSVC toolchain. If the failure is " +
        "MSB3073/link.exe, ensure the Visual Studio C++ build tools for the target architecture " +
        "are installed and that vswhere.exe is resolvable."
    );
    if (label !== hostRid) {
      // Cross-compiling needs a distinct component, and the base C++ workload does not include
      // it. CI hosts happen to ship it today, so this only bites when an image drifts.
      const target = label === "win-arm64" ? "ARM64" : "x64";
      console.error(
        `[ensure-server-bundle] ${label} is being cross-compiled from ${hostRid}, which needs the ` +
          `"MSVC v143 - VS 2022 C++ ${target} build tools" component specifically, not just the ` +
          "Desktop development with C++ workload."
      );
    }
    process.exit(result.status ?? 1);
  }
}

for (const rid of rids) {
  const crossNote = rid === hostRid ? "" : " (cross-compiled)";
  console.log(
    `[ensure-server-bundle] Publishing Native AOT WinUI XAML language server for ${rid}${crossNote}...`
  );
  publish(rid, [
    "publish",
    serverCsproj,
    "-c",
    "Release",
    "-r",
    rid,
    // PublishAot lives in the .csproj on purpose: passing it here would propagate to project
    // references, and WinUiXaml.Xaml targets netstandard2.0, which fails with NETSDK1207.
    `-p:Version=${extensionVersion}`,
    "-o",
    path.join(outDir, rid),
  ]);
}

console.log("[ensure-server-bundle] Publishing the framework-dependent generator host...");
publish("generator host", [
  "publish",
  generatorHostCsproj,
  "-c",
  "Release",
  "--self-contained",
  "false",
  "-p:UseAppHost=false",
  `-p:Version=${extensionVersion}`,
  "-o",
  path.join(outDir, GENERATOR_HOST_DIR),
]);

validateBundle("Local publish");
console.log(
  `[ensure-server-bundle] Native AOT language server published to dist/server for: ${rids.join(", ")}.`
);
