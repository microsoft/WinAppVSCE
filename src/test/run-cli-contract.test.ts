import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { buildRunArgs, WinAppRunOptions } from '../run-options';

/**
 * Contract tests between `buildRunArgs` and the real `winapp run` surface.
 *
 * Every other test in this suite asserts that `buildRunArgs` emits what we
 * *intended*; none of them can catch the case where the intent itself is wrong
 * because the CLI spells an option differently, dropped it, or never had it.
 * A typo like `--no-builds` produces a confident green suite and a runtime
 * failure, so the flag names are checked against the CLI's own schema.
 *
 * The fixture is generated from `winapp --cli-schema` (the `subcommands.run`
 * node) rather than transcribed from `--help`, so it cannot drift through
 * copying mistakes. Regenerate it when targeting a new CLI version; a
 * legitimately renamed option should surface here as a failure and be an
 * explicit decision, which is the entire point.
 */

interface RunSchemaOption {
	valueType: string;
	takesValue: boolean;
	repeatable: boolean;
	aliases?: string[];
}

interface RunSchema {
	cliVersion: string;
	command: string;
	arguments: string[];
	options: Record<string, RunSchemaOption>;
}

const schema: RunSchema = JSON.parse(
	readFileSync(join(__dirname, 'fixtures', 'run-cli-schema.json'), 'utf8')
);

/**
 * Options with every field populated, so `buildRunArgs` emits every flag it is
 * capable of emitting. Mutually exclusive combinations are deliberately
 * included: `validateRunOptions` rejects those, but this test is about whether
 * the CLI understands each flag at all, not whether the combination is legal.
 */
const maximalOptions: Required<WinAppRunOptions> = {
	input: 'C:\\src\\App\\App.csproj',
	project: 'App',
	configuration: 'Release',
	arch: 'arm64',
	framework: 'net10.0-windows10.0.26100.0',
	runtime: 'win-arm64',
	properties: { WindowsPackageType: 'None', Foo: 'Bar' },
	noBuild: true,
	noRestore: true,
	clean: true,
	debugOutput: true,
	symbols: true,
	detach: true,
	noLaunch: true,
	unregisterOnExit: true,
	withAlias: true,
	executable: 'App.exe',
	manifest: 'C:\\src\\App\\Package.appxmanifest',
	outputAppxDirectory: 'C:\\src\\App\\AppX',
	args: '--flag value',
	json: true,
};

/**
 * Walks an argv the way the CLI's parser would, using the schema to decide
 * which flags consume the following token. A positional-scanning heuristic
 * cannot do this correctly: `--args "--flag value"` has a value that itself
 * begins with `--`, and would be misread as a bare flag.
 *
 * Returns the flags encountered, and throws if the argv is malformed — a flag
 * that needs a value but is last or followed by another known flag.
 */
function walkArgs(args: string[]): Set<string> {
	const seen = new Set<string>();

	// args[0] is the `run` verb, args[1] the positional input.
	for (let i = 2; i < args.length; i++) {
		const flag = args[i];
		const spec = schema.options[flag];

		assert.ok(
			flag.startsWith('--'),
			`unexpected positional token "${flag}" at index ${i}: ${args.join(' ')}`
		);
		assert.ok(spec, `emitted flag absent from winapp ${schema.cliVersion}: ${flag}`);

		seen.add(flag);

		if (spec.takesValue) {
			const value = args[i + 1];
			assert.ok(value !== undefined, `${flag} requires a value but ended the argv`);
			assert.ok(
				!(value in schema.options),
				`${flag} requires a value but was followed by the flag ${value}`
			);
			i++;
		}
	}

	return seen;
}

describe('buildRunArgs matches the real winapp run schema', () => {
	it('emits only flags the CLI actually defines', () => {
		const emitted = walkArgs(buildRunArgs(maximalOptions));
		assert.ok(emitted.size > 0, 'expected the maximal options to emit flags');
	});

	it('gives a value to every option that requires one', () => {
		// walkArgs asserts arity as it goes; this pins the intent explicitly so
		// the coverage is not merely incidental to the previous test.
		const args = buildRunArgs(maximalOptions);
		walkArgs(args);

		for (const [flag, spec] of Object.entries(schema.options)) {
			if (!spec.takesValue) { continue; }
			const at = args.indexOf(flag);
			if (at === -1) { continue; }
			assert.notEqual(args[at + 1], undefined, `${flag} was emitted without a value`);
		}
	});

	it('covers every non-diagnostic option the CLI exposes', () => {
		const emitted = walkArgs(buildRunArgs(maximalOptions));

		// --verbose/--quiet are output controls the extension deliberately owns
		// elsewhere; they are not part of the run-options surface.
		const diagnosticOnly = new Set(['--verbose', '--quiet']);
		const missing = Object.keys(schema.options)
			.filter((flag) => !diagnosticOnly.has(flag) && !emitted.has(flag));

		assert.deepEqual(
			missing,
			[],
			`winapp ${schema.cliVersion} exposes run options the extension cannot emit: ${missing.join(', ')}`
		);
	});

	it('repeats --property once per MSBuild property', () => {
		assert.equal(schema.options['--property'].repeatable, true);

		const args = buildRunArgs({
			input: 'C:\\src\\App\\App.csproj',
			properties: { A: '1', B: '2', C: '3' },
		});

		const values = args.filter((_, i) => args[i - 1] === '--property');
		assert.deepEqual(values, ['A=1', 'B=2', 'C=3']);
	});

	it('passes the target as the positional input argument', () => {
		assert.equal(schema.arguments[0], 'input');

		const args = buildRunArgs({ input: 'C:\\src\\App' });
		assert.deepEqual(args, ['run', 'C:\\src\\App']);
	});
});
