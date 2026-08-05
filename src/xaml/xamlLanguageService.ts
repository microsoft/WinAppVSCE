import * as path from "path";
import * as fs from "fs";
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

// The file-system watcher handed to the LanguageClient's `synchronize.fileEvents`. vscode-languageclient
// does NOT dispose caller-supplied watchers, so we retain it here and dispose it in doStop — otherwise
// each start/restart/trust cycle would leak one watcher.
let fileWatcher: vscode.FileSystemWatcher | undefined;

// Single lifecycle queue. Every start/stop/restart/trust-grant/deactivate op is chained here so a
// stop fully completes before the next start begins — two servers can never run at once, and a
// restart can never tear down a still-pending start. Each op runs regardless of the previous op's
// outcome, and the chain itself never rejects (callers still observe their own op's result).
const lifecycle = new ServerLifecycle();

// Set synchronously at the very start of deactivateXaml, before any await. Once true, doStart
// no-ops so no queued or later start (a racing restartServer, or a deferred trust-grant restart)
// can resurrect the language server after the extension has begun shutting down.
// One non-nagging "degraded to syntax-only" warning per DISTINCT cause. Reset on a successful start
// so a later failure notifies again. Cause-aware so an untrusted→server transition (or vice versa)
// still surfaces the new, correct guidance once instead of being suppressed by a prior warning.
let lastDegradedCause: DegradedCause | undefined;

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
  // Clear any state left from a prior deactivate in the same host process so a re-activation can
  // start the server again.
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
    // The server is not started at all while the workspace is untrusted (see doStart). Once trust is
    // granted, restart so the semantic server starts and workspace-provided paths can take effect.
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      if (vscode.workspace.textDocuments.some((document) => document.languageId === "xaml")) {
        log("Workspace trust granted — restarting language server.");
        return restartClient(context);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        (event.affectsConfiguration("winui-xaml.server.path") ||
          event.affectsConfiguration("winui-xaml.server.dotnetPath")) &&
        (client || vscode.workspace.textDocuments.some((document) => document.languageId === "xaml"))
      ) {
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
  // Set synchronously (before any await) so a start already queued behind this — or one enqueued
  // by a racing restartServer/trust-grant after we begin — no-ops in doStart and can't resurrect
  // the server after shutdown. We still stop any running client below.
  lifecycle.beginDisposal();
  await stopClient();
}

/**
 * Starts the language server, serializing through the lifecycle queue so it can never interleave
 * with a stop. Safe to call when a client is already running (it becomes a no-op).
 */
async function startClient(context: vscode.ExtensionContext): Promise<void> {
  return lifecycle.runExclusive(() => doStart(context));
}

/**
 * Restarts the language server as a SINGLE exclusive lifecycle transition: the stop and the
 * subsequent start run inside one queued op, so no other op (a racing restart, trust-grant, or
 * deactivate) can interleave between them. If deactivation has begun, the start is skipped so the
 * server is not resurrected.
 */
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
  // Deactivation has begun — never start (or resurrect) the server after shutdown, even if this
  // start was queued before deactivateXaml ran or enqueued by a racing restart/trust-grant.
  if (lifecycle.isDisposing) {
    return;
  }

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
  //
  // WINUI_XAML_FORCE_UNTRUSTED is a test-only seam (mirrors WINUI_XAML_FORCE_NO_SERVER): the
  // integration harness runs with --disable-workspace-trust (isTrusted always true), so this env var
  // lets a test exercise the untrusted degradation + trust-grant recovery paths deterministically.
  // It is never set outside the harness, so production behavior is unchanged.
  const forceUntrusted = process.env.WINUI_XAML_FORCE_UNTRUSTED === "1";
  if (forceUntrusted || !vscode.workspace.isTrusted) {
    notifyDegraded(
      "Workspace is untrusted — language server not started (syntax-only until trust is granted).",
      "untrusted",
      userInitiated
    );
    return;
  }

  // Machine-scoped settings already block a workspace overriding server/dotnet paths; re-checking
  // isTrusted here is defense in depth and also covers the deferred-trust restart path.
  const config = vscode.workspace.getConfiguration("winui-xaml");
  const configuredServer = config.get<string>("server.path", "").trim();
  const dotnet = config.get<string>("server.dotnetPath", "dotnet");
  if (configuredServer && !fs.existsSync(configuredServer)) {
    notifyDegraded(
      `Configured language server not found: ${configuredServer}. ` +
        "Update or clear 'winui-xaml.server.path'. Syntax highlighting remains available.",
      "server",
      userInitiated
    );
    return;
  }

  const server = resolveServer(context, configuredServer, dotnet);
  if (!server) {
    notifyDegraded(
      "Language server executable not found. Set 'winui-xaml.server.path' to a server executable or DLL " +
        "to enable IntelliSense, diagnostics, and navigation. Syntax highlighting remains available.",
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

  // Pass the trusted workspace roots to the server so it only performs project discovery / MSBuild
  // evaluation for documents under one of these folders. An empty window contributes an empty list,
  // which disables project evaluation entirely (workspace-trust boundary, defense-in-depth).
  const allowedRoots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);

  // Retained so doStop can dispose it (vscode-languageclient never disposes caller-supplied watchers).
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
    // Best-effort cleanup of the half-started client so it doesn't linger.
    try {
      await candidate.stop();
    } catch {
      /* ignore — the start already failed */
    }
    // The client never took ownership, so dispose the watcher we created for it here (doStop only
    // runs when there is a tracked client to stop).
    disposeFileWatcher();
    notifyDegraded(
      `Failed to start language server (${server.command}): ${detail}. ` +
        "Check 'winui-xaml.server.path' if you configured a custom server. " +
        "Syntax highlighting remains available.",
      "server",
      userInitiated
    );
  }
}

/** Disposes and clears the retained file-system watcher, if any. Idempotent. */
function disposeFileWatcher(): void {
  if (fileWatcher) {
    fileWatcher.dispose();
    fileWatcher = undefined;
  }
}

/**
 * Stops the language server, serializing through the lifecycle queue so a concurrent restart/trust
 * grant can never observe a torn-down-but-not-yet-stopped client. Stop errors are swallowed and
 * logged (important during shutdown).
 */
async function stopClient(): Promise<void> {
  return lifecycle.runExclusive(doStop);
}

async function doStop(): Promise<void> {
  // Dispose the retained watcher on every stop (restart / trust cycle / deactivate) so it never leaks,
  // regardless of whether a client is currently tracked.
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

/**
 * Logs the reason and, once per transition into the degraded (syntax-only) state, shows a
 * non-blocking warning with actionable buttons. The message + actions are chosen by the pure
 * {@link buildDegradedNotification} (unit-tested), and kept non-nagging (per distinct
 * {@link DegradedCause}) via {@link lastDegradedCause}.
 */
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

/** Executes a single degraded-notification action (command / external URL / output reveal). */
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
    // VS Code has renamed the workspace-trust command across versions; try the fallback if the
    // primary id is not registered in this host.
    return Promise.resolve(primary).then(undefined, () =>
      action.fallbackCommand ? vscode.commands.executeCommand(action.fallbackCommand) : undefined
    );
  }
}

/**
 * Locates the self-contained bundled executable, or a developer-provided DLL. Priority: explicit
 * setting (trusted workspaces only — see {@link doStart}), environment variable, architecture-
 * appropriate bundled executable, then repo-relative dev builds.
 */
function resolveServer(
  context: vscode.ExtensionContext,
  configuredServer: string,
  dotnet: string
): { command: string; args: string[]; cwd: string } | undefined {
  // Test-only seam (N4): when WINUI_XAML_FORCE_NO_SERVER=1, behave as if no server DLL exists so the
  // missing-DLL degradation path (notifyDegraded → syntax-only) can be covered deterministically.
  // No effect on normal users: the env var is never set outside the integration harness.
  if (process.env.WINUI_XAML_FORCE_NO_SERVER === "1") {
    return undefined;
  }
  const candidates =
    process.env.WINUI_XAML_REQUIRE_BUNDLED === "1"
      ? [configuredServer || bundledServer(context)]
      : [
          configuredServer,
          process.env.WINUI_XAML_SERVER_PATH ?? "",
          process.env.WINUI_XAML_SERVER_DLL ?? "",
          bundledServer(context),
          repoRelativeServer(context, "Debug"),
          repoRelativeServer(context, "Release"),
        ];
  const serverPath = firstExistingPath(candidates);
  if (!serverPath) {
    return undefined;
  }
  return path.extname(serverPath).toLowerCase() === ".dll"
    ? { command: dotnet, args: [serverPath], cwd: path.dirname(serverPath) }
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
