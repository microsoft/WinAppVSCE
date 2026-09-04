// Kept independent of the VS Code API for unit testing.

import { DOTNET_INSTALL_TOOL_ID } from "./dotnetInstallTool";

/** Why the language server is not running. */
export type DegradedCause = "untrusted" | "dotnet" | "installTool" | "server";

/** Settings query for the degraded-state action. */
export const SERVER_SETTINGS_QUERY = "winapp.xaml";
export const DOTNET_RUNTIME_DISMISSED_KEY = "winui-xaml.dotnetRuntimeRequirementDismissed";
export const DOTNET_DOWNLOAD_URL = "https://dotnet.microsoft.com/download/dotnet/10.0";

/** An action displayed in the degraded-state warning. */
export interface DegradedAction {
  /** Button label. */
  readonly label: string;
  /** VS Code command id to execute. */
  readonly command?: string;
  /** Command id tried if {@link command} fails (VS Code renamed it across versions). */
  readonly fallbackCommand?: string;
  /** Optional single argument passed to {@link command}. */
  readonly commandArg?: string;
  /** External URL to open in the browser. */
  readonly url?: string;
  /** Reveal the WinUI XAML output channel. */
  readonly showOutput?: boolean;
  /** Persist that the user dismissed the missing-runtime prompt. */
  readonly dismissDotnetRequirement?: boolean;
}

export interface DegradedNotification {
  readonly message: string;
  readonly actions: readonly DegradedAction[];
}

/** Builds a warning for a degradation cause. */
export function buildDegradedNotification(
  cause: DegradedCause,
  detail?: string
): DegradedNotification {
  if (cause === "untrusted") {
    return {
      message:
        "WinUI XAML: workspace is not trusted. The language server is disabled and XAML is " +
        "syntax-only. IntelliSense, diagnostics, and navigation are unavailable until you trust " +
        "this workspace.",
      actions: [
        {
          label: "Manage Workspace Trust",
          command: "workbench.trust.manage",
          fallbackCommand: "workbench.action.manageTrust",
        },
      ],
    };
  }

  if (cause === "dotnet") {
    return {
      message:
        "WinUI XAML IntelliSense requires the .NET 10 runtime, but a compatible installation " +
        "was not found. XAML syntax highlighting remains available. After installing .NET, run " +
        "WinApp: Restart Language Server.",
      actions: [
        { label: "Install .NET", url: DOTNET_DOWNLOAD_URL },
        { label: "Don't Show Again", dismissDotnetRequirement: true },
      ],
    };
  }

  // Distinct from "dotnet": the runtime may well be installed. We could not set
  // up the tool that locates it, so telling the user to install .NET would be
  // wrong advice. The remedy is a retry, or making the marketplace reachable.
  if (cause === "installTool") {
    return {
      message:
        "WinUI XAML IntelliSense uses the .NET Install Tool " +
        `(${DOTNET_INSTALL_TOOL_ID}) to locate the .NET 10 runtime, and it could not be ` +
        "installed or queried. This usually means the Marketplace is unavailable or blocked " +
        "by policy. XAML syntax highlighting remains available.",
      actions: [
        { label: "Retry", command: "winui-xaml.restartServer" },
        {
          label: "Install Manually",
          command: "workbench.extensions.search",
          commandArg: DOTNET_INSTALL_TOOL_ID,
        },
        { label: "Show Output", showOutput: true },
      ],
    };
  }

  return {
    message:
      "WinUI XAML: language server not started. XAML is syntax-only. " +
      "IntelliSense, diagnostics, and navigation are unavailable." +
      (detail ? ` ${detail}` : ""),
    actions: [
      { label: "Restart Language Server", command: "winui-xaml.restartServer" },
      { label: "Open Settings", command: "workbench.action.openSettings", commandArg: SERVER_SETTINGS_QUERY },
      { label: "Show Output", showOutput: true },
    ],
  };
}

export interface DegradedActionHandlers {
  readonly dismissDotnetRequirement: () => Thenable<unknown>;
  readonly showOutput: () => void;
  readonly openUrl: (url: string) => Thenable<unknown>;
  readonly executeCommand: (command: string, commandArg?: string) => Thenable<unknown>;
}

/** Determines whether a degraded warning should interrupt the user. */
export function shouldShowDegradedNotification(
  cause: DegradedCause,
  previousCause: DegradedCause | undefined,
  dotnetRequirementDismissed: boolean,
  forceNotification: boolean
): boolean {
  if (forceNotification) {
    return true;
  }
  return cause !== previousCause &&
    !(cause === "dotnet" && dotnetRequirementDismissed);
}

/** Executes a degraded action through injected host operations. */
export function executeDegradedAction(
  action: DegradedAction,
  handlers: DegradedActionHandlers
): Thenable<unknown> | void {
  if (action.dismissDotnetRequirement) {
    return handlers.dismissDotnetRequirement();
  }
  if (action.showOutput) {
    handlers.showOutput();
    return;
  }
  if (action.url) {
    return handlers.openUrl(action.url);
  }
  if (action.command) {
    const primary = handlers.executeCommand(action.command, action.commandArg);
    return Promise.resolve(primary).then(undefined, () =>
      action.fallbackCommand
        ? handlers.executeCommand(action.fallbackCommand)
        : undefined
    );
  }
}
