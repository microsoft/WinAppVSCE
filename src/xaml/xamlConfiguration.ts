import {
  DIAGNOSTICS_LEVEL_KEY,
  DIAGNOSTICS_LEVEL_SETTING,
  DOTNET_DOWNLOAD_URL,
  EXTERNAL_COMMANDS,
  INTELLISENSE_ENABLE_KEY,
  INTELLISENSE_ENABLE_SETTING,
  XAML_COMMANDS,
  XAML_INTELLISENSE_UNAVAILABLE_PREFIX,
  XAML_STATUS_ACTIONS,
  XAML_STATUS_PREFIX,
  XamlStatusAction,
} from "./xamlConstants";
import {
  PROJECT_CONTEXT_ERROR_FALLBACK_MESSAGE,
  PROJECT_CONTEXT_FRAMEWORK_READY_MESSAGE,
  PROJECT_CONTEXT_LOADING_MESSAGE,
  ProjectContextState,
} from "./projectContextStatus";

export type { XamlStatusAction };

export type XamlDiagnosticsLevel = "off" | "all" | "errorsOnly";

export interface DiagnosticsLevelInteractionHost {
  log(message: string): void;
  showWarningMessage(
    message: string,
    action: typeof XAML_STATUS_ACTIONS.openSettings
  ): PromiseLike<string | undefined>;
  openSettings(): PromiseLike<unknown>;
}

export interface XamlLanguageServerConfiguration {
  enabled: boolean;
  initializationOptions: {
    diagnosticsLevel: XamlDiagnosticsLevel;
  };
}

export interface XamlStatus {
  message: string;
  actions: XamlStatusAction[];
}

export interface XamlProjectContextSummary {
  state: ProjectContextState;
  message?: string;
}

export const DOTNET_REQUIRED_STATUS = {
  text: "$(warning) XAML: .NET 10 required",
  tooltip:
    "WinUI XAML IntelliSense requires .NET 10. Select for install and restart options.",
  command: XAML_COMMANDS.showInfo,
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
  requiresDotnet = false,
  projectContext?: XamlProjectContextSummary
): XamlStatus {
  if (!enabled) {
    return {
      message:
        `${XAML_STATUS_PREFIX} IntelliSense is disabled in Settings; syntax highlighting remains active.`,
      actions: [XAML_STATUS_ACTIONS.openSettings],
    };
  }

  if (running) {
    if (projectContext?.state === "error") {
      return {
        message: `${XAML_INTELLISENSE_UNAVAILABLE_PREFIX} ${
          projectContext.message ?? PROJECT_CONTEXT_ERROR_FALLBACK_MESSAGE
        }`,
        actions: [
          XAML_STATUS_ACTIONS.restartServer,
          XAML_STATUS_ACTIONS.showOutput,
        ],
      };
    }
    if (projectContext?.state === "loading") {
      return {
        message: `${XAML_STATUS_PREFIX} ${PROJECT_CONTEXT_LOADING_MESSAGE}`,
        actions: [XAML_STATUS_ACTIONS.showOutput],
      };
    }
    if (projectContext?.state === "framework-ready") {
      return {
        message: `${XAML_STATUS_PREFIX} ${PROJECT_CONTEXT_FRAMEWORK_READY_MESSAGE}`,
        actions: [XAML_STATUS_ACTIONS.showOutput],
      };
    }
    return {
      message: `${XAML_STATUS_PREFIX} language server running.`,
      actions: [],
    };
  }

  if (!hasOpenXamlDocument) {
    return {
      message:
        `${XAML_STATUS_PREFIX} ready; the language server starts when a XAML file is opened.`,
      actions: [],
    };
  }

  if (requiresDotnet) {
    return {
      message:
        `${XAML_STATUS_PREFIX} .NET 10 is required; XAML syntax highlighting remains active.`,
      actions: [
        XAML_STATUS_ACTIONS.installDotnet,
        XAML_STATUS_ACTIONS.restartServer,
        XAML_STATUS_ACTIONS.showOutput,
      ],
    };
  }

  return {
    message: `${XAML_STATUS_PREFIX} syntax only; language server not started.`,
    actions: [
      trusted
        ? XAML_STATUS_ACTIONS.restartServer
        : XAML_STATUS_ACTIONS.manageTrust,
      XAML_STATUS_ACTIONS.showOutput,
    ],
  };
}

export function getXamlStatusEffect(
  action: XamlStatusAction | undefined
): XamlStatusEffect | undefined {
  switch (action) {
    case XAML_STATUS_ACTIONS.openSettings:
      return {
        command: EXTERNAL_COMMANDS.openSettings,
        args: [INTELLISENSE_ENABLE_SETTING],
      };
    case XAML_STATUS_ACTIONS.restartServer:
      return { command: XAML_COMMANDS.restartServer };
    case XAML_STATUS_ACTIONS.manageTrust:
      return { command: EXTERNAL_COMMANDS.manageTrust };
    case XAML_STATUS_ACTIONS.showOutput:
      return { showOutput: true };
    case XAML_STATUS_ACTIONS.installDotnet:
      return { url: DOTNET_DOWNLOAD_URL };
    default:
      return undefined;
  }
}

export function normalizeDiagnosticsLevel(value: unknown): XamlDiagnosticsLevel {
  if (value === "off") {
    return "off";
  }
  if (value === "errorsOnly") {
    return "errorsOnly";
  }
  return "all";
}

export function getDiagnosticsLevelValidationMessage(
  value: unknown
): string | undefined {
  if (value === "all" || value === "errorsOnly" || value === "off") {
    return undefined;
  }

  return `Invalid ${DIAGNOSTICS_LEVEL_SETTING} value '${String(
    value
  )}'. Using 'all'; choose all, errorsOnly, or off.`;
}

export class DiagnosticsLevelInteraction {
  private lastInvalidValue: string | undefined;

  constructor(private readonly host: DiagnosticsLevelInteractionHost) {}

  resolve(value: unknown): XamlDiagnosticsLevel {
    const message = getDiagnosticsLevelValidationMessage(value);
    if (!message) {
      this.lastInvalidValue = undefined;
      return normalizeDiagnosticsLevel(value);
    }

    this.host.log(message);
    const key = String(value);
    if (this.lastInvalidValue !== key) {
      this.lastInvalidValue = key;
      void Promise.resolve(
        this.host.showWarningMessage(message, XAML_STATUS_ACTIONS.openSettings)
      ).then((choice) => {
        if (choice === XAML_STATUS_ACTIONS.openSettings) {
          return this.host.openSettings();
        }
        return undefined;
      });
    }

    return "all";
  }

  async transmit(
    value: unknown,
    send: (level: XamlDiagnosticsLevel) => PromiseLike<unknown>
  ): Promise<void> {
    await send(this.resolve(value));
  }
}

export function readXamlLanguageServerConfiguration(
  get: <T>(section: string, defaultValue: T) => T
): XamlLanguageServerConfiguration {
  return {
    enabled: get(INTELLISENSE_ENABLE_KEY, true),
    initializationOptions: {
      diagnosticsLevel: normalizeDiagnosticsLevel(
        get(DIAGNOSTICS_LEVEL_KEY, "all")
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
