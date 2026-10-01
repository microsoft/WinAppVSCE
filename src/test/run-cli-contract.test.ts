import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
 * The schema is read straight from the binary in `bin/`, which is the exact
 * CLI the extension ships. An earlier version of this file compared against a
 * checked-in copy of the schema instead, which bought nothing: the copy could
 * only ever be as fresh as the last time someone remembered to regenerate it,
 * so it needed a second suite guarding the copy against the binary, plus a
 * script to rewrite it and another command to verify it. Reading the binary
 * directly makes drift impossible by construction rather than detectable.
 *
 * Skipped when no CLI is present. `bin/` is gitignored and populated by
 * `npm run download-cli`, so a fresh clone has nothing to check; CI downloads
 * the CLI before running unit tests, which is where this contract is enforced.
 */

interface RunSchemaOption {
	valueType: string;
	takesValue: boolean;
	repeatable: boolean;
}

interface RunSchema {
	cliVersion: string;
	arguments: string[];
	options: Record<string, RunSchemaOption>;
}

const cliPath = [
	join(__dirname, '..', '..', 'bin', 'win-x64', 'winapp.exe'),
	join(__dirname, '..', '..', 'bin', 'win-arm64', 'winapp.exe')
].find(existsSync);

/**
 * Reads the `run` subcommand out of `winapp --cli-schema`.
 *
 * Read once at load time: shelling out costs ~100ms and every test below needs
 * the same answer.
 */
function readRunSchema(): RunSchema | undefined {
	if (!cliPath) { return undefined; }

	const raw = execFileSync(cliPath, ['--cli-schema'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
	const parsed = JSON.parse(raw);
	const run = parsed.subcommands?.run;
	assert.ok(run, 'the bundled CLI schema has no "run" subcommand');

	const options: Record<string, RunSchemaOption> = {};
	for (const [name, spec] of Object.entries(run.options ?? {}) as [string, { valueType: string }][]) {
		options[name] = {
			valueType: spec.valueType,
			// Boolean options are bare flags; everything else consumes the next token.
			takesValue: spec.valueType !== 'System.Boolean',
			// An array-typed option is the CLI's way of spelling "pass me repeatedly".
			repeatable: spec.valueType.endsWith('[]')
		};
	}

	const args = Object.entries(run.arguments ?? {} as Record<string, { order: number }>)
		.sort((a, b) => (a[1] as { order: number }).order - (b[1] as { order: number }).order)
		.map(([name]) => name);

	return { cliVersion: parsed.version, arguments: args, options };
}

const schema = readRunSchema();

// node:test reports a skipped suite with its reason, so an absent CLI is
// visible in the output rather than looking like a suite that passed.
const skipReason = schema
	? false
	: 'no winapp.exe in bin/ — run "npm run download-cli" to check the run surface against the CLI';

/** Reads the schema in a test body, where the skip guard has already run. */
function requireSchema(): RunSchema {
	assert.ok(schema, 'expected a bundled CLI');
	return schema!;
}

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
	aot: true,
	clean: true,
	debugOutput: true,
	symbols: true,
	detach: true,
	noLaunch: true,
	unregisterOnExit: true,
	withAlias: true,
	withoutAlias: true,
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
	const schema = requireSchema();
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

describe('buildRunArgs matches the real winapp run schema', { skip: skipReason }, () => {
	it('emits only flags the CLI actually defines', () => {
		const emitted = walkArgs(buildRunArgs(maximalOptions));
		assert.ok(emitted.size > 0, 'expected the maximal options to emit flags');
	});

	it('gives a value to every option that requires one', () => {
		// walkArgs asserts arity as it goes; this pins the intent explicitly so
		// the coverage is not merely incidental to the previous test.
		const args = buildRunArgs(maximalOptions);
		walkArgs(args);

		for (const [flag, spec] of Object.entries(requireSchema().options)) {
			if (!spec.takesValue) { continue; }
			const at = args.indexOf(flag);
			if (at === -1) { continue; }
			assert.notEqual(args[at + 1], undefined, `${flag} was emitted without a value`);
		}
	});

	it('covers every non-diagnostic option the CLI exposes', () => {
		const schema = requireSchema();
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
		assert.equal(requireSchema().options['--property'].repeatable, true);

		const args = buildRunArgs({
			input: 'C:\\src\\App\\App.csproj',
			properties: { A: '1', B: '2', C: '3' },
		});

		const values = args.filter((_, i) => args[i - 1] === '--property');
		assert.deepEqual(values, ['A=1', 'B=2', 'C=3']);
	});

	it('passes the target as the positional input argument', () => {
		// A rename here is exactly the kind of break this file exists to catch:
		// the CLI renamed this argument from `input-folder` to `input` when it
		// gained project mode.
		assert.equal(requireSchema().arguments[0], 'input');

		const args = buildRunArgs({ input: 'C:\\src\\App' });
		assert.deepEqual(args, ['run', 'C:\\src\\App']);
	});
});
