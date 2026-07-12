// Ensures the WinUI XAML language server is published into dist/server before a VSIX is built.
//
// This runs from `vscode:prepublish`, so *any* `vsce package` (including a bare `npx vsce package`
// with no wrapper script) bundles the server — the server can no longer be silently omitted.
//
// If dist/server/WinUiXaml.LanguageServer.dll already exists it is reused as-is. That keeps two
// existing flows intact:
//   * package-vsc.ps1 publishes the server (via `bundle:server`) *before* invoking `vsce package`,
//     so this step becomes a no-op instead of building twice.
//   * package-vsc.ps1 -SkipServerBuild reuses a pre-published, ESRP-signed dist/server from an
//     earlier CI stage — rebuilding here would clobber the signed DLLs, so we must not.
//
// Set WINUI_FORCE_SERVER_BUNDLE=1 to force a fresh publish even when output exists.

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverDll = path.join(root, "dist", "server", "WinUiXaml.LanguageServer.dll");
const force = process.env.WINUI_FORCE_SERVER_BUNDLE === "1";

if (existsSync(serverDll) && !force) {
  console.log(`[ensure-server-bundle] Reusing existing ${path.relative(root, serverDll)}`);
  process.exit(0);
}

console.log("[ensure-server-bundle] Publishing WinUI XAML language server -> dist/server ...");
const csproj = path.join(
  root,
  "server",
  "src",
  "WinUiXaml.LanguageServer",
  "WinUiXaml.LanguageServer.csproj"
);
const outDir = path.join(root, "dist", "server");
const result = spawnSync(
  "dotnet",
  ["publish", csproj, "-c", "Release", "-o", outDir],
  { stdio: "inherit", cwd: root, shell: false }
);

if (result.error && result.error.code === "ENOENT") {
  console.error(
    "[ensure-server-bundle] The .NET SDK ('dotnet') was not found. Install the .NET 10 SDK to " +
      "bundle the WinUI XAML language server, or run package-vsc.ps1 -SkipServerBuild with a " +
      "pre-published dist/server."
  );
  process.exit(1);
}
if (result.status !== 0) {
  console.error("[ensure-server-bundle] dotnet publish failed.");
  process.exit(result.status ?? 1);
}
if (!existsSync(serverDll)) {
  console.error(`[ensure-server-bundle] Publish completed but ${serverDll} was not produced.`);
  process.exit(1);
}
console.log("[ensure-server-bundle] Language server published to dist/server");
