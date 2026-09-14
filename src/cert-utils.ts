/**
 * Pure helpers for the `winapp cert generate` flow.
 *
 * No VS Code dependency, so the argument construction and output parsing can be
 * unit tested directly.
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

	return args;
}

/**
 * Matches the CLI's "already exists" failure.
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
	const match = /certificate file already exists:\s*([^"\r\n]+)/i.exec(output);
	return match?.[1].trim() || undefined;
}

/** Extract a human-readable error message from CLI output. */
export function parseCertErrorMessage(output: string): string | undefined {
	// The first non-empty line. This runs only after a non-zero exit, so any
	// output is more useful to the user than the generic "see the output
	// channel" message. Stripping the CLI's leading status glyph is
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
	| { kind: 'success'; certificatePath: string }
	| { kind: 'already-exists'; existingPath?: string }
	| { kind: 'cancelled' }
	| { kind: 'failed'; message?: string };

/**
 * Classify the result of a `cert generate` run.
 *
 * "Already exists" is separated from other failures because it is recoverable
 * in the UI (offer to overwrite) rather than simply reported.
 *
 * @param expectedPath Where the certificate was asked to be written. The CLI is
 *   run without `--json`, so success is taken from the exit code and the path is
 *   the one the caller specified rather than one parsed back out of the output.
 */
export function decideCertGenerateOutcome(
	code: number | null,
	output: string,
	expectedPath: string,
	cancelled?: boolean
): CertGenerateOutcome {
	if (cancelled) {
		return { kind: 'cancelled' };
	}

	if (code === 0) {
		return { kind: 'success', certificatePath: expectedPath };
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

	// Backslash escapes are an RFC 2253 feature that the packaging schema's
	// ST_Publisher_2010_v2 pattern does not accept, so a publisher containing
	// one can never match a manifest. Rejecting it here keeps this validator
	// consistent with manifest-validator.ts rather than steering the user
	// towards a value the manifest editor would flag as an error.
	if (trimmed.includes('\\')) {
		return 'Remove the backslash — Windows packaging does not accept escape sequences in a publisher name.';
	}

	if (!trimmed.includes('=')) {
		// A bare name is wrapped as CN=<name> by the CLI, so an unescaped comma
		// would be read as an RDN separator and produce a malformed DN.
		if (trimmed.includes(',')) {
			return 'Remove the comma, or enter a full distinguished name (for example CN=Contoso Inc, O=Contoso).';
		}
		return undefined;
	}

	const components = trimmed.split(',');
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
		certificatePath: string,
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
			outcome = { kind: 'success', certificatePath: existingPath };
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

	result.certificatePath = outcome.certificatePath;
	result.created = created;

	if (install) {
		await adapter.installCertificate(outcome.certificatePath);
		result.installed = true;
	}

	// Reported for both branches: the install is handed to another window, so
	// this is the only place the certificate's location surfaces in VS Code.
	await adapter.reportSuccess(outcome.certificatePath, { created, installing: result.installed });

	return result;
}

// ──────────────────────────────────────────────────────
// Publisher source selection
// ──────────────────────────────────────────────────────

/**
 * Source of the publisher for a generated certificate: either a manifest the
 * CLI extracts it from, or a name the user typed because there is no manifest.
 */
export type CertPublisherSource =
	| { kind: 'manifest'; manifestPath: string }
	| { kind: 'publisher'; publisher: string };

export interface CertPublisherSourceAdapter {
	/** Locate candidate manifests. `undefined` means the search was cancelled. */
	findManifests(): Promise<string[] | undefined>;

	/** Ask which manifest to use. `undefined` means the user dismissed the picker. */
	pickManifest(manifestPaths: string[]): Promise<string | undefined>;

	/** Ask for a publisher by hand. `undefined` means the user dismissed the prompt. */
	promptPublisher(): Promise<string | undefined>;
}

/**
 * Decide where the certificate's publisher comes from.
 *
 * The certificate's publisher must match the manifest's `Identity/@Publisher`
 * or the resulting package will not install, so a manifest is always preferred
 * and passed explicitly via `--manifest`. Relying on the CLI's working-directory
 * inference instead is unsafe: with no manifest to find it silently falls back
 * to the current user name, producing a certificate that can never match.
 *
 * @returns The resolved source, or `undefined` if the user cancelled.
 */
export async function resolveCertPublisherSourceDecision(
	adapter: CertPublisherSourceAdapter
): Promise<CertPublisherSource | undefined> {
	const manifestPaths = await adapter.findManifests();

	if (!manifestPaths) {
		return undefined;
	}

	if (manifestPaths.length === 1) {
		return { kind: 'manifest', manifestPath: manifestPaths[0] };
	}

	if (manifestPaths.length > 1) {
		const picked = await adapter.pickManifest(manifestPaths);
		return picked ? { kind: 'manifest', manifestPath: picked } : undefined;
	}

	// No manifest: ask rather than letting the CLI fall back to the user name.
	const publisher = (await adapter.promptPublisher())?.trim();
	return publisher ? { kind: 'publisher', publisher } : undefined;
}