import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
	CERTIFICATE_DIALOG_FILTER,
	REDACTED,
	buildCertGenerateArgs,
	decideCertGenerateOutcome,
	executeCertGenerateFlow,
	isAlreadyExistsError,
	parseCertErrorMessage,
	parseCertGenerateResult,
	parseCertInfoSubject,
	parseExistingCertificatePath,
	parseManifestPublisher,
	publishersMatch,
	redactPasswordArgs,
	redactPasswordInOutput,
	resolveCertPublisherSourceDecision,
	validatePublisherInput,
	type CertGenerateFlowAdapter,
	type CertGenerateOutcome,
	type CertGenerateResult,
	type CertIfExists,
	type CertPublisherSourceAdapter,
	type OverwriteChoice
} from '../cert-utils';

/** A representative `cert generate --json` success payload. */
const SUCCESS_JSON = JSON.stringify({
	certificatePath: 'C:\\proj\\devcert.pfx',
	password: 'password',
	publisher: 'CN=Contoso',
	subjectName: 'CN=Contoso'
});

const ALREADY_EXISTS_JSON = JSON.stringify({
	error: 'Certificate file already exists: C:\\proj\\devcert.pfx'
});

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
			'error',
			'--json'
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
			'error',
			'--json'
		]);
	});

	test('defaults --if-exists to error and honours overwrite', () => {
		assert.deepEqual(buildCertGenerateArgs({ publisher: 'Contoso' }).slice(-3), [
			'--if-exists',
			'error',
			'--json'
		]);

		const overwrite = buildCertGenerateArgs({ publisher: 'Contoso', ifExists: 'overwrite' });
		assert.equal(overwrite[overwrite.indexOf('--if-exists') + 1], 'overwrite');
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

describe('redactPasswordArgs', () => {
	test('masks the value after --password without touching other arguments', () => {
		const args = redactPasswordArgs(['cert', 'generate', '--password', 'hunter2', '--json']);
		assert.deepEqual(args, ['cert', 'generate', '--password', REDACTED, '--json']);
	});

	test('does not mutate the caller array', () => {
		const original = ['--password', 'hunter2'];
		redactPasswordArgs(original);
		assert.deepEqual(original, ['--password', 'hunter2']);
	});

	test('tolerates a trailing --password with no value', () => {
		assert.deepEqual(redactPasswordArgs(['cert', '--password']), ['cert', '--password']);
	});

	test('does not redact a literal argument that merely looks like a secret', () => {
		assert.deepEqual(redactPasswordArgs(['--publisher', 'CN=password']), ['--publisher', 'CN=password']);
	});
});

describe('redactPasswordInOutput', () => {
	test('masks the password echoed back by --json', () => {
		const redacted = redactPasswordInOutput(SUCCESS_JSON);
		assert.ok(!redacted.includes('"password":"password"'));
		assert.ok(redacted.includes(`"password":"${REDACTED}"`));
		// The rest of the payload must remain parsable.
		assert.equal(parseCertGenerateResult(redacted)?.certificatePath, 'C:\\proj\\devcert.pfx');
	});

	test('masks passwords containing escaped quotes', () => {
		const redacted = redactPasswordInOutput('{"password": "a\\"b", "certificatePath": "c.pfx"}');
		assert.ok(!redacted.includes('a\\"b'));
		assert.equal(parseCertGenerateResult(redacted)?.certificatePath, 'c.pfx');
	});

	test('leaves output without a password untouched', () => {
		const output = '{"certificatePath":"c.pfx"}';
		assert.equal(redactPasswordInOutput(output), output);
	});
});

describe('parseCertGenerateResult', () => {
	test('reads the certificate path and publisher', () => {
		const result = parseCertGenerateResult(SUCCESS_JSON);
		assert.equal(result?.certificatePath, 'C:\\proj\\devcert.pfx');
		assert.equal(result?.publisher, 'CN=Contoso');
		assert.equal(result?.subjectName, 'CN=Contoso');
	});

	test('finds the payload when the CLI prints leading noise', () => {
		const result = parseCertGenerateResult(`Generating certificate...\n${SUCCESS_JSON}\n`);
		assert.equal(result?.certificatePath, 'C:\\proj\\devcert.pfx');
	});

	test('returns undefined for unparsable or pathless output', () => {
		assert.equal(parseCertGenerateResult('not json at all'), undefined);
		assert.equal(parseCertGenerateResult('{"publisher":"CN=Contoso"}'), undefined);
		assert.equal(parseCertGenerateResult('{"certificatePath":""}'), undefined);
	});
});

describe('isAlreadyExistsError / parseExistingCertificatePath', () => {
	test('detects the JSON form and extracts the path', () => {
		assert.ok(isAlreadyExistsError(ALREADY_EXISTS_JSON));
		assert.equal(parseExistingCertificatePath(ALREADY_EXISTS_JSON), 'C:\\proj\\devcert.pfx');
	});

	test('detects the plain-text form and extracts the path', () => {
		const output = '❌ Certificate file already exists: C:\\proj\\devcert.pfx\nPlease specify a different output path.';
		assert.ok(isAlreadyExistsError(output));
		assert.equal(parseExistingCertificatePath(output), 'C:\\proj\\devcert.pfx');
	});

	test('does not fire on unrelated failures', () => {
		assert.equal(isAlreadyExistsError('{"error":"Invalid publisher"}'), false);
		assert.equal(parseExistingCertificatePath('{"error":"Invalid publisher"}'), undefined);
	});
});

describe('parseCertErrorMessage', () => {
	test('prefers the JSON error field', () => {
		assert.equal(parseCertErrorMessage('{"error":"Invalid publisher"}'), 'Invalid publisher');
	});

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
		assert.deepEqual(decideCertGenerateOutcome(0, SUCCESS_JSON, true), { kind: 'cancelled' });
		assert.deepEqual(decideCertGenerateOutcome(null, '', true), { kind: 'cancelled' });
	});

	test('exit 0 with a payload is a success', () => {
		const outcome = decideCertGenerateOutcome(0, SUCCESS_JSON);
		assert.equal(outcome.kind, 'success');
		assert.equal(
			outcome.kind === 'success' ? outcome.result.certificatePath : undefined,
			'C:\\proj\\devcert.pfx'
		);
	});

	test('exit 0 without a parsable payload is a failure, not an unsubstantiated success', () => {
		assert.equal(decideCertGenerateOutcome(0, 'done!').kind, 'failed');
	});

	test('an already-exists failure is reported separately so it can be retried', () => {
		const outcome = decideCertGenerateOutcome(1, ALREADY_EXISTS_JSON);
		assert.equal(outcome.kind, 'already-exists');
		assert.equal(
			outcome.kind === 'already-exists' ? outcome.existingPath : undefined,
			'C:\\proj\\devcert.pfx'
		);
	});

	test('other non-zero exits carry the error message through', () => {
		const outcome = decideCertGenerateOutcome(1, '{"error":"Invalid publisher"}');
		assert.equal(outcome.kind, 'failed');
		assert.equal(outcome.kind === 'failed' ? outcome.message : undefined, 'Invalid publisher');
	});

	test('a null exit code with no output is a failure', () => {
		assert.equal(decideCertGenerateOutcome(null, '').kind, 'failed');
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

const GENERATED: CertGenerateResult = {
	certificatePath: 'C:\\proj\\devcert.pfx',
	publisher: 'CN=Contoso',
	subjectName: 'CN=Contoso'
};

const EXISTING_PATH = 'C:\\proj\\existing.pfx';

interface FlowCalls {
	generateModes: CertIfExists[];
	installed: string[];
	successes: { result: CertGenerateResult; created: boolean; installing: boolean }[];
	failures: (string | undefined)[];
	keptExisting: (string | undefined)[];
	confirmCanReuse: boolean[];
	inspected: string[];
	verified: CertGenerateResult[];
	installSkipped: CertGenerateResult[];
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
	choice: OverwriteChoice = 'dismiss',
	options: {
		verdict?: 'ok' | 'mismatch' | 'unverified';
		inspected?: CertGenerateResult;
	} = {}
): { adapter: CertGenerateFlowAdapter; calls: FlowCalls } {
	const calls: FlowCalls = {
		generateModes: [],
		installed: [],
		successes: [],
		failures: [],
		keptExisting: [],
		confirmCanReuse: [],
		inspected: [],
		verified: [],
		installSkipped: [],
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
		inspectCertificate: async (certificatePath) => {
			calls.inspected.push(certificatePath);
			calls.sequence.push('inspectCertificate');
			return options.inspected;
		},
		verifyPublisher: async (result) => {
			calls.verified.push(result);
			calls.sequence.push('verifyPublisher');
			return options.verdict ?? 'ok';
		},
		reportSuccess: async (result, context) => {
			calls.successes.push({ result, ...context });
			calls.sequence.push('reportSuccess');
		},
		reportFailure: (message) => {
			calls.failures.push(message);
			calls.sequence.push('reportFailure');
		},
		reportKeptExisting: (existingPath) => {
			calls.keptExisting.push(existingPath);
			calls.sequence.push('reportKeptExisting');
		},
		reportInstallSkipped: (result) => {
			calls.installSkipped.push(result);
			calls.sequence.push('reportInstallSkipped');
		}
	};

	return { adapter, calls };
}

describe('executeCertGenerateFlow', () => {
	test('generate-only success reports the certificate and installs nothing', async () => {
		const { adapter, calls } = createFakeAdapter([{ kind: 'success', result: GENERATED }]);

		const result = await executeCertGenerateFlow(adapter, false);

		assert.deepEqual(calls.generateModes, ['error']);
		assert.equal(result.certificatePath, GENERATED.certificatePath);
		assert.equal(result.created, true);
		assert.equal(result.installed, false);
		assert.equal(result.overwritePrompted, false);
		assert.deepEqual(calls.installed, []);
		assert.deepEqual(calls.successes, [{ result: GENERATED, created: true, installing: false }]);
	});

	test('generate-and-install installs and still reports where the cert landed', async () => {
		const { adapter, calls } = createFakeAdapter([{ kind: 'success', result: GENERATED }]);

		const result = await executeCertGenerateFlow(adapter, true);

		assert.equal(result.installed, true);
		assert.deepEqual(calls.installed, [GENERATED.certificatePath]);
		// The install runs in a separate elevated window, so the success
		// notification is the only in-VS-Code trace of the certificate path.
		assert.deepEqual(calls.successes, [{ result: GENERATED, created: true, installing: true }]);
	});

	test('overwrite retries generation with --if-exists overwrite', async () => {
		const { adapter, calls } = createFakeAdapter(
			[
				{ kind: 'already-exists', existingPath: EXISTING_PATH },
				{ kind: 'success', result: GENERATED }
			],
			'overwrite'
		);

		const result = await executeCertGenerateFlow(adapter, false);

		assert.deepEqual(calls.generateModes, ['error', 'overwrite']);
		assert.equal(result.overwritePrompted, true);
		assert.equal(result.created, true);
		assert.equal(result.certificatePath, GENERATED.certificatePath);
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
			{ result: { certificatePath: EXISTING_PATH }, created: false, installing: true }
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

describe('parseManifestPublisher', () => {
	const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">
  <Identity Name="App" Publisher="CN=Contoso, O=Contoso Ltd, C=US" Version="1.0.0.0" />
  <Properties>
    <PublisherDisplayName>Contoso Display</PublisherDisplayName>
  </Properties>
</Package>`;

	test('reads Identity/@Publisher', () => {
		assert.equal(parseManifestPublisher(MANIFEST), 'CN=Contoso, O=Contoso Ltd, C=US');
	});

	test('does not confuse PublisherDisplayName for the publisher', () => {
		assert.notEqual(parseManifestPublisher(MANIFEST), 'Contoso Display');
	});

	test('handles a namespace-prefixed Identity element', () => {
		assert.equal(
			parseManifestPublisher(
				`<pkg:Package xmlns:pkg="http://schemas.microsoft.com/appx/manifest/foundation/windows10">
  <pkg:Identity Name="A" Publisher="CN=X" Version="1.0.0.0" />
</pkg:Package>`
			),
			'CN=X'
		);
	});

	test('ignores a commented-out Identity element', () => {
		assert.equal(
			parseManifestPublisher(
				`<Package>
  <!-- <Identity Name="Old" Publisher="CN=Stale" /> -->
  <Identity Name="App" Publisher="CN=Current" />
</Package>`
			),
			'CN=Current'
		);
	});

	test('reads a single-quoted Publisher attribute', () => {
		assert.equal(
			parseManifestPublisher(`<Package><Identity Name='A' Publisher='CN=Quoted' /></Package>`),
			'CN=Quoted'
		);
	});

	test('decodes XML entities in the publisher', () => {
		assert.equal(
			parseManifestPublisher('<Package><Identity Publisher="CN=A &amp; B" /></Package>'),
			'CN=A & B'
		);
	});

	test('ignores Publisher on nested dependency elements', () => {
		assert.equal(
			parseManifestPublisher(
				`<Package>
  <Identity Name="App" Publisher="CN=Real" />
  <Dependencies>
    <PackageDependency Name="Dep" Publisher="CN=SomeoneElse" />
  </Dependencies>
</Package>`
			),
			'CN=Real'
		);
	});

	test('tolerates a leading BOM and CRLF line endings', () => {
		assert.equal(
			parseManifestPublisher('\uFEFF<Package>\r\n  <Identity Publisher="CN=Bom" />\r\n</Package>'),
			'CN=Bom'
		);
	});

	test('returns undefined when there is no Identity element', () => {
		assert.equal(parseManifestPublisher('<Package></Package>'), undefined);
		assert.equal(parseManifestPublisher('not xml at all'), undefined);
	});

	test('returns undefined when Identity carries no Publisher', () => {
		assert.equal(parseManifestPublisher('<Identity Name="App" Version="1.0.0.0" />'), undefined);
	});
});

describe('publishersMatch', () => {
	test('ignores case and spacing differences within a distinguished name', () => {
		assert.equal(publishersMatch('CN=Contoso, O=Contoso Ltd', 'cn=Contoso,o=contoso ltd'), true);
		assert.equal(publishersMatch('CN = Contoso', 'CN=Contoso'), true);
	});

	test('detects the CLI silently falling back to the user name', () => {
		// Regression guard for microsoft/winappCli#839.
		assert.equal(publishersMatch('CN=Contoso, O=Contoso Ltd, C=US', 'CN=chiaramooney'), false);
	});

	test('does not treat a prefix as a match', () => {
		assert.equal(publishersMatch('CN=Contoso', 'CN=Contoso, O=Contoso Ltd'), false);
	});
});

describe('parseCertInfoSubject', () => {
	test('reads the subject from a cert info payload', () => {
		assert.equal(
			parseCertInfoSubject(JSON.stringify({ subject: 'CN=Probe', thumbprint: 'AB' })),
			'CN=Probe'
		);
	});

	test('returns undefined for output without a subject', () => {
		assert.equal(parseCertInfoSubject('{"error":"bad password"}'), undefined);
		assert.equal(parseCertInfoSubject('not json'), undefined);
	});
});

describe('redact-then-classify', () => {
	// Redaction happens in runWinappCapture before the output is classified, so
	// no downstream message can contain the password the CLI echoes back. The
	// exit-0-but-unparsable branch is the one that matters: it routes a SUCCESS
	// payload into the error path.
	test('an exit-0 payload without certificatePath never leaks the password', () => {
		const renamed = JSON.stringify({ certPath: 'C:\\proj\\devcert.pfx', password: 'hunter2' });
		const outcome = decideCertGenerateOutcome(0, redactPasswordInOutput(renamed));

		assert.equal(outcome.kind, 'failed');
		assert.ok(outcome.kind === 'failed' && !outcome.message?.includes('hunter2'));
	});

	test('a failure payload never leaks the password', () => {
		const failure = JSON.stringify({ error: 'boom', password: 'hunter2' });
		const outcome = decideCertGenerateOutcome(1, redactPasswordInOutput(failure));

		assert.equal(outcome.kind, 'failed');
		assert.ok(outcome.kind === 'failed' && !outcome.message?.includes('hunter2'));
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
describe('executeCertGenerateFlow publisher verification', () => {
	test('verifies the publisher before handing off to the elevated install', async () => {
		const { adapter, calls } = createFakeAdapter([{ kind: 'success', result: GENERATED }]);
		await executeCertGenerateFlow(adapter, true);

		const verifyAt = calls.sequence.indexOf('verifyPublisher');
		const installAt = calls.sequence.indexOf('installCertificate');
		assert.ok(verifyAt !== -1 && installAt !== -1);
		assert.ok(
			verifyAt < installAt,
			`verifyPublisher must run before installCertificate, got ${calls.sequence.join(' -> ')}`
		);
	});

	test('skips the install when the publisher does not match the manifest', async () => {
		const { adapter, calls } = createFakeAdapter([{ kind: 'success', result: GENERATED }], 'dismiss', {
			verdict: 'mismatch'
		});
		const result = await executeCertGenerateFlow(adapter, true);

		assert.deepEqual(calls.installed, []);
		assert.equal(calls.installSkipped.length, 1);
		assert.equal(result.installed, false);
		assert.equal(result.publisherVerified, 'mismatch');
		// The certificate still exists, so the path is reported back.
		assert.equal(result.certificatePath, GENERATED.certificatePath);
	});

	test('a mismatch without an install request does not report a skipped install', async () => {
		const { adapter, calls } = createFakeAdapter([{ kind: 'success', result: GENERATED }], 'dismiss', {
			verdict: 'mismatch'
		});
		await executeCertGenerateFlow(adapter, false);

		assert.deepEqual(calls.installSkipped, []);
		assert.equal(calls.successes.length, 1);
	});

	test('an unverifiable publisher does not block the install', async () => {
		const { adapter, calls } = createFakeAdapter([{ kind: 'success', result: GENERATED }], 'dismiss', {
			verdict: 'unverified'
		});
		const result = await executeCertGenerateFlow(adapter, true);

		assert.deepEqual(calls.installed, [GENERATED.certificatePath]);
		assert.equal(result.installed, true);
	});

	test('reuse reads the existing certificate so it can be verified', async () => {
		const inspected: CertGenerateResult = {
			certificatePath: EXISTING_PATH,
			subjectName: 'CN=Existing'
		};
		const { adapter, calls } = createFakeAdapter(
			[{ kind: 'already-exists', existingPath: EXISTING_PATH }],
			'reuse',
			{ inspected }
		);
		await executeCertGenerateFlow(adapter, false);

		assert.deepEqual(calls.inspected, [EXISTING_PATH]);
		// Without the inspection the verifier would receive a bare path and skip
		// the check entirely, which is how a wrong certificate used to get through.
		assert.equal(calls.verified[0].subjectName, 'CN=Existing');
	});

	test('reuse still succeeds when the existing certificate cannot be read', async () => {
		const { adapter, calls } = createFakeAdapter(
			[{ kind: 'already-exists', existingPath: EXISTING_PATH }],
			'reuse'
		);
		const result = await executeCertGenerateFlow(adapter, false);

		assert.equal(result.certificatePath, EXISTING_PATH);
		assert.equal(result.created, false);
		assert.equal(calls.successes.length, 1);
	});

	test('a mismatched reused certificate is not installed', async () => {
		const { adapter, calls } = createFakeAdapter(
			[{ kind: 'already-exists', existingPath: EXISTING_PATH }],
			'reuse',
			{ inspected: { certificatePath: EXISTING_PATH, subjectName: 'CN=Wrong' }, verdict: 'mismatch' }
		);
		await executeCertGenerateFlow(adapter, true);

		assert.deepEqual(calls.installed, []);
		assert.equal(calls.installSkipped.length, 1);
	});
});