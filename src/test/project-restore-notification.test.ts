import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PROJECT_RESTORE_ACTIONS,
  PROJECT_RESTORE_MESSAGE,
  PROJECT_RESTORE_NOTIFICATION,
  type ProjectRestoreNotificationHost,
  notifyProjectRestoreRequired,
} from "../xaml/projectRestoreNotification";

describe("projectRestoreNotification contract", () => {
  it("exposes the notification contract", () => {
    assert.equal(PROJECT_RESTORE_NOTIFICATION, "winui-xaml/projectRestoreRequired");
    assert.match(PROJECT_RESTORE_MESSAGE, /project-aware IntelliSense is unavailable/i);
    assert.deepEqual(PROJECT_RESTORE_ACTIONS, {
      restore: "Restore Packages",
      showOutput: "Show Output",
    });
  });
});

describe("notifyProjectRestoreRequired", () => {
  const project = "C:\\app\\App.csproj";

  function createHost(choice?: string) {
    const calls = {
      prompted: [] as string[],
      restored: [] as string[],
      shownOutput: 0,
    };
    // Typed as the real interface so a host member the fake does not implement is a compile
    // error instead of a silently diverging test double.
    const host: ProjectRestoreNotificationHost = {
      isTrustedWorkspaceProject: () => true,
      showInformationMessage: async (message: string) => {
        calls.prompted.push(message);
        return choice;
      },
      showOutput: () => {
        calls.shownOutput += 1;
      },
      restoreProject: async (projectPath: string) => {
        calls.restored.push(projectPath);
      },
    };
    return { calls, host };
  }

  it("restores the project when the user approves", async () => {
    const { calls, host } = createHost(PROJECT_RESTORE_ACTIONS.restore);

    await notifyProjectRestoreRequired(project, host);

    assert.deepEqual(calls.prompted, [PROJECT_RESTORE_MESSAGE]);
    assert.deepEqual(calls.restored, [project]);
    assert.equal(calls.shownOutput, 0);
  });

  it("opens the output channel instead of restoring", async () => {
    const { calls, host } = createHost(PROJECT_RESTORE_ACTIONS.showOutput);

    await notifyProjectRestoreRequired(project, host);

    assert.equal(calls.shownOutput, 1);
    assert.deepEqual(calls.restored, []);
  });

  it("does nothing when the prompt is dismissed", async () => {
    const { calls, host } = createHost(undefined);

    await notifyProjectRestoreRequired(project, host);

    assert.deepEqual(calls.prompted, [PROJECT_RESTORE_MESSAGE]);
    assert.deepEqual(calls.restored, []);
    assert.equal(calls.shownOutput, 0);
  });

  // D5: this previously asserted "prompts only once", which encoded the defect -- the client
  // swallowed the server's re-armed notification, so a second outage for the same project was
  // silent. The server latches per condition and clears on a successful load; if it sends, it
  // means to.
  it("prompts again when the server reports the project a second time", async () => {
    const { calls, host } = createHost(PROJECT_RESTORE_ACTIONS.restore);

    await notifyProjectRestoreRequired(project, host);
    await notifyProjectRestoreRequired(project, host);

    assert.equal(calls.prompted.length, 2);
    assert.deepEqual(calls.restored, [project, project]);
  });

  it("stays silent for a missing path or an untrusted project", async () => {
    const { calls, host } = createHost(PROJECT_RESTORE_ACTIONS.restore);

    await notifyProjectRestoreRequired(undefined, host);
    await notifyProjectRestoreRequired(project, {
      ...host,
      isTrustedWorkspaceProject: () => false,
    });

    assert.deepEqual(calls.prompted, []);
    assert.deepEqual(calls.restored, []);
  });
});
