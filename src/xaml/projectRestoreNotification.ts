export const PROJECT_RESTORE_NOTIFICATION = "winui-xaml/projectRestoreRequired";
export const PROJECT_RESTORE_ACTIONS = {
  showOutput: "Show Output",
} as const;

export type ProjectRestoreAction =
  (typeof PROJECT_RESTORE_ACTIONS)[keyof typeof PROJECT_RESTORE_ACTIONS];

/**
 * The server owns the once-per-condition decision and clears its latch when the project loads. A
 * second client-side latch would silently swallow the re-armed notification, so there isn't one.
 */
export interface ProjectRestoreNotificationHost {
  isTrustedWorkspaceProject(projectPath: string): boolean;
  restoreProject(projectPath: string): Thenable<unknown>;
}

/**
 * Restores a project whose packages the server reported as missing.
 *
 * This runs without asking. A project that has never been restored yields no IntelliSense at all,
 * so the prompt it replaces had exactly one useful answer -- and now that the design-time build
 * builds the project's references, an unrestored reference costs the user the types in it too.
 * `dotnet restore` writes to `obj/`, which is build output rather than anything the user tracks,
 * and consent already exists at a coarser boundary: the language server does not start at all in
 * an untrusted workspace, so this is never reached there. The trust check below is defence in
 * depth on a security boundary, not the gate the user experiences.
 *
 * That is where the Roslyn C# language server settled (`dotnet_enable_automatic_restore`, on by
 * default) after shipping this same prompt on OmniSharp.
 *
 * Silently ignores projects that are absent or outside a trusted workspace.
 */
export async function notifyProjectRestoreRequired(
  projectPath: string | undefined,
  host: ProjectRestoreNotificationHost,
): Promise<void> {
  if (!projectPath || !host.isTrustedWorkspaceProject(projectPath)) {
    return;
  }

  await host.restoreProject(projectPath);
}
