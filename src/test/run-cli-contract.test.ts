import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { buildRunArgs, WinAppRunOptions } from '../run-options';

/**
 * Flag names are checked against the CLI --cli-schema; reads bin/ and skips when absent.
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

/** Reads the `run` schema once; shelling out costs about 100ms. */
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

/** Includes mutually exclusive fields to force every emitted flag through schema validation. */
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

/** Schema-guided argv walk; --args may contain values that start with --. */
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
