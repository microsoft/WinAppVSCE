import * as fs from "fs";
import * as path from "path";

/** The `dotnet` for MSBuild/restore/build, as an absolute path so a child spawned in a project
 * directory cannot resolve a planted `dotnet.exe` there. Undefined means no SDK is installed, which
 * callers report rather than run. `WINUI_XAML_DOTNET_PATH` pins an install for dev/test. */
export function resolveDotnetCommand(
  env: NodeJS.ProcessEnv = process.env,
  log?: (message: string) => void
): string | undefined {
  const override = env.WINUI_XAML_DOTNET_PATH;
  if (override && override.length > 0) {
    if (path.isAbsolute(override)) {
      return override;
    }
    log?.(`Ignoring WINUI_XAML_DOTNET_PATH='${override}': it must be an absolute path.`);
    return undefined;
  }
  return findDotnetOnPath(env);
}

/** Empty and relative PATH entries resolve against the child's working directory, which is the
 * untrusted project folder, so only absolute entries are searched. */
export function findDotnetOnPath(env: NodeJS.ProcessEnv): string | undefined {
  const executable = process.platform === "win32" ? "dotnet.exe" : "dotnet";
  for (const entry of listSearchableDirectories(env)) {
    const candidate = path.join(entry, executable);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** The PATH entries that are safe to probe: absolute, non-empty, and in their original order. */
export function listSearchableDirectories(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? env.Path ?? "")
    .split(path.delimiter)
    .filter((entry) => entry.length > 0 && path.isAbsolute(entry));
}

/** Environment for a child that may run dotnet. A resolved host pins DOTNET_HOST_PATH and
 * DOTNET_ROOT, which MSBuild and Roslyn's build host exec directly. With no host, an inherited
 * DOTNET_HOST_PATH is cleared because it names a host this extension did not resolve. */
export function createDotnetChildEnvironment(
  dotnetPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  if (dotnetPath === undefined) {
    delete childEnv.DOTNET_HOST_PATH;
    return childEnv;
  }

  childEnv.DOTNET_HOST_PATH = dotnetPath;
  childEnv.DOTNET_ROOT = path.dirname(dotnetPath);
  return childEnv;
}
