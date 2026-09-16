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
  "reference-build-failed",
  "packages-not-restored",
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
  "Loading the WinUI and package types for this project.";
export const PROJECT_CONTEXT_FRAMEWORK_READY_MESSAGE =
  "WinUI and package types are available. Your project's own types, x:Bind members, and diagnostics are still loading.";
export const PROJECT_CONTEXT_ERROR_FALLBACK_MESSAGE =
  "Project IntelliSense failed to load.";
export const PROJECT_CONTEXT_REFERENCE_BUILD_FAILED_FALLBACK_MESSAGE =
  "A referenced project could not be built, so the types it defines are unavailable.";
export const PROJECT_CONTEXT_PACKAGES_NOT_RESTORED_FALLBACK_MESSAGE =
  "Restore the project's packages so its references resolve.";
export const PROJECT_CONTEXT_RESTORING_MESSAGE =
  "Restoring the project's packages. Project-aware IntelliSense resumes when it completes.";
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

/** Durable project-on-disk states; a reload starting does not prove the developer-fixed condition stopped being true. */
const DURABLE_STATES: readonly ProjectContextState[] = [
  "reference-build-failed",
  "packages-not-restored",
];

/** Decides whether incoming status replaces current; suppresses transient reload `loading` over durable states while still accepting real recovery states immediately. */
export function shouldReplaceProjectContextStatus(
  current: ProjectContextStatus | undefined,
  incoming: ProjectContextStatus
): boolean {
  if (!current) {
    return true;
  }
  if (incoming.state !== "loading") {
    return true;
  }
  return !DURABLE_STATES.includes(current.state);
}

export function selectProjectContextStatus(
  statuses: Iterable<ProjectContextStatus>
): ProjectContextStatus | undefined {
  const values = [...statuses];
  return (
    // Restore precedes build: an unrestored project cannot be built, so when both conditions are
    // present, naming the build is telling the developer to do the step that will fail.
    values.find((status) => status.state === "packages-not-restored") ??
    values.find((status) => status.state === "reference-build-failed") ??
    values.find((status) => status.state === "error") ??
    values.find((status) => status.state === "loading") ??
    values.find((status) => status.state === "framework-ready") ??
    values.find((status) => status.state === "ready")
  );
}

/**
 * Conditions the extension is already acting on, which change what a state means to the reader.
 */
export interface ProjectContextStatusContext {
  /** True while the extension is running `dotnet restore` for the project. */
  restoreInFlight?: boolean;
}

export function getProjectContextStatusPresentation(
  status: ProjectContextStatus,
  context: ProjectContextStatusContext = {}
): ProjectContextStatusPresentation | undefined {
  switch (status.state) {
    // Name the condition, not the old remedy: design-time build now builds project references itself.
    // Reaching this means a reference failed to build, so "build required" would ask users to repeat the failed step.
    // Generic "unavailable" would instead send them hunting for a broken extension.
    case "reference-build-failed":
      return {
        text: "$(tools) WinApp: referenced project failed to build",
        tooltip: `${status.message ?? PROJECT_CONTEXT_REFERENCE_BUILD_FAILED_FALLBACK_MESSAGE} ${SHOW_XAML_OUTPUT_HINT}`,
        transient: false,
      };
    // A never-restored project is user-fixable and, on a clean clone, the first condition reached.
    // Generic "unavailable" sent developers hunting for a broken extension when the fix was one command.
    // This mirrors the build-side sibling above.
    case "packages-not-restored":
      // Auto-restore is already running, so the instruction is not the developer's to act on yet.
      // Calling it outstanding would repeat the build-side conflation and tell users to run a command the extension is running.
      // Once restore finishes without fixing the condition, the instruction is still needed and outlives the error notification.
      if (context.restoreInFlight) {
        return {
          text: "$(sync~spin) WinApp: restoring packages",
          tooltip: `${PROJECT_CONTEXT_RESTORING_MESSAGE} ${SHOW_XAML_OUTPUT_HINT}`,
          transient: false,
        };
      }

      return {
        text: "$(package) WinApp: restore required for XAML IntelliSense",
        tooltip: `${status.message ?? PROJECT_CONTEXT_PACKAGES_NOT_RESTORED_FALLBACK_MESSAGE} ${SHOW_XAML_OUTPUT_HINT}`,
        transient: false,
      };
    case "error":
      return {
        text: "$(warning) WinApp: XAML IntelliSense unavailable",
        tooltip: `${status.message ?? PROJECT_CONTEXT_ERROR_FALLBACK_MESSAGE} ${SHOW_XAML_OUTPUT_HINT}`,
        transient: false,
      };
    case "loading":
      return {
        text: "$(sync~spin) WinApp: Loading XAML IntelliSense",
        tooltip: `${PROJECT_CONTEXT_LOADING_MESSAGE} ${SHOW_XAML_OUTPUT_HINT}`,
        transient: false,
      };
    // Name what is usable before what is pending: WinUI controls/properties now complete, but app types and x:Bind do not.
    // The old "XAML project loading" sounded lateral or regressive right when capability improved.
    // If only the pending half is named, the status bar hides the useful part in the tooltip.
    case "framework-ready":
      return {
        text: "$(sync~spin) WinApp: WinUI Types Ready \u00b7 Loading Project Symbols and Diagnostics",
        tooltip: `${PROJECT_CONTEXT_FRAMEWORK_READY_MESSAGE} ${SHOW_XAML_OUTPUT_HINT}`,
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
