import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PROJECT_BUILD_ACTIONS,
  PROJECT_BUILD_NOTIFICATION,
  ProjectBuildNotificationGate,
  buildRequiredMessage,
  notifyProjectBuildRequired,
} from "../xaml/projectBuildNotification";

type Recorded = { message: string; actions: string[] };

function createHost(overrides: Partial<{ trusted: boolean; show: boolean; choice: string }> = {}) {
  const shown: Recorded[] = [];
  let outputShown = false;
  const host = {
    isTrustedWorkspaceProject: () => overrides.trusted ?? true,
    shouldShow: () => overrides.show ?? true,
    showWarningMessage: (message: string, ...actions: string[]) => {
      shown.push({ message, actions });
      return Promise.resolve(overrides.choice);
    },
    showOutput: () => {
      outputShown = true;
    },
  };
  return { host: host as never, shown, outputShown: () => outputShown };
}

describe("ProjectBuildNotificationGate", () => {
  it("shows once per project per session, case-insensitively", () => {
    const gate = new ProjectBuildNotificationGate();

    assert.equal(gate.shouldShow("C:\\app\\App.csproj"), true);
    assert.equal(gate.shouldShow("c:\\APP\\app.csproj"), false);
    assert.equal(gate.shouldShow("C:\\other\\Other.csproj"), true);
  });
});

describe("buildRequiredMessage", () => {
  it("names the unbuilt projects so the failure is self-diagnosing", () => {
    const message = buildRequiredMessage(["MiddleLib", "SharedLib"]);

    assert.match(message, /MiddleLib, SharedLib have not been built/);
    assert.match(message, /Build the solution once/);
  });

  it("uses singular agreement for one project", () => {
    assert.match(buildRequiredMessage(["SharedLib"]), /SharedLib has not been built/);
  });

  it("degrades to a generic subject when the compiler named nothing", () => {
    const message = buildRequiredMessage([]);

    assert.match(message, /A referenced project has not been built/);
    assert.doesNotMatch(message, /undefined/);
  });

  it("ignores blank names rather than emitting empty clauses", () => {
    assert.match(buildRequiredMessage(["", "  "]), /A referenced project has not been built/);
  });
});

describe("notifyProjectBuildRequired", () => {
  it("prompts with the Show Output action", async () => {
    const { host, shown } = createHost();

    await notifyProjectBuildRequired("C:\\app\\App.csproj", ["SharedLib"], host);

    assert.equal(shown.length, 1);
    assert.match(shown[0].message, /SharedLib has not been built/);
    assert.deepEqual(shown[0].actions, [PROJECT_BUILD_ACTIONS.showOutput]);
  });

  it("stays silent without a project path", async () => {
    const { host, shown } = createHost();

    await notifyProjectBuildRequired(undefined, ["SharedLib"], host);

    assert.equal(shown.length, 0);
  });

  it("stays silent outside a trusted workspace", async () => {
    const { host, shown } = createHost({ trusted: false });

    await notifyProjectBuildRequired("C:\\app\\App.csproj", ["SharedLib"], host);

    assert.equal(shown.length, 0);
  });

  it("stays silent when the gate has already prompted", async () => {
    const { host, shown } = createHost({ show: false });

    await notifyProjectBuildRequired("C:\\app\\App.csproj", ["SharedLib"], host);

    assert.equal(shown.length, 0);
  });

  it("tolerates a payload with no assemblies list", async () => {
    const { host, shown } = createHost();

    await notifyProjectBuildRequired("C:\\app\\App.csproj", undefined, host);

    assert.equal(shown.length, 1);
    assert.match(shown[0].message, /A referenced project has not been built/);
  });

  it("opens the output channel when that action is chosen", async () => {
    const { host, outputShown } = createHost({ choice: PROJECT_BUILD_ACTIONS.showOutput });

    await notifyProjectBuildRequired("C:\\app\\App.csproj", ["SharedLib"], host);

    assert.equal(outputShown(), true);
  });

  it("does nothing when the prompt is dismissed", async () => {
    const { host, outputShown } = createHost({ choice: undefined });

    await notifyProjectBuildRequired("C:\\app\\App.csproj", ["SharedLib"], host);

    assert.equal(outputShown(), false);
  });

  it("exposes the notification contract the server sends", () => {
    assert.equal(PROJECT_BUILD_NOTIFICATION, "winui-xaml/projectBuildRequired");
  });
});
