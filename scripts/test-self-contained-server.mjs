import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const windowsArch = (
  process.env.PROCESSOR_ARCHITEW6432 ||
  process.env.PROCESSOR_ARCHITECTURE ||
  process.arch
).toLowerCase();
const rid = windowsArch.includes("arm64") ? "win-arm64" : "win-x64";
const serverPath = path.join(
  root,
  "dist",
  "server",
  rid,
  "WinUiXaml.LanguageServer.exe"
);
const smoke = path.join(root, "server", "test", "lsp-smoke", "smoke.mjs");
const result = spawnSync(process.execPath, [smoke], {
  cwd: root,
  env: { ...process.env, WINUI_XAML_SERVER_PATH: serverPath },
  stdio: "inherit",
});

process.exit(result.status ?? 1);
