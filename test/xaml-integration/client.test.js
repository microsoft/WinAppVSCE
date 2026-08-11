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

describe("WinUI XAML — cold hover contract", function () {
  this.timeout(30000);

  before(async () => {
    await h.openProbe();
    await vscode.commands.executeCommand("winui-xaml.restartServer");
  });

  it("serves directives and framework syntax in under one second without warmUp", async () => {
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
      [xaml.replace("<Page", "<Pa|ge"), /(?:XAML element[\s\S]+Page[\s\S]+presentation|Represents content)/i],
      [xaml.replace("NavigationCacheMode", "NavigationCache|Mode"), /(?:XAML attribute[\s\S]+NavigationCacheMode[\s\S]+Page[\s\S]+Required|Gets or sets the navigation mode)/i],
      [xaml.replace('"Required"', '"Req|uired"'), /(?:Literal value[\s\S]+Required[\s\S]+NavigationCacheMode[\s\S]+Page|page is cached)/i],
      [xaml.replace("Content=", "Cont|ent="), /(?:XAML attribute[\s\S]+Content[\s\S]+Button[\s\S]+Hello|Gets or sets the content)/i],
    ]) {
      const { markdown, elapsedMs } = await h.timedHoverAt(probe);
      const prose = (markdown.split("```")[2] || "").trim();
      assert.ok(prose.length > 0, `expected prose below the signature; got: ${markdown}`);
      assert.doesNotMatch(markdown, /loading/i, `hover must not expose loading state; got: ${markdown}`);
      assert.match(prose, expected, `expected useful project-independent prose; got: ${markdown}`);
      assert.ok(elapsedMs < 1000, `cold hover took ${elapsedMs.toFixed(0)} ms; expected <1000 ms`);
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
