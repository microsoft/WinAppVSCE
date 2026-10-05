import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SUPPORTED_ARCHITECTURES } from '../run-options';

const packageJsonPath = path.resolve(__dirname, '..', '..', 'package.json');
const raw = fs.readFileSync(packageJsonPath, 'utf8');
const manifest = JSON.parse(raw);

/** Duplicate JSON keys silently replace earlier extension contributions. */
function findDuplicateKeys(json: string): string[] {
	const duplicates: string[] = [];
	const stack: { keys: Set<string>; path: string }[] = [];
	let current: { keys: Set<string>; path: string } | undefined;

	let index = 0;
	let pendingKey: string | undefined;

	while (index < json.length) {
		const char = json[index];

		if (char === '"') {
			// Read the string, honouring escapes, so a quote inside a value
			// does not desynchronise the scan.
			let end = index + 1;
			while (end < json.length) {
				if (json[end] === '\\') {
					end += 2;
					continue;
				}
				if (json[end] === '"') {
					break;
				}
				end += 1;
			}
			const text = json.slice(index + 1, end);
			index = end + 1;

			// A string is a key only when the next non-whitespace char is ':'.
			let lookahead = index;
			while (lookahead < json.length && /\s/.test(json[lookahead])) {
				lookahead += 1;
			}
			if (json[lookahead] === ':' && current) {
				if (current.keys.has(text)) {
					duplicates.push(current.path ? `${current.path}.${text}` : text);
				}
				current.keys.add(text);
				pendingKey = text;
			}
			continue;
		}

		if (char === '{') {
			const parentPath = current?.path ?? '';
			const nextPath = pendingKey
				? (parentPath ? `${parentPath}.${pendingKey}` : pendingKey)
				: parentPath;
			if (current) {
				stack.push(current);
			}
			current = { keys: new Set(), path: nextPath };
			pendingKey = undefined;
		} else if (char === '}') {
			current = stack.pop();
			pendingKey = undefined;
		} else if (char === ',') {
			pendingKey = undefined;
		}

		index += 1;
	}

	return duplicates;
}

describe('package.json contributions', () => {
	it('has no duplicate keys', () => {
		assert.deepEqual(findDuplicateKeys(raw), []);
	});

	it('declares every setting in a single configuration block', () => {
		const properties = Object.keys(manifest.contributes.configuration.properties);
		for (const expected of [
			'winapp.appDirectories',
			'winapp.manifest.intelliSense.enable',
			'winapp.manifest.diagnostics.level',
			'winapp.manifest.intelliSense.diagnostics.strictChildPlacement'
		]) {
			assert.ok(properties.includes(expected), `missing setting: ${expected}`);
		}
	});

	// Run options are per-run (the With Options prompts) or per-configuration
	// (launch.json). A workspace setting would be a third source of truth that
	// F5 could not honor, so the surface deliberately has none.
	it('contributes no winapp.run.* settings', () => {
		const properties = Object.keys(manifest.contributes.configuration.properties);
		assert.deepEqual(properties.filter(name => name.startsWith('winapp.run.')), []);
	});

	it('registers an activation event for every contributed command', () => {
		const activationEvents: string[] = manifest.activationEvents;
		for (const command of manifest.contributes.commands) {
			assert.ok(
				activationEvents.includes(`onCommand:${command.command}`),
				`missing activation event for ${command.command}`
			);
		}
	});

	it('exposes the run commands', () => {
		const commands = manifest.contributes.commands.map((c: { command: string }) => c.command);
		assert.ok(commands.includes('winapp.run'));
		assert.ok(commands.includes('winapp.runWithOptions'));
	});

	// launch.json is the only place a user types these by hand, so the schema
	// is the first line of defence: a wrong type or a missing enum turns into
	// a CLI error at F5 time instead of a red squiggle while editing.
	it('types every build option in the launch.json schema', () => {
		const properties = manifest.contributes.debuggers[0].configurationAttributes.launch.properties;

		assert.deepEqual(properties.arch.enum, [...SUPPORTED_ARCHITECTURES], 'arch must offer the architectures the CLI accepts');
		assert.ok(!properties.configuration.enum, 'configuration must stay free-form for custom MSBuild configurations');
		assert.equal(properties.configuration.type, 'string');
		assert.equal(properties.framework.type, 'string');
		assert.equal(properties.runtime.type, 'string');
		assert.equal(properties.properties.type, 'object');
		assert.equal(properties.properties.additionalProperties.type, 'string');

		for (const flag of ['noBuild', 'noRestore', 'aot', 'clean', 'unregisterOnExit', 'withAlias', 'withoutAlias']) {
			assert.equal(properties[flag].type, 'boolean', `${flag} should be a boolean`);
		}
	});

	it('keeps inputFolder as a deprecated alias for input', () => {
		const properties = manifest.contributes.debuggers[0].configurationAttributes.launch.properties;
		assert.ok(properties.input, 'input should be declared');
		assert.ok(properties.inputFolder.deprecationMessage, 'inputFolder should be marked deprecated');
	});

	it('does not expose options the debug adapter rejects', () => {
		const properties = manifest.contributes.debuggers[0].configurationAttributes.launch.properties;
		// Each of these leaves no running process for the debugger to attach to.
		for (const name of ['detach', 'noLaunch', 'debugOutput']) {
			assert.equal(properties[name], undefined, `${name} should not be offered in launch.json`);
		}
	});
});
