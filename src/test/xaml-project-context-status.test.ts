import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_CONTEXT_STATUS_NOTIFICATION,
  ProjectContextStatus,
  getRelevantProjectContextStatuses,
  getProjectContextStatusPresentation,
  selectProjectContextStatus,
} from "../xaml/projectContextStatus";

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
    text: "$(sync~spin) WinApp: XAML framework IntelliSense ready",
    tooltip:
      "WinUI types and properties are ready. Project symbols and diagnostics are still loading.",
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
      message: "Restore required.",
    }),
    {
      text: "$(warning) WinApp: XAML IntelliSense unavailable",
      tooltip: "Restore required. Click to show the WinUI XAML output.",
      transient: false,
    }
  );
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
