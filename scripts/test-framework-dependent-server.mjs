// Smokes the framework-dependent server bundle in dist/server.
//
// The bundle is prepared first so the suite can never silently validate a stale build. Which
// bundle that is comes from WINUI_XAML_SERVER_BUNDLE_MODE, shared with ensure-server-bundle.mjs:
//   source   (default, local dev) - publish a fresh bundle from server/src, then smoke it.
//   artifact (CI)                 - validate the already-downloaded SIGNED bundle and smoke that,
//                                   never rebuilding over it.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(
  root,
  "dist",
  "server",
  "WinUiXaml.LanguageServer.dll"
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
