import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	buildListArgs,
	buildNewArgs,
	describeNewFailure,
	formatTemplateTags,
	isNonEmptyOutputFailure,
	isSdkMissingExit,
	loadWinUiTemplates,
	parseScaffoldResult,
	parseTemplateList,
	type TemplateListAttempt,
	type TemplateListResult,
	type TemplateLoadAdapter
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

	it('falls back to whatever the CLI printed when there is no JSON payload', () => {
		const message = describeNewFailure(3, undefined, '  The .NET SDK 8.0 or later is required.\n');
		assert.equal(message, 'The .NET SDK 8.0 or later is required.');
	});

	it('does not surface raw output when a payload parsed but carried no error', () => {
		// The output here is the JSON blob itself, which is not a user-facing message.
		const message = describeNewFailure(5, { created: false }, '{"Created":false}');
		assert.equal(message, 'The WinApp CLI failed to create the app (exit code 5).');
	});

	it('names the exit code when the CLI said nothing at all', () => {
		assert.equal(
			describeNewFailure(4, undefined, '   '),
			'The WinApp CLI failed to create the app (exit code 4).'
		);
		assert.ok(describeNewFailure(null, undefined).includes('unknown'));
	});
});

describe('isSdkMissingExit', () => {
	it('identifies the sdk-missing exit code', () => {
		assert.equal(isSdkMissingExit(3), true);
		assert.equal(isSdkMissingExit(2), false);
		assert.equal(isSdkMissingExit(null), false);
	});
});

describe('isNonEmptyOutputFailure', () => {
	// Verbatim from winappcli 0.6.1 for a non-empty --output.
	const nonEmpty = {
		created: false,
		error: "Output directory 'C:\\src\\App' is not empty. Use --force to scaffold into it anyway."
	};

	it('identifies the one failure a --force retry can fix', () => {
		assert.equal(isNonEmptyOutputFailure(2, nonEmpty), true);
	});

	it('does not offer a retry for other invalid-argument failures', () => {
		// An invalid name is exit 2 as well, but --force will never fix it.
		assert.equal(
			isNonEmptyOutputFailure(2, {
				created: false,
				error: "Invalid name 'CON'. Use a simple name without path separators or invalid filename characters."
			}),
			false
		);
	});

	it('does not offer a retry for other exit codes or a missing payload', () => {
		assert.equal(isNonEmptyOutputFailure(3, nonEmpty), false);
		assert.equal(isNonEmptyOutputFailure(5, nonEmpty), false);
		assert.equal(isNonEmptyOutputFailure(2, undefined), false);
		assert.equal(isNonEmptyOutputFailure(2, { created: false }), false);
		assert.equal(isNonEmptyOutputFailure(null, nonEmpty), false);
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
