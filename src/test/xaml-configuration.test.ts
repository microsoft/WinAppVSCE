import assert from "node:assert/strict";
import test from "node:test";
import {
  DOTNET_REQUIRED_STATUS,
  getDiagnosticsLevelValidationMessage,
  getXamlStatus,
  getXamlStatusEffect,
  normalizeDiagnosticsLevel,
  readXamlLanguageServerConfiguration,
  shouldRestartXamlLanguageServer,
} from "../xaml/xamlConfiguration";

test("defines the persistent missing-runtime status and recovery command", () => {
  assert.deepEqual(DOTNET_REQUIRED_STATUS, {
    text: "$(warning) XAML: .NET 10 required",
    tooltip:
      "WinUI XAML IntelliSense requires .NET 10. Select for install and restart options.",
    command: "winui-xaml.showInfo",
  });
});

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
  assert.deepEqual(getXamlStatus(true, false, true, true, true), {
    message: "WinUI XAML Tools — .NET 10 is required; XAML syntax highlighting remains active.",
    actions: ["Install .NET", "Restart Language Server", "Show Output"],
  });
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
  assert.deepEqual(getXamlStatusEffect("Install .NET"), {
    url: "https://dotnet.microsoft.com/download/dotnet/10.0",
  });
  assert.equal(getXamlStatusEffect(undefined), undefined);
});

test("normalizes supported XAML diagnostic levels", () => {
  assert.equal(normalizeDiagnosticsLevel("off"), "off");
  assert.equal(normalizeDiagnosticsLevel("all"), "warning");
  assert.equal(normalizeDiagnosticsLevel("errorsOnly"), "error");
  assert.equal(normalizeDiagnosticsLevel("warning"), "warning");
  assert.equal(normalizeDiagnosticsLevel("error"), "error");
});

test("defaults unknown XAML diagnostic levels to warning", () => {
  assert.equal(normalizeDiagnosticsLevel("unexpected"), "warning");
  assert.equal(normalizeDiagnosticsLevel(""), "warning");
});

test("validates diagnostic aliases and explains invalid values", () => {
  for (const value of ["all", "errorsOnly", "off", "warning", "error"]) {
    assert.equal(getDiagnosticsLevelValidationMessage(value), undefined);
  }
  assert.match(
    getDiagnosticsLevelValidationMessage("syntax") ?? "",
    /Invalid winapp\.xaml\.diagnostics\.level value 'syntax'.*all, errorsOnly, or off/
  );
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
