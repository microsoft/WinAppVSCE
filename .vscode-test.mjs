import { defineConfig } from "@vscode/test-cli";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

// The extension resolves its .NET host through the .NET Install Tool extension,
// which this harness cannot use because it launches with --disable-extensions.
// Supply the host directly instead, the same way WINUI_XAML_SERVER_PATH supplies
// the server DLL.
function resolveDotnetHost() {
  if (process.env.WINUI_XAML_DOTNET_PATH) {
    return process.env.WINUI_XAML_DOTNET_PATH;
  }
  const locator = process.platform === "win32" ? "where" : "which";
  const found = execFileSync(locator, ["dotnet"], { encoding: "utf8" })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (found.length === 0) {
    throw new Error("Could not locate a dotnet host for the XAML integration harness.");
  }
  return found[0];
}

// Use a real project so the server can resolve types, x:Bind targets, and resources.
const fixture = path.resolve(here, "test", "fixtures", "xaml", "fixture");

// CI can test the packaged framework-dependent DLL instead of the local Debug DLL.
const debugServerDll = path.resolve(
  here,
  "server",
  "src",
  "WinUiXaml.LanguageServer",
  "bin",
  "Debug",
  "net10.0",
  "WinUiXaml.LanguageServer.dll"
);
const bundledServerDll = path.resolve(
  here,
  "dist",
  "server",
  "WinUiXaml.LanguageServer.dll"
);

export default defineConfig({
  files: process.env.WINUI_XAML_TEST_FILES || "test/xaml-integration/**/*.test.js",
  version: "stable",
  workspaceFolder: fixture,
  // Isolate the extension and enable the semantic server in the harness.
  launchArgs: ["--disable-extensions", "--disable-workspace-trust"],
  env: {
    ...(process.env.WINUI_XAML_TEST_BUNDLED === "1"
      ? {
          WINUI_XAML_TEST_SERVER_PATH: bundledServerDll,
          WINUI_XAML_REQUIRE_BUNDLED: "1",
        }
      : { WINUI_XAML_SERVER_PATH: debugServerDll }),
    WINUI_XAML_TEST: "1",
    WINUI_XAML_DOTNET_PATH: resolveDotnetHost(),
    WINUI_XAML_FIXTURE_DIR: fixture,
    WINUI_XAML_LOG: path.resolve(here, "server-test.log"),
  },
  mocha: {
    ui: "bdd",
    timeout: 180000,
    color: false,
  },
});
