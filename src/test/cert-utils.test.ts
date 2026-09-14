import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
	CERTIFICATE_DIALOG_FILTER,
	buildCertGenerateArgs,
	decideCertGenerateOutcome,
	executeCertGenerateFlow,
	isAlreadyExistsError,
	parseCertErrorMessage,
	parseExistingCertificatePath,
	resolveCertPublisherSourceDecision,
	validatePublisherInput,
	type CertGenerateFlowAdapter,
	type CertGenerateOutcome,
	type CertIfExists,
	type CertPublisherSourceAdapter,
	type OverwriteChoice
} from '../cert-utils';

/** Where the CLI writes by default, and therefore the path the flow expects. */
const EXPECTED_PATH = 'C:\\proj\\devcert.pfx';

/** A representative plain-text "already exists" failure. */
const ALREADY_EXISTS_TEXT =
	'❌ Certificate file already exists: C:\\proj\\devcert.pfx\nPlease specify a different output path or remove the existing file.';

describe('buildCertGenerateArgs', () => {
	test('prefers the manifest and never emits --publisher alongside it', () => {
		const args = buildCertGenerateArgs({
			manifestPath: 'C:\\proj\\Package.appxmanifest',
			publisher: 'CN=Ignored'
		});

		assert.deepEqual(args, [
			'cert',
			'generate',
			'--manifest',
			'C:\\proj\\Package.appxmanifest',
			'--if-exists',
			'error'
		]);
	});

	test('falls back to --publisher when there is no manifest', () => {
		const args = buildCertGenerateArgs({ publisher: 'CN=Contoso, O=Contoso Ltd' });

		assert.deepEqual(args, [
			'cert',
			'generate',
			'--publisher',
			'CN=Contoso, O=Contoso Ltd',
			'--if-exists',
			'error'
		]);
	});

	test('defaults --if-exists to error and honours overwrite', () => {
		assert.deepEqual(buildCertGenerateArgs({ publisher: 'Contoso' }).slice(-2), [
			'--if-exists',
			'error'
		]);

		const overwrite = buildCertGenerateArgs({ publisher: 'Contoso', ifExists: 'overwrite' });
		assert.equal(overwrite[overwrite.indexOf('--if-exists') + 1], 'overwrite');
	});

	test('never requests --json, so the CLI never echoes the password back', () => {
		assert.ok(!buildCertGenerateArgs({ publisher: 'Contoso' }).includes('--json'));
	});

	test('never emits --install, because generation stays un-elevated', () => {
		const args = buildCertGenerateArgs({ manifestPath: 'm.appxmanifest', ifExists: 'overwrite' });
		assert.ok(!args.includes('--install'));
	});

	test('emits no publisher flags when neither source is known', () => {
		const args = buildCertGenerateArgs();
		assert.ok(!args.includes('--manifest'));
		assert.ok(!args.includes('--publisher'));
	});
});

describe('isAlreadyExistsError / parseExistingCertificatePath', () => {
	test('detects the plain-text form and extracts the path', () => {
		assert.ok(isAlreadyExistsError(ALREADY_EXISTS_TEXT));
		assert.equal(parseExistingCertificatePath(ALREADY_EXISTS_TEXT), 'C:\\proj\\devcert.pfx');
	});

	test('extracts the path when no status glyph precedes it', () => {
		const output = 'Certificate file already exists: C:\\proj\\devcert.pfx';
		assert.ok(isAlreadyExistsError(output));
		assert.equal(parseExistingCertificatePath(output), 'C:\\proj\\devcert.pfx');
	});

	test('does not fire on unrelated failures', () => {
		assert.equal(isAlreadyExistsError('❌ Invalid publisher'), false);
		assert.equal(parseExistingCertificatePath('❌ Invalid publisher'), undefined);
	});
});

describe('parseCertErrorMessage', () => {
	test('strips the CLI status glyph from plain-text errors', () => {
		assert.equal(parseCertErrorMessage('❌ Invalid publisher format'), 'Invalid publisher format');
	});

	test('reports plain-text errors that carry no status glyph', () => {
		assert.equal(
			parseCertErrorMessage('Certificate file already exists: C:\\proj\\devcert.pfx'),
			'Certificate file already exists: C:\\proj\\devcert.pfx'
		);
	});

	test('skips leading blank lines', () => {
		assert.equal(parseCertErrorMessage('\n\n  \nSomething broke\n'), 'Something broke');
	});

	test('returns undefined when there is no output to report', () => {
		assert.equal(parseCertErrorMessage(''), undefined);
		assert.equal(parseCertErrorMessage('   \n\n  '), undefined);
	});
});

describe('decideCertGenerateOutcome', () => {
	test('cancellation wins over the exit code', () => {
		assert.deepEqual(decideCertGenerateOutcome(0, '', EXPECTED_PATH, true), { kind: 'cancelled' });
		assert.deepEqual(decideCertGenerateOutcome(null, '', EXPECTED_PATH, true), { kind: 'cancelled' });
	});

	test('exit 0 is a success reported at the path the caller asked for', () => {
		const outcome = decideCertGenerateOutcome(0, 'Development certificate generated', EXPECTED_PATH);
		assert.equal(outcome.kind, 'success');
		assert.equal(outcome.kind === 'success' ? outcome.certificatePath : undefined, EXPECTED_PATH);
	});

	test('exit 0 stays a success even when the CLI prints nothing parsable', () => {
		// The exit code is the authority, so a change in the CLI's human-readable
		// output cannot turn a successful generation into a reported failure.
		assert.equal(decideCertGenerateOutcome(0, 'done!', EXPECTED_PATH).kind, 'success');
	});

	test('an already-exists failure is reported separately so it can be retried', () => {
		const outcome = decideCertGenerateOutcome(1, ALREADY_EXISTS_TEXT, EXPECTED_PATH);
		assert.equal(outcome.kind, 'already-exists');
		assert.equal(
			outcome.kind === 'already-exists' ? outcome.existingPath : undefined,
			'C:\\proj\\devcert.pfx'
		);
	});

	test('other non-zero exits carry the error message through', () => {
		const outcome = decideCertGenerateOutcome(1, '❌ Invalid publisher', EXPECTED_PATH);
		assert.equal(outcome.kind, 'failed');
		assert.equal(outcome.kind === 'failed' ? outcome.message : undefined, 'Invalid publisher');
	});

	test('a null exit code with no output is a failure', () => {
		assert.equal(decideCertGenerateOutcome(null, '', EXPECTED_PATH).kind, 'failed');
	});
});

describe('validatePublisherInput', () => {
	test('accepts a bare name, which the CLI wraps as CN=<name>', () => {
		assert.equal(validatePublisherInput('Contoso'), undefined);
		assert.equal(validatePublisherInput('  Contoso  '), undefined);
	});

	test('accepts single and multi-component distinguished names', () => {
		assert.equal(validatePublisherInput('CN=Contoso'), undefined);
		assert.equal(validatePublisherInput('CN=Contoso, O=Contoso Ltd, C=US'), undefined);
	});

	test('rejects backslash escapes, which the packaging schema does not accept', () => {
		// ST_Publisher_2010_v2 has no escape sequences, so a publisher containing
		// one can never match a manifest. See manifest-validator.test.ts, which
		// pins the same rule for the manifest editor.
		assert.ok(validatePublisherInput('CN=Contoso\\, Inc, C=US'));
		assert.ok(validatePublisherInput('CN=A\\+B'));
	});

	test('rejects empty input', () => {
		assert.ok(validatePublisherInput(''));
		assert.ok(validatePublisherInput('   '));
	});

	test('rejects a bare name with an unescaped comma, which would split the DN', () => {
		assert.ok(validatePublisherInput('Contoso, Inc'));
	});

	test('rejects DN components that are not KEY=VALUE', () => {
		assert.ok(validatePublisherInput('CN=Contoso, Ltd'));
		assert.ok(validatePublisherInput('CN=Contoso, O='));
		assert.ok(validatePublisherInput('=Contoso'));
		assert.ok(validatePublisherInput('CN=Contoso,,C=US'));
	});
});

const GENERATED_PATH = 'C:\\proj\\devcert.pfx';

const EXISTING_PATH = 'C:\\proj\\existing.pfx';

interface FlowCalls {
	generateModes: CertIfExists[];
	installed: string[];
	successes: { certificatePath: string; created: boolean; installing: boolean }[];
	failures: (string | undefined)[];
	keptExisting: (string | undefined)[];
	confirmCanReuse: boolean[];
	/** Order of the delegated calls, so ordering guarantees can be asserted. */
	sequence: string[];
}

/**
 * Build a flow adapter that records every delegated call.
 *
 * `outcomes` is consumed one entry per `runGenerate`, so a test can script the
 * first attempt and the overwrite retry independently.
 */
function createFakeAdapter(
	outcomes: CertGenerateOutcome[],
	choice: OverwriteChoice = 'dismiss'
): { adapter: CertGenerateFlowAdapter; calls: FlowCalls } {
	const calls: FlowCalls = {
		generateModes: [],
		installed: [],
		successes: [],
		failures: [],
		keptExisting: [],
		confirmCanReuse: [],
		sequence: []
	};

	const queue = [...outcomes];

	const adapter: CertGenerateFlowAdapter = {
		runGenerate: async (ifExists) => {
			calls.generateModes.push(ifExists);
			calls.sequence.push('runGenerate');
			const next = queue.shift();
			assert.ok(next, 'runGenerate called more times than the test scripted');
			return next;
		},
		confirmOverwrite: async (_existingPath, canReuse) => {
			calls.confirmCanReuse.push(canReuse);
			calls.sequence.push('confirmOverwrite');
			return choice;
		},
		installCertificate: async (certificatePath) => {
			calls.installed.push(certificatePath);
			calls.sequence.push('installCertificate');
		},
		reportSuccess: async (certificatePath, context) => {
			calls.successes.push({ certificatePath, ...context });
			calls.sequence.push('reportSuccess');
		},
		reportFailure: (message) => {
			calls.failures.push(message);
			calls.sequence.push('reportFailure');
		},
		reportKeptExisting: (existingPath) => {
			calls.keptExisting.push(existingPath);
			calls.sequence.push('reportKeptExisting');
		}
	};

	return { adapter, calls };
}

describe('executeCertGenerateFlow', () => {
	test('generate-only success reports the certificate and installs nothing', async () => {
		const { adapter, calls } = createFakeAdapter([
			{ kind: 'success', certificatePath: GENERATED_PATH }
		]);

		const result = await executeCertGenerateFlow(adapter, false);

		assert.deepEqual(calls.generateModes, ['error']);
		assert.equal(result.certificatePath, GENERATED_PATH);
		assert.equal(result.created, true);
		assert.equal(result.installed, false);
		assert.equal(result.overwritePrompted, false);
		assert.deepEqual(calls.installed, []);
		assert.deepEqual(calls.successes, [
			{ certificatePath: GENERATED_PATH, created: true, installing: false }
		]);
	});

	test('generate-and-install installs and still reports where the cert landed', async () => {
		const { adapter, calls } = createFakeAdapter([
			{ kind: 'success', certificatePath: GENERATED_PATH }
		]);

		const result = await executeCertGenerateFlow(adapter, true);

		assert.equal(result.installed, true);
		assert.deepEqual(calls.installed, [GENERATED_PATH]);
		// The install runs in a separate elevated window, so the success
		// notification is the only in-VS-Code trace of the certificate path.
		assert.deepEqual(calls.successes, [
			{ certificatePath: GENERATED_PATH, created: true, installing: true }
		]);
	});

	test('overwrite retries generation with --if-exists overwrite', async () => {
		const { adapter, calls } = createFakeAdapter(
			[
				{ kind: 'already-exists', existingPath: EXISTING_PATH },
				{ kind: 'success', certificatePath: GENERATED_PATH }
			],
			'overwrite'
		);

		const result = await executeCertGenerateFlow(adapter, false);

		assert.deepEqual(calls.generateModes, ['error', 'overwrite']);
		assert.equal(result.overwritePrompted, true);
		assert.equal(result.created, true);
		assert.equal(result.certificatePath, GENERATED_PATH);
	});

	test('reusing an existing certificate skips generation but still installs it', async () => {
		const { adapter, calls } = createFakeAdapter(
			[{ kind: 'already-exists', existingPath: EXISTING_PATH }],
			'reuse'
		);

		const result = await executeCertGenerateFlow(adapter, true);

		// Only the first attempt ran: nothing was regenerated.
		assert.deepEqual(calls.generateModes, ['error']);
		assert.equal(result.created, false);
		assert.equal(result.certificatePath, EXISTING_PATH);
		// The user asked for an install, so declining to overwrite must not
		// silently drop the install as well.
		assert.deepEqual(calls.installed, [EXISTING_PATH]);
		assert.deepEqual(calls.successes, [
			{ certificatePath: EXISTING_PATH, created: false, installing: true }
		]);
	});

	test('dismissing the overwrite warning says so instead of failing silently', async () => {
		const { adapter, calls } = createFakeAdapter(
			[{ kind: 'already-exists', existingPath: EXISTING_PATH }],
			'dismiss'
		);

		const result = await executeCertGenerateFlow(adapter, true);

		assert.equal(result.certificatePath, undefined);
		assert.equal(result.installed, false);
		assert.deepEqual(calls.keptExisting, [EXISTING_PATH]);
		assert.deepEqual(calls.installed, []);
		assert.deepEqual(calls.successes, []);
		assert.deepEqual(calls.failures, []);
	});

	test('reuse is not offered when the CLI did not name the existing certificate', async () => {
		const { adapter, calls } = createFakeAdapter([{ kind: 'already-exists' }], 'dismiss');

		await executeCertGenerateFlow(adapter, false);

		assert.deepEqual(calls.confirmCanReuse, [false]);
		assert.deepEqual(calls.keptExisting, [undefined]);
	});

	test('a reuse choice without a known path does not fabricate one', async () => {
		const { adapter, calls } = createFakeAdapter([{ kind: 'already-exists' }], 'reuse');

		const result = await executeCertGenerateFlow(adapter, true);

		assert.equal(result.certificatePath, undefined);
		assert.deepEqual(calls.installed, []);
		assert.deepEqual(calls.successes, []);
	});

	test('cancellation is silent — it is the user stopping, not a failure', async () => {
		const { adapter, calls } = createFakeAdapter([{ kind: 'cancelled' }]);

		const result = await executeCertGenerateFlow(adapter, true);

		assert.equal(result.certificatePath, undefined);
		assert.deepEqual(calls.failures, []);
		assert.deepEqual(calls.successes, []);
		assert.deepEqual(calls.installed, []);
	});

	test('a failure is reported and never installed', async () => {
		const { adapter, calls } = createFakeAdapter([
			{ kind: 'failed', message: 'Invalid publisher' }
		]);

		const result = await executeCertGenerateFlow(adapter, true);

		assert.equal(result.certificatePath, undefined);
		assert.deepEqual(calls.failures, ['Invalid publisher']);
		assert.deepEqual(calls.installed, []);
	});

	test('an overwrite that still collides is reported rather than retried forever', async () => {
		const { adapter, calls } = createFakeAdapter(
			[
				{ kind: 'already-exists', existingPath: EXISTING_PATH },
				{ kind: 'already-exists', existingPath: EXISTING_PATH }
			],
			'overwrite'
		);

		const result = await executeCertGenerateFlow(adapter, false);

		assert.deepEqual(calls.generateModes, ['error', 'overwrite']);
		assert.equal(result.certificatePath, undefined);
		assert.equal(calls.failures.length, 1);
		assert.match(calls.failures[0]!, /could not be replaced/);
		// The warning is shown once; the retry does not re-prompt.
		assert.equal(calls.confirmCanReuse.length, 1);
	});
});

describe('CERTIFICATE_DIALOG_FILTER', () => {
	test('offers PFX only, because the CLI cannot load a .cer', () => {
		// Regression guard for microsoft/winappCli#838: cert install/info advertise
		// CER support their PKCS#12-only implementation does not have, so offering
		// .cer in the picker walks users into a raw DER decoding error.
		assert.deepEqual(Object.values(CERTIFICATE_DIALOG_FILTER).flat(), ['pfx']);
	});
});

describe('resolveCertPublisherSourceDecision', () => {
	function adapterFor(
		manifests: string[] | undefined,
		overrides: Partial<CertPublisherSourceAdapter> = {}
	): { adapter: CertPublisherSourceAdapter; calls: string[] } {
		const calls: string[] = [];
		const adapter: CertPublisherSourceAdapter = {
			findManifests: async () => {
				calls.push('findManifests');
				return manifests;
			},
			pickManifest: async (paths) => {
				calls.push('pickManifest');
				return paths[0];
			},
			promptPublisher: async () => {
				calls.push('promptPublisher');
				return 'Contoso';
			},
			...overrides
		};
		return { adapter, calls };
	}

	test('uses the only manifest without prompting', async () => {
		const { adapter, calls } = adapterFor(['C:\\proj\\Package.appxmanifest']);
		assert.deepEqual(await resolveCertPublisherSourceDecision(adapter), {
			kind: 'manifest',
			manifestPath: 'C:\\proj\\Package.appxmanifest'
		});
		assert.deepEqual(calls, ['findManifests']);
	});

	test('asks which manifest to use when several are found', async () => {
		const { adapter, calls } = adapterFor(['C:\\a.appxmanifest', 'C:\\b.appxmanifest']);
		assert.deepEqual(await resolveCertPublisherSourceDecision(adapter), {
			kind: 'manifest',
			manifestPath: 'C:\\a.appxmanifest'
		});
		assert.deepEqual(calls, ['findManifests', 'pickManifest']);
	});

	test('prompts for a publisher when there is no manifest', async () => {
		const { adapter, calls } = adapterFor([]);
		assert.deepEqual(await resolveCertPublisherSourceDecision(adapter), {
			kind: 'publisher',
			publisher: 'Contoso'
		});
		assert.deepEqual(calls, ['findManifests', 'promptPublisher']);
	});

	test('cancelling the manifest search stops the flow', async () => {
		const { adapter, calls } = adapterFor(undefined);
		assert.equal(await resolveCertPublisherSourceDecision(adapter), undefined);
		assert.deepEqual(calls, ['findManifests']);
	});

	test('dismissing the manifest picker stops the flow', async () => {
		const { adapter } = adapterFor(['C:\\a.appxmanifest', 'C:\\b.appxmanifest'], {
			pickManifest: async () => undefined
		});
		assert.equal(await resolveCertPublisherSourceDecision(adapter), undefined);
	});

	test('dismissing or blanking the publisher prompt stops the flow', async () => {
		const dismissed = adapterFor([], { promptPublisher: async () => undefined });
		assert.equal(await resolveCertPublisherSourceDecision(dismissed.adapter), undefined);

		const blank = adapterFor([], { promptPublisher: async () => '   ' });
		assert.equal(await resolveCertPublisherSourceDecision(blank.adapter), undefined);
	});
});
