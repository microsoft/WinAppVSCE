import * as fsp from 'fs/promises';
import * as path from 'path';
import { isContainedInReal, isOfferableProject, PROJECT_SCAN_SKIP_DIRS, readProjectRunnability } from './project-detection';
import { attributeValue, findElementsByLocalName, tryParseXml } from './xml-read';

/** The extension-only target classification is never passed to the CLI. */
export type RunTargetKind = 'project' | 'solution' | 'folder' | 'unknown';

/** Project file extensions the CLI can build in project mode. */
export const PROJECT_FILE_EXTENSIONS = ['.csproj'] as const;

/** Solution file extensions the CLI can build in project mode. */
export const SOLUTION_FILE_EXTENSIONS = ['.sln', '.slnx'] as const;

/** Primary discovery glob; executable scanning is only a fallback. */
export const PROJECT_FILE_GLOB = '**/*.{sln,slnx,csproj}';

/** Bounds project-file glob work; display is capped separately. */
export const PROJECT_FILE_MAX_RESULTS = 200;

/** Caps picker entries while Browse keeps all targets reachable. */
export const RUN_TARGET_DISPLAY_LIMIT = 10;

/** VS Code-compatible exclude glob for project-file discovery. */
export const PROJECT_FILE_EXCLUDE_GLOB =
	`{${[...PROJECT_SCAN_SKIP_DIRS].map(d => `**/${d}/**`).join(',')}}`;

/** A workspace folder, reduced to what target discovery needs. */
export interface WorkspaceRoot {
	/** The folder's display name (`vscode.WorkspaceFolder.name`). */
	name: string;
	/** Absolute filesystem path of the folder. */
	path: string;
}

/** A candidate target for `winapp run`. */
export interface RunTargetCandidate {
	kind: RunTargetKind;
	/** Absolute path passed to the CLI as the positional `input` argument. */
	path: string;
	/** The workspace root this candidate was discovered under. */
	root: WorkspaceRoot;
}

/** Returns `undefined` for directories; classify those from top-level entries. */
export function classifyRunTargetFile(filePath: string): RunTargetKind | undefined {
	const extension = path.extname(filePath).toLowerCase();
	if ((SOLUTION_FILE_EXTENSIONS as readonly string[]).includes(extension)) {
		return 'solution';
	}
	if ((PROJECT_FILE_EXTENSIONS as readonly string[]).includes(extension)) {
		return 'project';
	}
	return undefined;
}

/** Mirrors CLI precedence; `unknown` still goes to the CLI for final handling. */
export function classifyRunTargetEntries(entryNames: readonly string[]): RunTargetKind {
	let hasProject = false;
	let hasExecutable = false;

	for (const name of entryNames) {
		const extension = path.extname(name).toLowerCase();
		if ((SOLUTION_FILE_EXTENSIONS as readonly string[]).includes(extension)) {
			return 'solution';
		}
		if ((PROJECT_FILE_EXTENSIONS as readonly string[]).includes(extension)) {
			hasProject = true;
		} else if (extension === '.exe') {
			hasExecutable = true;
		}
	}

	if (hasProject) { return 'project'; }
	if (hasExecutable) { return 'folder'; }
	return 'unknown';
}

/** Non-existent paths classify by extension so `launch.json` can name projects. */
export async function classifyRunTarget(inputPath: string): Promise<RunTargetKind> {
	const byExtension = classifyRunTargetFile(inputPath);
	if (byExtension) {
		return byExtension;
	}

	try {
		const stat = await fsp.stat(inputPath);
		if (!stat.isDirectory()) {
			return 'unknown';
		}
	} catch {
		return 'unknown';
	}

	try {
		return classifyRunTargetEntries(await fsp.readdir(inputPath));
	} catch {
		return 'unknown';
	}
}

/** True when project-only options are meaningful for this target kind. */
export function isProjectMode(kind: RunTargetKind): boolean {
	return kind === 'project' || kind === 'solution';
}

/** Lightweight solution parse; empty results defer errors to the CLI. */
export function parseSolutionProjectPaths(content: string, solutionPath: string): string[] {
	const isXml = path.extname(solutionPath).toLowerCase() === '.slnx';
	const paths = isXml ? parseSlnxProjectPaths(content) : parseSlnProjectPaths(content);

	// Solution folders appear alongside real projects in both formats; keep only
	// entries that name a buildable project file.
	return paths.filter(p => classifyRunTargetFile(p) === 'project');
}

function parseSlnProjectPaths(content: string): string[] {
	// Project("{type-guid}") = "Name", "relative\path\Name.csproj", "{project-guid}"
	const pattern = /^Project\("\{[^}"]*\}"\)\s*=\s*"[^"]*"\s*,\s*"([^"]*)"/gm;
	const results: string[] = [];
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(content)) !== null) {
		results.push(match[1]);
	}
	return results;
}

function parseSlnxProjectPaths(content: string): string[] {
	// <Project Path="src/MyApp/MyApp.csproj" />
	//
	// XML parse handles quoting, entities, and commented-out members.
	const doc = tryParseXml(content);
	if (!doc) {
		return [];
	}

	const results: string[] = [];
	for (const element of findElementsByLocalName(doc, 'Project')) {
		const value = attributeValue(element, 'Path');
		if (value) {
			results.push(value);
		}
	}
	return results;
}

/** Drops solution entries that escape the solution directory via reparse points. */
export async function readSolutionProjectPaths(solutionPath: string): Promise<string[]> {
	let content: string;
	try {
		content = await fsp.readFile(solutionPath, 'utf-8');
	} catch {
		return [];
	}

	const solutionDir = path.dirname(solutionPath);
	const resolved = parseSolutionProjectPaths(content, solutionPath)
		.map(relative => path.resolve(solutionDir, relative.replace(/\\/g, path.sep)));
	const contained = await Promise.all(
		resolved.map(candidate => isContainedInReal(solutionDir, candidate))
	);
	return resolved.filter((_, index) => contained[index]);
}

/** True when `candidate` is inside `container` (or is `container` itself). */
export function isContainedIn(container: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(container), path.resolve(candidate));
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Reads only top-level projects, matching the CLI's directory-input rule. */
export async function readDirectoryProjectPaths(directoryPath: string): Promise<string[]> {
	return readDirectoryEntriesWithExtensions(directoryPath, PROJECT_FILE_EXTENSIONS);
}

/** Check top-level solutions before projects; `winapp 0.7.0` does too. */
export async function readDirectorySolutionPaths(directoryPath: string): Promise<string[]> {
	return readDirectoryEntriesWithExtensions(directoryPath, SOLUTION_FILE_EXTENSIONS);
}

async function readDirectoryEntriesWithExtensions(
	directoryPath: string,
	extensions: readonly string[]
): Promise<string[]> {
	let entries: string[];
	try {
		entries = await fsp.readdir(directoryPath);
	} catch {
		return [];
	}

	return entries
		.filter(name => extensions.includes(path.extname(name).toLowerCase()))
		.map(name => path.join(directoryPath, name))
		.sort((left, right) => left.localeCompare(right));
}

/** True when `targetPath` exists and is a directory. */
export async function isDirectory(targetPath: string): Promise<boolean> {
	try {
		return (await fsp.stat(targetPath)).isDirectory();
	} catch {
		return false;
	}
}

/** Directories classified as `solution` still need directory resolution first. */
export async function readTargetProjects(
	target: RunTargetCandidate
): Promise<{ projects: string[]; containerPath: string }> {
	if (!isProjectMode(target.kind)) {
		return { projects: [], containerPath: target.path };
	}

	if (await isDirectory(target.path)) {
		// A top-level solution takes precedence over projects; reading its
		// members lets browsed directories reach the --project prompt.
		const solutions = await readDirectorySolutionPaths(target.path);
		if (solutions.length === 1) {
			return {
				projects: await readSolutionProjectPaths(solutions[0]),
				containerPath: path.dirname(solutions[0])
			};
		}
		if (solutions.length > 1) {
			// Which solution wins is the CLI's call, and it reports the
			// ambiguity precisely. Prompting here would mean guessing first.
			return { projects: [], containerPath: target.path };
		}

		const directoryProjects = await readDirectoryProjectPaths(target.path);
		if (directoryProjects.length > 0) {
			return { projects: directoryProjects, containerPath: target.path };
		}
		return { projects: [], containerPath: target.path };
	}

	if (target.kind === 'solution') {
		return {
			projects: await readSolutionProjectPaths(target.path),
			containerPath: path.dirname(target.path)
		};
	}

	// A path to a single .csproj already names the project.
	return { projects: [], containerPath: path.dirname(target.path) };
}

/** Drops only explicit test/library projects; `unknown` stays visible. */
export async function filterOfferableProjects(projectPaths: readonly string[]): Promise<string[]> {
	const runnability = await Promise.all(projectPaths.map(readProjectRunnability));

	return projectPaths.filter((_, index) => isOfferableProject(runnability[index]));
}

/** Folds solution members into the solution target to preserve MSBuild context. */
export function dedupeSolutionMembers(
	candidates: readonly RunTargetCandidate[],
	solutionMembers: ReadonlyMap<string, readonly string[]>
): RunTargetCandidate[] {
	const covered = new Set<string>();
	for (const candidate of candidates) {
		if (candidate.kind !== 'solution') { continue; }
		for (const member of solutionMembers.get(candidate.path) ?? []) {
			covered.add(normalizeForComparison(member));
		}
	}

	if (covered.size === 0) {
		return [...candidates];
	}

	return candidates.filter(candidate =>
		candidate.kind !== 'project' || !covered.has(normalizeForComparison(candidate.path))
	);
}

/** Solutions are never filtered; the CLI resolves them with full MSBuild. */
export async function filterOfferableCandidates(
	candidates: readonly RunTargetCandidate[]
): Promise<RunTargetCandidate[]> {
	const projects = candidates.filter(candidate => candidate.kind === 'project');
	if (projects.length === 0) {
		return [...candidates];
	}

	const keep = new Set(await filterOfferableProjects(projects.map(candidate => candidate.path)));
	return candidates.filter(candidate => candidate.kind !== 'project' || keep.has(candidate.path));
}

/** Sorts candidates with the active editor's root first, without hiding others. */
export function sortRunTargets(
	candidates: readonly RunTargetCandidate[],
	preferredRootPath?: string
): RunTargetCandidate[] {
	const preferred = preferredRootPath ? normalizeForComparison(preferredRootPath) : undefined;
	const kindRank = (kind: RunTargetKind): number => {
		switch (kind) {
			case 'solution': return 0;
			case 'project': return 1;
			case 'folder': return 2;
			default: return 3;
		}
	};

	return [...candidates].sort((left, right) => {
		if (preferred) {
			const leftPreferred = normalizeForComparison(left.root.path) === preferred ? 0 : 1;
			const rightPreferred = normalizeForComparison(right.root.path) === preferred ? 0 : 1;
			if (leftPreferred !== rightPreferred) { return leftPreferred - rightPreferred; }
		}

		const rankDelta = kindRank(left.kind) - kindRank(right.kind);
		if (rankDelta !== 0) { return rankDelta; }

		return left.path.localeCompare(right.path);
	});
}

/** Prefers the deepest matching workspace root for nested roots. */
export function findOwningRoot(
	roots: readonly WorkspaceRoot[],
	filePath: string | undefined
): WorkspaceRoot | undefined {
	if (!filePath) { return undefined; }

	let best: WorkspaceRoot | undefined;
	for (const root of roots) {
		const relative = path.relative(root.path, filePath);
		if (relative.startsWith('..') || path.isAbsolute(relative)) { continue; }
		if (!best || root.path.length > best.path.length) {
			best = root;
		}
	}
	return best;
}

function normalizeForComparison(filePath: string): string {
	// Windows paths are case-insensitive, and discovery mixes separators
	// depending on whether a path came from a glob or a solution file.
	return path.resolve(filePath).replace(/[\\/]+/g, path.sep).toLowerCase();
}
