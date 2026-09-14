/**
 * Pure helpers for the `winapp cert generate` flow.
 *
 * No VS Code dependency, so the argument construction, output parsing and
 * redaction rules can be unit tested directly.
 */

/**
 * Glob patterns for app manifests within a project directory.
 *
 * `AppxManifest.xml` is matched with a character class rather than a plain
 * lowercase name because `vscode.workspace.findFiles` is case-sensitive on
 * non-Windows hosts and the file is conventionally written `AppxManifest.xml`
 * or `Package.appxmanifest`.
 */
export const MANIFEST_GLOBS = ['**/*.appxmanifest', '**/[Aa]ppx[Mm]anifest.xml'];

/** Placeholder substituted for secrets in echoed commands and captured output. */
export const REDACTED = '***';

/** Behaviour when the output certificate file already exists. */
export type CertIfExists = 'error' | 'overwrite';

export interface CertGenerateArgOptions {
	/** Manifest to extract the publisher from. Mutually exclusive with `publisher`. */
	manifestPath?: string;
	/** Explicit publisher DN or bare name, used when no manifest is available. */
	publisher?: string;
	/** Defaults to `'error'`, matching the CLI. */
	ifExists?: CertIfExists;
}

/**
 * Build the argument array for `winapp cert generate`.
 *
 * Arguments are returned as an array (never a shell string) so the caller can
 * spawn with `shell: false` and keep argument boundaries intact.
 *
 * `--install` is deliberately never emitted: the extension runs generate
 * un-elevated so failures are visible in VS Code, then elevates a separate
 * `cert install`. See the architecture notes on the elevated path.
 */
export function buildCertGenerateArgs(options: CertGenerateArgOptions = {}): string[] {
	const args = ['cert', 'generate'];

	// The manifest is the reliable source of the publisher, because the
	// certificate's publisher must match Identity/@Publisher for the package to
	// install. An explicit publisher is only used when no manifest was found.
	if (options.manifestPath) {
		args.push('--manifest', options.manifestPath);
	} else if (options.publisher) {
		args.push('--publisher', options.publisher);
	}

	args.push('--if-exists', options.ifExists ?? 'error');
	args.push('--json');

	return args;
}

/**
 * Mask the value following `--password` so a command echo never reveals it.
 *
 * The extension does not pass `--password` today, but the echo path is shared
 * and must not become a leak the moment it does.
 */
export function redactPasswordArgs(args: string[]): string[] {
	const redacted = [...args];
	for (let i = 0; i < redacted.length; i++) {
		if (redacted[i] === '--password' && i + 1 < redacted.length) {
			redacted[i + 1] = REDACTED;
			i++;
		}
	}
	return redacted;
}

/**
 * Mask the `password` field in CLI JSON output.
 *
 * `cert generate --json` echoes the certificate password back in its result
 * payload, so streaming raw CLI output to the output channel would re-leak the
 * secret even though the command itself was spawned with an argument array.
 */
export function redactPasswordInOutput(output: string): string {
	return output.replace(
		/("password"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
		`$1"${REDACTED}"`
	);
}

export interface CertGenerateResult {
	certificatePath: string;
	publisher?: string;
	subjectName?: string;
	publicCertificatePath?: string;
}

/**
 * Extract the first JSON object from CLI output.
 *
 * The CLI prints a bare JSON document under `--json`, but progress or warning
 * lines can still precede it on stderr, so the object is located rather than
 * assumed to be the whole payload.
 */
function parseJsonObject(output: string): Record<string, unknown> | undefined {
	const start = output.indexOf('{');
	const end = output.lastIndexOf('}');
	if (start === -1 || end === -1 || end < start) {
		return undefined;
	}

	try {
		const parsed: unknown = JSON.parse(output.slice(start, end + 1));
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// Not valid JSON — callers fall back to the raw output.
	}

	return undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Parse a successful `cert generate --json` payload. */
export function parseCertGenerateResult(output: string): CertGenerateResult | undefined {
	const json = parseJsonObject(output);
	const certificatePath = asString(json?.certificatePath);
	if (!certificatePath) {
		return undefined;
	}

	return {
		certificatePath,
		publisher: asString(json?.publisher),
		subjectName: asString(json?.subjectName),
		publicCertificatePath: asString(json?.publicCertificatePath)
	};
}

/**
 * Matches the CLI's "already exists" failure, in both its JSON form
 * (`{"error":"Certificate file already exists: …"}`) and its plain-text form.
 */
const ALREADY_EXISTS_RE = /certificate file already exists/i;

/** Whether the CLI failed because the output certificate already exists. */
export function isAlreadyExistsError(output: string): boolean {
	return ALREADY_EXISTS_RE.test(output);
}

/**
 * Pull the certificate path out of an "already exists" message so the user can
 * be told *which* file is about to be overwritten.
 */
export function parseExistingCertificatePath(output: string): string | undefined {
	// Match against the decoded error message when the CLI emitted JSON, so
	// Windows path separators are not reported back with doubled backslashes.
	const source = parseCertErrorMessage(output) ?? output;
	const match = /certificate file already exists:\s*([^"\r\n]+)/i.exec(source);
	return match?.[1].trim() || undefined;
}

/** Extract a human-readable error message from CLI output. */
export function parseCertErrorMessage(output: string): string | undefined {
	const fromJson = asString(parseJsonObject(output)?.error);
	if (fromJson) {
		return fromJson;
	}

	// Fall back to the first non-empty line that looks like an error, stripping
	// the CLI's leading status glyphs.
	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}
		const cleaned = line.replace(/^(?:\[ERROR\]\s*-\s*|[❌✖✗⚠]\s*)/u, '').trim();
		if (cleaned && cleaned !== line) {
			return cleaned;
		}
	}

	return undefined;
}

export type CertGenerateOutcome =
	| { kind: 'success'; result: CertGenerateResult }
	| { kind: 'already-exists'; existingPath?: string }
	| { kind: 'cancelled' }
	| { kind: 'failed'; message?: string };

/**
 * Classify the result of a `cert generate` run.
 *
 * "Already exists" is separated from other failures because it is recoverable
 * in the UI (offer to overwrite) rather than simply reported.
 */
export function decideCertGenerateOutcome(
	code: number | null,
	output: string,
	cancelled?: boolean
): CertGenerateOutcome {
	if (cancelled) {
		return { kind: 'cancelled' };
	}

	if (code === 0) {
		const result = parseCertGenerateResult(output);
		if (result) {
			return { kind: 'success', result };
		}
		// Exit 0 without a parsable payload means the certificate may well exist
		// but we cannot name it, so treat it as a failure rather than reporting
		// a success we cannot substantiate.
		return { kind: 'failed', message: parseCertErrorMessage(output) };
	}

	if (isAlreadyExistsError(output)) {
		return { kind: 'already-exists', existingPath: parseExistingCertificatePath(output) };
	}

	return { kind: 'failed', message: parseCertErrorMessage(output) };
}

/**
 * Validate a publisher entered by hand when the project has no manifest.
 *
 * Accepts either a bare name (the CLI wraps it as `CN=<name>`) or a full
 * distinguished name. Returns an error message for the input box, or
 * `undefined` when the value is acceptable.
 */
export function validatePublisherInput(value: string): string | undefined {
	const trimmed = value.trim();

	if (!trimmed) {
		return 'Enter a publisher name, for example Contoso or CN=Contoso.';
	}

	if (!trimmed.includes('=')) {
		// A bare name is wrapped as CN=<name> by the CLI, so an unescaped comma
		// would be read as an RDN separator and produce a malformed DN.
		if (trimmed.includes(',')) {
			return 'Remove the comma, or enter a full distinguished name and escape it as \\, (for example CN=Contoso\\, Inc).';
		}
		return undefined;
	}

	// Split on commas that are not escaped as "\,".
	const components = trimmed.split(/(?<!\\),/);
	for (const component of components) {
		const part = component.trim();
		if (!part) {
			return 'Remove the empty name component — each part of a distinguished name must be KEY=VALUE.';
		}

		const separator = part.indexOf('=');
		if (separator === -1) {
			return `Write "${part}" as KEY=VALUE, for example CN=${part}.`;
		}

		const key = part.slice(0, separator).trim();
		const componentValue = part.slice(separator + 1).trim();
		if (!key) {
			return 'Add the attribute name before "=", for example CN=Contoso.';
		}
		if (!componentValue) {
			return `Add a value after "${key}=", for example ${key}=Contoso.`;
		}
	}

	return undefined;
}
