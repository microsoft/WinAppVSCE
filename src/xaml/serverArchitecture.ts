export type WindowsServerRid = "win-x64" | "win-arm64";

/** Selects the server for the native architecture, including under ARM64 emulation. */
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
