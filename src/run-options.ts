

/** Shared `winapp run` option shape for palette and debug invocations. */
export interface WinAppRunOptions {
	/** Positional `input`: a build-output folder, `.csproj`, `.sln`/`.slnx`, or a directory containing one. */
	input: string;

	// --- Project mode only (silently ignored by the CLI in folder mode) ---
	/** Selects which project to launch when `input` is a solution or multi-app directory. */
	project?: string;
	/** Build configuration, e.g. `Debug` or `Release`. */
	configuration?: string;
	/** Target architecture: `x64`, `arm64`, or `x86`. */
	arch?: string;
	/** Target framework moniker, for multi-targeted projects. */
	framework?: string;
	/** .NET runtime identifier, e.g. `win-x64`. Overrides {@link arch}. */
	runtime?: string;
	/** MSBuild properties forwarded to both build and evaluation. */
	properties?: Record<string, string>;
	/** Skip building; run the existing build output. */
	noBuild?: boolean;
	/** Skip restoring before building. */
	noRestore?: boolean;
	/** Run the project's configured .NET Native AOT publish. Requires `PublishAot=true`. */
	aot?: boolean;

	// --- Both modes ---
	/** Remove the existing package's application data before re-deploying. */
	clean?: boolean;
	/** Capture OutputDebugString and first-chance exceptions. Incompatible with {@link json} and {@link noLaunch}. */
	debugOutput?: boolean;
	/** Download symbols from the Microsoft Symbol Server. Only meaningful with {@link debugOutput}. */
	symbols?: boolean;
	/** Launch and return immediately without waiting for exit. */
	detach?: boolean;
	/** Register the package without launching it. */
	noLaunch?: boolean;
	/** Unregister the development package after the app exits. */
	unregisterOnExit?: boolean;
	/** Launch via the manifest's execution alias instead of AUMID activation. */
	withAlias?: boolean;
	/** Forces AUMID activation; mutually exclusive with {@link withAlias}. */
	withoutAlias?: boolean;
	/** Path to the executable relative to the input folder. */
	executable?: string;
	/** Explicit `Package.appxmanifest` path. */
	manifest?: string;
	/** Output directory for the loose layout package. */
	outputAppxDirectory?: string;
	/** Command-line arguments passed to the launched application. */
	args?: string;
	/** Emit machine-readable output. Required by the debug adapter to read the launched PID. */
	json?: boolean;
}

/** Architectures offered in the UI. The CLI validates the value it is given. */
export const SUPPORTED_ARCHITECTURES = ['x64', 'arm64', 'x86'] as const;

/** Build configurations offered in the UI. `--configuration` accepts any value. */
export const COMMON_CONFIGURATIONS = ['Debug', 'Release'] as const;

/** Builds argv for shell-free spawn; project-only options stay for validation. */
export function buildRunArgs(options: WinAppRunOptions): string[] {
	const args = ['run', options.input];

	if (options.project) { args.push('--project', options.project); }
	if (options.configuration) { args.push('--configuration', options.configuration); }
	if (options.arch) { args.push('--arch', options.arch); }
	if (options.framework) { args.push('--framework', options.framework); }
	if (options.runtime) { args.push('--runtime', options.runtime); }

	for (const [name, value] of Object.entries(options.properties ?? {})) {
		args.push('--property', `${name}=${value}`);
	}

	if (options.noRestore) { args.push('--no-restore'); }
	if (options.noBuild) { args.push('--no-build'); }
	if (options.aot) { args.push('--aot'); }
	if (options.clean) { args.push('--clean'); }

	if (options.manifest) { args.push('--manifest', options.manifest); }
	if (options.outputAppxDirectory) { args.push('--output-appx-directory', options.outputAppxDirectory); }
	if (options.executable) { args.push('--executable', options.executable); }

	if (options.withAlias) { args.push('--with-alias'); }
	if (options.withoutAlias) { args.push('--without-alias'); }
	if (options.unregisterOnExit) { args.push('--unregister-on-exit'); }
	if (options.noLaunch) { args.push('--no-launch'); }
	if (options.detach) { args.push('--detach'); }

	if (options.debugOutput) { args.push('--debug-output'); }
	if (options.symbols) { args.push('--symbols'); }

	const trimmedArgs = options.args?.trim();
	if (trimmedArgs) { args.push('--args', trimmedArgs); }

	if (options.json) { args.push('--json'); }

	return args;
}

/**
 * Options the debug adapter cannot honour. The CLI accepts all three; it is
 * the VS Code debug session they break, so the CLI never reports them.
 */
export function validateDebugRunOptions(options: WinAppRunOptions): string[] {
	const errors: string[] = [];

	if (options.noLaunch) {
		errors.push('"noLaunch" is not supported in a WinApp debug configuration, because there is no launched process to attach to.');
	}

	if (options.detach) {
		errors.push('"detach" is not supported in a WinApp debug configuration, because WinApp must stay attached to manage the debug session.');
	}

	// Windows allows one debugger per process, so the CLI cannot capture debug
	// output while VS Code is attached.
	if (options.debugOutput) {
		errors.push('"debugOutput" is not supported in a WinApp debug configuration, because VS Code is already attached as the debugger.');
	}

	return errors;
}

/** Typed view of a `winapp` launch.json entry; `vscode.DebugConfiguration` is all `any`. */
export interface WinAppDebugConfiguration {
	/** Keeps this assignable from `vscode.DebugConfiguration`. */
	[key: string]: unknown;

	/** Positional input. Supersedes {@link inputFolder}. */
	input?: string;
	/** Deprecated alias for {@link input}, kept so existing launch.json files keep working. */
	inputFolder?: string;
	project?: string;
	configuration?: string;
	arch?: string;
	framework?: string;
	runtime?: string;
	properties?: Record<string, string>;
	noBuild?: boolean;
	noRestore?: boolean;
	aot?: boolean;
	clean?: boolean;
	detach?: boolean;
	noLaunch?: boolean;
	unregisterOnExit?: boolean;
	withAlias?: boolean;
	withoutAlias?: boolean;
	executable?: string;
	manifest?: string;
	outputAppxDirectory?: string;
	debugOutput?: boolean;
	symbols?: boolean;
}

/** `input` supersedes the deprecated `inputFolder` alias. */
export function resolveDebugInput(config: WinAppDebugConfiguration): string | undefined {
	return config.input || config.inputFolder || undefined;
}

/** Sets `json` and keeps rejected debug flags for validation messages. */
export function runOptionsFromDebugConfig(
	config: WinAppDebugConfiguration,
	input: string
): WinAppRunOptions {
	return {
		input,
		project: config.project,
		configuration: config.configuration,
		arch: config.arch,
		framework: config.framework,
		runtime: config.runtime,
		properties: config.properties,
		noBuild: config.noBuild,
		noRestore: config.noRestore,
		aot: config.aot,
		clean: config.clean,
		detach: config.detach,
		noLaunch: config.noLaunch,
		unregisterOnExit: config.unregisterOnExit,
		withAlias: config.withAlias,
		withoutAlias: config.withoutAlias,
		executable: config.executable,
		manifest: config.manifest,
		outputAppxDirectory: config.outputAppxDirectory,
		debugOutput: config.debugOutput,
		symbols: config.symbols,
		json: true
	};
}

