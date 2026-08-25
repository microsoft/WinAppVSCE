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
  DOTNET_RUNTIME_DISMISSED_KEY,
  DegradedAction,
  DegradedCause,
  executeDegradedAction,
  shouldShowDegradedNotification,
} from "./degradedNotification";
import {
  CSHARP_DEV_KIT_DISMISSED_KEY,
  CSHARP_DEV_KIT_EXTENSION_ID,
  CSHARP_DEV_KIT_MARKETPLACE_URI,
  CSHARP_DEV_KIT_RECOMMENDATION,
  CsharpDevKitNotificationGate,
} from "./csharpDevKitNotification";
import { findCompatibleDotnet } from "./dotnetRuntime";
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
  PROJECT_CONTEXT_STATUS_NOTIFICATION,
  ProjectContextStatus,
  getRelevantProjectContextStatuses,
  getProjectContextStatusPresentation,
  selectProjectContextStatus,
} from "./projectContextStatus";
import {
  normalizeDiagnosticsLevel,
  getDiagnosticsLevelValidationMessage,
  DOTNET_REQUIRED_STATUS,
  getXamlStatus,
  getXamlStatusEffect,
  readXamlLanguageServerConfiguration,
  shouldRestartXamlLanguageServer,
  XamlStatusAction,
} from "./xamlConfiguration";
import { hasOpenXamlDocument } from "./xamlDemand";

let client: LanguageClient | undefined;
let output: vscode.OutputChannel | undefined;
let projectStatusItem: vscode.StatusBarItem | undefined;
let readyStatusTimer: NodeJS.Timeout | undefined;
const projectContextStatuses = new Map<string, ProjectContextStatus>();

// The client does not own caller-supplied watchers.
let fileWatchers: vscode.FileSystemWatcher[] = [];

// Serialize lifecycle operations so starts and stops cannot overlap.
const lifecycle = new ServerLifecycle();

// Track each degraded cause once until the next successful start.
let lastDegradedCause: DegradedCause | undefined;
const csharpDevKitNotificationGate = new CsharpDevKitNotificationGate();
const projectRestoreNotificationGate = new ProjectRestoreNotificationGate();
let lastInvalidDiagnosticsLevel: string | undefined;

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
  projectStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  projectStatusItem.name = "WinApp XAML IntelliSense";
  projectStatusItem.command = "winui-xaml.showOutput";
  context.subscriptions.push(output);
  context.subscriptions.push(projectStatusItem);
  log("WinUI XAML Tools activating…");

  context.subscriptions.push(
    vscode.commands.registerCommand("winui-xaml.showInfo", () => showXamlInfo()),
    vscode.commands.registerCommand("winui-xaml.showOutput", () => output?.show(true)),
    vscode.commands.registerCommand("winui-xaml.restartServer", () => restartClient(context, true)),
    vscode.window.onDidChangeActiveTextEditor(() => renderProjectContextStatus()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("winapp.xaml.intelliSense.enable")) {
        if (!shouldRestartXamlLanguageServer(
          client !== undefined,
          hasXamlDemand()
        )) {
          log("XAML configuration changed — changes will apply when a XAML document opens.");
          return;
        }
        log("XAML configuration changed — restarting language server.");
        return restartClient(context);
      }

      if (event.affectsConfiguration("winapp.xaml.diagnostics.level")) {
        const configuredLevel = vscode.workspace
          .getConfiguration("winapp.xaml")
          .get<unknown>("diagnostics.level", "all");
        reportInvalidDiagnosticsLevel(configuredLevel);
        const diagnosticsLevel = normalizeDiagnosticsLevel(configuredLevel);
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
      if (hasXamlDemand()) {
        log("Workspace trust granted — restarting language server.");
        return restartClient(context);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      recommendCsharpDevKit(document, context);
      if (hasOpenXamlDocument([document])) {
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

  if (hasOpenXamlDocument(vscode.workspace.textDocuments)) {
    await startClient(context);
  }
}

function hasXamlDemand(): boolean {
  return hasOpenXamlDocument(vscode.workspace.textDocuments);
}

function showXamlInfo(): void {
  const configuration = readXamlLanguageServerConfiguration((section, defaultValue) =>
    vscode.workspace.getConfiguration("winapp.xaml").get(section, defaultValue)
  );
  const status = getXamlStatus(
    configuration.enabled,
    client?.isRunning() ?? false,
    vscode.workspace.isTrusted,
    vscode.workspace.textDocuments.some((document) => document.languageId === "xaml"),
    lastDegradedCause === "dotnet"
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
      if (effect && "url" in effect) {
        return vscode.env.openExternal(vscode.Uri.parse(effect.url));
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
  const configuredDiagnosticsLevel = xamlConfiguration.get<unknown>(
    "diagnostics.level",
    "all"
  );
  reportInvalidDiagnosticsLevel(configuredDiagnosticsLevel);
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
      userInitiated,
      context
    );
    return;
  }

  const serverPath = resolveServerPath(context);
  if (!serverPath) {
    notifyDegraded(
      "Framework-dependent language server DLL not found. IntelliSense, diagnostics, and navigation are unavailable; " +
        "syntax highlighting remains available.",
      "server",
      userInitiated,
      context
    );
    return;
  }

  const dotnet = process.env.WINUI_XAML_FORCE_NO_DOTNET === "1"
    ? undefined
    : await findCompatibleDotnet();
  if (!dotnet) {
    notifyDegraded(
      "A compatible installed Microsoft.NETCore.App 10.x runtime was not found.",
      "dotnet",
      userInitiated,
      context
    );
    return;
  }

  log(`Starting language server: ${dotnet} ${serverPath}`);

  const executable: Executable = {
    command: dotnet,
    args: [serverPath],
    transport: TransportKind.stdio,
    options: {
      cwd: path.dirname(serverPath),
      env: { ...process.env, DOTNET_HOST_PATH: dotnet },
    },
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
  candidate.onNotification(
    PROJECT_CONTEXT_STATUS_NOTIFICATION,
    (status: ProjectContextStatus) => updateProjectContextStatus(status)
  );

  try {
    await candidate.start();
    client = candidate;
    const latestDiagnosticsLevel = normalizeDiagnosticsLevel(
      vscode.workspace
        .getConfiguration("winapp.xaml")
        .get("diagnostics.level", "all")
    );
    await candidate.sendNotification("workspace/didChangeConfiguration", {
      settings: { diagnosticsLevel: latestDiagnosticsLevel },
    });
    lastDegradedCause = undefined;
    renderProjectContextStatus();
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
      `Failed to start language server (${dotnet}): ${detail}. ` +
        "Syntax highlighting remains available.",
      "server",
      userInitiated,
      context
    );
  }
}

function reportInvalidDiagnosticsLevel(value: unknown): void {
  const message = getDiagnosticsLevelValidationMessage(value);
  if (!message) {
    lastInvalidDiagnosticsLevel = undefined;
    return;
  }

  log(message);
  const key = String(value);
  if (lastInvalidDiagnosticsLevel === key) {
    return;
  }
  lastInvalidDiagnosticsLevel = key;
  void vscode.window.showWarningMessage(message, "Open Settings").then((choice) => {
    if (choice === "Open Settings") {
      return vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "winapp.xaml.diagnostics.level"
      );
    }
    return undefined;
  });
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

function updateProjectContextStatus(status: ProjectContextStatus): void {
  if (
    !status.uri ||
    !["loading", "framework-ready", "ready", "error", "idle"].includes(status.state)
  ) {
    return;
  }

  if (status.state === "idle") {
    projectContextStatuses.delete(status.uri);
  } else {
    projectContextStatuses.set(status.uri, status);
  }
  renderProjectContextStatus();
}

function renderProjectContextStatus(): void {
  if (readyStatusTimer) {
    clearTimeout(readyStatusTimer);
    readyStatusTimer = undefined;
  }

  const activeEditor = vscode.window.activeTextEditor;
  const activeDocumentUri = activeEditor
    ? activeEditor.document.languageId === "xaml"
      ? activeEditor.document.uri.toString()
      : null
    : undefined;
  if (projectStatusItem && activeDocumentUri && lastDegradedCause === "dotnet") {
    projectStatusItem.text = DOTNET_REQUIRED_STATUS.text;
    projectStatusItem.tooltip = DOTNET_REQUIRED_STATUS.tooltip;
    projectStatusItem.command = DOTNET_REQUIRED_STATUS.command;
    projectStatusItem.show();
    return;
  }
  const relevantStatuses = getRelevantProjectContextStatuses(
    projectContextStatuses.values(),
    activeDocumentUri
  );
  const selected = selectProjectContextStatus(relevantStatuses);
  const presentation = selected
    ? getProjectContextStatusPresentation(selected)
    : undefined;
  if (!projectStatusItem || !selected || !presentation) {
    projectStatusItem?.hide();
    return;
  }

  projectStatusItem.text = presentation.text;
  projectStatusItem.tooltip = presentation.tooltip;
  projectStatusItem.command = "winui-xaml.showOutput";
  projectStatusItem.show();
  if (presentation.transient) {
    readyStatusTimer = setTimeout(() => {
      const currentEditor = vscode.window.activeTextEditor;
      const currentUri = currentEditor
        ? currentEditor.document.languageId === "xaml"
          ? currentEditor.document.uri.toString()
          : null
        : undefined;
      if (
        selectProjectContextStatus(
          getRelevantProjectContextStatuses(projectContextStatuses.values(), currentUri)
        )?.state === "ready"
      ) {
        projectStatusItem?.hide();
      }
      readyStatusTimer = undefined;
    }, 3000);
  }
}

function clearProjectContextStatus(): void {
  projectContextStatuses.clear();
  if (readyStatusTimer) {
    clearTimeout(readyStatusTimer);
    readyStatusTimer = undefined;
  }
  projectStatusItem?.hide();
}

/** Stops the server without interleaving with another lifecycle operation. */
async function stopClient(): Promise<void> {
  return lifecycle.runExclusive(doStop);
}

async function doStop(): Promise<void> {
  disposeFileWatcher();
  clearProjectContextStatus();
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
  forceNotification = false,
  context?: vscode.ExtensionContext
): void {
  log(reason);
  const shouldShow = shouldShowDegradedNotification(
    cause,
    lastDegradedCause,
    context?.globalState.get(DOTNET_RUNTIME_DISMISSED_KEY, false) ?? false,
    forceNotification
  );
  lastDegradedCause = cause;
  renderProjectContextStatus();
  if (!shouldShow) {
    return;
  }
  const { message, actions } = buildDegradedNotification(cause, reason);
  void vscode.window
    .showWarningMessage(message, ...actions.map((a) => a.label))
    .then((choice) => {
      const action = actions.find((a) => a.label === choice);
      if (action) {
        void runDegradedAction(action, context);
      }
    });
}

/** Executes a degraded-state action. */
function runDegradedAction(
  action: DegradedAction,
  context?: vscode.ExtensionContext
): Thenable<unknown> | void {
  return executeDegradedAction(action, {
    dismissDotnetRequirement: () =>
      context?.globalState.update(DOTNET_RUNTIME_DISMISSED_KEY, true) ??
      Promise.resolve(),
    showOutput: () => output?.show(true),
    openUrl: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
    executeCommand: (command, commandArg) =>
      commandArg === undefined
        ? vscode.commands.executeCommand(command)
        : vscode.commands.executeCommand(command, commandArg),
  });
}

/** Locates the framework-dependent server DLL or a development-only DLL override. */
function resolveServerPath(context: vscode.ExtensionContext): string | undefined {
  // Exercise missing-server degradation in the integration harness.
  if (process.env.WINUI_XAML_FORCE_NO_SERVER === "1") {
    return undefined;
  }
  const configured = process.env.WINUI_XAML_SERVER_PATH;
  const candidates =
    process.env.WINUI_XAML_REQUIRE_BUNDLED === "1"
      ? [bundledServer(context)]
      : configured
        ? [configured, bundledServer(context)]
        : [bundledServer(context)];
  return firstExistingPath(
    candidates.filter((candidate) => path.extname(candidate).toLowerCase() === ".dll")
  );
}

function bundledServer(context: vscode.ExtensionContext): string {
  return path.join(
    context.extensionPath,
    "dist",
    "server",
    "WinUiXaml.LanguageServer.dll"
  );
}
