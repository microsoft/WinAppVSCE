import { defineConfig } from "@vscode/test-cli";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

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
    WINUI_XAML_FIXTURE_DIR: fixture,
    WINUI_XAML_LOG: path.resolve(here, "server-test.log"),
  },
  mocha: {
    ui: "bdd",
    timeout: 180000,
    color: false,
  },
});
