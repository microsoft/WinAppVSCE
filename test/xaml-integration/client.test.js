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
