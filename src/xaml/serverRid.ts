/** Picks the host-matching Native AOT server binary; kept free of `vscode` so tests catch ARM64 regressions on x64 CI. */
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
