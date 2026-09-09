import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PROJECT_RESTORE_ACTIONS,
  PROJECT_RESTORE_MESSAGE,
  PROJECT_RESTORE_NOTIFICATION,
  ProjectRestoreNotificationGate,
  notifyProjectRestoreRequired,
} from "../xaml/projectRestoreNotification";

describe("ProjectRestoreNotificationGate", () => {
  it("shows once per project per session", () => {
    const gate = new ProjectRestoreNotificationGate();

    assert.equal(gate.shouldShow("C:\\app\\App.csproj"), true);
    assert.equal(gate.shouldShow("C:\\app\\App.csproj"), false);
    assert.equal(gate.shouldShow("C:\\other\\Other.csproj"), true);
  });

  it("matches project paths case-insensitively", () => {
    const gate = new ProjectRestoreNotificationGate();

    assert.equal(gate.shouldShow("C:\\App\\App.csproj"), true);
    assert.equal(gate.shouldShow("c:\\app\\APP.csproj"), false);
  });

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
    const gate = new ProjectRestoreNotificationGate();
    return {
      calls,
      host: {
        isTrustedWorkspaceProject: () => true,
        shouldShow: (projectPath: string) => gate.shouldShow(projectPath),
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
      },
    };
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

  it("prompts only once per project even when the server reports it repeatedly", async () => {
    const { calls, host } = createHost(PROJECT_RESTORE_ACTIONS.restore);

    await notifyProjectRestoreRequired(project, host);
    await notifyProjectRestoreRequired(project, host);

    assert.equal(calls.prompted.length, 1);
    assert.deepEqual(calls.restored, [project]);
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
