import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeSignFlow, type SignFlowAdapter } from '../sign-flow';

/**
 * Stub adapter that records which methods were called and returns
 * configurable results.
 */
interface AdapterCallArgs {
	method: string;
	args: unknown[];
}

function createStubAdapter(overrides?: Partial<{
	pickSignableFileResult: string | undefined;
	pickCertificateFileResult: string | undefined;
}>): SignFlowAdapter & { calls: string[]; callArgs: AdapterCallArgs[] } {
	const calls: string[] = [];
	const callArgs: AdapterCallArgs[] = [];
	return {
		calls,
		callArgs,
		async pickSignableFile(workspacePath: string): Promise<string | undefined> {
			calls.push('pickSignableFile');
			callArgs.push({ method: 'pickSignableFile', args: [workspacePath] });
			return overrides?.pickSignableFileResult;
		},
		async pickCertificateFile(workspacePath: string): Promise<string | undefined> {
			calls.push('pickCertificateFile');
			callArgs.push({ method: 'pickCertificateFile', args: [workspacePath] });
			return overrides?.pickCertificateFileResult;
		},
		async runSignCommand(extensionPath: string, command: string, workspacePath: string): Promise<void> {
			calls.push('runSignCommand');
			callArgs.push({ method: 'runSignCommand', args: [extensionPath, command, workspacePath] });
		}
	};
}

describe('executeSignFlow', () => {
	describe('with prefilled path (post-pack Sign action)', () => {
		it('skips the file picker when a prefilled path is provided', async () => {
			const adapter = createStubAdapter({
				pickCertificateFileResult: 'C:\\certs\\dev.pfx'
			});

			const result = await executeSignFlow(
				adapter, '/ext', '/workspace', 'C:\\out\\app.msix'
			);

			assert.equal(result.filePickerShown, false,
				'File picker should NOT be shown when prefilled path is provided');
			assert.ok(!adapter.calls.includes('pickSignableFile'),
				'pickSignableFile should not be called');
		});

		it('shows the certificate picker directly', async () => {
			const adapter = createStubAdapter({
				pickCertificateFileResult: 'C:\\certs\\dev.pfx'
			});

			const result = await executeSignFlow(
				adapter, '/ext', '/workspace', 'C:\\out\\app.msix'
			);

			assert.equal(result.certPickerShown, true,
				'Certificate picker should be shown');
			assert.ok(adapter.calls.includes('pickCertificateFile'),
				'pickCertificateFile should be called');
		});

		it('passes the prefilled path to the sign command', async () => {
			const adapter = createStubAdapter({
				pickCertificateFileResult: 'C:\\certs\\dev.pfx'
			});

			const result = await executeSignFlow(
				adapter, '/ext', '/workspace', 'C:\\out\\app.msix'
			);

			assert.equal(result.filePath, 'C:\\out\\app.msix',
				'Prefilled path should be used as the file path');
			assert.ok(result.commandExecuted,
				'A sign command should be executed');
			assert.ok(result.commandExecuted!.includes('app.msix'),
				'Command should reference the prefilled artifact');
			assert.ok(result.commandExecuted!.includes('dev.pfx'),
				'Command should reference the selected certificate');
			assert.deepEqual(
				adapter.callArgs.find((call) => call.method === 'pickCertificateFile')?.args,
				['/workspace'],
				'pickCertificateFile should receive the workspace path'
			);
			assert.deepEqual(
				adapter.callArgs.find((call) => call.method === 'runSignCommand')?.args,
				['/ext', result.commandExecuted, '/workspace'],
				'runSignCommand should receive the extension path, command, and workspace path'
			);
		});

		it('executes the sign command via the adapter', async () => {
			const adapter = createStubAdapter({
				pickCertificateFileResult: 'C:\\certs\\dev.pfx'
			});

			const result = await executeSignFlow(
				adapter, '/ext', '/workspace', 'C:\\out\\app.msix'
			);

			assert.ok(adapter.calls.includes('runSignCommand'),
				'runSignCommand should be called');
			assert.deepEqual(
				adapter.callArgs.find((call) => call.method === 'runSignCommand')?.args,
				['/ext', result.commandExecuted, '/workspace'],
				'runSignCommand should receive the extension path, command, and workspace path'
			);
		});

		it('aborts when certificate picker is cancelled', async () => {
			const adapter = createStubAdapter({
				pickCertificateFileResult: undefined
			});

			const result = await executeSignFlow(
				adapter, '/ext', '/workspace', 'C:\\out\\app.msix'
			);

			assert.equal(result.certPickerShown, true,
				'Certificate picker should be shown');
			assert.equal(result.certPath, undefined,
				'No certificate should be selected');
			assert.equal(result.commandExecuted, undefined,
				'No command should be executed');
			assert.ok(!adapter.calls.includes('runSignCommand'),
				'runSignCommand should NOT be called when cert is cancelled');
		});
	});

	describe('without prefilled path (winapp.sign command)', () => {
		it('shows the file picker when no prefilled path is provided', async () => {
			const adapter = createStubAdapter({
				pickSignableFileResult: 'C:\\out\\app.msix',
				pickCertificateFileResult: 'C:\\certs\\dev.pfx'
			});

			const result = await executeSignFlow(
				adapter, '/ext', '/workspace'
			);

			assert.equal(result.filePickerShown, true,
				'File picker should be shown');
			assert.ok(adapter.calls.includes('pickSignableFile'),
				'pickSignableFile should be called');
			assert.deepEqual(
				adapter.callArgs.find((call) => call.method === 'pickSignableFile')?.args,
				['/workspace'],
				'pickSignableFile should receive the workspace path'
			);
		});

		it('proceeds to certificate picker after file selection', async () => {
			const adapter = createStubAdapter({
				pickSignableFileResult: 'C:\\out\\app.msix',
				pickCertificateFileResult: 'C:\\certs\\dev.pfx'
			});

			const result = await executeSignFlow(
				adapter, '/ext', '/workspace'
			);

			assert.equal(result.certPickerShown, true);
			assert.equal(result.filePath, 'C:\\out\\app.msix');
			assert.equal(result.certPath, 'C:\\certs\\dev.pfx');
			assert.ok(result.commandExecuted);
		});

		it('aborts when file picker is cancelled', async () => {
			const adapter = createStubAdapter({
				pickSignableFileResult: undefined
			});

			const result = await executeSignFlow(
				adapter, '/ext', '/workspace'
			);

			assert.equal(result.filePickerShown, true);
			assert.equal(result.filePath, undefined,
				'No file should be selected');
			assert.equal(result.certPickerShown, false,
				'Certificate picker should NOT be shown');
			assert.equal(result.commandExecuted, undefined,
				'No command should be executed');
		});

		it('aborts when certificate picker is cancelled after file selection', async () => {
			const adapter = createStubAdapter({
				pickSignableFileResult: 'C:\\out\\app.msix',
				pickCertificateFileResult: undefined
			});

			const result = await executeSignFlow(
				adapter, '/ext', '/workspace'
			);

			assert.equal(result.filePath, 'C:\\out\\app.msix');
			assert.equal(result.certPickerShown, true);
			assert.equal(result.certPath, undefined);
			assert.equal(result.commandExecuted, undefined);
		});
	});

	describe('command construction', () => {
		it('builds a valid sign command with both paths', async () => {
			const adapter = createStubAdapter({
				pickCertificateFileResult: 'C:\\certs\\dev.pfx'
			});

			const result = await executeSignFlow(
				adapter, '/ext', '/workspace', 'C:\\out\\app.msix'
			);

			assert.ok(result.commandExecuted);
			assert.ok(result.commandExecuted!.startsWith('sign '),
				'Command should start with "sign"');
			assert.ok(result.commandExecuted!.includes('app.msix'));
			assert.ok(result.commandExecuted!.includes('dev.pfx'));
		});

		it('handles paths with spaces', async () => {
			const adapter = createStubAdapter({
				pickCertificateFileResult: 'C:\\My Certs\\dev cert.pfx'
			});

			const result = await executeSignFlow(
				adapter, '/ext', '/workspace', 'C:\\My Apps\\my app.msix'
			);

			assert.ok(result.commandExecuted);
			assert.ok(result.commandExecuted!.includes('My Apps'));
			assert.ok(result.commandExecuted!.includes('My Certs'));
		});
	});
});
