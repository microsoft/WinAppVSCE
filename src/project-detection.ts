import * as fsp from 'fs/promises';
import * as path from 'path';
import { attributeValue, elementText, findElementsByLocalName, tryParseXml } from './xml-read';

/**
 * Mirrors the C# DetectedProjectType enum from WinApp.Cli.
 */
export type DetectedProjectType = 'Tauri' | 'Electron' | 'Flutter' | '.NET' | 'Rust' | 'C++';

/** Mirrors the C# DetectedProject record from WinApp.Cli. */
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

/** Shared scan exclusions; build-output discovery keeps `bin` searchable. */
export const ALWAYS_SKIP_DIRS = [
	'node_modules', '.git', '.vs', '.vscode', '.idea', 'packages', '.winapp'
] as const;

/** Real-path containment rejects symlink/junction escapes; absent paths cannot. */
export async function isContainedInReal(container: string, candidate: string): Promise<boolean> {
	const resolved = path.resolve(container, candidate);
	if (!isLexicallyContained(path.resolve(container), resolved)) {
		return false;
	}

	try {
		const realContainer = await fsp.realpath(container);
		const realResolved = await fsp.realpath(resolved);
		return isLexicallyContained(realContainer, realResolved);
	} catch {
		return true;
	}
}

function isLexicallyContained(container: string, candidate: string): boolean {
	const relative = path.relative(container, candidate);
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Directories excluded from project-file discovery, by BFS and by glob. */
export const PROJECT_SCAN_SKIP_DIRS = new Set<string>([
	...ALWAYS_SKIP_DIRS,
	// Build inputs/outputs and language caches: a project file found under
	// these is a copy, not a source.
	'bin', 'obj', 'debug', 'release', 'dist', 'build', 'out', 'target',
	'artifacts', 'testresults', 'appx', '__pycache__',
	'.gradle', '.dart_tool', '.pub-cache', '.nuget', '.cargo'
]);

/** Mirrors ProjectDetectionService.DetectProject from WinApp.Cli. */
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

/** Breadth-first project detection with periodic yielding for UI responsiveness. */
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
				if (PROJECT_SCAN_SKIP_DIRS.has(entry.name.toLowerCase())) { continue; }
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
export const BUILD_OUTPUT_SKIP_DIRS = new Set<string>([
	...ALWAYS_SKIP_DIRS,
	// `bin`, the configuration folders under it, and `artifacts` (the .NET 8+
	// artifacts output layout) are deliberately absent: build-output discovery
	// is looking for exactly what lives there.
	'appx', 'obj'
]);

/**
 * Maximum depth (in path segments relative to root) for build-output results.
 */
export const BUILD_OUTPUT_MAX_DEPTH = 8;

/**
 * Maximum number of executable matches to consider before stopping.
 */
export const BUILD_OUTPUT_MAX_RESULTS = 10;

/** Deduplicates executable parent folders and enforces `maxDepth`. */
export function deduplicateBuildOutputFolders(
	filePaths: string[],
	workspacePath: string,
	maxDepth: number = BUILD_OUTPUT_MAX_DEPTH
): string[] {
	const folderSet = new Set<string>();
	for (const filePath of filePaths) {
		const folderPath = path.dirname(filePath);
		const relativeFolder = path.relative(workspacePath, folderPath);
		if (relativeFolder !== '' && relativeFolder.split(path.sep).length > maxDepth) {
			continue;
		}
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

/** `unknown` stays visible because only the CLI can fully evaluate MSBuild. */
export type ProjectRunnability = 'app' | 'test' | 'library' | 'unknown';

/** Only explicit `test`/`library` markers demote; pending microsoft/winappCli#957. */
export function classifyProjectRunnability(content: string): ProjectRunnability {
	const doc = tryParseXml(content);
	if (!doc) {
		// Malformed or half-written. Falling back to `unknown` keeps the
		// project visible, which is the safe direction for this heuristic.
		return 'unknown';
	}

	for (const element of findElementsByLocalName(doc, 'IsTestProject')) {
		if (elementText(element).toLowerCase() === 'true') {
			return 'test';
		}
	}

	// The test SDK is what actually makes a project a test project; projects
	// relying on it rarely set IsTestProject themselves.
	for (const element of findElementsByLocalName(doc, 'PackageReference')) {
		if (attributeValue(element, 'Include')?.toLowerCase() === 'microsoft.net.test.sdk') {
			return 'test';
		}
	}

	// A conditioned OutputType is exactly the "can't tell without MSBuild"
	// case this heuristic must not guess at, so it is left to the CLI.
	const outputTypes = findElementsByLocalName(doc, 'OutputType')
		.filter(element => attributeValue(element, 'Condition') === undefined);
	if (outputTypes.length === 0) {
		// No explicit OutputType. It may still build an executable (WinUI and
		// WPF templates usually set it, but SDK defaults and shared props
		// files can supply it too), so defer to the CLI.
		return 'unknown';
	}

	const outputType = elementText(outputTypes[0]).toLowerCase();
	if (outputType === 'exe' || outputType === 'winexe') {
		return 'app';
	}
	if (outputType === 'library') {
		return 'library';
	}
	return 'unknown';
}

/** Unreadable project files are `unknown` so I/O hiccups never hide them. */
export async function readProjectRunnability(projectPath: string): Promise<ProjectRunnability> {
	try {
		return classifyProjectRunnability(await fsp.readFile(projectPath, 'utf-8'));
	} catch {
		return 'unknown';
	}
}

/** True when a project should be offered as a run target. */
export function isOfferableProject(runnability: ProjectRunnability): boolean {
	return runnability === 'app' || runnability === 'unknown';
}

/** Strict wrapper: `unknown` is not an app here; offerable projects may include it. */
function isExecutableCsproj(content: string): boolean {
	return classifyProjectRunnability(content) === 'app';
}
