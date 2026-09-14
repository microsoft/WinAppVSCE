import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
	REDACTED,
	buildCertGenerateArgs,
	decideCertGenerateOutcome,
	isAlreadyExistsError,
	parseCertErrorMessage,
	parseCertGenerateResult,
	parseExistingCertificatePath,
	redactPasswordArgs,
	redactPasswordInOutput,
	validatePublisherInput
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

	test('returns undefined when there is nothing error-shaped to report', () => {
		assert.equal(parseCertErrorMessage(''), undefined);
		assert.equal(parseCertErrorMessage('just some output'), undefined);
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
		assert.equal(validatePublisherInput('CN=Contoso\\, Inc, C=US'), undefined);
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
