import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getWindowsServerRid } from '../xaml/serverArchitecture';

describe('getWindowsServerRid', () => {
	it('uses the process architecture when Windows architecture variables are absent', () => {
		assert.equal(getWindowsServerRid('x64', {}), 'win-x64');
		assert.equal(getWindowsServerRid('arm64', {}), 'win-arm64');
	});

	it('prefers the native Windows architecture over an emulated process architecture', () => {
		assert.equal(
			getWindowsServerRid('x64', {
				PROCESSOR_ARCHITECTURE: 'AMD64',
				PROCESSOR_ARCHITEW6432: 'ARM64',
			}),
			'win-arm64'
		);
	});

	it('uses PROCESSOR_ARCHITECTURE for a native ARM64 process', () => {
		assert.equal(
			getWindowsServerRid('x64', { PROCESSOR_ARCHITECTURE: 'ARM64' }),
			'win-arm64'
		);
	});
});
