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
	MAX_PROJECT_NAME_LENGTH,
	parseScaffoldResult,
	parseTemplateList,
	sortTemplates,
	validateProjectName,
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

	it('accepts a name containing dots that is not a reserved device', () => {
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

	it('rejects other invalid filename characters', () => {
		for (const name of ['a<b', 'a>b', 'a:b', 'a"b', 'a|b', 'a?b', 'a*b']) {
			assert.ok(validateProjectName(name), `expected "${name}" to be rejected`);
		}
	});

	it('rejects option-shaped names that dotnet new would parse as a flag', () => {
		assert.ok(validateProjectName('--force'));
		assert.ok(validateProjectName('-n'));
	});

	it('rejects trailing dots and spaces, which Windows silently strips', () => {
		assert.ok(validateProjectName('MyApp.'));
		assert.ok(validateProjectName('MyApp '));
	});

	it('rejects reserved device names regardless of extension', () => {
		assert.ok(validateProjectName('CON'));
		assert.ok(validateProjectName('con'));
		assert.ok(validateProjectName('CON.txt'));
		assert.ok(validateProjectName('LPT1'));
		assert.ok(validateProjectName('NUL.anything'));
	});

	it('does not reject names that merely start with a reserved prefix', () => {
		assert.equal(validateProjectName('Console'), undefined);
		assert.equal(validateProjectName('Contoso'), undefined);
	});

	it('enforces the maximum length that leaves room for ".csproj"', () => {
		assert.equal(validateProjectName('a'.repeat(MAX_PROJECT_NAME_LENGTH)), undefined);
		assert.ok(validateProjectName('a'.repeat(MAX_PROJECT_NAME_LENGTH + 1)));
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
