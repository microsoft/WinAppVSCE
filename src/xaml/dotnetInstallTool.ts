// Kept independent of the VS Code API for unit testing.

/** The .NET Install Tool, which owns .NET discovery for the C# extension and C# Dev Kit. */
export const DOTNET_INSTALL_TOOL_ID = "ms-dotnettools.vscode-dotnet-runtime";

/** Major.minor of the runtime the language server targets. */
export const REQUIRED_DOTNET_VERSION = "10.0";

/**
 * Request passed to the Install Tool's `dotnet.findPath` command.
 *
 * `versionSpecRequirement` is deliberately `"equal"` rather than the
 * `"greater_than_or_equal"` the C# extension uses. The Install Tool compares
 * major.minor, so `"greater_than_or_equal"` on `"10.0"` also accepts a .NET 11
 * host — and a `net10.0` application does not roll forward across a major
 * version by default, so that host could not launch the server. `"equal"` with a
 * patchless version accepts any 10.0.x.
 *
 * `rejectPreviews` matters for the same reason: a released `net10.0` server does
 * not roll forward onto a prerelease runtime without
 * `DOTNET_ROLL_FORWARD_TO_PRERELEASE`.
 */
export interface DotnetFindPathRequest {
  readonly acquireContext: {
    readonly version: string;
    readonly requestingExtensionId: string;
    readonly architecture: string;
    readonly mode: "runtime";
  };
  readonly versionSpecRequirement: "equal";
  readonly rejectPreviews: true;
}

export function buildFindPathRequest(
  requestingExtensionId: string,
  architecture: string
): DotnetFindPathRequest {
  return {
    acquireContext: {
      version: REQUIRED_DOTNET_VERSION,
      requestingExtensionId,
      architecture,
      mode: "runtime",
    },
    versionSpecRequirement: "equal",
    rejectPreviews: true,
  };
}

/** Why a .NET host could not be resolved. */
export type DotnetResolutionFailure = "install-tool-unavailable" | "runtime-not-found";

export type DotnetResolution =
  | { readonly status: "resolved"; readonly dotnetPath: string }
  | { readonly status: "failed"; readonly reason: DotnetResolutionFailure };

/** Host operations the resolver needs, injected so the resolver stays testable. */
export interface InstallToolHost {
  /** Whether the Install Tool extension is present in this VS Code instance. */
  isInstalled(): boolean;
  /** Installs the Install Tool from the marketplace. Rejects if it cannot be installed. */
  install(): Promise<void>;
  /** Activates the Install Tool so its commands are registered. */
  activate(): Promise<void>;
  /** Executes `dotnet.findPath`. Resolves to undefined when no host satisfies the request. */
  findPath(request: DotnetFindPathRequest): Promise<{ dotnetPath: string } | undefined>;
  log(message: string): void;
  /** Monotonic-enough clock, injected so timing assertions are deterministic in tests. */
  now(): number;
}

/**
 * Resolves the .NET host through the Install Tool, which is the only discovery
 * mechanism this extension uses.
 *
 * The result is cached for the session because resolution is not free and
 * `startClient` can run repeatedly. {@link invalidate} exists so the explicit
 * restart command remains a genuine retry.
 */
export class DotnetHostResolver {
  private cachedPath: string | undefined;
  private installAttempted = false;

  /**
   * @param hostOverride Absolute path to a .NET host, bypassing the Install Tool.
   * A dev/test hook only, matching `WINUI_XAML_SERVER_PATH`: the integration
   * harness launches VS Code with `--disable-extensions`, so the Install Tool
   * cannot be installed or queried there. It is not a user-facing discovery path.
   */
  constructor(
    private readonly host: InstallToolHost,
    private readonly requestingExtensionId: string,
    private readonly architecture: string,
    private readonly hostOverride?: string
  ) {}

  /** Drops the cached host so the next resolve re-runs discovery. */
  invalidate(): void {
    this.cachedPath = undefined;
  }

  async resolve(): Promise<DotnetResolution> {
    if (this.hostOverride) {
      return { status: "resolved", dotnetPath: this.hostOverride };
    }

    if (this.cachedPath) {
      return { status: "resolved", dotnetPath: this.cachedPath };
    }

    if (!(await this.ensureInstallTool())) {
      return { status: "failed", reason: "install-tool-unavailable" };
    }

    const request = buildFindPathRequest(this.requestingExtensionId, this.architecture);
    const startedAt = this.host.now();
    let result: { dotnetPath: string } | undefined;
    try {
      result = await this.host.findPath(request);
    } catch (error) {
      this.host.log(`.NET host lookup failed: ${describeError(error)}`);
      return { status: "failed", reason: "install-tool-unavailable" };
    }
    this.host.log(`.NET host lookup took ${this.host.now() - startedAt}ms.`);

    if (!result?.dotnetPath) {
      this.host.log(
        `No .NET ${REQUIRED_DOTNET_VERSION} ${this.architecture} runtime was found.`
      );
      return { status: "failed", reason: "runtime-not-found" };
    }

    this.cachedPath = result.dotnetPath;
    return { status: "resolved", dotnetPath: result.dotnetPath };
  }

  /**
   * Installs the Install Tool if it is missing, then activates it.
   *
   * The install is attempted at most once per session: a failure is usually a
   * disabled marketplace or an admin policy, neither of which is fixed by
   * retrying on every server start.
   */
  private async ensureInstallTool(): Promise<boolean> {
    if (!this.host.isInstalled()) {
      if (this.installAttempted) {
        return false;
      }
      this.installAttempted = true;

      this.host.log(`Installing ${DOTNET_INSTALL_TOOL_ID} to locate the .NET runtime…`);
      const startedAt = this.host.now();
      try {
        await this.host.install();
      } catch (error) {
        this.host.log(`Could not install ${DOTNET_INSTALL_TOOL_ID}: ${describeError(error)}`);
        return false;
      }
      this.host.log(
        `Installed ${DOTNET_INSTALL_TOOL_ID} in ${this.host.now() - startedAt}ms.`
      );

      if (!this.host.isInstalled()) {
        this.host.log(
          `${DOTNET_INSTALL_TOOL_ID} is not available yet; reload the window to enable XAML IntelliSense.`
        );
        return false;
      }
    }

    try {
      await this.host.activate();
    } catch (error) {
      this.host.log(`Could not activate ${DOTNET_INSTALL_TOOL_ID}: ${describeError(error)}`);
      return false;
    }
    return true;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
