import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RUN_OPTIONS, SUPPORTED_ARCHITECTURES } from '../run-options';
import { createDefaultLaunchConfiguration, WINAPP_LAUNCH_CONFIG_NAME } from '../launch-config';

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

	// VS Code's "you don't have an extension for debugging X" recovery prompt
	// opens the Extensions view with the query `@category:debuggers <language>`
	// (debugCommands.ts). An extension that contributes a debug adapter but not
	// this category can never appear there, nor under the Marketplace's
	// Debuggers filter.
	it('claims the Debuggers category', () => {
		assert.ok(
			manifest.categories.includes('Debuggers'),
			'an extension contributing contributes.debuggers must claim the Debuggers category'
		);
		assert.ok(manifest.contributes.debuggers?.length > 0);
	});

	// The Marketplace rejects a publish with more than 10 keywords.
	it('stays within the Marketplace keyword limit', () => {
		assert.ok(Array.isArray(manifest.keywords));
		assert.ok(manifest.keywords.length > 0, 'keywords drive Marketplace search ranking');
		assert.ok(manifest.keywords.length <= 10, `too many keywords: ${manifest.keywords.length}`);
		assert.equal(new Set(manifest.keywords).size, manifest.keywords.length, 'duplicate keyword');
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

	// Without a `languages` claim VS Code never considers the WinApp debugger
	// for a bare F5, and sends the user to the Marketplace instead (#287).
	it('claims the languages a WinApp project is written in', () => {
		const languages: string[] = manifest.contributes.debuggers[0].languages;
		assert.ok(Array.isArray(languages) && languages.length > 0, 'debugger must declare languages');
		for (const expected of ['csharp', 'cpp']) {
			assert.ok(languages.includes(expected), `missing debugger language ${expected}`);
		}
	});

	// canSetBreakpointsIn() reads this contribution, and it is one of the
	// conditions that lets VS Code fall back to our configuration provider.
	it('contributes breakpoints for exactly the languages the debugger claims', () => {
		const languages: string[] = manifest.contributes.debuggers[0].languages;
		const breakpoints: { language: string }[] = manifest.contributes.breakpoints;
		assert.ok(Array.isArray(breakpoints), 'breakpoints must be contributed');
		assert.deepEqual(
			breakpoints.map(entry => entry.language).sort(),
			[...languages].sort(),
			'breakpoint languages must stay in sync with debugger languages'
		);
	});

	it('activates for the debug flows that have no launch.json yet', () => {
		const activationEvents: string[] = manifest.activationEvents;
		// guessDebugger() fires onDebugInitialConfigurations before asking any
		// provider for configurations; without it we are never consulted.
		assert.ok(activationEvents.includes('onDebugInitialConfigurations'));
		assert.ok(activationEvents.includes('onDebugDynamicConfigurations:winapp'));
	});

	// Every path that writes launch.json must produce identical content: the
	// notification writes this shape directly, and VS Code's "create a
	// launch.json file" flow writes initialConfigurations verbatim.
	//
	// This is also why WinAppDebugConfigurationProvider must NOT implement
	// provideDebugConfigurations: for the initial trigger kind VS Code
	// concatenates provider results onto initialConfigurations, so doing both
	// writes the entry twice.
	it('keeps the static default identical to the generated one', () => {
		const initial = manifest.contributes.debuggers[0].initialConfigurations;
		assert.equal(initial.length, 1, 'exactly one default configuration');
		assert.deepEqual(initial[0], createDefaultLaunchConfiguration());
	});

	// The duplicate-launch.json regression this guards against is subtle and
	// was already shipped once: for the Initial trigger kind VS Code appends
	// provider results onto package.json's `initialConfigurations`, so a
	// provider that implements provideDebugConfigurations writes the WinApp
	// entry twice. Only the standalone Dynamic-kind provider may supply one.
	it('never offers configurations from the initial-trigger-kind provider', () => {
		const source = fs.readFileSync(path.resolve(__dirname, '..', 'extension.ts'), 'utf8');

		const providerClass = source.slice(
			source.indexOf('class WinAppDebugConfigurationProvider'),
			source.indexOf('class WinAppDebugAdapterFactory')
		);
		assert.ok(providerClass.length > 0, 'WinAppDebugConfigurationProvider must exist');
		assert.ok(
			!/^\s*(async\s+)?provideDebugConfigurations\s*\(/m.test(providerClass),
			'WinAppDebugConfigurationProvider must not implement provideDebugConfigurations'
		);

		// Every other provider that does supply configurations must be
		// registered for the Dynamic trigger kind.
		for (const match of source.matchAll(/provideDebugConfigurations[\s\S]{0,400}?\)\s*\)/g)) {
			assert.ok(
				match[0].includes('DebugConfigurationProviderTriggerKind.Dynamic'),
				'a provider supplying configurations must register for the Dynamic trigger kind'
			);
		}
	});

	it('names the configuration snippet the same as the generated configuration', () => {
		const snippets = manifest.contributes.debuggers[0].configurationSnippets;
		assert.ok(
			snippets.some((snippet: { label: string }) => snippet.label === WINAPP_LAUNCH_CONFIG_NAME),
			'a snippet must carry the shared configuration name'
		);
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

	// package.json cannot import the run-option table, so this test is the
	// link between them: every row marked `inLaunchSchema` must be declared,
	// and nothing marked otherwise may leak in.
	it('declares exactly the run options the table marks as launch.json keys', () => {
		const properties = manifest.contributes.debuggers[0].configurationAttributes.launch.properties;

		// Not run options: the positional input, its deprecated alias, and the
		// two keys the adapter itself consumes.
		const adapterOwned = new Set(['input', 'inputFolder', 'debuggerType', 'workingDirectory', 'port']);
		const declared = new Set(Object.keys(properties).filter(name => !adapterOwned.has(name)));

		for (const option of RUN_OPTIONS) {
			if (option.inLaunchSchema) {
				assert.ok(declared.delete(option.key), `launch.json is missing the "${option.key}" run option`);
			} else {
				assert.equal(
					properties[option.key],
					undefined,
					`"${option.key}" should not be offered in launch.json`
				);
			}
		}

		assert.deepEqual([...declared], [], 'launch.json declares keys that are not run options');
	});

	it('keeps inputFolder as a deprecated alias for input', () => {
		const properties = manifest.contributes.debuggers[0].configurationAttributes.launch.properties;
		assert.ok(properties.input, 'input should be declared');
		assert.ok(properties.inputFolder.deprecationMessage, 'inputFolder should be marked deprecated');
	});

	it('does not expose options the debug adapter rejects', () => {
		const properties = manifest.contributes.debuggers[0].configurationAttributes.launch.properties;
		// Each of these leaves no running process for the debugger to attach to.
		for (const option of RUN_OPTIONS.filter(entry => entry.debugUnsupported)) {
			assert.equal(properties[option.key], undefined, `${option.key} should not be offered in launch.json`);
		}
	});
});
