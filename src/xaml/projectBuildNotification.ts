export const PROJECT_BUILD_NOTIFICATION = "winui-xaml/projectBuildRequired";
export const PROJECT_BUILD_ACTIONS = {
  build: "Build",
  showOutput: "Show Output",
} as const;

/**
 * The WinUI markup compiler resolves project references as assemblies on disk. On a fresh clone
 * those do not exist, it aborts with WMC1006, and no compilation is produced -- so every
 * project-aware feature goes dark at once, including built-in types and diagnostics. Naming the
 * projects is the whole point: the symptom otherwise looks like a broken extension.
 */
export function buildRequiredMessage(unresolvedAssemblies: readonly string[]): string {
  const named = unresolvedAssemblies.filter((name) => name.trim().length > 0);
  const subject =
    named.length === 0
      ? "A referenced project has not been built"
      : `${named.join(", ")} ${named.length === 1 ? "has" : "have"} not been built`;
  return (
    `${subject}, so project-aware WinUI XAML IntelliSense is unavailable. ` +
    "Build the solution once to enable it."
  );
}

/** Prevents repeated build prompts for the same project during one extension-host session. */
export class ProjectBuildNotificationGate {
  private readonly shownProjects = new Set<string>();

  shouldShow(projectPath: string): boolean {
    const key = projectPath.toLowerCase();
    if (this.shownProjects.has(key)) {
      return false;
    }

    this.shownProjects.add(key);
    return true;
  }
}

export type ProjectBuildAction =
  (typeof PROJECT_BUILD_ACTIONS)[keyof typeof PROJECT_BUILD_ACTIONS];

/** The VS Code surfaces the build prompt drives, injected so the flow is testable without a host. */
export interface ProjectBuildNotificationHost {
  isTrustedWorkspaceProject(projectPath: string): boolean;
  shouldShow(projectPath: string): boolean;
  showWarningMessage(
    message: string,
    ...actions: ProjectBuildAction[]
  ): Thenable<string | undefined>;
  showOutput(): void;
  /** Runs a build for the project so the user can act without leaving the prompt. */
  buildProject(projectPath: string): void;
}

/**
 * Prompts once for a project whose referenced output the server reported as missing. Silently
 * ignores projects that are absent, outside a trusted workspace, or already prompted for.
 */
export async function notifyProjectBuildRequired(
  projectPath: string | undefined,
  unresolvedAssemblies: readonly string[] | undefined,
  host: ProjectBuildNotificationHost,
): Promise<void> {
  if (
    !projectPath ||
    !host.isTrustedWorkspaceProject(projectPath) ||
    !host.shouldShow(projectPath)
  ) {
    return;
  }

  const choice = await host.showWarningMessage(
    buildRequiredMessage(unresolvedAssemblies ?? []),
    PROJECT_BUILD_ACTIONS.build,
    PROJECT_BUILD_ACTIONS.showOutput,
  );

  if (choice === PROJECT_BUILD_ACTIONS.build) {
    host.buildProject(projectPath);
    return;
  }

  if (choice === PROJECT_BUILD_ACTIONS.showOutput) {
    host.showOutput();
  }
}
