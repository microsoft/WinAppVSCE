import assert from "node:assert/strict";
import test from "node:test";
import {
  getXamlStatus,
  getXamlStatusEffect,
  normalizeDiagnosticsLevel,
  readXamlLanguageServerConfiguration,
  shouldRestartXamlLanguageServer,
} from "../xaml/xamlConfiguration";

test("reports disabled, running, and degraded XAML status actions", () => {
  assert.deepEqual(getXamlStatus(false, false, true, false), {
    message:
      "WinUI XAML Tools — IntelliSense is disabled in Settings; syntax highlighting remains active.",
    actions: ["Open Settings"],
  });

  assert.deepEqual(getXamlStatus(true, true, true, true), {
    message: "WinUI XAML Tools — language server running (Host B).",
    actions: [],
  });
  assert.deepEqual(getXamlStatus(true, false, true, true).actions, [
    "Restart Language Server",
    "Show Output",
  ]);
  assert.deepEqual(getXamlStatus(true, false, false, true).actions, [
    "Manage Workspace Trust",
    "Show Output",
  ]);
  assert.deepEqual(getXamlStatus(true, false, true, false), {
    message:
      "WinUI XAML Tools — ready; the language server starts when a XAML file is opened.",
    actions: [],
  });
});

test("maps every XAML status action to its recovery effect", () => {
  assert.deepEqual(getXamlStatusEffect("Open Settings"), {
    command: "workbench.action.openSettings",
    args: ["winapp.xaml.intelliSense.enable"],
  });
  assert.deepEqual(getXamlStatusEffect("Restart Language Server"), {
    command: "winui-xaml.restartServer",
  });
  assert.deepEqual(getXamlStatusEffect("Manage Workspace Trust"), {
    command: "workbench.trust.manage",
  });
  assert.deepEqual(getXamlStatusEffect("Show Output"), { showOutput: true });
  assert.equal(getXamlStatusEffect(undefined), undefined);
});

test("normalizes supported XAML diagnostic levels", () => {
  assert.equal(normalizeDiagnosticsLevel("off"), "off");
  assert.equal(normalizeDiagnosticsLevel("warning"), "warning");
  assert.equal(normalizeDiagnosticsLevel("error"), "error");
});

test("defaults unknown XAML diagnostic levels to warning", () => {
  assert.equal(normalizeDiagnosticsLevel("unexpected"), "warning");
  assert.equal(normalizeDiagnosticsLevel(""), "warning");
});

test("reads startup enablement and diagnostics initialization options together", () => {
  const values = new Map<string, unknown>([
    ["intelliSense.enable", false],
    ["diagnostics.level", "error"],
  ]);
  const configuration = readXamlLanguageServerConfiguration(
    <T>(section: string, defaultValue: T) =>
      (values.has(section) ? values.get(section) : defaultValue) as T
  );

  assert.deepEqual(configuration, {
    enabled: false,
    initializationOptions: { diagnosticsLevel: "error" },
  });
});

test("restarts on configuration changes only for an active or needed server", () => {
  assert.equal(shouldRestartXamlLanguageServer(false, false), false);
  assert.equal(shouldRestartXamlLanguageServer(true, false), true);
  assert.equal(shouldRestartXamlLanguageServer(false, true), true);
});
