import { isProjectMode, RunTargetKind } from './run-target';

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

export interface RunOptionDiagnostic {
	severity: 'error' | 'warning';
	message: string;
}

/** The debug adapter has stricter rules because it must attach. */
export type RunOptionsContext = 'palette' | 'debug';

/** Architectures accepted by `--arch`. */
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

/** Errors block the run; warnings surface CLI-ignored settings. */
export function validateRunOptions(
	options: WinAppRunOptions,
	kind: RunTargetKind,
	context: RunOptionsContext = 'palette'
): RunOptionDiagnostic[] {
	const diagnostics: RunOptionDiagnostic[] = [];

	// --- CLI-documented conflicts ---
	if (options.debugOutput && options.json) {
		diagnostics.push({
			severity: 'error',
			message: 'The "--debug-output" option cannot be combined with JSON output.'
		});
	}

	if (options.debugOutput && options.noLaunch) {
		diagnostics.push({
			severity: 'error',
			message: 'The "--debug-output" option cannot be combined with "--no-launch", because there is no process to capture output from.'
		});
	}

	if (options.withAlias && options.withoutAlias) {
		diagnostics.push({
			severity: 'error',
			message: 'The "withAlias" and "withoutAlias" options are opposites and cannot both be set.'
		});
	}

	if (options.symbols && !options.debugOutput) {
		diagnostics.push({
			severity: 'warning',
			message: 'The "symbols" option only applies when debug output capture is enabled, and will be ignored.'
		});
	}

	// --- Attach-specific rules ---
	if (context === 'debug') {
		if (options.noLaunch) {
			diagnostics.push({
				severity: 'error',
				message: '"noLaunch" is not supported in a WinApp debug configuration, because there is no launched process for the debugger to attach to. '
					+ 'Remove it, or register the package from the command palette and use a standard "attach" configuration instead.'
			});
		}
		if (options.detach) {
			diagnostics.push({
				severity: 'error',
				message: '"detach" is not supported in a WinApp debug configuration, because WinApp must stay attached to the launched app to manage the debug session. Remove it from launch.json.'
			});
		}
		if (options.debugOutput) {
			diagnostics.push({
				severity: 'error',
				message: '"debugOutput" is not supported in a WinApp debug configuration. '
					+ 'Windows allows only one debugger per process, so WinApp cannot capture debug output while VS Code is attached.'
			});
		}
	}

	// --- Mode mismatches ---
	if (!isProjectMode(kind) && kind !== 'unknown') {
		// `--aot` is the one project-only option the CLI rejects instead of
		// ignores, so silently dropping it would run a non-AOT build.
		if (options.aot) {
			diagnostics.push({
				severity: 'error',
				message: 'The "aot" option requires a project, solution, or source directory, and cannot be used with a build output folder.'
			});
		}

		const projectOnly = listProjectOnlyOptions(options).filter(name => name !== '--aot');
		if (projectOnly.length > 0) {
			const list = projectOnly.join(', ');
			const verb = projectOnly.length === 1 ? 'applies' : 'apply';
			diagnostics.push({
				severity: 'warning',
				message: `${list} ${verb} only when running a project or solution, and will be ignored for a build output folder.`
			});
		}
	}

	// --- Value checks ---
	if (options.runtime && options.arch) {
		diagnostics.push({
			severity: 'warning',
			message: 'Both "runtime" and "arch" are set. The runtime identifier takes precedence, so "arch" will be ignored.'
		});
	}

	if (options.runtime && !isWindowsRuntimeIdentifier(options.runtime)) {
		diagnostics.push({
			severity: 'error',
			message: `"${options.runtime}" is not a Windows runtime identifier the CLI can derive an architecture from. Use a win-* RID that ends in a supported architecture, such as "win-x64", "win-arm64", or "win10-x86".`
		});
	}

	if (options.arch && !isSupportedArchitecture(options.arch)) {
		diagnostics.push({
			severity: 'error',
			message: `"${options.arch}" is not a supported architecture. Use one of: ${SUPPORTED_ARCHITECTURES.join(', ')}.`
		});
	}

	if (options.noBuild && options.noRestore) {
		diagnostics.push({
			severity: 'warning',
			message: 'The "noRestore" option has no effect when "noBuild" is set, because no build runs.'
		});
	}

	for (const [name, value] of Object.entries(options.properties ?? {})) {
		if (name.trim() === '') {
			diagnostics.push({
				severity: 'error',
				message: 'MSBuild property names cannot be empty.'
			});
		} else if (name.includes('=')) {
			diagnostics.push({
				severity: 'error',
				message: `MSBuild property name "${name}" cannot contain "=".`
			});
		}
		if (value === undefined || value === null) {
			diagnostics.push({
				severity: 'error',
				message: `MSBuild property "${name}" has no value. Use an empty string to set it to nothing.`
			});
		}
	}

	return diagnostics;
}

/** Convenience filter: the blocking diagnostics from {@link validateRunOptions}. */
export function getRunOptionErrors(diagnostics: readonly RunOptionDiagnostic[]): RunOptionDiagnostic[] {
	return diagnostics.filter(d => d.severity === 'error');
}

/** Leaves `unknown` and `aot` untouched so CLI/validation handle them. */
export function clearInapplicableOptions(
	options: WinAppRunOptions,
	kind: RunTargetKind
): WinAppRunOptions {
	if (kind !== 'folder') {
		return options;
	}

	return {
		...options,
		project: undefined,
		configuration: undefined,
		arch: undefined,
		framework: undefined,
		runtime: undefined,
		properties: undefined,
		noBuild: undefined,
		noRestore: undefined
	};
}

/** Explicit launch.json subset avoids `any` hiding misspelled keys. */
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

/** Uses CLI flag spelling so warnings match `winapp run --help`. */
function listProjectOnlyOptions(options: WinAppRunOptions): string[] {
	const present: string[] = [];
	if (options.project) { present.push('--project'); }
	if (options.configuration) { present.push('--configuration'); }
	if (options.arch) { present.push('--arch'); }
	if (options.framework) { present.push('--framework'); }
	if (options.runtime) { present.push('--runtime'); }
	if (options.properties && Object.keys(options.properties).length > 0) { present.push('--property'); }
	if (options.noBuild) { present.push('--no-build'); }
	if (options.noRestore) { present.push('--no-restore'); }
	if (options.aot) { present.push('--aot'); }
	return present;
}

/** Matches CLI arch parsing: case-insensitive, with `amd64` as x64. */
function isSupportedArchitecture(arch: string): boolean {
	const normalized = arch.trim().toLowerCase();
	return (SUPPORTED_ARCHITECTURES as readonly string[]).includes(normalized) || normalized === 'amd64';
}

/** CLI accepts only `win` + optional digits + a supported architecture. */
function isWindowsRuntimeIdentifier(runtime: string): boolean {
	return /^win\d*-(?:x64|arm64|x86|amd64)$/.test(runtime.trim().toLowerCase());
}
