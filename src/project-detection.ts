import * as fsp from 'fs/promises';
import * as path from 'path';

/**
 * Mirrors the C# DetectedProjectType enum from WinApp.Cli.
 */
export type DetectedProjectType = 'Tauri' | 'Electron' | 'Flutter' | '.NET' | 'Rust' | 'C++';

/**
 * Represents a project detected during directory scanning.
 * Mirrors the C# DetectedProject record from WinApp.Cli.
 */
export interface DetectedProject {
	type: DetectedProjectType;
	directory: string;
	displayPath: string;
	projectFileName: string;
}

/**
 * Returns a display string like ".NET project (./src/MyApp/MyApp.csproj)"
 */
export function getDisplayFilePath(project: DetectedProject): string {
	return project.displayPath === '.'
		? `./${project.projectFileName}`
		: `./${project.displayPath}/${project.projectFileName}`;
}

/**
 * Returns a human-readable label like ".NET project (./src/MyApp/MyApp.csproj)"
 */
export function getProjectLabel(project: DetectedProject): string {
	return `${project.type} project (${getDisplayFilePath(project)})`;
}

const SKIP_DIRS = new Set([
	'node_modules', '.git', 'bin', 'obj', 'debug', 'release',
	'.vs', '.vscode', '.idea', 'packages', 'dist', 'build', 'out',
	'target', '.winapp', 'artifacts', 'testresults',
	'__pycache__', '.gradle', '.dart_tool', '.pub-cache', '.nuget', '.cargo'
]);

/**
 * Detects a project at a single directory (does not recurse).
 * Mirrors ProjectDetectionService.DetectProject from WinApp.Cli.
 */
export async function detectProjectAt(directory: string, searchRoot: string): Promise<DetectedProject | undefined> {
	const displayPath = getRelativeDisplayPath(directory, searchRoot);

	// Tauri: check immediate subdirectories for tauri.conf.json
	const tauriConf = await findTauriConfFile(directory);
	if (tauriConf) {
		return { type: 'Tauri', directory, displayPath, projectFileName: tauriConf };
	}

	// Electron: package.json with electron dependency
	if (await isElectronProject(directory)) {
		return { type: 'Electron', directory, displayPath, projectFileName: 'package.json' };
	}

	// Flutter: pubspec.yaml
	if (await fileExists(path.join(directory, 'pubspec.yaml'))) {
		return { type: 'Flutter', directory, displayPath, projectFileName: 'pubspec.yaml' };
	}

	// .NET: *.csproj (only executable, non-test projects)
	const csprojName = await findExecutableCsproj(directory);
	if (csprojName) {
		return { type: '.NET', directory, displayPath, projectFileName: csprojName };
	}

	// Rust: Cargo.toml
	if (await fileExists(path.join(directory, 'Cargo.toml'))) {
		return { type: 'Rust', directory, displayPath, projectFileName: 'Cargo.toml' };
	}

	// C++: CMakeLists.txt
	if (await fileExists(path.join(directory, 'CMakeLists.txt'))) {
		return { type: 'C++', directory, displayPath, projectFileName: 'CMakeLists.txt' };
	}

	return undefined;
}

/**
 * Performs a breadth-first search of the directory tree to find compatible projects.
 * Mirrors ProjectDetectionService.DetectProjectsAsync from WinApp.Cli.
 * Uses async I/O with periodic yielding to keep the UI responsive.
 */
export async function detectProjects(root: string, maxProjects: number = 10): Promise<DetectedProject[]> {
	const results: DetectedProject[] = [];
	const queue: string[] = [root];
	let iterations = 0;

	while (queue.length > 0 && results.length < maxProjects) {
		const current = queue.shift()!;
		const detected = await detectProjectAt(current, root);
		if (detected) {
			results.push(detected);
			// Don't recurse into detected project directories
			continue;
		}

		// Enqueue child directories (skip known non-project dirs)
		try {
			const entries = await fsp.readdir(current, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory() && !entry.isSymbolicLink()) { continue; }
				if (entry.name.startsWith('.') && entry.name !== '.') { continue; }
				if (SKIP_DIRS.has(entry.name.toLowerCase())) { continue; }
				const fullPath = path.join(current, entry.name);
				// Skip symlinks and junctions (reparse points)
				if (entry.isSymbolicLink()) { continue; }
				try {
					const stat = await fsp.stat(fullPath);
					if (!stat.isDirectory()) { continue; }
				} catch {
					continue;
				}
				queue.push(fullPath);
			}
		} catch {
			// Skip directories we can't read
		}

		// Yield to the event loop periodically to keep the UI responsive
		if (++iterations % 50 === 0) {
			await new Promise(resolve => setTimeout(resolve, 0));
		}
	}

	return results;
}

/** Directories to exclude from build-output scanning. */
export const BUILD_OUTPUT_SKIP_DIRS = new Set([
	'node_modules', '.git', 'appx', '.winapp', 'obj', '.vs', 'packages'
]);

/**
 * Maximum depth (in path segments relative to root) for build-output results.
 */
export const BUILD_OUTPUT_MAX_DEPTH = 8;

/**
 * VS Code-compatible globs for signable binaries at supported output depths.
 */
function buildOutputGlob(extension: BuildOutputExtension): string {
	return `{${Array.from(
	{ length: BUILD_OUTPUT_MAX_DEPTH + 1 },
	(_, depth) => `${'*/'.repeat(depth)}*.${extension}`
).join(',')}}`;
}

export type BuildOutputExtension = 'exe' | 'dll';

export const BUILD_OUTPUT_EXECUTABLE_GLOB = buildOutputGlob('exe');
export const BUILD_OUTPUT_LIBRARY_GLOB = buildOutputGlob('dll');

const CONVENTIONAL_OUTPUT_DIRECTORIES = ['bin', 'out', 'build', 'publish'];

/**
 * VS Code-compatible globs that only visit conventional output path segments,
 * while keeping the binary's parent directory within the supported depth.
 */
function buildConventionalOutputGlob(extension: BuildOutputExtension): string {
	const alternatives: string[] = [];
	for (let prefixDepth = 0; prefixDepth < BUILD_OUTPUT_MAX_DEPTH; prefixDepth++) {
		for (let suffixDepth = 0; suffixDepth < BUILD_OUTPUT_MAX_DEPTH - prefixDepth; suffixDepth++) {
			alternatives.push(
				`${'*/'.repeat(prefixDepth)}{${CONVENTIONAL_OUTPUT_DIRECTORIES.join(',')}}/`
				+ `${'*/'.repeat(suffixDepth)}*.${extension}`
			);
		}
	}
	return `{${alternatives.join(',')}}`;
}

export const BUILD_OUTPUT_CONVENTIONAL_EXECUTABLE_GLOB = buildConventionalOutputGlob('exe');
export const BUILD_OUTPUT_CONVENTIONAL_LIBRARY_GLOB = buildConventionalOutputGlob('dll');

/**
 * Maximum number of executable matches to consider before stopping.
 */
export const BUILD_OUTPUT_MAX_RESULTS = 10;

/** Maximum number of binary matches scanned before relevance ranking. */
export const BUILD_OUTPUT_MAX_SCAN_RESULTS = 50;

const BUILD_OUTPUT_OVERFETCH_MIN_RESULTS = 25;
const BUILD_OUTPUT_OVERFETCH_FACTOR = 5;

const OUTPUT_DIRECTORY_SCORES = new Map<string, number>([
	['bin', 100],
	['publish', 95],
	['out', 90],
	['build', 85],
	['dist', 80],
	['artifacts', 75],
	['target', 70]
]);

const CONFIGURATION_SEGMENTS = new Set([
	'debug', 'release', 'relwithdebinfo', 'minsizerel', 'production'
]);

const ARCHITECTURE_SEGMENTS = new Set([
	'x64', 'x86', 'arm64', 'arm', 'win32', 'amd64', 'anycpu'
]);

const TOOLING_SEGMENTS = new Set([
	'tool', 'tools', 'scripts', 'utilities', 'vendor', 'third_party', 'third-party'
]);

/**
 * Returns a bounded scan limit large enough to rank more candidates than the
 * picker can display.
 */
export function getBuildOutputScanLimit(maxResults: number): number {
	if (maxResults <= 0) {
		return 0;
	}
	return Math.min(
		BUILD_OUTPUT_MAX_SCAN_RESULTS,
		Math.max(BUILD_OUTPUT_OVERFETCH_MIN_RESULTS, maxResults * BUILD_OUTPUT_OVERFETCH_FACTOR)
	);
}

function getBuildOutputRelevance(filePath: string, workspacePath: string): number {
	const relativeFolder = path.relative(workspacePath, path.dirname(filePath));
	if (!relativeFolder) {
		return -50;
	}

	let score = 0;
	for (const segment of relativeFolder.split(path.sep).map(value => value.toLowerCase())) {
		score += OUTPUT_DIRECTORY_SCORES.get(segment) ?? 0;
		if (CONFIGURATION_SEGMENTS.has(segment)) {
			score += 20;
		}
		if (ARCHITECTURE_SEGMENTS.has(segment)) {
			score += 10;
		}
		if (/^net\d+(?:\.\d+)?(?:-|$)/.test(segment)) {
			score += 5;
		}
		if (TOOLING_SEGMENTS.has(segment)) {
			score -= 25;
		}
	}
	return score;
}

function compareBuildOutputFiles(left: string, right: string, workspacePath: string): number {
	const scoreDifference = getBuildOutputRelevance(right, workspacePath)
		- getBuildOutputRelevance(left, workspacePath);
	if (scoreDifference !== 0) {
		return scoreDifference;
	}

	const extensionDifference = Number(path.extname(left).toLowerCase() !== '.exe')
		- Number(path.extname(right).toLowerCase() !== '.exe');
	return extensionDifference !== 0
		? extensionDifference
		: path.relative(workspacePath, left).localeCompare(path.relative(workspacePath, right));
}

/**
 * Ranks conventional build-output paths first while retaining arbitrary
 * shallow output directories as deterministic fallback results.
 */
export function rankBuildOutputFiles(
	filePaths: string[],
	workspacePath: string,
	maxResults: number = BUILD_OUTPUT_MAX_RESULTS
): string[] {
	return filterBuildOutputFiles(filePaths, workspacePath)
		.sort((left, right) => compareBuildOutputFiles(left, right, workspacePath))
		.slice(0, maxResults);
}

export type FindBuildOutputMatches = (
	includeGlob: string,
	maxResults: number,
	excludedFolders?: string[]
) => Promise<string[]>;

/**
 * Searches conventional output paths before a bounded shallow fallback, then
 * merges, deduplicates, ranks, and caps the candidates.
 */
export async function discoverBuildOutputFiles(
	workspacePath: string,
	extension: BuildOutputExtension,
	maxResults: number,
	findMatches: FindBuildOutputMatches,
	isCancelled: () => boolean = () => false
): Promise<string[]> {
	if (maxResults <= 0 || isCancelled()) {
		return [];
	}

	const scanLimit = getBuildOutputScanLimit(maxResults);
	const conventionalGlob = extension === 'exe'
		? BUILD_OUTPUT_CONVENTIONAL_EXECUTABLE_GLOB
		: BUILD_OUTPUT_CONVENTIONAL_LIBRARY_GLOB;
	const fallbackGlob = extension === 'exe'
		? BUILD_OUTPUT_EXECUTABLE_GLOB
		: BUILD_OUTPUT_LIBRARY_GLOB;
	const conventional = await findMatches(conventionalGlob, scanLimit);
	if (isCancelled()) {
		return [];
	}

	const candidates = new Set(conventional);
	if (candidates.size < maxResults) {
		const fallback = await findMatches(fallbackGlob, scanLimit);
		if (isCancelled()) {
			return [];
		}
		for (const filePath of fallback) {
			candidates.add(filePath);
		}
	}

	return rankBuildOutputFiles([...candidates], workspacePath, maxResults);
}

/**
 * Finds executable-containing folders without allowing one folder's binaries
 * to consume the entire discovery window.
 */
export async function discoverBuildOutputFolders(
	workspacePath: string,
	maxResults: number,
	findMatches: FindBuildOutputMatches,
	isCancelled: () => boolean = () => false
): Promise<string[]> {
	if (maxResults <= 0 || isCancelled()) {
		return [];
	}
	const folderLimit = Math.min(maxResults, BUILD_OUTPUT_MAX_RESULTS);

	const representativeByFolder = new Map<string, string>();
	const addMatches = (matches: string[]): void => {
		for (const filePath of filterBuildOutputFiles(matches, workspacePath)) {
			const folder = path.dirname(filePath);
			if (!representativeByFolder.has(folder)) {
				representativeByFolder.set(folder, filePath);
			}
		}
	};

	const searchFolders = async (includeGlob: string): Promise<boolean> => {
		for (let attempt = 0; attempt < folderLimit; attempt++) {
			const previousFolderCount = representativeByFolder.size;
			const matches = await findMatches(
				includeGlob,
				BUILD_OUTPUT_MAX_SCAN_RESULTS,
				[...representativeByFolder.keys()]
			);
			if (isCancelled()) {
				return false;
			}
			addMatches(matches);
			if (
				representativeByFolder.size >= folderLimit
				|| matches.length < BUILD_OUTPUT_MAX_SCAN_RESULTS
				|| representativeByFolder.size === previousFolderCount
			) {
				break;
			}
		}
		return true;
	};

	if (!await searchFolders(BUILD_OUTPUT_CONVENTIONAL_EXECUTABLE_GLOB)) {
		return [];
	}
	if (
		representativeByFolder.size < folderLimit
		&& !await searchFolders(BUILD_OUTPUT_EXECUTABLE_GLOB)
	) {
		return [];
	}

	return rankBuildOutputFolders(
		[...representativeByFolder.values()],
		workspacePath,
		folderLimit
	);
}

/**
 * Ranks unique parent folders by their most relevant executable, then caps the
 * folder list rather than the file list.
 */
export function rankBuildOutputFolders(
	filePaths: string[],
	workspacePath: string,
	maxResults: number = BUILD_OUTPUT_MAX_RESULTS
): string[] {
	const representativeByFolder = new Map<string, string>();
	for (const filePath of filterBuildOutputFiles(filePaths, workspacePath)) {
		const folder = path.dirname(filePath);
		const current = representativeByFolder.get(folder);
		if (!current || compareBuildOutputFiles(filePath, current, workspacePath) < 0) {
			representativeByFolder.set(folder, filePath);
		}
	}

	return [...representativeByFolder.entries()]
		.sort(([leftFolder, leftFile], [rightFolder, rightFile]) => {
			const relevanceDifference = compareBuildOutputFiles(leftFile, rightFile, workspacePath);
			return relevanceDifference !== 0
				? relevanceDifference
				: path.relative(workspacePath, leftFolder)
					.localeCompare(path.relative(workspacePath, rightFolder));
		})
		.slice(0, maxResults)
		.map(([folder]) => folder);
}

/**
 * Filters build-output files by the depth of their parent directory relative
 * to the workspace root.
 */
export function filterBuildOutputFiles(
	filePaths: string[],
	workspacePath: string,
	maxDepth: number = BUILD_OUTPUT_MAX_DEPTH
): string[] {
	return filePaths.filter(filePath => {
		const relativeFolder = path.relative(workspacePath, path.dirname(filePath));
		return relativeFolder === '' || relativeFolder.split(path.sep).length <= maxDepth;
	});
}

/**
 * Given a list of absolute file paths (typically .exe matches) and a workspace
 * root, returns the unique parent directories sorted by relative path. Filters
 * out directories deeper than `maxDepth` segments from the root.
 *
 * This is the pure logic extracted from the VS Code build-output scan so it
 * can be unit tested without the VS Code API.
 */
export function deduplicateBuildOutputFolders(
	filePaths: string[],
	workspacePath: string,
	maxDepth: number = BUILD_OUTPUT_MAX_DEPTH
): string[] {
	const folderSet = new Set<string>();
	for (const filePath of filterBuildOutputFiles(filePaths, workspacePath, maxDepth)) {
		const folderPath = path.dirname(filePath);
		folderSet.add(folderPath);
	}

	return [...folderSet].sort((left, right) =>
		path.relative(workspacePath, left).localeCompare(path.relative(workspacePath, right))
	);
}
/**
 * VS Code-compatible glob exclude pattern for build-output scanning.
 */
export const BUILD_OUTPUT_EXCLUDE_GLOB = `{${[...BUILD_OUTPUT_SKIP_DIRS].map(d => `**/${d}/**`).join(',')}}`;

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fsp.access(filePath);
		return true;
	} catch {
		return false;
	}
}

function getRelativeDisplayPath(directory: string, searchRoot: string): string {
	const relative = path.relative(searchRoot, directory);
	if (!relative || relative === '.') {
		return '.';
	}
	return relative.replace(/\\/g, '/');
}

async function findTauriConfFile(directory: string): Promise<string | undefined> {
	try {
		const entries = await fsp.readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) { continue; }
			if (entry.name.startsWith('.')) { continue; }
			const subDir = path.join(directory, entry.name);
			try {
				const stat = await fsp.lstat(subDir);
				if (stat.isSymbolicLink()) { continue; }
			} catch {
				continue;
			}
			if (await fileExists(path.join(subDir, 'tauri.conf.json'))) {
				return `${entry.name}/tauri.conf.json`;
			}
		}
	} catch {
		// Skip if we can't read
	}
	return undefined;
}

async function isElectronProject(directory: string): Promise<boolean> {
	const packageJsonPath = path.join(directory, 'package.json');
	if (!await fileExists(packageJsonPath)) { return false; }
	try {
		const content = await fsp.readFile(packageJsonPath, 'utf-8');
		const pkg = JSON.parse(content);
		const deps = { ...pkg.dependencies, ...pkg.devDependencies };
		return 'electron' in deps;
	} catch {
		return false;
	}
}

async function findExecutableCsproj(directory: string): Promise<string | undefined> {
	try {
		const entries = await fsp.readdir(directory);
		for (const entry of entries) {
			if (!entry.endsWith('.csproj')) { continue; }
			const filePath = path.join(directory, entry);
			try {
				const content = await fsp.readFile(filePath, 'utf-8');
				if (isExecutableCsproj(content)) {
					return entry;
				}
			} catch {
				continue;
			}
		}
	} catch {
		// Skip if we can't read
	}
	return undefined;
}

/**
 * Parses csproj XML content to determine if it's an executable, non-test project.
 * Simplified heuristic inspired by the CLI's IsExecutableProject logic — uses regex
 * to match the first <OutputType> and <IsTestProject> elements. Does not handle
 * multiple/conditional PropertyGroups or values inside XML comments.
 */
function isExecutableCsproj(content: string): boolean {
	// Extract OutputType value from PropertyGroup elements
	const outputTypeMatch = content.match(/<OutputType>\s*(.*?)\s*<\/OutputType>/i);
	if (!outputTypeMatch) {
		return false;
	}
	const outputType = outputTypeMatch[1].toLowerCase();
	if (outputType !== 'exe' && outputType !== 'winexe') {
		return false;
	}

	// Check IsTestProject property
	const isTestMatch = content.match(/<IsTestProject>\s*(.*?)\s*<\/IsTestProject>/i);
	if (isTestMatch && isTestMatch[1].toLowerCase() === 'true') {
		return false;
	}

	return true;
}
