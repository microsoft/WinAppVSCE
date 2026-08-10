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
import {
  buildDegradedNotification,
  DegradedAction,
  DegradedCause,
} from "./degradedNotification";
import { getWindowsServerRid } from "./serverArchitecture";
import { ServerLifecycle } from "./serverLifecycle";

let client: LanguageClient | undefined;
let output: vscode.OutputChannel | undefined;

// The client does not own caller-supplied watchers.
let fileWatcher: vscode.FileSystemWatcher | undefined;

// Serialize lifecycle operations so starts and stops cannot overlap.
const lifecycle = new ServerLifecycle();

// Track each degraded cause once until the next successful start.
let lastDegradedCause: DegradedCause | undefined;

// The integration harness cannot read OutputChannel contents.
function log(message: string): void {
  output?.appendLine(message);
  if (process.env.WINUI_XAML_TEST === "1") {
    console.log(`[winui-xaml] ${message}`);
  }
}

/** Activates the XAML language service, degrading to syntax highlighting if unavailable. */
export async function activateXaml(context: vscode.ExtensionContext): Promise<void> {
  // Allow reactivation in the same host process.
  lifecycle.reset();
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
    vscode.commands.registerCommand("winui-xaml.restartServer", () => restartClient(context, true)),
    // Start semantic processing only after the workspace becomes trusted.
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      if (vscode.workspace.textDocuments.some((document) => document.languageId === "xaml")) {
        log("Workspace trust granted — restarting language server.");
        return restartClient(context);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (document.languageId === "xaml") {
        return startClient(context);
      }
    })
  );

  if (vscode.workspace.textDocuments.some((document) => document.languageId === "xaml")) {
    await startClient(context);
  }
}

export async function deactivateXaml(): Promise<void> {
  // Prevent queued starts from resurrecting the server during shutdown.
  lifecycle.beginDisposal();
  await stopClient();
}

/** Starts the server without interleaving with a stop. */
async function startClient(context: vscode.ExtensionContext): Promise<void> {
  return lifecycle.runExclusive(() => doStart(context));
}

/** Restarts the server as one exclusive lifecycle transition. */
async function restartClient(
  context: vscode.ExtensionContext,
  showRestartNotification = false
): Promise<void> {
  return lifecycle.runExclusive(async () => {
    await doStop();
    if (!lifecycle.isDisposing) {
      await doStart(context, showRestartNotification);
    }
  });
}

async function doStart(context: vscode.ExtensionContext, userInitiated = false): Promise<void> {
  // Never resurrect the server after shutdown begins.
  if (lifecycle.isDisposing) {
    return;
  }

  if (client) {
    return;
  }

  // Never evaluate projects in an untrusted workspace: MSBuild evaluation can execute attacker-controlled targets and tasks. Remain syntax-only until trust is granted. WINUI_XAML_FORCE_UNTRUSTED exercises this boundary in the integration harness.
  const forceUntrusted = process.env.WINUI_XAML_FORCE_UNTRUSTED === "1";
  if (forceUntrusted || !vscode.workspace.isTrusted) {
    notifyDegraded(
      "Workspace is untrusted — language server not started (syntax-only until trust is granted).",
      "untrusted",
      userInitiated
    );
    return;
  }

  const server = resolveServer(context);
  if (!server) {
    notifyDegraded(
      "Bundled language server executable not found. IntelliSense, diagnostics, and navigation are unavailable; " +
        "syntax highlighting remains available.",
      "server",
      userInitiated
    );
    return;
  }

  log(`Starting language server: ${server.command} ${server.args.join(" ")}`);

  const executable: Executable = {
    command: server.command,
    args: server.args,
    transport: TransportKind.stdio,
    options: { cwd: server.cwd },
  };

  const serverOptions: ServerOptions = { run: executable, debug: executable };

  // Restrict project evaluation to trusted workspace roots.
  const allowedRoots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);

  fileWatcher = vscode.workspace.createFileSystemWatcher("**/*.{cs,csproj,xaml,props,targets}");

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "xaml" },
      { scheme: "untitled", language: "xaml" },
    ],
    outputChannel: output,
    initializationOptions: { allowedRoots },
    synchronize: {
      fileEvents: fileWatcher,
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
    lastDegradedCause = undefined;
    log("Language server started.");
    if (userInitiated) {
      void vscode.window.showInformationMessage("WinUI XAML language server restarted.");
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Clean up the partially started client.
    try {
      await candidate.stop();
    } catch {
      /* ignore — the start already failed */
    }
    // The client never took ownership of this watcher.
    disposeFileWatcher();
    notifyDegraded(
      `Failed to start language server (${server.command}): ${detail}. ` +
        "Syntax highlighting remains available.",
      "server",
      userInitiated
    );
  }
}

/** Disposes the retained file-system watcher. */
function disposeFileWatcher(): void {
  if (fileWatcher) {
    fileWatcher.dispose();
    fileWatcher = undefined;
  }
}

/** Stops the server without interleaving with another lifecycle operation. */
async function stopClient(): Promise<void> {
  return lifecycle.runExclusive(doStop);
}

async function doStop(): Promise<void> {
  disposeFileWatcher();
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

/** Logs degradation and shows one warning per cause until recovery. */
function notifyDegraded(
  reason: string,
  cause: DegradedCause = "server",
  forceNotification = false
): void {
  log(reason);
  if (!forceNotification && cause === lastDegradedCause) {
    return;
  }
  lastDegradedCause = cause;

  const { message, actions } = buildDegradedNotification(cause, reason);
  void vscode.window
    .showWarningMessage(message, ...actions.map((a) => a.label))
    .then((choice) => {
      const action = actions.find((a) => a.label === choice);
      if (action) {
        void runDegradedAction(action);
      }
    });
}

/** Executes a degraded-state action. */
function runDegradedAction(action: DegradedAction): Thenable<unknown> | void {
  if (action.showOutput) {
    output?.show(true);
    return;
  }
  if (action.url) {
    return vscode.env.openExternal(vscode.Uri.parse(action.url));
  }
  if (action.command) {
    const primary =
      action.commandArg !== undefined
        ? vscode.commands.executeCommand(action.command, action.commandArg)
        : vscode.commands.executeCommand(action.command);
    // Support both workspace-trust command identifiers.
    return Promise.resolve(primary).then(undefined, () =>
      action.fallbackCommand ? vscode.commands.executeCommand(action.fallbackCommand) : undefined
    );
  }
}

/** Locates the bundled server or a development-only environment override. */
function resolveServer(
  context: vscode.ExtensionContext
): { command: string; args: string[]; cwd: string } | undefined {
  // Exercise missing-server degradation in the integration harness.
  if (process.env.WINUI_XAML_FORCE_NO_SERVER === "1") {
    return undefined;
  }
  const candidates =
    process.env.WINUI_XAML_REQUIRE_BUNDLED === "1"
      ? [bundledServer(context)]
      : [
          process.env.WINUI_XAML_SERVER_PATH ?? "",
          bundledServer(context),
        ];
  const serverPath = firstExistingPath(candidates);
  if (!serverPath) {
    return undefined;
  }
  return path.extname(serverPath).toLowerCase() === ".dll"
    ? { command: "dotnet", args: [serverPath], cwd: path.dirname(serverPath) }
    : { command: serverPath, args: [], cwd: path.dirname(serverPath) };
}

function bundledServer(context: vscode.ExtensionContext): string {
  const rid = getWindowsServerRid();
  return path.join(
    context.extensionPath,
    "dist",
    "server",
    rid,
    "WinUiXaml.LanguageServer.exe"
  );
}
