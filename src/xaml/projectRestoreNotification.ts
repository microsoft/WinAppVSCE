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
