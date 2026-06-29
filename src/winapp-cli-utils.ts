import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const WINAPP_CLI_CALLER_VALUE = 'vscode-extension';

/**
 * Get the path to the bundled winapp CLI executable.
 * Looks in the extension's bin/ directory first (by architecture),
 * then falls back to development paths and the system PATH.
 */
export function getWinappCliPath(extensionPath: string): string {
	const arch = os.arch() === 'arm64' ? 'win-arm64' : 'win-x64';

	const onDiskPaths = [
		// Bundled in extension (production)
		path.join(extensionPath, 'bin', arch, 'winapp.exe'),
		// Downloaded CLI binaries for local development (via npm run download-cli)
		path.join(extensionPath, '..', 'bin', arch, 'winapp.exe'),
	];

	// Return the first on-disk path that exists, otherwise fall back to 'winapp' on the system PATH
	return onDiskPaths.find((p) => fs.existsSync(p)) || 'winapp';
}

/**
 * Quote a value so PowerShell treats it as a single literal argument.
 *
 * WinApp CLI commands are dispatched through a PowerShell terminal via
 * `Terminal.sendText`, so any value interpolated into the command line is
 * parsed by PowerShell. Inside a double-quoted string PowerShell still expands
 * `$(...)`, `$var` and backtick escapes, which lets a crafted file path inject
 * arbitrary commands (e.g. a path containing `$(Remove-Item ...)`). A
 * single-quoted PowerShell literal performs no such expansion; the only
 * metacharacter is the single quote itself, which is escaped by doubling it.
 *
 * @param value The raw argument (typically a user-selected file path).
 * @returns The value wrapped in a single-quoted PowerShell literal.
 */
export function escapePowerShellArg(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}
