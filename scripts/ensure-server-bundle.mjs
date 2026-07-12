// Ensures the WinUI XAML language server is published into dist/server before a VSIX is built.
//
// This runs from `vscode:prepublish`, so *any* `vsce package` (including a bare `npx vsce package`
// with no wrapper script) bundles the server — the server can no longer be silently omitted.
//
// By DEFAULT this PUBLISHES (builds) a fresh server, so a bare `vsce package` always ships an
// up-to-date dist/server DLL and can never bundle a stale one.
//
// The only time we reuse an existing dist/server is the trusted CI release path, whose purpose is to
// preserve already-ESRP-signed DLLs from an earlier pipeline stage: set WINUI_REUSE_SIGNED_SERVER=1
// there (package-vsc.ps1 sets it under -SkipServerBuild). Even with the flag, if dist/server is
// absent we always publish. See docs/RELEASE.md.

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverDll = path.join(root, "dist", "server", "WinUiXaml.LanguageServer.dll");
const reuseSigned = process.env.WINUI_REUSE_SIGNED_SERVER === "1";

if (reuseSigned && existsSync(serverDll)) {
  console.log(
    `[ensure-server-bundle] WINUI_REUSE_SIGNED_SERVER=1 — reusing signed ${path.relative(root, serverDll)}`
  );
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
