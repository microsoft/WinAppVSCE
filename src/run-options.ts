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
	/** Launch via the app's execution alias instead of AUMID activation. */
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
	/** Turned on alongside this toggle; the CLI ignores it otherwise. */
	requires?: RunOptionKey;
}

/**
 * Toggles offered by With Options, in prompt order.
 *
 * `--without-alias` is omitted to avoid offering two conflicting aliases.
 * `debugOutput` and `symbols` live here rather than in `launch.json` because
 * `--debug-output` attaches the CLI's own debugger, and only one debugger can
 * attach to a process at a time.
 *
 * `detail` carries no flag name: {@link runToggleDetail} appends it from
 * {@link RUN_OPTIONS}, so there is one spelling of every flag.
 */
export const RUN_TOGGLES: readonly RunToggle[] = [
	{ key: 'clean', label: 'Clean application data', detail: 'Remove the existing package\'s LocalState and settings before deploying' },
	{ key: 'noBuild', label: 'Skip build', detail: 'Run the existing build output without rebuilding', projectOnly: true },
	{ key: 'noRestore', label: 'Skip restore', detail: 'Do not restore the project before building', projectOnly: true },
	{ key: 'aot', label: 'Native AOT publish', detail: 'Run the project\'s configured Native AOT publish; requires PublishAot=true', projectOnly: true },
	{ key: 'detach', label: 'Launch and return immediately', detail: 'Do not wait for the app to exit' },
	{ key: 'noLaunch', label: 'Register only, do not launch', detail: 'Create the debug identity and register the package without starting the app' },
	{ key: 'withAlias', label: 'Launch via execution alias', detail: 'Run in the terminal with stdin/stdout inherited; forces this for a windowed app, as console apps already do it' },
	{ key: 'unregisterOnExit', label: 'Unregister on exit', detail: 'Remove the development package after the app exits' },
	{ key: 'debugOutput', label: 'Capture debug output', detail: 'Capture OutputDebugString and first-chance exceptions; no other debugger can attach while this is on' },
	{ key: 'symbols', label: 'Download symbols for crash analysis', detail: 'Use the Microsoft Symbol Server for richer native stacks; turns on Capture debug output', requires: 'debugOutput' }
];

/** Toggles applicable to a target; project-only ones need project mode. */
export function availableRunToggles(projectMode: boolean): RunToggle[] {
	return RUN_TOGGLES.filter(toggle => !toggle.projectOnly || projectMode);
}

/**
 * Checked keys plus every prerequisite they imply.
 *
 * Checking a dependent toggle states an intent the prerequisite is part of, so
 * turning the prerequisite on is what the user asked for. The reverse does not
 * hold: a prerequisite is useful on its own, so clearing one leaves the
 * dependent alone — {@link resolveRunToggles} drops it at that point.
 */
export function expandRequiredToggles(
	available: readonly RunToggle[],
	checkedKeys: readonly RunOptionKey[]
): RunOptionKey[] {
	const byKey = new Map(available.map(toggle => [toggle.key, toggle]));
	const expanded = new Set(checkedKeys.filter(key => byKey.has(key)));

	for (const key of [...expanded]) {
		// Walk the chain so a future three-deep dependency still resolves.
		let requirement = byKey.get(key)?.requires;
		while (requirement && byKey.has(requirement) && !expanded.has(requirement)) {
			expanded.add(requirement);
			requirement = byKey.get(requirement)?.requires;
		}
	}

	// Emit in offer order so callers can compare against the offered list.
	return available.filter(toggle => expanded.has(toggle.key)).map(toggle => toggle.key);
}

/**
 * Resolves checked toggle keys into run options.
 *
 * A dependent toggle brings its prerequisite with it, and is itself cleared
 * when that prerequisite is unavailable, so the CLI never receives a flag it
 * would ignore.
 */
export function resolveRunToggles(
	available: readonly RunToggle[],
	checkedKeys: readonly RunOptionKey[]
): Partial<WinAppRunOptions> {
	const checked = new Set(expandRequiredToggles(available, checkedKeys));
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

/** How an option is spelled on the command line, for UI text. */
export function runOptionFlag(key: RunOptionKey): string {
	const option = RUN_OPTIONS.find(entry => entry.key === key);
	if (!option) {
		throw new Error(`No winapp run option is registered for "${key}".`);
	}
	return option.flag;
}

/**
 * Detail line for a toggle, with its flag appended from {@link RUN_OPTIONS}.
 *
 * Spelling the flag in the toggle literal too would let the picker drift out
 * of sync with the argv the same key actually produces.
 */
export function runToggleDetail(toggle: RunToggle): string {
	return `${toggle.detail} (${runOptionFlag(toggle.key)})`;
}

/** Builds argv for shell-free spawn; project-only options stay for validation. */export function buildRunArgs(options: WinAppRunOptions): string[] {
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

/** A launch.json `"project"` the user actually filled in, or undefined. */
function explicitProject(configuredProject: unknown): string | undefined {
	return typeof configuredProject === 'string' && configuredProject.trim()
		? configuredProject
		: undefined;
}

/**
 * Whether the interactive flow should ask which project to launch.
 *
 * An explicit launch.json `"project"` already answers the question, and
 * {@link resolveRunProject} would discard the answer anyway — so asking would
 * only cost the user a prompt.
 */
export function shouldPromptForProject(configuredProject: unknown): boolean {
	return explicitProject(configuredProject) === undefined;
}

/**
 * An explicit launch.json `"project"` always wins; the picker's answer only
 * fills in what the configuration left blank.
 */
export function resolveRunProject(
	configuredProject: unknown,
	pickedProject: string | undefined
): string | undefined {
	return explicitProject(configuredProject) ?? pickedProject;
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

