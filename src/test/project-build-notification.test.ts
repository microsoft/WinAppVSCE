import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PROJECT_BUILD_ACTIONS,
  PROJECT_BUILD_NOTIFICATION,
  type ProjectBuildNotificationHost,
  buildRequiredMessage,
  notifyProjectBuildRequired,
} from "../xaml/projectBuildNotification";

type Recorded = { message: string; actions: string[] };

function createHost(overrides: Partial<{ trusted: boolean; choice: string }> = {}) {
  const shown: Recorded[] = [];
  let outputShown = false;
  const built: string[] = [];
  // Typed as the real interface rather than cast away, so a host member the fake does not
  // implement is a compile error instead of a silently diverging test double.
  const host: ProjectBuildNotificationHost = {
    isTrustedWorkspaceProject: () => overrides.trusted ?? true,
    showWarningMessage: (message: string, ...actions: string[]) => {
      shown.push({ message, actions });
      return Promise.resolve(overrides.choice);
    },
    showOutput: () => {
      outputShown = true;
    },
    buildProject: (projectPath: string) => {
      built.push(projectPath);
    },
  };
  return { host, shown, outputShown: () => outputShown, built };
}

// D5: the client must NOT keep its own once-per-project latch. The server latches and re-arms when
// the project loads; a second latch here swallowed the re-armed notification, so the server-side
// re-arm test passed while the toast stayed silent through a second outage.
describe("second outage for the same project", () => {
  it("prompts again, because repetition is the server's decision", async () => {
    const { host, shown } = createHost();

    await notifyProjectBuildRequired("C:\\app\\App.csproj", ["SharedLib"], host);
    await notifyProjectBuildRequired("C:\\app\\App.csproj", ["SharedLib"], host);

    assert.equal(shown.length, 2);
  });
});

describe("buildRequiredMessage", () => {
  it("names the unresolved projects so the failure is self-diagnosing", () => {
    const message = buildRequiredMessage(["MiddleLib", "SharedLib"]);

    assert.match(message, /MiddleLib, SharedLib could not be built/);
    assert.match(message, /Build it to see the errors/);
  });

  it("scopes the outage to project-defined types, because the rest still resolves", () => {
    // The server compiles never-built references from source now, so this prompt means the
    // narrower failure. Claiming IntelliSense is unavailable would send the user hunting for a
    // breakage that is not there.
    const message = buildRequiredMessage(["SharedLib"]);

    assert.match(message, /SharedLib could not be built/);
    assert.match(message, /Framework and package types still work/);
    assert.doesNotMatch(message, /IntelliSense is unavailable/);
  });

  it("degrades to a generic subject when the compiler named nothing", () => {
    const message = buildRequiredMessage([]);

    assert.match(message, /A referenced project could not be built/);
    assert.doesNotMatch(message, /undefined/);
  });

  it("ignores blank names rather than emitting empty clauses", () => {
    assert.match(buildRequiredMessage(["", "  "]), /A referenced project could not be built/);
  });
});

describe("notifyProjectBuildRequired", () => {
  it("offers Build first, because building is the fix and Show Output is only diagnosis", async () => {
    const { host, shown } = createHost();

    await notifyProjectBuildRequired("C:\\app\\App.csproj", ["SharedLib"], host);

    assert.equal(shown.length, 1);
    assert.match(shown[0].message, /SharedLib could not be built/);
    assert.deepEqual(shown[0].actions, [
      PROJECT_BUILD_ACTIONS.build,
      PROJECT_BUILD_ACTIONS.showOutput,
    ]);
  });

  it("builds the project that was reported, not a workspace guess", async () => {
    const { host, built, outputShown } = createHost({ choice: PROJECT_BUILD_ACTIONS.build });

    await notifyProjectBuildRequired("C:\\app\\App.csproj", ["SharedLib"], host);

    assert.deepEqual(built, ["C:\\app\\App.csproj"]);
    assert.equal(outputShown(), false);
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

  it("tolerates a payload with no assemblies list", async () => {
    const { host, shown } = createHost();

    await notifyProjectBuildRequired("C:\\app\\App.csproj", undefined, host);

    assert.equal(shown.length, 1);
    assert.match(shown[0].message, /A referenced project could not be built/);
  });

  it("opens the output channel when that action is chosen", async () => {
    const { host, outputShown } = createHost({ choice: PROJECT_BUILD_ACTIONS.showOutput });

    await notifyProjectBuildRequired("C:\\app\\App.csproj", ["SharedLib"], host);

    assert.equal(outputShown(), true);
  });

  it("does nothing when the prompt is dismissed", async () => {
    const { host, outputShown, built } = createHost({ choice: undefined });

    await notifyProjectBuildRequired("C:\\app\\App.csproj", ["SharedLib"], host);

    assert.equal(outputShown(), false);
    assert.deepEqual(built, []);
  });

  it("exposes the notification contract the server sends", () => {
    assert.equal(PROJECT_BUILD_NOTIFICATION, "winui-xaml/projectBuildRequired");
  });
});

