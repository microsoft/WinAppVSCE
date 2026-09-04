import assert from "node:assert/strict";
import test from "node:test";
import { createDotnetChildEnvironment } from "../xaml/dotnetRuntime";

test("points DOTNET_ROOT and DOTNET_HOST_PATH at the resolved host", () => {
  const env = createDotnetChildEnvironment("C:\\dotnet10\\dotnet.exe", {
    PATH: "C:\\dotnet10",
    DOTNET_HOST_PATH: "C:\\dotnet8\\dotnet.exe",
  });

  assert.equal(env.DOTNET_HOST_PATH, "C:\\dotnet10\\dotnet.exe");
  assert.equal(env.DOTNET_ROOT, "C:\\dotnet10");
  assert.equal(env.PATH, "C:\\dotnet10");
});

test("drops an inherited DOTNET_HOST_PATH when the host is not an absolute path", () => {
  // Defensive only: dotnet.findPath always returns an absolute path. Forwarding
  // a host we did not choose would let MSBuild and Roslyn use it.
  const logged: string[] = [];
  const env = createDotnetChildEnvironment(
    "dotnet",
    { PATH: "C:\\dotnet10", DOTNET_HOST_PATH: "C:\\dotnet8\\dotnet.exe" },
    (message) => logged.push(message)
  );

  assert.ok(!("DOTNET_HOST_PATH" in env));
  assert.ok(!("DOTNET_ROOT" in env));
  assert.equal(env.PATH, "C:\\dotnet10");
  assert.equal(logged.length, 1);
});

test("does not mutate the source environment", () => {
  const source = { DOTNET_HOST_PATH: "C:\\dotnet8\\dotnet.exe" };
  createDotnetChildEnvironment("C:\\dotnet10\\dotnet.exe", source);

  assert.equal(source.DOTNET_HOST_PATH, "C:\\dotnet8\\dotnet.exe");
  assert.ok(!("DOTNET_ROOT" in source));
});
