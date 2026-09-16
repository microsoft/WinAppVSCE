export const PROJECT_BUILD_NOTIFICATION = "winui-xaml/projectBuildRequired";
export const PROJECT_BUILD_ACTIONS = {
  build: "Build",
  showOutput: "Show Output",
} as const;

// The markup compiler needs referenced assemblies on disk; design-time build now builds them, so this fires only when that build failed.
// Telling users to build would repeat the failed step; tell them to fix the project and build for Problems output.
// Framework/package types still resolve, so name the narrower outage and the projects involved.
export function buildRequiredMessage(unresolvedAssemblies: readonly string[]): string {
  const named = unresolvedAssemblies.filter((name) => name.trim().length > 0);
  const subject =
    named.length === 0
      ? "A referenced project could not be built"
      : `${named.join(", ")} could not be built`;
  return (
    `${subject}, so WinUI XAML IntelliSense cannot see types defined there. ` +
    "Framework and package types still work. Build it to see the errors."
  );
}

export type ProjectBuildAction =
  (typeof PROJECT_BUILD_ACTIONS)[keyof typeof PROJECT_BUILD_ACTIONS];

// The server owns the once-per-condition latch and clears it when the project loads.
// A client latch once swallowed re-armed server notifications, letting tests pass while the toast stayed silent.
// If a notification arrives, it is meant to be shown.
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

/** Prompts for missing referenced output; ignores absent/untrusted projects, and repetition is the server's call. */
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
