"use strict";

const assert = require("node:assert");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

describe("WinUI XAML — rename without SDK metadata", function () {
  this.timeout(180000);

  it("returns an actionable prepareRename error instead of offering a partial rename", async () => {
    const serverPath =
      process.env.WINUI_XAML_TEST_SERVER_PATH ||
      process.env.WINUI_XAML_SERVER_PATH;
    assert.ok(serverPath && fs.existsSync(serverPath), `A test server must exist; got ${serverPath}`);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "winui-xaml-no-sdk-"));
    const file = path.join(root, "Loose.xaml");
    const uri = vscode.Uri.file(file).toString();
    const rootUri = vscode.Uri.file(root).toString();
    const isDll = serverPath.toLowerCase().endsWith(".dll");
    const child = cp.spawn(isDll ? "dotnet" : serverPath, isDll ? [serverPath] : [], {
      cwd: path.dirname(serverPath),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let nextId = 1;
    let buffer = Buffer.alloc(0);
    const pending = new Map();
    let version = 1;
    const send = (method, params, notification = false) => {
      const message = notification
        ? { jsonrpc: "2.0", method, params }
        : { jsonrpc: "2.0", id: nextId++, method, params };
      const json = JSON.stringify(message);
      child.stdin.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
      if (notification) return Promise.resolve();
      return new Promise((resolve, reject) => {
        pending.set(message.id, { resolve, reject });
        setTimeout(() => {
          if (pending.delete(message.id)) reject(new Error(`${method} timed out`));
        }, 90000);
      });
    };

    child.stdout.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const match = /^Content-Length:\s*(\d+)/im.exec(
          buffer.slice(0, headerEnd).toString("ascii"));
        assert.ok(match, "server response must include Content-Length");
        const length = Number(match[1]);
        const bodyStart = headerEnd + 4;
        if (buffer.length < bodyStart + length) return;
        const message = JSON.parse(
          buffer.slice(bodyStart, bodyStart + length).toString("utf8"));
        buffer = buffer.slice(bodyStart + length);
        if (message.id !== undefined && pending.has(message.id)) {
          const request = pending.get(message.id);
          pending.delete(message.id);
          message.error
            ? request.reject(new Error(JSON.stringify(message.error)))
            : request.resolve(message.result);
        }
      }
    });
    child.stderr.on("data", () => {});
    const positionOf = (text, token, occurrence = 0) => {
      let offset = -1;
      for (let i = 0; i <= occurrence; i++) {
        offset = text.indexOf(token, offset + 1);
      }
      assert.ok(offset >= 0, `token ${token} occurrence ${occurrence} must exist`);
      const before = text.slice(0, offset);
      const lineStart = before.lastIndexOf("\n");
      return {
        line: (before.match(/\n/g) || []).length,
        character: offset - (lineStart + 1),
      };
    };
    const changeDocument = async (text) => {
      version++;
      await send("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      }, true);
    };

    try {
      await send("initialize", {
        processId: process.pid,
        rootUri,
        capabilities: { textDocument: { rename: { prepareSupport: true } } },
      });
      await send("initialized", {}, true);
      await send("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: "xaml",
          version,
          text: '<Grid x:Name="Root" />',
        },
      }, true);

      await assert.rejects(
        send("textDocument/prepareRename", {
          textDocument: { uri },
          position: { line: 0, character: 16 },
        }),
        /Rename requires complete WinUI SDK metadata.*restore.*Show Info/i);

      const declarationText = '<Grid x:Name="Root" />';
      await assert.rejects(
        send("textDocument/references", {
          textDocument: { uri },
          position: positionOf(declarationText, "Root"),
          context: { includeDeclaration: true },
        }),
        /Find References requires complete WinUI SDK metadata.*restore.*Show Info/i);
      await assert.rejects(
        send("textDocument/documentHighlight", {
          textDocument: { uri },
          position: positionOf(declarationText, "Root"),
        }),
        /Document highlights requires complete WinUI SDK metadata.*restore.*Show Info/i);

      const referenceCases = [
        '<Grid x:Name="Root"><DoubleAnimation Storyboard.TargetName="Root" /></Grid>',
        '<Grid x:Name="Root"><Button RelativePanel.RightOf="Root" /></Grid>',
        '<Grid x:Name="Root"><Setter Target="Root.Opacity" /></Grid>',
      ];
      for (const text of referenceCases) {
        await changeDocument(text);
        const position = positionOf(text, "Root", 1);
        await assert.rejects(
          send("textDocument/prepareRename", {
            textDocument: { uri },
            position,
          }),
          /Rename requires complete WinUI SDK metadata.*restore.*Show Info/i);
        await assert.rejects(
          send("textDocument/rename", {
            textDocument: { uri },
            position,
            newName: "Panel",
          }),
          /Rename requires complete WinUI SDK metadata.*restore.*Show Info/i);
      }
      await assert.rejects(
        send("textDocument/rename", {
          textDocument: { uri },
          position: { line: 0, character: 16 },
          newName: "Panel",
        }),
        /Rename requires complete WinUI SDK metadata.*restore.*Show Info/i);
    } finally {
      try { await send("shutdown", null); } catch {}
      try { await send("exit", null, true); } catch {}
      child.kill();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
