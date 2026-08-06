import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createSurroundSnippet,
  executeSurroundCommand,
  resolveSurroundElement,
  surroundElements,
} from "../xaml/xamlEditorFeatureModel";

test("XAML surround snippets preserve the selected text variable", () => {
  for (const element of surroundElements) {
    assert.equal(
      createSurroundSnippet(element),
      `<${element}>\n\t\${TM_SELECTED_TEXT}\n</${element}>`
    );
  }
});

test("XAML surround command resolves command arguments and Quick Pick choices", async () => {
  let pickCount = 0;
  assert.equal(
    await resolveSurroundElement(undefined, async () => {
      pickCount++;
      return "Grid";
    }),
    "Grid"
  );
  assert.equal(pickCount, 1);

  assert.equal(
    await resolveSurroundElement("Border", async () => {
      pickCount++;
      return "Grid";
    }),
    "Border"
  );
  assert.equal(pickCount, 1, "a valid command argument should bypass Quick Pick");
  assert.equal(await resolveSurroundElement(undefined, async () => undefined), undefined);
});

test("XAML surround command Quick Pick path inserts around every non-empty selection", async () => {
  const selections = [{ isEmpty: false, id: 1 }, { isEmpty: true, id: 2 }];
  let inserted:
    | { snippet: string; selections: readonly (typeof selections)[number][] }
    | undefined;

  assert.equal(
    await executeSurroundCommand(
      undefined,
      "xaml",
      selections,
      async () => "StackPanel",
      async (snippet, selected) => {
        inserted = { snippet, selections: selected };
      }
    ),
    true
  );
  assert.equal(inserted?.snippet, createSurroundSnippet("StackPanel"));
  assert.deepEqual(inserted?.selections, [selections[0]]);

  assert.equal(
    await executeSurroundCommand(
      undefined,
      "plaintext",
      selections,
      async () => "Border",
      async () => assert.fail("non-XAML documents must not insert")
    ),
    false
  );
});

test("package contributes the XAML snippets and surround command", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
  assert.deepEqual(packageJson.contributes.snippets, [
    { language: "xaml", path: "./snippets/xaml.json" },
  ]);
  assert.ok(
    packageJson.contributes.commands.some(
      (command: { command: string; enablement?: string }) =>
        command.command === "winui-xaml.surroundWith" &&
        command.enablement === "editorLangId == xaml && editorHasSelection"
    )
  );
  assert.match(
    fs.readFileSync(path.resolve("src", "xaml", "xamlEditorFeatures.ts"), "utf8"),
    /language: "xaml", scheme: "untitled"/
  );

  const snippets = JSON.parse(
    fs.readFileSync(path.resolve("snippets", "xaml.json"), "utf8")
  );
  assert.deepEqual(
    Object.values(snippets).map((snippet) => (snippet as { prefix: string }).prefix),
    ["xgrid", "xbind", "xresource", "xstyle", "xdatatemplate"]
  );
});
