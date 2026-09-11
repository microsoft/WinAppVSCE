export const PROJECT_RESTORE_NOTIFICATION = "winui-xaml/projectRestoreRequired";
export const PROJECT_RESTORE_ACTIONS = {
  restore: "Restore Packages",
  showOutput: "Show Output",
} as const;

export const PROJECT_RESTORE_MESSAGE =
  "WinUI XAML project packages are not restored, so project-aware IntelliSense is unavailable.";

export type ProjectRestoreAction =
  (typeof PROJECT_RESTORE_ACTIONS)[keyof typeof PROJECT_RESTORE_ACTIONS];

/**
 * As with the build prompt, the server owns the once-per-condition decision and clears its latch
 * when the project loads. A second client-side latch would silently swallow the re-armed
 * notification, so there isn't one.
 */
export interface ProjectRestoreNotificationHost {
  isTrustedWorkspaceProject(projectPath: string): boolean;
  showInformationMessage(
    message: string,
    ...actions: ProjectRestoreAction[]
  ): Thenable<string | undefined>;
  showOutput(): void;
  restoreProject(projectPath: string): Thenable<unknown>;
}

/**
 * Prompts to restore a project whose packages the server reported as missing, then runs the choice.
 * Silently ignores projects that are absent or outside a trusted workspace.
 */
export async function notifyProjectRestoreRequired(
  projectPath: string | undefined,
  host: ProjectRestoreNotificationHost,
): Promise<void> {
  if (!projectPath || !host.isTrustedWorkspaceProject(projectPath)) {
    return;
  }

  const choice = await host.showInformationMessage(
    PROJECT_RESTORE_MESSAGE,
    PROJECT_RESTORE_ACTIONS.restore,
    PROJECT_RESTORE_ACTIONS.showOutput,
  );

  if (choice === PROJECT_RESTORE_ACTIONS.showOutput) {
    host.showOutput();
  } else if (choice === PROJECT_RESTORE_ACTIONS.restore) {
    await host.restoreProject(projectPath);
  }
}
