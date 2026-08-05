import {
	test,
	expect,
	_electron as electron,
	type ElectronApplication,
	type Page
} from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const VSCODE_EXE =
	process.env.VSCODE_PATH ??
	path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe');
const EXTENSION_ROOT = path.resolve(__dirname, '..', '..', '..');
const EXTENSION_ARGS = process.env.E2E_USE_INSTALLED_EXTENSION === '1'
	? []
	: [`--extensionDevelopmentPath=${EXTENSION_ROOT}`];
const pendingApps = new Set<ElectronApplication>();
const pendingDirectories = new Set<string>();

async function cleanupPendingResources(): Promise<void> {
	const cleanupErrors: unknown[] = [];
	for (const app of pendingApps) {
		try {
			await app.close();
			pendingApps.delete(app);
		} catch (error) {
			cleanupErrors.push(new Error('Failed to close input-folder E2E application', { cause: error }));
		}
	}
	for (const directory of pendingDirectories) {
		try {
			await fs.promises.rm(directory, {
				recursive: true,
				force: true,
				maxRetries: 20,
				retryDelay: 250
			});
			pendingDirectories.delete(directory);
		} catch (error) {
			cleanupErrors.push(new Error(`Failed to remove E2E directory ${directory}`, { cause: error }));
		}
	}
	if (cleanupErrors.length > 0) {
		throw new AggregateError(cleanupErrors, 'Input-folder E2E cleanup failed');
	}
}

test.afterEach(cleanupPendingResources);
test.afterAll(cleanupPendingResources);

async function waitForReadyWorkbench(page: Page): Promise<void> {
	await expect(page.locator('.monaco-workbench')).toBeVisible({ timeout: 20_000 });
	await expect(page.locator('.tab.active')).toContainText('README.txt', { timeout: 20_000 });

	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Visual Studio Code' });
	const welcomeAppeared = await welcomeDialog.waitFor({ state: 'visible', timeout: 5_000 })
		.then(() => true, () => false);
	if (welcomeAppeared) {
		await welcomeDialog.getByRole('button', { name: 'Close' }).click();
		await expect(welcomeDialog).toBeHidden({ timeout: 5_000 });
	}
	await expect(page.getByRole('dialog').filter({ visible: true })).toHaveCount(0, { timeout: 5_000 });

	await page.keyboard.press('Control+Shift+D');
	await expect(page.getByRole('button', { name: /Debug Launch Configurations: Invalid input folder/ }))
		.toBeVisible({ timeout: 10_000 });
	await expect(page.getByRole('button', { name: /Start Debugging \(F5\)/ })).toBeEnabled();
}

test('invalid inputFolder offers to open its debug configuration', async () => {
	const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'input-folder-e2e-'));
	pendingDirectories.add(workspacePath);
	const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'input-folder-e2e-user-'));
	pendingDirectories.add(userDataPath);
	const vscodePath = path.join(workspacePath, '.vscode');
	const launchJsonPath = path.join(vscodePath, 'launch.json');
	const readmePath = path.join(workspacePath, 'README.txt');
	const sourceMarker = 'INPUT_FOLDER_E2E_WORKSPACE_LAUNCH';
	fs.mkdirSync(vscodePath);
	fs.writeFileSync(readmePath, 'Input folder validation test');
	fs.writeFileSync(launchJsonPath, JSON.stringify({
		version: '0.2.0',
		configurations: [{
			type: 'winapp',
			request: 'launch',
			name: 'Invalid input folder',
			debuggerType: 'node',
			inputFolder: path.join(workspacePath, 'missing-build-output'),
			e2eSourceMarker: sourceMarker
		}]
	}, null, 2));

	const app = await electron.launch({
		executablePath: VSCODE_EXE,
		args: [
			workspacePath,
			readmePath,
			'--new-window',
			`--user-data-dir=${userDataPath}`,
			...EXTENSION_ARGS,
			'--disable-telemetry',
			'--skip-release-notes',
			'--disable-workspace-trust'
		],
		timeout: 30_000
	});
	pendingApps.add(app);

	const page = await app.firstWindow();
	await page.waitForLoadState('domcontentloaded');
	await waitForReadyWorkbench(page);

	const notification = page.locator('.notification-toast')
		.filter({ hasText: 'The configured "inputFolder" path does not exist' });
	await page.keyboard.press('F5');
	await expect(notification).toBeVisible({ timeout: 20_000 });

	const debugToolbar = page.locator('.debug-toolbar');
	await expect(debugToolbar).toBeHidden();
	await expect(debugToolbar.getByRole('button').filter({ visible: true })).toHaveCount(0);
	const startDebugging = page.getByRole('button', { name: /Start Debugging \(F5\)/ });
	await expect(startDebugging).toBeVisible();
	await expect(startDebugging).toBeEnabled();

	const action = notification.getByText('Open debug configuration', { exact: true });
	await expect(action).toBeVisible();
	await action.click();

	await expect(page.locator('.tab.active')).toContainText('launch.json', { timeout: 10_000 });
	await expect(page.locator('.editor-group-container.active .view-lines'))
		.toContainText(sourceMarker, { timeout: 10_000 });
});
