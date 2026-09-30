import * as path from "path";

/** The `dotnet` for MSBuild/restore/build: PATH, which the SDK installer sets, unless
 * `WINUI_XAML_DOTNET_PATH` pins a specific install for dev/test. */
export function resolveDotnetCommand(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.WINUI_XAML_DOTNET_PATH;
  return override && override.length > 0 ? override : "dotnet";
}

/** Environment for a spawned dotnet child. Only an absolute override pins DOTNET_HOST_PATH /
 * DOTNET_ROOT, which MSBuild and Roslyn's build host exec directly; a bare `dotnet` from PATH
 * keeps the inherited values, because guessing DOTNET_ROOT can break a working SDK. */
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
    log?.(`Using '${dotnetPath}' from PATH; leaving DOTNET_ROOT as inherited.`);
  }
  return childEnv;
}
