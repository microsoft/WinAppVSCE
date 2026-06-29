/**
 * Helpers for safely composing command lines that are dispatched through a
 * PowerShell terminal.
 */

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
