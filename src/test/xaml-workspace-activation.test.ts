import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { hasOpenXamlDocument } from "../xaml/xamlDemand";

async function readActivationEvents(): Promise<string[]> {
  const packageJson = JSON.parse(
    await readFile("package.json", "utf8")
  ) as { activationEvents?: string[] };
  return packageJson.activationEvents ?? [];
}

test("activates without preloading when a workspace contains XAML", async () => {
  // The extension must activate for workspaces that contain XAML so that the
  // C# Dev Kit recommendation can fire on a .xaml.cs opened without its .xaml.
  // Activation registers providers only; the server still waits for demand.
  assert.ok((await readActivationEvents()).includes("workspaceContains:**/*.xaml"));
});

test("does not activate on plain C# documents", async () => {
  // Any workspace holding a .xaml.cs also holds the .xaml it is code-behind
  // for, so the workspaceContains glob above already covers every workspace
  // where the Dev Kit recommendation can pass its .xaml.cs gate.
  // onLanguage:csharp would only add activation where the gate always fails.
  assert.ok(!(await readActivationEvents()).includes("onLanguage:csharp"));
});

test("does not demand the language server until a XAML document is open", () => {
  assert.equal(hasOpenXamlDocument([]), false);
  assert.equal(hasOpenXamlDocument([{ languageId: "typescript" }]), false);
  assert.equal(
    hasOpenXamlDocument([
      { languageId: "typescript" },
      { languageId: "xaml" },
    ]),
    true
  );
});
