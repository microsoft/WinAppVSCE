import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * The extension never launches a .NET tool by name. `dotnet` is frequently absent from the PATH
 * a VS Code window inherits -- notably when the SDK was installed after the session started, or
 * when it lives somewhere only a login shell knows about -- so a bare `"dotnet"` argv[0] fails
 * with a message that names neither the extension nor the missing SDK.
 *
 * These are source-level assertions rather than behavioural ones because the launch sites are
 * module-private and each one builds a `vscode.Task` or a child process that a unit test cannot
 * observe without standing up the whole activation path. The defect being pinned is a missing
 * call, and a missing call is visible in the source. This is the same shape as the
 * `EveryInvocationGoesThroughTheGate` harvest on the server side.
 */
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
