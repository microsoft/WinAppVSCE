import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
	detectProjectAt,
	detectProjects,
	getProjectLabel,
	getDisplayFilePath,
	DetectedProject,
	filterBuildOutputFiles,
	deduplicateBuildOutputFolders,
	BUILD_OUTPUT_EXECUTABLE_GLOB,
	BUILD_OUTPUT_LIBRARY_GLOB,
	BUILD_OUTPUT_CONVENTIONAL_EXECUTABLE_GLOB,
	BUILD_OUTPUT_CONVENTIONAL_LIBRARY_GLOB,
	BUILD_OUTPUT_MAX_DEPTH,
	BUILD_OUTPUT_MAX_RESULTS,
	BUILD_OUTPUT_MAX_SCAN_RESULTS,
	discoverBuildOutputFiles,
	discoverBuildOutputFolders,
	getBuildOutputScanLimit,
	rankBuildOutputFiles,
	rankBuildOutputFolders
} from '../project-detection';

/**
 * Creates a temporary directory for test fixtures.
 */
function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'winapp-test-'));
}

/**
 * Recursively removes a directory.
 */
function removeTempDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Creates a file with the given content, creating parent directories as needed.
 */
function createFile(filePath: string, content: string = ''): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

describe('project-detection', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createTempDir();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	describe('detectProjectAt', () => {
		it('detects a .NET executable project', async () => {
			createFile(path.join(tempDir, 'MyApp.csproj'), `
				<Project Sdk="Microsoft.NET.Sdk">
					<PropertyGroup>
						<OutputType>Exe</OutputType>
						<TargetFramework>net8.0</TargetFramework>
					</PropertyGroup>
				</Project>
			`);

			const result = await detectProjectAt(tempDir, tempDir);
			assert.ok(result);
			assert.strictEqual(result.type, '.NET');
			assert.strictEqual(result.projectFileName, 'MyApp.csproj');
		});

		it('detects a WinExe .NET project', async () => {
			createFile(path.join(tempDir, 'WpfApp.csproj'), `
				<Project Sdk="Microsoft.NET.Sdk">
					<PropertyGroup>
						<OutputType>WinExe</OutputType>
					</PropertyGroup>
				</Project>
			`);

			const result = await detectProjectAt(tempDir, tempDir);
			assert.ok(result);
			assert.strictEqual(result.type, '.NET');
		});

		it('does not detect a .NET test project', async () => {
			createFile(path.join(tempDir, 'MyApp.Tests.csproj'), `
				<Project Sdk="Microsoft.NET.Sdk">
					<PropertyGroup>
						<OutputType>Exe</OutputType>
						<IsTestProject>true</IsTestProject>
					</PropertyGroup>
				</Project>
			`);

			const result = await detectProjectAt(tempDir, tempDir);
			assert.strictEqual(result, undefined);
		});

		it('does not detect a .NET library project', async () => {
			createFile(path.join(tempDir, 'MyLib.csproj'), `
				<Project Sdk="Microsoft.NET.Sdk">
					<PropertyGroup>
						<TargetFramework>net8.0</TargetFramework>
					</PropertyGroup>
				</Project>
			`);

			const result = await detectProjectAt(tempDir, tempDir);
			assert.strictEqual(result, undefined);
		});

		it('detects an Electron project', async () => {
			createFile(path.join(tempDir, 'package.json'), JSON.stringify({
				name: 'my-electron-app',
				dependencies: { electron: '^28.0.0' }
			}));

			const result = await detectProjectAt(tempDir, tempDir);
			assert.ok(result);
			assert.strictEqual(result.type, 'Electron');
			assert.strictEqual(result.projectFileName, 'package.json');
		});

		it('does not detect a non-Electron package.json', async () => {
			createFile(path.join(tempDir, 'package.json'), JSON.stringify({
				name: 'my-lib',
				dependencies: { express: '^4.0.0' }
			}));

			const result = await detectProjectAt(tempDir, tempDir);
			assert.strictEqual(result, undefined);
		});

		it('detects a Flutter project', async () => {
			createFile(path.join(tempDir, 'pubspec.yaml'), 'name: my_app\n');

			const result = await detectProjectAt(tempDir, tempDir);
			assert.ok(result);
			assert.strictEqual(result.type, 'Flutter');
			assert.strictEqual(result.projectFileName, 'pubspec.yaml');
		});

		it('detects a Rust project', async () => {
			createFile(path.join(tempDir, 'Cargo.toml'), '[package]\nname = "my_app"\n');

			const result = await detectProjectAt(tempDir, tempDir);
			assert.ok(result);
			assert.strictEqual(result.type, 'Rust');
			assert.strictEqual(result.projectFileName, 'Cargo.toml');
		});

		it('detects a C++ project', async () => {
			createFile(path.join(tempDir, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\n');

			const result = await detectProjectAt(tempDir, tempDir);
			assert.ok(result);
			assert.strictEqual(result.type, 'C++');
			assert.strictEqual(result.projectFileName, 'CMakeLists.txt');
		});

		it('detects a Tauri project', async () => {
			createFile(path.join(tempDir, 'src-tauri', 'tauri.conf.json'), '{}');

			const result = await detectProjectAt(tempDir, tempDir);
			assert.ok(result);
			assert.strictEqual(result.type, 'Tauri');
			assert.strictEqual(result.projectFileName, 'src-tauri/tauri.conf.json');
		});

		it('returns undefined for empty directory', async () => {
			const result = await detectProjectAt(tempDir, tempDir);
			assert.strictEqual(result, undefined);
		});

		it('sets displayPath to "." for root directory', async () => {
			createFile(path.join(tempDir, 'Cargo.toml'), '[package]\n');

			const result = await detectProjectAt(tempDir, tempDir);
			assert.ok(result);
			assert.strictEqual(result.displayPath, '.');
		});

		it('sets relative displayPath for nested directory', async () => {
			const nested = path.join(tempDir, 'apps', 'my-app');
			createFile(path.join(nested, 'Cargo.toml'), '[package]\n');

			const result = await detectProjectAt(nested, tempDir);
			assert.ok(result);
			assert.strictEqual(result.displayPath, 'apps/my-app');
		});

		it('prioritizes Tauri over Electron when both markers present', async () => {
			createFile(path.join(tempDir, 'package.json'), JSON.stringify({
				dependencies: { electron: '^28.0.0' }
			}));
			createFile(path.join(tempDir, 'src-tauri', 'tauri.conf.json'), '{}');

			const result = await detectProjectAt(tempDir, tempDir);
			assert.ok(result);
			assert.strictEqual(result.type, 'Tauri');
		});
	});

	describe('detectProjects', () => {
		it('finds multiple projects in different subdirectories', async () => {
			createFile(path.join(tempDir, 'app1', 'Cargo.toml'), '[package]\n');
			createFile(path.join(tempDir, 'app2', 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\n');
			createFile(path.join(tempDir, 'app3', 'pubspec.yaml'), 'name: app3\n');

			const results = await detectProjects(tempDir);
			assert.strictEqual(results.length, 3);
			const types = results.map(r => r.type).sort();
			assert.deepStrictEqual(types, ['C++', 'Flutter', 'Rust']);
		});

		it('respects maxProjects limit', async () => {
			for (let i = 0; i < 5; i++) {
				createFile(path.join(tempDir, `app${i}`, 'Cargo.toml'), '[package]\n');
			}

			const results = await detectProjects(tempDir, 3);
			assert.strictEqual(results.length, 3);
		});

		it('skips node_modules directory', async () => {
			createFile(path.join(tempDir, 'node_modules', 'some-pkg', 'Cargo.toml'), '[package]\n');
			createFile(path.join(tempDir, 'src', 'Cargo.toml'), '[package]\n');

			const results = await detectProjects(tempDir);
			assert.strictEqual(results.length, 1);
			assert.strictEqual(results[0].type, 'Rust');
			assert.ok(results[0].directory.includes('src'));
		});

		it('skips other ignored directories', async () => {
			const ignoredDirs = ['bin', 'obj', 'target', 'dist', 'build', '.git'];
			for (const dir of ignoredDirs) {
				createFile(path.join(tempDir, dir, 'Cargo.toml'), '[package]\n');
			}
			createFile(path.join(tempDir, 'src', 'Cargo.toml'), '[package]\n');

			const results = await detectProjects(tempDir);
			assert.strictEqual(results.length, 1);
			assert.ok(results[0].directory.includes('src'));
		});

		it('skips hidden directories', async () => {
			createFile(path.join(tempDir, '.hidden', 'Cargo.toml'), '[package]\n');
			createFile(path.join(tempDir, 'visible', 'Cargo.toml'), '[package]\n');

			const results = await detectProjects(tempDir);
			assert.strictEqual(results.length, 1);
			assert.ok(results[0].directory.includes('visible'));
		});

		it('does not recurse into detected project directories', async () => {
			// Parent is a Rust project
			createFile(path.join(tempDir, 'app', 'Cargo.toml'), '[package]\n');
			// Nested CMake inside the Rust project should not be found
			createFile(path.join(tempDir, 'app', 'subdir', 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\n');

			const results = await detectProjects(tempDir);
			assert.strictEqual(results.length, 1);
			assert.strictEqual(results[0].type, 'Rust');
		});

		it('detects project at root when present', async () => {
			createFile(path.join(tempDir, 'Cargo.toml'), '[package]\n');
			createFile(path.join(tempDir, 'subdir', 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\n');

			const results = await detectProjects(tempDir);
			// Root project found, so we don't recurse
			assert.strictEqual(results.length, 1);
			assert.strictEqual(results[0].type, 'Rust');
			assert.strictEqual(results[0].displayPath, '.');
		});

		it('returns empty array when no projects exist', async () => {
			createFile(path.join(tempDir, 'readme.md'), '# Hello\n');

			const results = await detectProjects(tempDir);
			assert.strictEqual(results.length, 0);
		});
	});

	describe('getDisplayFilePath', () => {
		it('formats root project path correctly', async () => {
			const project: DetectedProject = {
				type: 'Rust',
				directory: '/some/path',
				displayPath: '.',
				projectFileName: 'Cargo.toml'
			};
			assert.strictEqual(getDisplayFilePath(project), './Cargo.toml');
		});

		it('formats nested project path correctly', async () => {
			const project: DetectedProject = {
				type: '.NET',
				directory: '/some/path/apps/myapp',
				displayPath: 'apps/myapp',
				projectFileName: 'MyApp.csproj'
			};
			assert.strictEqual(getDisplayFilePath(project), './apps/myapp/MyApp.csproj');
		});
	});

	describe('getProjectLabel', () => {
		it('formats label correctly', async () => {
			const project: DetectedProject = {
				type: '.NET',
				directory: '/some/path',
				displayPath: 'src/app',
				projectFileName: 'App.csproj'
			};
			assert.strictEqual(getProjectLabel(project), '.NET project (./src/app/App.csproj)');
		});
	});

	describe('deduplicateBuildOutputFolders', () => {
		const sep = path.sep;
		const root = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';

		it('deduplicates files in the same directory', () => {
			const files = [
				path.join(root, 'bin', 'Debug', 'app.exe'),
				path.join(root, 'bin', 'Debug', 'helper.exe')
			];
			const result = deduplicateBuildOutputFolders(files, root);
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0], path.join(root, 'bin', 'Debug'));
		});

		it('returns multiple folders for files in different directories', () => {
			const files = [
				path.join(root, 'bin', 'Debug', 'app.exe'),
				path.join(root, 'bin', 'Release', 'app.exe')
			];
			const result = deduplicateBuildOutputFolders(files, root);
			assert.strictEqual(result.length, 2);
			assert.ok(result.includes(path.join(root, 'bin', 'Debug')));
			assert.ok(result.includes(path.join(root, 'bin', 'Release')));
		});

		it('filters out directories exceeding max depth', () => {
			// Build a path that exceeds the depth limit
			const segments = Array.from({ length: BUILD_OUTPUT_MAX_DEPTH + 1 }, (_, i) => `d${i}`);
			const deepPath = path.join(root, ...segments, 'app.exe');
			const shallowPath = path.join(root, 'bin', 'app.exe');
			const result = deduplicateBuildOutputFolders([deepPath, shallowPath], root);
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0], path.join(root, 'bin'));
		});

		it('respects custom maxDepth parameter', () => {
			const files = [
				path.join(root, 'a', 'b', 'c', 'app.exe'),  // depth 3
				path.join(root, 'x', 'app.exe')              // depth 1
			];
			const result = deduplicateBuildOutputFolders(files, root, 2);
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0], path.join(root, 'x'));
		});

		it('returns empty array for no input', () => {
			const result = deduplicateBuildOutputFolders([], root);
			assert.strictEqual(result.length, 0);
		});

		it('sorts results by relative path', () => {
			const files = [
				path.join(root, 'z-app', 'app.exe'),
				path.join(root, 'a-app', 'app.exe'),
				path.join(root, 'm-app', 'app.exe')
			];
			const result = deduplicateBuildOutputFolders(files, root);
			assert.deepStrictEqual(result, [
				path.join(root, 'a-app'),
				path.join(root, 'm-app'),
				path.join(root, 'z-app')
			]);
		});

		it('includes files at workspace root (depth 0)', () => {
			const files = [path.join(root, 'app.exe')];
			const result = deduplicateBuildOutputFolders(files, root);
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0], root);
		});
	});

	describe('filterBuildOutputFiles', () => {
		const root = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';

		it('preserves files whose parent folders are within the maximum depth', () => {
			const shallow = path.join(root, 'bin', 'app.dll');
			const atLimit = path.join(
				root,
				...Array.from({ length: BUILD_OUTPUT_MAX_DEPTH }, (_, index) => `d${index}`),
				'app.exe'
			);
			const tooDeep = path.join(
				root,
				...Array.from({ length: BUILD_OUTPUT_MAX_DEPTH + 1 }, (_, index) => `d${index}`),
				'app.dll'
			);

			assert.deepStrictEqual(filterBuildOutputFiles([shallow, atLimit, tooDeep], root), [shallow, atLimit]);
		});
	});

	describe('rankBuildOutputFiles', () => {
		const root = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';

		it('keeps relevant build outputs ahead of unrelated root and tool binaries under the cap', () => {
			const unrelated = [
				...Array.from({ length: 6 }, (_, index) => path.join(root, `tool-${index}.exe`)),
				...Array.from({ length: 6 }, (_, index) => path.join(root, 'tools', `helper-${index}.exe`))
			];
			const buildOutputs = [
				path.join(root, 'src', 'App', 'bin', 'Debug', 'net8.0-windows', 'App.exe'),
				path.join(root, 'out', 'x64', 'Release', 'NativeApp.exe')
			];

			const result = rankBuildOutputFiles([...unrelated, ...buildOutputs], root, 10);

			assert.deepStrictEqual(result.slice(0, 2), buildOutputs);
			assert.strictEqual(result.length, 10);
		});

		it('retains arbitrary shallow output folders as fallback results', () => {
			const conventional = path.join(root, 'bin', 'Release', 'App.dll');
			const custom = path.join(root, 'deliverables', 'Custom.dll');
			const rootBinary = path.join(root, 'helper.dll');

			assert.deepStrictEqual(
				rankBuildOutputFiles([rootBinary, custom, conventional], root, 3),
				[conventional, custom, rootBinary]
			);
		});

		it('uses EXE only as a tie-breaker after build-output relevance', () => {
			const relevantLibrary = path.join(root, 'bin', 'Release', 'App.dll');
			const lessRelevantExecutable = path.join(root, 'deliverables', 'Helper.exe');
			const tiedExecutable = path.join(root, 'bin', 'Release', 'App.exe');

			assert.deepStrictEqual(
				rankBuildOutputFiles([lessRelevantExecutable, relevantLibrary], root, 2),
				[relevantLibrary, lessRelevantExecutable]
			);
			assert.deepStrictEqual(
				rankBuildOutputFiles([relevantLibrary, tiedExecutable], root, 2),
				[tiedExecutable, relevantLibrary]
			);
		});

		it('uses a bounded overfetch limit before ranking', () => {
			assert.strictEqual(getBuildOutputScanLimit(1), 25);
			assert.strictEqual(getBuildOutputScanLimit(10), BUILD_OUTPUT_MAX_SCAN_RESULTS);
			assert.strictEqual(getBuildOutputScanLimit(100), BUILD_OUTPUT_MAX_SCAN_RESULTS);
		});
	});

	describe('discoverBuildOutputFiles', () => {
		const root = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';

		for (const extension of ['exe', 'dll'] as const) {
			it(`surfaces conventional ${extension.toUpperCase()} outputs before a full unrelated fallback`, async () => {
				const preferred = path.join(root, 'src', 'App', 'bin', 'Release', `App.${extension}`);
				const unrelated = Array.from(
					{ length: BUILD_OUTPUT_MAX_SCAN_RESULTS },
					(_, index) => path.join(root, 'deliverables', `unrelated-${index}.${extension}`)
				);
				const calls: string[] = [];

				const result = await discoverBuildOutputFiles(
					root,
					extension,
					10,
					async includeGlob => {
						calls.push(includeGlob);
						return calls.length === 1 ? [preferred] : unrelated;
					}
				);

				assert.strictEqual(
					calls[0],
					extension === 'exe'
						? BUILD_OUTPUT_CONVENTIONAL_EXECUTABLE_GLOB
						: BUILD_OUTPUT_CONVENTIONAL_LIBRARY_GLOB
				);
				assert.strictEqual(calls[1], extension === 'exe'
					? BUILD_OUTPUT_EXECUTABLE_GLOB
					: BUILD_OUTPUT_LIBRARY_GLOB);
				assert.strictEqual(result[0], preferred);
				assert.strictEqual(result.length, 10);
			});
		}

		it('skips fallback discovery when cancellation occurs during the conventional query', async () => {
			let cancelled = false;
			let calls = 0;

			const result = await discoverBuildOutputFiles(
				root,
				'exe',
				10,
				async () => {
					calls++;
					cancelled = true;
					return [path.join(root, 'bin', 'App.exe')];
				},
				() => cancelled
			);

			assert.deepStrictEqual(result, []);
			assert.strictEqual(calls, 1);
		});
	});

	describe('rankBuildOutputFolders', () => {
		const root = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';

		it('deduplicates before applying the folder cap', () => {
			const crowdedFolder = path.join(root, 'bin', 'Debug');
			const files = [
				...Array.from({ length: 20 }, (_, index) => path.join(crowdedFolder, `App-${index}.exe`)),
				path.join(root, 'out', 'Release', 'Native.exe'),
				path.join(root, 'build', 'x64', 'Tool.exe')
			];

			assert.deepStrictEqual(rankBuildOutputFolders(files, root, 3), [
				crowdedFolder,
				path.join(root, 'out', 'Release'),
				path.join(root, 'build', 'x64')
			]);
		});
	});

	describe('discoverBuildOutputFolders', () => {
		const root = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';

		it('discovers unique folders when one conventional folder contains more than 50 executables', async () => {
			const crowdedFolder = path.join(root, 'bin', 'Debug');
			const conventionalFolders = [
				crowdedFolder,
				path.join(root, 'src', 'App2', 'bin', 'Release'),
				path.join(root, 'src', 'App3', 'bin', 'x64'),
				path.join(root, 'src', 'App4', 'bin', 'arm64')
			];
			const fallbackFolders = Array.from(
				{ length: 12 },
				(_, index) => path.join(root, 'deliverables', `app-${index}`)
			);
			const conventionalFiles = [
				...Array.from(
					{ length: 55 },
					(_, index) => path.join(crowdedFolder, `App-${index}.exe`)
				),
				...conventionalFolders.slice(1).map(folder => path.join(folder, 'App.exe'))
			];
			const fallbackFiles = fallbackFolders.map(folder => path.join(folder, 'App.exe'));
			const searches: Array<{ glob: string; excludedFolders: string[] }> = [];

			const result = await discoverBuildOutputFolders(
				root,
				BUILD_OUTPUT_MAX_RESULTS + 5,
				async (includeGlob, scanLimit, excludedFolders = []) => {
					searches.push({ glob: includeGlob, excludedFolders });
					const candidates = includeGlob === BUILD_OUTPUT_CONVENTIONAL_EXECUTABLE_GLOB
						? conventionalFiles
						: fallbackFiles;
					return candidates
						.filter(file => !excludedFolders.includes(path.dirname(file)))
						.slice(0, scanLimit);
				}
			);

			assert.strictEqual(result.length, BUILD_OUTPUT_MAX_RESULTS);
			assert.strictEqual(new Set(result).size, BUILD_OUTPUT_MAX_RESULTS);
			for (const folder of conventionalFolders) {
				assert.ok(result.includes(folder));
			}
			assert.ok(result.some(folder => fallbackFolders.includes(folder)));
			assert.deepStrictEqual(searches[0].excludedFolders, []);
			assert.deepStrictEqual(searches[1].excludedFolders, [crowdedFolder]);
			assert.strictEqual(searches[2].glob, BUILD_OUTPUT_EXECUTABLE_GLOB);
		});

		it('stops and discards candidates when folder discovery is cancelled', async () => {
			let cancelled = false;
			let calls = 0;

			const result = await discoverBuildOutputFolders(
				root,
				10,
				async () => {
					calls++;
					cancelled = true;
					return [path.join(root, 'bin', 'App.exe')];
				},
				() => cancelled
			);

			assert.deepStrictEqual(result, []);
			assert.strictEqual(calls, 1);
		});
	});

	describe('build output binary globs', () => {
		const executableAlternatives = BUILD_OUTPUT_EXECUTABLE_GLOB.slice(1, -1).split(',');
		const libraryAlternatives = BUILD_OUTPUT_LIBRARY_GLOB.slice(1, -1).split(',');

		it('separates EXE and DLL files while covering root and maximum depth', () => {
			assert.ok(executableAlternatives.includes('*.exe'));
			assert.ok(executableAlternatives.includes(`${'*/'.repeat(BUILD_OUTPUT_MAX_DEPTH)}*.exe`));
			assert.ok(!executableAlternatives.some(pattern => pattern.endsWith('.dll')));
			assert.ok(libraryAlternatives.includes('*.dll'));
			assert.ok(libraryAlternatives.includes(`${'*/'.repeat(BUILD_OUTPUT_MAX_DEPTH)}*.dll`));
			assert.ok(!libraryAlternatives.some(pattern => pattern.endsWith('.exe')));
		});

		it('does not express paths beyond the maximum depth', () => {
			assert.strictEqual(executableAlternatives.length, BUILD_OUTPUT_MAX_DEPTH + 1);
			assert.strictEqual(libraryAlternatives.length, BUILD_OUTPUT_MAX_DEPTH + 1);
			assert.ok(!executableAlternatives.includes(`${'*/'.repeat(BUILD_OUTPUT_MAX_DEPTH + 1)}*.exe`));
			assert.ok(!libraryAlternatives.includes(`${'*/'.repeat(BUILD_OUTPUT_MAX_DEPTH + 1)}*.dll`));
		});

		it('targets conventional path segments with depth-bounded patterns', () => {
			assert.ok(BUILD_OUTPUT_CONVENTIONAL_EXECUTABLE_GLOB.includes('{bin,out,build,publish}'));
			assert.ok(BUILD_OUTPUT_CONVENTIONAL_LIBRARY_GLOB.includes('{bin,out,build,publish}'));
			assert.ok(!BUILD_OUTPUT_CONVENTIONAL_EXECUTABLE_GLOB.includes('**'));
			assert.ok(!BUILD_OUTPUT_CONVENTIONAL_LIBRARY_GLOB.includes('**'));
		});
	});
});
