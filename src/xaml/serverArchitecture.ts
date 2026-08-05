export type WindowsServerRid = "win-x64" | "win-arm64";

/**
 * Selects the server matching the native Windows architecture. Environment variables take
 * precedence so an x64 VS Code process running under ARM64 emulation still launches the ARM64
 * server, which can load the machine's native MSBuild assemblies.
 */
export function getWindowsServerRid(
  processArchitecture: string = process.arch,
  environment: NodeJS.ProcessEnv = process.env
): WindowsServerRid {
  const nativeArchitecture =
    environment.PROCESSOR_ARCHITEW6432 ??
    environment.PROCESSOR_ARCHITECTURE ??
    processArchitecture;
  return nativeArchitecture.toLowerCase() === "arm64" ? "win-arm64" : "win-x64";
}
