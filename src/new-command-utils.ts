import { extractJsonObject } from './winapp-cli-utils';

/**
 * Pure helpers backing the `winapp.new` command, kept free of the VS Code API so
 * they can be unit-tested directly. Several behaviours intentionally mirror
 * `NewCommand.cs` in microsoft/winappcli; the CLI symbol is named where so.
 */

/** Default project name, matching the CLI's `DefaultNameFor` for project templates. */
export const DEFAULT_PROJECT_NAME = 'WinUIApp';

/** A template entry as returned by `winapp new --list --json`. */
export interface WinUiTemplate {
	shortName: string;
	aliases: string[];
	displayName: string;
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
 * True when the CLI refused because the output directory already has files in
 * it, which is the one failure the user can retry with `--force`.
 */
export function isNonEmptyOutputFailure(
	exitCode: number | null,
	result: ScaffoldResult | undefined
): boolean {
	return exitCode === NEW_EXIT.invalidArgs
		&& (result?.error?.includes('--force') ?? false);
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
				: shortName
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
 * Describe a `winapp new` failure using the CLI's own words wherever possible.
 * The JSON `Error` field is preferred; if the CLI died before emitting one,
 * whatever it printed is the only diagnostic that exists, so pass that through.
 *
 * @param output Raw stdout+stderr, used only when there is no JSON payload.
 */
export function describeNewFailure(
	exitCode: number | null,
	result: ScaffoldResult | undefined,
	output?: string
): string {
	const detail = result?.error?.trim();
	if (detail) {
		return detail;
	}

	if (!result) {
		const raw = output?.trim();
		if (raw) {
			return raw;
		}
	}

	return `The WinApp CLI failed to create the app (exit code ${exitCode ?? 'unknown'}).`;
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
