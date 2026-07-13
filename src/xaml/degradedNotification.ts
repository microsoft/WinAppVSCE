// Pure decision logic for the WinUI XAML "degraded to syntax-only" notification. Kept free of any
// `vscode` import so it can be unit-tested under `tsx --test` (no VS Code host). The runtime wiring
// lives in xamlLanguageService.ts (notifyDegraded), which maps each returned action to a concrete
// vscode command / external URL / output-channel reveal.

/**
 * Why the language server is not running:
 *  - "untrusted": the workspace is not trusted, so the semantic server is intentionally disabled.
 *  - "server": the server could not be located or launched (missing DLL, bad dotnet path, etc.).
 */
export type DegradedCause = "untrusted" | "server";

/** The .NET runtime download page offered by the "Install .NET" action. */
export const DOTNET_DOWNLOAD_URL = "https://dotnet.microsoft.com/download";

/** Settings query the "Open Settings" action focuses (the WinUI XAML server settings). */
export const SERVER_SETTINGS_QUERY = "winui-xaml.server";

/**
 * A single actionable button on the degraded warning. Exactly one of {@link command}, {@link url},
 * or {@link showOutput} describes what the button does when clicked.
 */
export interface DegradedAction {
  /** Button label shown to the user (also used to match the user's choice). */
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

/**
 * Builds the warning message and action buttons for a degradation {@link DegradedCause}. Pure: no
 * side effects, deterministic, and independent of the VS Code API.
 */
export function buildDegradedNotification(cause: DegradedCause): DegradedNotification {
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
      "IntelliSense, diagnostics, and navigation are unavailable.",
    actions: [
      { label: "Open Settings", command: "workbench.action.openSettings", commandArg: SERVER_SETTINGS_QUERY },
      { label: "Show Output", showOutput: true },
      { label: "Install .NET", url: DOTNET_DOWNLOAD_URL },
    ],
  };
}
