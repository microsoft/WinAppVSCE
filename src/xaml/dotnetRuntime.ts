import * as fs from "fs";
import * as path from "path";

/** The `dotnet` for MSBuild/restore/build, as an absolute path so a child spawned in a project
 * directory cannot resolve a planted `dotnet.exe` there. PATH is the discovery mechanism the SDK
 * installer sets up; `WINUI_XAML_DOTNET_PATH` pins a specific install for dev/test. */
export function resolveDotnetCommand(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.WINUI_XAML_DOTNET_PATH;
  if (override && override.length > 0) {
    return override;
  }
  return findDotnetOnPath(env) ?? "dotnet";
}

/** Empty and relative PATH entries resolve against the child's working directory, which is the
 * untrusted project folder, so only absolute entries are searched. */
function findDotnetOnPath(env: NodeJS.ProcessEnv): string | undefined {
  const executable = process.platform === "win32" ? "dotnet.exe" : "dotnet";
  for (const entry of (env.PATH ?? env.Path ?? "").split(path.delimiter)) {
    if (entry.length === 0 || !path.isAbsolute(entry)) {
      continue;
    }
    const candidate = path.join(entry, executable);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Environment for a spawned dotnet child. An absolute override pins DOTNET_HOST_PATH / DOTNET_ROOT,
 * which MSBuild and Roslyn's build host exec directly. A bare `dotnet` clears an inherited
 * DOTNET_HOST_PATH, which would reach a different host, but keeps DOTNET_ROOT. */
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
    delete childEnv.DOTNET_HOST_PATH;
    log?.(`Using '${dotnetPath}' from PATH; leaving DOTNET_ROOT as inherited.`);
  }
  return childEnv;
}
