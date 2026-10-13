import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
	availableRunToggles,
	buildRunArgs,
	COMMON_CONFIGURATIONS,
	expandRequiredToggles,
	parseProcessIdFromJson,
	resolveDebugInput,
	resolveRunProject,
	resolveRunToggles,
	RUN_OPTIONS,
	RUN_TOGGLES,
	runOptionsFromDebugConfig,
	runToggleDetail,
	shouldPromptForProject,
	SUPPORTED_ARCHITECTURES,
	validateDebugRunOptions,
	type RunOptionKey,
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


describe('parseProcessIdFromJson', () => {
	it('reads processId', () => {
		assert.strictEqual(parseProcessIdFromJson('{"processId": 4242}'), 4242);
	});

	it('accepts the casing variants the CLI has used', () => {
		assert.strictEqual(parseProcessIdFromJson('{"pid": 7}'), 7);
		assert.strictEqual(parseProcessIdFromJson('{"ProcessId": 8}'), 8);
		assert.strictEqual(parseProcessIdFromJson('{"PID": 9}'), 9);
	});

	it('tolerates surrounding whitespace', () => {
		assert.strictEqual(parseProcessIdFromJson('\n  {"processId": 12}\r\n'), 12);
	});

	// Called on every stdout chunk, so a partial object is the normal case.
	it('returns undefined for incomplete JSON', () => {
		assert.strictEqual(parseProcessIdFromJson('{"processId": 42'), undefined);
	});

	it('returns undefined for non-JSON output', () => {
		assert.strictEqual(parseProcessIdFromJson('Building MyApp.csproj...'), undefined);
	});

	it('rejects a missing, non-numeric, or non-positive id', () => {
		assert.strictEqual(parseProcessIdFromJson('{"exitCode": 0}'), undefined);
		assert.strictEqual(parseProcessIdFromJson('{"processId": "4242"}'), undefined);
		assert.strictEqual(parseProcessIdFromJson('{"processId": 0}'), undefined);
		assert.strictEqual(parseProcessIdFromJson('{"processId": -1}'), undefined);
	});
});

describe('run toggles', () => {
	it('offers only switch options that exist in the run surface', () => {
		for (const toggle of RUN_TOGGLES) {
			const descriptor = RUN_OPTIONS.find(option => option.key === toggle.key);
			assert.ok(descriptor, `${toggle.key} is not a known run option`);
			assert.strictEqual(descriptor.kind, 'switch', `${toggle.key} is not a switch`);
		}
	});

	it('surfaces the debugging toggles that launch.json cannot express', () => {
		const keys = RUN_TOGGLES.map(toggle => toggle.key);
		assert.ok(keys.includes('debugOutput'));
		assert.ok(keys.includes('symbols'));
	});

	it('hides project-only toggles in folder mode', () => {
		const folderKeys = availableRunToggles(false).map(toggle => toggle.key);
		assert.ok(!folderKeys.includes('noBuild'));
		assert.ok(folderKeys.includes('clean'));
		assert.ok(availableRunToggles(true).map(toggle => toggle.key).includes('noBuild'));
	});

	it('emits false for every unchecked toggle', () => {
		const available = availableRunToggles(false);
		const resolved = resolveRunToggles(available, []);
		for (const toggle of available) {
			assert.strictEqual(resolved[toggle.key], false);
		}
	});

	it('turns on the prerequisite of a dependent toggle', () => {
		const available = availableRunToggles(true);
		const resolved = resolveRunToggles(available, ['symbols', 'clean'] as RunOptionKey[]);
		assert.strictEqual(resolved.symbols, true);
		assert.strictEqual(resolved.debugOutput, true);
		assert.strictEqual(resolved.clean, true);
	});

	it('keeps a dependent toggle when its prerequisite is checked', () => {
		const available = availableRunToggles(true);
		const resolved = resolveRunToggles(available, ['symbols', 'debugOutput'] as RunOptionKey[]);
		assert.strictEqual(resolved.symbols, true);
		assert.strictEqual(resolved.debugOutput, true);
	});

	it('leaves a prerequisite checked on its own alone', () => {
		const available = availableRunToggles(true);
		const resolved = resolveRunToggles(available, ['debugOutput'] as RunOptionKey[]);
		assert.strictEqual(resolved.debugOutput, true);
		assert.strictEqual(resolved.symbols, false);
	});

	it('drops a dependent toggle whose prerequisite is not offered', () => {
		// A dependent toggle offered without its prerequisite cannot be
		// honoured, so the flag must not reach the CLI.
		const available = [RUN_TOGGLES.find(toggle => toggle.key === 'symbols')!];
		const resolved = resolveRunToggles(available, ['symbols'] as RunOptionKey[]);
		assert.strictEqual(resolved.symbols, false);
	});

	it('round-trips the gated toggles into argv', () => {
		const available = availableRunToggles(true);
		const resolved = resolveRunToggles(available, ['symbols', 'debugOutput'] as RunOptionKey[]);
		const args = buildRunArgs(options(resolved));
		assert.ok(args.includes('--debug-output'));
		assert.ok(args.includes('--symbols'));

		// Checking only the dependent is the same request, so it produces the
		// same command line.
		const implied = buildRunArgs(options(resolveRunToggles(available, ['symbols'] as RunOptionKey[])));
		assert.deepStrictEqual(implied, args);
	});
});

describe('toggle prerequisites', () => {
	it('adds the prerequisite of a checked dependent', () => {
		const available = availableRunToggles(false);
		assert.deepStrictEqual(
			expandRequiredToggles(available, ['symbols'] as RunOptionKey[]),
			['debugOutput', 'symbols']
		);
	});

	it('does not imply a dependent from its prerequisite', () => {
		const available = availableRunToggles(false);
		assert.deepStrictEqual(
			expandRequiredToggles(available, ['debugOutput'] as RunOptionKey[]),
			['debugOutput']
		);
	});

	it('is idempotent, so the picker settles after one pass', () => {
		const available = availableRunToggles(true);
		const once = expandRequiredToggles(available, ['symbols', 'clean'] as RunOptionKey[]);
		assert.deepStrictEqual(expandRequiredToggles(available, once), once);
	});

	it('ignores keys that are not on offer', () => {
		const available = availableRunToggles(false);
		assert.deepStrictEqual(
			expandRequiredToggles(available, ['noBuild'] as RunOptionKey[]),
			[]
		);
	});

	it('emits in offer order regardless of check order', () => {
		const available = availableRunToggles(false);
		const order = available.map(toggle => toggle.key);
		const expanded = expandRequiredToggles(available, ['symbols', 'clean'] as RunOptionKey[]);
		assert.deepStrictEqual(expanded, order.filter(key => expanded.includes(key)));
	});
});

describe('toggle detail text', () => {
	it('appends the flag from the run option table', () => {
		const clean = RUN_TOGGLES.find(toggle => toggle.key === 'clean')!;
		assert.ok(runToggleDetail(clean).endsWith(' (--clean)'));
	});

	it('never hard-codes a flag in the toggle literal, so the two cannot drift', () => {
		for (const toggle of RUN_TOGGLES) {
			assert.ok(
				!toggle.detail.includes('--'),
				`${toggle.key} spells a flag in its detail text; runToggleDetail appends it`
			);
			const flag = RUN_OPTIONS.find(option => option.key === toggle.key)!.flag;
			assert.strictEqual(runToggleDetail(toggle), `${toggle.detail} (${flag})`);
		}
	});
});
/**
 * An explicit launch.json "project" is the user pinning which app F5 runs.
 * It has to win over the picker AND suppress the prompt, or a multi-app
 * solution asks a question whose answer is thrown away.
 */
describe('launch.json project precedence', () => {
	it('suppresses the disambiguation prompt when the config pins a project', () => {
		assert.equal(shouldPromptForProject('src/App/App.csproj'), false);
	});

	it('prompts when the config names no project', () => {
		assert.equal(shouldPromptForProject(undefined), true);
		assert.equal(shouldPromptForProject(''), true);
	});

	// A blank or whitespace-only value is a user who started typing and gave
	// up, not a pin; treating it as one would launch with no --project.
	it('prompts when the config value is blank or not a string', () => {
		assert.equal(shouldPromptForProject('   '), true);
		assert.equal(shouldPromptForProject(null), true);
		assert.equal(shouldPromptForProject(42), true);
	});

	it('lets the configured project win over whatever the picker resolved', () => {
		assert.equal(resolveRunProject('src/Pinned/Pinned.csproj', 'src/Picked/Picked.csproj'), 'src/Pinned/Pinned.csproj');
	});

	it('falls back to the picker only when the config left it blank', () => {
		assert.equal(resolveRunProject(undefined, 'src/Picked/Picked.csproj'), 'src/Picked/Picked.csproj');
		assert.equal(resolveRunProject('  ', 'src/Picked/Picked.csproj'), 'src/Picked/Picked.csproj');
	});

	it('leaves the project unset when neither side supplied one', () => {
		assert.equal(resolveRunProject(undefined, undefined), undefined);
	});

	// The two must agree: whenever the prompt is suppressed, the configured
	// value must be the one that survives.
	it('never suppresses the prompt without also winning', () => {
		for (const configured of [undefined, '', '   ', null, 42, 'App.csproj']) {
			if (!shouldPromptForProject(configured)) {
				assert.equal(resolveRunProject(configured, 'picked.csproj'), configured);
			}
		}
	});
});
