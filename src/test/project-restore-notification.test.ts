import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PROJECT_RESTORE_ACTIONS,
  PROJECT_RESTORE_MESSAGE,
  PROJECT_RESTORE_NOTIFICATION,
  ProjectRestoreNotificationGate,
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
