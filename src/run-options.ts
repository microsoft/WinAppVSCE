import { extractJsonObject } from './winapp-cli-utils';


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

/** Every run option except the positional `input`. */
export type RunOptionKey = Exclude<keyof WinAppRunOptions, 'input'>;

/** A boolean run option offered by the With Options palette command. */
export interface RunToggle {
	key: RunOptionKey;
	label: string;
	detail: string;
	/** Only offered when the target is a project or solution. */
	projectOnly?: boolean;
	/** Dropped unless this toggle is also on; the CLI ignores it otherwise. */
	requires?: RunOptionKey;
}

/**
 * Toggles offered by With Options, in prompt order.
 *
 * `--without-alias` is omitted to avoid offering two conflicting aliases.
 * `debugOutput` and `symbols` live here rather than in `launch.json` because
 * `--debug-output` attaches the CLI's own debugger, and only one debugger can
 * attach to a process at a time.
 */
export const RUN_TOGGLES: readonly RunToggle[] = [
	{ key: 'clean', label: 'Clean application data', detail: 'Remove the existing package\'s LocalState and settings before deploying (--clean)' },
	{ key: 'noBuild', label: 'Skip build', detail: 'Run the existing build output without rebuilding (--no-build)', projectOnly: true },
	{ key: 'noRestore', label: 'Skip restore', detail: 'Do not restore the project before building (--no-restore)', projectOnly: true },
	{ key: 'aot', label: 'Native AOT publish', detail: 'Run the project\'s configured Native AOT publish; requires PublishAot=true (--aot)', projectOnly: true },
	{ key: 'detach', label: 'Launch and return immediately', detail: 'Do not wait for the app to exit (--detach)' },
	{ key: 'noLaunch', label: 'Register only, do not launch', detail: 'Create the debug identity and register the package without starting the app (--no-launch)' },
	{ key: 'withAlias', label: 'Launch via execution alias', detail: 'Run in the terminal with stdin/stdout inherited; requires an execution alias in the manifest (--with-alias)' },
	{ key: 'unregisterOnExit', label: 'Unregister on exit', detail: 'Remove the development package after the app exits (--unregister-on-exit)' },
	{ key: 'debugOutput', label: 'Capture debug output', detail: 'Capture OutputDebugString and first-chance exceptions; no other debugger can attach while this is on (--debug-output)' },
	{ key: 'symbols', label: 'Download symbols for crash analysis', detail: 'Use the Microsoft Symbol Server for richer native stacks; only applies with Capture debug output (--symbols)', requires: 'debugOutput' }
];

/** Toggles applicable to a target; project-only ones need project mode. */
export function availableRunToggles(projectMode: boolean): RunToggle[] {
	return RUN_TOGGLES.filter(toggle => !toggle.projectOnly || projectMode);
}

/**
 * Resolves checked toggle keys into run options.
 *
 * A dependent toggle checked on its own is cleared rather than passed through,
 * so the CLI never receives a flag it would ignore.
 */
export function resolveRunToggles(
	available: readonly RunToggle[],
	checkedKeys: readonly RunOptionKey[]
): Partial<WinAppRunOptions> {
	const checked = new Set(checkedKeys);
	const selected: Record<string, boolean> = {};
	for (const toggle of available) {
		selected[toggle.key] = checked.has(toggle.key);
	}
	for (const toggle of available) {
		if (toggle.requires && !selected[toggle.requires]) {
			selected[toggle.key] = false;
		}
	}
	return selected as Partial<WinAppRunOptions>;
}

/** How an option is spelled on the command line. */
type RunOptionKind =
	/** `--flag value`, emitted only when the trimmed value is non-empty. */
	| 'value'
	/** `--flag`, emitted only when truthy. */
	| 'switch'
	/** `--flag Name=Value`, repeated once per entry. */
	| 'properties';

/**
 * The single source of truth for the `winapp run` surface.
 *
 * Argv emission, the launch.json mapping, and debug-session validation are all
 * derived from this table, and `package-contributions.test.ts` holds the
 * launch.json schema in `package.json` to it. Adding a CLI option means adding
 * one row plus one schema entry, rather than editing four parallel lists.
 */
interface RunOptionDescriptor {
	readonly key: RunOptionKey;
	readonly flag: string;
	readonly kind: RunOptionKind;
	/** Whether `package.json` declares this option in the launch.json schema. */
	readonly inLaunchSchema: boolean;
	/** Whether {@link runOptionsFromDebugConfig} copies it from a launch.json entry. */
	readonly fromDebugConfig: boolean;
	/** Why a WinApp debug session cannot honour it, when it cannot. */
	readonly debugUnsupported?: string;
}

/** Declaration order is argv order, so command lines are reproducible. */
export const RUN_OPTIONS: readonly RunOptionDescriptor[] = [
	{ key: 'project', flag: '--project', kind: 'value', inLaunchSchema: true, fromDebugConfig: true },
	{ key: 'configuration', flag: '--configuration', kind: 'value', inLaunchSchema: true, fromDebugConfig: true },
	{ key: 'arch', flag: '--arch', kind: 'value', inLaunchSchema: true, fromDebugConfig: true },
	{ key: 'framework', flag: '--framework', kind: 'value', inLaunchSchema: true, fromDebugConfig: true },
	{ key: 'runtime', flag: '--runtime', kind: 'value', inLaunchSchema: true, fromDebugConfig: true },
	{ key: 'properties', flag: '--property', kind: 'properties', inLaunchSchema: true, fromDebugConfig: true },
	{ key: 'noRestore', flag: '--no-restore', kind: 'switch', inLaunchSchema: true, fromDebugConfig: true },
	{ key: 'noBuild', flag: '--no-build', kind: 'switch', inLaunchSchema: true, fromDebugConfig: true },
	{ key: 'aot', flag: '--aot', kind: 'switch', inLaunchSchema: true, fromDebugConfig: true },
	{ key: 'clean', flag: '--clean', kind: 'switch', inLaunchSchema: true, fromDebugConfig: true },
	{ key: 'manifest', flag: '--manifest', kind: 'value', inLaunchSchema: true, fromDebugConfig: true },
	{ key: 'outputAppxDirectory', flag: '--output-appx-directory', kind: 'value', inLaunchSchema: true, fromDebugConfig: true },
	{ key: 'executable', flag: '--executable', kind: 'value', inLaunchSchema: true, fromDebugConfig: true },
	{ key: 'withAlias', flag: '--with-alias', kind: 'switch', inLaunchSchema: true, fromDebugConfig: true },
	{ key: 'withoutAlias', flag: '--without-alias', kind: 'switch', inLaunchSchema: true, fromDebugConfig: true },
	{ key: 'unregisterOnExit', flag: '--unregister-on-exit', kind: 'switch', inLaunchSchema: true, fromDebugConfig: true },
	{
		key: 'noLaunch',
		flag: '--no-launch',
		kind: 'switch',
		inLaunchSchema: false,
		fromDebugConfig: true,
		debugUnsupported: '"noLaunch" is not supported in a WinApp debug configuration, because there is no launched process to attach to.'
	},
	{
		key: 'detach',
		flag: '--detach',
		kind: 'switch',
		inLaunchSchema: false,
		fromDebugConfig: true,
		debugUnsupported: '"detach" is not supported in a WinApp debug configuration, because WinApp must stay attached to manage the debug session.'
	},
	{
		key: 'debugOutput',
		flag: '--debug-output',
		kind: 'switch',
		inLaunchSchema: false,
		fromDebugConfig: true,
		// Windows allows one debugger per process, so the CLI cannot capture
		// debug output while VS Code is attached.
		debugUnsupported: '"debugOutput" is not supported in a WinApp debug configuration, because VS Code is already attached as the debugger.'
	},
	// Only meaningful alongside --debug-output, so launch.json does not offer
	// it; it is still mapped so a hand-written config round-trips.
	{ key: 'symbols', flag: '--symbols', kind: 'switch', inLaunchSchema: false, fromDebugConfig: true },
	// The adapter composes --args itself (it prepends --inspect for node), and
	// --json is always on for a debug session, so neither is copied blindly.
	{ key: 'args', flag: '--args', kind: 'value', inLaunchSchema: true, fromDebugConfig: false },
	{ key: 'json', flag: '--json', kind: 'switch', inLaunchSchema: false, fromDebugConfig: false }
];

/** Builds argv for shell-free spawn; project-only options stay for validation. */
export function buildRunArgs(options: WinAppRunOptions): string[] {
	const args = ['run', options.input];

	for (const option of RUN_OPTIONS) {
		const value = options[option.key];

		switch (option.kind) {
			case 'switch':
				if (value) { args.push(option.flag); }
				break;

			case 'value': {
				const text = typeof value === 'string' ? value.trim() : '';
				if (text) { args.push(option.flag, text); }
				break;
			}

			case 'properties':
				for (const [name, entry] of Object.entries((value as Record<string, string> | undefined) ?? {})) {
					args.push(option.flag, `${name}=${entry}`);
				}
				break;
		}
	}

	return args;
}

/**
 * Options the debug adapter cannot honour. The CLI accepts all of them; it is
 * the VS Code debug session they break, so the CLI never reports them.
 */
export function validateDebugRunOptions(options: WinAppRunOptions): string[] {
	return RUN_OPTIONS
		.filter(option => option.debugUnsupported && options[option.key])
		.map(option => option.debugUnsupported!);
}

/**
 * Typed view of a `winapp` launch.json entry; `vscode.DebugConfiguration` is
 * all `any`. Every run option is accepted here so a hand-written config is
 * still type-checked, including the ones {@link validateDebugRunOptions}
 * rejects by name.
 */
export type WinAppDebugConfiguration = {
	/** Keeps this assignable from `vscode.DebugConfiguration`. */
	[key: string]: unknown;

	/** Positional input. Supersedes `inputFolder`. */
	input?: string;
	/** Deprecated alias for `input`, kept so existing launch.json files keep working. */
	inputFolder?: string;
} & Partial<Omit<WinAppRunOptions, 'input' | 'json'>>;

/** `input` supersedes the deprecated `inputFolder` alias. */
export function resolveDebugInput(config: WinAppDebugConfiguration): string | undefined {
	return config.input || config.inputFolder || undefined;
}

/**
 * Maps a launch.json entry onto {@link WinAppRunOptions}, always setting `json`
 * so the adapter can parse the PID. Debug-hostile flags are copied through so
 * {@link validateDebugRunOptions} can reject them by name.
 */
export function runOptionsFromDebugConfig(
	config: WinAppDebugConfiguration,
	input: string
): WinAppRunOptions {
	const options: WinAppRunOptions = { input };
	const writable = options as unknown as Record<string, unknown>;

	for (const option of RUN_OPTIONS) {
		if (option.fromDebugConfig) {
			writable[option.key] = config[option.key];
		}
	}

	// The adapter reads the launched process ID out of `--json` output, so this
	// is never the caller's to opt out of.
	options.json = true;
	return options;
}

/**
 * Reads the process ID out of `winapp run --json` output — the reciprocal of
 * the `--json` flag {@link runOptionsFromDebugConfig} always sets. Called on
 * every stdout chunk, so incomplete JSON is an expected miss, not an error.
 *
 * Scans for the JSON object rather than parsing the whole buffer, because the
 * CLI interleaves progress prose with its `--json` payload on stdout.
 */
export function parseProcessIdFromJson(output: string): number | undefined {
	const json = extractJsonObject(output);
	const pid = json?.processId ?? json?.pid ?? json?.ProcessId ?? json?.PID;
	return typeof pid === 'number' && pid > 0 ? pid : undefined;
}

