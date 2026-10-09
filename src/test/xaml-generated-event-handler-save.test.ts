import assert from "node:assert";
import { describe, it } from "node:test";
import {
  ApplyGeneratedHandlerHost,
  GENERATED_HANDLER_CHANGED_MESSAGE,
  GENERATED_HANDLER_SAVED_MESSAGE,
  applyGeneratedEventHandlerEdit,
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

describe("applying a generated event handler", () => {
  const uri = "file:///c:/app/Page.xaml.cs";
  const command = { command: "winui-xaml.saveGeneratedEventHandler", arguments: [uri] };
  type Target = { isDirty: boolean; version: number | undefined } | undefined;
  type Edit = { edit: boolean };

  function createHost(target: Target) {
    const calls = {
      applied: 0,
      commands: [] as string[],
      messages: [] as string[],
    };
    let current = target;
    const host: ApplyGeneratedHandlerHost<Edit> = {
      getTarget: () => current,
      applyEdit: async () => { calls.applied++; return true; },
      runCommand: async (name: string) => { calls.commands.push(name); },
      showInformationMessage: (message: string) => { calls.messages.push(message); },
    };
    return {
      calls,
      setTarget: (next: Target) => { current = next; },
      host,
    };
  }

  it("applies the edit and saves when the code-behind is clean and unchanged", async () => {
    const { calls, host } = createHost({ isDirty: false, version: 7 });

    await applyGeneratedEventHandlerEdit(uri, { edit: true }, command, false, 7, host);

    assert.strictEqual(calls.applied, 1);
    assert.deepStrictEqual(calls.commands, [command.command]);
    assert.deepStrictEqual(calls.messages, []);
  });

  it("applies the edit when the code-behind is not open in an editor", async () => {
    const { calls, host } = createHost(undefined);

    await applyGeneratedEventHandlerEdit(uri, { edit: true }, command, false, undefined, host);

    assert.strictEqual(calls.applied, 1);
    assert.deepStrictEqual(calls.commands, [command.command]);
  });

  it("saves a dirty code-behind and asks the user to retry instead of applying a stale edit", async () => {
    const state = createHost({ isDirty: true, version: 3 });
    // The save command clears the dirty flag, which is what makes a retry worthwhile.
    state.host.runCommand = async (name) => {
      state.calls.commands.push(name);
      state.setTarget({ isDirty: false, version: 4 });
    };

    await applyGeneratedEventHandlerEdit(uri, { edit: true }, command, false, 3, state.host);

    assert.strictEqual(state.calls.applied, 0);
    assert.deepStrictEqual(state.calls.commands, [command.command]);
    assert.deepStrictEqual(state.calls.messages, [GENERATED_HANDLER_SAVED_MESSAGE]);
  });

  it("does not apply when the code-behind stayed dirty through the save", async () => {
    const { calls, host } = createHost({ isDirty: true, version: 3 });

    await applyGeneratedEventHandlerEdit(uri, { edit: true }, command, true, 3, host);

    assert.strictEqual(calls.applied, 0);
    assert.deepStrictEqual(calls.messages, []);
  });

  it("does not apply when the code-behind changed after the edit was computed", async () => {
    const { calls, host } = createHost({ isDirty: false, version: 9 });

    await applyGeneratedEventHandlerEdit(uri, { edit: true }, command, false, 7, host);

    assert.strictEqual(calls.applied, 0);
    assert.deepStrictEqual(calls.commands, []);
    assert.deepStrictEqual(calls.messages, [GENERATED_HANDLER_CHANGED_MESSAGE]);
  });

  it("throws when VS Code refuses the edit", async () => {
    const { calls, host } = createHost({ isDirty: false, version: 7 });
    host.applyEdit = async () => false;

    await assert.rejects(
      () => applyGeneratedEventHandlerEdit(uri, { edit: true }, command, false, 7, host),
      /Could not apply the generated event handler edit/,
    );
    assert.deepStrictEqual(calls.commands, []);
  });
});