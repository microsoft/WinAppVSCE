export const PROJECT_RESTORE_NOTIFICATION = "winui-xaml/projectRestoreRequired";
export const PROJECT_RESTORE_ACTIONS = {
  restore: "Restore Packages",
  showOutput: "Show Output",
} as const;

export const PROJECT_RESTORE_MESSAGE =
  "WinUI XAML project packages are not restored, so project-aware IntelliSense is unavailable.";

/** Prevents repeated restore prompts for the same project during one extension-host session. */
export class ProjectRestoreNotificationGate {
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

export type ProjectRestoreAction =
  (typeof PROJECT_RESTORE_ACTIONS)[keyof typeof PROJECT_RESTORE_ACTIONS];

/** The VS Code surfaces the restore prompt drives, injected so the flow is testable without a host. */
export interface ProjectRestoreNotificationHost {
  isTrustedWorkspaceProject(projectPath: string): boolean;
  shouldShow(projectPath: string): boolean;
  showInformationMessage(
    message: string,
    ...actions: ProjectRestoreAction[]
  ): Thenable<string | undefined>;
  showOutput(): void;
  restoreProject(projectPath: string): Thenable<unknown>;
}

/**
 * Prompts once to restore a project whose packages the server reported as missing, then runs the
 * choice. Silently ignores projects that are absent, outside a trusted workspace, or already
 * prompted for.
 */
export async function notifyProjectRestoreRequired(
  projectPath: string | undefined,
  host: ProjectRestoreNotificationHost,
): Promise<void> {
  if (
    !projectPath ||
    !host.isTrustedWorkspaceProject(projectPath) ||
    !host.shouldShow(projectPath)
  ) {
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
