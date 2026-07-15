import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { escapePowerShellArg, buildElevatedTerminalCommand } from '../winapp-cli-utils';

describe('escapePowerShellArg', () => {
	it('wraps an ordinary path in single quotes', () => {
		assert.equal(escapePowerShellArg('C:\\apps\\my app'), "'C:\\apps\\my app'");
	});

	it('does not expand subexpression syntax', () => {
		// A double-quoted PowerShell string would evaluate $(...) — a single-quoted
		// literal must keep it verbatim so the path cannot run commands.
		const malicious = 'C:\\$(Remove-Item -Recurse C:\\)';
		assert.equal(escapePowerShellArg(malicious), `'${malicious}'`);
	});

	it('does not expand variables or backtick escapes', () => {
		assert.equal(escapePowerShellArg('$env:USERPROFILE'), "'$env:USERPROFILE'");
		assert.equal(escapePowerShellArg('a`nb'), "'a`nb'");
	});

	it('escapes an embedded single quote by doubling it', () => {
		assert.equal(escapePowerShellArg("O'Brien.pfx"), "'O''Brien.pfx'");
	});

	it('escapes a single quote used to break out of the literal', () => {
		// Attempt to close the quote and append a statement.
		const attack = "'; Remove-Item C:\\ #";
		const escaped = escapePowerShellArg(attack);
		assert.equal(escaped, "'''; Remove-Item C:\\ #'");
		// The result is a single balanced literal: every quote is paired.
		assert.equal((escaped.match(/'/g) || []).length % 2, 0);
	});

	it('handles an empty string', () => {
		assert.equal(escapePowerShellArg(''), "''");
	});
});

describe('buildElevatedTerminalCommand', () => {
	it('launches an elevated PowerShell window that runs the winapp CLI in the working directory', () => {
		const result = buildElevatedTerminalCommand(
			'C:\\ext\\bin\\winapp.exe',
			"cert install 'C:\\proj\\devcert.pfx'",
			'C:\\proj'
		);
		assert.equal(
			result,
			"Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList '-NoExit', '-Command', " +
			"'Set-Location -LiteralPath ''C:\\proj''; & ''C:\\ext\\bin\\winapp.exe'' cert install ''C:\\proj\\devcert.pfx'''"
		);
	});

	it('requests elevation via the RunAs verb and keeps the window open', () => {
		const result = buildElevatedTerminalCommand('winapp', 'cert generate --install', 'C:\\proj');
		assert.match(result, /-Verb RunAs/);
		assert.match(result, /-NoExit/);
	});

	it('sets the elevated working directory so RunAs does not default to System32', () => {
		const result = buildElevatedTerminalCommand('winapp', 'cert generate', 'C:\\my proj');
		// Doubled quotes because Set-Location sits inside the outer -Command literal.
		assert.match(result, /Set-Location -LiteralPath ''C:\\my proj''/);
	});

	it('doubles single quotes in the CLI path so it cannot break out of the literal', () => {
		const result = buildElevatedTerminalCommand("C:\\o'brien\\winapp.exe", 'cert generate', 'C:\\proj');
		// The path's quote is doubled once for the inner call and again for the
		// outer -Command literal, leaving every quote in the line balanced.
		assert.equal((result.match(/'/g) || []).length % 2, 0);
		assert.ok(result.includes("o''''brien"));
	});

	it('keeps a quote-injection attempt in the args inert', () => {
		const attack = escapePowerShellArg("'; Remove-Item C:\\ #");
		const result = buildElevatedTerminalCommand('winapp', `cert install ${attack}`, 'C:\\proj');
		// Every quote is paired: the injection stays inside a single literal.
		assert.equal((result.match(/'/g) || []).length % 2, 0);
	});
});
