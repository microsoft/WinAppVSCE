export const PROJECT_BUILD_NOTIFICATION = "winui-xaml/projectBuildRequired";
export const PROJECT_BUILD_ACTIONS = {
  build: "Build",
  showOutput: "Show Output",
} as const;

/**
 * The WinUI markup compiler resolves project references as assemblies on disk. The server now
 * compiles never-built references from source and supplies stand-ins, so this prompt no longer
 * fires for a merely-unbuilt project -- it means the reference could not be produced from source
 * either. Framework and package types still resolve, so the message must not claim IntelliSense
 * is gone; naming the projects is what makes the narrower outage attributable.
 */
export function buildRequiredMessage(unresolvedAssemblies: readonly string[]): string {
  const named = unresolvedAssemblies.filter((name) => name.trim().length > 0);
  const subject =
    named.length === 0
      ? "A referenced project could not be resolved"
      : `${named.join(", ")} could not be resolved`;
  return (
    `${subject}, so WinUI XAML IntelliSense cannot see types defined there. ` +
    "Framework and package types still work. Building the solution usually fixes this."
  );
}

export type ProjectBuildAction =
  (typeof PROJECT_BUILD_ACTIONS)[keyof typeof PROJECT_BUILD_ACTIONS];

/**
 * The server owns the once-per-condition decision: it latches per project and clears the latch when * the project loads, so a second outage is reported again. The client deliberately does NOT keep a
 * second latch -- one did exist, and because nothing ever cleared it the server's re-arm could not
 * reach the user. Two owners for one decision meant the server-side test passed while the toast
 * stayed silent. If a notification arrives, it is meant to be shown.
 */
export interface ProjectBuildNotificationHost {
  isTrustedWorkspaceProject(projectPath: string): boolean;
  showWarningMessage(
    message: string,
    ...actions: ProjectBuildAction[]
  ): Thenable<string | undefined>;
  showOutput(): void;
  /** Runs a build for the project so the user can act without leaving the prompt. */
  buildProject(projectPath: string): void;
}

/**
 * Prompts for a project whose referenced output the server reported as missing. Silently ignores
 * projects that are absent or outside a trusted workspace; repetition is the server's call.
 */
export async function notifyProjectBuildRequired(
  projectPath: string | undefined,
  unresolvedAssemblies: readonly string[] | undefined,
  host: ProjectBuildNotificationHost,
): Promise<void> {
  if (!projectPath || !host.isTrustedWorkspaceProject(projectPath)) {
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
