// Identifiers that must stay in step with package.json, plus the action labels
// shared by the status summary and the degraded-state warning.
//
// This module holds no logic and imports nothing, so any file can depend on it
// without creating a cycle.

/** Configuration section owning every XAML setting. */
export const XAML_SETTINGS_SECTION = "winapp.xaml";

/** Keys within {@link XAML_SETTINGS_SECTION}. */
export const INTELLISENSE_ENABLE_KEY = "intelliSense.enable";
export const DIAGNOSTICS_LEVEL_KEY = "diagnostics.level";

/** Fully qualified setting ids, for APIs that take an absolute path. */
export const INTELLISENSE_ENABLE_SETTING = `${XAML_SETTINGS_SECTION}.${INTELLISENSE_ENABLE_KEY}`;
export const DIAGNOSTICS_LEVEL_SETTING = `${XAML_SETTINGS_SECTION}.${DIAGNOSTICS_LEVEL_KEY}`;

/** Commands contributed by this extension. */
export const XAML_COMMANDS = {
  restartServer: "winui-xaml.restartServer",
  showInfo: "winui-xaml.showInfo",
  showOutput: "winui-xaml.showOutput",
  saveGeneratedEventHandler: "winui-xaml.saveGeneratedEventHandler",
} as const;

/** Commands owned by VS Code or another extension. */
export const EXTERNAL_COMMANDS = {
  openSettings: "workbench.action.openSettings",
  /** Renamed across VS Code versions, so callers try `manageTrust` first. */
  manageTrust: "workbench.trust.manage",
  manageTrustLegacy: "workbench.action.manageTrust",
  searchExtensions: "workbench.extensions.search",
  dotnetFindPath: "dotnet.findPath",
} as const;

export const DOTNET_DOWNLOAD_URL =
  "https://dotnet.microsoft.com/download/dotnet/10.0";

/** Buttons offered by the `winui-xaml.showInfo` status summary. */
export const XAML_STATUS_ACTIONS = {
  openSettings: "Open Settings",
  restartServer: "Restart Language Server",
  manageTrust: "Manage Workspace Trust",
  showOutput: "Show Output",
  installDotnet: "Install .NET",
} as const;

export type XamlStatusAction =
  (typeof XAML_STATUS_ACTIONS)[keyof typeof XAML_STATUS_ACTIONS];

/** Shared dismiss button label, used by every one-time XAML notification. */
export const DISMISS_ACTION_LABEL = "Don't Show Again";

/**
 * Buttons offered by the degraded-state warning. It shares the status actions
 * and adds a few of its own, so typing the label catches a mismatch between the
 * two surfaces at compile time.
 */
export type DegradedActionLabel =
  | XamlStatusAction
  | typeof DISMISS_ACTION_LABEL
  | "Retry"
  | "Install Manually";
