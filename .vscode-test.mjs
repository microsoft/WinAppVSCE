import { defineConfig } from "@vscode/test-cli";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

// The committed WinUI smoke fixture doubles as the test workspace so the language server resolves a
// genuine project (types, x:Bind targets, App.xaml resources) — exactly like the stdio smoke test.
const fixture = path.resolve(here, "test", "fixtures", "xaml", "fixture");

// Force the freshly-built Debug server (candidate #2 in resolveServerDll) so it wins over any
// bundled Release copy under dist/server.
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

export default defineConfig({
  files: process.env.WINUI_XAML_TEST_FILES || "test/xaml-integration/**/*.test.js",
  version: "stable",
  workspaceFolder: fixture,
  // Isolate the extension under test from any other installed extensions. --disable-workspace-trust
  // makes vscode.workspace.isTrusted true in the harness so the full feature suite still exercises
  // the semantic server; production behavior is unchanged (the trust gate is only bypassed here).
  launchArgs: ["--disable-extensions", "--disable-workspace-trust"],
  env: {
    WINUI_XAML_SERVER_DLL: debugServerDll,
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
