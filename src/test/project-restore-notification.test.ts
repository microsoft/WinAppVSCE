import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PROJECT_RESTORE_ACTIONS,
  PROJECT_RESTORE_NOTIFICATION,
  type ProjectRestoreNotificationHost,
  notifyProjectRestoreRequired,
} from "../xaml/projectRestoreNotification";

describe("projectRestoreNotification contract", () => {
  it("exposes the notification contract", () => {
    assert.equal(PROJECT_RESTORE_NOTIFICATION, "winui-xaml/projectRestoreRequired");
    // The only action left belongs to the failure path; the restore itself is not a choice.
    assert.deepEqual(PROJECT_RESTORE_ACTIONS, {
      showOutput: "Show Output",
    });
  });
});

describe("notifyProjectRestoreRequired", () => {
  const project = "C:\\app\\App.csproj";

  function createHost() {
    const calls = {
      restored: [] as string[],
    };
    // Typed as the real interface so a host member the fake does not implement is a compile
    // error instead of a silently diverging test double.
    const host: ProjectRestoreNotificationHost = {
      isTrustedWorkspaceProject: () => true,
      restoreProject: async (projectPath: string) => {
        calls.restored.push(projectPath);
      },
    };
    return { calls, host };
  }

  // An unrestored project yields no IntelliSense at all, so the prompt this replaces had exactly
  // one useful answer. Consent lives at the workspace-trust boundary instead, which is where the
  // Roslyn C# server also puts it.
  it("restores the project without asking", async () => {
    const { calls, host } = createHost();

    await notifyProjectRestoreRequired(project, host);

    assert.deepEqual(calls.restored, [project]);
  });

  // D5: this previously asserted "prompts only once", which encoded the defect -- the client
  // swallowed the server's re-armed notification, so a second outage for the same project was
  // silent. The server latches per condition and clears on a successful load; if it sends, it
  // means to.
  it("restores again when the server reports the project a second time", async () => {
    const { calls, host } = createHost();

    await notifyProjectRestoreRequired(project, host);
    await notifyProjectRestoreRequired(project, host);

    assert.deepEqual(calls.restored, [project, project]);
  });

  it("stays silent for a missing path or an untrusted project", async () => {
    const { calls, host } = createHost();

    await notifyProjectRestoreRequired(undefined, host);
    await notifyProjectRestoreRequired(project, {
      ...host,
      isTrustedWorkspaceProject: () => false,
    });

    assert.deepEqual(calls.restored, []);
  });
});
