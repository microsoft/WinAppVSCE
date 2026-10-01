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

/**
 * Directories no scan should ever descend into, regardless of what it is
 * looking for: dependency caches, VCS/IDE metadata, and tool scratch space.
 *
 * The three scans in this codebase (project detection, project-file
 * discovery, and build-output discovery) each extend this with exclusions
 * specific to what they look for. Those extensions legitimately differ —
 * build-output discovery must *not* skip `bin`, since that is exactly where
 * the executables live — so only this common base is shared, and each
 * specialization derives from it rather than restating it.
 */
export const ALWAYS_SKIP_DIRS = [
	'node_modules', '.git', '.vs', '.vscode', '.idea', 'packages', '.winapp'
] as const;

/**
 * True when `candidate` stays inside `container`, following reparse points.
 *
 * The lexical check rejects `..` traversal; the real-path check then rejects a
 * symlink or NTFS junction that lives inside `container` but resolves outside
 * it. A purely lexical test passes such a path, because nothing in the string
 * reveals the redirection.
 *
 * When either side cannot be resolved the target does not exist, and a path
 * that does not exist cannot be a reparse point — so the lexical result
 * stands rather than the path being rejected for being absent.
 *
 * This is the one containment rule for paths read out of workspace content
 * (solution members, configured app directories). Callers that only need the
 * lexical test can use the synchronous `isContainedIn` in `run-target.ts`.
 */
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

const SKIP_DIRS = new Set<string>([
	...ALWAYS_SKIP_DIRS,
	// Build inputs/outputs and language caches: a project file found under
	// these is a copy, not a source.
	'bin', 'obj', 'debug', 'release', 'dist', 'build', 'out', 'target',
	'artifacts', 'testresults', '__pycache__',
	'.gradle', '.dart_tool', '.pub-cache', '.nuget', '.cargo'
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

/**
 * How a `.csproj` is likely to behave when handed to `winapp run`.
 *
 * `unknown` is a first-class result and is deliberately common: the markers
 * this looks at can come from an SDK default, `Directory.Build.props`, or a
 * condition on `$(TargetFramework)`, none of which a static read can see. The
 * CLI resolves those correctly via full MSBuild evaluation, so the extension
 * must never treat `unknown` as "not runnable".
 */
export type ProjectRunnability = 'app' | 'test' | 'library' | 'unknown';

/**
 * Classifies csproj XML by the markers that are visible without evaluating
 * MSBuild.
 *
 * This intentionally does **not** reimplement the CLI's classification. The
 * CLI evaluates each project (falling back to a static parse only when the SDK
 * is unavailable) and is authoritative; this heuristic exists purely so the
 * extension can avoid *offering* a project the user plainly cannot run, and so
 * it can tell "obviously one app" from "genuinely ambiguous" before prompting.
 *
 * It is deliberately asymmetric: a project is only classified as `test` or
 * `library` when the project file explicitly says so. Anything else is
 * `unknown` and stays visible, so a project whose `OutputType` is inherited or
 * conditional is never hidden from the user.
 *
 * This approximation exists only because the CLI cannot be queried for its
 * classification without also building and launching the app. See
 * microsoft/winappCli#957 for the upstream query API and #273 for adopting it.
 */
export function classifyProjectRunnability(content: string): ProjectRunnability {
	if (/<IsTestProject>\s*true\s*<\/IsTestProject>/i.test(content)) {
		return 'test';
	}

	// The test SDK is what actually makes a project a test project; projects
	// relying on it rarely set IsTestProject themselves.
	if (/<PackageReference\b[^>]*\bInclude\s*=\s*"Microsoft\.NET\.Test\.Sdk"/i.test(content)) {
		return 'test';
	}

	const outputTypeMatch = content.match(/<OutputType>\s*(.*?)\s*<\/OutputType>/i);
	if (!outputTypeMatch) {
		// No explicit OutputType. It may still build an executable (WinUI and
		// WPF templates usually set it, but SDK defaults and shared props
		// files can supply it too), so defer to the CLI.
		return 'unknown';
	}

	const outputType = outputTypeMatch[1].toLowerCase();
	if (outputType === 'exe' || outputType === 'winexe') {
		return 'app';
	}
	if (outputType === 'library') {
		return 'library';
	}
	return 'unknown';
}

/**
 * Reads and classifies a project file. Unreadable files are `unknown` so an
 * I/O hiccup can never hide a project the user is looking for.
 */
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

/**
 * Parses csproj XML content to determine if it's an executable, non-test project.
 * Simplified heuristic inspired by the CLI's IsExecutableProject logic — uses regex
 * to match the first <OutputType> and <IsTestProject> elements. Does not handle
 * multiple/conditional PropertyGroups or values inside XML comments.
 */
function isExecutableCsproj(content: string): boolean {
	return classifyProjectRunnability(content) === 'app';
}
