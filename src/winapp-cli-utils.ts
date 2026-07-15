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

export function getWindowsPowerShellPath(systemRoot?: string): string {
	return path.join(systemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function isUsableElevatedCliPath(cliPath: string, cliPathExists: boolean): boolean {
	return path.isAbsolute(cliPath) && path.basename(cliPath).toLowerCase() === 'winapp.exe' && cliPathExists;
}

export type ElevatedWinappCommandDecision =
	| { kind: 'run-normally' }
	| { kind: 'run-elevated'; command: string }
	| { kind: 'error-cli-missing' };

export function decideElevatedWinappCommand(
	isElevated: boolean,
	cliPathIsUsable: boolean,
	cliPath: string,
	cliArgs: string,
	workingDirectory: string,
	launcherPath: string
): ElevatedWinappCommandDecision {
	if (!cliPathIsUsable) {
		return { kind: 'error-cli-missing' };
	}

	if (isElevated) {
		return { kind: 'run-normally' };
	}

	return { kind: 'run-elevated', command: buildElevatedTerminalCommand(cliPath, cliArgs, workingDirectory, launcherPath) };
}

/**
 * Build a PowerShell command that runs the winapp CLI elevated in a *separate*
 * console via `Start-Process -Verb RunAs`.
 *
 * VS Code cannot create an elevated integrated terminal (there is no extension
 * API for it, by design). Commands that need administrator rights — notably
 * `cert install`, which trusts a certificate in the machine store — are
 * therefore launched in a new UAC-elevated PowerShell window. `-NoExit` keeps
 * that window open so the user can read the result and any errors.
 *
 * The elevated shell is pointed at `workingDirectory` with `Set-Location`
 * before invoking the CLI. A RunAs-elevated process otherwise starts in
 * `System32`, which would break commands that rely on the working directory
 * (e.g. `cert generate` infers the publisher from the manifest in the current
 * directory and writes `devcert.pfx` there). `Set-Location` is used instead of
 * `Start-Process -WorkingDirectory` because the latter is ignored with `-Verb`
 * on Windows PowerShell 5.1.
 *
 * The working directory, CLI path, and the composed command are all quoted with
 * {@link escapePowerShellArg}, so values containing single quotes stay balanced
 * and cannot break out of the literal.
 *
 * @param launcherPath Absolute path to Windows PowerShell for the elevated launcher.
 * @param cliPath Path to the bundled winapp executable.
 * @param cliArgs The winapp arguments, already PowerShell-escaped where needed
 *                (e.g. `cert install 'C:\path\devcert.pfx'`).
 * @param workingDirectory Directory to run the elevated command in.
 * @returns A PowerShell command line to send to a (non-elevated) terminal.
 */
export function buildElevatedTerminalCommand(cliPath: string, cliArgs: string, workingDirectory: string, launcherPath: string): string {
	const innerCommand = `Set-Location -LiteralPath ${escapePowerShellArg(workingDirectory)}; & ${escapePowerShellArg(cliPath)} ${cliArgs}`.trim();
	return `Start-Process -FilePath ${escapePowerShellArg(launcherPath)} -Verb RunAs -ArgumentList '-NoExit', '-Command', ${escapePowerShellArg(innerCommand)}`;
}
