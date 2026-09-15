import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import {
	buildListArgs,
	buildNewArgs,
	describeNewFailure,
	ensureAvailableName,
	formatTemplateTags,
	isProjectTemplate,
	isSdkMissingExit,
	loadWinUiTemplates,
	parseScaffoldResult,
	parseTemplateList,
	resolveScaffoldTarget,
	sortTemplates,
	validateProjectName,
	type NonEmptyTargetChoice,
	type ScaffoldTargetAdapter,
	type TemplateListAttempt,
	type TemplateListResult,
	type TemplateLoadAdapter,
	type WinUiTemplate
} from '../new-command-utils';

/** A realistic `winapp new --list --json` payload (winappcli 0.6.1). */
const LIST_JSON = JSON.stringify({
	Listed: true,
	TemplateVersion: '0.0.6-alpha',
	Templates: [
		{
			ShortName: 'winui',
			Aliases: ['winui', 'winui3', 'wasdk-single'],
			DisplayName: 'WinUI Blank App',
			Type: 'project',
			Tags: 'Windows/WinUI/Desktop/XAML'
		},
		{
			ShortName: 'winui-lib',
			Aliases: ['winui-lib'],
			DisplayName: 'WinUI Class Library',
			Type: 'project',
			Tags: 'Windows/WinUI/Library'
		}
	]
});

function template(overrides: Partial<WinUiTemplate> = {}): WinUiTemplate {
	return {
		shortName: 'winui',
		aliases: [],
		displayName: 'WinUI Blank App',
		type: 'project',
		tags: 'Windows/WinUI/Desktop/XAML',
		...overrides
	};
}

describe('validateProjectName', () => {
	it('accepts a simple name', () => {
		assert.equal(validateProjectName('PhotoViewer'), undefined);
	});

	it('accepts a name containing dots', () => {
		assert.equal(validateProjectName('Contoso.PhotoViewer'), undefined);
	});

	it('rejects empty and whitespace-only names', () => {
		assert.ok(validateProjectName(''));
		assert.ok(validateProjectName('   '));
		assert.ok(validateProjectName(undefined));
	});

	it('rejects path separators so the scaffold cannot escape the target directory', () => {
		assert.ok(validateProjectName('..\\Escaped'));
		assert.ok(validateProjectName('sub/dir'));
		assert.ok(validateProjectName('sub\\dir'));
	});

	it('rejects "." and ".."', () => {
		assert.ok(validateProjectName('.'));
		assert.ok(validateProjectName('..'));
	});

	it('leaves CLI-side name rules to the CLI', () => {
		// These are rejected by `winapp new` with its own wording; the extension
		// deliberately does not duplicate that validation.
		for (const name of ['CON', 'MyApp.', '-n', 'a'.repeat(300), 'a<b']) {
			assert.equal(
				validateProjectName(name),
				undefined,
				`expected "${name}" to be left to the CLI`
			);
		}
	});
});

describe('ensureAvailableName', () => {
	const parent = path.join('C:', 'src');

	it('returns the base name when nothing is taken', () => {
		assert.equal(ensureAvailableName('PhotoViewer', parent, () => false), 'PhotoViewer');
	});

	it('numbers past a taken name', () => {
		const taken = new Set([path.join(parent, 'PhotoViewer')]);
		assert.equal(
			ensureAvailableName('PhotoViewer', parent, (p) => taken.has(p)),
			'PhotoViewer1'
		);
	});

	it('keeps numbering until a free variant is found', () => {
		const taken = new Set([
			path.join(parent, 'WinUIApp'),
			path.join(parent, 'WinUIApp1'),
			path.join(parent, 'WinUIApp2')
		]);
		assert.equal(
			ensureAvailableName('WinUIApp', parent, (p) => taken.has(p)),
			'WinUIApp3'
		);
	});

	it('falls back to the base name when the parent cannot be inspected', () => {
		assert.equal(
			ensureAvailableName('PhotoViewer', parent, () => {
				throw new Error('EACCES');
			}),
			'PhotoViewer'
		);
	});
});

describe('resolveScaffoldTarget', () => {
	const parent = path.join('C:', 'src');

	/**
	 * Build an adapter over a fake directory listing. `directories` maps a path
	 * to its entries, so an empty array models an existing-but-empty directory
	 * and a missing key models a path that doesn't exist.
	 */
	function createAdapter(
		directories: Record<string, string[]>,
		choice?: NonEmptyTargetChoice,
		options?: { readThrows?: boolean }
	) {
		const prompts: { targetDirectory: string; availableName: string }[] = [];
		const adapter: ScaffoldTargetAdapter = {
			pathExists: (candidatePath) => candidatePath in directories,
			readDirectory: (directoryPath) => {
				if (options?.readThrows) {
					throw new Error('EACCES');
				}
				return directories[directoryPath] ?? [];
			},
			confirmNonEmptyTarget: async (targetDirectory, availableName) => {
				prompts.push({ targetDirectory, availableName });
				return choice;
			}
		};
		return { adapter, prompts };
	}

	it('uses the requested name when the target does not exist', async () => {
		const { adapter, prompts } = createAdapter({});

		const target = await resolveScaffoldTarget(adapter, parent, 'PhotoViewer');

		assert.deepEqual(target, { name: 'PhotoViewer', force: false });
		// An absent directory is not a conflict, so the user is never asked.
		assert.equal(prompts.length, 0);
	});

	it('uses the requested name when the target exists but is empty', async () => {
		const { adapter, prompts } = createAdapter({
			[path.join(parent, 'PhotoViewer')]: []
		});

		const target = await resolveScaffoldTarget(adapter, parent, 'PhotoViewer');

		// The CLI itself tolerates an existing empty directory.
		assert.deepEqual(target, { name: 'PhotoViewer', force: false });
		assert.equal(prompts.length, 0);
	});

	it('offers the auto-numbered name for a non-empty target', async () => {
		const { adapter, prompts } = createAdapter(
			{ [path.join(parent, 'PhotoViewer')]: ['App.xaml'] },
			'use-available'
		);

		const target = await resolveScaffoldTarget(adapter, parent, 'PhotoViewer');

		assert.deepEqual(target, { name: 'PhotoViewer1', force: false });
		assert.equal(prompts.length, 1);
		assert.equal(prompts[0].availableName, 'PhotoViewer1');
		assert.equal(prompts[0].targetDirectory, path.join(parent, 'PhotoViewer'));
	});

	it('passes force when the user chooses to create anyway', async () => {
		const { adapter } = createAdapter(
			{ [path.join(parent, 'PhotoViewer')]: ['App.xaml'] },
			'create-anyway'
		);

		const target = await resolveScaffoldTarget(adapter, parent, 'PhotoViewer');

		// --force overwrites the user's files, so it must only ever come from an
		// explicit choice.
		assert.deepEqual(target, { name: 'PhotoViewer', force: true });
	});

	it('returns undefined when the user dismisses the conflict prompt', async () => {
		const { adapter } = createAdapter(
			{ [path.join(parent, 'PhotoViewer')]: ['App.xaml'] },
			undefined
		);

		const target = await resolveScaffoldTarget(adapter, parent, 'PhotoViewer');

		assert.equal(target, undefined);
	});

	it('never forces when the conflict prompt is dismissed', async () => {
		const { adapter } = createAdapter(
			{ [path.join(parent, 'PhotoViewer')]: ['App.xaml'] },
			undefined
		);

		const target = await resolveScaffoldTarget(adapter, parent, 'PhotoViewer');

		// Guards the destructive path specifically: cancelling must not fall
		// through to a forced scaffold.
		assert.notEqual(target?.force, true);
	});

	it('skips numbering past directories that are already taken', async () => {
		const { adapter, prompts } = createAdapter(
			{
				[path.join(parent, 'PhotoViewer')]: ['App.xaml'],
				[path.join(parent, 'PhotoViewer1')]: ['App.xaml'],
				[path.join(parent, 'PhotoViewer2')]: []
			},
			'use-available'
		);

		const target = await resolveScaffoldTarget(adapter, parent, 'PhotoViewer');

		// PhotoViewer2 exists, so it is taken even though it is empty.
		assert.equal(target?.name, 'PhotoViewer3');
		assert.equal(prompts[0].availableName, 'PhotoViewer3');
	});

	it('proceeds without forcing when the target cannot be inspected', async () => {
		const { adapter, prompts } = createAdapter(
			{ [path.join(parent, 'PhotoViewer')]: ['App.xaml'] },
			'create-anyway',
			{ readThrows: true }
		);

		const target = await resolveScaffoldTarget(adapter, parent, 'PhotoViewer');

		// An unreadable directory defers to the CLI's structured error rather
		// than prompting on a guess.
		assert.deepEqual(target, { name: 'PhotoViewer', force: false });
		assert.equal(prompts.length, 0);
	});
});

describe('parseTemplateList', () => {
	it('parses a list payload', () => {
		const result = parseTemplateList(LIST_JSON);
		assert.ok(result.ok);
		assert.equal(result.value.templateVersion, '0.0.6-alpha');
		assert.equal(result.value.templates.length, 2);
		assert.equal(result.value.templates[0].shortName, 'winui');
		assert.deepEqual(result.value.templates[0].aliases, ['winui', 'winui3', 'wasdk-single']);
	});

	it('ignores progress text printed before the payload', () => {
		const result = parseTemplateList(`Installing WinUI template pack...\n${LIST_JSON}\n`);
		assert.ok(result.ok);
		assert.equal(result.value.templates.length, 2);
	});

	it('ignores trailing text printed after the payload', () => {
		const result = parseTemplateList(`${LIST_JSON}\nDone.\n`);
		assert.ok(result.ok);
		assert.equal(result.value.templates.length, 2);
	});

	it('surfaces a CLI-reported error verbatim', () => {
		const payload = JSON.stringify({
			Listed: false,
			Error: 'The .NET SDK is required to create a WinUI app.'
		});
		const result = parseTemplateList(payload);
		assert.equal(result.ok, false);
		assert.ok(!result.ok && result.error.includes('.NET SDK'));
	});

	it('reports an error when the output has no JSON at all', () => {
		const result = parseTemplateList('winapp: command failed');
		assert.equal(result.ok, false);
	});

	it('reports an error when no usable templates come back', () => {
		const result = parseTemplateList(JSON.stringify({ Listed: true, Templates: [] }));
		assert.equal(result.ok, false);
	});

	it('skips malformed template entries but keeps the usable ones', () => {
		const payload = JSON.stringify({
			Listed: true,
			Templates: [null, { DisplayName: 'No short name' }, { ShortName: 'winui' }]
		});
		const result = parseTemplateList(payload);
		assert.ok(result.ok);
		assert.equal(result.value.templates.length, 1);
		// Falls back to the short name when DisplayName is absent.
		assert.equal(result.value.templates[0].displayName, 'winui');
	});
});

describe('parseScaffoldResult', () => {
	it('parses a success payload', () => {
		const payload = JSON.stringify({
			Created: true,
			Template: 'winui',
			Name: 'PhotoViewer',
			Path: 'C:\\src\\PhotoViewer',
			TemplateVersion: '0.0.6-alpha'
		});
		const result = parseScaffoldResult(payload);
		assert.equal(result?.created, true);
		assert.equal(result?.name, 'PhotoViewer');
		assert.equal(result?.projectPath, 'C:\\src\\PhotoViewer');
	});

	it('parses a failure payload with the CLI error text', () => {
		const payload = JSON.stringify({
			Created: false,
			Name: 'PhotoViewer',
			Path: 'C:\\src\\PhotoViewer',
			Error: "Output directory 'C:\\src\\PhotoViewer' is not empty. Use --force to scaffold into it anyway."
		});
		const result = parseScaffoldResult(payload);
		assert.equal(result?.created, false);
		assert.ok(result?.error?.includes('--force'));
	});

	it('returns undefined when there is no JSON payload', () => {
		assert.equal(parseScaffoldResult('crashed before writing output'), undefined);
	});
});

describe('sortTemplates', () => {
	it('puts the CLI default template first, then sorts by display name', () => {
		const sorted = sortTemplates([
			template({ shortName: 'winui-navview', displayName: 'WinUI NavigationView App' }),
			template({ shortName: 'winui-lib', displayName: 'WinUI Class Library' }),
			template({ shortName: 'winui', displayName: 'WinUI Blank App' })
		]);
		assert.deepEqual(sorted.map((t) => t.shortName), ['winui', 'winui-lib', 'winui-navview']);
	});

	it('does not mutate the input', () => {
		const input = [
			template({ shortName: 'winui-lib', displayName: 'WinUI Class Library' }),
			template({ shortName: 'winui', displayName: 'WinUI Blank App' })
		];
		sortTemplates(input);
		assert.equal(input[0].shortName, 'winui-lib');
	});
});

describe('isProjectTemplate', () => {
	it('treats project templates as projects', () => {
		assert.equal(isProjectTemplate(template({ type: 'project' })), true);
	});

	it('treats item templates as non-projects', () => {
		assert.equal(isProjectTemplate(template({ type: 'item' })), false);
		assert.equal(isProjectTemplate(template({ type: 'Item' })), false);
	});

	it('treats an unknown type as a project so templates are never silently hidden', () => {
		assert.equal(isProjectTemplate(template({ type: '' })), true);
	});
});

describe('formatTemplateTags', () => {
	it('renders slash-delimited tags as a readable detail line', () => {
		assert.equal(formatTemplateTags('Windows/WinUI/Desktop/XAML'), 'Windows · WinUI · Desktop · XAML');
	});

	it('tolerates empty and padded segments', () => {
		assert.equal(formatTemplateTags('Windows// WinUI '), 'Windows · WinUI');
		assert.equal(formatTemplateTags(''), '');
	});
});

describe('describeNewFailure', () => {
	it('prefers the CLI error text, which is already actionable', () => {
		const message = describeNewFailure(2, {
			created: false,
			error: "Output directory 'C:\\src\\App' is not empty. Use --force to scaffold into it anyway."
		});
		assert.ok(message.includes('--force'));
	});

	it('falls back to a per-exit-code message when the CLI reported none', () => {
		assert.ok(describeNewFailure(3, undefined).includes('.NET SDK'));
		assert.ok(describeNewFailure(4, undefined).includes('template pack'));
		assert.ok(describeNewFailure(5, undefined).length > 0);
		assert.ok(describeNewFailure(null, undefined).length > 0);
	});
});

describe('isSdkMissingExit', () => {
	it('identifies the sdk-missing exit code', () => {
		assert.equal(isSdkMissingExit(3), true);
		assert.equal(isSdkMissingExit(2), false);
		assert.equal(isSdkMissingExit(null), false);
	});
});

describe('buildNewArgs', () => {
	it('always passes --use-defaults and --json so the CLI never prompts', () => {
		const args = buildNewArgs({
			template: 'winui',
			name: 'PhotoViewer',
			output: 'C:\\src\\PhotoViewer'
		});
		assert.deepEqual(args, [
			'new',
			'--template', 'winui',
			'--name', 'PhotoViewer',
			'--output', 'C:\\src\\PhotoViewer',
			'--use-defaults',
			'--json'
		]);
	});

	it('adds --force only when requested', () => {
		const args = buildNewArgs({
			template: 'winui',
			name: 'PhotoViewer',
			output: 'C:\\src\\PhotoViewer',
			force: true
		});
		assert.ok(args.includes('--force'));
	});

	it('adds --template-version only when requested', () => {
		assert.ok(!buildNewArgs({ template: 'winui', name: 'a', output: 'b' }).includes('--template-version'));
		const args = buildNewArgs({
			template: 'winui',
			name: 'a',
			output: 'b',
			templateVersion: 'latest'
		});
		assert.deepEqual(args.slice(-2), ['--template-version', 'latest']);
	});
});

describe('buildListArgs', () => {
	it('lists with JSON output by default', () => {
		assert.deepEqual(buildListArgs(), ['new', '--list', '--json']);
	});

	it('pins the template version when asked', () => {
		assert.deepEqual(buildListArgs('latest'), ['new', '--list', '--json', '--template-version', 'latest']);
	});
});

describe('loadWinUiTemplates', () => {
	const parsedOk = parseTemplateList(LIST_JSON) as { ok: true; value: TemplateListResult };

	/**
	 * Build an adapter that replays a queue of listing attempts. Each
	 * `listTemplates` call shifts the next outcome, so a test states exactly what
	 * the CLI returns per attempt without spawning anything.
	 */
	function createAdapter(attempts: TemplateListAttempt[]) {
		const requested: ('latest' | 'installed' | undefined)[] = [];
		const progress: string[] = [];
		const failures: { message: string; sdkMissing: boolean }[] = [];

		const adapter: TemplateLoadAdapter = {
			listTemplates: async (templateVersion, progressMessage) => {
				requested.push(templateVersion);
				progress.push(progressMessage);
				const next = attempts.shift();
				assert.ok(next, 'listTemplates called more times than the test queued');
				return next;
			},
			reportFailure: async (message, sdkMissing) => {
				failures.push({ message, sdkMissing });
			}
		};

		return { adapter, requested, progress, failures };
	}

	const ok = (): TemplateListAttempt => ({ cancelled: false, code: 0, parsed: parsedOk });
	const noPack = (): TemplateListAttempt => ({
		cancelled: false,
		code: 4,
		parsed: { ok: false, error: 'No template pack installed.' }
	});

	it('uses the installed pack without installing anything', async () => {
		const { adapter, requested, failures } = createAdapter([ok()]);

		const loaded = await loadWinUiTemplates(adapter);

		assert.deepEqual(loaded, { list: parsedOk.value, freshlyInstalled: false });
		// Exactly one purely local attempt — no unpinned listing, so no feed call
		// and no machine-wide install.
		assert.deepEqual(requested, ['installed']);
		assert.equal(failures.length, 0);
	});

	it('falls back to the unpinned listing when no pack is installed', async () => {
		const { adapter, requested, failures } = createAdapter([noPack(), ok()]);

		const loaded = await loadWinUiTemplates(adapter);

		// freshlyInstalled must be true here: the fallback just fetched the pack,
		// so asking "installed or latest?" would be asking the same question twice.
		assert.deepEqual(loaded, { list: parsedOk.value, freshlyInstalled: true });
		assert.deepEqual(requested, ['installed', undefined]);
		assert.equal(failures.length, 0);
	});

	it('stops at a missing SDK instead of attempting the install fallback', async () => {
		const { adapter, requested, failures } = createAdapter([
			{
				cancelled: false,
				code: 3,
				parsed: { ok: false, error: 'The .NET SDK is required to create a WinUI app.' }
			}
		]);

		const loaded = await loadWinUiTemplates(adapter);

		assert.equal(loaded, undefined);
		// The fallback cannot succeed without an SDK, and its "Installing..."
		// progress would imply work that can never happen.
		assert.deepEqual(requested, ['installed']);
		assert.equal(failures.length, 1);
		assert.equal(failures[0].sdkMissing, true);
		// The CLI's own text distinguishes "no SDK" from "SDK too old".
		assert.match(failures[0].message, /\.NET SDK is required/);
	});

	it('reports a too-old SDK using the CLI wording', async () => {
		const { adapter, failures } = createAdapter([
			{
				cancelled: false,
				code: 3,
				parsed: { ok: false, error: 'The .NET SDK 8.0.100 or newer is required.' }
			}
		]);

		await loadWinUiTemplates(adapter);

		assert.equal(failures[0].message, 'The .NET SDK 8.0.100 or newer is required.');
		assert.equal(failures[0].sdkMissing, true);
	});

	it('installs the latest pack when asked, without probing installed first', async () => {
		const { adapter, requested, progress } = createAdapter([ok()]);

		const loaded = await loadWinUiTemplates(adapter, 'latest');

		// 'latest' was an explicit user choice, so both answers now name the same
		// pack and the follow-up question must not be asked again.
		assert.deepEqual(loaded, { list: parsedOk.value, freshlyInstalled: false });
		assert.deepEqual(requested, ['latest']);
		assert.match(progress[0], /Installing the latest/);
	});

	it('returns undefined when the first attempt is cancelled', async () => {
		const { adapter, requested, failures } = createAdapter([
			{ cancelled: true, code: null }
		]);

		const loaded = await loadWinUiTemplates(adapter);

		assert.equal(loaded, undefined);
		// Cancelling is not a failure, so nothing is reported to the user.
		assert.equal(failures.length, 0);
		assert.deepEqual(requested, ['installed']);
	});

	it('returns undefined when the fallback attempt is cancelled', async () => {
		const { adapter, failures } = createAdapter([
			noPack(),
			{ cancelled: true, code: null }
		]);

		const loaded = await loadWinUiTemplates(adapter);

		assert.equal(loaded, undefined);
		assert.equal(failures.length, 0);
	});

	it('reports the CLI error when the fallback fails', async () => {
		const { adapter, failures } = createAdapter([
			noPack(),
			{
				cancelled: false,
				code: 4,
				parsed: { ok: false, error: 'Failed to install the WinUI template pack.' }
			}
		]);

		const loaded = await loadWinUiTemplates(adapter);

		assert.equal(loaded, undefined);
		assert.equal(failures.length, 1);
		assert.equal(failures[0].message, 'Failed to install the WinUI template pack.');
		// Not an SDK problem, so it must not get the "Install .NET SDK" call to action.
		assert.equal(failures[0].sdkMissing, false);
	});

	it('treats a non-zero exit with a parsable payload as a failure', async () => {
		const { adapter, failures } = createAdapter([
			noPack(),
			{ cancelled: false, code: 5, parsed: parsedOk }
		]);

		const loaded = await loadWinUiTemplates(adapter);

		// A payload that parsed is not enough — the exit code still has to be 0.
		assert.equal(loaded, undefined);
		assert.equal(failures.length, 1);
	});

	// Only "no pack installed" (exit 4) can be fixed by retrying unpinned. Any
	// other probe failure would fail again identically, but behind an
	// "Installing the WinUI templates..." progress message promising work the
	// retry can never do. These pin that the retry stays narrowly scoped.

	it('does not retry when the CLI cannot be run at all', async () => {
		// spawn failure: no exit code, and the empty output fails to parse.
		const { adapter, requested, failures } = createAdapter([
			{
				cancelled: false,
				code: null,
				parsed: { ok: false, error: 'Could not read the template list from the WinApp CLI.' }
			}
		]);

		const loaded = await loadWinUiTemplates(adapter);

		assert.equal(loaded, undefined);
		// One attempt only — a second spawn would fail exactly the same way.
		assert.deepEqual(requested, ['installed']);
		assert.equal(failures.length, 1);
		assert.match(failures[0].message, /Could not read the template list/);
		assert.equal(failures[0].sdkMissing, false);
	});

	it('does not retry when the probe succeeds but its output is unreadable', async () => {
		// Exit 0 with a payload that could not be parsed: the pack question is
		// settled (the probe worked), so installing a pack is not the answer.
		const { adapter, requested, failures } = createAdapter([
			{
				cancelled: false,
				code: 0,
				parsed: { ok: false, error: 'Could not read the template list from the WinApp CLI.' }
			}
		]);

		const loaded = await loadWinUiTemplates(adapter);

		assert.equal(loaded, undefined);
		assert.deepEqual(requested, ['installed']);
		assert.equal(failures.length, 1);
	});

	it('does not retry when the probe reports invalid arguments', async () => {
		const { adapter, requested, failures } = createAdapter([
			{
				cancelled: false,
				code: 2,
				parsed: { ok: false, error: 'Unrecognized option.' }
			}
		]);

		const loaded = await loadWinUiTemplates(adapter);

		assert.equal(loaded, undefined);
		assert.deepEqual(requested, ['installed']);
		assert.equal(failures.length, 1);
		assert.equal(failures[0].message, 'Unrecognized option.');
	});

	it('falls back to a generic message when a failing probe has no payload', async () => {
		const { adapter, failures } = createAdapter([
			{ cancelled: false, code: 5 }
		]);

		const loaded = await loadWinUiTemplates(adapter);

		assert.equal(loaded, undefined);
		// describeNewFailure supplies the wording when the CLI said nothing usable.
		assert.equal(failures.length, 1);
		assert.equal(failures[0].message, describeNewFailure(5, undefined));
		assert.equal(failures[0].sdkMissing, false);
	});
});
