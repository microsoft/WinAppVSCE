import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { escapePowerShellArg } from '../shell-escape';

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
