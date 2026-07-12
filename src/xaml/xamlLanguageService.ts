import * as path from "path";
import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
  Executable,
} from "vscode-languageclient/node";
import { firstExistingPath } from "../winapp-cli-utils";

let client: LanguageClient | undefined;
let output: vscode.OutputChannel | undefined;

// Single lifecycle queue. Every start/stop/restart/trust-grant/deactivate op is chained here so a
// stop fully completes before the next start begins — two servers can never run at once, and a
// restart can never tear down a still-pending start. Each op runs regardless of the previous op's
// outcome, and the chain itself never rejects (callers still observe their own op's result).
let lifecycle: Promise<void> = Promise.resolve();

function runExclusive(op: () => Promise<void>): Promise<void> {
  const next = lifecycle.then(op, op);
  lifecycle = next.catch(() => {});
  return next;
}

// One non-nagging "degraded to syntax-only" warning per transition into the degraded state. Reset on a
// successful start so a later failure (e.g. after granting trust or fixing a setting) notifies again.
let degradedNotified = false;

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
    }),
    // The server is not started at all while the workspace is untrusted (see doStart). Once trust is
    // granted, restart so the semantic server starts and workspace-provided paths can take effect.
    vscode.workspace.onDidGrantWorkspaceTrust(async () => {
      log("Workspace trust granted — restarting language server.");
      await stopClient();
      await startClient(context);
    })
  );

  await startClient(context);
}

export async function deactivateXaml(): Promise<void> {
  await stopClient();
}

/**
 * Starts the language server, serializing through the lifecycle queue so it can never interleave
 * with a stop. Safe to call when a client is already running (it becomes a no-op).
 */
async function startClient(context: vscode.ExtensionContext): Promise<void> {
  return runExclusive(() => doStart(context));
}

async function doStart(context: vscode.ExtensionContext): Promise<void> {
  // Already running (e.g. a redundant start queued behind another) — nothing to do.
  if (client) {
    return;
  }

  // Workspace-trust gate (N1, CRITICAL). Do NOT start the semantic language server at all while the
  // workspace is untrusted: starting it would let Roslyn/MSBuild open the workspace's .csproj
  // (MSBuildWorkspace.OpenProjectAsync), and MSBuild evaluation / design-time build of an
  // attacker-controlled project can execute code (imported .targets, inline UsingTask, design-time
  // targets). So merely opening a .xaml file in an untrusted cloned repo could run attacker code.
  // Staying syntax-only (TextMate grammar) is the intended safe behavior; the
  // onDidGrantWorkspaceTrust handler restarts us once trust is granted.
  if (!vscode.workspace.isTrusted) {
    log("Workspace is untrusted — language server not started (syntax-only until trust is granted).");
    return;
  }

  // Machine-scoped settings already block a workspace overriding server/dotnet paths; re-checking
  // isTrusted here is defense in depth and also covers the deferred-trust restart path.
  const config = vscode.workspace.getConfiguration("winui-xaml");
  const configuredDll = config.get<string>("server.path", "").trim();
  const dotnet = config.get<string>("server.dotnetPath", "dotnet");

  const dllPath = resolveServerDll(context, configuredDll);
  if (!dllPath) {
    notifyDegraded(
      "Language server assembly not found. Set 'winui-xaml.server.path' to WinUiXaml.LanguageServer.dll " +
        "to enable IntelliSense, diagnostics, and navigation. Syntax highlighting remains available."
    );
    return;
  }

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

  const candidate = new LanguageClient(
    "winui-xaml",
    "WinUI XAML Language Server",
    serverOptions,
    clientOptions
  );

  try {
    await candidate.start();
    client = candidate;
    degradedNotified = false;
    log("Language server started.");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Best-effort cleanup of the half-started client so it doesn't linger.
    try {
      await candidate.stop();
    } catch {
      /* ignore — the start already failed */
    }
    notifyDegraded(
      `Failed to start language server (${dotnet}): ${detail}. ` +
        "Ensure the .NET runtime is installed or set 'winui-xaml.server.dotnetPath'. " +
        "Syntax highlighting remains available."
    );
  }
}

/**
 * Stops the language server, serializing through the lifecycle queue so a concurrent restart/trust
 * grant can never observe a torn-down-but-not-yet-stopped client. Stop errors are swallowed and
 * logged (important during shutdown).
 */
async function stopClient(): Promise<void> {
  return runExclusive(doStop);
}

async function doStop(): Promise<void> {
  const current = client;
  client = undefined;
  if (!current) {
    return;
  }
  try {
    await current.stop();
  } catch (err) {
    log(`Error stopping language server: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Logs the reason and, once per transition into the degraded (syntax-only) state, shows a
 * non-blocking warning with actionable buttons. Kept non-nagging via {@link degradedNotified}.
 */
function notifyDegraded(reason: string): void {
  log(reason);
  if (degradedNotified) {
    return;
  }
  degradedNotified = true;

  const OPEN_SETTINGS = "Open Settings";
  const SHOW_OUTPUT = "Show Output";
  const INSTALL_DOTNET = "Install .NET";
  void vscode.window
    .showWarningMessage(
      "WinUI XAML: language server not started — XAML is syntax-only. " +
        "IntelliSense, diagnostics, and navigation are unavailable.",
      OPEN_SETTINGS,
      SHOW_OUTPUT,
      INSTALL_DOTNET
    )
    .then((choice) => {
      if (choice === OPEN_SETTINGS) {
        void vscode.commands.executeCommand("workbench.action.openSettings", "winui-xaml.server");
      } else if (choice === SHOW_OUTPUT) {
        output?.show(true);
      } else if (choice === INSTALL_DOTNET) {
        void vscode.env.openExternal(vscode.Uri.parse("https://dotnet.microsoft.com/download"));
      }
    });
}

/**
 * Locates WinUiXaml.LanguageServer.dll. Priority: explicit setting (trusted workspaces only —
 * see {@link doStart}), environment variable, the server bundled into the packaged extension
 * (`dist/server`), then a repo-relative dev build (`server/src/.../bin/<config>/net10.0`).
 */
function resolveServerDll(
  context: vscode.ExtensionContext,
  configuredDll: string
): string | undefined {
  // Test-only seam (N4): when WINUI_XAML_FORCE_NO_SERVER=1, behave as if no server DLL exists so the
  // missing-DLL degradation path (notifyDegraded → syntax-only) can be covered deterministically.
  // No effect on normal users: the env var is never set outside the integration harness.
  if (process.env.WINUI_XAML_FORCE_NO_SERVER === "1") {
    return undefined;
  }
  return firstExistingPath([
    configuredDll,
    process.env.WINUI_XAML_SERVER_DLL ?? "",
    path.join(context.extensionPath, "dist", "server", "WinUiXaml.LanguageServer.dll"),
    repoRelativeServer(context, "Debug"),
    repoRelativeServer(context, "Release"),
  ]);
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
