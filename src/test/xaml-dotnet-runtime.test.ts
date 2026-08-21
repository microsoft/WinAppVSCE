import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  findCompatibleDotnet,
  getDotnetCandidates,
  hasRequiredDotnetRuntime,
  listDotnetRuntimes,
  RuntimeProbeProcess,
} from "../xaml/dotnetRuntime";

test("detects only the required Microsoft.NETCore.App major", () => {
  assert.equal(
    hasRequiredDotnetRuntime(
      "Microsoft.AspNetCore.App 10.0.1 [C:\\dotnet]\nMicrosoft.NETCore.App 9.0.8 [C:\\dotnet]"
    ),
    false
  );
  assert.equal(
    hasRequiredDotnetRuntime("Microsoft.NETCore.App 10.0.5 [C:\\dotnet]"),
    true
  );
});

test("checks explicit and installed dotnet locations without acquisition paths", () => {
  const candidates = getDotnetCandidates({
    DOTNET_HOST_PATH: "C:\\custom\\dotnet.exe",
    DOTNET_ROOT_ARM64: "C:\\arm64-runtime",
    DOTNET_ROOT: "C:\\runtime",
    ProgramFiles: "C:\\Program Files",
  }, "arm64");

  assert.deepEqual(candidates, [
    "C:\\custom\\dotnet.exe",
    "C:\\arm64-runtime\\dotnet.exe",
    "C:\\runtime\\dotnet.exe",
    "C:\\Program Files\\dotnet\\dotnet.exe",
    "dotnet",
  ]);
});

test("returns the first candidate with a compatible installed runtime", async () => {
  const checked: string[] = [];
  const result = await findCompatibleDotnet(
    ["old-dotnet", "current-dotnet"],
    async (command) => {
      checked.push(command);
      return command === "current-dotnet"
        ? "Microsoft.NETCore.App 10.0.5 [C:\\dotnet]"
        : "Microsoft.NETCore.App 9.0.8 [C:\\dotnet]";
    }
  );

  assert.equal(result, "current-dotnet");
  assert.deepEqual(checked, ["old-dotnet", "current-dotnet"]);
});

test("does not invent a runtime when no installed candidate is compatible", async () => {
  assert.equal(
    await findCompatibleDotnet(["dotnet"], async () => undefined),
    undefined
  );
});

function createProbe(): RuntimeProbeProcess & EventEmitter {
  const probe = new EventEmitter() as RuntimeProbeProcess & EventEmitter;
  Object.assign(probe, {
    stdout: new PassThrough(),
    kill: () => true,
  });
  return probe;
}

test("runtime probe returns stdout only for a successful process", async () => {
  const success = createProbe();
  const successfulResult = listDotnetRuntimes("dotnet", 1000, () => success);
  success.stdout.push("not a runtime listing");
  success.stdout.push(null);
  success.emit("close", 0);
  assert.equal(await successfulResult, "not a runtime listing");

  const failure = createProbe();
  const failedResult = listDotnetRuntimes("dotnet", 1000, () => failure);
  failure.emit("close", 1);
  assert.equal(await failedResult, undefined);

  const error = createProbe();
  const errorResult = listDotnetRuntimes("dotnet", 1000, () => error);
  error.emit("error");
  assert.equal(await errorResult, undefined);
});

test("runtime probe kills a process that exceeds the timeout", async () => {
  const probe = createProbe();
  let killed = false;
  probe.kill = () => {
    killed = true;
    return true;
  };

  assert.equal(await listDotnetRuntimes("dotnet", 1, () => probe), undefined);
  assert.equal(killed, true);
});
