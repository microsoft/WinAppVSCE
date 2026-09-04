export const PROJECT_CONTEXT_STATUS_NOTIFICATION = "winui-xaml/projectContextStatus";

/**
 * The single source of truth for project-context states. The runtime array and
 * the type are derived from one another, so a new state cannot be added to one
 * without the other.
 */
export const PROJECT_CONTEXT_STATES = [
  "loading",
  "framework-ready",
  "ready",
  "error",
  "idle",
] as const;

export type ProjectContextState = (typeof PROJECT_CONTEXT_STATES)[number];

/** Narrows an untrusted value (server notification payload) to a known state. */
export function isProjectContextState(
  value: unknown
): value is ProjectContextState {
  return PROJECT_CONTEXT_STATES.includes(value as ProjectContextState);
}

/**
 * Shared wording for the project-context states. The status bar and the
 * `winui-xaml.showInfo` summary describe the same conditions, so they compose
 * these sentences rather than each spelling them out.
 */
export const PROJECT_CONTEXT_LOADING_MESSAGE =
  "Loading authoritative project metadata.";
export const PROJECT_CONTEXT_FRAMEWORK_READY_MESSAGE =
  "Framework IntelliSense is available. Project symbols and diagnostics are still loading.";
export const PROJECT_CONTEXT_ERROR_FALLBACK_MESSAGE =
  "Project IntelliSense failed to load.";
export const SHOW_XAML_OUTPUT_HINT =
  "Click to show the WinUI XAML output.";

export interface ProjectContextStatus {
  uri: string;
  state: ProjectContextState;
  message?: string;
}

export interface ProjectContextStatusPresentation {
  text: string;
  tooltip: string;
  transient: boolean;
}

export function getRelevantProjectContextStatuses(
  statuses: Iterable<ProjectContextStatus>,
  activeDocumentUri: string | null | undefined
): ProjectContextStatus[] {
  const values = [...statuses];
  if (activeDocumentUri === undefined) {
    return values;
  }
  if (activeDocumentUri === null) {
    return [];
  }
  return values.filter((status) => status.uri === activeDocumentUri);
}

export function selectProjectContextStatus(
  statuses: Iterable<ProjectContextStatus>
): ProjectContextStatus | undefined {
  const values = [...statuses];
  return (
    values.find((status) => status.state === "error") ??
    values.find((status) => status.state === "loading") ??
    values.find((status) => status.state === "framework-ready") ??
    values.find((status) => status.state === "ready")
  );
}

export function getProjectContextStatusPresentation(
  status: ProjectContextStatus
): ProjectContextStatusPresentation | undefined {
  switch (status.state) {
    case "error":
      return {
        text: "$(warning) WinApp: XAML IntelliSense unavailable",
        tooltip: `${status.message ?? PROJECT_CONTEXT_ERROR_FALLBACK_MESSAGE} ${SHOW_XAML_OUTPUT_HINT}`,
        transient: false,
      };
    case "loading":
      return {
        text: "$(sync~spin) WinApp: XAML IntelliSense loading",
        tooltip: `${PROJECT_CONTEXT_LOADING_MESSAGE} ${SHOW_XAML_OUTPUT_HINT}`,
        transient: false,
      };
    case "framework-ready":
      return {
        text: "$(sync~spin) WinApp: XAML project loading",
        tooltip: PROJECT_CONTEXT_FRAMEWORK_READY_MESSAGE,
        transient: false,
      };
    case "ready":
      return {
        text: "$(check) WinApp: XAML IntelliSense ready",
        tooltip: "Project-aware XAML IntelliSense is ready.",
        transient: true,
      };
    case "idle":
      return undefined;
  }
}
