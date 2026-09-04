import * as path from "path";
import * as vscode from "vscode";
import {
  saveGeneratedEventHandlerDocument,
} from "./generatedEventHandlerSave";
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
import { createDotnetChildEnvironment } from "./dotnetRuntime";
import {
  DOTNET_INSTALL_TOOL_ID,
  DotnetFindPathRequest,
  DotnetHostResolver,
  InstallToolHost,
  describeDotnetResolutionFailure,
} from "./dotnetInstallTool";
import {
  DIAGNOSTICS_LEVEL_KEY,
  DIAGNOSTICS_LEVEL_SETTING,
  EXTERNAL_COMMANDS,
  INTELLISENSE_ENABLE_KEY,
  INTELLISENSE_ENABLE_SETTING,
  XAML_COMMANDS,
  XAML_SETTINGS_SECTION,
} from "./xamlConstants";
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
  isProjectContextState,
  selectProjectContextStatus,
} from "./projectContextStatus";
import {
  normalizeDiagnosticsLevel,
  DiagnosticsLevelInteraction,
  DOTNET_REQUIRED_STATUS,
  getXamlStatus,
  getXamlStatusEffect,
  readXamlLanguageServerConfiguration,
  shouldRestartXamlLanguageServer,
  XamlStatusAction,
} from "./xamlConfiguration";
import { hasOpenXamlDocument } from "./xamlDemand";
import {
  DOCUMENT_CHANGED_MESSAGE,
  INVALID_EDIT_RANGE_MESSAGE,
  GuardedTextEditRequest,
  PromptedTextEditDocument,
  PromptedTextEditRequest,
  runGuardedTextEditCommand,
  runPromptedTextEdit,
} from "./promptedTextEdit";

let client: LanguageClient | undefined;
let output: vscode.OutputChannel | undefined;
let projectStatusItem: vscode.StatusBarItem | undefined;
const APPLY_GENERATED_EVENT_HANDLER_COMMAND = "winui-xaml.applyGeneratedEventHandler";
const PROMPT_TEXT_EDIT_COMMAND = "winui-xaml.promptTextEdit";
const APPLY_GUARDED_TEXT_EDITS_COMMAND = "winui-xaml.applyGuardedTextEdits";

function findOpenDocument(documentUri: string): vscode.TextDocument | undefined {
  const target = vscode.Uri.parse(documentUri);
  const targetPath = path.normalize(target.fsPath);
  return vscode.workspace.textDocuments.find((candidate) =>
    candidate.uri.scheme === target.scheme &&
    (target.scheme === "file"
      ? path.normalize(candidate.uri.fsPath).localeCompare(
          targetPath,
          undefined,
          { sensitivity: process.platform === "win32" ? "accent" : "variant" },
        ) === 0
      : candidate.uri.toString() === target.toString()));
}
let readyStatusTimer: NodeJS.Timeout | undefined;
const projectContextStatuses = new Map<string, ProjectContextStatus>();

// The client does not own caller-supplied watchers.
let fileWatchers: vscode.FileSystemWatcher[] = [];

// Serialize lifecycle operations so starts and stops cannot overlap.
const lifecycle = new ServerLifecycle();

// Track each degraded cause once until the next successful start.
let lastDegradedCause: DegradedCause | undefined;

/** Resolves the .NET host through the Install Tool; created during activation. */
let dotnetHostResolver: DotnetHostResolver | undefined;
const csharpDevKitNotificationGate = new CsharpDevKitNotificationGate();
const projectRestoreNotificationGate = new ProjectRestoreNotificationGate();
const diagnosticsLevelInteraction = new DiagnosticsLevelInteraction({
  log,
  showWarningMessage: (message, action) =>
    vscode.window.showWarningMessage(message, action),
  openSettings: () =>
    vscode.commands.executeCommand(
      EXTERNAL_COMMANDS.openSettings,
      DIAGNOSTICS_LEVEL_SETTING
    ),
});

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
  dotnetHostResolver = new DotnetHostResolver(
    createInstallToolHost(),
    context.extension.id,
    process.arch,
    process.env.WINUI_XAML_DOTNET_PATH
  );
  projectStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  projectStatusItem.name = "WinApp XAML IntelliSense";
  projectStatusItem.command = XAML_COMMANDS.showOutput;
  context.subscriptions.push(output);
  context.subscriptions.push(projectStatusItem);
  log("WinUI XAML Tools activating…");

  context.subscriptions.push(
    vscode.commands.registerCommand(XAML_COMMANDS.showInfo, () => showXamlInfo()),
    vscode.commands.registerCommand(XAML_COMMANDS.showOutput, () => output?.show(true)),
    vscode.commands.registerCommand(XAML_COMMANDS.restartServer, () => restartClient(context, true)),
    vscode.commands.registerCommand(
      PROMPT_TEXT_EDIT_COMMAND,
      async (request: PromptedTextEditRequest) => {
        await runPromptedTextEdit(
          request,
          {
            showInput: async options => vscode.window.showInputBox({
              ...options,
              ignoreFocusOut: true,
            }),
            showChoice: async options => {
              const custom = `$(edit) ${request.customChoiceLabel}`;
              const selected = await vscode.window.showQuickPick(
                [...options.choices, custom],
                { placeHolder: options.placeHolder, ignoreFocusOut: true },
              );
              return selected === custom ? null : selected;
            },
            openDocument: async targetUri => {
              const uri = vscode.Uri.parse(targetUri);
              const document = findOpenDocument(targetUri) ??
                await vscode.workspace.openTextDocument(uri);
              return {
                version: document.version,
                source: document,
                getText: targetRange => {
                  const requestedRange = new vscode.Range(
                    targetRange.start.line,
                    targetRange.start.character,
                    targetRange.end.line,
                    targetRange.end.character,
                  );
                  if (!document.validateRange(requestedRange).isEqual(requestedRange)) {
                    throw new Error(INVALID_EDIT_RANGE_MESSAGE);
                  }
                  return document.getText(requestedRange);
                },
              };
            },
            applyEdit: async (targetDocument, targetRange, newText) => {
              const document = targetDocument.source as vscode.TextDocument;
              const requestedRange = new vscode.Range(
                targetRange.start.line,
                targetRange.start.character,
                targetRange.end.line,
                targetRange.end.character,
              );
              if (!document.validateRange(requestedRange).isEqual(requestedRange)) {
                throw new Error(INVALID_EDIT_RANGE_MESSAGE);
              }
              if (request.expectedVersion !== null &&
                  document.version !== request.expectedVersion ||
                  document.getText(requestedRange) !== request.expectedText) {
                throw new Error(DOCUMENT_CHANGED_MESSAGE);
              }

              const edit = new vscode.WorkspaceEdit();
              edit.replace(document.uri, requestedRange, newText);
              return vscode.workspace.applyEdit(edit);
            },
          },
        );
      },
    ),
    vscode.commands.registerCommand(
      APPLY_GUARDED_TEXT_EDITS_COMMAND,
      async (request: GuardedTextEditRequest) => {
        await runGuardedTextEditCommand(request, {
          openDocument: async targetUri => {
            const uri = vscode.Uri.parse(targetUri);
            return findOpenDocument(targetUri) ??
              vscode.workspace.openTextDocument(uri);
          },
          getDocumentVersion: document => document.version,
          createRange: range => new vscode.Range(
            range.start.line,
            range.start.character,
            range.end.line,
            range.end.character,
          ),
          isValidRange: (document, range) =>
            document.validateRange(range).isEqual(range),
          getText: (document, range) => document.getText(range),
          createWorkspaceEdit: () => new vscode.WorkspaceEdit(),
          replace: (edit, document, range, newText) => {
            edit.replace(document.uri, range, newText);
          },
          applyEdit: edit => vscode.workspace.applyEdit(edit),
        });
      },
    ),
    vscode.commands.registerCommand(
      XAML_COMMANDS.saveGeneratedEventHandler,
      async (documentUri: string) => {
        const uri = vscode.Uri.parse(documentUri);
        const document =
          findOpenDocument(documentUri) ?? (await vscode.workspace.openTextDocument(uri));
        await saveGeneratedEventHandlerDocument(
          document,
          uri.fsPath,
          async (message, action) =>
            (await vscode.window.showWarningMessage(
              message,
              { modal: true },
              action,
            )) === action,
        );
      },
    ),
    vscode.commands.registerCommand(
      APPLY_GENERATED_EVENT_HANDLER_COMMAND,
      async (
        documentUri: string,
        edit: vscode.WorkspaceEdit,
        originalCommand: vscode.Command,
        wasDirty: boolean,
        originalVersion: number | undefined,
      ) => {
        const openDocument = findOpenDocument(documentUri);
        if (wasDirty || openDocument?.isDirty) {
          if (openDocument?.isDirty) {
            await vscode.commands.executeCommand(originalCommand.command, documentUri);
          }
          if (!openDocument?.isDirty) {
            void vscode.window.showInformationMessage(
              "Code-behind changes were saved. Retry Generate Event Handler.",
            );
          }
          return;
        }
        if (openDocument && originalVersion !== undefined && openDocument.version !== originalVersion) {
          void vscode.window.showInformationMessage(
            "The code-behind changed. Retry Generate Event Handler.",
          );
          return;
        }
        if (!(await vscode.workspace.applyEdit(edit))) {
          throw new Error("Could not apply the generated event handler edit.");
        }
        await vscode.commands.executeCommand(originalCommand.command, documentUri);
      },
    ),
    vscode.window.onDidChangeActiveTextEditor(() => renderProjectContextStatus()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(INTELLISENSE_ENABLE_SETTING)) {
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

      if (event.affectsConfiguration(DIAGNOSTICS_LEVEL_SETTING)) {
        const configuredLevel = vscode.workspace
          .getConfiguration(XAML_SETTINGS_SECTION)
          .get<unknown>(DIAGNOSTICS_LEVEL_KEY, "all");
        if (!client?.isRunning()) {
          diagnosticsLevelInteraction.resolve(configuredLevel);
          log("XAML diagnostics level changed — it will apply when the language server is running.");
          return;
        }

        return diagnosticsLevelInteraction.transmit(
          configuredLevel,
          (diagnosticsLevel) => {
            log(`XAML diagnostics level changed to '${diagnosticsLevel}'.`);
            return client!.sendNotification("workspace/didChangeConfiguration", {
              settings: { diagnosticsLevel },
            });
          }
        );
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
        .getConfiguration(XAML_SETTINGS_SECTION)
        .get(INTELLISENSE_ENABLE_KEY, true);
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
    vscode.workspace.getConfiguration(XAML_SETTINGS_SECTION).get(section, defaultValue)
  );
  const activeEditor = vscode.window.activeTextEditor;
  const activeDocumentUri = activeEditor
    ? activeEditor.document.languageId === "xaml"
      ? activeEditor.document.uri.toString()
      : null
    : undefined;
  const projectContext = selectProjectContextStatus(
    getRelevantProjectContextStatuses(
      projectContextStatuses.values(),
      activeDocumentUri
    )
  );
  const status = getXamlStatus(
    configuration.enabled,
    client?.isRunning() ?? false,
    vscode.workspace.isTrusted,
    vscode.workspace.textDocuments.some((document) => document.languageId === "xaml"),
    lastDegradedCause === "dotnet",
    projectContext
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

/** Bridges the Install Tool resolver to the VS Code extension host. */
function createInstallToolHost(): InstallToolHost {
  return {
    isInstalled: () => vscode.extensions.getExtension(DOTNET_INSTALL_TOOL_ID) !== undefined,
    install: async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Setting up .NET tooling for XAML IntelliSense",
        },
        async () => {
          await vscode.commands.executeCommand(
            "workbench.extensions.installExtension",
            DOTNET_INSTALL_TOOL_ID
          );
          await waitForExtensionRegistration(DOTNET_INSTALL_TOOL_ID);
        }
      );
    },
    activate: async () => {
      // The Install Tool activates on startup finished, which has already passed
      // for a mid-session install, so activate it explicitly before its commands
      // are needed.
      const extension = vscode.extensions.getExtension(DOTNET_INSTALL_TOOL_ID);
      if (extension && !extension.isActive) {
        await extension.activate();
      }
    },
    findPath: async (request: DotnetFindPathRequest) =>
      vscode.commands.executeCommand<{ dotnetPath: string } | undefined>(
        EXTERNAL_COMMANDS.dotnetFindPath,
        request
      ),
    log,
    now: () => Date.now(),
  };
}

/** Waits for a freshly installed extension to appear in the registry. */
function waitForExtensionRegistration(id: string, timeoutMs = 15000): Promise<void> {
  if (vscode.extensions.getExtension(id)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      subscription.dispose();
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const subscription = vscode.extensions.onDidChange(() => {
      if (vscode.extensions.getExtension(id)) {
        finish();
      }
    });
  });
}

function requireDotnetHostResolver(): DotnetHostResolver {
  if (!dotnetHostResolver) {
    throw new Error("The XAML .NET host resolver was used before activation completed.");
  }
  return dotnetHostResolver;
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
      // An explicit restart is the user's retry, so re-run host discovery
      // instead of returning the cached answer that may have failed.
      dotnetHostResolver?.invalidate();
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

  const xamlConfiguration = vscode.workspace.getConfiguration(XAML_SETTINGS_SECTION);
  const configuredDiagnosticsLevel = xamlConfiguration.get<unknown>(
    DIAGNOSTICS_LEVEL_KEY,
    "all"
  );
  diagnosticsLevelInteraction.resolve(configuredDiagnosticsLevel);
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
              EXTERNAL_COMMANDS.openSettings,
              INTELLISENSE_ENABLE_SETTING
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

  const resolution =
    process.env.WINUI_XAML_FORCE_NO_DOTNET === "1"
      ? ({ status: "failed", reason: "runtime-not-found" } as const)
      : await requireDotnetHostResolver().resolve();
  if (resolution.status === "failed") {
    const installToolUnavailable = resolution.reason === "install-tool-unavailable";
    notifyDegraded(
      describeDotnetResolutionFailure(resolution.reason),
      installToolUnavailable ? "installTool" : "dotnet",
      userInitiated,
      context
    );
    return;
  }
  const dotnet = resolution.dotnetPath;

  log(`Starting language server: ${dotnet} ${serverPath}`);

  const executable: Executable = {
    command: dotnet,
    args: [serverPath],
    transport: TransportKind.stdio,
    options: {
      cwd: path.dirname(serverPath),
      env: createDotnetChildEnvironment(dotnet, process.env, log),
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
    middleware: {
      provideCodeActions: async (document, range, context, token, next) => {
        const actions = await next(document, range, context, token);
        return actions?.map((action) => {
          if (!(action instanceof vscode.CodeAction) ||
              action.edit === undefined ||
              action.command?.command !== XAML_COMMANDS.saveGeneratedEventHandler ||
              typeof action.command.arguments?.[0] !== "string") {
            return action;
          }

          const documentUri = action.command.arguments[0];
          const target = findOpenDocument(documentUri);
          const recovery = new vscode.CodeAction(
            target?.isDirty
              ? "Save code-behind changes, then retry Generate Event Handler"
              : action.title,
            action.kind,
          );
          recovery.command = {
            command: APPLY_GENERATED_EVENT_HANDLER_COMMAND,
            title: recovery.title,
            arguments: [
              documentUri,
              action.edit,
              action.command,
              target?.isDirty ?? false,
              target?.version,
            ],
          };
          recovery.diagnostics = action.diagnostics;
          recovery.isPreferred = action.isPreferred;
          return recovery;
        });
      },
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
        .getConfiguration(XAML_SETTINGS_SECTION)
        .get(DIAGNOSTICS_LEVEL_KEY, "all")
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
    const resolution = await requireDotnetHostResolver().resolve();
    if (resolution.status === "failed") {
      throw new Error(
        `${describeDotnetResolutionFailure(resolution.reason)} ${
          resolution.reason === "install-tool-unavailable"
            ? "See the WinUI XAML output for details."
            : "Install the .NET 10 runtime, then run restore again."
        }`
      );
    }
    const dotnet = resolution.dotnetPath;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Restoring WinUI project packages",
      },
      () => runDotnetRestore(projectPath, dotnet)
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

function runDotnetRestore(projectPath: string, dotnetPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(dotnetPath, ["restore", projectPath, "--nologo"], {
      cwd: path.dirname(projectPath),
      windowsHide: true,
      env: createDotnetChildEnvironment(dotnetPath, process.env, log),
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
  if (!status.uri || !isProjectContextState(status.state)) {
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
  projectStatusItem.command = XAML_COMMANDS.showOutput;
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
