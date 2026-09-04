"use strict";

// LSP client commands, restart serialization, and syntax-only degradation.

const assert = require("node:assert");
const vscode = require("vscode");
const h = require("./helper");

async function hasSemanticButtonCompletion() {
  const items = await h.completionItemsAt(`<Page ${h.NS}>\n  <But|\n</Page>`);
  return {
    found: items.some((item) =>
      item.label === "Button" &&
      typeof item.detail === "string" &&
      item.detail.startsWith("Microsoft.UI.Xaml")),
    labels: items.slice(0, 20).map((item) => `${item.label}${item.detail ? ` (${item.detail})` : ""}`),
  };
}

async function waitForSemanticButton(expected, timeoutMs = 30000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await hasSemanticButtonCompletion();
    if (last.found === expected) {
      return last;
    }
    await h.delay(200);
  }
  assert.fail(
    `semantic Button completion did not become ${expected ? "available" : "unavailable"}; ` +
      `last items: ${(last?.labels || []).join(", ")}`
  );
}

describe("WinUI XAML — cold hover contract", function () {
  this.timeout(30000);

  before(async () => {
    await h.openProbe();
    await vscode.commands.executeCommand("winui-xaml.restartServer");
  });

  it("serves directives immediately and framework syntax as soon as metadata is ready", async () => {
    const xaml =
      '<Page xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"\n' +
      '      xmlns:language="http://schemas.microsoft.com/winfx/2006/xaml"\n' +
      '      xmlns:compat="http://schemas.openxmlformats.org/markup-compatibility/2006"\n' +
      '      language:Class="SmokeFixture.SmokePage" compat:Ignorable="design"\n' +
      '      NavigationCacheMode="Required">\n' +
      '  <Button Content="Hello" />\n' +
      '</Page>';

    for (const [probe, expected] of [
      [xaml.replace("language:Class", "language:Cl|ass"), /CLR class/i],
      [xaml.replace("compat:Ignorable", "compat:Ign|orable"), /namespace prefixes/i],
    ]) {
      const { markdown, elapsedMs } = await h.timedHoverAt(probe);
      const prose = (markdown.split("```")[2] || "").trim();
      assert.ok(prose.length > 0, `expected prose below the signature; got: ${markdown}`);
      assert.doesNotMatch(markdown, /loading/i, `hover must not expose loading state; got: ${markdown}`);
      assert.match(prose, expected, `expected useful project-independent prose; got: ${markdown}`);
      assert.ok(elapsedMs < 1000, `project-independent hover took ${elapsedMs.toFixed(0)} ms; expected <1000 ms`);
    }

    for (const [probe, expected] of [
      [xaml.replace("<Page", "<Pa|ge"), /(?:XAML element[\s\S]+Page[\s\S]+presentation|Represents content)/i],
      [xaml.replace("NavigationCacheMode", "NavigationCache|Mode"), /(?:XAML attribute[\s\S]+NavigationCacheMode[\s\S]+Page[\s\S]+Required|Gets or sets the navigation mode)/i],
      [xaml.replace('"Required"', '"Req|uired"'), /(?:Literal value[\s\S]+Required[\s\S]+NavigationCacheMode[\s\S]+Page|page is cached)/i],
      [xaml.replace("Content=", "Cont|ent="), /(?:XAML attribute[\s\S]+Content[\s\S]+Button[\s\S]+Hello|Gets or sets the content)/i],
    ]) {
      const started = performance.now();
      const markdown = await h.hoverMatchingAt(
        probe,
        (value) => expected.test((value.split("```")[2] || "").trim()),
        10000
      );
      const elapsedMs = performance.now() - started;
      const prose = (markdown.split("```")[2] || "").trim();
      assert.ok(prose.length > 0, `expected prose below the signature; got: ${markdown}`);
      assert.doesNotMatch(markdown, /loading/i, `hover must not expose loading state; got: ${markdown}`);
      assert.match(prose, expected, `expected useful framework prose; got: ${markdown}`);
      assert.ok(elapsedMs < 10000, `framework hover took ${elapsedMs.toFixed(0)} ms; expected <10000 ms`);
    }
  });
});

describe("WinUI XAML — client commands & lifecycle", function () {
  this.timeout(180000);

  before(async () => {
    await h.warmUp();
  });

  after(async () => {
    await vscode.commands.executeCommand("winui-xaml.restartServer");
    await h.warmUp();
    await h.revertProbe();
  });

  it("registers the winui-xaml commands", async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("winui-xaml.showInfo"), "expected winui-xaml.showInfo to be registered");
    assert.ok(
      commands.includes("winui-xaml.restartServer"),
      "expected winui-xaml.restartServer to be registered"
    );
  });

  it("executes winui-xaml.showInfo without throwing", async () => {
    // showInfo pops a non-blocking information message; executing it must resolve, not reject.
    await assert.doesNotReject(() => vscode.commands.executeCommand("winui-xaml.showInfo"));
  });

  it("restarts the server and keeps it healthy", async () => {
    await assert.doesNotReject(
      () => vscode.commands.executeCommand("winui-xaml.restartServer"),
      "restartServer should never reject"
    );
    // A completion response confirms restart serialization.
    await h.warmUp();
    const items = await h.completionsAt(`<Page ${h.NS}>\n  <But|\n</Page>`);
    assert.ok(items.includes("Button"), `expected Button after restart; got ${items.slice(0, 20).join(", ")}`);
  });

  it("tolerates rapid back-to-back restarts (no torn-down pending start)", async () => {
    // Fire several restarts without awaiting between them; the lifecycle mutex must keep these from stopping a still-pending start. All must settle without rejecting.
    const restarts = [
      vscode.commands.executeCommand("winui-xaml.restartServer"),
      vscode.commands.executeCommand("winui-xaml.restartServer"),
      vscode.commands.executeCommand("winui-xaml.restartServer"),
    ];
    await assert.doesNotReject(() => Promise.all(restarts));
    await h.warmUp();
    const items = await h.completionsAt(`<Page ${h.NS}>\n  <But|\n</Page>`);
    assert.ok(items.includes("Button"), "server should recover after rapid restarts");
  });

  it("stays syntax-only while XAML IntelliSense is disabled and starts after re-enabling", async () => {
    const configuration = vscode.workspace.getConfiguration("winapp.xaml");
    const previous = configuration.inspect("intelliSense.enable")?.globalValue;
    try {
      await configuration.update(
        "intelliSense.enable",
        false,
        vscode.ConfigurationTarget.Global
      );
      await waitForSemanticButton(false);
    } finally {
      await configuration.update(
        "intelliSense.enable",
        previous,
        vscode.ConfigurationTarget.Global
      );
      await waitForSemanticButton(true);
    }

    const recovered = await hasSemanticButtonCompletion();
    assert.ok(recovered.found, "server should start after XAML IntelliSense is re-enabled");
  });

  it("applies diagnostic levels sent through client initialization options", async () => {
    const configuration = vscode.workspace.getConfiguration("winapp.xaml");
    const previous = configuration.inspect("diagnostics.level")?.globalValue;
    const hasCode = (diagnostics, code) =>
      diagnostics.some((diagnostic) => String(diagnostic.code) === code);
    try {
      await configuration.update(
        "diagnostics.level",
        "warning",
        vscode.ConfigurationTarget.Global
      );
      const existing = await h.diagnosticsFor(
        `<Page ${h.NS}>\n  <Buton />\n</Page>`,
        (diagnostics) => hasCode(diagnostics, "WXAML0002")
      );
      assert.ok(hasCode(existing, "WXAML0002"), "warning should publish semantic warnings");

      await configuration.update(
        "diagnostics.level",
        "off",
        vscode.ConfigurationTarget.Global
      );
      const openDocument = h.getDoc();
      const suppressionStarted = Date.now();
      while (
        Date.now() - suppressionStarted < 5000 &&
        hasCode(vscode.languages.getDiagnostics(openDocument.uri), "WXAML0002")
      ) {
        await h.delay(100);
      }
      assert.ok(
        !hasCode(vscode.languages.getDiagnostics(openDocument.uri), "WXAML0002"),
        "off should republish unchanged open documents without semantic warnings"
      );

      await waitForSemanticButton(true);
      const suppressed = await h.diagnosticsFor(
        `<Page ${h.NS}>\n  <Buton />\n</Page>`,
        undefined,
        2000
      );
      assert.ok(!hasCode(suppressed, "WXAML0002"), "off should suppress semantic warnings");

      await configuration.update(
        "diagnostics.level",
        "error",
        vscode.ConfigurationTarget.Global
      );
      await waitForSemanticButton(true);
      const errorsOnly = await h.diagnosticsFor(
        `<Page ${h.NS}>\n  <local:NoSuchControl />\n  <zzz:Widget />\n</Page>`,
        (diagnostics) =>
          hasCode(diagnostics, "WXAML0001") &&
          hasCode(diagnostics, "WXAML0002")
      );
      assert.ok(hasCode(errorsOnly, "WXAML0001"), "error level should preserve errors");
      assert.ok(
        hasCode(errorsOnly, "WXAML0002"),
        "error level should preserve authoritative unknown-type errors"
      );
      assert.ok(
        errorsOnly.every((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error),
        "error level should filter non-error diagnostics"
      );
    } finally {
      await configuration.update(
        "diagnostics.level",
        previous,
        vscode.ConfigurationTarget.Global
      );
      await waitForSemanticButton(true);
    }
  });

  it("degrades to syntax-only when the server DLL is absent (no throw)", async function () {
    // Force resolveServer to find no server (test-only seam), reproducing the missing-server branch that resolves undefined → notifyDegraded → syntax-only, without a real running server.
    process.env.WINUI_XAML_FORCE_NO_SERVER = "1";
    try {
      // Restart must swallow the missing-DLL condition and resolve — activation stays syntax-only.
      await assert.doesNotReject(
        () => vscode.commands.executeCommand("winui-xaml.restartServer"),
        "restartServer must not reject when the server DLL is absent"
      );

      if (vscode.workspace.isTrusted) {
        // With no server, element-name completion no longer produces "Button".
        const items = await hasSemanticButtonCompletion();
        assert.ok(
          !items.found,
          `expected syntax-only degradation (no semantic Button) but got: ${items.labels.join(", ")}`
        );
      }
    } finally {
      // Recover: drop the seam and restart so the server comes back for later tests.
      delete process.env.WINUI_XAML_FORCE_NO_SERVER;
      await vscode.commands.executeCommand("winui-xaml.restartServer");
      await h.warmUp();
    }

    const recovered = await h.completionsAt(`<Page ${h.NS}>\n  <But|\n</Page>`);
    assert.ok(recovered.includes("Button"), "server should recover after clearing the missing-DLL seam");
  });

  it("degrades to syntax-only without .NET 10, then recovers after restart", async function () {
    process.env.WINUI_XAML_FORCE_NO_DOTNET = "1";
    try {
      await assert.doesNotReject(
        () => vscode.commands.executeCommand("winui-xaml.restartServer"),
        "restartServer must not reject when the required runtime is absent"
      );
      const degraded = await waitForSemanticButton(false);
      assert.ok(
        !degraded.found,
        `expected syntax-only degradation without .NET 10; got: ${degraded.labels.join(", ")}`
      );
    } finally {
      delete process.env.WINUI_XAML_FORCE_NO_DOTNET;
      await vscode.commands.executeCommand("winui-xaml.restartServer");
    }

    const recovered = await waitForSemanticButton(true, 60000);
    assert.ok(recovered.found, "server should recover after .NET 10 becomes available");
  });

  it("degrades to syntax-only when the workspace is untrusted, then recovers (WINUI_XAML_FORCE_UNTRUSTED)", async function () {
    // The harness is trusted; this seam exercises the untrusted security boundary. Clearing it follows the same restart path as granting workspace trust.
    process.env.WINUI_XAML_FORCE_UNTRUSTED = "1";
    try {
      // Force syntax-only mode without starting the server.
      await assert.doesNotReject(
        () => vscode.commands.executeCommand("winui-xaml.restartServer"),
        "restartServer must not reject when the workspace is untrusted"
      );
      const degraded = await hasSemanticButtonCompletion();
      assert.ok(
        !degraded.found,
        `expected syntax-only degradation while untrusted (no semantic Button) but got: ${degraded.labels.join(", ")}`
      );
    } finally {
      // Simulate granting trust.
      delete process.env.WINUI_XAML_FORCE_UNTRUSTED;
      await vscode.commands.executeCommand("winui-xaml.restartServer");
      await h.warmUp();
    }

    const recovered = await h.completionsAt(`<Page ${h.NS}>\n  <But|\n</Page>`);
    assert.ok(recovered.includes("Button"), "server should start once trust is granted (seam cleared)");
  });

});
