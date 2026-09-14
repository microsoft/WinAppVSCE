import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const packageJsonPath = path.resolve(__dirname, '..', '..', 'package.json');
const raw = fs.readFileSync(packageJsonPath, 'utf8');
const manifest = JSON.parse(raw);

/**
 * Find object keys that appear more than once at the same position in the
 * document.
 *
 * Duplicate keys are legal JSON — `JSON.parse` silently keeps the last one —
 * so a plain parse cannot catch them. That makes it possible to add a second
 * `contributes.configuration` block and unknowingly delete every setting in
 * the first, with no syntax error and no failing parse to warn you.
 */
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
			'winapp.manifest.intelliSense.diagnostics.strictChildPlacement',
			'winapp.run.configuration',
			'winapp.run.arch',
			'winapp.run.properties',
			'winapp.run.unregisterOnExit'
		]) {
			assert.ok(properties.includes(expected), `missing setting: ${expected}`);
		}
	});

	it('scopes the run settings to the resource so multi-root workspaces can differ', () => {
		const properties = manifest.contributes.configuration.properties;
		for (const name of Object.keys(properties).filter(k => k.startsWith('winapp.run.'))) {
			assert.equal(properties[name].scope, 'resource', `${name} should be resource-scoped`);
		}
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
		assert.ok(commands.includes('winapp.runAdvanced'));
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
