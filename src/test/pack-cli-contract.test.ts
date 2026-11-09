import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { buildPackArgs, type PackInput, type PackOptions } from '../pack-args';

interface PackSchemaOption {
	takesValue: boolean;
	repeatable: boolean;
}

interface PackSchema {
	cliVersion: string;
	aliases: string[];
	argumentName: string;
	inputDescription: string;
	options: Record<string, PackSchemaOption>;
}

const cliPath = [
	join(__dirname, '..', '..', 'bin', 'win-x64', 'winapp.exe'),
	join(__dirname, '..', '..', 'bin', 'win-arm64', 'winapp.exe')
].find(existsSync);

function readPackSchema(): PackSchema | undefined {
	if (!cliPath) { return undefined; }

	const raw = execFileSync(cliPath, ['--cli-schema'], {
		encoding: 'utf8',
		maxBuffer: 16 * 1024 * 1024
	});
	const parsed = JSON.parse(raw);
	const pack = parsed.subcommands?.package;
	assert.ok(pack, 'the bundled CLI schema has no "package" subcommand');

	const options: Record<string, PackSchemaOption> = {};
	for (const [name, spec] of Object.entries(pack.options ?? {}) as [string, { valueType: string }][]) {
		options[name] = {
			takesValue: spec.valueType !== 'System.Boolean',
			repeatable: spec.valueType.endsWith('[]')
		};
	}

	const argumentsInOrder = Object.entries(
		pack.arguments ?? {} as Record<string, { order: number; description?: string }>
	).sort((a, b) => (
		(a[1] as { order: number }).order - (b[1] as { order: number }).order
	));
	const [argumentName, argumentSpec] = argumentsInOrder[0] ?? [];

	return {
		cliVersion: parsed.version,
		aliases: pack.aliases ?? [],
		argumentName,
		inputDescription: String(
			(argumentSpec as { description?: string } | undefined)?.description ?? ''
		),
		options
	};
}

const schema = readPackSchema();
const skipReason = schema
	? false
	: 'no winapp.exe in bin/ — run "npm run download-cli" to check the pack surface against the CLI';

function requireSchema(): PackSchema {
	assert.ok(schema, 'expected a bundled CLI');
	return schema!;
}

const projectInput: PackInput = {
	kind: 'project',
	projectFile: 'C:\\src\\App\\App.csproj',
	workspaceRoot: 'C:\\src',
	architectures: ['x64', 'arm64']
};

const folderInput: PackInput = {
	kind: 'folders',
	folders: ['C:\\publish\\x64', 'C:\\publish\\arm64'],
	workspaceRoot: 'C:\\src'
};

const generatedOptions: PackOptions = {
	signing: 'generateDev',
	selfContained: true,
	configuration: 'Debug'
};

const supportedPackOptions = [
	'--arch',
	'--configuration',
	'--generate-cert',
	'--install-cert',
	'--no-sign',
	'--self-contained'
];

function walkArgs(args: string[]): { flags: Set<string>; positional: string[] } {
	const packSchema = requireSchema();
	const flags = new Set<string>();
	const positional: string[] = [];

	assert.equal(args[0], 'pack');
	for (let i = 1; i < args.length; i++) {
		const token = args[i];
		if (!token.startsWith('--')) {
			positional.push(token);
			continue;
		}

		const spec = packSchema.options[token];
		assert.ok(spec, `emitted flag absent from winapp ${packSchema.cliVersion}: ${token}`);
		flags.add(token);
		if (spec.takesValue) {
			const value = args[i + 1];
			assert.ok(value !== undefined, `${token} requires a value but ended the argv`);
			assert.ok(!(value in packSchema.options), `${token} was followed by the flag ${value}`);
			i++;
		}
	}

	return { flags, positional };
}

describe('buildPackArgs matches the real winapp package schema', { skip: skipReason }, () => {
	it('uses the supported pack alias and positional input', () => {
		const packSchema = requireSchema();
		assert.ok(packSchema.aliases.includes('pack'));
		assert.equal(packSchema.argumentName, 'input-folder');
		assert.match(packSchema.inputDescription, /\.csproj/i);
		assert.match(packSchema.inputDescription, /multiple folders/i);
	});

	it('emits only flags defined by the bundled CLI', () => {
		walkArgs(buildPackArgs(projectInput, generatedOptions));
		walkArgs(buildPackArgs(projectInput, {
			signing: 'unsigned',
			selfContained: false
		}));
		walkArgs(buildPackArgs(folderInput, {
			signing: 'default',
			selfContained: false
		}));
	});

	it('covers every pack option the extension intentionally supports', () => {
		const emitted = new Set<string>();
		for (const args of [
			buildPackArgs(projectInput, generatedOptions),
			buildPackArgs(projectInput, { signing: 'unsigned', selfContained: false })
		]) {
			for (const flag of walkArgs(args).flags) {
				emitted.add(flag);
			}
		}

		assert.deepEqual(
			supportedPackOptions.filter(flag => !emitted.has(flag)),
			[]
		);
	});

	it('repeats --arch once per selected project architecture', () => {
		assert.equal(requireSchema().options['--arch'].repeatable, true);
		const args = buildPackArgs(projectInput, {
			signing: 'default',
			selfContained: false
		});
		assert.deepEqual(
			args.filter((_, index) => args[index - 1] === '--arch'),
			['x64', 'arm64']
		);
		assert.deepEqual(walkArgs(args).positional, [projectInput.projectFile]);
	});

	it('passes every build-output folder positionally', () => {
		const args = buildPackArgs(folderInput, {
			signing: 'default',
			selfContained: false
		});
		assert.deepEqual(walkArgs(args).positional, folderInput.folders);
	});
});
