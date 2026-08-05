"use strict";

// Integration coverage for the extension's LSP *client surface* (src/xaml/xamlLanguageService.ts):
// the winui-xaml.showInfo / winui-xaml.restartServer commands, restart lifecycle serialization, and
// graceful degradation to syntax-only when the server can't launch. Complements features.test.js
// (which exercises the language features themselves) by driving the client's own commands/config.
//
// Note on scope: the harness normally resolves a real server DLL (via WINUI_XAML_SERVER_DLL and the
// repo-relative Debug build). Two graceful-degradation paths are covered here: (1) the missing-DLL
// path, forced deterministically via the WINUI_XAML_FORCE_NO_SERVER test seam (resolveServer
// returns undefined → notifyDegraded → syntax-only); and (2) the bad-dotnetPath path, which drives
// doStart's catch → notify → return. Both prove activation stays syntax-only and never throws.

const assert = require("node:assert");
const vscode = require("vscode");
const h = require("./helper");

const EXT = "winui-xaml";

describe("WinUI XAML — client commands & lifecycle", function () {
  this.timeout(180000);

  before(async () => {
    await h.warmUp();
  });

  after(async () => {
    // Make sure we hand a healthy, default-configured server to any later test files.
    await vscode.workspace
      .getConfiguration(EXT)
      .update("server.dotnetPath", undefined, vscode.ConfigurationTarget.Global);
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
    // After a clean restart the server answers completions again (proves start/stop serialization).
    await h.warmUp();
    const items = await h.completionsAt(`<Page ${h.NS}>\n  <But|\n</Page>`);
    assert.ok(items.includes("Button"), `expected Button after restart; got ${items.slice(0, 20).join(", ")}`);
  });

  it("tolerates rapid back-to-back restarts (no torn-down pending start)", async () => {
    // Fire several restarts without awaiting between them; the lifecycle mutex must keep these from
    // stopping a still-pending start. All must settle without rejecting.
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

  it("degrades to syntax-only when the server DLL is absent (no throw)", async function () {
    // Force resolveServer to find no server (test-only seam), reproducing the missing-server branch
    // that resolves undefined → notifyDegraded → syntax-only, without a real running server.
    process.env.WINUI_XAML_FORCE_NO_SERVER = "1";
    try {
      // Restart must swallow the missing-DLL condition and resolve — activation stays syntax-only.
      await assert.doesNotReject(
        () => vscode.commands.executeCommand("winui-xaml.restartServer"),
        "restartServer must not reject when the server DLL is absent"
      );

      if (vscode.workspace.isTrusted) {
        // With no server, element-name completion no longer produces "Button".
        const items = await h.completionsAt(`<Page ${h.NS}>\n  <But|\n</Page>`);
        assert.ok(
          !items.includes("Button"),
          `expected syntax-only degradation (no Button) but got: ${items.slice(0, 20).join(", ")}`
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

  it("degrades to syntax-only when dotnet can't launch (no throw)", async function () {
    // The trust gate ignores workspace-provided dotnetPath in untrusted workspaces, so the bad value
    // would have no effect there — only assert the degraded behavior when the workspace is trusted.
    const config = () => vscode.workspace.getConfiguration(EXT);
    const debugDll = process.env.WINUI_XAML_TEST_DLL;
    assert.ok(debugDll, "harness must expose a Debug server DLL for the dotnet fallback test");
    await config().update("server.path", debugDll, vscode.ConfigurationTarget.Global);
    await config().update(
      "server.dotnetPath",
      "winui-xaml-nonexistent-dotnet",
      vscode.ConfigurationTarget.Global
    );
    try {
      // Restart must swallow the launch failure and resolve — activation stays syntax-only.
      await assert.doesNotReject(
        () => vscode.commands.executeCommand("winui-xaml.restartServer"),
        "restartServer must not reject even when the server can't launch"
      );

      if (vscode.workspace.isTrusted) {
        // With no running server, the element-name completion no longer produces "Button".
        const items = await h.completionsAt(`<Page ${h.NS}>\n  <But|\n</Page>`);
        assert.ok(
          !items.includes("Button"),
          `expected syntax-only degradation (no Button) but got: ${items.slice(0, 20).join(", ")}`
        );
      }
    } finally {
      // Recover: restore the default dotnet and restart so the server comes back for later tests.
      await config().update("server.dotnetPath", undefined, vscode.ConfigurationTarget.Global);
      await config().update("server.path", undefined, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand("winui-xaml.restartServer");
      await h.warmUp();
    }

    const recovered = await h.completionsAt(`<Page ${h.NS}>\n  <But|\n</Page>`);
    assert.ok(recovered.includes("Button"), "server should recover after restoring dotnetPath");
  });

  it("automatically restarts when server path settings change", async function () {
    const config = () => vscode.workspace.getConfiguration(EXT);
    const debugDll = process.env.WINUI_XAML_TEST_DLL;
    assert.ok(debugDll, "harness must expose a Debug server DLL");
    await config().update("server.path", debugDll, vscode.ConfigurationTarget.Global);
    await config().update(
      "server.dotnetPath",
      "winui-xaml-nonexistent-dotnet",
      vscode.ConfigurationTarget.Global
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const degraded = await h.completionsAt(`<Page ${h.NS}>\n  <But|\n</Page>`);
      assert.ok(!degraded.includes("Button"), "configuration change should stop the old server");
    } finally {
      await config().update("server.dotnetPath", undefined, vscode.ConfigurationTarget.Global);
      await config().update("server.path", undefined, vscode.ConfigurationTarget.Global);
      await h.warmUp();
    }

    const recovered = await h.completionsAt(`<Page ${h.NS}>\n  <But|\n</Page>`);
    assert.ok(recovered.includes("Button"), "clearing settings should automatically restart the server");
  });

  it("degrades to syntax-only when the workspace is untrusted, then recovers (WINUI_XAML_FORCE_UNTRUSTED)", async function () {
    // The harness runs with --disable-workspace-trust (isTrusted === true), so the untrusted gate is
    // never hit organically. WINUI_XAML_FORCE_UNTRUSTED is the test seam (mirrors WINUI_XAML_FORCE_NO_SERVER)
    // that forces doStart down the untrusted branch: the semantic server is not started, so element-name
    // completion loses "Button". Clearing the seam and restarting (the same path onDidGrantWorkspaceTrust
    // takes) must bring the server back.
    process.env.WINUI_XAML_FORCE_UNTRUSTED = "1";
    try {
      // (a) Forced-untrusted restart must not reject and must degrade to syntax-only (no server).
      await assert.doesNotReject(
        () => vscode.commands.executeCommand("winui-xaml.restartServer"),
        "restartServer must not reject when the workspace is untrusted"
      );
      const degraded = await h.completionsAt(`<Page ${h.NS}>\n  <But|\n</Page>`);
      assert.ok(
        !degraded.includes("Button"),
        `expected syntax-only degradation while untrusted (no Button) but got: ${degraded.slice(0, 20).join(", ")}`
      );
    } finally {
      // (b) Simulate trust being granted: clear the seam and restart, which must start the server.
      delete process.env.WINUI_XAML_FORCE_UNTRUSTED;
      await vscode.commands.executeCommand("winui-xaml.restartServer");
      await h.warmUp();
    }

    const recovered = await h.completionsAt(`<Page ${h.NS}>\n  <But|\n</Page>`);
    assert.ok(recovered.includes("Button"), "server should start once trust is granted (seam cleared)");
  });

  it("resolves an explicit winui-xaml.server.path and serves semantic completion", async function () {
    // Exercises the configuredDll branch of resolveServerDll (candidate #1), which the other tests
    // never hit (they rely on the WINUI_XAML_SERVER_DLL env / repo-relative fallback). Point server.path
    // at the freshly-built Debug DLL (the value the harness normally passes via the env var) and clear
    // the env so the explicit setting is the ONLY thing that can resolve the server.
    const debugDll = process.env.WINUI_XAML_TEST_DLL;
    assert.ok(debugDll, "harness must expose the Debug server DLL via WINUI_XAML_TEST_DLL");
    const config = () => vscode.workspace.getConfiguration(EXT);
    delete process.env.WINUI_XAML_SERVER_DLL;
    await config().update("server.path", debugDll, vscode.ConfigurationTarget.Global);
    try {
      await assert.doesNotReject(
        () => vscode.commands.executeCommand("winui-xaml.restartServer"),
        "restartServer must not reject when server.path points at a valid DLL"
      );
      await h.warmUp();
      const items = await h.completionsAt(`<Page ${h.NS}>\n  <But|\n</Page>`);
      assert.ok(items.includes("Button"), `expected Button via explicit server.path; got ${items.slice(0, 20).join(", ")}`);
    } finally {
      process.env.WINUI_XAML_SERVER_DLL = debugDll;
      await config().update("server.path", undefined, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand("winui-xaml.restartServer");
      await h.warmUp();
    }

    const recovered = await h.completionsAt(`<Page ${h.NS}>\n  <But|\n</Page>`);
    assert.ok(recovered.includes("Button"), "server should recover after clearing server.path");
  });

  it("degrades to syntax-only when winui-xaml.server.path points at an invalid DLL (no throw)", async function () {
    // An existing-but-non-DLL server.path resolves (the file exists) but fails to launch as an assembly,
    // driving doStart's catch -> notifyDegraded -> syntax-only. Clear the env too so the invalid setting
    // wins over every fallback candidate.
    const debugDll = process.env.WINUI_XAML_SERVER_DLL;
    const config = () => vscode.workspace.getConfiguration(EXT);
    delete process.env.WINUI_XAML_SERVER_DLL;
    await config().update("server.path", h.XAML_PATH, vscode.ConfigurationTarget.Global);
    try {
      await assert.doesNotReject(
        () => vscode.commands.executeCommand("winui-xaml.restartServer"),
        "restartServer must not reject when server.path is an invalid DLL"
      );
      if (vscode.workspace.isTrusted) {
        const items = await h.completionsAt(`<Page ${h.NS}>\n  <But|\n</Page>`);
        assert.ok(
          !items.includes("Button"),
          `expected syntax-only degradation for an invalid server.path but got: ${items.slice(0, 20).join(", ")}`
        );
      }
    } finally {
      if (debugDll) process.env.WINUI_XAML_SERVER_DLL = debugDll;
      await config().update("server.path", undefined, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand("winui-xaml.restartServer");
      await h.warmUp();
    }

    const recovered = await h.completionsAt(`<Page ${h.NS}>\n  <But|\n</Page>`);
    assert.ok(recovered.includes("Button"), "server should recover after clearing the invalid server.path");
  });
});
