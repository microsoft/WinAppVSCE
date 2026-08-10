// Kept independent of the VS Code API for unit testing.

/** Why the language server is not running. */
export type DegradedCause = "untrusted" | "server";

/** Settings query for the degraded-state action. */
export const SERVER_SETTINGS_QUERY = "winui-xaml.server";

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
        "WinUI XAML: workspace is not trusted — the language server is disabled and XAML is " +
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

  return {
    message:
      "WinUI XAML: language server not started — XAML is syntax-only. " +
      "IntelliSense, diagnostics, and navigation are unavailable." +
      (detail ? ` ${detail}` : ""),
    actions: [
      { label: "Open Settings", command: "workbench.action.openSettings", commandArg: SERVER_SETTINGS_QUERY },
      { label: "Show Output", showOutput: true },
    ],
  };
}
