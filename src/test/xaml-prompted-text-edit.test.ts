import assert from "node:assert";
import { describe, it } from "node:test";
import {
  PromptedTextEditDependencies,
  PromptedTextEditDocument,
  PromptedTextEditRequest,
  runGuardedTextEditCommand,
  runPromptedTextEdit,
  validatePromptedXamlValue,
} from "../xaml/promptedTextEdit";

const identifierPattern = String.raw`[\p{L}_][\p{L}\p{N}_]*`;
const prefixPattern = String.raw`[\p{L}_][\p{L}\p{N}_.-]*`;
const patterns = {
  namespaceUri:
    String.raw`(?:using:${identifierPattern}(?:\.${identifierPattern})*|https?://[^\s"'&<>]+)`,
  xamlType: `(?:${prefixPattern}:)?${identifierPattern}`,
  xamlName: identifierPattern,
  xamlMember: `(?:(?:${prefixPattern}:)?${identifierPattern}\\.)?${identifierPattern}`,
};

const request: PromptedTextEditRequest = {
  documentUri: "file:///C:/repo/Page.xaml",
  range: {
    start: { line: 0, character: 6 },
    end: { line: 0, character: 10 },
  },
  prompt: "Enter a member",
  placeHolder: "Name",
  initialValue: "Old",
  prefix: "",
  suffix: "",
  expectedVersion: 7,
  expectedText: "Old1",
  choices: [],
  customChoiceLabel: "Enter another value...",
  validationPattern: patterns.xamlName,
  validationMessage: "Invalid value.",
};

function createDependencies(overrides: Partial<PromptedTextEditDependencies> = {}) {
  const document: PromptedTextEditDocument = {
    version: 7,
    getText: () => "Old1",
  };
  const applied: Array<{ range: PromptedTextEditRequest["range"]; text: string }> = [];
  const dependencies: PromptedTextEditDependencies = {
    showInput: async options => {
      assert.strictEqual(options.value, "Old");
      assert.strictEqual(options.validateInput(" NewName "), undefined);
      return " NewName ";
    },
    showChoice: async () => undefined,
    openDocument: async () => document,
    applyEdit: async (_document, range, text) => {
      applied.push({ range, text });
      return true;
    },
    ...overrides,
  };
  return { dependencies, document, applied };
}

describe("prompted XAML text edits", () => {
  it("validates namespace, type, name, and attached-property inputs", () => {
    const valid = (value: string, pattern: string) =>
      validatePromptedXamlValue(value, pattern, "Invalid value.");
    assert.strictEqual(valid("using:Sample.Controls", patterns.namespaceUri), undefined);
    assert.strictEqual(valid("using:Sámple.Controls", patterns.namespaceUri), undefined);
    assert.strictEqual(valid("https://example.com/xaml", patterns.namespaceUri), undefined);
    assert.strictEqual(valid("using:Bad Namespace", patterns.namespaceUri), "Invalid value.");
    assert.strictEqual(valid("using:123", patterns.namespaceUri), "Invalid value.");
    assert.strictEqual(valid("using:Foo..Bar", patterns.namespaceUri), "Invalid value.");
    assert.strictEqual(valid("using:.", patterns.namespaceUri), "Invalid value.");
    assert.strictEqual(valid("using:Bad&Namespace", patterns.namespaceUri), "Invalid value.");
    assert.strictEqual(valid("file:///tmp/types", patterns.namespaceUri), "Invalid value.");
    assert.strictEqual(valid("models:Item", patterns.xamlType), undefined);
    assert.strictEqual(valid("my-controls:Ítem", patterns.xamlType), undefined);
    assert.strictEqual(valid("models:", patterns.xamlType), "Invalid value.");
    assert.strictEqual(valid("Member_1", patterns.xamlName), undefined);
    assert.strictEqual(valid("Náme", patterns.xamlName), undefined);
    assert.strictEqual(valid("1Member", patterns.xamlName), "Invalid value.");
    assert.strictEqual(valid("Grid.Row", patterns.xamlMember), undefined);
    assert.strictEqual(valid("layout:Grid.Row", patterns.xamlMember), undefined);
    assert.strictEqual(valid("Grid.", patterns.xamlMember), "Invalid value.");
    assert.match(validatePromptedXamlValue("Name", "[", "Invalid")!, /invalid validation rule/);
  });

  describe("guarded XAML text edits", () => {
    const guardedRequest = {
      documentUri: "file:///C:/repo/Page.xaml",
      expectedVersion: 7,
      edits: [
        {
          range: {
            start: { line: 0, character: 1 },
            end: { line: 0, character: 4 },
          },
          expectedText: "old",
          newText: "new",
        },
        {
          range: {
            start: { line: 1, character: 2 },
            end: { line: 1, character: 5 },
          },
          expectedText: "bad",
          newText: "good",
        },
      ],
    };

    it("validates and applies all planned edits atomically", async () => {
      const document: PromptedTextEditDocument = {
        version: 7,
        getText: range => range.start.line === 0 ? "old" : "bad",
      };
      type ConvertedRange = {
        source: PromptedTextEditRequest["range"];
        key: string;
      };
      type TestWorkspaceEdit = Array<{ range: ConvertedRange; newText: string }>;
      const applied: TestWorkspaceEdit[] = [];
      let workspaceEditsCreated = 0;

      await runGuardedTextEditCommand(guardedRequest, {
        openDocument: async () => document,
        getDocumentVersion: target => target.version,
        createRange: range => ({
          source: range,
          key: `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`,
        }),
        isValidRange: (_target, range) => range.key.length > 0,
        getText: (target, range) => target.getText(range.source),
        createWorkspaceEdit: () => {
          workspaceEditsCreated++;
          return [] as TestWorkspaceEdit;
        },
        replace: (edit, target, range, newText) => {
          assert.strictEqual(target, document);
          edit.push({ range, newText });
        },
        applyEdit: async edits => {
          applied.push(edits);
          return true;
        },
      });

      assert.strictEqual(workspaceEditsCreated, 1);
      assert.deepStrictEqual(
        applied[0].map(edit => [edit.range.key, edit.newText]),
        [["0:1-0:4", "new"], ["1:2-1:5", "good"]],
      );
    });

    it("rejects malformed ranges before opening the document", async () => {
      let opened = false;
      await assert.rejects(
        runGuardedTextEditCommand(
          {
            ...guardedRequest,
            edits: [{
              ...guardedRequest.edits[0],
              range: {
                start: { line: 1, character: 0 },
                end: { line: 0, character: 0 },
              },
            }],
          },
          {
            openDocument: async () => {
              opened = true;
              throw new Error("should not open");
            },
            getDocumentVersion: () => 7,
            createRange: range => range,
            isValidRange: () => true,
            getText: () => "",
            createWorkspaceEdit: () => [],
            replace: () => {},
            applyEdit: async () => true,
          },
        ),
        /invalid edit range/,
      );
      assert.strictEqual(opened, false);
    });

    it("rejects stale versions and stale range text without applying", async () => {
      let applied = false;
      const dependencies = {
        openDocument: async (): Promise<PromptedTextEditDocument> => ({
          version: 8,
          getText: () => "old",
        }),
        getDocumentVersion: (document: PromptedTextEditDocument) => document.version,
        createRange: (range: PromptedTextEditRequest["range"]) => range,
        isValidRange: () => true,
        getText: (
          document: PromptedTextEditDocument,
          range: PromptedTextEditRequest["range"],
        ) => document.getText(range),
        createWorkspaceEdit: () => [],
        replace: () => {},
        applyEdit: async () => {
          applied = true;
          return true;
        },
      };
      await assert.rejects(
        runGuardedTextEditCommand(guardedRequest, dependencies),
        /document.*changed/i,
      );

      dependencies.openDocument = async () => ({
        version: 7,
        getText: range => range.start.line === 0 ? "old" : "changed",
      });
      await assert.rejects(
        runGuardedTextEditCommand(guardedRequest, dependencies),
        /document.*changed/i,
      );
      assert.strictEqual(applied, false);
    });

    it("propagates document-specific out-of-bounds range validation", async () => {
      let applied = false;
      await assert.rejects(
        runGuardedTextEditCommand(guardedRequest, {
          openDocument: async (): Promise<PromptedTextEditDocument> => ({
            version: 7,
            getText: () => "old",
          }),
          getDocumentVersion: document => document.version,
          createRange: range => range,
          isValidRange: () => false,
          getText: (document, range) => document.getText(range),
          createWorkspaceEdit: () => [],
          replace: () => {},
          applyEdit: async () => {
            applied = true;
            return true;
          },
        }),
        /invalid edit range/,
      );
      assert.strictEqual(applied, false);
    });

    it("surfaces atomic workspace edit failures", async () => {
      await assert.rejects(
        runGuardedTextEditCommand(guardedRequest, {
          openDocument: async (): Promise<PromptedTextEditDocument> => ({
            version: 7,
            getText: range => range.start.line === 0 ? "old" : "bad",
          }),
          getDocumentVersion: document => document.version,
          createRange: range => range,
          isValidRange: () => true,
          getText: (document, range) => document.getText(range),
          createWorkspaceEdit: () => [],
          replace: () => {},
          applyEdit: async () => false,
        }),
        /Could not edit/,
      );
    });
  });

  it("applies the exact planned range and trimmed replacement", async () => {
    const { dependencies, applied } = createDependencies();

    await runPromptedTextEdit(request, dependencies);

    assert.deepStrictEqual(applied, [{ range: request.range, text: "NewName" }]);
  });

  it("applies namespace and data-type affixes exactly", async () => {
    for (const scenario of [
      {
        prefix: " xmlns:local=\"",
        suffix: "\"",
        value: "using:Sample.Controls",
        expected: " xmlns:local=\"using:Sample.Controls\"",
      },
      {
        prefix: " x:DataType=\"",
        suffix: "\"",
        value: "models:Item",
        expected: " x:DataType=\"models:Item\"",
      },
    ]) {
      const applied: string[] = [];
      const { dependencies } = createDependencies({
        showInput: async () => scenario.value,
        applyEdit: async (_document, _range, text) => {
          applied.push(text);
          return true;
        },
      });

      await runPromptedTextEdit(
        { ...request, initialValue: "", prefix: scenario.prefix, suffix: scenario.suffix },
        dependencies,
      );

      assert.deepStrictEqual(applied, [scenario.expected]);
    }
  });

  it("applies an authoritative quick-pick choice without opening text input", async () => {
    const applied: string[] = [];
    const { dependencies } = createDependencies({
      showChoice: async options => {
        assert.deepStrictEqual(options.choices, ["models:Person", "models:Account"]);
        return "models:Account";
      },
      showInput: async () => { throw new Error("should not prompt"); },
      applyEdit: async (_document, _range, text) => {
        applied.push(text);
        return true;
      },
    });

    await runPromptedTextEdit(
      {
        ...request,
        initialValue: "",
        prefix: " x:DataType=\"",
        suffix: "\"",
        choices: ["models:Person", "models:Account"],
        validationPattern: patterns.xamlType,
      },
      dependencies,
    );

    assert.deepStrictEqual(applied, [" x:DataType=\"models:Account\""]);
  });

  it("rejects an authoritative choice that violates the server validation rule", async () => {
    const { dependencies } = createDependencies({
      showChoice: async () => "models:Bad\" Value=\"Injected",
      showInput: async () => { throw new Error("should not prompt"); },
    });

    await assert.rejects(
      runPromptedTextEdit(
        { ...request, choices: ["models:Bad\" Value=\"Injected"] },
        dependencies,
      ),
      /Invalid value/,
    );
  });

  it("opens text input after choosing the custom-value option", async () => {
    const applied: string[] = [];
    const { dependencies } = createDependencies({
      showChoice: async () => null,
      showInput: async () => "models:Custom",
      applyEdit: async (_document, _range, text) => {
        applied.push(text);
        return true;
      },
    });

    await runPromptedTextEdit(
      {
        ...request,
        initialValue: "",
        prefix: " x:DataType=\"",
        suffix: "\"",
        choices: ["models:Person", "models:Account"],
        validationPattern: patterns.xamlType,
      },
      dependencies,
    );

    assert.deepStrictEqual(applied, [" x:DataType=\"models:Custom\""]);
  });

  it("does nothing when an authoritative choice is cancelled", async () => {
    const { dependencies, applied } = createDependencies({
      showChoice: async () => undefined,
      showInput: async () => { throw new Error("should not prompt"); },
    });

    await runPromptedTextEdit(
      { ...request, choices: ["models:Person", "models:Account"] },
      dependencies,
    );

    assert.deepStrictEqual(applied, []);
  });

  it("rejects the unchanged invalid initial value", async () => {
    const { dependencies } = createDependencies({
      showInput: async options => {
        assert.match(options.validateInput("Old")!, /different value/);
        return undefined;
      },
    });

    await runPromptedTextEdit(request, dependencies);
  });

  it("does nothing when the prompt is cancelled", async () => {
    const { dependencies, applied } = createDependencies({
      showInput: async () => undefined,
      openDocument: async () => { throw new Error("should not open"); },
    });

    await runPromptedTextEdit(request, dependencies);

    assert.deepStrictEqual(applied, []);
  });

  it("rejects changed document versions and changed range text", async () => {
    const versionChanged = createDependencies({
      openDocument: async () => ({ version: 8, getText: () => "Old1" }),
    });
    await assert.rejects(
      runPromptedTextEdit(request, versionChanged.dependencies),
      /document changed/,
    );

    const textChanged = createDependencies({
      openDocument: async () => ({ version: 7, getText: () => "Else" }),
    });
    await assert.rejects(
      runPromptedTextEdit(request, textChanged.dependencies),
      /document changed/,
    );
  });

  it("rechecks the document immediately before applying the edit", async () => {
    let reads = 0;
    const changedBeforeApply = createDependencies({
      openDocument: async () => ({
        version: 7,
        getText: () => ++reads === 1 ? "Old1" : "Changed",
      }),
      applyEdit: async () => {
        throw new Error("should not apply");
      },
    });

    await assert.rejects(
      runPromptedTextEdit(request, changedBeforeApply.dependencies),
      /document changed/,
    );
  });

  it("checks expected text when no server document version is available", async () => {
    const { dependencies } = createDependencies({
      openDocument: async () => ({ version: 12, getText: () => "Else" }),
    });

    await assert.rejects(
      runPromptedTextEdit({ ...request, expectedVersion: null }, dependencies),
      /document changed/,
    );
  });

  it("rejects malformed ranges and failed workspace edits", async () => {
    const malformed = {
      ...request,
      range: {
        start: { line: 1, character: 0 },
        end: { line: 0, character: 0 },
      },
    };
    const normal = createDependencies();
    await assert.rejects(
      runPromptedTextEdit(malformed, normal.dependencies),
      /invalid edit range/,
    );

    const failed = createDependencies({ applyEdit: async () => false });
    await assert.rejects(
      runPromptedTextEdit(request, failed.dependencies),
      /file is writable.*run the quick fix again/,
    );
  });
});
