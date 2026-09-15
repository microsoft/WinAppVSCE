/**
 * Pure helpers for the `winapp cert generate` flow.
 *
 * No VS Code dependency, so the argument construction and output parsing can be
 * unit tested directly.
 */

import * as path from 'path';
import { parseWinappErrorMessage } from './winapp-cli-utils';

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

export type CertGenerateOutcome =
	| { kind: 'success'; certificatePath: string }
	| { kind: 'already-exists'; existingPath: string }
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
 *   The same applies to a collision: the file the CLI refused to overwrite is by
 *   definition the one it was told to write.
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
		return { kind: 'already-exists', existingPath: expectedPath };
	}

	return { kind: 'failed', message: parseWinappErrorMessage(output) };
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

	/** Warn that a certificate already exists and ask what to do. */
	confirmOverwrite(existingPath: string): Promise<OverwriteChoice>;

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
	reportKeptExisting(existingPath: string): void;
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
		const choice = await adapter.confirmOverwrite(existingPath);

		if (choice === 'reuse') {
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
				`the certificate at ${outcome.existingPath} could not be replaced`
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
	/**
	 * Locate the project's primary manifest, or `undefined` when it has none.
	 *
	 * Only the manifest the CLI itself would use qualifies; see
	 * `selectCanonicalManifest`.
	 */
	findCanonicalManifest(): Promise<string | undefined>;

	/** Ask for a publisher by hand. `undefined` means the user dismissed the prompt. */
	promptPublisher(): Promise<string | undefined>;
}

/**
 * Manifest file names that MSBuild treats as a project's primary manifest.
 *
 * Variants such as `Package.Store.appxmanifest` are deliberately excluded: they
 * carry a different `Identity/@Publisher` (the Store-assigned one), so they are
 * a real choice the user has to make rather than a name to guess at.
 */
const CANONICAL_MANIFEST_NAMES = new Set(['package.appxmanifest', 'appxmanifest.xml']);

/** Compare two paths for equality, case-insensitively as Windows does. */
function pathsEqual(left: string, right: string): boolean {
	return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

/**
 * Pick the project's primary manifest when that choice is unambiguous.
 *
 * Only a canonically named manifest sitting directly in the project directory
 * qualifies. That is the file MSBuild packages by default, so selecting it
 * matches what the CLI would have inferred from the working directory — the
 * prompt would only be asking the user to confirm the obvious.
 *
 * Manifests in subdirectories never qualify, which keeps template and
 * code-generator copies (for example `ProjectGenerator/Template/...`) from being
 * mistaken for the project's own manifest.
 *
 * @returns The manifest to use, or `undefined` when the user should be asked.
 */
export function selectCanonicalManifest(
	manifestPaths: string[],
	projectDir: string
): string | undefined {
	const canonical = manifestPaths.filter(
		manifestPath =>
			pathsEqual(path.dirname(manifestPath), projectDir) &&
			CANONICAL_MANIFEST_NAMES.has(path.basename(manifestPath).toLowerCase())
	);

	return canonical.length === 1 ? canonical[0] : undefined;
}

/**
 * Decide where the certificate's publisher comes from.
 *
 * The certificate's publisher must match the manifest's `Identity/@Publisher`
 * or the resulting package will not install, so the project's primary manifest
 * is preferred and passed explicitly via `--manifest`. Relying on the CLI's
 * working-directory inference instead is unsafe: with no manifest to find it
 * silently falls back to the current user name, producing a certificate that
 * can never match.
 *
 * When the project has no primary manifest the user is asked for a publisher
 * outright. No other manifest is offered as a substitute -- a Store variant, a
 * generator template, or a sibling project's manifest carries a different
 * publisher, and the CLI would not have considered any of them either.
 *
 * @returns The resolved source, or `undefined` if the user cancelled.
 */
export async function resolveCertPublisherSourceDecision(
	adapter: CertPublisherSourceAdapter
): Promise<CertPublisherSource | undefined> {
	const manifestPath = await adapter.findCanonicalManifest();
	if (manifestPath) {
		return { kind: 'manifest', manifestPath };
	}

	// No usable manifest: ask rather than letting the CLI fall back to the user
	// name, which would silently produce a certificate that matches nothing.
	const publisher = (await adapter.promptPublisher())?.trim();
	return publisher ? { kind: 'publisher', publisher } : undefined;
}