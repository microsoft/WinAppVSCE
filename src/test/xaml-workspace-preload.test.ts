import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  XAML_WORKSPACE_EXCLUDE_GLOB,
  XAML_WORKSPACE_INCLUDE_GLOB,
  XAML_WORKSPACE_MAX_RESULTS,
  findFirstWorkspaceXaml,
} from "../xaml/workspacePreload";

test("finds at most one non-generated workspace XAML file", async () => {
  const calls: unknown[][] = [];
  const result = await findFirstWorkspaceXaml(async (...args) => {
    calls.push(args);
    return ["file:///workspace/App.xaml"];
  });

  assert.equal(result, "file:///workspace/App.xaml");
  assert.deepEqual(calls, [
    [
      XAML_WORKSPACE_INCLUDE_GLOB,
      XAML_WORKSPACE_EXCLUDE_GLOB,
      XAML_WORKSPACE_MAX_RESULTS,
    ],
  ]);
  assert.equal(XAML_WORKSPACE_MAX_RESULTS, 1);
  assert.match(XAML_WORKSPACE_EXCLUDE_GLOB, /bin/);
  assert.match(XAML_WORKSPACE_EXCLUDE_GLOB, /obj/);
  assert.match(XAML_WORKSPACE_EXCLUDE_GLOB, /node_modules/);
  assert.match(XAML_WORKSPACE_EXCLUDE_GLOB, /packages/);
});

test("returns undefined when the workspace has no eligible XAML", async () => {
  assert.equal(
    await findFirstWorkspaceXaml(async () => []),
    undefined
  );
});

test("activates the extension when a workspace contains XAML", async () => {
  const packageJson = JSON.parse(
    await readFile("package.json", "utf8")
  ) as { activationEvents?: string[] };

  assert.ok(packageJson.activationEvents?.includes("workspaceContains:**/*.xaml"));
});
