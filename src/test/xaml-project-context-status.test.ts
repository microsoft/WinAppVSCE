import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  PROJECT_CONTEXT_STATES,
  PROJECT_CONTEXT_STATUS_NOTIFICATION,
  ProjectContextStatus,
  getRelevantProjectContextStatuses,
  getProjectContextStatusPresentation,
  isProjectContextState,
  selectProjectContextStatus,
  shouldReplaceProjectContextStatus,
} from "../xaml/projectContextStatus";

test("a starting reload does not erase a build-required the developer has not fixed", () => {
  // Every save restarts the load, so an unbuilt project re-sends `loading` indefinitely.
  const current: ProjectContextStatus = {
    uri: "file:///a.xaml",
    state: "build-required",
    message: "PlainLib has not been built",
  };
  assert.equal(
    shouldReplaceProjectContextStatus(current, {
      uri: "file:///a.xaml",
      state: "loading",
    }),
    false
  );
  assert.equal(
    shouldReplaceProjectContextStatus(
      { uri: "file:///a.xaml", state: "restore-required" },
      { uri: "file:///a.xaml", state: "loading" }
    ),
    false
  );
});

test("recovery after a real build still lands immediately", () => {
  // The suppression must be narrow: only `loading` is held off. If any terminal state were
  // suppressed too, a developer who built would be stuck reading "build required" forever --
  // strictly worse than the flapping this fixes.
  const current: ProjectContextStatus = {
    uri: "file:///a.xaml",
    state: "build-required",
  };
  for (const state of PROJECT_CONTEXT_STATES.filter((s) => s !== "loading")) {
    assert.equal(
      shouldReplaceProjectContextStatus(current, {
        uri: "file:///a.xaml",
        state,
      }),
      true,
      `${state} must replace build-required`
    );
  }
});

test("a reload replaces any state that is not a durable fact about the project", () => {
  assert.equal(
    shouldReplaceProjectContextStatus(undefined, {
      uri: "file:///a.xaml",
      state: "loading",
    }),
    true
  );
  for (const state of ["ready", "framework-ready", "error"] as const) {
    assert.equal(
      shouldReplaceProjectContextStatus(
        { uri: "file:///a.xaml", state },
        { uri: "file:///a.xaml", state: "loading" }
      ),
      true,
      `loading must replace ${state}`
    );
  }
});

/**
 * The server sends the state as a bare string and the client narrows it with
 * `isProjectContextState`, so a state the server emits but this list does not know is *dropped* --
 * the status bar shows nothing at all rather than showing something wrong.
 *
 * Nothing in either language's test suite covers that seam: the server's states are string
 * literals inside a private method, and the client's tests only ever feed it states it already
 * knows. A server-side state added without its client counterpart therefore compiles, ships, and
 * silently displays nothing. This reads the literals back out of the C# source so that mismatch
 * fails the build instead.
 */
test("every state the server can emit is one the client knows", () => {
  const source = readFileSync(
    path.join(
      __dirname,
      "..",
      "..",
      "server",
      "src",
      "WinUiXaml.LanguageServer",
      "XamlLanguageServer.CompletionAndResources.cs"
    ),
    "utf8"
  );

  const emitted = [
    ...source.matchAll(
      /NotifyProjectContextStatusAsync\(\s*(?:uri|\w+)\s*,\s*"([a-z-]+)"/g
    ),
  ].map((match) => match[1]);

  // A regex that silently stopped matching would turn this into a tautology, so the harvest
  // itself is asserted before it is used.
  assert.ok(
    emitted.length >= 5,
    `Expected to find the server's status literals, found ${emitted.length}. ` +
      "The call shape probably changed and this test is no longer reading anything."
  );
  assert.ok(emitted.includes("restore-required"));
  assert.ok(emitted.includes("build-required"));

  const unknown = [...new Set(emitted)].filter(
    (state) => !PROJECT_CONTEXT_STATES.includes(state as never)
  );

  assert.deepEqual(
    unknown,
    [],
    `The server emits these states but the client drops them, so the status bar goes blank: ${unknown.join(", ")}`
  );
});

test("uses the project-context status notification contract", () => {
  assert.equal(PROJECT_CONTEXT_STATUS_NOTIFICATION, "winui-xaml/projectContextStatus");
});

test("prioritizes actionable errors over loading and ready states", () => {
  const statuses: ProjectContextStatus[] = [
    { uri: "file:///Ready.xaml", state: "ready" },
    { uri: "file:///Framework.xaml", state: "framework-ready" },
    { uri: "file:///Loading.xaml", state: "loading" },
    { uri: "file:///Failed.xaml", state: "error", message: "Restore required." },
  ];

  assert.deepEqual(selectProjectContextStatus(statuses), statuses[3]);
});

test("shows loading ahead of ready and ignores idle-only state", () => {
  const ready: ProjectContextStatus = { uri: "file:///Ready.xaml", state: "ready" };
  const loading: ProjectContextStatus = { uri: "file:///Loading.xaml", state: "loading" };

  assert.deepEqual(selectProjectContextStatus([ready, loading]), loading);
  assert.equal(
    selectProjectContextStatus([{ uri: "file:///Closed.xaml", state: "idle" }]),
    undefined
  );
});

test("shows framework readiness while project symbols continue loading", () => {
  const frameworkReady: ProjectContextStatus = {
    uri: "file:///Framework.xaml",
    state: "framework-ready",
  };
  const ready: ProjectContextStatus = { uri: "file:///Ready.xaml", state: "ready" };

  assert.deepEqual(selectProjectContextStatus([ready, frameworkReady]), frameworkReady);
  assert.deepEqual(getProjectContextStatusPresentation(frameworkReady), {
    text: "$(sync~spin) WinApp: XAML project loading",
    tooltip:
      "Framework IntelliSense is available. Project symbols and diagnostics are still loading.",
    transient: false,
  });

  test("scopes status to the active XAML document", () => {
    const statuses: ProjectContextStatus[] = [
      { uri: "file:///Preloaded.xaml", state: "error", message: "Restore required." },
      { uri: "file:///Active.xaml", state: "ready" },
    ];

    assert.deepEqual(
      getRelevantProjectContextStatuses(statuses, "file:///Active.xaml"),
      [statuses[1]]
    );
    assert.deepEqual(getRelevantProjectContextStatuses(statuses, null), []);
    assert.deepEqual(getRelevantProjectContextStatuses(statuses, undefined), statuses);
  });
});

test("presents persistent loading and actionable error status", () => {
  assert.deepEqual(
    getProjectContextStatusPresentation({
      uri: "file:///Loading.xaml",
      state: "loading",
    }),
    {
      text: "$(sync~spin) WinApp: XAML IntelliSense loading",
      tooltip:
        "Loading authoritative project metadata. Click to show the WinUI XAML output.",
      transient: false,
    }
  );
  assert.deepEqual(
    getProjectContextStatusPresentation({
      uri: "file:///Failed.xaml",
      state: "error",
      // Deliberately not a restore or build message: both of those have their own states now, so
      // using one here would imply this generic wording is still where they land.
      message: "The owning project could not be compiled.",
    }),
    {
      text: "$(warning) WinApp: XAML IntelliSense unavailable",
      tooltip:
        "The owning project could not be compiled. Click to show the WinUI XAML output.",
      transient: false,
    }
  );
});

test("reports the restore as work in flight while the extension is running it", () => {
  // The extension restores without being asked, so during that window "restore required" would
  // tell the developer to run a command the extension is at that moment running.
  assert.deepEqual(
    getProjectContextStatusPresentation(
      {
        uri: "file:///Fresh.xaml",
        state: "restore-required",
        message: "Restore required: App.csproj.",
      },
      { restoreInFlight: true }
    ),
    {
      text: "$(sync~spin) WinApp: restoring packages",
      tooltip:
        "Restoring the project's packages. Project-aware IntelliSense resumes when it " +
        "completes. Click to show the WinUI XAML output.",
      transient: false,
    }
  );

  // Once it finishes without fixing the condition -- a restore that failed -- the state is an
  // outstanding demand again, so the instruction comes back. The error notification that reported
  // the failure is transient; the bar is what the developer still sees a minute later.
  assert.match(
    getProjectContextStatusPresentation(
      {
        uri: "file:///Fresh.xaml",
        state: "restore-required",
        message: "Restore required: App.csproj.",
      },
      { restoreInFlight: false }
    )?.text ?? "",
    /restore required/
  );

  // The flag describes the restore only; a build the extension is not running still instructs.
  assert.match(
    getProjectContextStatusPresentation(
      { uri: "file:///Fresh.xaml", state: "build-required", message: "build me" },
      { restoreInFlight: true }
    )?.text ?? "",
    /build required/
  );
});

test("names the restore in the bar itself, and outranks the build", () => {
  // A never-restored project is as user-fixable as a never-built one, and reached earlier on a
  // clean clone. Before this state existed it fell through to "XAML IntelliSense unavailable",
  // which describes a broken extension rather than a one-command fix.
  assert.deepEqual(
    getProjectContextStatusPresentation({
      uri: "file:///Fresh.xaml",
      state: "restore-required",
      message: "Restore required: App.csproj.",
    }),
    {
      text: "$(package) WinApp: restore required for XAML IntelliSense",
      tooltip: "Restore required: App.csproj. Click to show the WinUI XAML output.",
      transient: false,
    }
  );

  // Restore is the prerequisite for build, so naming the build while packages are missing would
  // point the developer at the step that fails second.
  assert.equal(
    selectProjectContextStatus([
      { uri: "file:///A.xaml", state: "build-required", message: "build me" },
      { uri: "file:///A.xaml", state: "restore-required", message: "restore me" },
    ])?.state,
    "restore-required"
  );

  assert.equal(
    selectProjectContextStatus([
      { uri: "file:///A.xaml", state: "error", message: "boom" },
      { uri: "file:///A.xaml", state: "restore-required", message: "restore me" },
    ])?.state,
    "restore-required"
  );

  // The client narrows the server's notification payload, so a state the server emits but this
  // list does not know is dropped and nothing reaches the bar at all.
  assert.equal(isProjectContextState("restore-required"), true);
});

test("names the build in the bar itself, and outranks a plain error", () => {
  assert.deepEqual(
    getProjectContextStatusPresentation({
      uri: "file:///Diamond.xaml",
      state: "build-required",
      message: "Build required: App.csproj (unresolved: MiddleLib, SharedLib).",
    }),
    {
      text: "$(tools) WinApp: build required for XAML IntelliSense",
      tooltip:
        "Build required: App.csproj (unresolved: MiddleLib, SharedLib). " +
        "Click to show the WinUI XAML output.",
      transient: false,
    }
  );

  // A server that reports both must surface the one with a fix attached.
  assert.equal(
    selectProjectContextStatus([
      { uri: "file:///A.xaml", state: "error", message: "boom" },
      { uri: "file:///A.xaml", state: "build-required", message: "build me" },
    ])?.state,
    "build-required"
  );

  assert.equal(isProjectContextState("build-required"), true);
});

test("presents ready status briefly and hides idle status", () => {
  assert.deepEqual(
    getProjectContextStatusPresentation({
      uri: "file:///Ready.xaml",
      state: "ready",
    }),
    {
      text: "$(check) WinApp: XAML IntelliSense ready",
      tooltip: "Project-aware XAML IntelliSense is ready.",
      transient: true,
    }
  );
  assert.equal(
    getProjectContextStatusPresentation({
      uri: "file:///Closed.xaml",
      state: "idle",
    }),
    undefined
  );
});
