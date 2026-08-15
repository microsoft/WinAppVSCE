import * as path from "path";
import * as vscode from "vscode";
import { spawn } from "child_process";
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
import {
  CSHARP_DEV_KIT_DISMISSED_KEY,
  CSHARP_DEV_KIT_EXTENSION_ID,
  CSHARP_DEV_KIT_MARKETPLACE_URI,
  CSHARP_DEV_KIT_RECOMMENDATION,
  CsharpDevKitNotificationGate,
} from "./csharpDevKitNotification";
import { getWindowsServerRid } from "./serverArchitecture";
import { ServerLifecycle } from "./serverLifecycle";
import {
  shouldTriggerAutomaticXamlSuggestions,
} from "./attributeSuggestionTrigger";
import {
  PROJECT_RESTORE_ACTIONS,
  PROJECT_RESTORE_MESSAGE,
  PROJECT_RESTORE_NOTIFICATION,
  ProjectRestoreNotificationGate,
} from "./projectRestoreNotification";
import {
  normalizeDiagnosticsLevel,
  getXamlStatus,
  getXamlStatusEffect,
  readXamlLanguageServerConfiguration,
  shouldRestartXamlLanguageServer,
  XamlStatusAction,
} from "./xamlConfiguration";

let client: LanguageClient | undefined;
let output: vscode.OutputChannel | undefined;

// The client does not own caller-supplied watchers.
let fileWatchers: vscode.FileSystemWatcher[] = [];

// Serialize lifecycle operations so starts and stops cannot overlap.
const lifecycle = new ServerLifecycle();

// Track each degraded cause once until the next successful start.
let lastDegradedCause: DegradedCause | undefined;
const csharpDevKitNotificationGate = new CsharpDevKitNotificationGate();
const projectRestoreNotificationGate = new ProjectRestoreNotificationGate();

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
    vscode.commands.registerCommand("winui-xaml.showInfo", () => showXamlInfo()),
    vscode.commands.registerCommand("winui-xaml.restartServer", () => restartClient(context, true)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("winapp.xaml.intelliSense.enable")) {
        if (!shouldRestartXamlLanguageServer(
          client !== undefined,
          vscode.workspace.textDocuments.some((document) => document.languageId === "xaml")
        )) {
          log("XAML configuration changed — changes will apply when a XAML document opens.");
          return;
        }
        log("XAML configuration changed — restarting language server.");
        return restartClient(context);
      }

      if (event.affectsConfiguration("winapp.xaml.diagnostics.level")) {
        const diagnosticsLevel = normalizeDiagnosticsLevel(
          vscode.workspace
            .getConfiguration("winapp.xaml")
            .get("diagnostics.level", "warning")
        );
        if (!client?.isRunning()) {
          log("XAML diagnostics level changed — it will apply when the language server is running.");
          return;
        }

        log(`XAML diagnostics level changed to '${diagnosticsLevel}'.`);
        return client.sendNotification("workspace/didChangeConfiguration", {
          settings: { diagnosticsLevel },
        });
      }
    }),
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
      recommendCsharpDevKit(document, context);
      if (document.languageId === "xaml") {
        return startClient(context);
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (
        event.document.languageId !== "xaml" ||
        event.contentChanges.length !== 1
      ) {
        return;
      }

      const change = event.contentChanges[0];
      const enabled = vscode.workspace
        .getConfiguration("winapp.xaml")
        .get("intelliSense.enable", true);
      if (
        !enabled ||
        (change.text !== "<" && !/^\r?\n[ \t]*$/.test(change.text))
      ) {
        return;
      }

      const offset = change.rangeOffset + change.text.length;
      const text = event.document.getText();
      const shouldTrigger = shouldTriggerAutomaticXamlSuggestions(
        enabled,
        change.text,
        text,
        offset
      );
      if (!shouldTrigger) {
        return;
      }

      const expectedPosition = event.document.positionAt(offset);
      setTimeout(() => {
        const editor = vscode.window.activeTextEditor;
        if (
          editor?.document.uri.toString() === event.document.uri.toString() &&
          editor.selection.active.isEqual(expectedPosition)
        ) {
          void vscode.commands.executeCommand("editor.action.triggerSuggest");
        }
      }, 0);
    })
  );

  vscode.workspace.textDocuments.forEach((document) => recommendCsharpDevKit(document, context));

  if (vscode.workspace.textDocuments.some((document) => document.languageId === "xaml")) {
    await startClient(context);
  }
}

function showXamlInfo(): void {
  const configuration = readXamlLanguageServerConfiguration((section, defaultValue) =>
    vscode.workspace.getConfiguration("winapp.xaml").get(section, defaultValue)
  );
  const status = getXamlStatus(
    configuration.enabled,
    client?.isRunning() ?? false,
    vscode.workspace.isTrusted,
    vscode.workspace.textDocuments.some((document) => document.languageId === "xaml")
  );
  void vscode.window
    .showInformationMessage<XamlStatusAction>(status.message, ...status.actions)
    .then((selection) => {
      const effect = getXamlStatusEffect(selection);
      if (effect && "command" in effect) {
        return vscode.commands.executeCommand(effect.command, ...(effect.args ?? []));
      }
      if (effect && "showOutput" in effect) {
        output?.show();
      }
      return undefined;
    });
}

function recommendCsharpDevKit(
  document: vscode.TextDocument,
  context: vscode.ExtensionContext
): void {
  if (document.uri.scheme !== "file") {
    return;
  }

  const dismissed = context.globalState.get<boolean>(CSHARP_DEV_KIT_DISMISSED_KEY, false);
  const installed = vscode.extensions.getExtension(CSHARP_DEV_KIT_EXTENSION_ID) !== undefined;
  if (!csharpDevKitNotificationGate.shouldShow(document.uri.fsPath, installed, dismissed)) {
    return;
  }

  const recommendation = CSHARP_DEV_KIT_RECOMMENDATION;
  void vscode.window
    .showInformationMessage(
      recommendation.message,
      recommendation.installAction,
      recommendation.dismissAction
    )
    .then(async (choice) => {
      if (choice === recommendation.installAction) {
        await vscode.env.openExternal(vscode.Uri.parse(CSHARP_DEV_KIT_MARKETPLACE_URI));
      } else if (choice === recommendation.dismissAction) {
        await context.globalState.update(CSHARP_DEV_KIT_DISMISSED_KEY, true);
      }
    });
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

  const xamlConfiguration = vscode.workspace.getConfiguration("winapp.xaml");
  const serverConfiguration = readXamlLanguageServerConfiguration(
    (section, defaultValue) => xamlConfiguration.get(section, defaultValue)
  );
  if (!serverConfiguration.enabled) {
    lastDegradedCause = undefined;
    log("Language server disabled by winapp.xaml.intelliSense.enable.");
    if (userInitiated) {
      void vscode.window
        .showInformationMessage(
          "WinUI XAML IntelliSense is disabled in Settings.",
          "Open Settings"
        )
        .then((selection) => {
          if (selection === "Open Settings") {
            return vscode.commands.executeCommand(
              "workbench.action.openSettings",
              "winapp.xaml.intelliSense.enable"
            );
          }
          return undefined;
        });
    }
    return;
  }
  const { diagnosticsLevel } = serverConfiguration.initializationOptions;

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

  fileWatchers = [
    vscode.workspace.createFileSystemWatcher("**/*.{cs,csproj,xaml,props,targets}"),
    vscode.workspace.createFileSystemWatcher("**/obj/project.assets.json"),
  ];

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "xaml" },
      { scheme: "untitled", language: "xaml" },
    ],
    outputChannel: output,
    initializationOptions: { allowedRoots, diagnosticsLevel },
    synchronize: {
      fileEvents: fileWatchers,
    },
  };

  const candidate = new LanguageClient(
    "winui-xaml",
    "WinUI XAML Language Server",
    serverOptions,
    clientOptions
  );
  candidate.onNotification(
    PROJECT_RESTORE_NOTIFICATION,
    ({ projectPath }: { projectPath?: string }) => notifyProjectRestoreRequired(projectPath)
  );

  try {
    await candidate.start();
    client = candidate;
    const latestDiagnosticsLevel = normalizeDiagnosticsLevel(
      vscode.workspace
        .getConfiguration("winapp.xaml")
        .get("diagnostics.level", "warning")
    );
    await candidate.sendNotification("workspace/didChangeConfiguration", {
      settings: { diagnosticsLevel: latestDiagnosticsLevel },
    });
    lastDegradedCause = undefined;
    log("Language server started.");
    if (userInitiated) {
      void vscode.window.showInformationMessage("WinUI XAML language server restarted.");
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (client === candidate) {
      client = undefined;
    }
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

function notifyProjectRestoreRequired(projectPath: string | undefined): void {
  if (
    !projectPath ||
    !isTrustedWorkspaceProject(projectPath) ||
    !projectRestoreNotificationGate.shouldShow(projectPath)
  ) {
    return;
  }

  void vscode.window
    .showInformationMessage(
      PROJECT_RESTORE_MESSAGE,
      PROJECT_RESTORE_ACTIONS.restore,
      PROJECT_RESTORE_ACTIONS.showOutput
    )
    .then(async (choice) => {
      if (choice === PROJECT_RESTORE_ACTIONS.showOutput) {
        output?.show(true);
      } else if (choice === PROJECT_RESTORE_ACTIONS.restore) {
        await restoreProject(projectPath);
      }
    });
}

function isTrustedWorkspaceProject(projectPath: string): boolean {
  if (!vscode.workspace.isTrusted || path.extname(projectPath).toLowerCase() !== ".csproj") {
    return false;
  }

  const candidate = path.resolve(projectPath);
  return (vscode.workspace.workspaceFolders ?? []).some((folder) => {
    const relative = path.relative(path.resolve(folder.uri.fsPath), candidate);
    return relative.length === 0 ||
      (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
  });
}

async function restoreProject(projectPath: string): Promise<void> {
  output?.show(true);
  log(`Restoring project packages: ${projectPath}`);

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Restoring WinUI project packages",
      },
      () => runDotnetRestore(projectPath)
    );
    log("Project package restore completed. IntelliSense metadata is reloading.");
    void vscode.window.showInformationMessage(
      "WinUI project packages restored. XAML IntelliSense is reloading."
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log(`Project package restore failed: ${detail}`);
    void vscode.window.showErrorMessage(
      `WinUI project package restore failed: ${detail}`,
      PROJECT_RESTORE_ACTIONS.showOutput
    ).then((choice) => {
      if (choice === PROJECT_RESTORE_ACTIONS.showOutput) {
        output?.show(true);
      }
    });
  }
}

function runDotnetRestore(projectPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("dotnet", ["restore", projectPath, "--nologo"], {
      cwd: path.dirname(projectPath),
      windowsHide: true,
    });

    child.stdout.on("data", (data: Buffer) => output?.append(data.toString()));
    child.stderr.on("data", (data: Buffer) => output?.append(data.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`dotnet restore exited with code ${code ?? "unknown"}`));
      }
    });
  });
}

/** Disposes the retained file-system watcher. */
function disposeFileWatcher(): void {
  for (const watcher of fileWatchers) {
    watcher.dispose();
  }
  fileWatchers = [];
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
