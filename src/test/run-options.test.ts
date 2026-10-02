import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
	buildRunArgs,
	clearInapplicableOptions,
	COMMON_CONFIGURATIONS,
	resolveDebugInput,
	runOptionsFromDebugConfig,
	SUPPORTED_ARCHITECTURES,
	validateDebugRunOptions,
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

describe('validateDebugRunOptions', () => {
	it('rejects noLaunch, which leaves nothing to attach to', () => {
		assert.ok(validateDebugRunOptions(options({ noLaunch: true })).some(m => m.includes('noLaunch')));
	});

	it('rejects detach, which orphans the run process', () => {
		assert.ok(validateDebugRunOptions(options({ detach: true })).some(m => m.includes('detach')));
	});

	it('rejects debugOutput, since Windows allows one debugger per process', () => {
		assert.ok(validateDebugRunOptions(options({ debugOutput: true })).some(m => m.includes('debugOutput')));
	});

	it('reports every unsupported option at once', () => {
		const errors = validateDebugRunOptions(options({ noLaunch: true, detach: true, debugOutput: true }));
		assert.strictEqual(errors.length, 3);
	});

	// Everything else is the CLI's to validate; it reports bad values itself.
	it('leaves build options alone', () => {
		const opts = options({ configuration: 'Release', arch: 'x64', runtime: 'win-x64', noBuild: true });
		assert.deepStrictEqual(validateDebugRunOptions(opts), []);
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

/** Folder runs silently ignore project-only options, so drop them and warn. */
describe('clearInapplicableOptions', () => {
	const projectOnly = options({
		project: 'App',
		configuration: 'Release',
		arch: 'x64',
		framework: 'net8.0-windows10.0.19041.0',
		runtime: 'win-x64',
		properties: { Foo: 'Bar' },
		noBuild: true,
		noRestore: true,
		aot: true,
		debugOutput: true,
		symbols: true
	});

	it('drops every project-only option for a folder target', () => {
		const cleared = clearInapplicableOptions(projectOnly, 'folder');
		assert.deepStrictEqual(
			Object.entries(cleared)
				.filter(([, value]) => value !== undefined)
				.map(([key]) => key)
				.sort(),
			// aot survives on purpose: the CLI rejects it outright rather than
			// ignoring it, so the CLI's own error is what the user sees.
			['aot', 'debugOutput', 'input', 'symbols']
		);
	});

	for (const kind of ['project', 'solution', 'unknown'] as const) {
		it(`leaves a ${kind} target untouched`, () => {
			assert.deepStrictEqual(clearInapplicableOptions(projectOnly, kind), projectOnly);
		});
	}
});
