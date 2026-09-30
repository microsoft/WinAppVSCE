import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
	buildRunArgs,
	getRunOptionErrors,
	resolveDebugInput,
	runOptionsFromDebugConfig,
	validateRunOptions,
	type WinAppDebugConfiguration,
	type WinAppRunOptions
} from '../run-options';

function options(overrides: Partial<WinAppRunOptions> = {}): WinAppRunOptions {
	return { input: 'C:/ws/MyApp.csproj', ...overrides };
}

describe('buildRunArgs', () => {
	it('emits the run verb and positional input first', () => {
		assert.deepStrictEqual(buildRunArgs(options()), ['run', 'C:/ws/MyApp.csproj']);
	});

	it('omits every option that is unset', () => {
		assert.strictEqual(buildRunArgs(options()).length, 2);
	});

	it('emits project-mode options with their values', () => {
		const args = buildRunArgs(options({
			project: 'MyApp',
			configuration: 'Release',
			arch: 'arm64',
			framework: 'net10.0-windows10.0.26100.0',
			runtime: 'win-arm64'
		}));

		assert.deepStrictEqual(args, [
			'run', 'C:/ws/MyApp.csproj',
			'--project', 'MyApp',
			'--configuration', 'Release',
			'--arch', 'arm64',
			'--framework', 'net10.0-windows10.0.26100.0',
			'--runtime', 'win-arm64'
		]);
	});

	it('repeats --property once per entry as Name=Value', () => {
		const args = buildRunArgs(options({
			properties: { WindowsPackageType: 'None', Foo: 'Bar' }
		}));

		assert.deepStrictEqual(args.slice(2), [
			'--property', 'WindowsPackageType=None',
			'--property', 'Foo=Bar'
		]);
	});

	it('does not quote or escape values — argv goes straight to spawn', () => {
		const args = buildRunArgs(options({
			input: 'C:/my ws/My App.csproj',
			properties: { Banner: 'Hello World' }
		}));

		assert.ok(args.includes('C:/my ws/My App.csproj'));
		assert.ok(args.includes('Banner=Hello World'));
	});

	it('emits boolean flags without values', () => {
		const args = buildRunArgs(options({
			noBuild: true, noRestore: true, clean: true,
			withAlias: true, unregisterOnExit: true, json: true
		}));

		for (const flag of ['--no-build', '--no-restore', '--clean', '--with-alias', '--unregister-on-exit', '--json']) {
			assert.ok(args.includes(flag), `expected ${flag}`);
		}
		assert.ok(!args.includes('true'));
	});

	it('trims --args and omits it when blank', () => {
		assert.deepStrictEqual(buildRunArgs(options({ args: '  --flag value  ' })).slice(2), ['--args', '--flag value']);
		assert.strictEqual(buildRunArgs(options({ args: '   ' })).length, 2);
	});

	it('puts --json last so the adapter can read it predictably', () => {
		const args = buildRunArgs(options({ json: true, clean: true, args: '-v' }));
		assert.strictEqual(args[args.length - 1], '--json');
	});

	it('is deterministic regardless of key insertion order', () => {
		const a = buildRunArgs({ input: 'x', clean: true, configuration: 'Debug' });
		const b = buildRunArgs({ configuration: 'Debug', clean: true, input: 'x' });
		assert.deepStrictEqual(a, b);
	});
});

describe('validateRunOptions — CLI conflicts', () => {
	it('rejects --debug-output with --json', () => {
		const result = validateRunOptions(options({ debugOutput: true, json: true }), 'project');
		assert.ok(getRunOptionErrors(result).some(d => d.message.includes('JSON')));
	});

	it('rejects --debug-output with --no-launch', () => {
		const result = validateRunOptions(options({ debugOutput: true, noLaunch: true }), 'project');
		assert.ok(getRunOptionErrors(result).some(d => d.message.includes('no-launch')));
	});

	it('warns that symbols without debug output is ignored', () => {
		const result = validateRunOptions(options({ symbols: true }), 'project');
		assert.ok(result.some(d => d.severity === 'warning' && d.message.includes('symbols')));
	});

	it('rejects the two alias options together, since they are opposites', () => {
		const result = validateRunOptions(options({ withAlias: true, withoutAlias: true }), 'project');
		assert.ok(getRunOptionErrors(result).some(d => d.message.includes('opposites')));
	});

	it('accepts either alias option on its own', () => {
		for (const opts of [{ withAlias: true }, { withoutAlias: true }]) {
			assert.deepStrictEqual(getRunOptionErrors(validateRunOptions(options(opts), 'project')), []);
		}
	});

	it('accepts a clean project-mode option set', () => {
		const result = validateRunOptions(options({ configuration: 'Release', arch: 'x64' }), 'project');
		assert.deepStrictEqual(getRunOptionErrors(result), []);
	});
});

describe('validateRunOptions — debug context', () => {
	it('rejects noLaunch, which leaves nothing to attach to', () => {
		const result = validateRunOptions(options({ noLaunch: true }), 'project', 'debug');
		assert.ok(getRunOptionErrors(result).some(d => d.message.includes('noLaunch')));
	});

	it('rejects detach, which orphans the run process', () => {
		const result = validateRunOptions(options({ detach: true }), 'project', 'debug');
		assert.ok(getRunOptionErrors(result).some(d => d.message.includes('detach')));
	});

	it('rejects debugOutput, since Windows allows one debugger per process', () => {
		const result = validateRunOptions(options({ debugOutput: true }), 'project', 'debug');
		assert.ok(getRunOptionErrors(result).some(d => d.message.includes('debugOutput')));
	});

	it('allows the same options in the palette context', () => {
		for (const opt of [{ noLaunch: true }, { detach: true }, { debugOutput: true }]) {
			assert.deepStrictEqual(getRunOptionErrors(validateRunOptions(options(opt), 'project', 'palette')), []);
		}
	});
});

describe('validateRunOptions — mode mismatches', () => {
	it('warns when project-only options are used on a folder', () => {
		const result = validateRunOptions(options({ configuration: 'Release', noBuild: true }), 'folder');
		const warning = result.find(d => d.severity === 'warning');
		assert.ok(warning);
		assert.ok(warning!.message.includes('--configuration'));
		assert.ok(warning!.message.includes('--no-build'));
	});

	it('does not warn in project or solution mode', () => {
		for (const kind of ['project', 'solution'] as const) {
			const result = validateRunOptions(options({ configuration: 'Release' }), kind);
			assert.deepStrictEqual(result, []);
		}
	});

	it('stays quiet for unknown targets, letting the CLI decide', () => {
		const result = validateRunOptions(options({ configuration: 'Release' }), 'unknown');
		assert.deepStrictEqual(result, []);
	});

	it('does not warn about folder-compatible options', () => {
		const result = validateRunOptions(options({ clean: true, withAlias: true }), 'folder');
		assert.deepStrictEqual(result, []);
	});

	// --aot drives an MSBuild publish, so folder mode has nothing to apply it
	// to. Listing it keeps the warning honest about everything being dropped.
	it('names --aot among the options a folder run ignores', () => {
		const result = validateRunOptions(options({ aot: true }), 'folder');
		const warning = result.find(d => d.severity === 'warning');
		assert.ok(warning);
		assert.ok(warning!.message.includes('--aot'));
	});
});

describe('validateRunOptions — value checks', () => {
	it('warns that runtime overrides arch', () => {
		const result = validateRunOptions(options({ runtime: 'win-x64', arch: 'x86' }), 'project');
		assert.ok(result.some(d => d.severity === 'warning' && d.message.includes('precedence')));
	});

	it('rejects non-Windows runtime identifiers', () => {
		const result = validateRunOptions(options({ runtime: 'linux-x64' }), 'project');
		assert.ok(getRunOptionErrors(result).some(d => d.message.includes('linux-x64')));
	});

	it('accepts Windows runtime identifiers', () => {
		for (const rid of ['win-x64', 'win-arm64', 'win10-x64', 'win']) {
			const result = validateRunOptions(options({ runtime: rid }), 'project');
			assert.deepStrictEqual(getRunOptionErrors(result), [], `expected ${rid} to be accepted`);
		}
	});

	it('rejects unsupported architectures', () => {
		const result = validateRunOptions(options({ arch: 'mips' }), 'project');
		assert.ok(getRunOptionErrors(result).some(d => d.message.includes('mips')));
	});

	it('warns that noRestore is redundant with noBuild', () => {
		const result = validateRunOptions(options({ noBuild: true, noRestore: true }), 'project');
		assert.ok(result.some(d => d.severity === 'warning' && d.message.includes('noRestore')));
	});

	it('rejects malformed MSBuild property names', () => {
		assert.ok(getRunOptionErrors(validateRunOptions(options({ properties: { '': 'x' } }), 'project')).length > 0);
		assert.ok(getRunOptionErrors(validateRunOptions(options({ properties: { 'A=B': 'x' } }), 'project')).length > 0);
	});

	it('accepts an empty property value', () => {
		const result = validateRunOptions(options({ properties: { Foo: '' } }), 'project');
		assert.deepStrictEqual(getRunOptionErrors(result), []);
	});
});

describe('resolveDebugInput', () => {
	it('prefers the new input key over the deprecated inputFolder alias', () => {
		assert.strictEqual(resolveDebugInput({ input: 'A.csproj', inputFolder: 'bin/Debug' }), 'A.csproj');
	});

	it('still honours inputFolder so existing launch.json files keep working', () => {
		assert.strictEqual(resolveDebugInput({ inputFolder: 'bin/Debug' }), 'bin/Debug');
	});

	it('returns undefined when neither is set so the picker runs', () => {
		assert.strictEqual(resolveDebugInput({}), undefined);
	});

	it('treats an empty string as unset', () => {
		assert.strictEqual(resolveDebugInput({ input: '', inputFolder: '' }), undefined);
	});
});

describe('runOptionsFromDebugConfig', () => {
	// Every key the launch.json schema declares must reach the CLI. A key that
	// is contributed but never mapped is silently ignored at F5 time.
	it('maps every declared launch.json key onto run options', () => {
		const config: WinAppDebugConfiguration = {
			type: 'winapp',
			name: 'Launch',
			request: 'launch',
			project: 'App',
			configuration: 'Release',
			arch: 'arm64',
			framework: 'net8.0-windows10.0.19041.0',
			runtime: 'win-arm64',
			properties: { Foo: 'Bar' },
			noBuild: true,
			noRestore: true,
			aot: true,
			clean: true,
			debugOutput: true,
			symbols: true,
			detach: false,
			noLaunch: false,
			unregisterOnExit: true,
			withAlias: true,
			// The opposite of withAlias, so a valid pairing still proves the
			// key is read rather than dropped.
			withoutAlias: false,
			executable: 'App.exe',
			manifest: 'Package.appxmanifest',
			outputAppxDirectory: 'out'
		};

		const options = runOptionsFromDebugConfig(config, 'C:/ws/App.csproj');

		assert.deepStrictEqual(options, {
			input: 'C:/ws/App.csproj',
			project: 'App',
			configuration: 'Release',
			arch: 'arm64',
			framework: 'net8.0-windows10.0.19041.0',
			runtime: 'win-arm64',
			properties: { Foo: 'Bar' },
			noBuild: true,
			noRestore: true,
			aot: true,
			clean: true,
			debugOutput: true,
			symbols: true,
			detach: false,
			noLaunch: false,
			unregisterOnExit: true,
			withAlias: true,
			withoutAlias: false,
			executable: 'App.exe',
			manifest: 'Package.appxmanifest',
			outputAppxDirectory: 'out',
			json: true
		});
	});

	// The adapter parses the launched process ID out of the CLI's JSON output
	// in order to attach, so this can never be opted out of.
	it('always requests JSON output', () => {
		assert.strictEqual(runOptionsFromDebugConfig({}, 'C:/ws/App.csproj').json, true);
	});

	it('produces a minimal command line for a bare configuration', () => {
		const options = runOptionsFromDebugConfig({}, 'C:/ws/App.csproj');
		assert.deepStrictEqual(buildRunArgs(options), ['run', 'C:/ws/App.csproj', '--json']);
	});

	it('round-trips debugOutput and symbols, which validation depends on', () => {
		const options = runOptionsFromDebugConfig({ debugOutput: true, symbols: true }, 'C:/ws/App.csproj');
		const args = buildRunArgs(options);
		assert.ok(args.includes('--debug-output'));
		assert.ok(args.includes('--symbols'));
	});
});
