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

/**
 * File-dialog filter for certificate pickers.
 *
 * PFX only, deliberately: the CLI loads certificates with
 * `X509CertificateLoader.LoadPkcs12FromFile`, so a `.cer` is rejected with a raw
 * DER decoding error even though `cert install --help` advertises CER support
 * (microsoft/winappCli#838). Offering `.cer` here only leads users into that
 * error, so do not re-add it until the CLI actually accepts one.
 */
export const CERTIFICATE_DIALOG_FILTER: Record<string, string[]> = {
	'Certificates': ['pfx']
};

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

	// Fall back to the first non-empty line. This runs only after a non-zero
	// exit, so any output is more useful to the user than the generic "see the
	// output channel" message. Stripping the CLI's leading status glyph is
	// normalization, not a match condition: plain-text errors without a glyph
	// must still be reported.
	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}
		const cleaned = line.replace(/^(?:\[ERROR\]\s*-\s*|[❌✖✗⚠]\s*)/u, '').trim();
		if (cleaned) {
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
 * Extract `Identity/@Publisher` from manifest XML.
 *
 * Used to verify what the CLI actually produced: `cert generate --manifest`
 * silently falls back to the current user name when it cannot parse the
 * manifest (exit 0, no warning), which yields a certificate that can never
 * match the package. See microsoft/winappCli#839.
 */
export function parseManifestPublisher(xml: string): string | undefined {
	// Match the Identity element's Publisher attribute specifically; other
	// elements (e.g. PublisherDisplayName) must not be picked up.
	const identity = /<(?:\w+:)?Identity\b[^>]*>/i.exec(xml);
	if (!identity) {
		return undefined;
	}

	const publisher = /\bPublisher\s*=\s*"([^"]*)"/i.exec(identity[0]);
	return publisher?.[1]?.trim() || undefined;
}

/**
 * Compare two distinguished names for practical equality.
 *
 * Comparison ignores case and the optional whitespace around `=` and `,`, so
 * `CN=Contoso, O=Contoso Ltd` and `cn=Contoso,o=Contoso Ltd` are the same
 * publisher. It is deliberately not a full RFC 4514 parser: this only needs to
 * be good enough to catch the CLI having ignored the manifest entirely.
 */
export function publishersMatch(a: string, b: string): boolean {
	const normalize = (value: string) =>
		value
			.trim()
			.replace(/\s*=\s*/g, '=')
			.replace(/\s*,\s*/g, ',')
			.toLowerCase();

	return normalize(a) === normalize(b);
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

// ──────────────────────────────────────────────────────
// Certificate generation flow
//
// The VS Code wiring (progress, notifications, elevation) lives in
// extension.ts; this section owns only the decision logic and delegates UI
// operations through an injectable adapter interface.
// ──────────────────────────────────────────────────────

/** What the user chose when told a certificate already exists. */
export type OverwriteChoice = 'overwrite' | 'reuse' | 'dismiss';

export interface CertGenerateFlowAdapter {
	/** Run `cert generate` with the given `--if-exists` mode and classify the result. */
	runGenerate(ifExists: CertIfExists): Promise<CertGenerateOutcome>;

	/**
	 * Warn that a certificate already exists and ask what to do.
	 *
	 * `canReuse` is false when the CLI did not tell us where the existing
	 * certificate is, in which case reusing it cannot be offered.
	 */
	confirmOverwrite(existingPath: string | undefined, canReuse: boolean): Promise<OverwriteChoice>;

	/** Install the certificate into the machine store (requires elevation). */
	installCertificate(certificatePath: string): Promise<void>;

	/** Report the certificate that is now available. */
	reportSuccess(
		result: CertGenerateResult,
		context: { created: boolean; installing: boolean }
	): Promise<void>;

	/** Report that nothing was produced. */
	reportFailure(message?: string): void;

	/** Tell the user the existing certificate was left alone and nothing else happened. */
	reportKeptExisting(existingPath: string | undefined): void;
}

export interface CertGenerateFlowResult {
	/** The certificate the user ended up with, if any. */
	certificatePath: string | undefined;
	/** False when an existing certificate was reused instead of generated. */
	created: boolean;
	/** Whether the elevated install step ran. */
	installed: boolean;
	/** Whether the "already exists" warning was shown. */
	overwritePrompted: boolean;
}

/**
 * Run the certificate-generation flow.
 *
 * Generation is attempted with `--if-exists error` first so an existing
 * certificate is surfaced to the user rather than silently replaced. The CLI is
 * the authority on whether the output path is taken, so the collision is handled
 * reactively instead of pre-checking the path here.
 *
 * @param install Whether the user asked for the certificate to be installed as
 *   well. The install is a separate elevated step, so generation failures are
 *   reported in VS Code rather than scrolling past in a UAC window.
 */
export async function executeCertGenerateFlow(
	adapter: CertGenerateFlowAdapter,
	install: boolean
): Promise<CertGenerateFlowResult> {
	const result: CertGenerateFlowResult = {
		certificatePath: undefined,
		created: false,
		installed: false,
		overwritePrompted: false
	};

	let outcome = await adapter.runGenerate('error');
	let created = true;

	if (outcome.kind === 'already-exists') {
		result.overwritePrompted = true;
		const existingPath = outcome.existingPath;
		const choice = await adapter.confirmOverwrite(existingPath, existingPath !== undefined);

		if (choice === 'reuse' && existingPath) {
			outcome = { kind: 'success', result: { certificatePath: existingPath } };
			created = false;
		} else if (choice === 'overwrite') {
			outcome = await adapter.runGenerate('overwrite');
		} else {
			// Dismissing must not look like a silent no-op: the user asked for a
			// certificate and is getting neither a new one nor an install.
			adapter.reportKeptExisting(existingPath);
			return result;
		}
	}

	switch (outcome.kind) {
		case 'cancelled':
			return result;
		case 'already-exists':
			// The overwrite retry hit the same condition, so something other than
			// our own run is holding the path.
			adapter.reportFailure(
				`the certificate at ${outcome.existingPath ?? 'the output path'} could not be replaced`
			);
			return result;
		case 'failed':
			adapter.reportFailure(outcome.message);
			return result;
	}

	result.certificatePath = outcome.result.certificatePath;
	result.created = created;

	if (install) {
		await adapter.installCertificate(outcome.result.certificatePath);
		result.installed = true;
	}

	// Reported for both branches: the install is handed to another window, so
	// this is the only place the certificate's location surfaces in VS Code.
	await adapter.reportSuccess(outcome.result, { created, installing: install });

	return result;
}
