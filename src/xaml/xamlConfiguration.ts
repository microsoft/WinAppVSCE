export type XamlDiagnosticsLevel = "off" | "warning" | "error";
export type XamlDiagnosticsLevelSetting =
  | XamlDiagnosticsLevel
  | "all"
  | "errorsOnly";

export interface XamlLanguageServerConfiguration {
  enabled: boolean;
  initializationOptions: {
    diagnosticsLevel: XamlDiagnosticsLevel;
  };
}

export type XamlStatusAction =
  | "Open Settings"
  | "Restart Language Server"
  | "Manage Workspace Trust"
  | "Show Output"
  | "Install .NET";

export interface XamlStatus {
  message: string;
  actions: XamlStatusAction[];
}

export const DOTNET_REQUIRED_STATUS = {
  text: "$(warning) XAML: .NET 10 required",
  tooltip:
    "WinUI XAML IntelliSense requires .NET 10. Select for install and restart options.",
  command: "winui-xaml.showInfo",
} as const;

export type XamlStatusEffect =
  | { command: string; args?: string[] }
  | { showOutput: true }
  | { url: string };

export function getXamlStatus(
  enabled: boolean,
  running: boolean,
  trusted: boolean,
  hasOpenXamlDocument: boolean,
  requiresDotnet = false
): XamlStatus {
  if (!enabled) {
    return {
      message:
        "WinUI XAML Tools — IntelliSense is disabled in Settings; syntax highlighting remains active.",
      actions: ["Open Settings"],
    };
  }

  if (running) {
    return {
      message: "WinUI XAML Tools — language server running (Host B).",
      actions: [],
    };
  }

  if (!hasOpenXamlDocument) {
    return {
      message:
        "WinUI XAML Tools — ready; the language server starts when a XAML file is opened.",
      actions: [],
    };
  }

  if (requiresDotnet) {
    return {
      message:
        "WinUI XAML Tools — .NET 10 is required; XAML syntax highlighting remains active.",
      actions: ["Install .NET", "Restart Language Server", "Show Output"],
    };
  }

  return {
    message: "WinUI XAML Tools — syntax only; language server not started.",
    actions: [
      trusted ? "Restart Language Server" : "Manage Workspace Trust",
      "Show Output",
    ],
  };
}

export function getXamlStatusEffect(
  action: XamlStatusAction | undefined
): XamlStatusEffect | undefined {
  switch (action) {
    case "Open Settings":
      return {
        command: "workbench.action.openSettings",
        args: ["winapp.xaml.intelliSense.enable"],
      };
    case "Restart Language Server":
      return { command: "winui-xaml.restartServer" };
    case "Manage Workspace Trust":
      return { command: "workbench.trust.manage" };
    case "Show Output":
      return { showOutput: true };
    case "Install .NET":
      return { url: "https://dotnet.microsoft.com/download/dotnet/10.0" };
    default:
      return undefined;
  }
}

export function normalizeDiagnosticsLevel(value: unknown): XamlDiagnosticsLevel {
  if (value === "off") {
    return "off";
  }
  if (value === "error" || value === "errorsOnly") {
    return "error";
  }
  return "warning";
}

export function getDiagnosticsLevelValidationMessage(
  value: unknown
): string | undefined {
  if (
    value === "all" ||
    value === "errorsOnly" ||
    value === "off" ||
    value === "warning" ||
    value === "error"
  ) {
    return undefined;
  }

  return `Invalid winapp.xaml.diagnostics.level value '${String(
    value
  )}'. Using 'all'; choose all, errorsOnly, or off.`;
}

export function readXamlLanguageServerConfiguration(
  get: <T>(section: string, defaultValue: T) => T
): XamlLanguageServerConfiguration {
  return {
    enabled: get("intelliSense.enable", true),
    initializationOptions: {
      diagnosticsLevel: normalizeDiagnosticsLevel(
        get("diagnostics.level", "all")
      ),
    },
  };
}

export function shouldRestartXamlLanguageServer(
  hasClient: boolean,
  hasOpenXamlDocument: boolean
): boolean {
  return hasClient || hasOpenXamlDocument;
}
