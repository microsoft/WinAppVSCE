import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
  Executable,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;
let output: vscode.OutputChannel | undefined;

// When running under the integration harness, mirror diagnostics to stdout so failures are
// visible in the test output (OutputChannel contents aren't reachable via the extension API).
function log(message: string): void {
  output?.appendLine(message);
  if (process.env.WINUI_XAML_TEST === "1") {
    console.log(`[winui-xaml] ${message}`);
  }
}

/**
 * Activates the WinUI XAML language service: a standalone .NET LSP process ("Host B")
 * connected to `.xaml` documents. This is additive to the host WinApp extension — if the
 * server cannot be located or started it degrades gracefully to syntax highlighting only
 * and never disturbs the other extension features.
 */
export async function activateXaml(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel("WinUI XAML");
  context.subscriptions.push(output);
  log("WinUI XAML Tools activating…");

  context.subscriptions.push(
    vscode.commands.registerCommand("winui-xaml.showInfo", () => {
      vscode.window.showInformationMessage(
        client && client.isRunning()
          ? "WinUI XAML Tools — language server running (Host B)."
          : "WinUI XAML Tools — syntax only; language server not started."
      );
    }),
    vscode.commands.registerCommand("winui-xaml.restartServer", async () => {
      await stopClient();
      await startClient(context);
    })
  );

  await startClient(context);
}

export async function deactivateXaml(): Promise<void> {
  await stopClient();
}

async function startClient(context: vscode.ExtensionContext): Promise<void> {
  const dllPath = resolveServerDll(context);
  if (!dllPath) {
    log(
      "Language server assembly not found. Set 'winui-xaml.server.path' to WinUiXaml.LanguageServer.dll " +
        "to enable IntelliSense, diagnostics, and navigation. Syntax highlighting remains available."
    );
    return;
  }

  const dotnet = vscode.workspace
    .getConfiguration("winui-xaml")
    .get<string>("server.dotnetPath", "dotnet");

  log(`Starting language server: ${dotnet} ${dllPath}`);

  const executable: Executable = {
    command: dotnet,
    args: [dllPath],
    transport: TransportKind.stdio,
    options: { cwd: path.dirname(dllPath) },
  };

  const serverOptions: ServerOptions = { run: executable, debug: executable };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "xaml" },
      { scheme: "untitled", language: "xaml" },
    ],
    outputChannel: output,
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.{csproj,xaml}"),
    },
  };

  client = new LanguageClient(
    "winui-xaml",
    "WinUI XAML Language Server",
    serverOptions,
    clientOptions
  );

  try {
    await client.start();
    log("Language server started.");
  } catch (err) {
    log(`Failed to start language server: ${err instanceof Error ? err.message : String(err)}`);
    client = undefined;
  }
}

async function stopClient(): Promise<void> {
  if (client) {
    await client.stop();
    client = undefined;
  }
}

/**
 * Locates WinUiXaml.LanguageServer.dll. Priority: explicit setting, environment variable,
 * the server bundled into the packaged extension (`dist/server`), then a repo-relative dev
 * build (`server/src/.../bin/<config>/net10.0`).
 */
function resolveServerDll(context: vscode.ExtensionContext): string | undefined {
  const configured = vscode.workspace
    .getConfiguration("winui-xaml")
    .get<string>("server.path", "")
    .trim();

  const candidates = [
    configured,
    process.env.WINUI_XAML_SERVER_DLL ?? "",
    path.join(context.extensionPath, "dist", "server", "WinUiXaml.LanguageServer.dll"),
    repoRelativeServer(context, "Debug"),
    repoRelativeServer(context, "Release"),
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function repoRelativeServer(context: vscode.ExtensionContext, configuration: string): string {
  return path.resolve(
    context.extensionPath,
    "server",
    "src",
    "WinUiXaml.LanguageServer",
    "bin",
    configuration,
    "net10.0",
    "WinUiXaml.LanguageServer.dll"
  );
}
