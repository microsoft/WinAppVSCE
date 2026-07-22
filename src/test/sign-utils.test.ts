import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findWorkspaceArtifacts, buildSignCommand, SIGNABLE_ARTIFACT_GLOBS, CERTIFICATE_GLOBS } from '../sign-utils';

function createTempDir(): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'winapp-sign-utils-')));
}

function removeTempDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

function createFile(filePath: string, mtimeMs?: number): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, '');
	if (mtimeMs !== undefined) {
		const time = new Date(mtimeMs);
		fs.utimesSync(filePath, time, time);
	}
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		removeTempDir(dir);
	}
});

describe('findWorkspaceArtifacts', () => {
	it('discovers .msix, .msixbundle, .appx, and .appxbundle files', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		createFile(path.join(tempDir, 'a.msix'));
		createFile(path.join(tempDir, 'b.msixbundle'));
		createFile(path.join(tempDir, 'c.appx'));
		createFile(path.join(tempDir, 'd.appxbundle'));

		const results = await findWorkspaceArtifacts(tempDir, SIGNABLE_ARTIFACT_GLOBS);

		assert.deepEqual(
			results.map(filePath => path.basename(filePath)).sort(),
			['a.msix', 'b.msixbundle', 'c.appx', 'd.appxbundle']
		);
	});

	it('sorts artifacts by newest mtime first', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const older = path.join(tempDir, 'older.msix');
		const newest = path.join(tempDir, 'newest.msixbundle');
		const middle = path.join(tempDir, 'middle.appx');
		createFile(older, 1_700_000_000_000);
		createFile(newest, 1_700_000_000_200);
		createFile(middle, 1_700_000_000_100);

		const results = await findWorkspaceArtifacts(tempDir, SIGNABLE_ARTIFACT_GLOBS);

		assert.deepEqual(results, [newest, middle, older]);
	});

	it('tolerates stat failures by pushing those files to the end', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const stable = path.join(tempDir, 'stable.msix');
		const missing = path.join(tempDir, 'missing.appx');
		createFile(stable, 1_700_000_000_100);
		createFile(missing, 1_700_000_000_200);

		const promisesFs = fs.promises as { stat: typeof fs.promises.stat };
		const originalStat = promisesFs.stat;
		promisesFs.stat = (async (targetPath: fs.PathLike) => {
			if (path.resolve(String(targetPath)) === missing) {
				throw new Error('ENOENT');
			}
			return originalStat(targetPath);
		}) as typeof fs.promises.stat;

		try {
			const results = await findWorkspaceArtifacts(tempDir, SIGNABLE_ARTIFACT_GLOBS);
			assert.deepEqual(results, [stable, missing]);
		} finally {
			promisesFs.stat = originalStat;
		}
	});

	it('returns an empty array for an empty workspace', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);

		const results = await findWorkspaceArtifacts(tempDir, SIGNABLE_ARTIFACT_GLOBS);

		assert.deepEqual(results, []);
	});

	it('discovers files in subdirectories', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const nested = path.join(tempDir, 'artifacts', 'release', 'app.msix');
		createFile(nested);

		const results = await findWorkspaceArtifacts(tempDir, SIGNABLE_ARTIFACT_GLOBS);

		assert.deepEqual(results, [nested]);
	});

	it('excludes node_modules and .git directories', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const included = path.join(tempDir, 'out', 'app.msix');
		createFile(included);
		createFile(path.join(tempDir, 'node_modules', 'pkg', 'ignored.msix'));
		createFile(path.join(tempDir, '.git', 'objects', 'ignored.appx'));

		const results = await findWorkspaceArtifacts(tempDir, SIGNABLE_ARTIFACT_GLOBS);

		assert.deepEqual(results, [included]);
	});
});

describe('findWorkspaceArtifacts with CERTIFICATE_GLOBS', () => {
	it('discovers .pfx certificate files', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		createFile(path.join(tempDir, 'devcert.pfx'));
		createFile(path.join(tempDir, 'certs', 'prod.pfx'));

		const results = await findWorkspaceArtifacts(tempDir, CERTIFICATE_GLOBS);

		assert.deepEqual(
			results.map(filePath => path.basename(filePath)).sort(),
			['devcert.pfx', 'prod.pfx']
		);
	});

	it('does not discover non-pfx files', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		createFile(path.join(tempDir, 'app.msix'));
		createFile(path.join(tempDir, 'cert.pem'));

		const results = await findWorkspaceArtifacts(tempDir, CERTIFICATE_GLOBS);

		assert.deepEqual(results, []);
	});

	it('excludes node_modules certificates', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const included = path.join(tempDir, 'devcert.pfx');
		createFile(included);
		createFile(path.join(tempDir, 'node_modules', 'pkg', 'test.pfx'));

		const results = await findWorkspaceArtifacts(tempDir, CERTIFICATE_GLOBS);

		assert.deepEqual(results, [included]);
	});
});

describe('buildSignCommand', () => {
	it('produces positional arguments: sign <file> <cert>', () => {
		const result = buildSignCommand('C:\\out\\app.msix', 'C:\\certs\\dev.pfx');
		assert.equal(result, "sign 'C:\\out\\app.msix' 'C:\\certs\\dev.pfx'");
	});

	it('does not use --cert flag', () => {
		const result = buildSignCommand('app.msix', 'cert.pfx');
		assert.ok(!result.includes('--cert'), `Expected no --cert flag, got: ${result}`);
	});

	it('escapes paths containing single quotes', () => {
		const result = buildSignCommand("C:\\O'Brien\\app.msix", 'cert.pfx');
		assert.ok(result.includes('sign'), 'Command should start with sign');
		assert.ok(result.includes("O''Brien"), 'Single quote in path should be escaped');
	});

	it('handles paths with spaces', () => {
		const result = buildSignCommand('C:\\My Apps\\app.msix', 'C:\\My Certs\\dev.pfx');
		assert.ok(result.includes('My Apps'), 'Space in file path should be preserved');
		assert.ok(result.includes('My Certs'), 'Space in cert path should be preserved');
	});
});
