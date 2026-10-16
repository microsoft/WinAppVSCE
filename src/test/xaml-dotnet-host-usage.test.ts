import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

// The extension never launches a .NET tool by a hardcoded name: `resolveDotnetCommand` is the one
// place that decides which `dotnet` runs, so a dev/test override applies everywhere at once.
// Source-level assertions fit because private launch sites build vscode.Task/child processes and the defect is a missing call.
const source = readFileSync(
  path.join(__dirname, "..", "..", "src", "xaml", "xamlLanguageService.ts"),
  "utf8"
);

/** Strips comments so prose about `"dotnet"` cannot satisfy or trip these assertions. */
function code(): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("no process is launched by the bare name 'dotnet'", () => {
  const launches = [
    ...code().matchAll(/(?:new vscode\.ProcessExecution|spawn|execFile|spawnSync)\(\s*([^,]+),/g),
  ];

  assert.ok(launches.length > 0, "expected to find at least one process launch to check");

  for (const launch of launches) {
    const executable = launch[1].trim();
    assert.notEqual(
      executable,
      '"dotnet"',
      `a process is launched as the bare name "dotnet"; call resolveDotnetCommand() instead ` +
        `so WINUI_XAML_DOTNET_PATH applies to every launch site`
    );
  }
});

test("every .NET launch site names its command through resolveDotnetCommand", () => {
  const body = code();

  const resolved = new Set(
    [...body.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*resolveDotnetCommand\(/g)].map(
      (match) => match[1]
    )
  );

  const launchPattern =
    /(?:new vscode\.ProcessExecution|spawn|execFile|spawnSync)\(\s*([A-Za-z_$][\w$]*)\s*,/g;
  const launches = [...body.matchAll(launchPattern)];
  assert.ok(launches.length > 0, "expected to find at least one process launch to check");

  for (const launch of launches) {
    const executable = launch[1];
    if (resolved.has(executable)) {
      continue;
    }

    // Otherwise the command arrives as a parameter, so the obligation moves to the callers:
    // find the enclosing function and require each call to pass a resolved command.
    const enclosing = [
      ...body.slice(0, launch.index).matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g),
    ].pop();
    assert.ok(
      enclosing && new RegExp(`\\b${executable}\\s*:\\s*string`).test(enclosing[2]),
      `'${executable}' is launched without coming from resolveDotnetCommand()`
    );

    const parameterIndex = enclosing[2].split(",").findIndex((p) => p.trim().startsWith(executable));
    const calls = [
      ...body.matchAll(new RegExp(`\\b${enclosing[1]}\\(([^;\\n]*)\\)`, "g")),
    ].filter((call) => !body.slice(0, call.index).endsWith("function "));
    assert.ok(calls.length > 0, `expected a call to ${enclosing[1]} to check`);

    for (const call of calls) {
      const argument = (call[1].split(",")[parameterIndex] ?? "").trim();
      assert.ok(
        argument.startsWith("resolveDotnetCommand(") || resolved.has(argument),
        `${enclosing[1]} is called with '${argument}', which does not come from resolveDotnetCommand()`
      );
    }
  }

  // The helper must still exist, or every assertion above passes vacuously after a rename.
  assert.ok(
    body.includes("resolveDotnetCommand"),
    "resolveDotnetCommand must remain the single place that names the dotnet command"
  );
});
