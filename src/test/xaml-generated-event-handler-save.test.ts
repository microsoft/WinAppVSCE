import assert from "node:assert";
import { describe, it } from "node:test";
import {
  saveGeneratedEventHandlerDocument,
  targetsDirtyGeneratedHandlerDocument,
} from "../xaml/generatedEventHandlerSave";

describe("generated event handler save", () => {
  it("leaves a dirty document unsaved when the user declines", async () => {
    let saves = 0;
    await saveGeneratedEventHandlerDocument(
      { isDirty: true, save: async () => { saves++; return true; } },
      "Page.xaml.cs",
      async () => false,
    );

    assert.strictEqual(saves, 0);
  });

  it("saves a dirty document after explaining that all pending edits are included", async () => {
    let prompt = "";
    let saves = 0;
    await saveGeneratedEventHandlerDocument(
      { isDirty: true, save: async () => { saves++; return true; } },
      "Page.xaml.cs",
      async (message) => {
        prompt = message;
        return true;
      },
    );

    assert.match(prompt, /all pending edits/i);
    assert.strictEqual(saves, 1);
  });

  it("surfaces save failures", async () => {
    await assert.rejects(
      saveGeneratedEventHandlerDocument(
        { isDirty: true, save: async () => false },
        "Page.xaml.cs",
        async () => true,
      ),
      /Could not save generated event handler/,
    );
  });

  it("identifies generated-handler actions targeting dirty documents", () => {
    const target = "file:///C:/repo/Page.xaml.cs";
    assert.strictEqual(
      targetsDirtyGeneratedHandlerDocument(
        {
          command: "winui-xaml.saveGeneratedEventHandler",
          arguments: [target],
        },
        (uri) => uri === target,
      ),
      true,
    );
    assert.strictEqual(
      targetsDirtyGeneratedHandlerDocument(
        { command: "other.command", arguments: [target] },
        () => true,
      ),
      false,
    );
  });
});
