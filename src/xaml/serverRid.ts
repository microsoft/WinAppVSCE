/**
 * Picks the Native AOT server binary that matches the host.
 *
 * Kept free of `vscode` so it is directly testable: CI runs x64, so a regression that always
 * returned `win-x64` would leave ARM64 users silently running the emulated binary without failing
 * any suite.
 */
export function serverRidFor(platform: string, arch: string): string | undefined {
  if (platform !== "win32") {
    return undefined;
  }

  switch (arch) {
    case "arm64":
      return "win-arm64";
    case "x64":
      return "win-x64";
    default:
      return undefined;
  }
}
