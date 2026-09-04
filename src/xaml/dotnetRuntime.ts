import * as path from "path";

/**
 * Builds the environment for a spawned dotnet child process.
 *
 * DOTNET_ROOT points the host at the .NET installation we resolved, matching
 * what the C# extension sets for its language server. DOTNET_HOST_PATH is set
 * alongside it because MSBuild targets and Roslyn's build host resolve and exec
 * it directly; it is contractually an absolute path to the host executable.
 *
 * Paths come from the Install Tool's `dotnet.findPath`, which always returns an
 * absolute path, so the non-absolute branch is defensive only. It logs rather
 * than writing a value that would send MSBuild somewhere unintended, and drops
 * any inherited DOTNET_HOST_PATH rather than forwarding a host we did not
 * choose.
 */
export function createDotnetChildEnvironment(
  dotnetPath: string,
  env: NodeJS.ProcessEnv = process.env,
  log?: (message: string) => void
): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  if (path.isAbsolute(dotnetPath)) {
    childEnv.DOTNET_HOST_PATH = dotnetPath;
    childEnv.DOTNET_ROOT = path.dirname(dotnetPath);
  } else {
    log?.(`Resolved .NET host '${dotnetPath}' is not an absolute path; leaving DOTNET_ROOT unset.`);
    delete childEnv.DOTNET_HOST_PATH;
    delete childEnv.DOTNET_ROOT;
  }
  return childEnv;
}
