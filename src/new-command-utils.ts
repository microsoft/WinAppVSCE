import * as path from 'path';

/**
 * Pure helpers backing the `winapp.new` command, kept free of the VS Code API so
 * they can be unit-tested directly. Several behaviours intentionally mirror
 * `NewCommand.cs` in microsoft/winappcli; the CLI symbol is named where so.
 */

/** Default project name, matching the CLI's `DefaultNameFor` for project templates. */
export const DEFAULT_PROJECT_NAME = 'WinUIApp';

/** Short name of the template the CLI itself defaults to; sorted first in the picker. */
export const DEFAULT_TEMPLATE_SHORT_NAME = 'winui';

/** A template entry as returned by `winapp new --list --json`. */
export interface WinUiTemplate {
	shortName: string;
	aliases: string[];
	displayName: string;
	/** `"project"` or `"item"`. */
	type: string;
	tags: string;
}

/** Parsed payload of a successful `winapp new --list --json` run. */
export interface TemplateListResult {
	templates: WinUiTemplate[];
	/** Version of the installed WinUI template pack, when the CLI reported one. */
	templateVersion?: string;
}

/** Parsed payload of a `winapp new --json` scaffold run. */
export interface ScaffoldResult {
	created: boolean;
	template?: string;
	name?: string;
	/** Absolute path to the created project directory. */
	projectPath?: string;
	error?: string;
	templateVersion?: string;
}

/**
 * Exit codes emitted by `winapp new`. Mirrors the `Exit*` constants in
 * `NewCommand.cs`; they are a documented part of the command's contract.
 */
export const NEW_EXIT = {
	success: 0,
	invalidArgs: 2,
	sdkMissing: 3,
	packFailed: 4,
	scaffoldFailed: 5
} as const;

/**
 * Characters that would make the extension's own `path.join` of the name
 * produce a directory other than the one the user picked.
 */
const PATH_SEPARATORS = /[\\/]/;

/**
 * Check only what the extension needs before it can safely build a path from
 * the name. Everything else (length, reserved device names, option-shaped
 * names) is left to the CLI, which reports it with its own wording.
 *
 * @returns An error message to show in the input box, or `undefined` when valid.
 */
export function validateProjectName(name: string | undefined): string | undefined {
	if (name === undefined || name.trim().length === 0) {
		return 'Enter a name for the app.';
	}

	// The name is joined onto the chosen folder to pick the target directory, so
	// a separator or dot segment would silently scaffold somewhere else.
	if (PATH_SEPARATORS.test(name) || name === '.' || name === '..') {
		return 'Use a simple name, without path separators.';
	}

	return undefined;
}

/**
 * Returns the first available variant of `baseName` — `Name`, `Name1`, … — where
 * a name is taken when a directory of that name exists in the parent. Ports the
 * CLI's `EnsureAvailableName`, which it skips for an explicit `--name`.
 *
 * @param baseName The requested name.
 * @param directoryExists Predicate reporting whether a path is an existing directory.
 * @param parentDirectory Directory the project directory would be created in.
 */
export function ensureAvailableName(
	baseName: string,
	parentDirectory: string,
	directoryExists: (candidatePath: string) => boolean
): string {
	const isTaken = (candidate: string): boolean => {
		try {
			return directoryExists(path.join(parentDirectory, candidate));
		} catch {
			// If the parent can't be inspected, don't block on numbering — let the
			// scaffold surface any real conflict as a structured error instead.
			return false;
		}
	};

	if (!isTaken(baseName)) {
		return baseName;
	}

	for (let suffix = 1; ; suffix++) {
		const candidate = `${baseName}${suffix}`;
		if (!isTaken(candidate)) {
			return candidate;
		}
	}
}

/**
 * How the user chose to handle an existing, non-empty target directory.
 * `use-available` takes the auto-numbered name; `create-anyway` scaffolds over
 * the existing contents with `--force`.
 */
export type NonEmptyTargetChoice = 'use-available' | 'create-anyway';

/** The resolved scaffold target. */
export interface ScaffoldTarget {
	/** Final project name to pass as `--name`. */
	name: string;
	/** Whether `--force` is needed to scaffold into a non-empty directory. */
	force: boolean;
}

/**
 * Everything {@link resolveScaffoldTarget} needs from the outside world. An
 * interface so the logic is testable without a file system or VS Code, matching
 * the `SignFlowAdapter` pattern in `sign-utils.ts`.
 */
export interface ScaffoldTargetAdapter {
	/** Whether a path exists, as either a file or a directory. */
	pathExists(candidatePath: string): boolean;

	/** Entry names in a directory. May throw when the directory can't be read. */
	readDirectory(directoryPath: string): string[];

	/** Ask how to handle an existing, non-empty target directory. */
	confirmNonEmptyTarget(
		targetDirectory: string,
		availableName: string
	): Promise<NonEmptyTargetChoice | undefined>;
}

/**
 * Decide the final project name and whether `--force` is needed. Mirrors the
 * CLI's preflight, but checking here lets us offer the auto-numbered name
 * instead of reporting exit 2 after the fact.
 *
 * @returns The resolved name and force flag, or `undefined` if the user cancelled.
 */
export async function resolveScaffoldTarget(
	adapter: ScaffoldTargetAdapter,
	parentDirectory: string,
	requestedName: string
): Promise<ScaffoldTarget | undefined> {
	const targetDirectory = path.join(parentDirectory, requestedName);

	let targetIsNonEmpty: boolean;
	try {
		targetIsNonEmpty = adapter.pathExists(targetDirectory)
			&& adapter.readDirectory(targetDirectory).length > 0;
	} catch {
		// Can't inspect the folder (locked, protected). Don't block here — let the
		// CLI surface it as a structured error with a real reason.
		return { name: requestedName, force: false };
	}

	if (!targetIsNonEmpty) {
		return { name: requestedName, force: false };
	}

	const availableName = ensureAvailableName(requestedName, parentDirectory, (candidate) =>
		adapter.pathExists(candidate)
	);

	const choice = await adapter.confirmNonEmptyTarget(targetDirectory, availableName);

	if (choice === 'use-available') {
		return { name: availableName, force: false };
	}
	if (choice === 'create-anyway') {
		return { name: requestedName, force: true };
	}
	return undefined;
}

/**
 * Parse the payload of `winapp new --list --json`.
 *
 * @returns The parsed list, or an error message when the payload is missing,
 *          malformed, or reports a CLI-side error.
 */
export function parseTemplateList(
	output: string
): { ok: true; value: TemplateListResult } | { ok: false; error: string } {
	const json = extractJsonObject(output);
	if (!json) {
		return { ok: false, error: 'Could not read the template list from the WinApp CLI.' };
	}

	if (typeof json.Error === 'string' && json.Error.trim().length > 0) {
		return { ok: false, error: json.Error.trim() };
	}

	if (!Array.isArray(json.Templates)) {
		return { ok: false, error: 'The WinApp CLI returned no WinUI templates.' };
	}

	const templates: WinUiTemplate[] = [];
	for (const raw of json.Templates) {
		if (!raw || typeof raw !== 'object') {
			continue;
		}
		const entry = raw as Record<string, unknown>;
		const shortName = typeof entry.ShortName === 'string' ? entry.ShortName : undefined;
		if (!shortName) {
			continue;
		}
		templates.push({
			shortName,
			aliases: Array.isArray(entry.Aliases)
				? entry.Aliases.filter((alias): alias is string => typeof alias === 'string')
				: [],
			displayName: typeof entry.DisplayName === 'string' && entry.DisplayName.length > 0
				? entry.DisplayName
				: shortName,
			type: typeof entry.Type === 'string' ? entry.Type : '',
			tags: typeof entry.Tags === 'string' ? entry.Tags : ''
		});
	}

	if (templates.length === 0) {
		return { ok: false, error: 'The WinApp CLI returned no WinUI templates.' };
	}

	return {
		ok: true,
		value: {
			templates,
			templateVersion: typeof json.TemplateVersion === 'string' && json.TemplateVersion.length > 0
				? json.TemplateVersion
				: undefined
		}
	};
}

/** Parse the payload of a `winapp new --json` scaffold run. */
export function parseScaffoldResult(output: string): ScaffoldResult | undefined {
	const json = extractJsonObject(output);
	if (!json) {
		return undefined;
	}

	return {
		created: json.Created === true,
		template: typeof json.Template === 'string' ? json.Template : undefined,
		name: typeof json.Name === 'string' ? json.Name : undefined,
		projectPath: typeof json.Path === 'string' ? json.Path : undefined,
		error: typeof json.Error === 'string' && json.Error.trim().length > 0 ? json.Error.trim() : undefined,
		templateVersion: typeof json.TemplateVersion === 'string' ? json.TemplateVersion : undefined
	};
}

/**
 * Extract the JSON object from captured CLI output. Progress or warning text can
 * precede the payload on stderr, which the capture helper interleaves into the
 * same buffer, so anchor on the first `{` rather than requiring silence.
 */
function extractJsonObject(output: string): Record<string, unknown> | undefined {
	if (!output) {
		return undefined;
	}

	const start = output.indexOf('{');
	if (start < 0) {
		return undefined;
	}

	// Walk back from the end so trailing output after the payload is ignored too.
	for (let end = output.lastIndexOf('}'); end > start; end = output.lastIndexOf('}', end - 1)) {
		try {
			const parsed = JSON.parse(output.slice(start, end + 1));
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			// Not a complete object at this boundary — try the previous '}'.
		}
	}

	return undefined;
}

/** True when the template scaffolds a whole project (rather than a file into one). */
export function isProjectTemplate(template: WinUiTemplate): boolean {
	return !template.type || template.type.toLowerCase() !== 'item';
}

/**
 * Order templates for the picker: the CLI's own default first, then the rest
 * alphabetically by display name so the list is stable between runs.
 */
export function sortTemplates(templates: WinUiTemplate[]): WinUiTemplate[] {
	return [...templates].sort((a, b) => {
		const aIsDefault = a.shortName === DEFAULT_TEMPLATE_SHORT_NAME;
		const bIsDefault = b.shortName === DEFAULT_TEMPLATE_SHORT_NAME;
		if (aIsDefault !== bIsDefault) {
			return aIsDefault ? -1 : 1;
		}
		return a.displayName.localeCompare(b.displayName);
	});
}

/**
 * Render a template's `Tags` value (a slash-delimited string such as
 * `Windows/WinUI/Desktop/XAML`) for the picker's detail line.
 */
export function formatTemplateTags(tags: string): string {
	return tags
		.split('/')
		.map((tag) => tag.trim())
		.filter((tag) => tag.length > 0)
		.join(' · ');
}

/**
 * Map a `winapp new` exit code and JSON payload onto a user-facing message. The
 * CLI's own `Error` text is preferred when present: it is already actionable and
 * keeps the extension from tracking the CLI's wording.
 */
export function describeNewFailure(
	exitCode: number | null,
	result: ScaffoldResult | undefined
): string {
	const detail = result?.error;
	if (detail) {
		return detail;
	}

	switch (exitCode) {
		case NEW_EXIT.invalidArgs:
			return 'The WinApp CLI rejected the app name or output directory.';
		case NEW_EXIT.sdkMissing:
			return 'The .NET SDK is required to create a WinUI app.';
		case NEW_EXIT.packFailed:
			return 'Failed to install the WinUI template pack. Check your network and NuGet feed configuration.';
		case NEW_EXIT.scaffoldFailed:
			return 'Failed to scaffold the app.';
		default:
			return 'Failed to create the app.';
	}
}

/** True when the failure is a missing or too-old .NET SDK, which has its own call to action. */
export function isSdkMissingExit(exitCode: number | null): boolean {
	return exitCode === NEW_EXIT.sdkMissing;
}

/** Outcome of one `winapp new --list --json` attempt. */
export interface TemplateListAttempt {
	cancelled: boolean;
	code: number | null;
	parsed?: { ok: true; value: TemplateListResult } | { ok: false; error: string };
}

/**
 * A template listing plus whether this run had to install the pack.
 * `freshlyInstalled` suppresses the installed-versus-latest question, since both
 * answers would name the same version.
 */
export interface TemplateLoad {
	list: TemplateListResult;
	freshlyInstalled: boolean;
}

/**
 * Everything {@link loadWinUiTemplates} needs from the outside world. An
 * interface so the state machine is testable without spawning the CLI or
 * installing a pack, matching `SignFlowAdapter` in `sign-utils.ts`.
 */
export interface TemplateLoadAdapter {
	/** Run one attempt, returning its outcome; the caller decides what to report. */
	listTemplates(
		templateVersion: 'latest' | 'installed' | undefined,
		progressMessage: string
	): Promise<TemplateListAttempt>;

	/** Report a failure to the user. */
	reportFailure(message: string, sdkMissing: boolean): Promise<void>;
}

/**
 * Load the WinUI template list, installing the pack only when necessary. Probes
 * `--template-version installed` first, since the unpinned listing hits the feed
 * on every run. Only exit 4 (no pack) falls through to the unpinned retry.
 *
 * @param templateVersion When `'latest'`, installs the newest template pack
 *                        before listing. Omitted on the normal path.
 * @returns The parsed list, or `undefined` when the run failed or was cancelled
 *          (the failure has already been reported to the user).
 */
export async function loadWinUiTemplates(
	adapter: TemplateLoadAdapter,
	templateVersion?: 'latest'
): Promise<TemplateLoad | undefined> {
	if (templateVersion !== 'latest') {
		const local = await adapter.listTemplates('installed', 'Loading WinUI templates...');
		if (local.cancelled) {
			return undefined;
		}
		if (local.parsed?.ok && local.code === 0) {
			return { list: local.parsed.value, freshlyInstalled: false };
		}
		if (local.code !== NEW_EXIT.packFailed) {
			// Only "no pack installed" justifies retrying unpinned; anything else
			// fails identically while the retry misleadingly announces itself as
			// "Installing the WinUI templates...". Prefer the CLI's own wording,
			// which distinguishes "no SDK" from "SDK too old".
			const detail = local.parsed && !local.parsed.ok
				? local.parsed.error
				: describeNewFailure(local.code, undefined);
			await adapter.reportFailure(detail, isSdkMissingExit(local.code));
			return undefined;
		}
		// Exit 4 from the `installed` probe means no pack is installed yet: fall
		// through to the unpinned listing, which installs the latest on demand.
	}

	const result = await adapter.listTemplates(
		templateVersion,
		templateVersion === 'latest'
			? 'Installing the latest WinUI templates...'
			: 'Installing the WinUI templates...'
	);

	if (result.cancelled) {
		return undefined;
	}

	if (!result.parsed?.ok || result.code !== 0) {
		const message = result.parsed && !result.parsed.ok
			? result.parsed.error
			: 'Failed to load the WinUI templates.';
		await adapter.reportFailure(message, isSdkMissingExit(result.code));
		return undefined;
	}

	// Reaching the unpinned listing on the default path means nothing was
	// installed and the CLI has just fetched the newest pack.
	return { list: result.parsed.value, freshlyInstalled: templateVersion !== 'latest' };
}

/**
 * Build the argument list for a `winapp new` scaffold run. `--use-defaults` and
 * `--json` are always passed; the CLI forces the former under the latter, and
 * passing it explicitly documents that this run must never prompt.
 */
export function buildNewArgs(options: {
	template: string;
	name: string;
	output: string;
	force?: boolean;
	templateVersion?: 'latest' | 'installed';
}): string[] {
	const args = [
		'new',
		'--template', options.template,
		'--name', options.name,
		'--output', options.output,
		'--use-defaults',
		'--json'
	];

	if (options.force) {
		args.push('--force');
	}

	if (options.templateVersion) {
		args.push('--template-version', options.templateVersion);
	}

	return args;
}

/** Build the argument list for a `winapp new --list` run. */
export function buildListArgs(templateVersion?: 'latest' | 'installed'): string[] {
	const args = ['new', '--list', '--json'];
	if (templateVersion) {
		args.push('--template-version', templateVersion);
	}
	return args;
}
