export const PROJECT_CONTEXT_STATUS_NOTIFICATION = "winui-xaml/projectContextStatus";

export type ProjectContextState =
  | "loading"
  | "framework-ready"
  | "ready"
  | "error"
  | "idle";

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
        tooltip: `${status.message ?? "Project IntelliSense failed to load."} Click to show the WinUI XAML output.`,
        transient: false,
      };
    case "loading":
      return {
        text: "$(sync~spin) WinApp: XAML IntelliSense loading",
        tooltip:
          "Loading authoritative project metadata. Click to show the WinUI XAML output.",
        transient: false,
      };
    case "framework-ready":
      return {
        text: "$(sync~spin) WinApp: XAML project loading",
        tooltip:
          "Framework IntelliSense is available. Project symbols and diagnostics are still loading.",
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
