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

test("activates for XAML code-behind so the Dev Kit recommendation can fire", async () => {
  // VS Code cannot activate on an individual file open, only onLanguage or
  // workspaceContains. This glob is the narrowest event that still registers
  // recommendCsharpDevKit before the user opens a .xaml.cs.
  assert.ok((await readActivationEvents()).includes("workspaceContains:**/*.xaml.cs"));
});

test("does not activate on plain C# or on XAML that has no code-behind", async () => {
  const events = await readActivationEvents();
  // onLanguage:csharp activated in every C# workspace to serve a recommendation
  // gated to .xaml.cs. The broader **/*.xaml glob additionally caught C++/WinRT
  // and XAML-only workspaces; onLanguage:xaml already covers opening XAML there.
  assert.ok(!events.includes("onLanguage:csharp"));
  assert.ok(!events.includes("workspaceContains:**/*.xaml"));
});

test("still activates when a XAML document is opened", async () => {
  assert.ok((await readActivationEvents()).includes("onLanguage:xaml"));
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
