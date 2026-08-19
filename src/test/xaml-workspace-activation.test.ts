import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { hasOpenXamlDocument } from "../xaml/xamlDemand";

test("activates without preloading when a workspace contains XAML", async () => {
  const packageJson = JSON.parse(
    await readFile("package.json", "utf8")
  ) as { activationEvents?: string[] };

  assert.ok(packageJson.activationEvents?.includes("workspaceContains:**/*.xaml"));
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
