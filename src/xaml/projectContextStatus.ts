import { XAML_COMMANDS } from "./xamlConstants";

export const PROJECT_CONTEXT_STATUS_NOTIFICATION = "winui-xaml/projectContextStatus";

/** The single source of truth for project-context states. The runtime array and the type are derived from one another, so a new state cannot be added to one without the other. */
export const PROJECT_CONTEXT_STATES = [
  "loading",
  "framework-ready",
  "ready",
  "error",
  "reference-build-failed",
  "packages-not-restored",
  "generators-unavailable",
  "dotnet-sdk-required",
  "idle",
] as const;

export type ProjectContextState = (typeof PROJECT_CONTEXT_STATES)[number];

/** Narrows an untrusted value (server notification payload) to a known state. */
export function isProjectContextState(
  value: unknown
): value is ProjectContextState {
  return PROJECT_CONTEXT_STATES.includes(value as ProjectContextState);
}

/** Shared wording for the project-context states. The status bar and the `winui-xaml.showInfo` summary describe the same conditions, so they compose these sentences rather than each spelling them out. */
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
export const PROJECT_CONTEXT_GENERATORS_UNAVAILABLE_FALLBACK_MESSAGE =
  "Source generators could not run, so generated members are missing.";
export const PROJECT_CONTEXT_DOTNET_SDK_REQUIRED_MESSAGE =
  "Install the .NET 10 SDK to get project-aware XAML IntelliSense for this C# project. " +
  "XAML formatting, folding, outline, and closing-tag completion work without it.";
export const PROJECT_CONTEXT_RESTORING_MESSAGE =
  "Restoring the project's packages. Project-aware IntelliSense resumes when it completes.";
export const SHOW_XAML_OUTPUT_HINT =
  "Click to show the WinUI XAML output.";

/** The install action lives in Show XAML Language Server Status, so this state sends the click there instead. */
export const SHOW_XAML_INFO_HINT = "Click for install and restart actions.";

export interface ProjectContextStatus {
  uri: string;
  state: ProjectContextState;
  message?: string;
}

export interface ProjectContextStatusPresentation {
  text: string;
  tooltip: string;
  transient: boolean;
  /** Status-bar click target. Defaults to showing the output channel. */
  command?: string;
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
  "generators-unavailable",
  "dotnet-sdk-required",
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

/** Priority when several projects report at once, lowest rank first. Typed as a total record, so a new state fails to compile until it is ranked. `idle` is absent: it means there is nothing to report. */
const PROJECT_CONTEXT_PRIORITY: Record<
  Exclude<ProjectContextState, "idle">,
  number
> = {
  // A missing SDK blocks restore and build alike, so it outranks both: telling the developer to
  // restore names a step that cannot run.
  "dotnet-sdk-required": 0,
  // Restore precedes build: an unrestored project cannot be built, so when both conditions are
  // present, naming the build is telling the developer to do the step that will fail.
  "packages-not-restored": 1,
  "reference-build-failed": 2,
  "generators-unavailable": 3,
  error: 4,
  loading: 5,
  "framework-ready": 6,
  ready: 7,
};

export function selectProjectContextStatus(
  statuses: Iterable<ProjectContextStatus>
): ProjectContextStatus | undefined {
  let best: ProjectContextStatus | undefined;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const status of statuses) {
    const rank =
      PROJECT_CONTEXT_PRIORITY[
        status.state as Exclude<ProjectContextState, "idle">
      ];
    if (rank !== undefined && rank < bestRank) {
      best = status;
      bestRank = rank;
    }
  }
  return best;
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
    // Only a project the server tried to load reaches this state, so the prompt lands on C#
    // projects and never on a C++ project that needs no .NET.
    case "dotnet-sdk-required":
      return {
        text: "$(cloud-download) WinApp: .NET SDK Required for XAML IntelliSense",
        tooltip: `${PROJECT_CONTEXT_DOTNET_SDK_REQUIRED_MESSAGE} ${SHOW_XAML_INFO_HINT}`,
        transient: false,
        command: XAML_COMMANDS.showInfo,
      };
    // The reference build was attempted and failed, so the useful thing to say is what broke, not
    // to ask for a build that just failed or a generic "unavailable" that implicates the extension.
    case "reference-build-failed":
      return {
        text: "$(tools) WinApp: Referenced Project Failed to Build",
        tooltip: `${status.message ?? PROJECT_CONTEXT_REFERENCE_BUILD_FAILED_FALLBACK_MESSAGE} ${SHOW_XAML_OUTPUT_HINT}`,
        transient: false,
      };
    // Missing packages are user-fixable in one command, so name that rather than a generic
    // "unavailable" that implicates the extension. Mirrors the build-side sibling above.
    case "packages-not-restored":
      if (context.restoreInFlight) {
        return {
          text: "$(sync~spin) WinApp: Restoring Packages",
          tooltip: `${PROJECT_CONTEXT_RESTORING_MESSAGE} ${SHOW_XAML_OUTPUT_HINT}`,
          transient: false,
        };
      }

      return {
        text: "$(package) WinApp: Restore Required for XAML IntelliSense",
        tooltip: `${status.message ?? PROJECT_CONTEXT_PACKAGES_NOT_RESTORED_FALLBACK_MESSAGE} ${SHOW_XAML_OUTPUT_HINT}`,
        transient: false,
      };
    // Nothing the developer can build or restore fixes this, so the wording points at the
    // extension's own helper rather than asking for an action that cannot help.
    case "generators-unavailable":
      return {
        text: "$(warning) WinApp: Generated Members Unavailable",
        tooltip: `${status.message ?? PROJECT_CONTEXT_GENERATORS_UNAVAILABLE_FALLBACK_MESSAGE} ${SHOW_XAML_OUTPUT_HINT}`,
        transient: false,
      };
    case "error":
      return {
        text: "$(warning) WinApp: XAML IntelliSense Unavailable",
        tooltip: `${status.message ?? PROJECT_CONTEXT_ERROR_FALLBACK_MESSAGE} ${SHOW_XAML_OUTPUT_HINT}`,
        transient: false,
      };
    case "loading":
      return {
        text: "$(sync~spin) WinApp: Loading XAML IntelliSense",
        tooltip: `${PROJECT_CONTEXT_LOADING_MESSAGE} ${SHOW_XAML_OUTPUT_HINT}`,
        transient: false,
      };
    // Name what is usable before what is pending: WinUI controls and properties complete here, app
    // types and x:Bind do not. Naming only the pending half buries the useful part in the tooltip.
    case "framework-ready":
      return {
        text: "$(sync~spin) WinApp: WinUI Types Ready \u00b7 Loading Project Symbols and Diagnostics",
        tooltip: `${PROJECT_CONTEXT_FRAMEWORK_READY_MESSAGE} ${SHOW_XAML_OUTPUT_HINT}`,
        transient: false,
      };
    case "ready":
      return {
        text: "$(check) WinApp: XAML IntelliSense Ready",
        tooltip: "Project-aware XAML IntelliSense is ready.",
        transient: true,
      };
    case "idle":
      return undefined;
    default: {
      // A new state must be given a presentation here; this fails to compile until it is.
      const unhandled: never = status.state;
      return unhandled;
    }
  }
}
