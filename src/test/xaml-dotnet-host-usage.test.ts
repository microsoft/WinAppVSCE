import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

// The extension never launches a .NET tool by name; VS Code's PATH often lacks a newly installed or shell-only SDK.
// Bare `dotnet` would fail without naming the extension or SDK, so every launch site must use the resolver.
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
      `a process is launched as the bare name "dotnet"; resolve the host first, ` +
        `as restoreProject does, so the failure can name the missing SDK`
    );
  }
});

test("every .NET launch site resolves the host and passes a child environment", () => {
  const body = code();

  // Both launch sites pass a resolved variable, and both build the environment the resolved
  // host needs. A launch that resolved the host but dropped the environment would still break
  // on a private install, so the two are asserted together.
  const launchSites = [
    ...body.matchAll(
      /(?:new vscode\.ProcessExecution|spawn)\(\s*([A-Za-z_$][\w$]*)\s*,[\s\S]{0,400}?createDotnetChildEnvironment\(\s*([A-Za-z_$][\w$]*)/g
    ),
  ];

  // Self-calibrating rather than a hardcoded count: every launch the first test discovered must
  // also appear here with a resolved host and its environment. A new launch site therefore has to
  // be correct to pass, instead of merely changing an expected number.
  const launches = [
    ...body.matchAll(/(?:new vscode\.ProcessExecution|spawn|execFile|spawnSync)\(\s*([^,]+),/g),
  ];

  assert.equal(
    launchSites.length,
    launches.length,
    `every .NET launch site must resolve the host and pass its environment; found ` +
      `${launches.length} launch(es) but only ${launchSites.length} are host-resolved`
  );

  for (const site of launchSites) {
    assert.equal(
      site[1],
      site[2],
      "the environment must be built for the same host the process is launched with"
    );
  }

  // Server startup resolves the host too, so resolutions outnumber the launch sites checked
  // here. What matters is that none of them is missing.
  assert.ok(
    (body.match(/requireDotnetHostResolver\(\)\.resolve\(\)/g) ?? []).length >= launchSites.length,
    "every launch site must be backed by a host resolution"
  );
});
