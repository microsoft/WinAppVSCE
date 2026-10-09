import * as path from "path";
import * as vscode from "vscode";
import {
  applyGeneratedEventHandlerEdit,
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
import { notificationDismissal } from "./notificationDismissal";
import { createDotnetChildEnvironment, resolveDotnetCommand } from "./dotnetRuntime";
import {
  DIAGNOSTICS_LEVEL_KEY,
  DIAGNOSTICS_LEVEL_SETTING,
  DOTNET_DOWNLOAD_URL,
  EXTERNAL_COMMANDS,
  INTELLISENSE_ENABLE_KEY,
  INTELLISENSE_ENABLE_SETTING,
  XAML_COMMANDS,
  XAML_SETTINGS_SECTION,
  XAML_STATUS_ACTIONS,
} from "./xamlConstants";
import { ServerLifecycle } from "./serverLifecycle";
import {
  isEnterEdit,
  shouldTriggerAutomaticXamlSuggestions,
} from "./attributeSuggestionTrigger";
import {
  PROJECT_RESTORE_ACTIONS,
  PROJECT_RESTORE_NOTIFICATION,
  notifyProjectRestoreRequired as runProjectRestoreNotification,
} from "./projectRestoreNotification";
import {
  PROJECT_BUILD_ACTIONS,
  PROJECT_BUILD_NOTIFICATION,
  notifyProjectBuildRequired as runProjectBuildNotification,
} from "./projectBuildNotification";
import {
  PROJECT_CONTEXT_DOTNET_SDK_REQUIRED_MESSAGE,
  PROJECT_CONTEXT_STATUS_NOTIFICATION,
  ProjectContextStatus,
  getRelevantProjectContextStatuses,
  getProjectContextStatusPresentation,
  isProjectContextState,
  selectProjectContextStatus,
  shouldReplaceProjectContextStatus,
} from "./projectContextStatus";
import {
  normalizeDiagnosticsLevel,
  DiagnosticsLevelInteraction,
  getXamlStatus,
  getXamlStatusEffect,
  readXamlLanguageServerConfiguration,
  shouldRestartXamlLanguageServer,
  XamlStatusAction,
} from "./xamlConfiguration";
import { hasOpenXamlDocument } from "./xamlDemand";
import { serverRidFor } from "./serverRid";
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
/** Restores currently running; counted per reported project because the status bar shows whichever document is active. */
let restoresInFlight = 0;
const projectContextStatuses = new Map<string, ProjectContextStatus>();

// The client does not own caller-supplied watchers.
let fileWatchers: vscode.FileSystemWatcher[] = [];

// Serialize lifecycle operations so starts and stops cannot overlap.
const lifecycle = new ServerLifecycle();

// Track each degraded cause once until the next successful start.
let lastDegradedCause: DegradedCause | undefined;

const csharpDevKitNotificationGate = new CsharpDevKitNotificationGate();
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
      ) =>
        applyGeneratedEventHandlerEdit(
          documentUri,
          edit,
          originalCommand,
          wasDirty,
          originalVersion,
          {
            getTarget: (uri) => findOpenDocument(uri),
            applyEdit: (workspaceEdit) => vscode.workspace.applyEdit(workspaceEdit),
            runCommand: (command, uri) =>
              vscode.commands.executeCommand(command, uri),
            showInformationMessage: (message) => {
              void vscode.window.showInformationMessage(message);
            },
          },
        ),
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
      if (!enabled || (change.text !== "<" && !isEnterEdit(change.text))) {
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
    projectContext
      ? { ...projectContext, restoreInFlight: restoresInFlight > 0 }
      : undefined
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

  const dismissal = notificationDismissal(CSHARP_DEV_KIT_DISMISSED_KEY, context.globalState);
  const installed = vscode.extensions.getExtension(CSHARP_DEV_KIT_EXTENSION_ID) !== undefined;
  if (
    !csharpDevKitNotificationGate.shouldShow(
      document.uri.fsPath,
      installed,
      dismissal.isDismissed
    )
  ) {
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
        await dismissal.dismiss();
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

  // The shipped server is a Windows-only native binary; elsewhere the .exe exists but spawn fails with ENOEXEC.
  // Gate explicitly so users see unsupported-platform wording, not a generic failed-to-start error.
  // WINUI_XAML_SERVER_PATH bypasses this for contributor framework-dependent .dlls that run under dotnet cross-platform.
  if (!process.env.WINUI_XAML_SERVER_PATH && !serverRidFor(process.platform, process.arch)) {
    notifyDegraded(
      `WinUI XAML language support requires Windows on x64 or ARM64 (this host is ${process.platform}-${process.arch}). ` +
        "Syntax highlighting remains available.",
      "server",
      userInitiated,
      context
    );
    return;
  }

  const serverPath = resolveServerPath(context);
  if (!serverPath) {
    notifyDegraded(
      "Bundled WinUI XAML language server executable not found. IntelliSense, diagnostics, and navigation are unavailable; " +
        "syntax highlighting remains available.",
      "server",
      userInitiated,
      context
    );
    return;
  }

  // The Native AOT server is self-contained, so nothing about .NET gates its launch. Only a
  // contributor-supplied framework-dependent .dll runs under `dotnet`.
  const isNativeServer = serverPath.toLowerCase().endsWith(".exe");
  const dotnet = resolveDotnetCommand(process.env, log);

  let command = serverPath;
  let args: string[] = [];
  if (!isNativeServer) {
    if (dotnet === undefined) {
      notifyDegraded(
        `The language server at ${serverPath} is framework-dependent and no .NET host was found. ` +
          "Publish the Native AOT server or install the .NET SDK; syntax highlighting remains available.",
        "server",
        userInitiated,
        context
      );
      return;
    }
    command = dotnet;
    args = [serverPath];
  }

  log(
    isNativeServer
      ? `Starting language server: ${serverPath} (native, self-contained)`
      : `Starting language server: ${command} ${serverPath}`
  );

  const executable: Executable = {
    command,
    args,
    transport: TransportKind.stdio,
    options: {
      cwd: path.dirname(serverPath),
      env: createDotnetChildEnvironment(dotnet, process.env),
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
    PROJECT_BUILD_NOTIFICATION,
    ({
      projectPath,
      unresolvedAssemblies,
    }: {
      projectPath?: string;
      unresolvedAssemblies?: string[];
    }) => notifyProjectBuildRequired(projectPath, unresolvedAssemblies)
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
      // Name the executable that was actually launched. For the AOT server this is the native
      // binary, and blaming `dotnet` for its spawn failure sends triage to the wrong process.
      `Failed to start language server (${isNativeServer ? serverPath : dotnet}): ${detail}. ` +
        "Syntax highlighting remains available.",
      "server",
      userInitiated,
      context
    );
  }
}

function notifyProjectRestoreRequired(projectPath: string | undefined): void {
  void runProjectRestoreNotification(projectPath, {
    isTrustedWorkspaceProject,
    restoreProject,
  });
}

function notifyProjectBuildRequired(
  projectPath: string | undefined,
  unresolvedAssemblies: string[] | undefined
): void {
  void runProjectBuildNotification(projectPath, unresolvedAssemblies, {
    isTrustedWorkspaceProject,
    showWarningMessage: (message, ...actions) =>
      vscode.window.showWarningMessage(message, ...actions),
    showOutput: () => output?.show(true),
    buildProject: (projectPath) => void runProjectBuild(projectPath),
  });
}

// Builds in a visible task terminal: it is the user's action, build errors surface there, and existing outputs let the server re-resolve on next request.
// Pass the project as a ProcessExecution argument, not shell text, so PowerShell cannot expand `$(...)` or backticks in a server-reported path.
async function runProjectBuild(projectPath: string): Promise<void> {
  const dotnet = resolveDotnetCommand();
  if (dotnet === undefined) {
    reportMissingDotnetSdk("build");
    return;
  }
  const task = new vscode.Task(
    { type: "winapp-xaml-build" },
    vscode.TaskScope.Workspace,
    "Build",
    "WinApp",
    new vscode.ProcessExecution(dotnet, ["build", projectPath], {
      cwd: path.dirname(projectPath),
      env: toTaskEnvironment(createDotnetChildEnvironment(dotnet, process.env)),
    })
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
    clear: true,
  };

  // A rejected executeTask is the one remaining way this can fail silently: the task is
  // well-formed, but VS Code can still decline to start it.
  void Promise.resolve(vscode.tasks.executeTask(task)).then(
    (execution) => watchProjectBuildCompletion(execution, projectPath),
    (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      log(`Project build task could not start: ${detail}`);
      void vscode.window.showErrorMessage(`WinUI project build could not start: ${detail}`);
    }
  );
}

// A successful build writes only under bin/obj, which the server ignores, so nothing would tell it
// the references it reported as unbuilt now exist. Naming the project file is the same signal a
// .csproj edit sends, and it is what clears the build-required status without a restart.
function watchProjectBuildCompletion(
  execution: vscode.TaskExecution,
  projectPath: string
): void {
  const subscription = vscode.tasks.onDidEndTaskProcess((event) => {
    if (event.execution !== execution) {
      return;
    }

    subscription.dispose();
    if (event.exitCode !== 0) {
      return;
    }

    log(`Project build completed: ${projectPath}. Reloading project metadata.`);
    void client?.sendNotification("workspace/didChangeWatchedFiles", {
      changes: [{ uri: vscode.Uri.file(projectPath).toString(), type: 2 }],
    });
  });
}

/** Converts a process env to ProcessExecution's string map, dropping undefined values like direct spawn would. */
function toTaskEnvironment(env: NodeJS.ProcessEnv): { [key: string]: string } {
  const result: { [key: string]: string } = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
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

// Launching a bare `dotnet` here would let the project directory, which is the working directory,
// satisfy the lookup, so an unresolved host is reported instead of run.
function reportMissingDotnetSdk(operation: string): void {
  log(`No .NET SDK found on PATH; skipping project ${operation}.`);
  void vscode.window
    .showErrorMessage(
      `WinUI project ${operation} needs the .NET SDK. ${PROJECT_CONTEXT_DOTNET_SDK_REQUIRED_MESSAGE}`,
      XAML_STATUS_ACTIONS.installDotnet
    )
    .then((choice) => {
      if (choice === XAML_STATUS_ACTIONS.installDotnet) {
        void vscode.env.openExternal(vscode.Uri.parse(DOTNET_DOWNLOAD_URL));
      }
    });
}

async function restoreProject(projectPath: string): Promise<void> {
  const dotnet = resolveDotnetCommand();
  if (dotnet === undefined) {
    reportMissingDotnetSdk("package restore");
    return;
  }

  log(`Restoring project packages: ${projectPath}`);
  restoresInFlight += 1;
  renderProjectContextStatus();

  try {
    await runDotnetRestore(projectPath, dotnet);
    log("Project package restore completed. IntelliSense metadata is reloading.");
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
  } finally {
    restoresInFlight -= 1;
    renderProjectContextStatus();
  }
}

function runDotnetRestore(projectPath: string, dotnetPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(dotnetPath, ["restore", projectPath, "--nologo"], {
      cwd: path.dirname(projectPath),
      windowsHide: true,
      env: createDotnetChildEnvironment(dotnetPath, process.env),
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
  } else if (
    shouldReplaceProjectContextStatus(
      projectContextStatuses.get(status.uri),
      status
    )
  ) {
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
  const relevantStatuses = getRelevantProjectContextStatuses(
    projectContextStatuses.values(),
    activeDocumentUri
  );
  const selected = selectProjectContextStatus(relevantStatuses);
  const presentation = selected
    ? getProjectContextStatusPresentation(selected, {
        restoreInFlight: restoresInFlight > 0,
      })
    : undefined;
  if (!projectStatusItem || !selected || !presentation) {
    projectStatusItem?.hide();
    return;
  }

  projectStatusItem.text = presentation.text;
  projectStatusItem.tooltip = presentation.tooltip;
  projectStatusItem.command = presentation.command ?? XAML_COMMANDS.showOutput;
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
    // dispose(), not stop(): stop() leaves the document-sync features registered, so a debounced
    // didChange can still fire against the torn-down client and throw inside its Delayer.
    await current.dispose();
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
    showOutput: () => output?.show(true),
    openUrl: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
    executeCommand: (command, commandArg) =>
      commandArg === undefined
        ? vscode.commands.executeCommand(command)
        : vscode.commands.executeCommand(command, commandArg),
  });
}

/** Locates the bundled Native AOT server executable, or a development-only override. */
function resolveServerPath(context: vscode.ExtensionContext): string | undefined {
  // Exercise missing-server degradation in the integration harness.
  if (process.env.WINUI_XAML_FORCE_NO_SERVER === "1") {
    return undefined;
  }
  const configured = process.env.WINUI_XAML_SERVER_PATH;
  const bundled = bundledServer(context);
  const candidates =
    process.env.WINUI_XAML_REQUIRE_BUNDLED === "1"
      ? [bundled]
      : configured
        ? [configured, bundled]
        : [bundled];
  // The bundled server is a native .exe; an override may still be a framework-dependent .dll,
  // which is how local debug builds and the smoke harness run it.
  return firstExistingPath(
    candidates.filter(
      (candidate): candidate is string =>
        candidate !== undefined && [".exe", ".dll"].includes(path.extname(candidate).toLowerCase())
    )
  );
}

/** The architecture-specific Native AOT server under dist/server/win-<arch>/, or undefined when
 * this host has no bundled binary: an override must not fall back to a foreign-architecture exe. */
function bundledServer(context: vscode.ExtensionContext): string | undefined {
  const rid = serverRidFor(process.platform, process.arch);
  return rid === undefined
    ? undefined
    : path.join(context.extensionPath, "dist", "server", rid, "WinUiXaml.LanguageServer.exe");
}
