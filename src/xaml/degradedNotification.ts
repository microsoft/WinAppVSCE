// Kept independent of the VS Code API for unit testing.

import {
  DOTNET_DOWNLOAD_URL,
  DegradedActionLabel,
  EXTERNAL_COMMANDS,
  XAML_COMMANDS,
  XAML_SETTINGS_SECTION,
} from "./xamlConstants";

/** Why the language server is not running. The server is self-contained, so .NET is not a cause. */
export type DegradedCause = "untrusted" | "server";

/** Settings query for the degraded-state action. */
export const SERVER_SETTINGS_QUERY = XAML_SETTINGS_SECTION;
export { DOTNET_DOWNLOAD_URL };

/** An action displayed in the degraded-state warning. */
export interface DegradedAction {
  /** Button label. */
  readonly label: DegradedActionLabel;
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
          command: EXTERNAL_COMMANDS.manageTrust,
          fallbackCommand: EXTERNAL_COMMANDS.manageTrustLegacy,
        },
      ],
    };
  }

  return {
    message:
      "WinUI XAML: language server not started. XAML is syntax-only. " +
      "IntelliSense, diagnostics, and navigation are unavailable." +
      (detail ? ` ${detail}` : ""),
    actions: [
      { label: "Restart Language Server", command: XAML_COMMANDS.restartServer },
      { label: "Open Settings", command: EXTERNAL_COMMANDS.openSettings, commandArg: SERVER_SETTINGS_QUERY },
      { label: "Show Output", showOutput: true },
    ],
  };
}

export interface DegradedActionHandlers {
  readonly showOutput: () => void;
  readonly openUrl: (url: string) => Thenable<unknown>;
  readonly executeCommand: (command: string, commandArg?: string) => Thenable<unknown>;
}

/** Determines whether a degraded warning should interrupt the user. */
export function shouldShowDegradedNotification(
  cause: DegradedCause,
  previousCause: DegradedCause | undefined,
  forceNotification: boolean
): boolean {
  return forceNotification || cause !== previousCause;
}

/** Executes a degraded action through injected host operations. */
export function executeDegradedAction(
  action: DegradedAction,
  handlers: DegradedActionHandlers
): Thenable<unknown> | void {
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
