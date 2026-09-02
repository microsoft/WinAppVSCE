import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const srcRoot = path.resolve(__dirname, '..');
const localePinnedLearnUrl = /learn\.microsoft\.com\/[a-z]{2}-[a-z]{2}\//i;

function collectSourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (entry === 'node_modules' || entry === 'test') {
				continue;
			}
			files.push(...collectSourceFiles(full));
		} else if (entry.endsWith('.ts')) {
			files.push(full);
		}
	}
	return files;
}

describe('Microsoft Learn documentation links', () => {
	it('never pins a locale segment so readers get their own language', () => {
		const offenders = collectSourceFiles(srcRoot).filter((file) =>
			localePinnedLearnUrl.test(readFileSync(file, 'utf8'))
		);
		assert.deepEqual(
			offenders.map((file) => path.relative(srcRoot, file)),
			[]
		);
	});
});
