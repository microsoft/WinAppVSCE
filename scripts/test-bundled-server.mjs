// Smokes the bundled Native AOT server in dist/server. The bundle is prepared first so the suite can
// never silently validate a stale build. WINUI_XAML_SERVER_BUNDLE_MODE (shared with
// ensure-server-bundle.mjs) picks which: `source` republishes from server/src, `artifact` (CI) validates the downloaded SIGNED bundle without rebuilding over it.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The server is architecture-specific, so only the binary matching this host can be executed.
const hostRid = process.arch === "arm64" ? "win-arm64" : "win-x64";
const serverPath = path.join(
  root,
  "dist",
  "server",
  hostRid,
  "WinUiXaml.LanguageServer.exe"
);

const ensure = spawnSync(
  process.execPath,
  [path.join(root, "scripts", "ensure-server-bundle.mjs")],
  { cwd: root, stdio: "inherit" }
);
if (ensure.status !== 0) {
  process.exit(ensure.status ?? 1);
}

const smoke = path.join(root, "server", "test", "lsp-smoke", "smoke.mjs");
const result = spawnSync(process.execPath, [smoke], {
  cwd: root,
  env: { ...process.env, WINUI_XAML_SERVER_PATH: serverPath },
  stdio: "inherit",
});

process.exit(result.status ?? 1);
