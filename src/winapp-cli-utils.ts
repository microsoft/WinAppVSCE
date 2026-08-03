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

export function resolveWindowsPowerShellPath(systemRoot: string | undefined): string {
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

/**
 * Matches a fully qualified Windows path: a drive letter, a colon, and a
 * separator (`C:\out`, `c:/out`). Drive-relative values like `C:out` have no
 * separator after the colon and deliberately do not match.
 */
const WINDOWS_FULLY_QUALIFIED = /^[a-zA-Z]:[\\/]/;

/** Matches a Windows drive-relative path such as `C:out` or `D:..\sibling`. */
const WINDOWS_DRIVE_RELATIVE = /^[a-zA-Z]:(?![\\/])/;

/**
 * Resolves the debug session's working directory against the workspace folder.
 *
 * `workingDirectory` comes straight from launch.json, so it may be relative
 * (`"./out"`), root-relative (`"\out"`), fully qualified (`"C:\out"`), or
 * drive-relative (`"C:out"`). Passing a relative value to `spawn` resolves it
 * against the extension host's `process.cwd()` rather than the workspace, so
 * the app launches from an unrelated directory.
 *
 * Only fully qualified paths are returned untouched. Root-relative paths keep
 * their leading separator but are anchored to the workspace drive, since
 * `path.isAbsolute('\\out')` is true on Windows even though the value names no
 * drive and would otherwise follow whichever drive the extension host happens
 * to be on.
 *
 * Drive-relative paths are rejected: `C:out` means "the current directory of
 * drive C:", which is per-process state this extension cannot observe or
 * control, so any resolution would be a guess that silently differs from what
 * the user typed.
 *
 * @param workspacePath Absolute path to the workspace folder.
 * @param workingDirectory The launch.json `workingDirectory` value, if set.
 * @returns An absolute directory to use as the spawn cwd.
 * @throws If `workingDirectory` is drive-relative.
 */
export function resolveWorkingDirectory(workspacePath: string, workingDirectory?: string): string {
	if (!workingDirectory) {
		return workspacePath;
	}

	// POSIX: isAbsolute is enough. Windows: require a drive so that "\out"
	// falls through to be re-anchored on the workspace drive below.
	if (path.sep === '/') {
		if (path.isAbsolute(workingDirectory)) {
			return workingDirectory;
		}
		return path.resolve(workspacePath, workingDirectory);
	}

	if (WINDOWS_FULLY_QUALIFIED.test(workingDirectory)) {
		return workingDirectory;
	}

	if (WINDOWS_DRIVE_RELATIVE.test(workingDirectory)) {
		throw new Error(
			`launch.json "workingDirectory" value "${workingDirectory}" is drive-relative. ` +
			'Drive-relative paths depend on the per-process current directory of that drive, ' +
			'so they cannot be resolved reliably. Use a path relative to the workspace ' +
			`(for example "${workingDirectory.slice(2) || '.'}") or a fully qualified path ` +
			`(for example "${workingDirectory.slice(0, 2)}\\${workingDirectory.slice(2)}").`
		);
	}

	// Root-relative ("\out") and plain relative ("out", "../sibling") values both
	// resolve against the workspace, which pins the drive to the workspace drive.
	return path.resolve(workspacePath, workingDirectory);
}
