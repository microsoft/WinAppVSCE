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

  // Each launch passes a variable, and each variable is assigned from resolveDotnetCommand.
  const launches = [
    ...body.matchAll(
      /(?:new vscode\.ProcessExecution|spawn|execFile|spawnSync)\(\s*([A-Za-z_$][\w$]*)\s*,/g
    ),
  ];

  assert.ok(launches.length > 0, "expected to find at least one process launch to check");

  const resolved = new Set(
    [...body.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*resolveDotnetCommand\(/g)].map(
      (match) => match[1]
    )
  );

  // Parameters carry an already-resolved command in from a caller, so accept them too: the
  // caller's assignment is what this test pins, and it is checked above.
  const parameters = new Set(
    [...body.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*string/g)].map((match) => match[1])
  );

  for (const launch of launches) {
    const executable = launch[1];
    assert.ok(
      resolved.has(executable) || parameters.has(executable),
      `'${executable}' is launched without coming from resolveDotnetCommand()`
    );
  }

  // The helper must still exist and be the only decision point, or the assertions above pass
  // vacuously against a renamed function.
  assert.ok(
    body.includes("resolveDotnetCommand"),
    "resolveDotnetCommand must remain the single place that names the dotnet command"
  );
});
