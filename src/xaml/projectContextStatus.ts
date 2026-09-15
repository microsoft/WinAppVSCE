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
  "build-required",
  "restore-required",
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
export const PROJECT_CONTEXT_BUILD_REQUIRED_FALLBACK_MESSAGE =
  "Build the solution once so referenced projects produce their assemblies.";
export const PROJECT_CONTEXT_RESTORE_REQUIRED_FALLBACK_MESSAGE =
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

/**
 * States that describe the project on disk rather than an operation in flight. They stay true
 * until the developer acts, so a reload starting is not evidence they stopped being true.
 */
const DURABLE_STATES: readonly ProjectContextState[] = [
  "build-required",
  "restore-required",
];

/**
 * Decides whether an incoming status replaces the one already held for that document.
 *
 * Every save restarts the project load, which re-sends `loading` before failing the same way
 * again -- so on an unbuilt project the bar would drop its instruction and spin on each
 * keystroke-plus-save, which is precisely the clean-clone case the instruction exists for.
 * A load that genuinely resolves ends in `ready` / `framework-ready` / `error`, none of which
 * are suppressed here, so recovery after a real build still lands immediately.
 */
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
    values.find((status) => status.state === "restore-required") ??
    values.find((status) => status.state === "build-required") ??
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
    // The clean-clone case reaches every developer who opens XAML before their first build, so
    // the instruction belongs in the bar itself. "unavailable" would send them looking for a
    // broken extension when the fix is one build.
    case "build-required":
      return {
        text: "$(tools) WinApp: build required for XAML IntelliSense",
        tooltip: `${status.message ?? PROJECT_CONTEXT_BUILD_REQUIRED_FALLBACK_MESSAGE} ${SHOW_XAML_OUTPUT_HINT}`,
        transient: false,
      };
    // A never-restored project is as user-fixable as a never-built one, and on a clean clone it is
    // the condition reached *first*. Falling back to the generic "unavailable" wording here sent
    // developers looking for a broken extension at the exact moment the fix was one command --
    // the same defect this state's build-side sibling above was added to remove.
    case "restore-required":
      // The extension restores without being asked, so for as long as that is running the
      // instruction is not the developer's to act on -- it describes work already in flight.
      // Reporting it as an outstanding demand is the same conflation the build-side wording
      // above was written to avoid, and it would also be the only place left where the user is
      // told to run a command the extension is at that moment running.
      //
      // The instruction is still what a developer needs once the restore *finishes* without
      // fixing the condition -- a restore that failed leaves the demand outstanding, and the bar
      // outlives the error notification that reported it.
      if (context.restoreInFlight) {
        return {
          text: "$(sync~spin) WinApp: restoring packages",
          tooltip: `${PROJECT_CONTEXT_RESTORING_MESSAGE} ${SHOW_XAML_OUTPUT_HINT}`,
          transient: false,
        };
      }

      return {
        text: "$(package) WinApp: restore required for XAML IntelliSense",
        tooltip: `${status.message ?? PROJECT_CONTEXT_RESTORE_REQUIRED_FALLBACK_MESSAGE} ${SHOW_XAML_OUTPUT_HINT}`,
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
