import * as vscode from "vscode";
import {
  executeSurroundCommand,
  SurroundElement,
  surroundElements,
} from "./xamlEditorFeatureModel";

export function registerXamlEditorFeatures(context: vscode.ExtensionContext): void {
  const selector: vscode.DocumentSelector = [
    { language: "xaml", scheme: "file" },
    { language: "xaml", scheme: "untitled" },
  ];

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "winui-xaml.surroundWith",
      async (requestedElement?: SurroundElement) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          return;
        }

        await executeSurroundCommand(
          requestedElement,
          editor.document.languageId,
          editor.selections,
          () => vscode.window.showQuickPick([...surroundElements], {
              placeHolder: "Select a WinUI element to surround the selection",
            }),
          (snippet, selections) => editor.insertSnippet(
            new vscode.SnippetString(snippet),
            selections
          )
        );
      }
    ),
    vscode.languages.registerCodeActionsProvider(
      selector,
      {
        provideCodeActions(_document, range) {
          if (range.isEmpty) {
            return [];
          }

          return surroundElements.map((element) => {
            const action = new vscode.CodeAction(
              `Surround with ${element}`,
              vscode.CodeActionKind.Refactor.append("surround")
            );
            action.command = {
              command: "winui-xaml.surroundWith",
              title: action.title,
              arguments: [element],
            };
            return action;
          });
        },
      },
      {
        providedCodeActionKinds: [vscode.CodeActionKind.Refactor.append("surround")],
      }
    )
  );
}
