export const PROJECT_RESTORE_NOTIFICATION = "winui-xaml/projectRestoreRequired";
export const PROJECT_RESTORE_ACTIONS = {
  showOutput: "Show Output",
} as const;

export type ProjectRestoreAction =
  (typeof PROJECT_RESTORE_ACTIONS)[keyof typeof PROJECT_RESTORE_ACTIONS];

/** The server owns and clears the once-per-condition latch; a client latch would swallow re-armed notifications. */
export interface ProjectRestoreNotificationHost {
  isTrustedWorkspaceProject(projectPath: string): boolean;
  restoreProject(projectPath: string): Thenable<unknown>;
}

// Restores without asking: an unrestored project has no IntelliSense, and reference auto-builds make unrestored references hide their types too.
// `dotnet restore` writes build output under `obj/`; workspace trust is the user-facing consent gate, with the trust check below as defence in depth.
// Mirrors Roslyn's default auto-restore path and silently ignores absent or untrusted projects.
export async function notifyProjectRestoreRequired(
  projectPath: string | undefined,
  host: ProjectRestoreNotificationHost,
): Promise<void> {
  if (!projectPath || !host.isTrustedWorkspaceProject(projectPath)) {
    return;
  }

  await host.restoreProject(projectPath);
}
